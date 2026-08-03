import { db } from "@backend/db/db";
import { runYantraContainer } from "@backend/modules/yantra/services/container_runner.yantra.service";
import { runExecute } from "@backend/modules/yantra/services/execute_runner.yantra.service";
import {
	GH_TIMEOUT_MS,
	gh,
	ghRequest,
} from "@backend/modules/yantra/services/gh_client.yantra.service";
import { fetchRepoFile } from "@backend/modules/yantra/services/repo_files.yantra.service";
import {
	addIssueLabels,
	commentOnIssue,
	extractJsonBlock,
	recordRun,
	removeIssueLabel,
	routeModel,
} from "@backend/modules/yantra/services/turn_shared.yantra.service";
import { checkRails } from "@backend/modules/yantra/state/rails.yantra";
import { ScanLatch } from "@backend/modules/yantra/state/scan_latch.yantra";
import { logger } from "@backend/utils/logger.utils";
import { ulid } from "ulid";

/**
 * GRADE (loop-protocol §2.4) + rails — ported from ops/yantra/grade.sh.
 * Scan mode: grade every open agent:pr-open PR whose CI is done and whose
 * head SHA has no verdict yet. Two legs: CI (Actions REST) and rubric (fresh
 * opus container with a checkout at the PR head). PASS+T0+rails ⇒ squash
 * auto-merge + close the linked issue (staging merges never auto-close).
 * FAIL ⇒ one execute retry on the same branch; second FAIL ⇒ agent:failed.
 *
 * checkRails is the ONLY gate before the merge call — no other code path in
 * the app merges (H8 invariant).
 */

const GRADE_TIMEOUT_MS = 20 * 60 * 1000;
const API = "https://api.github.com";

export interface GradeProject {
	repo: string;
	/** The staging branch — where prompts/rubrics are read from. */
	baseBranch: string;
	/**
	 * Per-project autonomy (#24): may yantra merge a passing PR to the
	 * production branch itself? Undefined is treated as false — a project must
	 * opt IN before anything ships to prod unattended.
	 */
	autoMergeToMain?: boolean;
	ghToken: string;
	claudeToken: string;
}

interface PrDetail {
	number: number;
	title: string;
	body: string | null;
	head: { sha: string };
	additions: number;
	deletions: number;
	changed_files: number;
	labels: { name: string }[];
}

interface GradeVerdict {
	verdict?: string;
	tier_confirmed?: string;
	failures?: string[];
}

export const tierRank = (t: string): number =>
	({ T0: 0, T1: 1, T2: 2, T3: 3 })[t] ?? 3;

export const linkedIssue = (body: string | null): number => {
	const m = body?.match(/closes #(\d+)/i);
	return m?.[1] ? Number(m[1]) : 0;
};

const rawDiff = async (
	repo: string,
	pr: number,
	token: string,
): Promise<string> => {
	// Bounded like every other GitHub call — this one runs while the scan latch
	// is held, so a hung diff is exactly what stalls grading.
	const res = await fetch(`${API}/repos/${repo}/pulls/${pr}`, {
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/vnd.github.v3.diff",
			"x-github-api-version": "2022-11-28",
		},
		signal: AbortSignal.timeout(GH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`GitHub ${res.status} diff for PR #${pr}`);
	return (await res.text()).slice(0, 180_000);
};

const killSwitchOn = async (repo: string, token: string): Promise<boolean> => {
	try {
		const v = await gh<{ value: string }>(
			`/repos/${repo}/actions/variables/YANTRA_KILL`,
			token,
		);
		return v.value === "true";
	} catch {
		return true; // fail CLOSED
	}
};

const automergesLastHour = async (
	repo: string,
	token: string,
): Promise<number> => {
	try {
		const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		const r = await gh<{ total_count: number }>(
			`/search/issues?q=${encodeURIComponent(
				`repo:${repo} is:pr is:merged label:tier:T0 merged:>${since}`,
			)}`,
			token,
		);
		return r.total_count;
	} catch {
		return 999; // unknown ⇒ R3 refuses — conservative
	}
};

// One scan at a time per process — grades are slow (rubric container) and the
// already-graded dedupe is comment-based, so concurrent scans could double-
// grade the same SHA. v0 was serial by construction; we stay serial.
//
// Serial, but not indefinitely: a plain boolean latch is never cleared if the
// scan that set it never returns, and grading then stops for the life of the
// process while every tick logs a cheerful "skipped". The latch expires so a
// wedged scan costs one window instead of everything after it.
//
// Ceiling = the grade container's own timeout (20 min) plus room for the CI
// probe and rubric fetch around it, so a legitimately slow scan is never
// mistaken for a dead one.
const SCAN_WEDGE_MS = GRADE_TIMEOUT_MS + 10 * 60 * 1000;
const scanLatch = new ScanLatch(SCAN_WEDGE_MS);

export const runGradeScan = async (project: GradeProject): Promise<void> => {
	const held = scanLatch.acquire();
	if (!held.acquired) {
		logger.info(
			{ repo: project.repo, heldForMs: held.heldForMs },
			"grade scan skipped: one in flight",
		);
		return;
	}
	if (held.tookOverAfterMs !== null) {
		// Loud on purpose: self-healing past this quietly would hide a real bug.
		logger.error(
			{ repo: project.repo, wedgedForMs: held.tookOverAfterMs },
			"grade scan latch wedged — previous scan never finished, taking over",
		);
	}
	try {
		const prs = await gh<{ number: number }[]>(
			`/repos/${project.repo}/issues?labels=agent:pr-open&state=open&per_page=50`,
			project.ghToken,
		);
		for (const pr of prs) {
			if (await killSwitchOn(project.repo, project.ghToken)) {
				logger.info({ repo: project.repo }, "grade scan abort: kill switch");
				return;
			}
			try {
				await gradeOne(project, pr.number);
			} catch (err) {
				logger.error(
					{ err, pr: pr.number },
					"grade_one errored (scan continues)",
				);
			}
		}
	} finally {
		scanLatch.release(held.token);
	}
};

const gradeOne = async (project: GradeProject, prNumber: number) => {
	const { repo, ghToken } = project;
	const started = new Date();
	const model = routeModel("grade");
	const turn = ulid();

	// PRs carry agent:pr-open on the ISSUE side too (execute labels both);
	// only grade actual pull requests.
	const pr = await gh<PrDetail & { pull_request?: unknown }>(
		`/repos/${repo}/pulls/${prNumber}`,
		ghToken,
	).catch(() => null);
	if (!pr?.head?.sha) {
		logger.warn({ pr: prNumber }, "grade: PR fetch failed/not a PR — skip");
		return;
	}
	const sha = pr.head.sha;

	// CI leg via the Actions REST API (same evidence source as v0).
	const runs = await gh<{
		workflow_runs: {
			name: string;
			status: string;
			conclusion: string | null;
			html_url: string;
		}[];
	}>(`/repos/${repo}/actions/runs?head_sha=${sha}&per_page=20`, ghToken).catch(
		() => null,
	);
	if (!runs || runs.workflow_runs.length === 0) {
		logger.info({ pr: prNumber }, "grade skip: no CI runs for head sha yet");
		return;
	}
	const pending = runs.workflow_runs.some((r) => r.status !== "completed");
	if (pending) {
		logger.info({ pr: prNumber }, "grade skip: CI pending");
		return;
	}
	const ciFailed = runs.workflow_runs.some((r) =>
		["failure", "cancelled", "timed_out", "startup_failure"].includes(
			r.conclusion ?? "",
		),
	);

	// Already graded this SHA? (comment marker, exactly like v0)
	const comments = await gh<{ body: string }[]>(
		`/repos/${repo}/issues/${prNumber}/comments?per_page=100`,
		ghToken,
	);
	if (comments.some((c) => c.body.includes(`yantra grade sha=${sha}`))) {
		return;
	}
	const failCount = comments.filter(
		(c) =>
			c.body.includes("yantra grade") && c.body.includes('"verdict": "FAIL"'),
	).length;

	const issue = linkedIssue(pr.body);
	const tierLabel = (
		pr.labels.find((l) => l.name.startsWith("tier:"))?.name ?? "tier:T3"
	).slice(5);

	let verdict: string;
	let tierConfirmed: string;
	let verdictJson: GradeVerdict;

	if (ciFailed) {
		verdict = "FAIL";
		tierConfirmed = tierLabel;
		verdictJson = {
			verdict: "FAIL",
			tier_confirmed: tierLabel,
			failures: [
				"CI leg red: required checks failed on this PR — read the CI logs, fix the root cause; never weaken tests",
			],
		};
	} else {
		// Rubric leg — read-only container with a checkout at the PR head.
		const [template, rubrics] = await Promise.all([
			fetchRepoFile(
				repo,
				"ops/yantra/prompts/grade.md",
				project.baseBranch,
				ghToken,
			),
			fetchRepoFile(
				repo,
				"docs/yantra/rubrics.md",
				project.baseBranch,
				ghToken,
			),
		]);
		if (!template) {
			await recordGrade(
				project,
				turn,
				issue,
				model,
				tierLabel,
				started,
				"infra_error",
				prNumber,
			);
			return;
		}
		let spec = "<no linked issue found>";
		if (issue) {
			const idata = await gh<{ title: string; body: string | null }>(
				`/repos/${repo}/issues/${issue}`,
				ghToken,
			).catch(() => null);
			if (idata) spec = `# ${idata.title}\n\n${idata.body ?? ""}`;
		}
		const diff = await rawDiff(repo, prNumber, ghToken).catch(() => "");
		const checksJson = JSON.stringify(
			runs.workflow_runs.map((r) => ({
				name: r.name,
				status: r.status,
				conclusion: r.conclusion,
				url: r.html_url,
			})),
			null,
			2,
		);
		const prompt = [
			template,
			`\n## Rubric (rubrics.md)\n\n${rubrics ?? ""}`,
			`\n## Product Spec (issue #${issue})\n\n${spec}`,
			`\n## Advise tier label: ${tierLabel}`,
			`\n## CI leg (harness-verified): SUCCESS — these check results ARE the CI evidence; cite the links:\n\`\`\`json\n${checksJson}\n\`\`\``,
			`\n## PR #${prNumber} diff\n\`\`\`diff\n${diff}\n\`\`\``,
		].join("\n");

		const script = [
			"set -euo pipefail",
			"export GIT_TERMINAL_PROMPT=0",
			"mkdir -p /workspace && cd /workspace",
			`git clone --quiet "https://x-access-token:\${GH_TOKEN}@github.com/\${YANTRA_REPO}.git" repo`,
			"cd repo",
			'git checkout --quiet "$HEAD_SHA"',
			'echo "$PROMPT_B64" | base64 -d > /workspace/prompt.md',
			// Read-only run: no --dangerously-skip-permissions needed.
			`claude -p "$(cat /workspace/prompt.md)" --model "$MODEL"`,
		].join("\n");

		let output = "";
		try {
			const result = await runYantraContainer({
				name: `yantra-grade-${prNumber}-${ulid().toLowerCase()}`,
				script,
				env: {
					PROMPT_B64: Buffer.from(prompt, "utf8").toString("base64"),
					MODEL: model,
					HEAD_SHA: sha,
					YANTRA_REPO: repo,
					GH_TOKEN: ghToken,
					CLAUDE_CODE_OAUTH_TOKEN: project.claudeToken,
				},
				timeoutMs: GRADE_TIMEOUT_MS,
			});
			if (result.exitCode !== 0) throw new Error(`exit ${result.exitCode}`);
			output = result.output;
		} catch (err) {
			logger.error({ err, pr: prNumber }, "grade container infra error");
			await recordGrade(
				project,
				turn,
				issue,
				model,
				tierLabel,
				started,
				"infra_error",
				prNumber,
			);
			return;
		}
		const parsed = extractJsonBlock(output) as GradeVerdict | null;
		if (!parsed || typeof parsed.verdict !== "string") {
			await recordGrade(
				project,
				turn,
				issue,
				model,
				tierLabel,
				started,
				"infra_error",
				prNumber,
			);
			return;
		}
		verdictJson = parsed;
		verdict = parsed.verdict;
		tierConfirmed = parsed.tier_confirmed ?? tierLabel;
	}

	// Tier honesty: the higher of advise-label vs grade re-derivation wins.
	if (tierRank(tierConfirmed) < tierRank(tierLabel)) {
		tierConfirmed = tierLabel;
	} else if (tierConfirmed !== tierLabel) {
		await addIssueLabels(
			repo,
			prNumber,
			[`tier:${tierConfirmed}`],
			ghToken,
		).catch(() => {});
		await removeIssueLabel(repo, prNumber, `tier:${tierLabel}`, ghToken);
		if (issue) {
			await addIssueLabels(
				repo,
				issue,
				[`tier:${tierConfirmed}`],
				ghToken,
			).catch(() => {});
			await removeIssueLabel(repo, issue, `tier:${tierLabel}`, ghToken);
		}
	}

	const run = ulid();
	await commentOnIssue(
		repo,
		prNumber,
		`🤖 yantra grade sha=${sha} run=${run} model=${model}\n\n\`\`\`json\n${JSON.stringify(verdictJson, null, 2)}\n\`\`\``,
		ghToken,
	);

	if (verdict === "PASS") {
		// Auto-merge tiers: T0 + T1. This gate is the ONLY code path that calls
		// gh pr merge, so it must stay in lock-step with rails.yantra.ts
		// (AUTO_MERGE_TIERS) and state_machine.yantra.ts (isAutoMergeTier) — the
		// "widen rails to T0+T1" change updated those two but missed THIS one, so
		// every T1 PASS silently fell through to human review instead of merging.
		// Per-project autonomy (#24). PRs target the production branch, so an
		// auto-merge here ships to PROD. A project only goes hands-off when its
		// team opts in; default false ⇒ the PR waits for a human click in the
		// yantra UI. Checked BEFORE the rails so an opted-out project never even
		// reaches the merge path.
		if (
			(tierConfirmed === "T0" || tierConfirmed === "T1") &&
			project.autoMergeToMain !== true
		) {
			await commentOnIssue(
				repo,
				prNumber,
				`🤖 yantra grade PASS (${tierConfirmed}) — auto-promote is OFF for this project, so this PR is waiting for a human merge.`,
				ghToken,
			).catch(() => {});
			logger.info(
				{ pr: prNumber, tier: tierConfirmed },
				"grade PASS — auto-promote disabled for project, awaiting human merge",
			);
		} else if (tierConfirmed === "T0" || tierConfirmed === "T1") {
			// Gather rail inputs FRESH at merge time; checkRails is the only gate.
			const files = await gh<{ filename: string }[]>(
				`/repos/${repo}/pulls/${prNumber}/files?per_page=100`,
				ghToken,
			).catch(() => []);
			const railFail = checkRails(
				{
					additions: pr.additions,
					deletions: pr.deletions,
					changedFiles: pr.changed_files,
					filePaths: files.map((f) => f.filename),
				},
				{
					tierConfirmed,
					rubricVerdict: verdict,
					automergesLastHour: await automergesLastHour(repo, ghToken),
					killSwitchOn: await killSwitchOn(repo, ghToken),
					isRevert: /^revert/i.test(pr.title),
				},
			);
			if (railFail === null) {
				await ghRequest(
					"PUT",
					`/repos/${repo}/pulls/${prNumber}/merge`,
					ghToken,
					{
						merge_method: "squash",
					},
				);
				if (issue) {
					await ghRequest("PATCH", `/repos/${repo}/issues/${issue}`, ghToken, {
						state: "closed",
						state_reason: "completed",
					}).catch(() => {});
				}
				logger.info(
					{ pr: prNumber, issue, tier: tierConfirmed },
					"grade PASS — auto-merged",
				);
				await recordGrade(
					project,
					turn,
					issue,
					model,
					tierConfirmed,
					started,
					failCount > 0 ? "grade_pass_retry" : "grade_pass_first_try",
					prNumber,
					{ merged: true, autoMerged: true },
				);
			} else {
				await commentOnIssue(
					repo,
					prNumber,
					`🤖 yantra rails: auto-merge REFUSED — ${railFail}. Queued for human review.`,
					ghToken,
				);
				logger.info({ pr: prNumber, railFail }, "grade PASS but rails refused");
				await recordGrade(
					project,
					turn,
					issue,
					model,
					tierConfirmed,
					started,
					"grade_pass_first_try",
					prNumber,
				);
			}
		} else {
			logger.info(
				{ pr: prNumber, tierConfirmed },
				"grade PASS — human review queue",
			);
			await recordGrade(
				project,
				turn,
				issue,
				model,
				tierConfirmed,
				started,
				failCount > 0 ? "grade_pass_retry" : "grade_pass_first_try",
				prNumber,
			);
		}
		return;
	}

	// FAIL
	await recordGrade(
		project,
		turn,
		issue,
		model,
		tierConfirmed,
		started,
		"grade_fail",
		prNumber,
	);
	if (failCount === 0 && issue) {
		logger.info({ pr: prNumber }, "grade FAIL attempt=1 — execute retry");
		const failures = (verdictJson.failures ?? [])
			.map((f) => `- ${f}`)
			.join("\n");
		await runExecute({
			repo,
			baseBranch: project.baseBranch,
			ghToken,
			claudeToken: project.claudeToken,
			issue,
			turn,
			tier: tierConfirmed,
			adviseJson: {},
			retry: { pr: prNumber, failures },
		});
	} else {
		logger.info(
			{ pr: prNumber },
			"grade FAIL attempt=2 — parking agent:failed",
		);
		if (issue) {
			await addIssueLabels(
				repo,
				issue,
				["agent:failed", "needs-human"],
				ghToken,
			).catch(() => {});
			await removeIssueLabel(repo, issue, "agent:pr-open", ghToken);
		}
		await commentOnIssue(
			repo,
			prNumber,
			"🤖 yantra: second grade FAIL — parked `agent:failed`. A human must intervene (fix and re-add `spec:ready`, or close).",
			ghToken,
		);
	}
};

const recordGrade = (
	project: GradeProject,
	turn: string,
	issue: number,
	model: string,
	tier: string,
	startedAt: Date,
	outcome: string,
	pr: number,
	flags?: { merged?: boolean; autoMerged?: boolean },
) =>
	recordRun({
		repo: project.repo,
		baseBranch: project.baseBranch,
		turn,
		issue,
		role: "grade",
		model,
		promptVersion: 1,
		tier,
		taskType: "unknown",
		startedAt,
		outcome,
		pr,
	}).then(async (run) => {
		if (flags?.merged || flags?.autoMerged) {
			await db.yantraTelemetry.findBy({ run }).update({
				merged: flags.merged ?? false,
				autoMerged: flags.autoMerged ?? false,
			});
		}
		return run;
	});

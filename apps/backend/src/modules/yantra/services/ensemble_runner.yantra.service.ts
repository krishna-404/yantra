import { runYantraContainer } from "@backend/modules/yantra/services/container_runner.yantra.service";
import { EXEC_IMAGE_OC } from "@backend/modules/yantra/services/docker_status.yantra.service";
import { gh } from "@backend/modules/yantra/services/gh_client.yantra.service";
import {
	fetchRepoFile,
	parsePromptVersion,
} from "@backend/modules/yantra/services/repo_files.yantra.service";
import {
	addIssueLabels,
	branchSlug,
	commentOnIssue,
	getIssue,
	issueField,
	recordRun,
	removeIssueLabel,
} from "@backend/modules/yantra/services/turn_shared.yantra.service";
import { logger } from "@backend/utils/logger.utils";
import { ulid } from "ulid";

/**
 * ENSEMBLE EXECUTE (Phase 3, operator directives 2026-07-12) — every task runs
 * through N free models IN PARALLEL, then a strong free model SYNTHESISES one
 * answer from all N candidate diffs.
 *
 * Parallelism matters: a task can't wait for three models to answer one after
 * another. So each candidate runs in its OWN container concurrently (clone +
 * solve + push its own branch), and only the judge waits — for whichever
 * candidates finished. Wall-time ≈ one model + one judge, not the sum of all.
 *
 * The operator chose synthesis (not pick-best, not mechanical merge): the judge
 * blends the strongest parts of each candidate, and the blended diff must still
 * pass the full self-check gate before a PR opens. Grade + rails then treat an
 * ensemble PR exactly like any other — the lane is invisible downstream.
 *
 * Candidate branches are throwaway (`<pr-branch>-c1…cN`); the judge deletes
 * them after opening the PR. Telemetry records one row per candidate model plus
 * the synthesis so scorecards (D26) can grade each model over time.
 */

const NO_DIFF_EXIT = 21;
const CAND_TIMEOUT_MS = 90 * 60 * 1000; // one model, one container
const JUDGE_TIMEOUT_MS = 90 * 60 * 1000; // synthesis + self-check + PR

export interface EnsembleOutcome {
	kind: "pr_open" | "parked" | "no_diff";
	pr: number;
	models: string[];
	judge: string;
	candidatesSucceeded: number;
}

// ── container scripts ───────────────────────────────────────────────────────
// Both single-quote the inner WORK heredoc so bash expands nothing at
// write-time; env vars resolve at run-time under the `node` user (su -p keeps
// the environment). `\${VAR}` escapes JS interpolation so bash sees $VAR.

/** One candidate: solve the spec, push its own branch, no PR. */
const buildCandidateScript = (): string => `set -euo pipefail
pg_ctlcluster "$(ls /etc/postgresql | head -1)" main start
su postgres -c "psql -qc \\"ALTER USER postgres PASSWORD 'postgres';\\""
mkdir -p /workspace
echo "$PROMPT_B64" | base64 -d > /workspace/prompt.md
cat > /workspace/work.sh <<'WORK'
set -euo pipefail
unset NOVU_SECRET_KEY NOVU_API_URL
export GIT_TERMINAL_PROMPT=0
git config --global user.name "yantra-bot"
git config --global user.email "yantra-bot@users.noreply.github.com"
cd /workspace
git clone --quiet -b "$BASE_BRANCH" "https://x-access-token:\${GH_TOKEN}@github.com/\${YANTRA_REPO}.git" repo
cd repo
git checkout -q -B "$CAND_BRANCH" "origin/$BASE_BRANCH"
yarn install --frozen-lockfile >/workspace/install.log 2>&1
yarn build --filter='./packages/*' >>/workspace/install.log 2>&1 || true
opencode run "$(cat /workspace/prompt.md)" -m "$MODEL" --dangerously-skip-permissions </dev/null || true
git add -A >/dev/null 2>&1 || true
git commit -q -m "candidate: $MODEL" >/dev/null 2>&1 || true
git diff --quiet "origin/$BASE_BRANCH"..HEAD 2>/dev/null && { echo "NO_DIFF"; exit ${NO_DIFF_EXIT}; }
git push --quiet -u origin "$CAND_BRANCH" --force
WORK
chown -R node:node /workspace
su node -p -s /bin/bash -c 'export HOME=/home/node; bash /workspace/work.sh'
`;

/** The judge: gather candidate diffs, synthesise on the PR branch, gate, PR. */
const buildJudgeScript = (): string => `set -euo pipefail
pg_ctlcluster "$(ls /etc/postgresql | head -1)" main start
su postgres -c "psql -qc \\"ALTER USER postgres PASSWORD 'postgres';\\""
mkdir -p /workspace
echo "$PROMPT_B64" | base64 -d > /workspace/prompt.md
echo "$CAND_BRANCHES_B64" | base64 -d > /workspace/cands.txt
cat > /workspace/work.sh <<'WORK'
set -euo pipefail
unset NOVU_SECRET_KEY NOVU_API_URL
export GIT_TERMINAL_PROMPT=0
git config --global user.name "yantra-bot"
git config --global user.email "yantra-bot@users.noreply.github.com"
cd /workspace
git clone --quiet -b "$BASE_BRANCH" "https://x-access-token:\${GH_TOKEN}@github.com/\${YANTRA_REPO}.git" repo
cd repo
BASE="origin/$BASE_BRANCH"
git checkout -q -B "$BRANCH" "$BASE"

yarn install --frozen-lockfile >/workspace/selfcheck.log 2>&1
yarn build --filter='./packages/*' >>/workspace/selfcheck.log 2>&1 || \\
	echo "WARN: package pre-build returned non-zero; check-types may false-red" >>/workspace/selfcheck.log

# gather each candidate's diff (skip any branch that never got pushed)
i=0
while IFS= read -r CB <&3; do
	[ -z "$CB" ] && continue
	git fetch -q origin "$CB" 2>/dev/null || continue
	i=$((i+1))
	git diff "$BASE".."origin/$CB" > "/workspace/cand-$i.patch" 2>/dev/null || true
done 3< /workspace/cands.txt

{
	echo "You are the Yantra SYNTHESIS judge. Below is a Product Spec and $i independent candidate solutions (unified diffs) produced by different models for the SAME spec. Produce the SINGLE BEST solution by combining the strongest parts of each — do not merely copy one candidate. Edit the files in this repository to implement your synthesised solution. It MUST pass lint, type-check, knip and tests; you may not weaken, skip, or delete tests to make them pass."
	echo
	echo "End your reply with one fenced json block recording how the candidates diverged (this is the scoring signal):"
	echo '\`\`\`json'
	echo '{ "picked_from": "which candidate each major decision came from", "divergences": ["where the candidates disagreed and why your choice is better"] }'
	echo '\`\`\`'
	echo
	echo "## Product Spec"
	cat /workspace/prompt.md
	n=0
	while [ $n -lt $i ]; do
		n=$((n+1))
		echo; echo "## Candidate $n diff"; echo '\`\`\`diff'
		cat "/workspace/cand-$n.patch" 2>/dev/null || echo "(empty)"; echo '\`\`\`'
	done
} > /workspace/judge.md
opencode run "$(cat /workspace/judge.md)" -m "$JUDGE_MODEL" --dangerously-skip-permissions </dev/null >/workspace/judge-out.log 2>&1
git add -A >/dev/null 2>&1 || true
git commit -q -m "synthesised solution (judge: $JUDGE_MODEL)" >/dev/null 2>&1 || true

selfcheck() {
	yarn lint && yarn check-types && yarn knip && yarn test:db:setup && yarn test:run
}
if ! selfcheck >>/workspace/selfcheck.log 2>&1; then
	echo "--- self-check failed; giving the judge one fix pass ---" >>/workspace/selfcheck.log
	opencode run "The self-check gate failed. Output tail:
$(tail -60 /workspace/selfcheck.log)
Fix the failures. You may not weaken or skip tests. Commit the fix." \\
		-m "$JUDGE_MODEL" --dangerously-skip-permissions </dev/null >>/workspace/judge-out.log 2>&1
	git add -A >/dev/null 2>&1 || true
	git commit -q -m "judge fix pass" >/dev/null 2>&1 || true
	selfcheck >>/workspace/selfcheck.log 2>&1
fi

# clean up throwaway candidate branches regardless of outcome
while IFS= read -r CB <&3; do
	[ -z "$CB" ] && continue
	git push -q origin --delete "$CB" 2>/dev/null || true
done 3< /workspace/cands.txt

git diff --quiet "$BASE"..HEAD 2>/dev/null && { echo "NO_DIFF"; exit ${NO_DIFF_EXIT}; }

git push --quiet -u origin "$BRANCH"

TITLE=$(echo "$TITLE_B64" | base64 -d)
{
	echo "Automated Yantra change for #$ISSUE via $i-model ensemble (parallel candidates, synthesis judge)."
	echo; echo "Candidate models: $CAND_MODELS"
	echo "Synthesis judge: $JUDGE_MODEL"
	echo; echo "## Judge synthesis notes"; echo '\`\`\`'
	tail -40 /workspace/judge-out.log; echo '\`\`\`'
	echo; echo "## Self-check tail"; echo '\`\`\`'
	tail -20 /workspace/selfcheck.log; echo '\`\`\`'
	echo; echo "Closes #$ISSUE"
} > /workspace/final-body.md
gh pr create --repo "$YANTRA_REPO" --base "$BASE_BRANCH" --head "$BRANCH" \\
	--title "[Yantra][$TIER] $TITLE" --body-file /workspace/final-body.md
WORK
chown -R node:node /workspace
su node -p -s /bin/bash -c 'export HOME=/home/node; bash /workspace/work.sh'
`;

// Exported for the contract test — pins the two-phase script shape.
export const ensembleScripts = { buildCandidateScript, buildJudgeScript };

/**
 * Pure: render each candidate's exit code + transcript tail for the park
 * comment, so a "every candidate failed" park is diagnosable from the issue
 * itself (not just the backend logs).
 */
export const formatCandidateDiag = (
	cands: { model: string; exitCode: number; tail: string }[],
): string =>
	cands
		.map(
			(c) =>
				`\n\n**${c.model}** (exit ${c.exitCode}):\n\`\`\`\n${
					c.tail.slice(-600) || "(no output)"
				}\n\`\`\``,
		)
		.join("");

// ── orchestration ───────────────────────────────────────────────────────────

interface CandResult {
	model: string;
	branch: string;
	ok: boolean;
	exitCode: number;
	/** Last chunk of the container transcript — the "why" when a candidate fails. */
	tail: string;
}

export const runEnsembleExecute = async (input: {
	repo: string;
	baseBranch: string;
	ghToken: string;
	nvidiaKey: string;
	/** ≥2 execute model refs; each solves in its own parallel container. */
	models: string[];
	/** Grade-role model that synthesises the final solution (never an executor). */
	judge: string;
	issue: number;
	turn: string;
	tier: string;
	adviseJson: unknown;
}): Promise<EnsembleOutcome> => {
	const started = new Date();
	const template =
		(await fetchRepoFile(
			input.repo,
			"ops/yantra/prompts/execute.md",
			input.baseBranch,
			input.ghToken,
		)) ?? "You are a Yantra execute agent. Complete the Product Spec below.";
	const pv = parsePromptVersion(template);

	const issue = await getIssue(input.repo, input.issue, input.ghToken);
	const taskType = issueField(issue.body, "type") || "unknown";
	const branch = `yantra/${input.issue}-${branchSlug(issue.title)}`;

	const promptParts = [
		template,
		`\n## Product Spec (issue #${issue.number}): ${issue.title}\n\n${issue.body ?? ""}`,
		`\n## Approved plan (Advise, tier ${input.tier})\n\`\`\`json\n${JSON.stringify(input.adviseJson ?? {}, null, 2)}\n\`\`\``,
	];
	const conventions = await fetchRepoFile(
		input.repo,
		".brain/conventions.md",
		input.baseBranch,
		input.ghToken,
	);
	if (conventions)
		promptParts.push(`\n## .brain/conventions.md\n\n${conventions}`);
	const prompt = promptParts.join("\n");
	const promptB64 = Buffer.from(prompt, "utf8").toString("base64");

	const baseEnv = {
		PROMPT_B64: promptB64,
		BASE_BRANCH: input.baseBranch,
		YANTRA_REPO: input.repo,
		GH_TOKEN: input.ghToken,
		NVIDIA_API_KEY: input.nvidiaKey,
	};

	// ── Phase 1: candidates in parallel, each in its own container ──────────
	const candScript = buildCandidateScript();
	const candResults: CandResult[] = await Promise.all(
		input.models.map(async (model, idx): Promise<CandResult> => {
			const candBranch = `${branch}-c${idx + 1}`;
			try {
				const r = await runYantraContainer({
					name: `yantra-cand-${input.issue}-${idx + 1}-${ulid().toLowerCase()}`,
					image: EXEC_IMAGE_OC,
					script: candScript,
					env: { ...baseEnv, MODEL: model, CAND_BRANCH: candBranch },
					timeoutMs: CAND_TIMEOUT_MS,
				});
				if (r.exitCode !== 0)
					logger.warn(
						{
							issue: input.issue,
							model,
							exitCode: r.exitCode,
							tail: r.output.slice(-1200),
						},
						"ensemble candidate failed",
					);
				return {
					model,
					branch: candBranch,
					ok: r.exitCode === 0,
					exitCode: r.exitCode,
					tail: r.output.slice(-700),
				};
			} catch (err) {
				const tail = err instanceof Error ? err.message : String(err);
				logger.warn(
					{ err, issue: input.issue, model },
					"ensemble candidate container error",
				);
				return { model, branch: candBranch, ok: false, exitCode: -1, tail };
			}
		}),
	);

	const succeeded = candResults.filter((c) => c.ok);
	const recordCandidates = (outcome: string) =>
		Promise.all(
			candResults.map((c) =>
				recordRun({
					repo: input.repo,
					baseBranch: input.baseBranch,
					turn: input.turn,
					issue: input.issue,
					role: "execute",
					model: c.model,
					lane: "ensemble",
					promptVersion: pv,
					tier: input.tier,
					taskType,
					startedAt: started,
					outcome: c.ok ? outcome : "candidate_failed",
					pr: 0,
				}),
			),
		);

	const park = async (reason: string, outcome: string, diag = "") => {
		await recordCandidates("candidate");
		await recordRun({
			repo: input.repo,
			baseBranch: input.baseBranch,
			turn: input.turn,
			issue: input.issue,
			role: "execute",
			model: input.judge,
			lane: "ensemble",
			promptVersion: pv,
			tier: input.tier,
			taskType,
			startedAt: started,
			outcome,
			pr: 0,
		});
		await addIssueLabels(
			input.repo,
			input.issue,
			["needs-human"],
			input.ghToken,
		);
		await removeIssueLabel(
			input.repo,
			input.issue,
			"agent:working",
			input.ghToken,
		);
		await commentOnIssue(
			input.repo,
			input.issue,
			`🤖 yantra ensemble parked (${reason}). Models: ${input.models.join(", ")}; judge ${input.judge}.${diag}`,
			input.ghToken,
		);
	};

	if (succeeded.length === 0) {
		// Surface each candidate's exit + transcript tail so the failure is
		// diagnosable from the issue itself, not just the backend logs.
		const diag = formatCandidateDiag(candResults);
		await park(
			"every candidate failed or produced no diff",
			"infra_error",
			diag,
		);
		return {
			kind: "parked",
			pr: 0,
			models: input.models,
			judge: input.judge,
			candidatesSucceeded: 0,
		};
	}

	// ── Phase 2: judge synthesises from the candidate branches ──────────────
	let judgeOk = false;
	let judgeNoDiff = false;
	try {
		const r = await runYantraContainer({
			name: `yantra-judge-${input.issue}-${ulid().toLowerCase()}`,
			image: EXEC_IMAGE_OC,
			script: buildJudgeScript(),
			env: {
				...baseEnv,
				JUDGE_MODEL: input.judge,
				BRANCH: branch,
				ISSUE: String(input.issue),
				TIER: input.tier,
				TITLE_B64: Buffer.from(issue.title, "utf8").toString("base64"),
				CAND_BRANCHES_B64: Buffer.from(
					succeeded.map((c) => c.branch).join("\n"),
					"utf8",
				).toString("base64"),
				CAND_MODELS: succeeded.map((c) => c.model).join(", "),
			},
			timeoutMs: JUDGE_TIMEOUT_MS,
		});
		if (r.exitCode === 0) judgeOk = true;
		else if (r.exitCode === NO_DIFF_EXIT) judgeNoDiff = true;
	} catch (err) {
		logger.warn({ err, issue: input.issue }, "ensemble judge container error");
	}

	if (!judgeOk) {
		await park(
			judgeNoDiff ? "judge produced empty diff" : "judge/self-check failure",
			judgeNoDiff ? "no_diff" : "infra_error",
		);
		return {
			kind: judgeNoDiff ? "no_diff" : "parked",
			pr: 0,
			models: input.models,
			judge: input.judge,
			candidatesSucceeded: succeeded.length,
		};
	}

	let pr = 0;
	try {
		const prs = await gh<{ number: number }[]>(
			`/repos/${input.repo}/pulls?head=${encodeURIComponent(
				`${input.repo.split("/")[0]}:${branch}`,
			)}&state=open`,
			input.ghToken,
		);
		pr = prs[0]?.number ?? 0;
	} catch {
		pr = 0;
	}

	await recordCandidates("candidate");
	await recordRun({
		repo: input.repo,
		baseBranch: input.baseBranch,
		turn: input.turn,
		issue: input.issue,
		role: "execute",
		model: input.judge,
		lane: "ensemble",
		promptVersion: pv,
		tier: input.tier,
		taskType,
		startedAt: started,
		outcome: "ok",
		pr,
	});

	await addIssueLabels(
		input.repo,
		input.issue,
		["agent:pr-open"],
		input.ghToken,
	);
	await removeIssueLabel(
		input.repo,
		input.issue,
		"agent:working",
		input.ghToken,
	);
	if (pr)
		await addIssueLabels(
			input.repo,
			pr,
			["agent:pr-open", `tier:${input.tier}`],
			input.ghToken,
		);
	logger.info(
		{
			issue: input.issue,
			pr,
			models: input.models,
			judge: input.judge,
			candidatesSucceeded: succeeded.length,
		},
		"ensemble execute done, PR open",
	);
	return {
		kind: "pr_open",
		pr,
		models: input.models,
		judge: input.judge,
		candidatesSucceeded: succeeded.length,
	};
};

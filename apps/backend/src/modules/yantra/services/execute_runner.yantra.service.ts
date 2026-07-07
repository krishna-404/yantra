import { runYantraContainer } from "@backend/modules/yantra/services/container_runner.yantra.service";
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
	routeModel,
} from "@backend/modules/yantra/services/turn_shared.yantra.service";
import { logger } from "@backend/utils/logger.utils";
import { ulid } from "ulid";

/**
 * EXECUTE (loop-protocol §2.3) — ported from ops/yantra/execute.sh. The
 * container does everything (clone → branch → yarn install → package builds →
 * claude → self-check with one fix pass → push → PR); this service assembles
 * the prompt, applies §2.3 retry semantics, and moves the labels.
 *
 * The in-container work script below is v0's BOOTSTRAP heredoc verbatim
 * except for delivery (SCRIPT_B64 env instead of stdin) — behavior parity is
 * the point (H9/D24), so resist "improvements" here until after cutover.
 */

// Exit 21 = NO_DIFF (agent produced an empty attempt) — not infra, no retry.
const NO_DIFF_EXIT = 21;
const EXECUTE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // X1's 2 h wall-clock cap

export interface ExecuteOutcome {
	kind: "pr_open" | "parked" | "no_diff";
	pr: number;
}

const buildWorkScript = (): string => `set -euo pipefail
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
if [[ "$IS_RETRY" == "1" ]]; then
	git checkout --quiet "$BRANCH"
else
	git checkout --quiet -b "$BRANCH" "origin/$BASE_BRANCH"
fi

yarn install --frozen-lockfile >/workspace/selfcheck.log 2>&1

yarn build --filter='./packages/*' >>/workspace/selfcheck.log 2>&1 || \\
	echo "WARN: package pre-build returned non-zero; check-types may false-red" >>/workspace/selfcheck.log

claude -p "$(cat /workspace/prompt.md)" --model "$MODEL" --dangerously-skip-permissions

selfcheck() {
	yarn lint && yarn check-types && yarn knip && yarn test:db:setup && yarn test:run
}
if ! selfcheck >>/workspace/selfcheck.log 2>&1; then
	echo "--- self-check failed; giving the agent one fix pass ---" >>/workspace/selfcheck.log
	claude -p "The self-check gate failed. Output tail:
$(tail -60 /workspace/selfcheck.log)
Fix the failures. You may not weaken or skip tests. Commit the fix." \\
		--model "$MODEL" --dangerously-skip-permissions
	selfcheck >>/workspace/selfcheck.log 2>&1
fi

git diff --quiet "origin/$BASE_BRANCH"..HEAD 2>/dev/null && { echo "NO_DIFF"; exit ${NO_DIFF_EXIT}; }

git push --quiet -u origin "$BRANCH"

if [[ "$IS_RETRY" == "0" ]]; then
	TITLE=$(echo "$TITLE_B64" | base64 -d)
	{
		cat /workspace/pr-body.md 2>/dev/null || echo "Automated Yantra change for #$ISSUE."
		echo; echo "## Self-check tail"; echo '\`\`\`'
		tail -20 /workspace/selfcheck.log; echo '\`\`\`'
		echo; echo "Closes #$ISSUE"
	} > /workspace/final-body.md
	gh pr create --repo "$YANTRA_REPO" --base "$BASE_BRANCH" --head "$BRANCH" \\
		--title "[Yantra][$TIER] $TITLE" --body-file /workspace/final-body.md
fi
WORK
chown -R node:node /workspace
su node -p -s /bin/bash -c 'export HOME=/home/node; bash /workspace/work.sh'
`;

export const runExecute = async (project: {
	repo: string;
	baseBranch: string;
	ghToken: string;
	claudeToken: string;
	issue: number;
	turn: string;
	tier: string;
	adviseJson: unknown;
	retry?: { pr: number; failures: string };
}): Promise<ExecuteOutcome> => {
	const started = new Date();
	const model =
		routeModel(`execute.${project.tier}`) || routeModel("execute.T1");

	const template =
		(await fetchRepoFile(
			project.repo,
			"ops/yantra/prompts/execute.md",
			project.baseBranch,
			project.ghToken,
		)) ?? "You are a Yantra execute agent. Complete the Product Spec below.";
	const pv = parsePromptVersion(template);

	const issue = await getIssue(project.repo, project.issue, project.ghToken);
	const taskType = issueField(issue.body, "type") || "unknown";
	const branch = `yantra/${project.issue}-${branchSlug(issue.title)}`;

	const promptParts = [
		template,
		`\n## Product Spec (issue #${issue.number}): ${issue.title}\n\n${issue.body ?? ""}`,
		`\n## Approved plan (Advise, tier ${project.tier})\n\`\`\`json\n${JSON.stringify(project.adviseJson ?? {}, null, 2)}\n\`\`\``,
	];
	const conventions = await fetchRepoFile(
		project.repo,
		".brain/conventions.md",
		project.baseBranch,
		project.ghToken,
	);
	if (conventions)
		promptParts.push(`\n## .brain/conventions.md\n\n${conventions}`);
	if (project.retry) {
		promptParts.push(
			`\n## RETRY — the previous attempt FAILED grade. Fix exactly these, on the existing branch:\n${project.retry.failures}`,
		);
	}
	const prompt = promptParts.join("\n");

	// §2.3: infra failure → retry once after 60 s → park needs-human.
	let lastOutput = "no output";
	let ok = false;
	let noDiff = false;
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			const result = await runYantraContainer({
				name: `yantra-execute-${project.issue}-${ulid().toLowerCase()}`,
				script: buildWorkScript(),
				env: {
					PROMPT_B64: Buffer.from(prompt, "utf8").toString("base64"),
					MODEL: model,
					BRANCH: branch,
					ISSUE: String(project.issue),
					TIER: project.tier,
					BASE_BRANCH: project.baseBranch,
					TITLE_B64: Buffer.from(issue.title, "utf8").toString("base64"),
					IS_RETRY: project.retry ? "1" : "0",
					YANTRA_REPO: project.repo,
					GH_TOKEN: project.ghToken,
					CLAUDE_CODE_OAUTH_TOKEN: project.claudeToken,
				},
				timeoutMs: EXECUTE_TIMEOUT_MS,
			});
			lastOutput = result.output;
			if (result.exitCode === 0) {
				ok = true;
				break;
			}
			if (result.exitCode === NO_DIFF_EXIT) {
				noDiff = true;
				break;
			}
			logger.warn(
				{ attempt, exitCode: result.exitCode, issue: project.issue },
				"execute container attempt failed",
			);
		} catch (err) {
			lastOutput = err instanceof Error ? err.message : String(err);
			logger.warn({ err, attempt, issue: project.issue }, "execute run error");
		}
		if (attempt === 1) await new Promise((r) => setTimeout(r, 60_000));
	}

	if (!ok) {
		const tail = lastOutput.slice(-1500);
		await addIssueLabels(
			project.repo,
			project.issue,
			["needs-human"],
			project.ghToken,
		);
		await removeIssueLabel(
			project.repo,
			project.issue,
			"agent:working",
			project.ghToken,
		);
		await commentOnIssue(
			project.repo,
			project.issue,
			`🤖 yantra execute parked (${noDiff ? "empty diff" : "infra/self-check failure"}). Tail:\n\n\`\`\`\n${tail}\n\`\`\``,
			project.ghToken,
		);
		await recordRun({
			repo: project.repo,
			baseBranch: project.baseBranch,
			turn: project.turn,
			issue: project.issue,
			role: "execute",
			model,
			promptVersion: pv,
			tier: project.tier,
			taskType,
			startedAt: started,
			outcome: noDiff ? "no_diff" : "infra_error",
		});
		return { kind: noDiff ? "no_diff" : "parked", pr: 0 };
	}

	// Success: find the PR the container opened, swap labels for grade's scan.
	let pr = project.retry?.pr ?? 0;
	if (!pr) {
		try {
			const prs = await gh<{ number: number }[]>(
				`/repos/${project.repo}/pulls?head=${encodeURIComponent(
					`${project.repo.split("/")[0]}:${branch}`,
				)}&state=open`,
				project.ghToken,
			);
			pr = prs[0]?.number ?? 0;
		} catch {
			pr = 0;
		}
	}
	await addIssueLabels(
		project.repo,
		project.issue,
		["agent:pr-open"],
		project.ghToken,
	);
	await removeIssueLabel(
		project.repo,
		project.issue,
		"agent:working",
		project.ghToken,
	);
	if (pr) {
		await addIssueLabels(
			project.repo,
			pr,
			["agent:pr-open", `tier:${project.tier}`],
			project.ghToken,
		);
	}
	await recordRun({
		repo: project.repo,
		baseBranch: project.baseBranch,
		turn: project.turn,
		issue: project.issue,
		role: "execute",
		model,
		promptVersion: pv,
		tier: project.tier,
		taskType,
		startedAt: started,
		outcome: "ok",
		pr,
	});
	logger.info({ issue: project.issue, pr }, "yantra execute done, PR open");
	return { kind: "pr_open", pr };
};

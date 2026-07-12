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
 * FREE-LANE EXECUTE (Phase 3) — the execute runner's twin, but the coding
 * agent inside the container is OpenCode driving a free provider (NVIDIA
 * today) instead of Claude Code. Same in/out contract: clone → branch →
 * install → package build → agent → self-check (one fix pass) → push → PR.
 *
 * The ONLY behavioural difference from execute_runner is the agent command:
 * `opencode run "<prompt>" -m <modelRef> --dangerously-skip-permissions`
 * vs `claude -p …`. Everything the harness owns (labels, retry, PR, self-
 * check gates) is identical, so grade/rails treat a free-lane PR exactly
 * like a Claude one — which is the point: the lane is invisible downstream.
 *
 * Telemetry records `lane` = the model ref so scorecards (D26) can grade it.
 */

const NO_DIFF_EXIT = 21;
const FREE_EXEC_TIMEOUT_MS = 2 * 60 * 60 * 1000; // same 2h wall cap as execute

export interface FreeLaneOutcome {
	kind: "pr_open" | "parked" | "no_diff";
	pr: number;
}

// v0's execute BOOTSTRAP, with `claude -p` swapped for `opencode run`. Kept a
// near-verbatim twin so the two lanes stay behaviourally identical (the model
// ref arrives as $MODEL, the provider key as $NVIDIA_API_KEY via opencode.json).
const buildOcWorkScript = (): string => `set -euo pipefail
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

opencode run "$(cat /workspace/prompt.md)" -m "$MODEL" --dangerously-skip-permissions

selfcheck() {
	yarn lint && yarn check-types && yarn knip && yarn test:db:setup && yarn test:run
}
if ! selfcheck >>/workspace/selfcheck.log 2>&1; then
	echo "--- self-check failed; giving the agent one fix pass ---" >>/workspace/selfcheck.log
	opencode run "The self-check gate failed. Output tail:
$(tail -60 /workspace/selfcheck.log)
Fix the failures. You may not weaken or skip tests. Commit the fix." \\
		-m "$MODEL" --dangerously-skip-permissions
	selfcheck >>/workspace/selfcheck.log 2>&1
fi

git diff --quiet "origin/$BASE_BRANCH"..HEAD 2>/dev/null && { echo "NO_DIFF"; exit ${NO_DIFF_EXIT}; }

git push --quiet -u origin "$BRANCH"

if [[ "$IS_RETRY" == "0" ]]; then
	TITLE=$(echo "$TITLE_B64" | base64 -d)
	{
		echo "Automated Yantra change for #$ISSUE (free lane: $MODEL)."
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

export const runFreeLaneExecute = async (input: {
	repo: string;
	baseBranch: string;
	ghToken: string;
	nvidiaKey: string;
	/** OpenCode model ref, e.g. "nvidia/qwen/qwen3-coder-480b-a35b-instruct". */
	modelRef: string;
	issue: number;
	turn: string;
	tier: string;
	adviseJson: unknown;
}): Promise<FreeLaneOutcome> => {
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

	let lastOutput = "no output";
	let ok = false;
	let noDiff = false;
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			const result = await runYantraContainer({
				name: `yantra-oc-exec-${input.issue}-${ulid().toLowerCase()}`,
				image: EXEC_IMAGE_OC,
				script: buildOcWorkScript(),
				env: {
					PROMPT_B64: Buffer.from(prompt, "utf8").toString("base64"),
					MODEL: input.modelRef,
					BRANCH: branch,
					ISSUE: String(input.issue),
					TIER: input.tier,
					BASE_BRANCH: input.baseBranch,
					TITLE_B64: Buffer.from(issue.title, "utf8").toString("base64"),
					IS_RETRY: "0",
					YANTRA_REPO: input.repo,
					GH_TOKEN: input.ghToken,
					NVIDIA_API_KEY: input.nvidiaKey,
				},
				timeoutMs: FREE_EXEC_TIMEOUT_MS,
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
				{
					attempt,
					exitCode: result.exitCode,
					issue: input.issue,
					model: input.modelRef,
				},
				"free-lane execute attempt failed",
			);
		} catch (err) {
			lastOutput = err instanceof Error ? err.message : String(err);
			logger.warn({ err, attempt, issue: input.issue }, "free-lane run error");
		}
		if (attempt === 1) await new Promise((r) => setTimeout(r, 60_000));
	}

	const record = (outcome: string, pr: number) =>
		recordRun({
			repo: input.repo,
			baseBranch: input.baseBranch,
			turn: input.turn,
			issue: input.issue,
			role: "execute",
			model: input.modelRef,
			promptVersion: pv,
			tier: input.tier,
			taskType,
			startedAt: started,
			outcome,
			pr,
		});

	if (!ok) {
		const tail = lastOutput.slice(-1500);
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
			`🤖 yantra free-lane execute (${input.modelRef}) parked (${noDiff ? "empty diff" : "infra/self-check failure"}). Tail:\n\n\`\`\`\n${tail}\n\`\`\``,
			input.ghToken,
		);
		await record(noDiff ? "no_diff" : "infra_error", 0);
		return { kind: noDiff ? "no_diff" : "parked", pr: 0 };
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
	if (pr) {
		await addIssueLabels(
			input.repo,
			pr,
			["agent:pr-open", `tier:${input.tier}`],
			input.ghToken,
		);
	}
	await record("ok", pr);
	logger.info(
		{ issue: input.issue, pr, model: input.modelRef },
		"free-lane execute done, PR open",
	);
	return { kind: "pr_open", pr };
};

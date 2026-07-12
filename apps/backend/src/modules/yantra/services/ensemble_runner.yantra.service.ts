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
 * ENSEMBLE EXECUTE (Phase 3, operator directive 2026-07-12) — every task goes
 * to N free models, then a strong free model SYNTHESISES one answer from all N.
 *
 * Why: divergence between models on the same spec is the scoring signal ("what
 * is each model better at"); combining their strengths covers more of the
 * solution space than any single model. The operator chose synthesis (not
 * pick-best, not mechanical merge): the judge blends the candidates, and the
 * blended diff must still pass the full self-check gate before a PR opens.
 *
 * One container, one clone/install: each model solves the spec on its own
 * branch (captured as a diff), then the judge reads all diffs + the spec and
 * edits the repo to implement the synthesised solution on the PR branch. This
 * keeps the whole ensemble atomic and within the D18 container caps — no
 * cross-container branch coordination.
 *
 * The lane is invisible downstream: the PR grade + rails treat an ensemble PR
 * exactly like any other. Telemetry records one row per candidate model plus
 * the synthesis, so scorecards (D26) can grade each model over time.
 */

const NO_DIFF_EXIT = 21;
const ENSEMBLE_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 3h: N candidates + judge, serial

export interface EnsembleOutcome {
	kind: "pr_open" | "parked" | "no_diff";
	pr: number;
	models: string[];
	judge: string;
}

// v0's execute BOOTSTRAP shape, extended to a candidate loop + a synthesis
// judge. Every model ref arrives via env (MODELS_B64 newline list, JUDGE_MODEL);
// the provider key arrives as $NVIDIA_API_KEY, read by opencode.json. The WORK
// heredoc is single-quoted so bash expands nothing at write-time — env vars
// resolve at run-time under the `node` user (su -p preserves the environment).
export const buildEnsembleScript = (): string => `set -euo pipefail
pg_ctlcluster "$(ls /etc/postgresql | head -1)" main start
su postgres -c "psql -qc \\"ALTER USER postgres PASSWORD 'postgres';\\""
mkdir -p /workspace
echo "$PROMPT_B64" | base64 -d > /workspace/prompt.md
echo "$MODELS_B64" | base64 -d > /workspace/models.txt
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

yarn install --frozen-lockfile >/workspace/selfcheck.log 2>&1
yarn build --filter='./packages/*' >>/workspace/selfcheck.log 2>&1 || \\
	echo "WARN: package pre-build returned non-zero; check-types may false-red" >>/workspace/selfcheck.log

# ---- candidates: each model solves the spec on its own branch ----
i=0
CAND_SUMMARY=""
while IFS= read -r MODEL <&3; do
	[ -z "$MODEL" ] && continue
	i=$((i+1))
	git reset --hard -q "$BASE"; git clean -fdq
	git checkout -q -B "cand-$i" "$BASE"
	echo "=== candidate $i: $MODEL ===" >>/workspace/agents.log
	opencode run "$(cat /workspace/prompt.md)" -m "$MODEL" --dangerously-skip-permissions </dev/null >>/workspace/agents.log 2>&1 || true
	git add -A >/dev/null 2>&1 || true
	git commit -q -m "candidate $i ($MODEL)" >/dev/null 2>&1 || true
	git diff "$BASE".."cand-$i" > "/workspace/cand-$i.patch" 2>/dev/null || true
	LINES=$(wc -l < "/workspace/cand-$i.patch" 2>/dev/null | tr -d ' ')
	CAND_SUMMARY="\${CAND_SUMMARY}- candidate $i: $MODEL (\${LINES:-0} diff lines)"$'\\n'
done 3< /workspace/models.txt

# ---- judge synthesises the single best solution on the PR branch ----
git reset --hard -q "$BASE"; git clean -fdq
git checkout -q -B "$BRANCH" "$BASE"
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

git diff --quiet "$BASE"..HEAD 2>/dev/null && { echo "NO_DIFF"; exit ${NO_DIFF_EXIT}; }

git push --quiet -u origin "$BRANCH"

TITLE=$(echo "$TITLE_B64" | base64 -d)
{
	echo "Automated Yantra change for #$ISSUE via $i-model ensemble (synthesis judge)."
	echo; echo "## Candidate models"; printf '%b' "$CAND_SUMMARY"
	echo; echo "Synthesis judge: $JUDGE_MODEL"
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

export const runEnsembleExecute = async (input: {
	repo: string;
	baseBranch: string;
	ghToken: string;
	nvidiaKey: string;
	/** ≥2 execute model refs; each writes its own candidate diff. */
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

	let lastOutput = "no output";
	let ok = false;
	let noDiff = false;
	try {
		const result = await runYantraContainer({
			name: `yantra-ens-${input.issue}-${ulid().toLowerCase()}`,
			image: EXEC_IMAGE_OC,
			script: buildEnsembleScript(),
			env: {
				PROMPT_B64: Buffer.from(prompt, "utf8").toString("base64"),
				MODELS_B64: Buffer.from(input.models.join("\n"), "utf8").toString(
					"base64",
				),
				JUDGE_MODEL: input.judge,
				BRANCH: branch,
				ISSUE: String(input.issue),
				TIER: input.tier,
				BASE_BRANCH: input.baseBranch,
				TITLE_B64: Buffer.from(issue.title, "utf8").toString("base64"),
				YANTRA_REPO: input.repo,
				GH_TOKEN: input.ghToken,
				NVIDIA_API_KEY: input.nvidiaKey,
			},
			timeoutMs: ENSEMBLE_TIMEOUT_MS,
		});
		lastOutput = result.output;
		if (result.exitCode === 0) ok = true;
		else if (result.exitCode === NO_DIFF_EXIT) noDiff = true;
		else
			logger.warn(
				{ exitCode: result.exitCode, issue: input.issue },
				"ensemble execute failed",
			);
	} catch (err) {
		lastOutput = err instanceof Error ? err.message : String(err);
		logger.warn({ err, issue: input.issue }, "ensemble run error");
	}

	// One telemetry row per candidate model (participation + scoring key), plus
	// the synthesis row carrying the PR. All share the turn so a scorecard can
	// join them back into one ensemble run.
	const recordCandidates = async () => {
		for (const model of input.models) {
			await recordRun({
				repo: input.repo,
				baseBranch: input.baseBranch,
				turn: input.turn,
				issue: input.issue,
				role: "execute",
				model,
				lane: "ensemble",
				promptVersion: pv,
				tier: input.tier,
				taskType,
				startedAt: started,
				outcome: "candidate",
				pr: 0,
			});
		}
	};

	if (!ok) {
		await recordCandidates();
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
			outcome: noDiff ? "no_diff" : "infra_error",
			pr: 0,
		});
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
			`🤖 yantra ensemble execute parked (${noDiff ? "empty diff" : "infra/self-check failure"}). Models: ${input.models.join(", ")}; judge ${input.judge}. Tail:\n\n\`\`\`\n${tail}\n\`\`\``,
			input.ghToken,
		);
		return {
			kind: noDiff ? "no_diff" : "parked",
			pr: 0,
			models: input.models,
			judge: input.judge,
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

	await recordCandidates();
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
		{ issue: input.issue, pr, models: input.models, judge: input.judge },
		"ensemble execute done, PR open",
	);
	return { kind: "pr_open", pr, models: input.models, judge: input.judge };
};

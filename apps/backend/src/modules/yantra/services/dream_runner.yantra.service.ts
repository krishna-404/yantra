import { runYantraContainer } from "@backend/modules/yantra/services/container_runner.yantra.service";
import { gh } from "@backend/modules/yantra/services/gh_client.yantra.service";
import {
	fetchRepoFile,
	parsePromptVersion,
} from "@backend/modules/yantra/services/repo_files.yantra.service";
import {
	recordRun,
	routeModel,
} from "@backend/modules/yantra/services/turn_shared.yantra.service";
import { logger } from "@backend/utils/logger.utils";
import { ulid } from "ulid";

/**
 * DREAM (loop-protocol §2.5) — nightly knowledge consolidation, ported from the
 * retired ops/yantra/dream-nightly.sh.
 *
 * This is a REPAIR as much as a port: DREAM only ever existed in the VPS shell
 * loop, and it had been failing every night with rc=1 since that host's Claude
 * subscription was revoked — the knowledge loop was silently dead. Running it
 * in-app puts it under the same per-project config as everything else.
 *
 * Contract (from ops/yantra/prompts/dream-nightly.md, kept in the repo for this):
 * at most ONE PR touching only `.brain/`, always `tier:T3`, NEVER auto-merged.
 * An empty night is a valid, common outcome — most nights nothing clears the
 * promotion bar (≥2 independent runs, or 1 run + explicit human confirmation).
 */

const DREAM_TIMEOUT_MS = 25 * 60 * 1000;

export interface DreamProject {
	id: string;
	repo: string;
	/** PRs target the promotion branch — staging is a disposable preview (#24). */
	productionBranch: string;
	ghToken: string;
	claudeToken: string;
}

/** Today's merged/closed PRs, the evidence DREAM weighs lessons against. */
const recentPrs = async (repo: string, token: string): Promise<string> => {
	const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
		.toISOString()
		.slice(0, 10);
	try {
		const res = await gh<{
			items: { number: number; title: string; state: string }[];
		}>(
			`/search/issues?q=${encodeURIComponent(
				`repo:${repo} is:pr updated:>=${since}`,
			)}&per_page=30`,
			token,
		);
		if (res.items.length === 0) return "(no PR activity in the last 24h)";
		return res.items
			.map((p) => `#${p.number} [${p.state}] ${p.title}`)
			.join("\n");
	} catch {
		return "(PR history unavailable)";
	}
};

const buildDreamScript = (): string => `
set -uo pipefail
cd /workspace
git config --global user.email "yantra-bot@users.noreply.github.com"
git config --global user.name "yantra-bot"
git clone --quiet -b "$BASE_BRANCH" "https://x-access-token:\${GH_TOKEN}@github.com/\${YANTRA_REPO}.git" repo || exit 40
cd repo
git checkout --quiet -b "$BRANCH" "origin/$BASE_BRANCH" || exit 40

echo "=== dream run ($MODEL) ==="
timeout 1200 claude -p "$(cat /workspace/prompt.md)" --model "$MODEL" --dangerously-skip-permissions </dev/null \
  || echo "WARN: dream agent exited non-zero or timed out"

# Rail: DREAM may only ever touch .brain/. Anything else is a bug in the run —
# drop the whole thing rather than open a PR that trips R2 at grade time.
if ! git diff --quiet; then
  OUTSIDE=$(git diff --name-only | grep -v '^\\.brain/' || true)
  if [ -n "$OUTSIDE" ]; then
    echo "REFUSED: dream touched files outside .brain/:"; echo "$OUTSIDE"
    exit 41
  fi
  git add -A .brain/
  git commit --quiet -m "chore(brain): nightly consolidation

Co-authored-by: yantra-bot <yantra-bot@users.noreply.github.com>" || exit 42
  git push --quiet -u origin "$BRANCH" || exit 43
  gh pr create --repo "$YANTRA_REPO" --base "$BASE_BRANCH" --head "$BRANCH" \\
    --title "[Yantra][T3] DREAM: nightly consolidation" \\
    --body "Nightly DREAM consolidation. Touches only \\\`.brain/\\\`.

Tier T3 — never auto-merged; waits for human review per loop-protocol §2.5." \\
    --label "tier:T3" || exit 44
  echo "DREAM_PR_OPENED"
else
  echo "DREAM_EMPTY_NIGHT"
fi
`;

/**
 * One nightly consolidation pass for a project. Never throws: a failed dream is
 * logged and forgotten, exactly like v0 — it must never wedge the tick or the
 * cron that calls it.
 */
export const runDream = async (project: DreamProject): Promise<string> => {
	const started = new Date();
	const turn = ulid();
	const model = routeModel("dream");
	const branch = `yantra/dream-${new Date().toISOString().slice(0, 10)}`;

	const template = await fetchRepoFile(
		project.repo,
		"ops/yantra/prompts/dream-nightly.md",
		project.productionBranch,
		project.ghToken,
	);
	if (!template) {
		logger.warn({ repo: project.repo }, "dream: prompt missing — skipped");
		return "no_prompt";
	}

	const prompt = [
		template,
		"",
		"## Today's PR activity",
		await recentPrs(project.repo, project.ghToken),
		"",
		"The repo is cloned at /workspace/repo — read `.brain/inbox/` there for the",
		"current stubs and their strike counts.",
	].join("\n");

	try {
		const result = await runYantraContainer({
			name: `yantra-dream-${turn}`,
			script: buildDreamScript(),
			env: {
				PROMPT_B64: Buffer.from(prompt, "utf8").toString("base64"),
				MODEL: model,
				BRANCH: branch,
				BASE_BRANCH: project.productionBranch,
				YANTRA_REPO: project.repo,
				GH_TOKEN: project.ghToken,
				CLAUDE_CODE_OAUTH_TOKEN: project.claudeToken,
			},
			timeoutMs: DREAM_TIMEOUT_MS,
		});

		const opened = result.output.includes("DREAM_PR_OPENED");
		const refused = result.exitCode === 41;
		const outcome = refused
			? "refused_outside_brain"
			: opened
				? "pr_opened"
				: "empty_night";

		await recordRun({
			turn,
			repo: project.repo,
			baseBranch: project.productionBranch,
			issue: 0,
			role: "dream",
			model,
			promptVersion: parsePromptVersion(template),
			tier: "T3",
			taskType: "dream",
			startedAt: started,
			outcome,
		});
		logger.info({ repo: project.repo, outcome }, "yantra dream finished");
		return outcome;
	} catch (err) {
		logger.error({ err, repo: project.repo }, "yantra dream failed");
		return "infra_error";
	}
};

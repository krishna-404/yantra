import { runYantraContainer } from "@backend/modules/yantra/services/container_runner.yantra.service";
import {
	fetchRepoFile,
	parsePromptVersion,
} from "@backend/modules/yantra/services/repo_files.yantra.service";
import {
	addIssueLabels,
	commentOnIssue,
	extractJsonBlock,
	getIssue,
	issueField,
	recordRun,
	removeIssueLabel,
	routeModel,
} from "@backend/modules/yantra/services/turn_shared.yantra.service";
import { logger } from "@backend/utils/logger.utils";
import { ulid } from "ulid";

/**
 * ADVISE (loop-protocol §2.2) — the blocking plan gate, ported from
 * ops/yantra/advise.sh. The model runs inside a yantra-exec container
 * (the backend has no claude CLI); prompt = advise.md template + spec +
 * .brain/decisions.md + .brain/conventions.md, all fetched from the repo.
 *
 * Outcomes mirror the script's exit codes:
 *   proceed  → tier label added, verdict JSON returned (execute follows)
 *   parked   → needs-human added, agent:working removed, release comment
 *   infra    → caller releases the claim (retry next tick)
 */

export interface AdviseOutcome {
	kind: "proceed" | "parked" | "infra_error";
	tier: string;
	verdictJson: unknown;
}

const ADVISE_TIMEOUT_MS = 15 * 60 * 1000;

interface AdviseVerdict {
	verdict?: string;
	tier?: string;
}

export const runAdvise = async (project: {
	repo: string;
	baseBranch: string;
	ghToken: string;
	claudeToken: string;
	issue: number;
	turn: string;
}): Promise<AdviseOutcome> => {
	const started = new Date();
	const model = routeModel("advise");
	const infra = async (
		taskType: string,
		pv: number,
	): Promise<AdviseOutcome> => {
		await recordRun({
			repo: project.repo,
			baseBranch: project.baseBranch,
			turn: project.turn,
			issue: project.issue,
			role: "advise",
			model,
			promptVersion: pv,
			tier: "",
			taskType,
			startedAt: started,
			outcome: "infra_error",
		});
		return { kind: "infra_error", tier: "", verdictJson: null };
	};

	const template = await fetchRepoFile(
		project.repo,
		"ops/yantra/prompts/advise.md",
		project.baseBranch,
		project.ghToken,
	);
	if (!template) return infra("unknown", 1);
	const pv = parsePromptVersion(template);

	const issue = await getIssue(project.repo, project.issue, project.ghToken);
	const taskType = issueField(issue.body, "type") || "unknown";

	const parts = [
		template,
		`\n## Product Spec (issue #${issue.number}): ${issue.title}\n\n${issue.body ?? ""}`,
	];
	for (const brain of ["decisions", "conventions"]) {
		const text = await fetchRepoFile(
			project.repo,
			`.brain/${brain}.md`,
			project.baseBranch,
			project.ghToken,
		);
		if (text) parts.push(`\n## .brain/${brain}.md\n\n${text}`);
	}
	const prompt = parts.join("\n");

	// The container just runs claude and prints; parsing happens here.
	const script = [
		"set -euo pipefail",
		'echo "$PROMPT_B64" | base64 -d > /tmp/prompt.md',
		"export HOME=/home/node",
		"chown node:node /tmp/prompt.md",
		`su node -p -s /bin/bash -c 'export HOME=/home/node; claude -p "$(cat /tmp/prompt.md)" --model "$MODEL"'`,
	].join("\n");

	let output = "";
	try {
		const result = await runYantraContainer({
			name: `yantra-advise-${project.issue}-${ulid().toLowerCase()}`,
			script,
			env: {
				PROMPT_B64: Buffer.from(prompt, "utf8").toString("base64"),
				MODEL: model,
				CLAUDE_CODE_OAUTH_TOKEN: project.claudeToken,
			},
			timeoutMs: ADVISE_TIMEOUT_MS,
		});
		if (result.exitCode !== 0) {
			logger.error(
				{
					issue: project.issue,
					exitCode: result.exitCode,
					timedOut: result.timedOut,
				},
				"advise container failed",
			);
			return infra(taskType, pv);
		}
		output = result.output;
	} catch (err) {
		logger.error({ err, issue: project.issue }, "advise container error");
		return infra(taskType, pv);
	}

	const verdictJson = extractJsonBlock(output) as AdviseVerdict | null;
	if (!verdictJson || typeof verdictJson.verdict !== "string") {
		return infra(taskType, pv);
	}
	const verdict = verdictJson.verdict;
	const tier = typeof verdictJson.tier === "string" ? verdictJson.tier : "";
	const run = ulid();

	await commentOnIssue(
		project.repo,
		project.issue,
		`🤖 yantra advise run=${run} model=${model}\n\n\`\`\`json\n${JSON.stringify(verdictJson, null, 2)}\n\`\`\``,
		project.ghToken,
	);

	if (verdict === "PROCEED") {
		if (tier) {
			await addIssueLabels(
				project.repo,
				project.issue,
				[`tier:${tier}`],
				project.ghToken,
			);
		}
		await recordRun({
			repo: project.repo,
			baseBranch: project.baseBranch,
			turn: project.turn,
			issue: project.issue,
			role: "advise",
			model,
			promptVersion: pv,
			tier,
			taskType,
			startedAt: started,
			outcome: "ok",
		});
		return { kind: "proceed", tier, verdictJson };
	}

	if (verdict === "AMBIGUOUS" || verdict === "REJECT") {
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
			`🤖 yantra release run=${run} — parked (${verdict}), claim released.`,
			project.ghToken,
		);
		await recordRun({
			repo: project.repo,
			baseBranch: project.baseBranch,
			turn: project.turn,
			issue: project.issue,
			role: "advise",
			model,
			promptVersion: pv,
			tier,
			taskType,
			startedAt: started,
			outcome: "parked",
		});
		return { kind: "parked", tier, verdictJson };
	}

	return infra(taskType, pv);
};

import { db } from "@backend/db/db";
import { runAdvise } from "@backend/modules/yantra/services/advise_runner.yantra.service";
import { getAppSecretValue } from "@backend/modules/yantra/services/app_secrets.yantra.service";
import { runEnsembleExecute } from "@backend/modules/yantra/services/ensemble_runner.yantra.service";
import { runExecute } from "@backend/modules/yantra/services/execute_runner.yantra.service";
import { gh } from "@backend/modules/yantra/services/gh_client.yantra.service";
import { candidateModels } from "@backend/modules/yantra/services/lanes.yantra.service";
import { openSecret } from "@backend/modules/yantra/services/secret_box.yantra.service";
import {
	addIssueLabels,
	commentOnIssue,
	removeIssueLabel,
} from "@backend/modules/yantra/services/turn_shared.yantra.service";
import { logger } from "@backend/utils/logger.utils";

/**
 * One LIVE turn (loop-protocol §2.2–§2.3): advise gate → execute container →
 * PR open. Runs as a pg-tbus task so a two-hour execute never blocks the
 * 10-minute tick, and a backend restart mid-turn surfaces in the task log
 * instead of vanishing.
 *
 * The claim (labels + claim comment) already happened in the tick before the
 * task was queued — this handler owns everything after it, including releasing
 * the claim on every failure path. Kill switch is re-checked here (fail
 * closed), matching v0's "re-check at every transition".
 *
 * Grade is NOT here yet: live turns currently end at PR-open + CI. The grade
 * runner (H8 rails) is the next slice; until then a human (or v0's grader,
 * while it still runs) closes the loop. Tenant-zero stays in shadow mode
 * until the D24 parity gate anyway.
 */

const releaseClaim = async (
	repo: string,
	issue: number,
	token: string,
	reason: string,
): Promise<void> => {
	await addIssueLabels(repo, issue, ["spec:ready"], token).catch(() => {});
	await removeIssueLabel(repo, issue, "agent:working", token);
	await commentOnIssue(
		repo,
		issue,
		`🤖 yantra: ${reason} — claim released, will retry next tick.`,
		token,
	).catch(() => {});
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

export const runLiveTurn = async (input: {
	projectId: string;
	issue: number;
	turn: string;
}): Promise<void> => {
	const project = await db.yantraProjects.findByOptional({
		id: input.projectId,
	});
	if (!project || !project.enabled || project.mode !== "live") {
		logger.warn(
			{ projectId: input.projectId, issue: input.issue },
			"live turn dropped: project missing, paused, or no longer live",
		);
		return;
	}
	const ghToken = openSecret(project.ghTokenCiphertext);
	const { repo, baseBranch } = project;

	const claudeToken = await getAppSecretValue("CLAUDE_CODE_OAUTH_TOKEN");
	if (!claudeToken) {
		await releaseClaim(
			repo,
			input.issue,
			ghToken,
			"no Claude token configured (cockpit → Runner infrastructure)",
		);
		return;
	}

	if (await killSwitchOn(repo, ghToken)) {
		await releaseClaim(repo, input.issue, ghToken, "kill switch on");
		return;
	}

	const advise = await runAdvise({
		repo,
		baseBranch,
		ghToken,
		claudeToken,
		issue: input.issue,
		turn: input.turn,
	});
	if (advise.kind === "parked") return; // advise already parked + released
	if (advise.kind === "infra_error") {
		await releaseClaim(repo, input.issue, ghToken, "advise infra error");
		return;
	}

	if (await killSwitchOn(repo, ghToken)) {
		await releaseClaim(repo, input.issue, ghToken, "kill switch on");
		return;
	}

	const tier = advise.tier || "T1";

	// Execution lane: when free models are configured, EVERY task runs through
	// the parallel ensemble (operator directive 2026-07-12 — every task to ≥3
	// LLMs). Advise stays on Claude (the plan gate); the ensemble writes the
	// code and a free judge synthesises. Falls back to the Claude execute
	// container when NVIDIA isn't set up (or too few models exist). The self-
	// check gate + grade + rails are identical either way, so the lane choice
	// never affects what can merge.
	const nvidiaKey = await getAppSecretValue("NVIDIA_API_KEY");
	const models = nvidiaKey
		? candidateModels("execute", ["nvidia"])
				.slice(0, 3)
				.map((m) => m.ref)
		: [];
	const judge = nvidiaKey ? candidateModels("grade", ["nvidia"])[0]?.ref : null;

	if (nvidiaKey && models.length >= 2 && judge) {
		await runEnsembleExecute({
			repo,
			baseBranch,
			ghToken,
			nvidiaKey,
			models,
			judge,
			issue: input.issue,
			turn: input.turn,
			tier,
			adviseJson: advise.verdictJson,
		});
		// Ensemble handles its own park/labels/telemetry on every path.
		return;
	}

	await runExecute({
		repo,
		baseBranch,
		ghToken,
		claudeToken,
		issue: input.issue,
		turn: input.turn,
		tier,
		adviseJson: advise.verdictJson,
	});
	// Execute handles its own park/labels/telemetry on every path.
};

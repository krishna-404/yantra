import { db } from "@backend/db/db";
import { getAppSecretValue } from "@backend/modules/yantra/services/app_secrets.yantra.service";
import { runDream } from "@backend/modules/yantra/services/dream_runner.yantra.service";
import { listEnabledProjectsWithTokens } from "@backend/modules/yantra/services/projects.yantra.service";
import { logger } from "@backend/utils/logger.utils";
import cron, { type ScheduledTask } from "node-cron";

// Distinct advisory-lock key from the shadow tick (…003), reconcile (…002) and
// docker prune (…004) so none of the yantra locks collide.
const DREAM_LOCK_KEY = 823_401_101_005n;

let scheduledTask: ScheduledTask | null = null;

/**
 * Nightly DREAM consolidation (loop-protocol §2.5), in-app.
 *
 * This restores a loop that had been DEAD: DREAM lived only in the retired VPS
 * shell harness, where it failed with rc=1 every night after that host's Claude
 * subscription was revoked. Nobody noticed because a failed dream is silent by
 * design. Running it here puts it on the same per-project config, secrets and
 * telemetry as every other role.
 *
 * Runs per enabled LIVE project, serially — dream containers are slow and there
 * is no reason to race them. One project failing never stops the others, and
 * the advisory lock keeps it multi-replica safe.
 */
export async function yantraDreamOnce(): Promise<void> {
	try {
		await db.$transaction(async () => {
			const lockResult = await db.$query<{ acquired: boolean }>`
				SELECT pg_try_advisory_xact_lock(${DREAM_LOCK_KEY}::bigint) AS acquired
			`;
			if (!lockResult.rows[0]?.acquired) return;

			const claudeToken = await getAppSecretValue("CLAUDE_CODE_OAUTH_TOKEN");
			if (!claudeToken) {
				logger.warn("yantra dream skipped: no Claude token configured");
				return;
			}

			const projects = (await listEnabledProjectsWithTokens()).filter(
				(p) => p.mode === "live",
			);
			for (const project of projects) {
				const outcome = await runDream({
					id: project.id,
					repo: project.repo,
					// PRs target the promotion branch — staging is a disposable
					// force-pushed preview, so a dream PR merged there would vanish
					// (exactly what happened to the v0 nightlies).
					productionBranch: project.productionBranch || project.baseBranch,
					ghToken: project.ghToken,
					claudeToken,
				});
				logger.info(
					{ repo: project.repo, outcome },
					"yantra dream project done",
				);
			}
		});
	} catch (error) {
		logger.error({ err: error }, "yantra dream cron failed");
	}
}

export function startYantraDreamCron(): void {
	// 21:30 UTC = 03:00 IST, matching the retired v0 timer, and offset from the
	// 04:17 UTC prune so the two nightly jobs never contend.
	scheduledTask = cron.schedule("30 21 * * *", () => {
		void yantraDreamOnce();
	});
	logger.info("yantra dream cron scheduled (21:30 UTC / 03:00 IST)");
}

export function stopYantraDreamCron(): void {
	if (scheduledTask) {
		scheduledTask.stop();
		scheduledTask = null;
	}
}

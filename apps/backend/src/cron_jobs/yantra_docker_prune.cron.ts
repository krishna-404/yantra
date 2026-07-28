import { db } from "@backend/db/db";
import { pruneDocker } from "@backend/modules/yantra/services/docker_prune.yantra.service";
import { logger } from "@backend/utils/logger.utils";
import cron, { type ScheduledTask } from "node-cron";

// Distinct advisory-lock key from the shadow tick (…003) and reconcile (…002)
// so none of the yantra locks collide.
const DOCKER_PRUNE_LOCK_KEY = 823_401_101_004n;

let scheduledTask: ScheduledTask | null = null;

/**
 * Nightly disk reclaim (self-maintaining, operator: "the system should be
 * self-maintaining — why do I have to SSH?"). Ensemble runs and staging deploys
 * accumulate dangling images + build cache until the VPS disk fills and new
 * containers die at `yarn install` with ENOSPC. This prunes that bloat once a
 * day so the disk never reaches that point; the cockpit button covers the gap
 * if it fills between passes. The advisory lock keeps it multi-replica safe.
 */
export async function yantraDockerPruneOnce(): Promise<void> {
	try {
		await db.$transaction(async () => {
			const lockResult = await db.$query<{ acquired: boolean }>`
				SELECT pg_try_advisory_xact_lock(${DOCKER_PRUNE_LOCK_KEY}::bigint) AS acquired
			`;
			if (!lockResult.rows[0]?.acquired) return;
			const result = await pruneDocker();
			logger.info(
				{ reclaimed: result.reclaimedHuman, ok: result.ok },
				"yantra nightly docker prune",
			);
		});
	} catch (error) {
		logger.error({ err: error }, "yantra docker prune cron failed");
	}
}

export function startYantraDockerPruneCron(): void {
	// 04:17 UTC daily — off-peak, and offset from round-hour crons so the prune
	// doesn't contend with a tick or a deploy.
	scheduledTask = cron.schedule("17 4 * * *", () => {
		void yantraDockerPruneOnce();
	});
	logger.info("yantra docker prune scheduled (daily 04:17 UTC)");
}

export function stopYantraDockerPruneCron(): void {
	scheduledTask?.stop();
	scheduledTask = null;
}

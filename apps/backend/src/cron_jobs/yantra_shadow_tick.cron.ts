import { env } from "@backend/configs/env.config";
import { db } from "@backend/db/db";
import { runShadowTick } from "@backend/modules/yantra/services/shadow_tick.yantra.service";
import { logger } from "@backend/utils/logger.utils";
import cron, { type ScheduledTask } from "node-cron";

// Distinct from reconcile (…002) so the advisory locks never collide.
const SHADOW_TICK_LOCK_KEY = 823_401_101_003n;

let scheduledTask: ScheduledTask | null = null;

/**
 * H4 shadow mode: every 10 minutes (same cadence as the VPS loop's systemd
 * timer) the app decides what the harness WOULD do and records it — the H9
 * parity record. Advisory lock = multi-replica safe. Gated on
 * YANTRA_GH_TOKEN; absent means the tick never starts.
 */
export async function yantraShadowTickOnce(): Promise<void> {
	try {
		await db.$transaction(async () => {
			const lockResult = await db.$query<{ acquired: boolean }>`
				SELECT pg_try_advisory_xact_lock(${SHADOW_TICK_LOCK_KEY}::bigint) AS acquired
			`;
			if (!lockResult.rows[0]?.acquired) return;
			await runShadowTick();
		});
	} catch (error) {
		logger.error({ err: error }, "yantra shadow tick failed");
	}
}

export function startYantraShadowTickCron(): void {
	if (!env.YANTRA_GH_TOKEN) {
		logger.info("YANTRA_GH_TOKEN unset; yantra shadow tick disabled");
		return;
	}
	scheduledTask = cron.schedule("*/10 * * * *", () => {
		void yantraShadowTickOnce();
	});
	logger.info("yantra shadow tick scheduled (every 10 min)");
}

export function stopYantraShadowTickCron(): void {
	scheduledTask?.stop();
	scheduledTask = null;
}

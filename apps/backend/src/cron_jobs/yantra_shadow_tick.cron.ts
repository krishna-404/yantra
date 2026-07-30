import { db } from "@backend/db/db";
import { runShadowTick } from "@backend/modules/yantra/services/shadow_tick.yantra.service";
import { logger } from "@backend/utils/logger.utils";
import cron, { type ScheduledTask } from "node-cron";

// Distinct from reconcile (…002) so the advisory locks never collide.
const SHADOW_TICK_LOCK_KEY = 823_401_101_003n;

let scheduledTask: ScheduledTask | null = null;

/**
 * H4 shadow / live tick: every 2 minutes the app decides (shadow) or acts
 * (live) on each enabled project. The advisory lock makes it multi-replica
 * safe AND self-throttling — if a tick outruns the previous one (a live turn
 * or grade scan still finishing), the lock isn't acquired and this run
 * no-ops, so a fast cadence never stacks work. Credentials are project-scoped
 * (D23): reads enabled yantra_projects rows, quietly no-ops when there are
 * none. (Was 10 min to mirror the VPS systemd timer; tightened once the app
 * became the sole driver, so it picks up and chains work far faster.)
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
	scheduledTask = cron.schedule("*/2 * * * *", () => {
		void yantraShadowTickOnce();
	});
	logger.info("yantra shadow tick scheduled (every 2 min)");
}

export function stopYantraShadowTickCron(): void {
	scheduledTask?.stop();
	scheduledTask = null;
}

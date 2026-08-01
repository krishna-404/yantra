import { db } from "@backend/db/db";
import {
	advanceSchedule,
	runRoutine,
} from "@backend/modules/yantra/services/routines_runner.yantra.service";
import { logger } from "@backend/utils/logger.utils";
import cron, { type ScheduledTask } from "node-cron";

// Distinct advisory-lock key from tick (…003), prune (…004) and dream (…005).
const ROUTINES_LOCK_KEY = 823_401_101_006n;

let scheduledTask: ScheduledTask | null = null;

/**
 * The Routines scheduler (#18) — the self-sufficiency milestone.
 *
 * Every five minutes: find enabled routines whose stored `nextRunAt` has
 * passed, run them, and advance their schedule. Because "when do I run next"
 * lives in the DB rather than in a process timer, a deploy or restart can't
 * lose a schedule, and a second replica can't double-fire one — the advisory
 * lock serialises the sweep.
 *
 * A routine that has never run (`nextRunAt IS NULL`) fires on the next sweep,
 * so creating one in the UI takes effect within minutes instead of waiting for
 * its first cron boundary.
 */
export async function yantraRoutinesOnce(): Promise<void> {
	try {
		await db.$transaction(async () => {
			const lockResult = await db.$query<{ acquired: boolean }>`
				SELECT pg_try_advisory_xact_lock(${ROUTINES_LOCK_KEY}::bigint) AS acquired
			`;
			if (!lockResult.rows[0]?.acquired) return;

			const now = new Date();
			const due = await db.yantraRoutines
				.where({ enabled: true })
				.where((q) =>
					q.where({ nextRunAt: null }).orWhere({ nextRunAt: { lte: now } }),
				)
				.order({ nextRunAt: "ASC" })
				.limit(20)
				.select(
					"id",
					"projectId",
					"name",
					"cron",
					"action",
					"prompt",
					"targetReady",
				);

			if (due.length === 0) return;

			for (const routine of due) {
				let outcome = "error";
				try {
					outcome = await runRoutine(routine);
				} catch (err) {
					logger.error({ err, routine: routine.id }, "routine run failed");
				}
				// Always advance, even on failure — otherwise a permanently broken
				// routine would be retried every sweep forever.
				await advanceSchedule(routine).catch((err) =>
					logger.error(
						{ err, routine: routine.id },
						"routine reschedule failed",
					),
				);
				logger.info(
					{ routine: routine.id, name: routine.name, outcome },
					"yantra routine fired",
				);
			}
		});
	} catch (error) {
		logger.error({ err: error }, "yantra routines cron failed");
	}
}

export function startYantraRoutinesCron(): void {
	// Every 5 minutes: fine-grained enough that a routine fires close to its
	// scheduled minute, cheap enough that an idle sweep is one indexed query.
	scheduledTask = cron.schedule("*/5 * * * *", () => {
		void yantraRoutinesOnce();
	});
	logger.info("yantra routines cron scheduled (every 5 min)");
}

export function stopYantraRoutinesCron(): void {
	if (scheduledTask) {
		scheduledTask.stop();
		scheduledTask = null;
	}
}

import { db } from "@backend/db/db";
import { yantraRoutineRunTaskDef } from "@backend/events/events.schema";
import { tbus } from "@backend/events/tbus";
import { logger } from "@backend/utils/logger.utils";
import cron, { type ScheduledTask } from "node-cron";

// Distinct advisory-lock key from tick (…003), prune (…004) and dream (…005).
const ROUTINES_LOCK_KEY = 823_401_101_006n;

let scheduledTask: ScheduledTask | null = null;

/**
 * The Routines scheduler (#18) — the self-sufficiency milestone.
 *
 * Every five minutes: find enabled routines whose stored `nextRunAt` has
 * passed, queue one task each, and advance their schedule. Because "when do I
 * run next" lives in the DB rather than in a process timer, a deploy or restart
 * can't lose a schedule, and a second replica can't double-fire one — the
 * advisory lock serialises the sweep.
 *
 * The sweep only DISPATCHES (#140). Grooming is slow and talks to two APIs, so
 * running it inline held this transaction — and its advisory lock — for as long
 * as the slowest provider took, and a failure left nothing behind but a log
 * line. As a pg-tbus task it gets an expiry, a singleton key, and a row in
 * pg_tbus_task_logs like every other background job.
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
				// Only what dispatch needs: the id to queue, the cron to advance the
				// schedule, the name for the log line. The task reloads the rest.
				.select("id", "name", "cron");

			if (due.length === 0) return;

			for (const routine of due) {
				try {
					await tbus.send(
						yantraRoutineRunTaskDef.from(
							{ routineId: routine.id },
							// One active run per routine: a slow groom must not stack
							// behind itself when the next boundary comes around.
							{ singletonKey: routine.id },
						),
					);
					logger.info(
						{ routine: routine.id, name: routine.name },
						"yantra routine queued",
					);
				} catch (err) {
					logger.error({ err, routine: routine.id }, "routine enqueue failed");
				}
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

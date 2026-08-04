import { db } from "@backend/db/db";
import { yantraRoutineRunTaskDef } from "@backend/events/events.schema";
import { tbus } from "@backend/events/tbus";
import { gh } from "@backend/modules/yantra/services/gh_client.yantra.service";
import { openSecret } from "@backend/modules/yantra/services/secret_box.yantra.service";
import {
	createReadySpec,
	groomIdea,
} from "@backend/modules/yantra/services/spec_intake.yantra.service";
import { nextRunAt } from "@backend/modules/yantra/state/cron_schedule.yantra";
import { logger } from "@backend/utils/logger.utils";

/**
 * The Routines engine (#18) — what makes a project self-feeding.
 *
 * Until now the factory could build anything you queued, but it went idle the
 * moment the queue emptied: someone had to keep filing specs. A Routine is a
 * stored schedule that tops the queue back up on its own, so a project keeps
 * shipping without a human (or an assistant) poking it.
 *
 * Deliberately DB-driven, not a process timer: `nextRunAt` lives on the row, so
 * a restart, a deploy or a second replica can't lose or double-run a schedule —
 * the same fragility that let the v0 shell loop rot unnoticed for weeks.
 *
 * `groom_backlog` is the one action for now: count what's queued, and if the
 * project is below `targetReady`, groom fresh specs up to that number. The bar
 * is deliberately low-risk — routines only ever CREATE spec:ready issues; the
 * advise gate, rails and grade still decide what actually merges.
 */

/** How far ahead to schedule when the cron matches nothing inside a year. */
const FALLBACK_DELAY_MS = 24 * 60 * 60 * 1000;

export interface RoutineRow {
	id: string;
	teamId: string | null;
	projectId: string;
	name: string;
	cron: string | null;
	action: string;
	prompt: string;
	targetReady: number;
}

/** How many `spec:ready` issues the project currently has waiting. */
const readyCount = async (repo: string, token: string): Promise<number> => {
	const rows = await gh<{ pull_request?: unknown }[]>(
		`/repos/${repo}/issues?labels=spec:ready&state=open&per_page=100`,
		token,
	);
	return rows.filter((i) => !i.pull_request).length;
};

/**
 * Executes one routine. Returns a short outcome string for telemetry/logs.
 * Never throws — a broken routine must not stop the others or wedge the cron.
 */
export const runRoutine = async (routine: RoutineRow): Promise<string> => {
	const project = await db.yantraProjects
		.findByOptional({ id: routine.projectId })
		.select("repo", "baseBranch", "ghTokenCiphertext", "enabled", "mode");
	if (!project || !project.enabled) return "project_disabled";

	const ghToken = openSecret(project.ghTokenCiphertext);

	if (routine.action !== "groom_backlog" && routine.action !== "file_specs") {
		logger.warn(
			{ routine: routine.id, action: routine.action },
			"routine skipped: unknown action",
		);
		return `unknown_action:${routine.action}`;
	}

	const queued = await readyCount(project.repo, ghToken);
	const gap = Math.max(0, routine.targetReady - queued);
	if (gap === 0) return `already_topped_up:${queued}`;

	// Cap per pass so a misconfigured targetReady can't flood the backlog in one
	// go; the next tick tops up the rest.
	const toFile = Math.min(gap, 3);
	const theme =
		routine.prompt.trim() ||
		"the next most valuable improvement to this codebase";

	let filed = 0;
	for (let i = 0; i < toFile; i++) {
		try {
			const draft = await groomIdea(
				`Propose ONE concrete, self-contained improvement for this project. Focus: ${theme}. ` +
					"It must be small enough to ship as a single PR, and must not duplicate work already queued.",
				// The routine's own team, so grooming bills the same free-lane key
				// the rest of that team's runs use (#138).
				routine.teamId,
				// …and the project's repo, so the spec names real paths instead of
				// being parked by advise for naming none (#145).
				{ repo: project.repo, branch: project.baseBranch, ghToken },
			);
			await createReadySpec({
				repo: project.repo,
				ghToken,
				title: draft.title,
				body: `${draft.body}\n\n---\n🤖 Filed automatically by routine "${routine.name}".`,
				tier: draft.tier as "T0" | "T1" | "T2" | "T3",
			});
			filed++;
		} catch (err) {
			logger.error(
				{ err, routine: routine.id },
				"routine: failed to file a spec (continuing)",
			);
		}
	}
	return `filed:${filed}`;
};

/**
 * Only self-enqueue runs due inside this window. Beyond it the five-minute
 * sweep picks the routine up instead — a monthly schedule should not sit in the
 * task queue as a row for a month waiting to be noticed.
 */
const SELF_ENQUEUE_HORIZON_MS = 60 * 60 * 1000;

/**
 * How early a firing may still count as "due". A self-enqueued task lands at
 * its scheduled second, so without a little slack clock jitter could make it
 * arrive a hair early, fail the due check, and silently skip the run.
 */
const DUE_SLACK_MS = 30 * 1000;

/**
 * Moves the schedule forward and returns the new `nextRunAt`.
 *
 * Called by the RUN, before the work starts — not by the sweep. That ordering
 * is what makes a duplicate dispatch harmless: whoever gets there first moves
 * the clock, and the loser sees a schedule already in the future and stops.
 * It also means a failure inside the run still leaves the clock advanced, so a
 * permanently-broken routine retries at its next boundary rather than every
 * tick.
 */
export const advanceSchedule = async (routine: {
	id: string;
	cron: string | null;
}): Promise<number> => {
	const now = new Date();
	let next: Date | null = null;
	if (routine.cron) {
		try {
			next = nextRunAt(routine.cron, now);
		} catch (err) {
			logger.warn(
				{ err, routine: routine.id, cron: routine.cron },
				"routine: invalid cron — falling back to a daily retry",
			);
		}
	}
	const at = (next ?? new Date(now.getTime() + FALLBACK_DELAY_MS)).getTime();
	await db.yantraRoutines.findBy({ id: routine.id }).update({ nextRunAt: at });
	return at;
};

/**
 * Queue the next firing to land on its scheduled minute rather than whenever
 * the sweep next happens to look. Without this a "daily at 03:00" routine fires
 * somewhere in 03:00–03:05, which is fine for a backlog top-up and wrong for
 * anything a person is watching the clock for.
 *
 * Best-effort by design: the sweep remains the safety net, so a failed enqueue
 * costs punctuality, never the run.
 */
export const scheduleNextRun = async (
	routineId: string,
	at: number,
): Promise<boolean> => {
	const delayMs = at - Date.now();
	if (delayMs > SELF_ENQUEUE_HORIZON_MS) return false;

	try {
		await tbus.send(
			yantraRoutineRunTaskDef.from(
				{ routineId },
				{
					// Ceil, never floor: landing a second early would fail the due
					// check and skip the cycle entirely.
					startAfterSeconds: Math.max(0, Math.ceil(delayMs / 1000)),
					singletonKey: routineId,
				},
			),
		);
		return true;
	} catch (err) {
		logger.warn(
			{ err, routine: routineId },
			"routine: self-enqueue failed — the sweep will pick it up",
		);
		return false;
	}
};

/**
 * The task-side entry point (#140): claim the slot by advancing the schedule,
 * queue the next firing, then do the work.
 *
 * Advancing first is the idempotence guard. The sweep and a self-enqueued task
 * can both target the same firing; whichever runs first moves `nextRunAt` into
 * the future, and the other sees it and returns `not_due` without grooming
 * anything. That holds regardless of how the queue's singleton semantics treat
 * a delayed task, which is the point — correctness shouldn't rest on it.
 *
 * `lastRunAt` is stamped after the work, not at dispatch, so it means "last
 * executed": a backed-up queue must never let the UI claim a run that hasn't
 * happened.
 */
export const runRoutineById = async (routineId: string): Promise<string> => {
	const routine = await db.yantraRoutines
		.where({ id: routineId })
		.select(
			"id",
			"teamId",
			"projectId",
			"name",
			"cron",
			"action",
			"prompt",
			"targetReady",
			"enabled",
			"nextRunAt",
		)
		.takeOptional();
	if (!routine) return "routine_deleted";
	// Disabled between dispatch and execution — honour the newer intent.
	if (!routine.enabled) return "routine_disabled";

	if (
		routine.nextRunAt !== null &&
		routine.nextRunAt > Date.now() + DUE_SLACK_MS
	) {
		return "not_due";
	}

	const at = await advanceSchedule(routine);
	await scheduleNextRun(routine.id, at);

	try {
		return await runRoutine(routine);
	} finally {
		await db.yantraRoutines
			.findBy({ id: routineId })
			.update({ lastRunAt: Date.now() })
			.catch((err) =>
				logger.error(
					{ err, routine: routineId },
					"routine: lastRunAt stamp failed",
				),
			);
	}
};

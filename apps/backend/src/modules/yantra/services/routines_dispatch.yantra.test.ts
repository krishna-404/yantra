import { db } from "@backend/db/db";
import {
	advanceSchedule,
	runRoutineById,
} from "@backend/modules/yantra/services/routines_runner.yantra.service";
import { defaultContext } from "@backend/test/setup";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The sweep dispatches and the task executes (#140), and the RUN owns the
 * clock: it advances `nextRunAt` before doing any work, which is what makes a
 * duplicate dispatch harmless, and stamps `lastRunAt` only after the work.
 *
 * Getting this wrong either double-grooms a routine (sweep and self-enqueue
 * both firing) or reports runs that never happened, so both halves are pinned
 * here — including the not-due guard that the whole scheme rests on.
 */

const REPO = "test-owner/test-repo-routines-dispatch";

const seed = async (
	overrides: { enabled?: boolean; cron?: string | null } = {},
) => {
	const teamId = defaultContext?.user.activeTeamAppId;
	if (!teamId)
		throw new Error("test setup: no active team on the default user");
	const project = await db.yantraProjects
		.create({
			teamId,
			repo: REPO,
			baseBranch: "staging",
			ghTokenCiphertext: "not-a-real-ciphertext",
			ghTokenHint: "0000",
			// Disabled: runRoutine short-circuits before touching GitHub, which is
			// what lets these assertions stay about scheduling rather than network.
			enabled: false,
		})
		.select("id");

	return db.yantraRoutines
		.create({
			teamId,
			projectId: project.id,
			name: "nightly top-up",
			cron: overrides.cron === undefined ? "0 3 * * *" : overrides.cron,
			action: "groom_backlog",
			prompt: "",
			targetReady: 3,
			enabled: overrides.enabled ?? true,
			nextRunAt: null,
		})
		.select("id");
};

afterEach(async () => {
	const projects = await db.yantraProjects.where({ repo: REPO }).select("id");
	await db.yantraRoutines
		.where({ projectId: { in: projects.map((p) => p.id) } })
		.delete();
	await db.yantraProjects.where({ repo: REPO }).delete();
});

describe("advanceSchedule", () => {
	it("moves nextRunAt forward without claiming the routine ran", async () => {
		const routine = await seed();

		const at = await advanceSchedule({ id: routine.id, cron: "0 3 * * *" });

		const row = await db.yantraRoutines.findBy({ id: routine.id });
		expect(row.nextRunAt).toBe(at);
		expect(row.nextRunAt).toBeGreaterThan(Date.now());
		// Advancing is a claim on the slot, not a record of work done.
		expect(row.lastRunAt).toBeNull();
	});

	it("takes a routine out of the due set so the next sweep skips it", async () => {
		const routine = await seed();

		await advanceSchedule({ id: routine.id, cron: "0 3 * * *" });

		const due = await db.yantraRoutines
			.where({ enabled: true })
			.where((q) =>
				q
					.where({ nextRunAt: null })
					.orWhere({ nextRunAt: { lte: new Date() } }),
			);
		expect(due.map((r) => r.id)).not.toContain(routine.id);
	});

	it("falls back to a daily retry when the cron is unparseable", async () => {
		const routine = await seed({ cron: "not a cron" });

		await advanceSchedule({ id: routine.id, cron: "not a cron" });

		const row = await db.yantraRoutines.findBy({ id: routine.id });
		// Roughly a day out — a broken expression must not mean "due forever".
		const hoursOut = ((row.nextRunAt ?? 0) - Date.now()) / 3_600_000;
		expect(hoursOut).toBeGreaterThan(23);
		expect(hoursOut).toBeLessThan(25);
	});
});

describe("runRoutineById", () => {
	it("stamps lastRunAt and advances the clock when it executes", async () => {
		const routine = await seed();

		const outcome = await runRoutineById(routine.id);

		expect(outcome).toBe("project_disabled");
		const row = await db.yantraRoutines.findBy({ id: routine.id });
		expect(row.lastRunAt).not.toBeNull();
		// The run owns the schedule now — it claimed its slot on the way in.
		expect(row.nextRunAt).toBeGreaterThan(Date.now());
	});

	it("skips a duplicate dispatch whose slot was already claimed", async () => {
		const routine = await seed();

		// First firing advances the clock past now…
		expect(await runRoutineById(routine.id)).toBe("project_disabled");
		const afterFirst = await db.yantraRoutines.findBy({ id: routine.id });

		// …so a second task for the same firing — sweep racing a self-enqueue,
		// or a redelivery — must do nothing rather than groom twice.
		expect(await runRoutineById(routine.id)).toBe("not_due");
		const afterSecond = await db.yantraRoutines.findBy({ id: routine.id });
		expect(afterSecond.nextRunAt).toBe(afterFirst.nextRunAt);
		expect(afterSecond.lastRunAt).toBe(afterFirst.lastRunAt);
	});

	it("treats a never-run routine (nextRunAt null) as due", async () => {
		const routine = await seed();
		const before = await db.yantraRoutines.findBy({ id: routine.id });
		expect(before.nextRunAt).toBeNull();

		// Creating a routine shouldn't mean waiting for its first cron boundary.
		expect(await runRoutineById(routine.id)).toBe("project_disabled");
	});

	it("honours a routine disabled between dispatch and execution", async () => {
		const routine = await seed();
		await db.yantraRoutines.findBy({ id: routine.id }).update({
			enabled: false,
		});

		expect(await runRoutineById(routine.id)).toBe("routine_disabled");
	});

	it("survives a routine deleted between dispatch and execution", async () => {
		const routine = await seed();
		await db.yantraRoutines.findBy({ id: routine.id }).delete();

		// A queued task for a deleted routine is normal, not an error worth
		// failing the task over.
		expect(await runRoutineById(routine.id)).toBe("routine_deleted");
	});
});

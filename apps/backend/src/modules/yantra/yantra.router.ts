import { db } from "@backend/db/db";
import {
	addProject,
	listProjects,
	rotateProjectToken,
	setProjectEnabled,
} from "@backend/modules/yantra/services/projects.yantra.service";
import {
	importTelemetryRows,
	parseTelemetryJsonl,
} from "@backend/modules/yantra/services/telemetry_import.yantra.service";
import { rpcSuperAdminProcedure } from "@backend/procedures/super_admin.procedure";
import { z } from "zod";

/**
 * H10 (first slice) — the factory's own state, served by the app it builds
 * (tenant-zero, docs/yantra/03-phase-2-harness.md §0). Super-admin-gated.
 * Read model today = yantra_telemetry (imported from v0 via H3); turns/runs/
 * verdicts start flowing when the H4/H5 workers land.
 */

const telemetryRowZod = z.object({
	run: z.string(),
	turn: z.string(),
	issue: z.number(),
	role: z.string(),
	model: z.string(),
	tier: z.string(),
	taskType: z.string(),
	startedAt: z.number(),
	endedAt: z.number(),
	wallS: z.number(),
	outcome: z.string(),
	pr: z.number(),
	merged: z.boolean(),
	autoMerged: z.boolean(),
});

const summary = rpcSuperAdminProcedure
	.route({ method: "GET", path: "/yantra/summary", tags: ["Yantra"] })
	.output(
		z.object({
			totalRuns: z.number(),
			merges: z.number(),
			autoMerges: z.number(),
			byOutcome: z.array(z.object({ outcome: z.string(), count: z.number() })),
			byRole: z.array(z.object({ role: z.string(), count: z.number() })),
			lastRunAt: z.number().nullable(),
		}),
	)
	.handler(async () => {
		// The harness history is small (hundreds of rows); aggregate in JS off
		// one bounded query rather than hand-rolling grouped SQL for each tile.
		const rows = await db.yantraTelemetry
			.select("outcome", "role", "merged", "autoMerged", "startedAt")
			.order({ startedAt: "DESC" })
			.limit(2000);
		const byOutcome = new Map<string, number>();
		const byRole = new Map<string, number>();
		let merges = 0;
		let autoMerges = 0;
		for (const r of rows) {
			byOutcome.set(r.outcome, (byOutcome.get(r.outcome) ?? 0) + 1);
			byRole.set(r.role, (byRole.get(r.role) ?? 0) + 1);
			if (r.merged) merges++;
			if (r.autoMerged) autoMerges++;
		}
		return {
			totalRuns: rows.length,
			merges,
			autoMerges,
			byOutcome: [...byOutcome.entries()]
				.map(([outcome, count]) => ({ outcome, count }))
				.sort((a, b) => b.count - a.count),
			byRole: [...byRole.entries()]
				.map(([role, count]) => ({ role, count }))
				.sort((a, b) => b.count - a.count),
			lastRunAt: rows[0]?.startedAt ?? null,
		};
	});

const listRuns = rpcSuperAdminProcedure
	.route({ method: "GET", path: "/yantra/runs", tags: ["Yantra"] })
	.input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
	.output(z.object({ rows: z.array(telemetryRowZod) }))
	.handler(async ({ input }) => {
		const rows = await db.yantraTelemetry
			.select(
				"run",
				"turn",
				"issue",
				"role",
				"model",
				"tier",
				"taskType",
				"startedAt",
				"endedAt",
				"wallS",
				"outcome",
				"pr",
				"merged",
				"autoMerged",
			)
			.order({ startedAt: "DESC" })
			.limit(input.limit);
		return { rows };
	});

const importTelemetry = rpcSuperAdminProcedure
	.route({ method: "POST", path: "/yantra/import-telemetry", tags: ["Yantra"] })
	.input(z.object({ jsonl: z.string().min(1).max(5_000_000) }))
	.output(
		z.object({
			inserted: z.number(),
			skippedDuplicates: z.number(),
			parseErrors: z.array(z.object({ line: z.number(), message: z.string() })),
		}),
	)
	.handler(async ({ input }) => {
		const { rows, errors } = parseTelemetryJsonl(input.jsonl);
		const result = await importTelemetryRows(rows);
		return { ...result, parseErrors: errors.slice(0, 20) };
	});

// ── projects (D23) — repo + branch + encrypted PAT, managed from the cockpit ─

const projectViewZod = z.object({
	id: z.string(),
	repo: z.string(),
	baseBranch: z.string(),
	enabled: z.boolean(),
	// Last 4 chars of the PAT only — plaintext never crosses the API.
	ghTokenHint: z.string(),
	createdAt: z.number(),
});

const listProjectsRoute = rpcSuperAdminProcedure
	.route({ method: "GET", path: "/yantra/projects", tags: ["Yantra"] })
	.output(z.object({ projects: z.array(projectViewZod) }))
	.handler(async () => ({ projects: await listProjects() }));

const addProjectRoute = rpcSuperAdminProcedure
	.route({ method: "POST", path: "/yantra/projects", tags: ["Yantra"] })
	.input(
		z.object({
			repo: z
				.string()
				.min(3)
				.max(255)
				.regex(/^[\w.-]+\/[\w.-]+$/, "must look like owner/name"),
			baseBranch: z.string().min(1).max(255),
			ghToken: z.string().min(20).max(500),
		}),
	)
	.output(projectViewZod)
	.handler(async ({ input }) => addProject(input));

const setProjectEnabledRoute = rpcSuperAdminProcedure
	.route({
		method: "POST",
		path: "/yantra/projects/set-enabled",
		tags: ["Yantra"],
	})
	.input(z.object({ id: z.string().min(1), enabled: z.boolean() }))
	.output(z.object({ ok: z.boolean() }))
	.handler(async ({ input }) => {
		await setProjectEnabled(input.id, input.enabled);
		return { ok: true };
	});

const rotateProjectTokenRoute = rpcSuperAdminProcedure
	.route({
		method: "POST",
		path: "/yantra/projects/rotate-token",
		tags: ["Yantra"],
	})
	.input(
		z.object({ id: z.string().min(1), ghToken: z.string().min(20).max(500) }),
	)
	.output(z.object({ ok: z.boolean() }))
	.handler(async ({ input }) => {
		await rotateProjectToken(input.id, input.ghToken);
		return { ok: true };
	});

export const yantraRouter = {
	summary,
	runs: listRuns,
	importTelemetry,
	listProjects: listProjectsRoute,
	addProject: addProjectRoute,
	setProjectEnabled: setProjectEnabledRoute,
	rotateProjectToken: rotateProjectTokenRoute,
};

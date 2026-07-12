import { db } from "@backend/db/db";
import {
	APP_SECRET_KEYS,
	getAppSecretValue,
	listAppSecrets,
	setAppSecret,
} from "@backend/modules/yantra/services/app_secrets.yantra.service";
import { getDockerStatus } from "@backend/modules/yantra/services/docker_status.yantra.service";
import { runEnsembleExecute } from "@backend/modules/yantra/services/ensemble_runner.yantra.service";
import { runFreeLaneExecute } from "@backend/modules/yantra/services/free_lane_runner.yantra.service";
import {
	getKillSwitch,
	setKillSwitch,
} from "@backend/modules/yantra/services/kill_switch.yantra.service";
import {
	candidateModels,
	listLanes,
	runLaneSmoke,
} from "@backend/modules/yantra/services/lanes.yantra.service";
import {
	addProject,
	listProjects,
	rotateProjectToken,
	setProjectEnabled,
	setProjectMode,
} from "@backend/modules/yantra/services/projects.yantra.service";
import { openSecret } from "@backend/modules/yantra/services/secret_box.yantra.service";
import {
	createReadySpec,
	groomIdea,
} from "@backend/modules/yantra/services/spec_intake.yantra.service";
import {
	importTelemetryRows,
	parseTelemetryJsonl,
} from "@backend/modules/yantra/services/telemetry_import.yantra.service";
import {
	addIssueLabels,
	commentOnIssue,
	removeIssueLabel,
} from "@backend/modules/yantra/services/turn_shared.yantra.service";
import { rpcSuperAdminProcedure } from "@backend/procedures/super_admin.procedure";
import { logger } from "@backend/utils/logger.utils";
import { ulid } from "ulid";
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
	// GET query params arrive as strings through the OpenAPI handler — coerce.
	.input(
		z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
	)
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
	mode: z.string(),
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

// The H9 cutover lever: live = the app claims issues and opens PRs itself.
const setProjectModeRoute = rpcSuperAdminProcedure
	.route({
		method: "POST",
		path: "/yantra/projects/set-mode",
		tags: ["Yantra"],
	})
	.input(z.object({ id: z.string().min(1), mode: z.enum(["shadow", "live"]) }))
	.output(z.object({ ok: z.boolean() }))
	.handler(async ({ input }) => {
		await setProjectMode(input.id, input.mode);
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

// ── kill switch (H10) — the cockpit red button, per project ─────────────────

const killSwitchStateZod = z.object({
	projectId: z.string(),
	repo: z.string(),
	// null = variable unreadable; the harness fails closed and treats it as ON.
	kill: z.boolean().nullable(),
});

const getKillSwitchRoute = rpcSuperAdminProcedure
	.route({ method: "GET", path: "/yantra/kill-switch", tags: ["Yantra"] })
	.input(z.object({ projectId: z.string().min(1) }))
	.output(killSwitchStateZod)
	.handler(async ({ input }) => getKillSwitch(input.projectId));

const setKillSwitchRoute = rpcSuperAdminProcedure
	.route({ method: "POST", path: "/yantra/kill-switch", tags: ["Yantra"] })
	.input(z.object({ projectId: z.string().min(1), kill: z.boolean() }))
	.output(killSwitchStateZod)
	.handler(async ({ input }) => setKillSwitch(input.projectId, input.kill));

// ── runner infrastructure (H5 pre-flight): app secrets + docker socket ──────

const listAppSecretsRoute = rpcSuperAdminProcedure
	.route({ method: "GET", path: "/yantra/app-secrets", tags: ["Yantra"] })
	.output(
		z.object({
			secrets: z.array(
				z.object({
					key: z.string(),
					valueHint: z.string(),
					updatedAt: z.number(),
				}),
			),
			knownKeys: z.array(z.string()),
		}),
	)
	.handler(async () => ({
		secrets: await listAppSecrets(),
		knownKeys: [...APP_SECRET_KEYS],
	}));

const setAppSecretRoute = rpcSuperAdminProcedure
	.route({ method: "POST", path: "/yantra/app-secrets", tags: ["Yantra"] })
	.input(
		z.object({
			key: z.enum(APP_SECRET_KEYS),
			value: z.string().min(8).max(2000),
		}),
	)
	.output(z.object({ ok: z.boolean() }))
	.handler(async ({ input }) => {
		await setAppSecret(input.key, input.value);
		return { ok: true };
	});

const dockerStatusRoute = rpcSuperAdminProcedure
	.route({ method: "GET", path: "/yantra/docker-status", tags: ["Yantra"] })
	.output(
		z.object({
			reachable: z.boolean(),
			version: z.string().nullable(),
			execImagePresent: z.boolean(),
			error: z.string().nullable(),
		}),
	)
	.handler(async () => getDockerStatus());

// ── free-AI lanes (Phase 3): registry + key smoke-test ──────────────────────

const listLanesRoute = rpcSuperAdminProcedure
	.route({ method: "GET", path: "/yantra/lanes", tags: ["Yantra"] })
	.output(
		z.object({
			lanes: z.array(
				z.object({
					id: z.string(),
					label: z.string(),
					keyPresent: z.boolean(),
				}),
			),
		}),
	)
	.handler(async () => ({ lanes: await listLanes() }));

const laneSmokeRoute = rpcSuperAdminProcedure
	.route({ method: "POST", path: "/yantra/lanes/smoke", tags: ["Yantra"] })
	.input(z.object({ lane: z.string().min(1) }))
	.output(
		z.object({
			lane: z.string(),
			keyPresent: z.boolean(),
			ok: z.boolean(),
			modelCount: z.number(),
			sampleModel: z.string().nullable(),
			latencyMs: z.number(),
			error: z.string().nullable(),
		}),
	)
	.handler(async ({ input }) => runLaneSmoke(input.lane));

// Manual "try the free lane on this issue" trigger — the on-demand path to
// NVIDIA's first real task, before auto-routing exists. Claims the issue, then
// fires the free-lane container detached (the run takes minutes). Auto-routing
// by scorecard (D26) comes after this proves out.
const tryFreeLaneRoute = rpcSuperAdminProcedure
	.route({ method: "POST", path: "/yantra/lanes/try", tags: ["Yantra"] })
	.input(
		z.object({
			projectId: z.string().min(1),
			issue: z.number().int().positive(),
			model: z.string().min(1).optional(),
			tier: z.string().default("T0"),
		}),
	)
	.output(
		z.object({
			started: z.boolean(),
			model: z.string(),
			error: z.string().nullable(),
		}),
	)
	.handler(async ({ input }) => {
		const project = await db.yantraProjects
			.findBy({ id: input.projectId })
			.select("id", "repo", "baseBranch", "ghTokenCiphertext");
		const ghToken = openSecret(project.ghTokenCiphertext);

		const nvidiaKey = await getAppSecretValue("NVIDIA_API_KEY");
		if (!nvidiaKey) {
			return { started: false, model: "", error: "NVIDIA_API_KEY not set" };
		}
		// Default to the first NVIDIA executor in the catalog; validate any override.
		const candidates = candidateModels("execute", ["nvidia"]);
		const modelRef = input.model ?? candidates[0]?.ref;
		if (!modelRef || !candidates.some((c) => c.ref === modelRef)) {
			return {
				started: false,
				model: modelRef ?? "",
				error: "model is not a known NVIDIA executor",
			};
		}

		const turn = ulid();
		await addIssueLabels(project.repo, input.issue, ["agent:working"], ghToken);
		await removeIssueLabel(project.repo, input.issue, "spec:ready", ghToken);
		await commentOnIssue(
			project.repo,
			input.issue,
			`🤖 yantra claim run=${turn} role=execute lane=free model=${modelRef}`,
			ghToken,
		);

		// Detached — the container run is long; don't block the HTTP response.
		void runFreeLaneExecute({
			repo: project.repo,
			baseBranch: project.baseBranch,
			ghToken,
			nvidiaKey,
			modelRef,
			issue: input.issue,
			turn,
			tier: input.tier,
			adviseJson: {},
		}).catch((err) =>
			logger.error({ err, issue: input.issue }, "free-lane try failed"),
		);

		return { started: true, model: modelRef, error: null };
	});

// Manual "run the 3-model ensemble on this issue" trigger (operator directive
// 2026-07-12). Picks N execute models + 1 judge from the catalog (validating
// overrides), claims the issue, fires the ensemble container detached. Every
// task should eventually route here automatically; this proves it first.
const tryEnsembleRoute = rpcSuperAdminProcedure
	.route({ method: "POST", path: "/yantra/lanes/ensemble", tags: ["Yantra"] })
	.input(
		z.object({
			projectId: z.string().min(1),
			issue: z.number().int().positive(),
			/** Override the execute models (≥2). Defaults to the top NVIDIA executors. */
			models: z.array(z.string().min(1)).min(2).optional(),
			/** Override the synthesis judge. Defaults to the top NVIDIA grader. */
			judge: z.string().min(1).optional(),
			tier: z.string().default("T0"),
		}),
	)
	.output(
		z.object({
			started: z.boolean(),
			models: z.array(z.string()),
			judge: z.string(),
			error: z.string().nullable(),
		}),
	)
	.handler(async ({ input }) => {
		const project = await db.yantraProjects
			.findBy({ id: input.projectId })
			.select("id", "repo", "baseBranch", "ghTokenCiphertext");
		const ghToken = openSecret(project.ghTokenCiphertext);

		const nvidiaKey = await getAppSecretValue("NVIDIA_API_KEY");
		if (!nvidiaKey) {
			return {
				started: false,
				models: [],
				judge: "",
				error: "NVIDIA_API_KEY not set",
			};
		}

		const executors = candidateModels("execute", ["nvidia"]);
		const graders = candidateModels("grade", ["nvidia"]);
		// Default: up to 3 distinct executors; judge = top grader (never an executor,
		// so no self-grading — D26).
		const models = input.models ?? executors.slice(0, 3).map((m) => m.ref);
		const judge = input.judge ?? graders[0]?.ref;

		if (models.length < 2)
			return {
				started: false,
				models,
				judge: judge ?? "",
				error: "need at least 2 execute models",
			};
		const badModel = models.find((m) => !executors.some((e) => e.ref === m));
		if (badModel)
			return {
				started: false,
				models,
				judge: judge ?? "",
				error: `not a known NVIDIA executor: ${badModel}`,
			};
		if (!judge || !graders.some((g) => g.ref === judge))
			return {
				started: false,
				models,
				judge: judge ?? "",
				error: "judge is not a known NVIDIA grader",
			};
		if (models.includes(judge))
			return {
				started: false,
				models,
				judge,
				error: "judge must not also be an execute model (no self-grading)",
			};

		const turn = ulid();
		await addIssueLabels(project.repo, input.issue, ["agent:working"], ghToken);
		await removeIssueLabel(project.repo, input.issue, "spec:ready", ghToken);
		await commentOnIssue(
			project.repo,
			input.issue,
			`🤖 yantra claim run=${turn} role=execute lane=ensemble models=[${models.join(", ")}] judge=${judge}`,
			ghToken,
		);

		void runEnsembleExecute({
			repo: project.repo,
			baseBranch: project.baseBranch,
			ghToken,
			nvidiaKey,
			models,
			judge,
			issue: input.issue,
			turn,
			tier: input.tier,
			adviseJson: {},
		}).catch((err) =>
			logger.error({ err, issue: input.issue }, "ensemble try failed"),
		);

		return { started: true, models, judge, error: null };
	});

// ── spec intake (Phase 4, chat-first) ───────────────────────────────────────
// The supply side of the factory: an idea is groomed into a draft spec (no
// side effects), then a separate approve step files it as a spec:ready issue
// the tick claims. Two steps on purpose — the operator sees the draft before
// anything becomes real work.
const groomIdeaRoute = rpcSuperAdminProcedure
	.route({ method: "POST", path: "/yantra/intake/groom", tags: ["Yantra"] })
	.input(z.object({ idea: z.string().min(4).max(2000) }))
	.output(
		z.object({
			title: z.string(),
			tier: z.string(),
			body: z.string(),
			groomedBy: z.string(),
		}),
	)
	.handler(async ({ input }) => groomIdea(input.idea));

const approveSpecRoute = rpcSuperAdminProcedure
	.route({ method: "POST", path: "/yantra/intake/approve", tags: ["Yantra"] })
	.input(
		z.object({
			projectId: z.string().min(1),
			title: z.string().min(4).max(120),
			body: z.string().min(1),
			tier: z.enum(["T0", "T1", "T2", "T3"]),
		}),
	)
	.output(z.object({ issue: z.number(), url: z.string() }))
	.handler(async ({ input }) => {
		const project = await db.yantraProjects
			.findBy({ id: input.projectId })
			.select("repo", "ghTokenCiphertext");
		const ghToken = openSecret(project.ghTokenCiphertext);
		return createReadySpec({
			repo: project.repo,
			ghToken,
			title: input.title,
			body: input.body,
			tier: input.tier,
		});
	});

export const yantraRouter = {
	summary,
	groomIdea: groomIdeaRoute,
	approveSpec: approveSpecRoute,
	runs: listRuns,
	importTelemetry,
	listProjects: listProjectsRoute,
	addProject: addProjectRoute,
	setProjectEnabled: setProjectEnabledRoute,
	setProjectMode: setProjectModeRoute,
	rotateProjectToken: rotateProjectTokenRoute,
	getKillSwitch: getKillSwitchRoute,
	setKillSwitch: setKillSwitchRoute,
	listAppSecrets: listAppSecretsRoute,
	setAppSecret: setAppSecretRoute,
	dockerStatus: dockerStatusRoute,
	listLanes: listLanesRoute,
	laneSmoke: laneSmokeRoute,
	tryFreeLane: tryFreeLaneRoute,
	tryEnsemble: tryEnsembleRoute,
};

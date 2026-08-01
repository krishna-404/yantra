import { db } from "@backend/db/db";
import {
	gh,
	ghRequest,
} from "@backend/modules/yantra/services/gh_client.yantra.service";
import {
	openSecret,
	sealSecret,
} from "@backend/modules/yantra/services/secret_box.yantra.service";
import {
	createReadySpec,
	groomIdea,
} from "@backend/modules/yantra/services/spec_intake.yantra.service";
import {
	rpcProtectedActiveTeamProcedure,
	rpcProtectedProcedure,
} from "@backend/procedures/protected.procedure";
import { z } from "zod";

/**
 * User-app (team-accessible) yantra surface — the per-project chat + project
 * settings (P3). Normal authed oRPC procedures so any signed-in team member
 * reaches them through the typed client, unlike the super-admin cockpit routes.
 *
 * Tenancy: createProject stamps the caller's active team on the row. listing is
 * not yet team-filtered (P4) so existing teamId=null projects stay visible;
 * that filter flips on once legacy rows are backfilled.
 */

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

const projectZod = z.object({
	id: z.string(),
	repo: z.string(),
	// baseBranch === the staging branch (see the table docs).
	baseBranch: z.string(),
	productionBranch: z.string(),
	productionUrl: z.string(),
	stagingUrl: z.string(),
	mode: z.string(),
	enabled: z.boolean(),
	ghTokenHint: z.string(),
	autoMergeToMain: z.boolean(),
});

const PROJECT_COLUMNS = [
	"id",
	"repo",
	"baseBranch",
	"productionBranch",
	"productionUrl",
	"stagingUrl",
	"mode",
	"enabled",
	"ghTokenHint",
	"autoMergeToMain",
] as const;

const listProjects = rpcProtectedProcedure
	.route({ method: "GET", tags: ["Yantra"] })
	.output(z.array(projectZod))
	.handler(async () => {
		return db.yantraProjects
			.order({ createdAt: "ASC" })
			.select(...PROJECT_COLUMNS);
	});

const createProject = rpcProtectedActiveTeamProcedure
	.route({ method: "POST", tags: ["Yantra"] })
	.input(
		z.object({
			repo: z
				.string()
				.min(3)
				.max(255)
				.regex(REPO_RE, "must look like owner/name"),
			// The staging branch — where every feature branch is checked.
			baseBranch: z.string().min(1).max(255),
			productionBranch: z.string().min(1).max(255).default("main"),
			productionUrl: z.string().max(500).default(""),
			stagingUrl: z.string().max(500).default(""),
			ghToken: z.string().min(20).max(500),
		}),
	)
	.output(projectZod)
	.handler(async ({ input, context }) => {
		const token = input.ghToken.trim();
		return db.yantraProjects
			.create({
				teamId: context.user.activeTeamAppId,
				repo: input.repo.trim(),
				baseBranch: input.baseBranch.trim(),
				productionBranch: input.productionBranch.trim(),
				productionUrl: input.productionUrl.trim(),
				stagingUrl: input.stagingUrl.trim(),
				ghTokenCiphertext: sealSecret(token),
				ghTokenHint: token.slice(-4),
				enabled: true,
			})
			.select(...PROJECT_COLUMNS);
	});

const updateProject = rpcProtectedActiveTeamProcedure
	.route({ method: "POST", tags: ["Yantra"] })
	.input(
		z.object({
			id: z.string().min(1),
			baseBranch: z.string().min(1).max(255).optional(),
			productionBranch: z.string().min(1).max(255).optional(),
			productionUrl: z.string().max(500).optional(),
			stagingUrl: z.string().max(500).optional(),
			mode: z.enum(["shadow", "live"]).optional(),
			enabled: z.boolean().optional(),
			autoMergeToMain: z.boolean().optional(),
		}),
	)
	.output(z.object({ ok: z.boolean() }))
	.handler(async ({ input }) => {
		const { id, ...rest } = input;
		const patch = Object.fromEntries(
			Object.entries(rest).filter(([, v]) => v !== undefined),
		);
		if (Object.keys(patch).length > 0) {
			await db.yantraProjects.findBy({ id }).update(patch);
		}
		return { ok: true };
	});

const setProjectToken = rpcProtectedActiveTeamProcedure
	.route({ method: "POST", tags: ["Yantra"] })
	.input(
		z.object({ id: z.string().min(1), ghToken: z.string().min(20).max(500) }),
	)
	.output(z.object({ ok: z.boolean() }))
	.handler(async ({ input }) => {
		const token = input.ghToken.trim();
		await db.yantraProjects.findBy({ id: input.id }).update({
			ghTokenCiphertext: sealSecret(token),
			ghTokenHint: token.slice(-4),
		});
		return { ok: true };
	});

const draftZod = z.object({
	title: z.string(),
	tier: z.string(),
	body: z.string(),
	groomedBy: z.string(),
});

const messageZod = z.object({
	id: z.string(),
	role: z.string(),
	text: z.string(),
	payload: z.unknown().nullable(),
	createdAt: z.number(),
});

/** The persisted thread for a project, oldest first (#26). */
const listMessages = rpcProtectedActiveTeamProcedure
	.route({ method: "GET", tags: ["Yantra"] })
	.input(z.object({ projectId: z.string().min(1) }))
	.output(z.array(messageZod))
	.handler(async ({ input }) => {
		return db.yantraChatMessages
			.where({ projectId: input.projectId })
			.order({ createdAt: "ASC" })
			.limit(200)
			.select("id", "role", "text", "payload", "createdAt");
	});

/**
 * One chat turn: persist what the user said, groom it into a spec draft, and
 * persist that too. Both turns are stored so a refresh (or a teammate opening
 * the same project) sees the whole conversation.
 */
const sendMessage = rpcProtectedActiveTeamProcedure
	.route({ method: "POST", tags: ["Yantra"] })
	.input(
		z.object({
			projectId: z.string().min(1),
			idea: z.string().min(4).max(2000),
		}),
	)
	.output(z.object({ draft: draftZod, messages: z.array(messageZod) }))
	.handler(async ({ input, context }) => {
		const teamId = context.user.activeTeamAppId;
		const userMsg = await db.yantraChatMessages
			.create({
				teamId,
				projectId: input.projectId,
				role: "user",
				text: input.idea.trim(),
				authorUserId: context.user.id,
			})
			.select("id", "role", "text", "payload", "createdAt");

		const draft = await groomIdea(input.idea);

		const draftMsg = await db.yantraChatMessages
			.create({
				teamId,
				projectId: input.projectId,
				role: "draft",
				text: draft.title,
				payload: draft,
				authorUserId: context.user.id,
			})
			.select("id", "role", "text", "payload", "createdAt");

		return { draft, messages: [userMsg, draftMsg] };
	});

const queueSpec = rpcProtectedActiveTeamProcedure
	.route({ method: "POST", tags: ["Yantra"] })
	.input(
		z.object({
			projectId: z.string().min(1),
			title: z.string().min(4).max(120),
			body: z.string().min(1),
			tier: z.enum(["T0", "T1", "T2", "T3"]),
		}),
	)
	.output(z.object({ issue: z.number(), url: z.string() }))
	.handler(async ({ input, context }) => {
		const project = await db.yantraProjects
			.findBy({ id: input.projectId })
			.select("repo", "ghTokenCiphertext");
		const ghToken = openSecret(project.ghTokenCiphertext);
		const created = await createReadySpec({
			repo: project.repo,
			ghToken,
			title: input.title,
			body: input.body,
			tier: input.tier,
		});
		// Record the outcome in the thread so the conversation shows what shipped.
		await db.yantraChatMessages.create({
			teamId: context.user.activeTeamAppId,
			projectId: input.projectId,
			role: "queued",
			text: input.title,
			payload: { ...created, tier: input.tier },
			authorUserId: context.user.id,
		});
		return created;
	});

/**
 * Live monitor (#27) — what the factory is doing on this project, in-app, so
 * you never have to leave yantra to ask "what happened?".
 */
const statusZod = z.object({
	runs: z.array(
		z.object({
			run: z.string(),
			issue: z.number(),
			role: z.string(),
			tier: z.string(),
			outcome: z.string(),
			pr: z.number(),
			merged: z.boolean(),
			autoMerged: z.boolean(),
			wallS: z.number(),
			startedAt: z.number(),
		}),
	),
	openPrs: z.array(
		z.object({
			number: z.number(),
			title: z.string(),
			url: z.string(),
			tier: z.string(),
			draft: z.boolean(),
		}),
	),
	readyCount: z.number(),
	workingCount: z.number(),
});

const projectStatus = rpcProtectedActiveTeamProcedure
	.route({ method: "GET", tags: ["Yantra"] })
	.input(z.object({ projectId: z.string().min(1) }))
	.output(statusZod)
	.handler(async ({ input }) => {
		const project = await db.yantraProjects
			.findBy({ id: input.projectId })
			.select("repo", "ghTokenCiphertext");
		const ghToken = openSecret(project.ghTokenCiphertext);

		const runs = await db.yantraTelemetry
			.where({ repo: project.repo })
			.order({ startedAt: "DESC" })
			.limit(25)
			.select(
				"run",
				"issue",
				"role",
				"tier",
				"outcome",
				"pr",
				"merged",
				"autoMerged",
				"wallS",
				"startedAt",
			);

		// GitHub is the source of truth for what's in flight. A failure here
		// (revoked PAT, API down) degrades the pane rather than breaking it.
		const [prs, ready, working] = await Promise.all([
			gh<
				{
					number: number;
					title: string;
					html_url: string;
					draft: boolean;
					labels: { name: string }[];
				}[]
			>(`/repos/${project.repo}/pulls?state=open&per_page=20`, ghToken).catch(
				() => [],
			),
			gh<unknown[]>(
				`/repos/${project.repo}/issues?labels=spec:ready&state=open&per_page=50`,
				ghToken,
			).catch(() => []),
			gh<unknown[]>(
				`/repos/${project.repo}/issues?labels=agent:working&state=open&per_page=50`,
				ghToken,
			).catch(() => []),
		]);

		return {
			runs,
			openPrs: prs.map((p) => ({
				number: p.number,
				title: p.title,
				url: p.html_url,
				tier:
					(p.labels ?? []).find((l) => l.name.startsWith("tier:"))?.name ?? "",
				draft: Boolean(p.draft),
			})),
			readyCount: ready.length,
			workingCount: working.length,
		};
	});

/**
 * The human half of the promote model (#24): when a project has auto-promote
 * OFF, a passing PR waits for a person. This is that click — squash-merge into
 * the project's production branch, from inside yantra.
 */
const promotePr = rpcProtectedActiveTeamProcedure
	.route({ method: "POST", tags: ["Yantra"] })
	.input(
		z.object({ projectId: z.string().min(1), pr: z.number().int().positive() }),
	)
	.output(z.object({ merged: z.boolean(), message: z.string() }))
	.handler(async ({ input }) => {
		const project = await db.yantraProjects
			.findBy({ id: input.projectId })
			.select("repo", "ghTokenCiphertext");
		const ghToken = openSecret(project.ghTokenCiphertext);
		try {
			await ghRequest(
				"PUT",
				`/repos/${project.repo}/pulls/${input.pr}/merge`,
				ghToken,
				{ merge_method: "squash" },
			);
			return { merged: true, message: `Merged #${input.pr}.` };
		} catch (err) {
			return {
				merged: false,
				message: err instanceof Error ? err.message : "Merge failed",
			};
		}
	});

export const yantraUserAppRouter = {
	listProjects,
	projectStatus,
	promotePr,
	listMessages,
	sendMessage,
	createProject,
	updateProject,
	setProjectToken,
	queueSpec,
};

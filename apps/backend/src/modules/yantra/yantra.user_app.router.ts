import { db } from "@backend/db/db";
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
	baseBranch: z.string(),
	mode: z.string(),
	enabled: z.boolean(),
	ghTokenHint: z.string(),
	autoMergeToMain: z.boolean(),
});

const listProjects = rpcProtectedProcedure
	.route({ method: "GET", tags: ["Yantra"] })
	.output(z.array(projectZod))
	.handler(async () => {
		return db.yantraProjects
			.order({ createdAt: "ASC" })
			.select(
				"id",
				"repo",
				"baseBranch",
				"mode",
				"enabled",
				"ghTokenHint",
				"autoMergeToMain",
			);
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
			baseBranch: z.string().min(1).max(255),
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
				ghTokenCiphertext: sealSecret(token),
				ghTokenHint: token.slice(-4),
				enabled: true,
			})
			.select(
				"id",
				"repo",
				"baseBranch",
				"mode",
				"enabled",
				"ghTokenHint",
				"autoMergeToMain",
			);
	});

const updateProject = rpcProtectedActiveTeamProcedure
	.route({ method: "POST", tags: ["Yantra"] })
	.input(
		z.object({
			id: z.string().min(1),
			baseBranch: z.string().min(1).max(255).optional(),
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

const groom = rpcProtectedProcedure
	.route({ method: "POST", tags: ["Yantra"] })
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

const queueSpec = rpcProtectedProcedure
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

export const yantraUserAppRouter = {
	listProjects,
	createProject,
	updateProject,
	setProjectToken,
	groom,
	queueSpec,
};

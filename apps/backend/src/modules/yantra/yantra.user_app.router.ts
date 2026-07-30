import { db } from "@backend/db/db";
import { openSecret } from "@backend/modules/yantra/services/secret_box.yantra.service";
import {
	createReadySpec,
	groomIdea,
} from "@backend/modules/yantra/services/spec_intake.yantra.service";
import { rpcProtectedProcedure } from "@backend/procedures/protected.procedure";
import { z } from "zod";

/**
 * User-app (team-accessible) yantra surface — the per-project chat (P3).
 *
 * Unlike the super-admin cockpit routes (rpcSuperAdminProcedure over the
 * OpenAPI surface), these are normal authed oRPC procedures so any signed-in
 * team member reaches them through the typed user-app client. Slice-1 is the
 * conversational spec intake: describe → draft → queue as a spec:ready issue
 * the factory claims.
 *
 * Tenancy note: slice-1 lists all projects. Per-team filtering (once
 * yantra_projects.teamId from P1 is merged + backfilled) is a P4 refinement;
 * kept out here so the chat ships independently of the P1 migration.
 */

const projectZod = z.object({
	id: z.string(),
	repo: z.string(),
	baseBranch: z.string(),
	mode: z.string(),
});

const listProjects = rpcProtectedProcedure
	.route({ method: "GET", tags: ["Yantra"] })
	.output(z.array(projectZod))
	.handler(async () => {
		return db.yantraProjects
			.order({ createdAt: "DESC" })
			.select("id", "repo", "baseBranch", "mode");
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
	groom,
	queueSpec,
};

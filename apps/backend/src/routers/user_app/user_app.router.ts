import { cdnRouter } from "@backend/modules/cdn/cdn.user_app.router";
import { filesRouter } from "@backend/modules/files/files.router";
import { notificationsRouter } from "@backend/modules/notifications/notifications.router";
import { teamsAppRouter } from "@backend/modules/teams/teams_app.router";
import { meRouter } from "@backend/modules/users/me.user_app.router";
import { yantraUserAppRouter } from "@backend/modules/yantra/yantra.user_app.router";
import { rpcPublicProcedure } from "@backend/procedures/public.procedure";
import type {
	InferRouterInputs,
	InferRouterOutputs,
	RouterClient,
} from "@orpc/server";
import { z } from "zod";

// Phase 1: Basic health check and testing endpoints
// Modules will be added in later phases

/**
 * Which build is actually serving this process.
 *
 * Three rounds of "the fix didn't work" turned out to be "the fix was never
 * deployed", and there was no way to tell the two apart from outside: the only
 * evidence available was inferring backend behaviour from the shape of a
 * groomed issue body. A deployment you cannot identify is a deployment you
 * cannot debug.
 *
 * Read at import time, not per request — the value cannot change without a
 * restart. Coolify exposes SOURCE_COMMIT; the others cover Railway, Render and
 * a plain `docker build --build-arg`.
 */
const BUILD_COMMIT =
	process.env.SOURCE_COMMIT ??
	process.env.GIT_COMMIT_SHA ??
	process.env.RAILWAY_GIT_COMMIT_SHA ??
	process.env.RENDER_GIT_COMMIT ??
	"unknown";

/** When this process booted — distinguishes "redeployed" from "still warm". */
const STARTED_AT = new Date().toISOString();

// Health check endpoint
const healthCheck = rpcPublicProcedure
	.route({ method: "GET", tags: ["Health Check"] })
	.output(
		z.object({
			status: z.string(),
			timestamp: z.string(),
			phase: z.number(),
			message: z.string(),
			/** Short SHA of the deployed build, or "unknown" if unset. */
			commit: z.string(),
			/** Process boot time, so a stale container is obvious. */
			startedAt: z.string(),
		}),
	)
	.handler(async () => {
		return {
			status: "ok",
			timestamp: new Date().toISOString(),
			phase: 1,
			message: "Phase 1: Core Infrastructure - oRPC server is running",
			commit: BUILD_COMMIT.slice(0, 12),
			startedAt: STARTED_AT,
		};
	});

export const userAppRouter = {
	cdn: cdnRouter,
	files: filesRouter,
	health: healthCheck,
	me: meRouter,
	notifications: notificationsRouter,
	teams: teamsAppRouter,
	yantra: yantraUserAppRouter,
};

export type UserAppRouter = RouterClient<typeof userAppRouter>;
export type UserAppRouterInputs = InferRouterInputs<typeof userAppRouter>;
export type UserAppRouterOutputs = InferRouterOutputs<typeof userAppRouter>;

import { db } from "@backend/db/db";
import { subscriptionOpenApiRouter } from "@backend/modules/subscriptions/subscription.router";
import { openApiPublicProcedure } from "@backend/procedures/open_api_public.procedure";
import { zTimezone } from "@connected-repo/zod-schemas/zod_utils";
import * as z from "zod";
import { teamApiRouter } from "./team_api.router";

/**
 * Which build is actually serving this process.
 *
 * Several rounds of "the fix didn't work" were spent arguing about whether a
 * fix was even deployed, with no evidence available but inferring the
 * backend's version from the shape of a groomed issue body. A deployment you
 * cannot identify is a deployment you cannot debug.
 *
 * This lives on `/api/health` specifically because that is the one health URL
 * reachable from a shell — the oRPC health procedure is behind the RPC
 * envelope and is not what anyone curls.
 *
 * Read at import, not per request: neither value can change without a restart,
 * which is what makes a stale container obvious rather than inferred.
 * SOURCE_COMMIT is what Coolify and Dokploy set; the rest cover Railway,
 * Render and a plain `docker build --build-arg`.
 */
const BUILD_COMMIT =
	process.env.SOURCE_COMMIT ??
	process.env.GIT_COMMIT_SHA ??
	process.env.RAILWAY_GIT_COMMIT_SHA ??
	process.env.RENDER_GIT_COMMIT ??
	"unknown";

/** When this process booted — distinguishes "redeployed" from "still warm". */
const STARTED_AT = new Date().toISOString();

// Health check endpoint for OpenAPI (public - no auth required)
const healthCheck = openApiPublicProcedure
	.route({ method: "GET", tags: ["Health"] })
	.output(
		z.object({
			status: z.string(),
			timestamp: z.string(),
			dbTimezone: z.string().min(1),
			backendTimezone: z.string().min(1),
			/** Short SHA of the deployed build, or "unknown" if nothing stamps it. */
			commit: z.string(),
			/** Process boot time, so a container that survived a deploy is visible. */
			startedAt: z.string(),
		}),
	)
	.handler(async () => {
		const backendTimezone = zTimezone.parse(
			Intl.DateTimeFormat().resolvedOptions().timeZone,
		);
		try {
			// Test database connection by running a simple query
			await db.$query`SELECT 1`;
			const dbTimezoneResult =
				await db.$query`SELECT current_setting('timezone') as timezone`;
			const dbTimezone = zTimezone.parse(dbTimezoneResult.rows[0]?.timezone);
			if (!dbTimezone) {
				throw new Error("Failed to retrieve database timezone");
			}

			return {
				status: "ok",
				timestamp: new Date().toISOString(),
				dbTimezone,
				backendTimezone,
				commit: BUILD_COMMIT.slice(0, 12),
				startedAt: STARTED_AT,
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown database error";
			throw new Error(errorMessage);
		}
	});

export const openApiRouter = {
	health: healthCheck,
	v1: {
		subscriptions: subscriptionOpenApiRouter,
		team: teamApiRouter,
	},
};

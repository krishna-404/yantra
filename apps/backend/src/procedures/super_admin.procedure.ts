import { env } from "@backend/configs/env.config";
import { createRateLimitMiddleware } from "@backend/middlewares/rate_limit.middleware";
import {
	type RpcAuthenticatedContext,
	rpcProtectedProcedure,
} from "@backend/procedures/protected.procedure";
import { ORPCError } from "@orpc/server";

const normalizePhone = (v: string): string => v.replace(/\D/g, "");

const parseList = (
	raw: string | undefined,
	transform: (v: string) => string = (v) => v.toLowerCase(),
): Set<string> => {
	if (!raw) return new Set();
	return new Set(
		raw
			.split(",")
			.map((v) => transform(v.trim()))
			.filter(Boolean),
	);
};

const superAdminEmails = parseList(env.SUPER_ADMIN_EMAILS);
const superAdminPhones = parseList(
	env.SUPER_ADMIN_PHONE_NUMBERS,
	normalizePhone,
);

/**
 * The allowlist check on its own, so routes that are *mostly* team-accessible
 * can still reserve one action for an operator (e.g. writing installation-wide
 * provider keys) without duplicating the env parsing.
 */
export const isSuperAdmin = (user: {
	email?: string | null;
	phoneNumber?: string | null;
}): boolean => {
	const email = user.email?.toLowerCase();
	const phone = normalizePhone(user.phoneNumber ?? "");
	return Boolean(
		(email && superAdminEmails.has(email)) ||
			(phone !== "" && superAdminPhones.has(phone)),
	);
};

/**
 * Super-admin gate. Allows access only when the authenticated user's email
 * (case-insensitive) or phone number is listed in `SUPER_ADMIN_EMAILS` or
 * `SUPER_ADMIN_PHONE_NUMBERS` env vars. Both are comma-separated.
 *
 * Phone numbers are normalized to digits-only on both sides of the compare,
 * so "+15555551234", "5555551234", and "+1 (555) 555-1234" all match.
 *
 * Intentionally simple — no database-backed admin role, no separate auth
 * scheme. If the env lists are empty the gate fails closed (FORBIDDEN).
 *
 * NOTE: env values are captured at module load; rotating an admin requires a
 * redeploy. This is intentional (fast path, no DB hit) but must be documented.
 */
export const rpcSuperAdminProcedure = rpcProtectedProcedure
	.use(({ context, next }) => {
		if (!isSuperAdmin(context.user)) {
			throw new ORPCError("FORBIDDEN", {
				status: 403,
				message: "Super-admin access required",
			});
		}

		return next({ context });
	})
	// Bound admin actions so a compromised admin session or runaway script
	// cannot torch the DB. Placed AFTER the allowlist gate — non-admins get a
	// 403 without touching the rate_limits table, and legitimate admins get
	// a generous 30 req/min budget.
	.use(
		createRateLimitMiddleware<RpcAuthenticatedContext>({
			bucketFn: (ctx) => ({
				key: `super-admin:user:${ctx.user.id}`,
				limit: 30,
				windowSeconds: 60,
			}),
			label: "super-admin",
		}),
	);

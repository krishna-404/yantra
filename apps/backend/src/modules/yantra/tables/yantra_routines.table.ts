import { BaseTable } from "@backend/db/base_table";
import { getRequestContext } from "@backend/lib/request-context";

/**
 * A Routine: a user-configured schedule that auto-generates work for a project
 * so it stays self-sufficient — no human or assistant in the loop. Mirrors
 * Claude's Routines. On its `cron` the routines engine (P2) runs `action`
 * against `projectId` — e.g. groom the backlog and file enough `spec:ready`
 * issues to keep `targetReady` queued — so the factory never idles.
 *
 * Team-scoped (`teamId`) so every member of the project's team shares and can
 * manage its routines. The engine runs from a cron with no request context, so
 * the default tenant scope below is a no-op there (returns the query unchanged),
 * exactly like team_members during auth bootstrap.
 */
export class YantraRoutineTable extends BaseTable {
	readonly table = "yantra_routines";

	columns = this.setColumns(
		(t) => ({
			id: t.ulidWithDefault().primaryKey(),
			teamId: t.ulid().foreignKey("teams_app", "id", {
				onUpdate: "RESTRICT",
				onDelete: "CASCADE",
			}),
			projectId: t.ulid().foreignKey("yantra_projects", "id", {
				onUpdate: "RESTRICT",
				onDelete: "CASCADE",
			}),
			name: t.string(200),
			// 5-field UTC cron, e.g. "0 3 * * *". Null = trigger-only (manual/event).
			cron: t.string(100).nullable(),
			// What the routine does: "groom_backlog" | "file_specs" | "custom_prompt".
			// Kept as a validated string (not a DB enum) so new actions don't need a
			// migration — the engine + zod are the source of truth.
			action: t.string(40).default("groom_backlog"),
			// Free-form instruction for the action: the theme/area to groom, or the
			// prompt for custom_prompt. Empty = "keep the backlog topped up".
			prompt: t.text().default(""),
			// Self-feed target: keep at least this many spec:ready issues queued.
			targetReady: t.integer().default(3),
			enabled: t.boolean().default(true),
			lastRunAt: t.timestampNumber().nullable(),
			nextRunAt: t.timestampNumber().nullable(),
			createdByUserId: t
				.uuid()
				.foreignKey("users", "id", {
					onUpdate: "RESTRICT",
					onDelete: "SET NULL",
				})
				.nullable(),
			...t.timestampsAsNumbers(),
		}),
		(t) => [
			// The engine scans due, enabled routines by nextRunAt.
			t.index(["enabled", "nextRunAt"]),
			t.index(["projectId"]),
			t.index(["teamId"]),
		],
	);

	// Default tenant scope (matches team_members): team-scoped inside a request,
	// unscoped from the cron engine where there is no request context.
	scopes = this.setScopes({
		default: (q) => {
			const ctx = getRequestContext();
			return ctx ? q.where({ teamId: ctx.tenantTeamId }) : q;
		},
	});
}

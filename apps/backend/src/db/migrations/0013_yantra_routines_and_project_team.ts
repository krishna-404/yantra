import { change } from "../db_script";

/**
 * Platform P1 — multi-tenant projects + Routines.
 *
 * 1. yantra_projects.teamId — the owning team (nullable so tenant-zero's
 *    original single-operator row stays valid). Team-scoped projects are
 *    visible to every team_member; null = super-admin-only (legacy).
 * 2. yantra_routines — user-configured schedules that auto-generate work for a
 *    project (groom backlog → file spec:ready issues) so it stays self-
 *    sufficient. The engine (P2) scans enabled routines by next_run_at.
 *
 * Mirrors the migration conventions in 0010–0012 (string(26) ulids, varchar
 * FKs to teams_app/users, clock_timestamp() defaults). Sync-infra index churn
 * from the generator is intentionally NOT included (D16).
 */
change(async (db) => {
	await db.changeTable("yantra_projects", (t) => ({
		teamId: t.add(
			t
				.string(26)
				.foreignKey("teams_app", "id", {
					onUpdate: "RESTRICT",
					onDelete: "CASCADE",
				})
				.nullable(),
		),
	}));

	await db.createTable(
		"yantra_routines",
		(t) => ({
			id: t.string(26).primaryKey(),
			teamId: t.string(26).foreignKey("teams_app", "id", {
				onUpdate: "RESTRICT",
				onDelete: "CASCADE",
			}),
			projectId: t.string(26).foreignKey("yantra_projects", "id", {
				onUpdate: "RESTRICT",
				onDelete: "CASCADE",
			}),
			name: t.string(200),
			cron: t.string(100).nullable(),
			action: t.string(40).default("groom_backlog"),
			prompt: t.text().default(""),
			targetReady: t.integer().default(3),
			enabled: t.boolean().default(true),
			lastRunAt: t.timestamp().nullable(),
			nextRunAt: t.timestamp().nullable(),
			createdByUserId: t
				.uuid()
				.foreignKey("users", "id", {
					onUpdate: "RESTRICT",
					onDelete: "SET NULL",
				})
				.nullable(),
			createdAt: t.timestamp().default(t.sql`clock_timestamp()`),
			updatedAt: t.timestamp().default(t.sql`clock_timestamp()`),
		}),
		(t) => [
			t.index(["enabled", "nextRunAt"]),
			t.index(["projectId"]),
			t.index(["teamId"]),
		],
	);
});

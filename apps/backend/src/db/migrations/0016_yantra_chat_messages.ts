import { change } from "../db_script";

/**
 * yantra_chat_messages (#26) — the per-project chat thread.
 *
 * The chat lived in React state, so a refresh erased it: you could describe an
 * idea, get a drafted spec, and lose both by reloading. Persisting the thread
 * makes the chat a place work actually happens, and gives the team-bot and the
 * team knowledge-base a history to read.
 *
 * `role` distinguishes the turn kinds the UI renders: "user" (what you typed),
 * "draft" (a groomed spec awaiting approval) and "queued" (the spec:ready issue
 * that got filed). `payload` carries the role-specific bits — the draft's
 * title/tier/body, or the queued issue number + URL — so new turn kinds don't
 * need a migration.
 */
change(async (db) => {
	await db.createTable(
		"yantra_chat_messages",
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
			role: t.string(20),
			text: t.text().default(""),
			payload: t.json().nullable(),
			authorUserId: t
				.uuid()
				.foreignKey("users", "id", {
					onUpdate: "RESTRICT",
					onDelete: "SET NULL",
				})
				.nullable(),
			createdAt: t.timestamp().default(t.sql`clock_timestamp()`),
			updatedAt: t.timestamp().default(t.sql`clock_timestamp()`),
		}),
		// The thread read is always "this project's messages, oldest first".
		(t) => [t.index(["projectId", "createdAt"]), t.index(["teamId"])],
	);
});

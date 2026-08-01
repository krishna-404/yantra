import { BaseTable } from "@backend/db/base_table";
import { getRequestContext } from "@backend/lib/request-context";

/**
 * One turn in a project's chat thread (#26). The chat used to live in React
 * state, so a refresh erased the conversation; persisting it makes the chat a
 * real workspace and gives the team-bot / knowledge-base a history to read.
 *
 * Team-scoped by default, like team_members — inside a request the scope pins
 * rows to the caller's active team; from a cron (no request context) the scope
 * is a no-op so background jobs can read threads across teams.
 */
export class YantraChatMessageTable extends BaseTable {
	readonly table = "yantra_chat_messages";

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
			/** "user" | "draft" | "queued" — the turn kinds the thread renders. */
			role: t.string(20),
			text: t.text().default(""),
			/**
			 * Role-specific extras: a draft's title/tier/body/groomedBy, or a
			 * queued spec's issue number + URL. JSON so a new turn kind doesn't
			 * need a migration.
			 */
			payload: t.json().nullable(),
			authorUserId: t
				.uuid()
				.foreignKey("users", "id", {
					onUpdate: "RESTRICT",
					onDelete: "SET NULL",
				})
				.nullable(),
			...t.timestampsAsNumbers(),
		}),
		(t) => [t.index(["projectId", "createdAt"]), t.index(["teamId"])],
	);

	scopes = this.setScopes({
		default: (q) => {
			const ctx = getRequestContext();
			return ctx ? q.where({ teamId: ctx.tenantTeamId }) : q;
		},
	});
}

import { BaseTable } from "@backend/db/base_table";

/**
 * Provider secrets for the harness (D23/D24) — the credentials the runners need
 * to do work, e.g. the Claude OAuth token every execute container uses. Same
 * secret-box encryption as project tokens; the API only ever returns the last-4
 * hint.
 *
 * Two scopes, one table (#138): a row with `teamId` set belongs to that team,
 * and `teamId = null` is the installation-level fallback the operator sets.
 * Resolution is always "team key, else installation key", so a fresh team works
 * out of the box and a team that wants its own billing can override.
 */
export class YantraAppSecretTable extends BaseTable {
	readonly table = "yantra_app_secrets";

	columns = this.setColumns((t) => ({
		id: t.ulidWithDefault().primaryKey(),
		teamId: t
			.string(26)
			.foreignKey("teams_app", "id", {
				onUpdate: "RESTRICT",
				onDelete: "CASCADE",
			})
			.nullable(),
		key: t.string(100),
		valueCiphertext: t.text(),
		valueHint: t.string(4).default(""),
		...t.timestampsAsNumbers(),
	}));
}

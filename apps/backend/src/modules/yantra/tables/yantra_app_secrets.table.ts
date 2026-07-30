import { BaseTable } from "@backend/db/base_table";

/**
 * App-level harness secrets (D23/D24) — credentials that belong to the
 * operator's installation rather than to one project, e.g. the Claude OAuth
 * token every execute container uses. Same secret-box encryption as project
 * tokens; the API only ever returns the last-4 hint.
 */
export class YantraAppSecretTable extends BaseTable {
	readonly table = "yantra_app_secrets";

	columns = this.setColumns((t) => ({
		id: t.ulidWithDefault().primaryKey(),
		key: t.string(100).unique(),
		valueCiphertext: t.text(),
		valueHint: t.string(4).default(""),
		...t.timestampsAsNumbers(),
	}));
}

import { BaseTable } from "@backend/db/base_table";

/**
 * One row per grade verdict on a PR head SHA (loop-protocol §2.4). The raw
 * rubric JSON is kept verbatim for the Phase-3 scorecards. Written by the H5
 * grade runner; empty until then.
 */
export class YantraVerdictTable extends BaseTable {
	readonly table = "yantra_verdicts";

	columns = this.setColumns((t) => ({
		id: t.ulidWithDefault().primaryKey(),
		runId: t
			.string(26)
			.foreignKey("yantra_runs", "id", {
				onUpdate: "RESTRICT",
				onDelete: "CASCADE",
			})
			.nullable(),
		pr: t.integer(),
		headSha: t.string(64),
		verdict: t.string(20),
		tierConfirmed: t.string(10).nullable(),
		raw: t.json().nullable(),
		...t.timestampsAsNumbers(),
	}));
}

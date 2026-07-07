import { BaseTable } from "@backend/db/base_table";

/**
 * One row per role-run inside a turn (advise/execute/grade/dream container
 * invocation). Written by the H5 role runners; empty until then.
 */
export class YantraRunTable extends BaseTable {
	readonly table = "yantra_runs";

	columns = this.setColumns((t) => ({
		// The run ULID itself — same value the container run is labeled with.
		id: t.string(26).primaryKey(),
		turnId: t
			.string(26)
			.foreignKey("yantra_turns", "id", {
				onUpdate: "RESTRICT",
				onDelete: "CASCADE",
			})
			.nullable(),
		role: t.string(20),
		model: t.string(100),
		outcome: t.string(40).nullable(),
		startedAt: t.timestampNumber(),
		endedAt: t.timestampNumber().nullable(),
		...t.timestampsAsNumbers(),
	}));
}

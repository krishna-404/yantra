import { BaseTable } from "@backend/db/base_table";

/**
 * One row per turn — a claim on one issue through its terminal state
 * (loop-protocol §2). Empty until the H4 tick writes it; created in H1 so the
 * H2 state machine and parity fixtures have their durable substrate ready.
 * `repo`/`baseBranch` = tenant identity (tenant-zero → multi-tenant widening).
 */
export class YantraTurnTable extends BaseTable {
	readonly table = "yantra_turns";

	columns = this.setColumns((t) => ({
		id: t.ulidWithDefault().primaryKey(),
		repo: t.string(255),
		baseBranch: t.string(255),
		issue: t.integer(),
		// §2 states: claimed | advising | executing | pr_open | grading |
		// parked | failed | merged | reaped | killed
		state: t.string(20),
		tier: t.string(10).nullable(),
		pr: t.integer().nullable(),
		startedAt: t.timestampNumber(),
		endedAt: t.timestampNumber().nullable(),
		...t.timestampsAsNumbers(),
	}));
}

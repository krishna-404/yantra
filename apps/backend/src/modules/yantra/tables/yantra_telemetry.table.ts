import { BaseTable } from "@backend/db/base_table";

/**
 * One row per harness run (loop-protocol §5) — the factory's own flight
 * recorder, imported from v0's runs.jsonl (H3) and written live by the v1
 * workers after H4/H5. Field names mirror ops/yantra/lib.sh `telemetry()`
 * one-to-one so the importer is a straight mapping, not a translation.
 *
 * `repo` + `baseBranch` are first-class tenant columns (03-phase-2-harness.md
 * §0): Phase-4 multi-tenant becomes a widening, not a rewrite.
 */
export class YantraTelemetryTable extends BaseTable {
	readonly table = "yantra_telemetry";

	columns = this.setColumns((t) => ({
		id: t.ulidWithDefault().primaryKey(),
		// The run ULID from lib.sh — natural idempotency key for the importer.
		run: t.string(26).unique(),
		turn: t.string(26),
		repo: t.string(255).default("krishna-404/yantra"),
		baseBranch: t.string(255).default("staging"),
		issue: t.integer().default(0),
		role: t.string(20),
		lane: t.string(40).default("claude-max"),
		model: t.string(100),
		promptVersion: t.integer().default(1),
		tier: t.string(10),
		taskType: t.string(40).default("unknown"),
		startedAt: t.timestampNumber(),
		endedAt: t.timestampNumber(),
		wallS: t.integer().default(0),
		outcome: t.string(40),
		pr: t.integer().default(0),
		merged: t.boolean().default(false),
		autoMerged: t.boolean().default(false),
		reverted: t.boolean().default(false),
		tokensEst: t.integer().default(0),
		costUsd: t.doublePrecision().default(0),
		...t.timestampsAsNumbers(),
	}));
}

import { db } from "@backend/db/db";
import { z } from "zod";

/**
 * H3 — v0 telemetry importer (docs/yantra/03-phase-2-harness.md 2.A).
 *
 * Input is the JSONL that ops/yantra/lib.sh `telemetry()` has appended since
 * Phase 0 (one JSON object per line, loop-protocol §5). Parsing is tolerant:
 * malformed lines are reported, never abort the batch. Import is idempotent
 * on the run ULID — re-importing the same file inserts nothing new.
 */

export const telemetryLineZod = z
	.object({
		run: z.string().min(10),
		turn: z.string(),
		issue: z.number().int().default(0),
		role: z.string(),
		lane: z.string().default("claude-max"),
		model: z.string(),
		prompt_version: z.number().int().default(1),
		tier: z.string(),
		task_type: z.string().default("unknown"),
		started_at: z.string(),
		ended_at: z.string(),
		wall_s: z.number().int().default(0),
		outcome: z.string(),
		pr: z.number().int().default(0),
		merged: z.boolean().default(false),
		auto_merged: z.boolean().default(false),
		reverted: z.boolean().default(false),
		tokens_est: z.number().int().default(0),
		cost_usd: z.number().default(0),
	})
	.loose();

export type TelemetryLine = z.infer<typeof telemetryLineZod>;

export interface ParseResult {
	rows: TelemetryLine[];
	errors: { line: number; message: string }[];
}

export const parseTelemetryJsonl = (text: string): ParseResult => {
	const rows: TelemetryLine[] = [];
	const errors: ParseResult["errors"] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const raw = lines[i]?.trim();
		if (!raw) continue;
		try {
			const parsed = telemetryLineZod.parse(JSON.parse(raw));
			rows.push(parsed);
		} catch (err) {
			errors.push({
				line: i + 1,
				message:
					err instanceof Error ? err.message.slice(0, 200) : "unparseable",
			});
		}
	}
	return { rows, errors };
};

export interface ImportResult {
	inserted: number;
	skippedDuplicates: number;
}

export const importTelemetryRows = async (
	rows: TelemetryLine[],
): Promise<ImportResult> => {
	if (rows.length === 0) return { inserted: 0, skippedDuplicates: 0 };

	// Dedupe within the batch first (a re-run row can appear twice in a file
	// that was concatenated), then against the table — run ULID is the key.
	const byRun = new Map(rows.map((r) => [r.run, r]));
	const unique = [...byRun.values()];
	const intraBatchDupes = rows.length - unique.length;

	return await db.$transaction(async () => {
		const existing = await db.yantraTelemetry
			.where({ run: { in: unique.map((r) => r.run) } })
			.pluck("run");
		const existingSet = new Set(existing);
		const fresh = unique.filter((r) => !existingSet.has(r.run));

		if (fresh.length > 0) {
			await db.yantraTelemetry.createMany(
				fresh.map((r) => ({
					run: r.run,
					turn: r.turn,
					issue: r.issue,
					role: r.role,
					lane: r.lane,
					model: r.model,
					promptVersion: r.prompt_version,
					tier: r.tier,
					taskType: r.task_type,
					startedAt: new Date(r.started_at),
					endedAt: new Date(r.ended_at),
					wallS: r.wall_s,
					outcome: r.outcome,
					pr: r.pr,
					merged: r.merged,
					autoMerged: r.auto_merged,
					reverted: r.reverted,
					tokensEst: r.tokens_est,
					costUsd: r.cost_usd,
				})),
			);
		}

		return {
			inserted: fresh.length,
			skippedDuplicates: intraBatchDupes + existingSet.size,
		};
	});
};

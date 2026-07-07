import { db } from "@backend/db/db";
import {
	importTelemetryRows,
	parseTelemetryJsonl,
} from "@backend/modules/yantra/services/telemetry_import.yantra.service";
import { yantraRouter } from "@backend/modules/yantra/yantra.router";
import { createRouterClient } from "@orpc/server";
import { describe, expect, it } from "vitest";

const line = (run: string, overrides: Record<string, unknown> = {}) =>
	JSON.stringify({
		run,
		turn: "01TURN0000000000000000TURN",
		issue: 8,
		role: "execute",
		lane: "claude-max",
		model: "opus",
		prompt_version: 1,
		tier: "T2",
		task_type: "strip-module",
		started_at: "2026-07-06T07:00:00Z",
		ended_at: "2026-07-06T07:30:00Z",
		wall_s: 1800,
		outcome: "ok",
		pr: 59,
		merged: false,
		auto_merged: false,
		reverted: false,
		tokens_est: 0,
		cost_usd: 0,
		...overrides,
	});

describe("parseTelemetryJsonl", () => {
	it("parses valid lines and skips blanks", () => {
		const text = `${line("01RUNAAAAAAAAAAAAAAAAAAAAA")}\n\n${line("01RUNBBBBBBBBBBBBBBBBBBBBB")}\n`;
		const { rows, errors } = parseTelemetryJsonl(text);
		expect(rows).toHaveLength(2);
		expect(errors).toHaveLength(0);
		expect(rows[0]?.run).toBe("01RUNAAAAAAAAAAAAAAAAAAAAA");
	});

	it("reports malformed lines without aborting the batch", () => {
		const text = `${line("01RUNCCCCCCCCCCCCCCCCCCCCC")}\nnot-json\n{"run":"too-short"}`;
		const { rows, errors } = parseTelemetryJsonl(text);
		expect(rows).toHaveLength(1);
		expect(errors).toHaveLength(2);
		expect(errors[0]?.line).toBe(2);
	});
});

describe("importTelemetryRows", () => {
	it("inserts rows and is idempotent on the run ULID", async () => {
		const { rows } = parseTelemetryJsonl(
			`${line("01RUNDDDDDDDDDDDDDDDDDDDDD")}\n${line("01RUNEEEEEEEEEEEEEEEEEEEEE", { merged: true, outcome: "grade_pass_first_try" })}`,
		);

		const first = await importTelemetryRows(rows);
		expect(first.inserted).toBe(2);
		expect(first.skippedDuplicates).toBe(0);

		const second = await importTelemetryRows(rows);
		expect(second.inserted).toBe(0);
		expect(second.skippedDuplicates).toBe(2);

		const stored = await db.yantraTelemetry
			.where({ run: "01RUNEEEEEEEEEEEEEEEEEEEEE" })
			.take();
		expect(stored.merged).toBe(true);
		expect(stored.outcome).toBe("grade_pass_first_try");
	});

	it("dedupes within a single batch", async () => {
		const dupe = line("01RUNFFFFFFFFFFFFFFFFFFFFF");
		const { rows } = parseTelemetryJsonl(`${dupe}\n${dupe}`);
		const result = await importTelemetryRows(rows);
		expect(result.inserted).toBe(1);
		expect(result.skippedDuplicates).toBe(1);
	});
});

describe("yantra router auth", () => {
	it("rejects unauthenticated callers", async () => {
		const unauthClient = createRouterClient(yantraRouter);
		await expect(unauthClient.summary()).rejects.toThrow();
	});
});

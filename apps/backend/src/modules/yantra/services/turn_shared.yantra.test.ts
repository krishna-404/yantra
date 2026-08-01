import { db } from "@backend/db/db";
import { parsePromptVersion } from "@backend/modules/yantra/services/repo_files.yantra.service";
import {
	branchSlug,
	extractJsonBlock,
	issueField,
	recordRun,
	routeModel,
} from "@backend/modules/yantra/services/turn_shared.yantra.service";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

/**
 * These helpers encode v0 parity semantics (branch names, comment parsing,
 * model routing) — the H9/D24 comparison depends on them matching lib.sh
 * byte-for-byte, so they get pinned by tests.
 */

describe("routeModel", () => {
	it("mirrors the retired v0 routing.json table", () => {
		expect(routeModel("advise")).toBe("opus");
		expect(routeModel("grade")).toBe("opus");
		expect(routeModel("execute.T0")).toBe("sonnet");
		expect(routeModel("execute.T1")).toBe("sonnet");
		expect(routeModel("execute.T2")).toBe("opus");
		expect(routeModel("execute.T3")).toBe("opus");
		expect(routeModel("dream")).toBe("sonnet");
	});

	it("falls back to sonnet for unknown keys", () => {
		expect(routeModel("execute.T9")).toBe("sonnet");
	});
});

describe("extractJsonBlock", () => {
	it("takes the LAST valid fenced json block, like lib.sh", () => {
		const raw = [
			"chatter",
			"```json",
			'{"verdict":"REJECT"}',
			"```",
			"more thinking…",
			"```json",
			'{"verdict":"PROCEED","tier":"T1"}',
			"```",
		].join("\n");
		expect(extractJsonBlock(raw)).toEqual({ verdict: "PROCEED", tier: "T1" });
	});

	it("skips a trailing invalid block in favor of an earlier valid one", () => {
		const raw = [
			"```json",
			'{"ok":true}',
			"```",
			"```json",
			"{not json",
			"```",
		].join("\n");
		expect(extractJsonBlock(raw)).toEqual({ ok: true });
	});

	it("returns null when no parseable block exists", () => {
		expect(extractJsonBlock("no blocks here")).toBeNull();
		expect(extractJsonBlock("```json\n{broken\n```")).toBeNull();
	});
});

describe("branchSlug", () => {
	it("lowercases, strips [spec], collapses punctuation, caps at 40", () => {
		expect(branchSlug("[Spec] Add OAuth2 login!! (fast)")).toBe(
			"add-oauth2-login-fast",
		);
		expect(branchSlug("A".repeat(80)).length).toBeLessThanOrEqual(40);
	});
});

describe("issueField", () => {
	it("parses issue-form '### field' sections", () => {
		const body = "### type\n\nfeature\n\n### depends-on\n\n#1";
		expect(issueField(body, "type")).toBe("feature");
	});

	it("parses 'field: value' frontmatter style", () => {
		expect(issueField("type: chore\nrest", "type")).toBe("chore");
	});

	it("returns empty for missing field or null body", () => {
		expect(issueField("nothing", "type")).toBe("");
		expect(issueField(null, "type")).toBe("");
	});
});

describe("parsePromptVersion", () => {
	it("reads the template header, defaults to 1", () => {
		expect(parsePromptVersion("<!-- prompt-version: 3 -->\nhello")).toBe(3);
		expect(parsePromptVersion("no header")).toBe(1);
	});
});

describe("recordRun", () => {
	it("writes a §5-shaped telemetry row and returns the run ulid", async () => {
		const turn = ulid();
		const run = await recordRun({
			repo: "krishna-404/yantra",
			baseBranch: "staging",
			turn,
			issue: 999_901,
			role: "advise",
			model: "opus",
			promptVersion: 1,
			tier: "T1",
			taskType: "feature",
			startedAt: new Date(Date.now() - 5_000),
			outcome: "ok",
		});
		const row = await db.yantraTelemetry.findBy({ run });
		expect(row.turn).toBe(turn);
		expect(row.issue).toBe(999_901);
		expect(row.role).toBe("advise");
		expect(row.lane).toBe("claude-max");
		expect(row.wallS).toBeGreaterThanOrEqual(4);
		await db.yantraTelemetry.findBy({ run }).delete();
	});
});

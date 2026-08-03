import {
	isValidCron,
	matchesCron,
	nextRunAt,
	parseCron,
} from "@backend/modules/yantra/state/cron_schedule.yantra";
import { describe, expect, it } from "vitest";

/**
 * Routines fire from stored `nextRunAt` timestamps, so this arithmetic decides
 * whether a project's self-feed actually happens. Pure logic, pinned here.
 */

const utc = (iso: string) => new Date(`${iso}Z`);

describe("parseCron", () => {
	it("expands wildcards to the full field range", () => {
		const f = parseCron("* * * * *");
		expect(f.minute).toHaveLength(60);
		expect(f.hour).toHaveLength(24);
		expect(f.dayOfMonth).toHaveLength(31);
		expect(f.month).toHaveLength(12);
		expect(f.dayOfWeek).toHaveLength(7);
	});

	it("handles steps, ranges and lists", () => {
		expect(parseCron("*/15 * * * *").minute).toEqual([0, 15, 30, 45]);
		expect(parseCron("0 9-17 * * *").hour).toEqual([
			9, 10, 11, 12, 13, 14, 15, 16, 17,
		]);
		expect(parseCron("0 0 * * 1,3,5").dayOfWeek).toEqual([1, 3, 5]);
		expect(parseCron("0 0-23/6 * * *").hour).toEqual([0, 6, 12, 18]);
	});

	it("rejects malformed expressions", () => {
		expect(() => parseCron("* * * *")).toThrow(/5 fields/);
		expect(() => parseCron("60 * * * *")).toThrow(/out of range/);
		expect(() => parseCron("* 25 * * *")).toThrow(/out of range/);
		expect(isValidCron("0 3 * * *")).toBe(true);
		expect(isValidCron("nonsense")).toBe(false);
	});
});

describe("matchesCron", () => {
	it("matches a daily 03:00 schedule only at 03:00", () => {
		const f = parseCron("0 3 * * *");
		expect(matchesCron(f, utc("2026-08-01T03:00:00"))).toBe(true);
		expect(matchesCron(f, utc("2026-08-01T03:01:00"))).toBe(false);
		expect(matchesCron(f, utc("2026-08-01T04:00:00"))).toBe(false);
	});

	it("ORs day-of-month with day-of-week when both are restricted", () => {
		// Standard cron quirk: "1st of the month OR any Monday".
		const f = parseCron("0 0 1 * 1");
		expect(matchesCron(f, utc("2026-08-01T00:00:00"))).toBe(true); // the 1st (a Saturday)
		expect(matchesCron(f, utc("2026-08-03T00:00:00"))).toBe(true); // a Monday
		expect(matchesCron(f, utc("2026-08-04T00:00:00"))).toBe(false); // neither
	});

	it("ANDs the day fields when only one is restricted", () => {
		const f = parseCron("0 0 15 * *");
		expect(matchesCron(f, utc("2026-08-15T00:00:00"))).toBe(true);
		expect(matchesCron(f, utc("2026-08-16T00:00:00"))).toBe(false);
	});
});

describe("nextRunAt", () => {
	it("returns the next matching minute, strictly after `from`", () => {
		const next = nextRunAt("0 3 * * *", utc("2026-08-01T03:00:00"));
		// Already 03:00 — the next run is tomorrow, not now (no double-fire).
		expect(next?.toISOString()).toBe("2026-08-02T03:00:00.000Z");
	});

	it("finds a same-day slot when one remains", () => {
		const next = nextRunAt("*/30 * * * *", utc("2026-08-01T10:05:00"));
		expect(next?.toISOString()).toBe("2026-08-01T10:30:00.000Z");
	});

	it("rolls over month boundaries", () => {
		const next = nextRunAt("0 0 1 * *", utc("2026-08-20T12:00:00"));
		expect(next?.toISOString()).toBe("2026-09-01T00:00:00.000Z");
	});

	it("returns null when nothing matches inside the horizon", () => {
		// Feb 29 is years away from this date — beyond the one-year scan, so the
		// caller falls back to a fixed delay instead of hanging the routine.
		expect(nextRunAt("0 0 29 2 *", utc("2026-08-01T00:00:00"))).toBeNull();
	});

	it("ignores seconds on the input instant", () => {
		const next = nextRunAt("*/10 * * * *", utc("2026-08-01T10:00:30"));
		expect(next?.toISOString()).toBe("2026-08-01T10:10:00.000Z");
	});
});

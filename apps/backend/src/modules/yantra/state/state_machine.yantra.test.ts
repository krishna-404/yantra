import {
	AUTOMERGE_HOURLY_CAP,
	canClaim,
	effectiveTier,
	InvalidTransitionError,
	MAX_WORKING_ISSUES,
	newTurn,
	STALE_CLAIM_MS,
	type TurnEvent,
	type TurnSnapshot,
	type TurnState,
	transition,
} from "@backend/modules/yantra/state/state_machine.yantra";
import { describe, expect, it } from "vitest";

const claimed = (): TurnSnapshot => newTurn();
const executing = (): TurnSnapshot =>
	transition(claimed(), { type: "ADVISE_PROCEED", tier: "T1" }).turn;
const prOpen = (): TurnSnapshot =>
	transition(executing(), { type: "EXECUTE_OK", pr: 42 }).turn;

const okClaimCtx = {
	killSwitchOn: false,
	workingCount: 0,
	automergesLastHour: 0,
	readySpecAvailable: true,
};

describe("canClaim (§2.1 preconditions, in order)", () => {
	it("allows a claim when every precondition holds", () => {
		expect(canClaim(okClaimCtx)).toEqual({ ok: true });
	});

	it("kill switch is the FIRST reason even when others also fail", () => {
		expect(
			canClaim({
				killSwitchOn: true,
				workingCount: MAX_WORKING_ISSUES,
				automergesLastHour: AUTOMERGE_HOURLY_CAP,
				readySpecAvailable: false,
			}),
		).toEqual({ ok: false, reason: "kill_switch" });
	});

	it("blocks at capacity and at automerge saturation", () => {
		expect(
			canClaim({ ...okClaimCtx, workingCount: MAX_WORKING_ISSUES }),
		).toEqual({ ok: false, reason: "no_capacity" });
		expect(
			canClaim({ ...okClaimCtx, automergesLastHour: AUTOMERGE_HOURLY_CAP }),
		).toEqual({ ok: false, reason: "automerge_saturation" });
	});

	it("blocks when nothing is spec:ready", () => {
		expect(canClaim({ ...okClaimCtx, readySpecAvailable: false })).toEqual({
			ok: false,
			reason: "nothing_ready",
		});
	});
});

describe("happy path claim → merge", () => {
	it("walks claimed → executing → pr_open → merged for a T0 under rails", () => {
		const a = transition(claimed(), { type: "ADVISE_PROCEED", tier: "T0" });
		expect(a.turn.state).toBe("executing");
		const e = transition(a.turn, { type: "EXECUTE_OK", pr: 7 });
		expect(e.turn.state).toBe("pr_open");
		const g = transition(e.turn, {
			type: "GRADE_PASS",
			tierConfirmed: "T0",
			railsOk: true,
		});
		expect(g.turn.state).toBe("merged");
		expect(g.effects).toContainEqual({ kind: "auto_merge", pr: 7 });
		expect(g.effects).toContainEqual({ kind: "close_issue" });
	});

	it("routes T1+ PASS to the human review queue, then HUMAN_MERGE closes it", () => {
		const g = transition(prOpen(), {
			type: "GRADE_PASS",
			tierConfirmed: "T1",
			railsOk: true,
		});
		expect(g.turn.state).toBe("review_queue");
		expect(g.effects).toContainEqual({
			kind: "notify",
			workflow: "review-digest",
		});
		const m = transition(g.turn, { type: "HUMAN_MERGE" });
		expect(m.turn.state).toBe("merged");
	});
});

describe("effectiveTier (tier honesty)", () => {
	it("takes the higher of advise vs grade and never lowers", () => {
		expect(effectiveTier("T1", "T2")).toBe("T2");
		expect(effectiveTier("T2", "T1")).toBe("T2");
		expect(effectiveTier(null, "T0")).toBe("T0");
	});
});

describe("no event escapes the diagram", () => {
	const EVENTS: TurnEvent[] = [
		{ type: "ADVISE_PROCEED", tier: "T1" },
		{ type: "ADVISE_AMBIGUOUS" },
		{ type: "ADVISE_REJECT" },
		{ type: "EXECUTE_OK", pr: 1 },
		{ type: "EXECUTE_INFRA_ERROR" },
		{ type: "GRADE_PASS", tierConfirmed: "T0", railsOk: true },
		{ type: "GRADE_FAIL", failures: ["x"] },
		{ type: "HUMAN_MERGE" },
		{ type: "REAP", claimAgeMs: STALE_CLAIM_MS + 1 },
		{ type: "KILL" },
	];

	const ALLOWED: Record<TurnState, Set<TurnEvent["type"]>> = {
		claimed: new Set([
			"ADVISE_PROCEED",
			"ADVISE_AMBIGUOUS",
			"ADVISE_REJECT",
			"REAP",
			"KILL",
		]),
		executing: new Set(["EXECUTE_OK", "EXECUTE_INFRA_ERROR", "REAP", "KILL"]),
		pr_open: new Set(["GRADE_PASS", "GRADE_FAIL", "KILL"]),
		review_queue: new Set(["HUMAN_MERGE", "KILL"]),
		merged: new Set(),
		parked: new Set(),
		failed: new Set(),
		reaped: new Set(),
		killed: new Set(),
	};

	const SNAPSHOTS: Record<TurnState, TurnSnapshot> = {
		claimed: claimed(),
		executing: executing(),
		pr_open: prOpen(),
		review_queue: {
			state: "review_queue",
			tier: "T1",
			pr: 42,
			gradeFailCount: 0,
		},
		merged: { state: "merged", tier: "T0", pr: 42, gradeFailCount: 0 },
		parked: { state: "parked", tier: null, pr: null, gradeFailCount: 0 },
		failed: { state: "failed", tier: "T1", pr: 42, gradeFailCount: 2 },
		reaped: { state: "reaped", tier: null, pr: null, gradeFailCount: 0 },
		killed: { state: "killed", tier: null, pr: null, gradeFailCount: 0 },
	};

	for (const [state, snapshot] of Object.entries(SNAPSHOTS) as [
		TurnState,
		TurnSnapshot,
	][]) {
		for (const event of EVENTS) {
			const allowed = ALLOWED[state].has(event.type);
			it(`${state} × ${event.type} → ${allowed ? "transition" : "throws"}`, () => {
				if (allowed) {
					const result = transition(snapshot, event);
					expect(result.turn.state).not.toBe(undefined);
					expect(result.telemetryOutcome.length).toBeGreaterThan(0);
				} else {
					expect(() => transition(snapshot, event)).toThrow(
						InvalidTransitionError,
					);
				}
			});
		}
	}
});

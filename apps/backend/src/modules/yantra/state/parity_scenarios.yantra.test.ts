import {
	canClaim,
	InvalidTransitionError,
	newTurn,
	STALE_CLAIM_MS,
	transition,
} from "@backend/modules/yantra/state/state_machine.yantra";
import { describe, expect, it } from "vitest";

/**
 * Loop-protocol §8 — the 10 parity scenarios, encoded at the pure-state level.
 * These fixtures are the v0→v1 cutover contract (H9): the H4/H5 workers must
 * produce exactly these decisions; the parts that live above the pure machine
 * (Novu delivery, revert-PR creation, telemetry persistence) are asserted at
 * the worker layer, and each scenario notes what remains there.
 */

const okCtx = {
	killSwitchOn: false,
	workingCount: 0,
	automergesLastHour: 0,
	readySpecAvailable: true,
};

describe("loop-protocol §8 parity scenarios", () => {
	it("1. kill switch on ⇒ no claim; a live turn KILLed cleanly", () => {
		expect(canClaim({ ...okCtx, killSwitchOn: true })).toEqual({
			ok: false,
			reason: "kill_switch",
		});
		const killed = transition(newTurn(), { type: "KILL" });
		expect(killed.turn.state).toBe("killed");
		expect(killed.telemetryOutcome).toBe("killed");
	});

	it("2. 3 issues working + 1 ready ⇒ no 4th claim", () => {
		expect(canClaim({ ...okCtx, workingCount: 3 })).toEqual({
			ok: false,
			reason: "no_capacity",
		});
	});

	it("3. stale claim (≥2h, no PR) reaped exactly once — a second reap throws", () => {
		const stale = { type: "REAP" as const, claimAgeMs: STALE_CLAIM_MS };
		const first = transition(newTurn(), stale);
		expect(first.turn.state).toBe("reaped");
		expect(first.effects).toContainEqual({ kind: "release_claim" });
		// The racing second tick sees the reaped turn: exactly-once by construction.
		expect(() => transition(first.turn, stale)).toThrow(InvalidTransitionError);
		// A fresh (non-stale) claim must NOT be reapable.
		expect(() =>
			transition(newTurn(), { type: "REAP", claimAgeMs: STALE_CLAIM_MS - 1 }),
		).toThrow(InvalidTransitionError);
	});

	it("4. AMBIGUOUS advise ⇒ needs-human + notify + claim released", () => {
		const parked = transition(newTurn(), { type: "ADVISE_AMBIGUOUS" });
		expect(parked.turn.state).toBe("parked");
		expect(parked.effects).toEqual(
			expect.arrayContaining([
				{ kind: "add_needs_human" },
				{ kind: "notify", workflow: "needs-human" },
				{ kind: "release_claim" },
			]),
		);
	});

	it("5. grade FAIL → retry carries the failure list → second FAIL ⇒ agent:failed, no third try", () => {
		let turn = transition(newTurn(), {
			type: "ADVISE_PROCEED",
			tier: "T1",
		}).turn;
		turn = transition(turn, { type: "EXECUTE_OK", pr: 9 }).turn;

		const fail1 = transition(turn, {
			type: "GRADE_FAIL",
			failures: ["CI red"],
		});
		expect(fail1.turn.state).toBe("executing");
		expect(fail1.effects).toContainEqual({
			kind: "dispatch_execute_retry",
			pr: 9,
			failures: ["CI red"],
		});

		const retried = transition(fail1.turn, { type: "EXECUTE_OK", pr: 9 }).turn;
		const fail2 = transition(retried, {
			type: "GRADE_FAIL",
			failures: ["still red"],
		});
		expect(fail2.turn.state).toBe("failed");
		expect(fail2.effects).toContainEqual({ kind: "add_agent_failed" });
		// No third try: the failed turn accepts no further grade events.
		expect(() =>
			transition(fail2.turn, { type: "GRADE_FAIL", failures: ["x"] }),
		).toThrow(InvalidTransitionError);
	});

	it("6. T0 PASS but rails refuse (e.g. 160-line diff) ⇒ NO auto-merge, human queue", () => {
		let turn = transition(newTurn(), {
			type: "ADVISE_PROCEED",
			tier: "T0",
		}).turn;
		turn = transition(turn, { type: "EXECUTE_OK", pr: 11 }).turn;
		const g = transition(turn, {
			type: "GRADE_PASS",
			tierConfirmed: "T0",
			railsOk: false,
			railFailReason: "R2: diff 160 changed lines > 150",
		});
		expect(g.turn.state).toBe("review_queue");
		expect(g.effects.some((e) => e.kind === "auto_merge")).toBe(false);
		expect(g.effects).toContainEqual({
			kind: "comment_rails_refusal",
			pr: 11,
			reason: "R2: diff 160 changed lines > 150",
		});
	});

	it("7. 4 auto-merges in the hour ⇒ the next claim waits (R3 saturation)", () => {
		expect(canClaim({ ...okCtx, automergesLastHour: 4 })).toEqual({
			ok: false,
			reason: "automerge_saturation",
		});
	});

	it("8. red canary ⇒ kill: any live turn aborts with the killed notification", () => {
		// The revert-PR creation is the canary worker's job; the machine's
		// contract is that KILL is accepted from every live state.
		let turn = transition(newTurn(), {
			type: "ADVISE_PROCEED",
			tier: "T2",
		}).turn;
		turn = transition(turn, { type: "EXECUTE_OK", pr: 13 }).turn;
		const killed = transition(turn, { type: "KILL" });
		expect(killed.turn.state).toBe("killed");
		expect(killed.effects).toContainEqual({
			kind: "notify",
			workflow: "killed",
		});
	});

	it("9. grade re-derives a higher tier ⇒ higher tier wins, auto-merge blocked", () => {
		let turn = transition(newTurn(), {
			type: "ADVISE_PROCEED",
			tier: "T0",
		}).turn;
		turn = transition(turn, { type: "EXECUTE_OK", pr: 17 }).turn;
		const g = transition(turn, {
			type: "GRADE_PASS",
			tierConfirmed: "T2",
			railsOk: true,
		});
		expect(g.turn.tier).toBe("T2");
		expect(g.turn.state).toBe("review_queue");
		expect(g.effects).toContainEqual({
			kind: "update_tier_label",
			from: "T0",
			to: "T2",
		});
		expect(g.effects.some((e) => e.kind === "auto_merge")).toBe(false);
	});

	it("10. every transition names a telemetry outcome — parked and infra-error included", () => {
		const parked = transition(newTurn(), { type: "ADVISE_REJECT" });
		expect(parked.telemetryOutcome).toBe("parked");

		const infra = transition(
			transition(newTurn(), { type: "ADVISE_PROCEED", tier: "T1" }).turn,
			{ type: "EXECUTE_INFRA_ERROR" },
		);
		expect(infra.telemetryOutcome).toBe("infra_error");
		expect(infra.turn.state).toBe("parked");
	});
});

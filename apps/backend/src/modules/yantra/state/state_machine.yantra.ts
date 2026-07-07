/**
 * H2 — the turn state machine (loop-protocol §2), pure and I/O-free.
 *
 * v0 encodes this lifecycle implicitly across loop-tick.sh / advise.sh /
 * execute.sh / grade.sh with GitHub labels as the state store. This module is
 * the explicit encoding the v1 workers (H4/H5) drive against the H1 tables:
 * every allowed transition is enumerated, every disallowed one throws, and
 * side effects come back as DATA (an effects checklist) so the workers can't
 * forget a label swap or a notification the bash version performed.
 *
 * Any behavior difference from loop-protocol §2 is a bug in exactly one of
 * the two — fix the document or this module via PR, never silently diverge.
 */

/** §2.1 precondition 2 (D18): max concurrent claimed issues. */
export const MAX_WORKING_ISSUES = 3;
/** §2.1 precondition 3 / rail R3: auto-merges allowed per trailing hour. */
export const AUTOMERGE_HOURLY_CAP = 4;
/** §2.1: a claim this old with no PR is stale and may be reaped. */
export const STALE_CLAIM_MS = 2 * 60 * 60 * 1000;

export type TurnTier = "T0" | "T1" | "T2" | "T3";

export type TurnState =
	| "claimed" // agent:working, advise pending
	| "executing" // agent:working, execute container running (first try or retry)
	| "pr_open" // agent:pr-open, awaiting grade
	| "review_queue" // grade PASS on T1+ (or rails-refused T0) — human merge
	| "merged" // terminal
	| "parked" // terminal for the turn: needs-human (bad spec / infra error)
	| "failed" // terminal: agent:failed after two grade FAILs
	| "reaped" // terminal: stale claim released back to spec:ready
	| "killed"; // terminal: kill switch aborted the turn

const TERMINAL_STATES: ReadonlySet<TurnState> = new Set([
	"merged",
	"parked",
	"failed",
	"reaped",
	"killed",
]);

export interface TurnSnapshot {
	state: TurnState;
	/** Advise's proposed tier; raised (never lowered) by grade's re-derivation. */
	tier: TurnTier | null;
	pr: number | null;
	/** Grade FAILs so far — §2.4 allows exactly one retry. */
	gradeFailCount: number;
}

export const newTurn = (): TurnSnapshot => ({
	state: "claimed",
	tier: null,
	pr: null,
	gradeFailCount: 0,
});

// ── §2.1 claim preconditions ────────────────────────────────────────────────

export type ClaimBlockReason =
	| "kill_switch"
	| "no_capacity"
	| "automerge_saturation"
	| "nothing_ready";

export interface ClaimContext {
	killSwitchOn: boolean;
	workingCount: number;
	automergesLastHour: number;
	readySpecAvailable: boolean;
}

export type ClaimDecision =
	| { ok: true }
	| { ok: false; reason: ClaimBlockReason };

/** §2.1 — checked in order; the FIRST failing precondition is the reason. */
export const canClaim = (ctx: ClaimContext): ClaimDecision => {
	if (ctx.killSwitchOn) return { ok: false, reason: "kill_switch" };
	if (ctx.workingCount >= MAX_WORKING_ISSUES)
		return { ok: false, reason: "no_capacity" };
	if (ctx.automergesLastHour >= AUTOMERGE_HOURLY_CAP)
		return { ok: false, reason: "automerge_saturation" };
	if (!ctx.readySpecAvailable) return { ok: false, reason: "nothing_ready" };
	return { ok: true };
};

// ── tier honesty (§2.4) ─────────────────────────────────────────────────────

const TIER_RANK: Record<TurnTier, number> = { T0: 0, T1: 1, T2: 2, T3: 3 };

/** Grade re-derives the tier from the diff; the HIGHER of the two wins. */
export const effectiveTier = (
	adviseTier: TurnTier | null,
	gradedTier: TurnTier,
): TurnTier => {
	if (adviseTier === null) return gradedTier;
	return TIER_RANK[gradedTier] > TIER_RANK[adviseTier]
		? gradedTier
		: adviseTier;
};

// ── events ──────────────────────────────────────────────────────────────────

export type TurnEvent =
	| { type: "ADVISE_PROCEED"; tier: TurnTier }
	| { type: "ADVISE_AMBIGUOUS" }
	| { type: "ADVISE_REJECT" }
	| { type: "EXECUTE_OK"; pr: number }
	/** Emitted AFTER the runner's own §2.3 retry-once-after-60s failed too. */
	| { type: "EXECUTE_INFRA_ERROR" }
	| {
			type: "GRADE_PASS";
			tierConfirmed: TurnTier;
			/** H8's checkRails outcome — rails stay the merge gate, not this module. */
			railsOk: boolean;
			railFailReason?: string;
	  }
	| { type: "GRADE_FAIL"; failures: string[] }
	| { type: "HUMAN_MERGE" }
	| { type: "REAP"; claimAgeMs: number }
	| { type: "KILL" };

// ── effects (returned as data; the workers perform them) ────────────────────

export type Effect =
	| { kind: "apply_tier_label"; tier: TurnTier }
	| { kind: "update_tier_label"; from: TurnTier; to: TurnTier }
	| { kind: "swap_labels_to_pr_open"; pr: number }
	| { kind: "release_claim" }
	| { kind: "add_needs_human" }
	| { kind: "add_agent_failed" }
	| { kind: "notify"; workflow: "needs-human" | "review-digest" | "killed" }
	| { kind: "auto_merge"; pr: number }
	| { kind: "record_automerge"; pr: number }
	| { kind: "comment_rails_refusal"; pr: number; reason: string }
	| { kind: "dispatch_execute_retry"; pr: number; failures: string[] }
	| { kind: "comment_reap" }
	| { kind: "close_issue" };

export interface TransitionResult {
	turn: TurnSnapshot;
	effects: Effect[];
	/** §5/§8 scenario 10: EVERY transition names its telemetry outcome. */
	telemetryOutcome: string;
}

export class InvalidTransitionError extends Error {
	constructor(state: TurnState, event: TurnEvent["type"], detail?: string) {
		super(
			`invalid transition: ${event} in state ${state}${detail ? ` (${detail})` : ""}`,
		);
		this.name = "InvalidTransitionError";
	}
}

// ── the machine (§2.2–§2.5) ─────────────────────────────────────────────────

export const transition = (
	turn: TurnSnapshot,
	event: TurnEvent,
): TransitionResult => {
	// Kill switch aborts any live turn (§2 diagram; re-checked at every
	// role boundary in v0). Terminal states cannot be killed again.
	if (event.type === "KILL") {
		if (TERMINAL_STATES.has(turn.state))
			throw new InvalidTransitionError(turn.state, event.type);
		return {
			turn: { ...turn, state: "killed" },
			effects: [
				{ kind: "release_claim" },
				{ kind: "notify", workflow: "killed" },
			],
			telemetryOutcome: "killed",
		};
	}

	// §2.1: only a live claim with NO PR is reapable, and only once —
	// two racing ticks must produce exactly one reap (parity scenario 3).
	if (event.type === "REAP") {
		const reapable =
			(turn.state === "claimed" || turn.state === "executing") &&
			turn.pr === null;
		if (!reapable) throw new InvalidTransitionError(turn.state, event.type);
		if (event.claimAgeMs < STALE_CLAIM_MS)
			throw new InvalidTransitionError(
				turn.state,
				event.type,
				"claim not stale",
			);
		return {
			turn: { ...turn, state: "reaped" },
			effects: [{ kind: "release_claim" }, { kind: "comment_reap" }],
			telemetryOutcome: "reaped",
		};
	}

	switch (turn.state) {
		case "claimed": {
			// §2.2 — the blocking plan gate.
			if (event.type === "ADVISE_PROCEED") {
				return {
					turn: { ...turn, state: "executing", tier: event.tier },
					effects: [{ kind: "apply_tier_label", tier: event.tier }],
					telemetryOutcome: "ok",
				};
			}
			if (event.type === "ADVISE_AMBIGUOUS" || event.type === "ADVISE_REJECT") {
				return {
					turn: { ...turn, state: "parked" },
					effects: [
						{ kind: "add_needs_human" },
						{ kind: "notify", workflow: "needs-human" },
						{ kind: "release_claim" },
					],
					telemetryOutcome: "parked",
				};
			}
			throw new InvalidTransitionError(turn.state, event.type);
		}

		case "executing": {
			// §2.3 — one containerized build run, one PR.
			if (event.type === "EXECUTE_OK") {
				return {
					turn: { ...turn, state: "pr_open", pr: event.pr },
					effects: [{ kind: "swap_labels_to_pr_open", pr: event.pr }],
					telemetryOutcome: "ok",
				};
			}
			if (event.type === "EXECUTE_INFRA_ERROR") {
				return {
					turn: { ...turn, state: "parked" },
					effects: [
						{ kind: "add_needs_human" },
						{ kind: "notify", workflow: "needs-human" },
						{ kind: "release_claim" },
					],
					telemetryOutcome: "infra_error",
				};
			}
			throw new InvalidTransitionError(turn.state, event.type);
		}

		case "pr_open": {
			// §2.4 — two-leg grade already folded into the event by the runner
			// (CI red arrives as GRADE_FAIL with the CI failure listed).
			if (event.type === "GRADE_PASS") {
				if (turn.pr === null)
					throw new InvalidTransitionError(turn.state, event.type, "no PR");
				const tier = effectiveTier(turn.tier, event.tierConfirmed);
				const effects: Effect[] = [];
				if (turn.tier !== null && tier !== turn.tier) {
					effects.push({
						kind: "update_tier_label",
						from: turn.tier,
						to: tier,
					});
				}
				const passOutcome =
					turn.gradeFailCount > 0 ? "grade_pass_retry" : "grade_pass_first_try";
				// §2.4 + §6: auto-merge is T0 + rails ONLY. Tier honesty means a
				// grade-raised tier blocks the merge (parity scenario 9); a rails
				// refusal queues for human review instead (scenario 6).
				if (tier === "T0" && event.railsOk) {
					effects.push(
						{ kind: "auto_merge", pr: turn.pr },
						{ kind: "record_automerge", pr: turn.pr },
						{ kind: "close_issue" },
					);
					return {
						turn: { ...turn, state: "merged", tier },
						effects,
						telemetryOutcome: passOutcome,
					};
				}
				if (tier === "T0" && !event.railsOk) {
					effects.push({
						kind: "comment_rails_refusal",
						pr: turn.pr,
						reason: event.railFailReason ?? "rails refused",
					});
				}
				effects.push({ kind: "notify", workflow: "review-digest" });
				return {
					turn: { ...turn, state: "review_queue", tier },
					effects,
					telemetryOutcome: passOutcome,
				};
			}
			if (event.type === "GRADE_FAIL") {
				if (turn.pr === null)
					throw new InvalidTransitionError(turn.state, event.type, "no PR");
				// §2.4: FAIL ⇒ ONE retry with the failure list; second FAIL ⇒
				// agent:failed, no third try (parity scenario 5).
				if (turn.gradeFailCount === 0) {
					return {
						turn: { ...turn, state: "executing", gradeFailCount: 1 },
						effects: [
							{
								kind: "dispatch_execute_retry",
								pr: turn.pr,
								failures: event.failures,
							},
						],
						telemetryOutcome: "grade_fail",
					};
				}
				return {
					turn: { ...turn, state: "failed", gradeFailCount: 2 },
					effects: [
						{ kind: "add_agent_failed" },
						{ kind: "add_needs_human" },
						{ kind: "notify", workflow: "needs-human" },
					],
					telemetryOutcome: "grade_fail",
				};
			}
			throw new InvalidTransitionError(turn.state, event.type);
		}

		case "review_queue": {
			if (event.type === "HUMAN_MERGE") {
				if (turn.pr === null)
					throw new InvalidTransitionError(turn.state, event.type, "no PR");
				return {
					turn: { ...turn, state: "merged" },
					effects: [{ kind: "close_issue" }],
					telemetryOutcome: "human_merge",
				};
			}
			throw new InvalidTransitionError(turn.state, event.type);
		}

		default:
			throw new InvalidTransitionError(turn.state, event.type);
	}
};

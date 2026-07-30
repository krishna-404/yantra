/**
 * H8 — auto-merge rails R1–R4 (loop-protocol §6) as ONE pure function, ported
 * from ops/yantra/grade.sh rails_check. The merge path calls this and nothing
 * else may merge. R5 (reverts) relaxes only R2's size caps.
 *
 * Pure by design: counts and switch state arrive as inputs; the caller
 * gathers them fresh immediately before merging.
 */

export interface RailsPr {
	additions: number;
	deletions: number;
	changedFiles: number;
	filePaths: string[];
}

export interface RailsContext {
	tierConfirmed: string;
	rubricVerdict: string;
	automergesLastHour: number;
	killSwitchOn: boolean;
	isRevert?: boolean;
}

const PROTECTED_PATH =
	/^\.github\/|^ops\/yantra\/|^apps\/yantra\/|^LICENSE$|auth|secret|\.env|migrations\/|^\.brain\//;
const BRAIN_INBOX = /^\.brain\/inbox\//;

/**
 * Tiers eligible for auto-merge. T0 + T1 only — both are small, self-contained
 * changes the R2 size caps already bound; T2+ always waits for human review.
 * Kept in lock-step with isAutoMergeTier in state_machine.yantra.ts (same
 * policy, two layers).
 */
const AUTO_MERGE_TIERS = new Set(["T0", "T1"]);

/** Returns null when every rail holds, else the first violated rail. */
export const checkRails = (pr: RailsPr, ctx: RailsContext): string | null => {
	// R1 — T0/T1 + rubric PASS (CI-green is a caller precondition)
	if (ctx.rubricVerdict !== "PASS") {
		return `R1: rubric verdict is ${ctx.rubricVerdict}, not PASS`;
	}
	if (!AUTO_MERGE_TIERS.has(ctx.tierConfirmed)) {
		return `R1: tier_confirmed=${ctx.tierConfirmed} — only T0/T1 auto-merge`;
	}

	// R2 — size caps (reverts exempt) + protected paths (never exempt)
	if (!ctx.isRevert) {
		const lines = pr.additions + pr.deletions;
		if (lines > 150) return `R2: diff ${lines} changed lines > 150`;
		if (pr.changedFiles > 5) return `R2: ${pr.changedFiles} files > 5`;
	}
	const bad = pr.filePaths.find(
		(p) => PROTECTED_PATH.test(p) && !BRAIN_INBOX.test(p),
	);
	if (bad) return `R2: touches protected path: ${bad}`;
	if (pr.filePaths.some((p) => /(^|\/)package\.json$/.test(p))) {
		return "R2: touches package.json (dependency sections are rail-protected)";
	}

	// R3 — < 4 auto-merges in the trailing 60 min (repo-wide)
	if (ctx.automergesLastHour >= 4) {
		return `R3: ${ctx.automergesLastHour} auto-merges in the last hour (cap 4)`;
	}

	// R4 — kill switch, re-checked at merge time
	if (ctx.killSwitchOn) return "R4: YANTRA_KILL is true";

	return null;
};

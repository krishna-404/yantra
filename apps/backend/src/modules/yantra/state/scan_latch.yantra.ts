/**
 * A single-flight latch that cannot wedge.
 *
 * The grade scan is serialised by a "one at a time" flag: a second tick sees
 * the flag and skips. That is correct right up until the in-flight scan never
 * finishes — a hung network call, a container that never exits — at which point
 * the flag is never cleared and *every subsequent tick skips forever*. Grading
 * stops for the whole process, silently, until someone restarts it.
 *
 * So the latch is held with a timestamp rather than a boolean, and a holder
 * older than `wedgeAfterMs` is presumed dead and taken over. The takeover is
 * loud on purpose: a wedged scan is a bug, and self-healing past it quietly
 * would hide the thing worth fixing.
 *
 * Release is token-checked. A zombie holder that finally returns must not clear
 * the latch of the scan that replaced it, or the two overlap for real.
 */
export interface LatchAcquired {
	acquired: true;
	token: number;
	/** Set when this acquisition displaced a presumed-dead holder. */
	tookOverAfterMs: number | null;
}

export interface LatchBusy {
	acquired: false;
	/** How long the current holder has been running. */
	heldForMs: number;
}

export type LatchResult = LatchAcquired | LatchBusy;

export class ScanLatch {
	private heldSince: number | null = null;
	private token = 0;

	constructor(private readonly wedgeAfterMs: number) {}

	/** @param now injected so the wedge boundary is testable without fake timers. */
	acquire(now: number = Date.now()): LatchResult {
		if (this.heldSince !== null) {
			const heldForMs = now - this.heldSince;
			if (heldForMs < this.wedgeAfterMs) return { acquired: false, heldForMs };
			// Presumed dead — take over.
			this.heldSince = now;
			this.token += 1;
			return { acquired: true, token: this.token, tookOverAfterMs: heldForMs };
		}
		this.heldSince = now;
		this.token += 1;
		return { acquired: true, token: this.token, tookOverAfterMs: null };
	}

	/** No-op unless `token` still owns the latch, so a zombie can't free it. */
	release(token: number): void {
		if (this.token === token) this.heldSince = null;
	}

	/** Test seam only. */
	get isHeld(): boolean {
		return this.heldSince !== null;
	}
}

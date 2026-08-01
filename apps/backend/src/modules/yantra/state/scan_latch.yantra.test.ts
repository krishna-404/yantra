import { ScanLatch } from "@backend/modules/yantra/state/scan_latch.yantra";
import { describe, expect, it } from "vitest";

/**
 * This latch is the only thing standing between one hung GitHub call and
 * "grading silently stops until someone restarts the process", so its
 * boundaries are pinned rather than assumed.
 */

const WEDGE = 60_000;
const T0 = 1_000_000;

describe("ScanLatch", () => {
	it("lets the first caller in and keeps the second out", () => {
		const latch = new ScanLatch(WEDGE);
		const first = latch.acquire(T0);
		expect(first.acquired).toBe(true);

		const second = latch.acquire(T0 + 5_000);
		expect(second.acquired).toBe(false);
		if (!second.acquired) expect(second.heldForMs).toBe(5_000);
	});

	it("re-opens after the holder releases", () => {
		const latch = new ScanLatch(WEDGE);
		const first = latch.acquire(T0);
		if (!first.acquired) throw new Error("expected acquire");
		latch.release(first.token);

		expect(latch.isHeld).toBe(false);
		expect(latch.acquire(T0 + 1).acquired).toBe(true);
	});

	it("holds right up to the wedge boundary, then takes over", () => {
		const latch = new ScanLatch(WEDGE);
		latch.acquire(T0);

		// One millisecond short: still a legitimate long-running scan.
		expect(latch.acquire(T0 + WEDGE - 1).acquired).toBe(false);

		const takeover = latch.acquire(T0 + WEDGE);
		expect(takeover.acquired).toBe(true);
		if (takeover.acquired) expect(takeover.tookOverAfterMs).toBe(WEDGE);
	});

	it("reports no takeover on an uncontested acquire", () => {
		const latch = new ScanLatch(WEDGE);
		const first = latch.acquire(T0);
		if (!first.acquired) throw new Error("expected acquire");
		expect(first.tookOverAfterMs).toBeNull();
	});

	it("ignores a zombie's release so it can't free the scan that replaced it", () => {
		const latch = new ScanLatch(WEDGE);
		const zombie = latch.acquire(T0);
		if (!zombie.acquired) throw new Error("expected acquire");

		const successor = latch.acquire(T0 + WEDGE);
		expect(successor.acquired).toBe(true);

		// The hung scan finally returns and runs its `finally`.
		latch.release(zombie.token);

		// The successor must still own the latch — otherwise two scans overlap.
		expect(latch.isHeld).toBe(true);
		expect(latch.acquire(T0 + WEDGE + 1).acquired).toBe(false);
	});

	it("does not wedge again after a takeover is released", () => {
		const latch = new ScanLatch(WEDGE);
		latch.acquire(T0);
		const takeover = latch.acquire(T0 + WEDGE);
		if (!takeover.acquired) throw new Error("expected takeover");

		latch.release(takeover.token);
		expect(latch.acquire(T0 + WEDGE + 1).acquired).toBe(true);
	});

	it("takes over repeatedly rather than staying stuck on one dead holder", () => {
		const latch = new ScanLatch(WEDGE);
		latch.acquire(T0);
		// Every scan hangs; each tick past the boundary must still get a turn.
		expect(latch.acquire(T0 + WEDGE).acquired).toBe(true);
		expect(latch.acquire(T0 + WEDGE * 2).acquired).toBe(true);
		expect(latch.acquire(T0 + WEDGE * 3).acquired).toBe(true);
	});
});

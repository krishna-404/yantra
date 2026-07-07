import {
	decideShadowTick,
	parseDependsOn,
} from "@backend/modules/yantra/services/shadow_tick.yantra.service";
import { STALE_CLAIM_MS } from "@backend/modules/yantra/state/state_machine.yantra";
import { describe, expect, it } from "vitest";

const base = {
	killSwitchOn: false,
	working: [],
	ready: [],
	automergesLastHour: 0,
};

describe("decideShadowTick", () => {
	it("kill switch blocks everything, named first", () => {
		const d = decideShadowTick({
			...base,
			killSwitchOn: true,
			ready: [{ number: 5, openDeps: [] }],
		});
		expect(d.outcome).toBe("blocked_kill_switch");
		expect(d.wouldClaim).toBeNull();
	});

	it("claims the first ready issue whose deps are all closed", () => {
		const d = decideShadowTick({
			...base,
			ready: [
				{ number: 13, openDeps: [55] }, // blocked by open dep
				{ number: 23, openDeps: [] },
			],
		});
		expect(d.outcome).toBe("would_claim_#23");
		expect(d.wouldClaim).toBe(23);
	});

	it("reports idle when every ready issue is dep-blocked", () => {
		const d = decideShadowTick({
			...base,
			ready: [{ number: 13, openDeps: [55] }],
		});
		expect(d.outcome).toBe("blocked_nothing_ready");
	});

	it("capacity blocks at 3 working; stale no-PR claims are flagged for reap", () => {
		const d = decideShadowTick({
			...base,
			working: [
				{ number: 1, claimAgeMs: STALE_CLAIM_MS + 1, hasOpenPr: false },
				{ number: 2, claimAgeMs: 1000, hasOpenPr: false },
				{ number: 3, claimAgeMs: STALE_CLAIM_MS + 1, hasOpenPr: true },
			],
			ready: [{ number: 9, openDeps: [] }],
		});
		expect(d.outcome).toBe("blocked_no_capacity");
		// Only #1 reaps: #2 is fresh, #3 has an open PR (labels just lagged).
		expect(d.wouldReap).toEqual([1]);
	});

	it("R3 saturation blocks new claims", () => {
		const d = decideShadowTick({
			...base,
			automergesLastHour: 4,
			ready: [{ number: 9, openDeps: [] }],
		});
		expect(d.outcome).toBe("blocked_automerge_saturation");
	});
});

describe("parseDependsOn", () => {
	it("parses issue refs from the spec form field", () => {
		expect(parseDependsOn("### depends-on\n\n#68, #12\n\n### next")).toEqual([
			68, 12,
		]);
	});

	it("returns empty for none/dash/absent", () => {
		expect(parseDependsOn("### depends-on\n\n—\n")).toEqual([]);
		expect(parseDependsOn("no field here")).toEqual([]);
		expect(parseDependsOn(null)).toEqual([]);
	});
});

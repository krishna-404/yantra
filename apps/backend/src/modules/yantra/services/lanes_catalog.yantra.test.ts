import {
	candidateModels,
	LANE_MODELS,
} from "@backend/modules/yantra/services/lanes.yantra.service";
import { describe, expect, it } from "vitest";

/** The model catalog (D26) — the seed pool the scorecards later refine. */

describe("LANE_MODELS catalog", () => {
	it("every entry is well-formed: provider/model ref, source, ≥1 role", () => {
		for (const m of LANE_MODELS) {
			expect(m.ref).toMatch(/^[a-z]+\/.+/); // provider/model
			expect(["groq", "nvidia", "opencode"]).toContain(m.source);
			// the ref's provider prefix matches the declared source
			expect(m.ref.startsWith(`${m.source}/`)).toBe(true);
			expect(m.roles.length).toBeGreaterThan(0);
			expect(["fast", "medium", "slow"]).toContain(m.speed);
		}
	});

	it("has both executors and graders", () => {
		expect(LANE_MODELS.some((m) => m.roles.includes("execute"))).toBe(true);
		expect(LANE_MODELS.some((m) => m.roles.includes("grade"))).toBe(true);
	});
});

describe("candidateModels", () => {
	it("filters by role AND available credential source", () => {
		// Only NVIDIA credential present → no opencode-native models offered.
		const execNvidia = candidateModels("execute", ["nvidia"]);
		expect(execNvidia.length).toBeGreaterThan(0);
		expect(execNvidia.every((m) => m.source === "nvidia")).toBe(true);
		expect(execNvidia.every((m) => m.roles.includes("execute"))).toBe(true);

		// With the OpenCode token too, the free-native models become eligible.
		const execBoth = candidateModels("execute", ["nvidia", "opencode"]);
		expect(execBoth.length).toBeGreaterThan(execNvidia.length);

		// No credentials → nothing eligible.
		expect(candidateModels("execute", [])).toHaveLength(0);
	});

	it("graders and executors are drawn from different pools", () => {
		const graders = candidateModels("grade", ["nvidia"]).map((m) => m.ref);
		const execs = candidateModels("execute", ["nvidia"]).map((m) => m.ref);
		// The seed keeps the fast execs and slow graders disjoint.
		expect(graders.some((g) => execs.includes(g))).toBe(false);
	});
});

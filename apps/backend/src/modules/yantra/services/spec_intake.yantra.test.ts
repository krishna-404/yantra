import { draftFromGroomText } from "@backend/modules/yantra/services/spec_intake.yantra.service";
import { describe, expect, it } from "vitest";

const wrap = (json: unknown) =>
	`Here is the spec:\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;

describe("draftFromGroomText", () => {
	it("renders a complete groomer json into issue-form markdown", () => {
		const draft = draftFromGroomText(
			wrap({
				title: "[Spec] Add rate limiting to upload endpoint",
				tier: "T2",
				type: "feature",
				problem: "Uploads are unbounded.",
				success_criteria: ["429 after N req/min", "tests cover the limiter"],
				out_of_scope: ["per-user quotas"],
			}),
			"fallback",
			"groq/llama-3.3-70b-versatile",
		);
		expect(draft.title).toBe("[Spec] Add rate limiting to upload endpoint");
		expect(draft.tier).toBe("T2");
		expect(draft.body).toContain("### type\n\nfeature");
		expect(draft.body).toContain("- [ ] 429 after N req/min");
		expect(draft.body).toContain("## Out of scope");
		expect(draft.body).toContain("- per-user quotas");
		expect(draft.groomedBy).toBe("groq/llama-3.3-70b-versatile");
	});

	it("always guarantees the CI gate as a success criterion", () => {
		const draft = draftFromGroomText(
			wrap({ title: "[Spec] Tweak", success_criteria: ["do the thing"] }),
			"fallback",
			"m",
		);
		expect(draft.body).toMatch(/lint.+check-types.+test/i);
	});

	it("defaults tier to T1 when missing or invalid", () => {
		expect(draftFromGroomText(wrap({ title: "x" }), "f", "m").tier).toBe("T1");
		expect(
			draftFromGroomText(wrap({ title: "x", tier: "T9" }), "f", "m").tier,
		).toBe("T1");
	});

	it("uses the fallback problem when the groomer omits one", () => {
		const draft = draftFromGroomText(
			wrap({ title: "[Spec] x" }),
			"the original idea text",
			"m",
		);
		expect(draft.body).toContain("the original idea text");
	});

	it("rejects output with no json block", () => {
		expect(() => draftFromGroomText("no json here", "f", "m")).toThrow(
			/usable spec/,
		);
	});

	it("rejects output with an empty title", () => {
		expect(() => draftFromGroomText(wrap({ title: "   " }), "f", "m")).toThrow(
			/usable spec/,
		);
	});
});

import {
	checkRails,
	type RailsContext,
	type RailsPr,
} from "@backend/modules/yantra/state/rails.yantra";
import { describe, expect, it } from "vitest";

/** Table-driven: every rail × pass/fail (H8 success criteria). */

const okPr: RailsPr = {
	additions: 40,
	deletions: 20,
	changedFiles: 3,
	filePaths: ["apps/backend/src/foo.ts", "apps/frontend/src/Bar.tsx"],
};
const okCtx: RailsContext = {
	tierConfirmed: "T0",
	rubricVerdict: "PASS",
	automergesLastHour: 0,
	killSwitchOn: false,
};

describe("checkRails (R1–R5)", () => {
	it("all rails hold ⇒ null", () => {
		expect(checkRails(okPr, okCtx)).toBeNull();
	});

	it("R1: non-PASS verdict refuses", () => {
		expect(checkRails(okPr, { ...okCtx, rubricVerdict: "FAIL" })).toMatch(
			/^R1/,
		);
	});

	it("R1: T0 and T1 auto-merge; T2+ refuses", () => {
		for (const tier of ["T0", "T1"]) {
			expect(checkRails(okPr, { ...okCtx, tierConfirmed: tier })).toBeNull();
		}
		for (const tier of ["T2", "T3"]) {
			expect(checkRails(okPr, { ...okCtx, tierConfirmed: tier })).toMatch(
				/^R1/,
			);
		}
	});

	it("R2: >150 changed lines refuses; exactly 150 passes", () => {
		expect(
			checkRails({ ...okPr, additions: 151, deletions: 0 }, okCtx),
		).toMatch(/^R2: diff 151/);
		expect(
			checkRails({ ...okPr, additions: 100, deletions: 50 }, okCtx),
		).toBeNull();
	});

	it("R2: >5 files refuses", () => {
		expect(checkRails({ ...okPr, changedFiles: 6 }, okCtx)).toMatch(
			/^R2: 6 files/,
		);
	});

	it("R2: protected paths refuse — including auth/secret/env/migrations substrings", () => {
		const cases = [
			".github/workflows/ci.yml",
			"ops/yantra/prompts/grade.md",
			"apps/yantra/x.ts",
			"LICENSE",
			"apps/backend/src/modules/auth/session.ts",
			"apps/backend/src/secret_box.ts",
			"apps/backend/.env.example",
			"apps/backend/src/db/migrations/0001_x.ts",
			".brain/decisions.md",
		];
		for (const path of cases) {
			expect(checkRails({ ...okPr, filePaths: [path] }, okCtx)).toMatch(
				/^R2: touches protected path/,
			);
		}
	});

	it("R2: .brain/inbox/ is the carved-out exception", () => {
		expect(
			checkRails({ ...okPr, filePaths: [".brain/inbox/note.md"] }, okCtx),
		).toBeNull();
	});

	it("R2: package.json anywhere refuses", () => {
		expect(
			checkRails({ ...okPr, filePaths: ["apps/backend/package.json"] }, okCtx),
		).toMatch(/package\.json/);
		expect(checkRails({ ...okPr, filePaths: ["package.json"] }, okCtx)).toMatch(
			/package\.json/,
		);
	});

	it("R5: revert exempts size caps but NEVER protected paths", () => {
		const big = { ...okPr, additions: 400, deletions: 300, changedFiles: 12 };
		expect(checkRails(big, { ...okCtx, isRevert: true })).toBeNull();
		expect(
			checkRails(
				{ ...big, filePaths: ["ops/yantra/Dockerfile"] },
				{ ...okCtx, isRevert: true },
			),
		).toMatch(/^R2: touches protected path/);
	});

	it("R3: 4 auto-merges in the hour refuses; 3 passes", () => {
		expect(checkRails(okPr, { ...okCtx, automergesLastHour: 4 })).toMatch(
			/^R3/,
		);
		expect(checkRails(okPr, { ...okCtx, automergesLastHour: 3 })).toBeNull();
	});

	it("R4: kill switch refuses at merge time", () => {
		expect(checkRails(okPr, { ...okCtx, killSwitchOn: true })).toBe(
			"R4: YANTRA_KILL is true",
		);
	});

	it("rail order matches v0: R1 before R2 before R3 before R4", () => {
		const everythingWrong = checkRails(
			{ ...okPr, additions: 999, filePaths: ["LICENSE"] },
			{
				tierConfirmed: "T2",
				rubricVerdict: "PASS",
				automergesLastHour: 9,
				killSwitchOn: true,
			},
		);
		expect(everythingWrong).toMatch(/^R1/);
	});
});

import { buildModuleMap } from "@backend/modules/yantra/services/repo_context.yantra.service";
import { dropContradictoryExclusions } from "@backend/modules/yantra/services/spec_intake.yantra.service";
import { describe, expect, it } from "vitest";

/**
 * Both halves of the #145 post-mortem. Issue #145 was groomed, claimed, and
 * parked by advise inside forty seconds for exactly two reasons, quoted from
 * its verdict:
 *
 *   "Success criteria directly contradict the Out-of-scope list … this is an
 *    incoherent scope boundary, not a detail gap."
 *   "No file paths, table name, column name, or module location are given."
 *
 * A prompt rule alone can't fix either — a cheap groomer will still do it — so
 * the contradiction is stripped deterministically and the repo map is built
 * from real tree data. These tests hold both.
 */

describe("dropContradictoryExclusions", () => {
	it("removes an exclusion that negates a success criterion", () => {
		// The literal #145 failure.
		const criteria = [
			"Questions about the repo are answered in-thread with relevant information",
			"`yarn lint`, `yarn check-types` and `yarn test:run` pass",
		];
		const exclusions = [
			"Implementing the logic for answering questions about the repo",
		];

		expect(dropContradictoryExclusions(criteria, exclusions)).toEqual([]);
	});

	it("keeps an exclusion that genuinely narrows scope", () => {
		const criteria = [
			"Classification is stored on the chat message row",
			"`yarn lint`, `yarn check-types` and `yarn test:run` pass",
		];
		const exclusions = [
			"Backfilling classification for historical messages",
			"Localising the classifier into other languages",
		];

		expect(dropContradictoryExclusions(criteria, exclusions)).toEqual(
			exclusions,
		);
	});

	it("is not fooled by boilerplate shared between every spec", () => {
		// "lint", "tests", "pass" appear in every criterion; an exclusion that
		// merely reuses those words is not a contradiction.
		const criteria = [
			"`yarn lint`, `yarn check-types` and `yarn test:run` pass",
		];
		const exclusions = ["Adding new lint rules to the shared config"];

		expect(dropContradictoryExclusions(criteria, exclusions)).toEqual(
			exclusions,
		);
	});

	it("leaves an empty list alone", () => {
		expect(dropContradictoryExclusions(["anything"], [])).toEqual([]);
	});
});

describe("buildModuleMap", () => {
	it("censuses source directories instead of listing every file", () => {
		const map = buildModuleMap([
			"apps/backend/src/modules/yantra/services/a.ts",
			"apps/backend/src/modules/yantra/services/b.ts",
			"apps/backend/src/modules/yantra/services/c.ts",
			"apps/frontend/src/pages/Page.tsx",
		]);

		expect(map).toContain(
			"apps/backend/src/modules/yantra/services/ — 3 files",
		);
		expect(map).toContain("apps/frontend/src/pages/ — 1 file");
		// Individual filenames would crowd out the idea being groomed.
		expect(map).not.toContain("a.ts");
	});

	it("ignores dependencies and build output", () => {
		const map = buildModuleMap([
			"node_modules/pkg/index.ts",
			"dist/bundle.js",
			"coverage/report.js",
			"apps/backend/src/real.ts",
		]);

		expect(map).toBe("apps/backend/src/ — 1 file");
	});

	it("ignores non-source files", () => {
		const map = buildModuleMap(["README.md", "logo.png", "src/app.ts"]);

		expect(map).toBe("src/ — 1 file");
	});

	it("orders the busiest directories first", () => {
		const map = buildModuleMap([
			"small/one.ts",
			"big/a.ts",
			"big/b.ts",
			"big/c.ts",
		]);

		expect(map.split("\n")[0]).toBe("big/ — 3 files");
	});
});

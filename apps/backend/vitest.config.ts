/// <reference types="vitest" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Ratchet baseline: coverage must not drop below the committed numbers.
// Measured, not invented — regenerate by running `yarn test:coverage` and
// updating coverage.thresholds.json only when coverage genuinely improves.
const coverageThresholds = JSON.parse(
	readFileSync(resolve(__dirname, "coverage.thresholds.json"), "utf8"),
) as {
	statements: number;
	branches: number;
	functions: number;
	lines: number;
};

export default defineConfig({
	test: {
		environment: "node",
		// pool: 'threads',
		globals: true,
		setupFiles: ["./src/test/setup.ts"],
		// The global setup.ts beforeEach opens a DB transaction and creates a
		// logged-in user before EVERY test. Under coverage instrumentation on a
		// loaded CI runner (a single Postgres checkpoint has been observed taking
		// 110 s+), that DB work can exceed vitest's 10 s hook default and fail the
		// whole coverage job on pure infra slowness — not a real regression. Give
		// the DB hooks generous headroom so a slow-disk moment doesn't flake CI; a
		// genuine hang is still caught by the job-level timeout well above this.
		hookTimeout: 60_000,
		testTimeout: 30_000,
		include: ["src/**/*.{test,spec}.ts"],
		exclude: ["node_modules", "dist", "**/*.d.ts"],
		coverage: {
			reporter: ["text", "json", "html"],
			exclude: [
				"node_modules/",
				"dist/",
				"src/**/*.d.ts",
				"src/test/",
				"**/*.config.ts",
				"src/db/db_script.ts",
			],
			thresholds: coverageThresholds,
		},
	},
	resolve: {
		alias: {
			"@backend": resolve(__dirname, "src"),
		},
	},
});

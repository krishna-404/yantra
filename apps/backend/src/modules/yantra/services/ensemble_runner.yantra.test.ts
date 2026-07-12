import { buildEnsembleScript } from "@backend/modules/yantra/services/ensemble_runner.yantra.service";
import { describe, expect, it } from "vitest";

/**
 * The ensemble container script is the contract between the harness and the
 * OpenCode CLI: N candidates each solve the spec, a judge synthesises one
 * answer, and the synthesised diff must pass the full self-check gate before a
 * PR opens. These assertions pin that contract so a refactor can't silently
 * drop a stage (e.g. skip the self-check, or let the judge also be a candidate).
 */
describe("buildEnsembleScript", () => {
	const script = buildEnsembleScript();

	it("reads the model list and prompt from env-provided base64 payloads", () => {
		expect(script).toContain('echo "$PROMPT_B64" | base64 -d');
		expect(script).toContain('echo "$MODELS_B64" | base64 -d');
	});

	it("runs one candidate per model on its own branch", () => {
		expect(script).toContain("while IFS= read -r MODEL <&3");
		expect(script).toContain('git checkout -q -B "cand-$i"');
		expect(script).toContain(
			'opencode run "$(cat /workspace/prompt.md)" -m "$MODEL"',
		);
	});

	it("has the judge synthesise on the PR branch, not a candidate branch", () => {
		expect(script).toContain('git checkout -q -B "$BRANCH"');
		expect(script).toContain(
			'opencode run "$(cat /workspace/judge.md)" -m "$JUDGE_MODEL"',
		);
	});

	it("gates the synthesised diff on the full self-check before pushing", () => {
		expect(script).toContain(
			"yarn lint && yarn check-types && yarn knip && yarn test:db:setup && yarn test:run",
		);
		// self-check must precede push + PR
		expect(script.indexOf("selfcheck")).toBeLessThan(
			script.indexOf("git push"),
		);
		expect(script.indexOf("git push")).toBeLessThan(
			script.indexOf("gh pr create"),
		);
	});

	it("exits with the no-diff sentinel when the judge produced nothing", () => {
		expect(script).toContain('{ echo "NO_DIFF"; exit 21; }');
	});

	it("drives agents non-interactively", () => {
		expect(script).toContain("--dangerously-skip-permissions");
		expect(script).toContain("</dev/null");
	});
});

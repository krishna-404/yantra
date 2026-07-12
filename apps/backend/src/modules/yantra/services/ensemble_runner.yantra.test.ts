import { ensembleScripts } from "@backend/modules/yantra/services/ensemble_runner.yantra.service";
import { describe, expect, it } from "vitest";

/**
 * The ensemble runs candidates in parallel containers (each pushes its own
 * branch) and a judge that synthesises from those branches. These assertions
 * pin that two-phase contract so a refactor can't silently drop a stage (e.g.
 * skip the self-check, or have the judge open a PR without pushing).
 */
describe("ensemble candidate script", () => {
	const script = ensembleScripts.buildCandidateScript();

	it("solves the spec on its own candidate branch and pushes it, no PR", () => {
		expect(script).toContain('git checkout -q -B "$CAND_BRANCH"');
		expect(script).toContain(
			'opencode run "$(cat /workspace/prompt.md)" -m "$MODEL"',
		);
		expect(script).toContain('git push --quiet -u origin "$CAND_BRANCH"');
		expect(script).not.toContain("gh pr create");
	});

	it("exits with the no-diff sentinel when the model changed nothing", () => {
		expect(script).toContain('{ echo "NO_DIFF"; exit 21; }');
	});
});

describe("ensemble judge script", () => {
	const script = ensembleScripts.buildJudgeScript();

	it("gathers candidate diffs and synthesises on the PR branch", () => {
		expect(script).toContain("git fetch -q origin");
		expect(script).toContain('git checkout -q -B "$BRANCH"');
		expect(script).toContain(
			'opencode run "$(cat /workspace/judge.md)" -m "$JUDGE_MODEL"',
		);
	});

	it("gates the synthesised diff on the full self-check before pushing", () => {
		expect(script).toContain(
			"yarn lint && yarn check-types && yarn knip && yarn test:db:setup && yarn test:run",
		);
		expect(script.indexOf("selfcheck")).toBeLessThan(
			script.indexOf("git push"),
		);
		expect(script.indexOf("git push")).toBeLessThan(
			script.indexOf("gh pr create"),
		);
	});

	it("deletes the throwaway candidate branches", () => {
		expect(script).toContain("git push -q origin --delete");
	});

	it("drives agents non-interactively", () => {
		expect(script).toContain("--dangerously-skip-permissions");
		expect(script).toContain("</dev/null");
	});
});

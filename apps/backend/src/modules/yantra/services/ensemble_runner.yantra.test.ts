import {
	ensembleScripts,
	runEnsembleExecute,
} from "@backend/modules/yantra/services/ensemble_runner.yantra.service";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── mock the I/O the runner orchestrates so we can exercise the whole flow ──
const runYantraContainer = vi.fn();
const gh = vi.fn();
const recordRun = vi.fn();
const addIssueLabels = vi.fn();
const removeIssueLabel = vi.fn();
const commentOnIssue = vi.fn();

vi.mock(
	"@backend/modules/yantra/services/container_runner.yantra.service",
	() => ({ runYantraContainer: (o: unknown) => runYantraContainer(o) }),
);
vi.mock("@backend/modules/yantra/services/gh_client.yantra.service", () => ({
	gh: (...a: unknown[]) => gh(...a),
}));
vi.mock("@backend/modules/yantra/services/repo_files.yantra.service", () => ({
	fetchRepoFile: vi.fn().mockResolvedValue(null),
	parsePromptVersion: vi.fn().mockReturnValue(1),
}));
vi.mock("@backend/modules/yantra/services/turn_shared.yantra.service", () => ({
	getIssue: vi.fn().mockResolvedValue({
		number: 7,
		title: "Add tests",
		body: "### type\n\ntest",
		labels: [],
	}),
	issueField: vi.fn().mockReturnValue("test"),
	branchSlug: vi.fn().mockReturnValue("add-tests"),
	recordRun: (r: unknown) => recordRun(r),
	addIssueLabels: (...a: unknown[]) => addIssueLabels(...a),
	removeIssueLabel: (...a: unknown[]) => removeIssueLabel(...a),
	commentOnIssue: (...a: unknown[]) => commentOnIssue(...a),
}));

const baseInput = {
	repo: "krishna-404/yantra",
	baseBranch: "staging",
	ghToken: "t",
	nvidiaKey: "k",
	models: ["nvidia/a", "nvidia/b", "nvidia/c"],
	judge: "nvidia/j",
	issue: 7,
	turn: "01T",
	tier: "T1",
	adviseJson: {},
};

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

describe("runEnsembleExecute orchestration", () => {
	beforeEach(() => {
		runYantraContainer.mockReset();
		gh.mockReset();
		recordRun.mockReset().mockResolvedValue("run");
		addIssueLabels.mockReset().mockResolvedValue(undefined);
		removeIssueLabel.mockReset().mockResolvedValue(undefined);
		commentOnIssue.mockReset().mockResolvedValue(undefined);
	});

	const setContainer = (candExit: number, judgeExit: number) =>
		runYantraContainer.mockImplementation(
			async (o: { name: string }): Promise<{ exitCode: number }> => ({
				exitCode: o.name.startsWith("yantra-cand-") ? candExit : judgeExit,
			}),
		);

	it("runs one container per candidate PLUS a judge, then opens the PR", async () => {
		setContainer(0, 0);
		gh.mockResolvedValue([{ number: 42 }]);

		const out = await runEnsembleExecute(baseInput);

		expect(out.kind).toBe("pr_open");
		expect(out.pr).toBe(42);
		expect(out.candidatesSucceeded).toBe(3);
		// 3 candidate containers + 1 judge container
		expect(runYantraContainer).toHaveBeenCalledTimes(4);
		// telemetry: 3 candidates + 1 synthesis row
		expect(recordRun).toHaveBeenCalledTimes(4);
		expect(addIssueLabels).toHaveBeenCalledWith(
			baseInput.repo,
			7,
			["agent:pr-open"],
			"t",
		);
	});

	it("parks without running the judge when every candidate fails", async () => {
		setContainer(1, 0);

		const out = await runEnsembleExecute(baseInput);

		expect(out.kind).toBe("parked");
		expect(out.candidatesSucceeded).toBe(0);
		// 3 candidate containers only — the judge never runs
		expect(runYantraContainer).toHaveBeenCalledTimes(3);
		expect(addIssueLabels).toHaveBeenCalledWith(
			baseInput.repo,
			7,
			["needs-human"],
			"t",
		);
	});

	it("reports no_diff when the judge produced an empty diff", async () => {
		setContainer(0, 21);

		const out = await runEnsembleExecute(baseInput);

		expect(out.kind).toBe("no_diff");
		expect(runYantraContainer).toHaveBeenCalledTimes(4);
	});
});

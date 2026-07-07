import { db } from "@backend/db/db";
import { yantraLiveTurnTaskDef } from "@backend/events/events.schema";
import { tbus } from "@backend/events/tbus";
import { gh } from "@backend/modules/yantra/services/gh_client.yantra.service";
import { listEnabledProjectsWithTokens } from "@backend/modules/yantra/services/projects.yantra.service";
import {
	addIssueLabels,
	commentOnIssue,
	removeIssueLabel,
	routeModel,
} from "@backend/modules/yantra/services/turn_shared.yantra.service";
import {
	canClaim,
	STALE_CLAIM_MS,
} from "@backend/modules/yantra/state/state_machine.yantra";
import { logger } from "@backend/utils/logger.utils";
import { ulid } from "ulid";

/**
 * H4 (shadow mode) — the app's own tick, DECIDING but not ACTING.
 *
 * Every run reads live GitHub state for each enabled yantra_project (D23 —
 * credentials come from the project row, decrypted just-in-time; nothing in
 * env), runs the same §2.1 claim logic as ops/yantra/loop-tick.sh through the
 * H2 machine's canClaim, and records the decision it WOULD have made as a
 * yantra_telemetry row (role "shadow_tick", lane "shadow") tagged with the
 * project's repo + baseBranch. Zero writes to GitHub — the v0 loop keeps
 * flying while this builds the H9 parity record. Cutover flips shadow → live
 * by swapping the decision log for the H5 role runners.
 *
 * Known, documented divergences from v0 (compared at H9):
 * - R3 count comes from a GitHub search over recently-merged tier:T0 PRs,
 *   not v0's automerges.jsonl ledger on the VPS (≈ equal in practice).
 * - Claim age comes from the latest "🤖 yantra claim" comment, same as v0.
 */

interface GhIssue {
	number: number;
	body: string | null;
	labels: { name: string }[];
	pull_request?: unknown;
}

// ── pure decision core (unit-tested; no I/O) ────────────────────────────────

export interface ShadowWorkingIssue {
	number: number;
	claimAgeMs: number | null; // null = no claim comment found
	hasOpenPr: boolean;
}

export interface ShadowReadyIssue {
	number: number;
	openDeps: number[];
}

export interface ShadowInputs {
	killSwitchOn: boolean;
	working: ShadowWorkingIssue[];
	ready: ShadowReadyIssue[];
	automergesLastHour: number;
}

export interface ShadowDecision {
	/** Compact outcome string written to telemetry (≤40 chars by construction). */
	outcome: string;
	wouldClaim: number | null;
	wouldReap: number[];
}

export const decideShadowTick = (inputs: ShadowInputs): ShadowDecision => {
	// Reap detection mirrors loop-tick.sh: stale claim (≥2h) with no open PR.
	const wouldReap = inputs.working
		.filter(
			(w) =>
				!w.hasOpenPr && w.claimAgeMs !== null && w.claimAgeMs >= STALE_CLAIM_MS,
		)
		.map((w) => w.number);

	const claimable = inputs.ready.filter((r) => r.openDeps.length === 0);
	const decision = canClaim({
		killSwitchOn: inputs.killSwitchOn,
		workingCount: inputs.working.length,
		automergesLastHour: inputs.automergesLastHour,
		readySpecAvailable: claimable.length > 0,
	});

	if (!decision.ok) {
		return {
			outcome: `blocked_${decision.reason}`,
			wouldClaim: null,
			wouldReap,
		};
	}
	const target = claimable[0];
	if (!target) {
		return { outcome: "blocked_nothing_ready", wouldClaim: null, wouldReap };
	}
	return {
		outcome: `would_claim_#${target.number}`,
		wouldClaim: target.number,
		wouldReap,
	};
};

/** Parses the spec form's "### depends-on" field into issue numbers. */
export const parseDependsOn = (body: string | null): number[] => {
	if (!body) return [];
	const match = body.match(/###\s*depends-on\s*\n+(?!###)([^\n]*)/i);
	if (!match?.[1]) return [];
	return [...match[1].matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
};

// ── live gather (thin I/O shell around the pure core) ───────────────────────

const isoHourAgo = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

const gatherInputs = async (
	repo: string,
	token: string,
): Promise<ShadowInputs> => {
	// Kill switch fails CLOSED, exactly like lib.sh kill_switch_on.
	let killSwitchOn = true;
	try {
		const v = await gh<{ value: string }>(
			`/repos/${repo}/actions/variables/YANTRA_KILL`,
			token,
		);
		killSwitchOn = v.value === "true";
	} catch {
		killSwitchOn = true;
	}

	const [workingRaw, readyRaw] = await Promise.all([
		gh<GhIssue[]>(
			`/repos/${repo}/issues?labels=agent:working&state=open&per_page=100`,
			token,
		),
		gh<GhIssue[]>(
			`/repos/${repo}/issues?labels=spec:ready&state=open&per_page=100`,
			token,
		),
	]);
	const workingIssues = workingRaw.filter((i) => !i.pull_request);
	const readyIssues = readyRaw.filter(
		(i) =>
			!i.pull_request &&
			!i.labels.some(
				(l) => l.name === "yantra:exempt" || l.name === "agent:working",
			),
	);

	const working: ShadowWorkingIssue[] = await Promise.all(
		workingIssues.map(async (issue) => {
			let claimAgeMs: number | null = null;
			let hasOpenPr = false;
			try {
				const comments = await gh<{ body: string; created_at: string }[]>(
					`/repos/${repo}/issues/${issue.number}/comments?per_page=100`,
					token,
				);
				const claims = comments.filter((c) => c.body.includes("yantra claim"));
				const last = claims[claims.length - 1];
				if (last) claimAgeMs = Date.now() - new Date(last.created_at).getTime();
				const pr = await gh<{ total_count: number }>(
					`/search/issues?q=${encodeURIComponent(
						`repo:${repo} is:pr is:open "Closes #${issue.number}" in:body`,
					)}`,
					token,
				);
				hasOpenPr = pr.total_count > 0;
			} catch (err) {
				logger.warn(
					{ err, repo, issue: issue.number },
					"shadow tick: working-issue probe failed",
				);
			}
			return { number: issue.number, claimAgeMs, hasOpenPr };
		}),
	);

	const ready: ShadowReadyIssue[] = await Promise.all(
		readyIssues.map(async (issue) => {
			const deps = parseDependsOn(issue.body);
			const openDeps: number[] = [];
			for (const dep of deps) {
				try {
					const d = await gh<{ state: string }>(
						`/repos/${repo}/issues/${dep}`,
						token,
					);
					if (d.state === "open") openDeps.push(dep);
				} catch {
					// Unknown dep state blocks the claim — conservative, like v0.
					openDeps.push(dep);
				}
			}
			return { number: issue.number, openDeps };
		}),
	);

	let automergesLastHour = 0;
	try {
		const merged = await gh<{ total_count: number }>(
			`/search/issues?q=${encodeURIComponent(
				`repo:${repo} is:pr is:merged label:tier:T0 merged:>${isoHourAgo()}`,
			)}`,
			token,
		);
		automergesLastHour = merged.total_count;
	} catch {
		automergesLastHour = 0;
	}

	return { killSwitchOn, working, ready, automergesLastHour };
};

const recordDecision = async (
	project: { repo: string; baseBranch: string },
	decision: ShadowDecision,
	started: Date,
	lane: "shadow" | "live" = "shadow",
): Promise<void> => {
	const id = ulid();
	await db.yantraTelemetry.create({
		run: id,
		turn: id,
		repo: project.repo,
		baseBranch: project.baseBranch,
		issue: decision.wouldClaim ?? 0,
		role: lane === "live" ? "tick" : "shadow_tick",
		lane,
		model: "none",
		promptVersion: 1,
		tier: "",
		taskType:
			decision.wouldReap.length > 0
				? `would_reap:${decision.wouldReap.slice(0, 3).join(",")}`
				: "tick",
		startedAt: started,
		endedAt: new Date(),
		wallS: Math.round((Date.now() - started.getTime()) / 1000),
		outcome: decision.outcome.slice(0, 40),
		pr: 0,
		merged: false,
		autoMerged: false,
		reverted: false,
		tokensEst: 0,
		costUsd: 0,
	});
};

export interface ProjectShadowResult {
	repo: string;
	baseBranch: string;
	decision: ShadowDecision;
}

// ── live mode (H5): the same decision, ACTED on ─────────────────────────────

/**
 * v0's claim back-off: a claim comment counts as live ONLY if nothing
 * released it afterwards (parks/reaps post a release marker). Without this,
 * two orchestrators — or a park→re-ready cycle — would stall or double-claim.
 */
const hasLiveUnreleasedClaim = async (
	repo: string,
	issue: number,
	token: string,
): Promise<boolean> => {
	try {
		const comments = await gh<{ body: string; created_at: string }[]>(
			`/repos/${repo}/issues/${issue}/comments?per_page=100`,
			token,
		);
		const last = (pred: (b: string) => boolean) =>
			comments.filter((c) => pred(c.body)).at(-1)?.created_at ?? null;
		const lastClaim = last((b) => b.includes("yantra claim"));
		if (!lastClaim) return false;
		const lastRelease = last(
			(b) =>
				b.includes("parked") ||
				b.includes("yantra reap") ||
				b.includes("claim released"),
		);
		if (lastRelease && lastRelease >= lastClaim) return false;
		return Date.now() - new Date(lastClaim).getTime() < STALE_CLAIM_MS;
	} catch {
		return true; // unknown state blocks the claim — conservative
	}
};

const actOnLiveDecision = async (
	project: { id: string; repo: string; baseBranch: string; ghToken: string },
	decision: ShadowDecision,
): Promise<string> => {
	const { repo, ghToken } = project;

	for (const issue of decision.wouldReap) {
		await addIssueLabels(repo, issue, ["spec:ready"], ghToken).catch(() => {});
		await removeIssueLabel(repo, issue, "agent:working", ghToken);
		await commentOnIssue(
			repo,
			issue,
			"🤖 yantra reap: stale claim (>2 h, no PR) — released back to spec:ready.",
			ghToken,
		).catch(() => {});
		logger.warn({ repo, issue }, "yantra live tick: reaped stale claim");
	}

	if (decision.wouldClaim === null) return decision.outcome;
	const issue = decision.wouldClaim;

	if (await hasLiveUnreleasedClaim(repo, issue, ghToken)) {
		logger.warn({ repo, issue }, "yantra live tick: rival claim — backing off");
		return "backoff_live_claim";
	}

	const turn = ulid();
	await addIssueLabels(repo, issue, ["agent:working"], ghToken);
	await removeIssueLabel(repo, issue, "spec:ready", ghToken);
	await commentOnIssue(
		repo,
		issue,
		`🤖 yantra claim run=${turn} role=execute model=${routeModel("execute.T1")}`,
		ghToken,
	);
	await tbus.send(
		yantraLiveTurnTaskDef.from({ projectId: project.id, issue, turn }),
	);
	logger.info({ repo, issue, turn }, "yantra live tick: claimed, turn queued");
	return `claimed_#${issue}`;
};

/**
 * One shadow tick across every enabled project: gather → decide → record,
 * per project row. Never writes to GitHub. No projects ⇒ quiet no-op. One
 * project failing (revoked PAT, GitHub down) doesn't stop the others.
 */
export const runShadowTick = async (): Promise<ProjectShadowResult[]> => {
	const projects = await listEnabledProjectsWithTokens();
	if (projects.length === 0) return [];

	const results: ProjectShadowResult[] = [];
	for (const project of projects) {
		const started = new Date();
		try {
			const inputs = await gatherInputs(project.repo, project.ghToken);
			const decision = decideShadowTick(inputs);
			if (project.mode === "live") {
				const acted = await actOnLiveDecision(project, decision);
				await recordDecision(
					project,
					{ ...decision, outcome: acted },
					started,
					"live",
				);
			} else {
				await recordDecision(project, decision, started);
			}
			logger.info(
				{
					repo: project.repo,
					baseBranch: project.baseBranch,
					...decision,
					inputs: {
						...inputs,
						ready: inputs.ready.length,
						working: inputs.working.length,
					},
				},
				"yantra shadow tick",
			);
			results.push({
				repo: project.repo,
				baseBranch: project.baseBranch,
				decision,
			});
		} catch (err) {
			logger.error(
				{ err, repo: project.repo },
				"yantra shadow tick failed for project",
			);
		}
	}
	return results;
};

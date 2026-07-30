import { db } from "@backend/db/db";
import {
	gh,
	ghRequest,
} from "@backend/modules/yantra/services/gh_client.yantra.service";
import { ulid } from "ulid";

/**
 * Shared plumbing for the H5 role runners — straight ports of lib.sh helpers
 * (route_model, extract_json_block, issue_field, telemetry) so v1 behaves
 * byte-for-byte like v0 where behavior is observable (labels, comments,
 * branch names, telemetry fields).
 */

// routing.json as code — same table, one source (ops/routing.json retires
// with the VPS loop at H9).
const ROUTING: Record<string, { lane: string; model: string }> = {
	advise: { lane: "claude-max", model: "opus" },
	grade: { lane: "claude-max", model: "opus" },
	"execute.T0": { lane: "claude-max", model: "sonnet" },
	"execute.T1": { lane: "claude-max", model: "sonnet" },
	"execute.T2": { lane: "claude-max", model: "opus" },
	"execute.T3": { lane: "claude-max", model: "opus" },
	dream: { lane: "claude-max", model: "sonnet" },
};

export const routeModel = (roleKey: string): string =>
	ROUTING[roleKey]?.model ?? "sonnet";

/** Last valid ```json fenced block wins — port of lib.sh extract_json_block. */
export const extractJsonBlock = (raw: string): unknown | null => {
	const blocks = [...raw.matchAll(/^```json\s*$([\s\S]*?)^```\s*$/gm)];
	for (let i = blocks.length - 1; i >= 0; i--) {
		const body = blocks[i]?.[1];
		if (!body) continue;
		try {
			return JSON.parse(body);
		} catch {
			// keep scanning backwards
		}
	}
	return null;
};

/** Branch slug — port of execute.sh: lowercase, strip [spec], 40 chars. */
export const branchSlug = (title: string): string =>
	title
		.toLowerCase()
		.replace(/\[spec\]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);

/** Parses "### field\n\nvalue" issue-form output OR "field: value" lines. */
export const issueField = (body: string | null, field: string): string => {
	if (!body) return "";
	const lines = body.split("\n");
	const header = `### ${field}`;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]?.trim() === header) {
			for (let j = i + 1; j < lines.length; j++) {
				const line = lines[j] ?? "";
				if (line.startsWith("### ")) break;
				if (line.trim().length > 0) return line.trim();
			}
			break;
		}
	}
	const kv = lines.find((l) => l.startsWith(`${field}:`));
	return kv ? kv.slice(field.length + 1).trim() : "";
};

// ── GitHub issue plumbing ────────────────────────────────────────────────────

export interface IssueDetail {
	number: number;
	title: string;
	body: string | null;
	labels: { name: string }[];
}

export const getIssue = (
	repo: string,
	issue: number,
	token: string,
): Promise<IssueDetail> =>
	gh<IssueDetail>(`/repos/${repo}/issues/${issue}`, token);

export const addIssueLabels = (
	repo: string,
	issue: number,
	labels: string[],
	token: string,
): Promise<unknown> =>
	ghRequest("POST", `/repos/${repo}/issues/${issue}/labels`, token, { labels });

export const removeIssueLabel = async (
	repo: string,
	issue: number,
	label: string,
	token: string,
): Promise<void> => {
	try {
		await ghRequest(
			"DELETE",
			`/repos/${repo}/issues/${issue}/labels/${encodeURIComponent(label)}`,
			token,
		);
	} catch {
		// 404 = label wasn't there; that's the state we wanted.
	}
};

export const commentOnIssue = (
	repo: string,
	issue: number,
	body: string,
	token: string,
): Promise<unknown> =>
	ghRequest("POST", `/repos/${repo}/issues/${issue}/comments`, token, { body });

// ── telemetry (loop-protocol §5) ─────────────────────────────────────────────

export const recordRun = async (row: {
	repo: string;
	baseBranch: string;
	turn: string;
	issue: number;
	role: string;
	model: string;
	/** Provider lane for scoring (e.g. "claude-max", "nvidia", "ensemble"). */
	lane?: string;
	promptVersion: number;
	tier: string;
	taskType: string;
	startedAt: Date;
	outcome: string;
	pr?: number;
}): Promise<string> => {
	const run = ulid();
	await db.yantraTelemetry.create({
		run,
		turn: row.turn,
		repo: row.repo,
		baseBranch: row.baseBranch,
		issue: row.issue,
		role: row.role,
		lane: row.lane ?? "claude-max",
		model: row.model,
		promptVersion: row.promptVersion,
		tier: row.tier,
		taskType: row.taskType || "unknown",
		startedAt: row.startedAt,
		endedAt: new Date(),
		wallS: Math.round((Date.now() - row.startedAt.getTime()) / 1000),
		outcome: row.outcome.slice(0, 40),
		pr: row.pr ?? 0,
		merged: false,
		autoMerged: false,
		reverted: false,
		tokensEst: 0,
		costUsd: 0,
	});
	return run;
};

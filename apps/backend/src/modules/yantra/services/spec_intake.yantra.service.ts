import { freeComplete } from "@backend/modules/yantra/services/free_completion.yantra.service";
import { ghRequest } from "@backend/modules/yantra/services/gh_client.yantra.service";
import { extractJsonBlock } from "@backend/modules/yantra/services/turn_shared.yantra.service";

/**
 * Spec intake (Phase 4, chat-first) — the supply side of the factory. A rough
 * one-line idea (from the operator's chat, or the machine's dream role) is
 * groomed by a free model into a full spec in the exact issue-form shape the
 * harness claims, then — on human approval — filed as a `spec:ready` GitHub
 * issue the tick picks up. This is how "everything gets spec-ready with a human
 * in the loop" without the human hand-writing every spec.
 *
 * Grooming is pure text (no repo, no container), so it's a single free-model
 * call — fast and cheap. Approval is a deliberate second step: the draft is
 * shown, the operator edits/approves, and only then does an issue get created.
 */

const TIERS = ["T0", "T1", "T2", "T3"] as const;
export type Tier = (typeof TIERS)[number];

export interface SpecDraft {
	title: string;
	tier: Tier;
	/** Issue-form markdown body: type, problem, success criteria, out-of-scope. */
	body: string;
	/** Which free provider/model groomed it (shown in the chat, recorded later). */
	groomedBy: string;
}

const GROOM_SYSTEM = `You are Yantra's spec groomer. You turn a rough one-line idea into a precise, self-contained engineering spec that an autonomous coding agent can execute and a CI gate can verify.

Rules:
- Output ONE fenced json block and nothing else.
- The spec must be SMALL and focused. Prefer the smallest change that delivers the idea. If the idea is large, scope the json to a first slice and note the rest under out-of-scope.
- Success criteria MUST be concrete, checkable, and include that lint, type-check and tests pass. No vague criteria.
- Never weaken or delete tests as a success criterion.
- Estimate tier by blast radius: T0 = tiny/safe (tests, docs, one-line fix); T1 = small feature/refactor, no protected paths; T2 = larger feature; T3 = touches auth/secrets/migrations/CI/harness (human-merge).

json shape:
{
  "title": "[Spec] <imperative, <70 chars>",
  "tier": "T0|T1|T2|T3",
  "type": "feature|fix|test|docs|refactor|chore",
  "problem": "1-3 sentences: what and why",
  "success_criteria": ["checkable item", "lint + check-types + tests pass"],
  "out_of_scope": ["explicitly excluded"]
}`;

const isTier = (v: unknown): v is Tier =>
	typeof v === "string" && (TIERS as readonly string[]).includes(v);

/** Renders the groomed json into the issue-form markdown the harness parses. */
const renderBody = (spec: {
	type: string;
	problem: string;
	success_criteria: string[];
	out_of_scope: string[];
}): string => {
	// The CI gate is non-negotiable — guarantee it's a criterion even if the
	// groomer forgot it, so the harness always has a hard pass/fail line.
	const criteria = [...spec.success_criteria];
	if (!criteria.some((c) => /lint|check-types|test/i.test(c)))
		criteria.push("`yarn lint`, `yarn check-types` and `yarn test:run` pass");
	const crit = criteria.map((c) => `- [ ] ${c}`).join("\n");
	const oos = spec.out_of_scope.length
		? spec.out_of_scope.map((o) => `- ${o}`).join("\n")
		: "—";
	return [
		`### type\n\n${spec.type}`,
		`### depends-on\n\n—`,
		`## Problem\n\n${spec.problem}`,
		`## Success criteria\n\n${crit}`,
		`## Out of scope\n\n${oos}`,
		`## Context\n\nGroomed from an operator idea via Yantra spec-intake (Phase 4). Keep the change minimal and focused.`,
	].join("\n\n");
};

/**
 * Pure: turn a groomer's raw completion text into a spec draft. Tolerant of a
 * model that omits fields (fills safe defaults) but rejects one that gives no
 * usable title — an empty draft must never silently become a real issue.
 */
export const draftFromGroomText = (
	text: string,
	fallbackProblem: string,
	groomedBy: string,
): SpecDraft => {
	const parsed = extractJsonBlock(text) as Record<string, unknown> | null;
	if (!parsed || typeof parsed.title !== "string" || !parsed.title.trim())
		throw new Error("groomer did not return a usable spec (no json/title)");

	const tier = isTier(parsed.tier) ? parsed.tier : "T1";
	const body = renderBody({
		type: typeof parsed.type === "string" ? parsed.type : "chore",
		problem:
			typeof parsed.problem === "string" && parsed.problem.trim()
				? parsed.problem
				: fallbackProblem,
		success_criteria: Array.isArray(parsed.success_criteria)
			? parsed.success_criteria.filter(
					(c): c is string => typeof c === "string" && c.trim().length > 0,
				)
			: [],
		out_of_scope: Array.isArray(parsed.out_of_scope)
			? parsed.out_of_scope.filter((o): o is string => typeof o === "string")
			: [],
	});

	return { title: parsed.title.trim().slice(0, 120), tier, body, groomedBy };
};

/** Groom a rough idea into a spec draft. Does NOT create anything. */
export const groomIdea = async (idea: string): Promise<SpecDraft> => {
	const trimmed = idea.trim();
	if (trimmed.length < 4) throw new Error("idea is too short to groom");

	const result = await freeComplete({
		system: GROOM_SYSTEM,
		user: `Idea: ${trimmed}`,
		temperature: 0.2,
		maxTokens: 1200,
	});

	return draftFromGroomText(
		result.text,
		trimmed,
		`${result.provider}/${result.model}`,
	);
};

export interface CreatedSpec {
	issue: number;
	url: string;
}

/**
 * File an approved draft as a spec:ready issue. This is the human-in-the-loop
 * gate: only an explicit approve reaches here, and only here does the factory
 * gain a new claimable task.
 */
export const createReadySpec = async (input: {
	repo: string;
	ghToken: string;
	title: string;
	body: string;
	tier: Tier;
}): Promise<CreatedSpec> => {
	const created = await ghRequest<{ number: number; html_url: string }>(
		"POST",
		`/repos/${input.repo}/issues`,
		input.ghToken,
		{
			title: input.title,
			body: input.body,
			labels: ["spec:ready", `tier:${input.tier}`],
		},
	);
	return { issue: created.number, url: created.html_url };
};

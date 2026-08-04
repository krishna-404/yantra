import { freeComplete } from "@backend/modules/yantra/services/free_completion.yantra.service";
import {
	gh,
	ghRequest,
} from "@backend/modules/yantra/services/gh_client.yantra.service";
import { getRepoContext } from "@backend/modules/yantra/services/repo_context.yantra.service";
import { extractJsonBlock } from "@backend/modules/yantra/services/turn_shared.yantra.service";

/**
 * Spec intake (Phase 4, chat-first) — the supply side of the factory. A rough
 * one-line idea (from the operator's chat, or the machine's dream role) is
 * groomed by a free model into a full spec in the exact issue-form shape the
 * harness claims, then — on human approval — filed as a `spec:ready` GitHub
 * issue the tick picks up. This is how "everything gets spec-ready with a human
 * in the loop" without the human hand-writing every spec.
 *
 * Grooming reads the repo's shape but never checks it out: a directory map and
 * the house-rules docs, not a container. That was the missing ingredient — a
 * blind groomer cannot name the files a spec touches, and advise parks every
 * spec that names none (#145). Approval is still a deliberate second step: the
 * draft is shown, the operator edits/approves, and only then does an issue get
 * created.
 */

const TIERS = ["T0", "T1", "T2", "T3"] as const;
export type Tier = (typeof TIERS)[number];

export interface SpecDraft {
	title: string;
	tier: Tier;
	/** Issue-form markdown: type, problem, criteria, files expected, out-of-scope. */
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
- CRITICAL: out_of_scope must never exclude anything a success criterion requires. If a criterion says a behaviour must work, that behaviour is IN scope — do not also list it as excluded. A spec that contradicts itself is rejected by the review gate and wastes the run. When in doubt, cut the criterion rather than excluding what it demands.
- files_expected must name real paths taken from the REPO MAP below. Name the directory at minimum, the file where you can. Never invent a path that is not consistent with the map. If the map is empty, return an empty list rather than guessing.
- Estimate tier by blast radius: T0 = tiny/safe (tests, docs, one-line fix); T1 = small feature/refactor, no protected paths; T2 = larger feature; T3 = touches auth/secrets/migrations/CI/harness (human-merge).

json shape:
{
  "title": "[Spec] <imperative, <70 chars>",
  "tier": "T0|T1|T2|T3",
  "type": "feature|fix|test|docs|refactor|chore",
  "problem": "1-3 sentences: what and why",
  "success_criteria": ["checkable item", "lint + check-types + tests pass"],
  "files_expected": ["path/from/the/repo/map.ts"],
  "out_of_scope": ["explicitly excluded"]
}`;

const isTier = (v: unknown): v is Tier =>
	typeof v === "string" && (TIERS as readonly string[]).includes(v);

/**
 * Crude suffix stripper, not a linguistics engine. It exists so "answering",
 * "answered" and "answer" all compare equal — without it the #145 pair lands at
 * 0.60 overlap, just under the bar. The trailing-"e" strip is what keeps "ing"
 * forms aligned with their base: "creating" → "creat" would otherwise never
 * match "create".
 */
const stem = (w: string): string => {
	let s = w;
	if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
	else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
	else if (s.length > 4 && s.endsWith("s") && !s.endsWith("ss"))
		s = s.slice(0, -1);
	if (s.length > 4 && s.endsWith("e")) s = s.slice(0, -1);
	return s;
};

/** Stemmed. Words too common to mean two lines are about the same thing. */
const STOPWORDS = new Set(
	[
		// Grammar.
		"the",
		"and",
		"for",
		"with",
		"that",
		"this",
		"from",
		"into",
		"are",
		"not",
		"any",
		"all",
		"its",
		"must",
		"should",
		"will",
		"can",
		"when",
		"then",
		"than",
		"out",
		"scope",
		"each",
		"per",
		"via",
		// Spec boilerplate — every criterion carries these.
		"use",
		"using",
		"pass",
		"test",
		"lint",
		"type",
		"code",
		"logic",
		"yarn",
		// Generic implementation verbs. These are the important ones: "implementing
		// X" and "X" name the same behaviour, so counting the verb as a distinctive
		// word makes a real contradiction look like a partial match. #148 excluded
		// "Implementing the logic for answering repo questions" against a criterion
		// requiring exactly that, and scored 0.60 purely because "implement" and
		// "logic" padded the denominator.
		"add",
		"implement",
		"create",
		"modify",
		"integrate",
		"support",
		"handle",
		"build",
		"change",
		"update",
		"provide",
		"ensure",
		"introduce",
	].map(stem),
);

const meaningfulWords = (s: string): Set<string> =>
	new Set(
		s
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, " ")
			.split(/\s+/)
			.filter((w) => w.length > 3)
			.map(stem)
			.filter((w) => !STOPWORDS.has(w)),
	);

/**
 * Drop out-of-scope lines that exclude something a success criterion demands.
 *
 * This is the failure that killed #145: the groomer required "questions are
 * answered in-thread" and simultaneously excluded "the logic for answering
 * questions", and advise refused it — correctly — as "an incoherent scope
 * boundary, not a detail gap". The prompt now forbids it, but a cheap model
 * will still do it sometimes, so the contradiction is also removed here.
 *
 * Success criteria win: they are the contract the grader checks. An
 * out-of-scope line that negates one is noise at best and a blocked run at
 * worst. Exported for tests — this rule has to stay honest.
 */
export const dropContradictoryExclusions = (
	successCriteria: string[],
	outOfScope: string[],
): string[] => {
	const criteriaWords = successCriteria.map(meaningfulWords);
	return outOfScope.filter((line) => {
		const words = meaningfulWords(line);
		if (words.size === 0) return true;
		return !criteriaWords.some((crit) => {
			if (crit.size === 0) return false;
			let shared = 0;
			for (const w of words) if (crit.has(w)) shared++;
			// Two thirds of an exclusion's distinctive words also appearing in a
			// single criterion means they are about the same behaviour.
			return shared / words.size >= 0.66;
		});
	});
};

/** Renders the groomed json into the issue-form markdown the harness parses. */
const renderBody = (spec: {
	type: string;
	problem: string;
	success_criteria: string[];
	files_expected: string[];
	out_of_scope: string[];
}): string => {
	// The CI gate is non-negotiable — guarantee it's a criterion even if the
	// groomer forgot it, so the harness always has a hard pass/fail line.
	const criteria = [...spec.success_criteria];
	if (!criteria.some((c) => /lint|check-types|test/i.test(c)))
		criteria.push("`yarn lint`, `yarn check-types` and `yarn test:run` pass");
	const crit = criteria.map((c) => `- [ ] ${c}`).join("\n");
	const kept = dropContradictoryExclusions(criteria, spec.out_of_scope);
	const oos = kept.length ? kept.map((o) => `- ${o}`).join("\n") : "—";
	// advise asks "which files does this touch?" and parks the spec when it
	// can't tell. Answering it up front is the difference between a claimable
	// spec and one that burns an Opus turn to be rejected.
	const files = spec.files_expected.length
		? spec.files_expected.map((f) => `- \`${f}\``).join("\n")
		: "—";
	return [
		`### type\n\n${spec.type}`,
		`### depends-on\n\n—`,
		`## Problem\n\n${spec.problem}`,
		`## Success criteria\n\n${crit}`,
		`## Files expected\n\n${files}`,
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
		files_expected: Array.isArray(parsed.files_expected)
			? parsed.files_expected.filter(
					(f): f is string => typeof f === "string" && f.trim().length > 0,
				)
			: [],
		out_of_scope: Array.isArray(parsed.out_of_scope)
			? parsed.out_of_scope.filter((o): o is string => typeof o === "string")
			: [],
	});

	return { title: parsed.title.trim().slice(0, 120), tier, body, groomedBy };
};

/**
 * Groom a rough idea into a spec draft. Does NOT create anything.
 * `teamId` picks the team's own free-lane key when it has one (#138).
 */
export const groomIdea = async (
	idea: string,
	teamId: string | null = null,
	repo: { repo: string; branch: string; ghToken: string } | null = null,
): Promise<SpecDraft> => {
	const trimmed = idea.trim();
	if (trimmed.length < 4) throw new Error("idea is too short to groom");

	// Blind grooming still works — it just produces the kind of spec advise
	// parks. Any project that can hand us a token gets the map.
	const ctx = repo ? await getRepoContext(repo) : null;
	const user = [
		ctx?.moduleMap ? `REPO MAP (${repo?.repo})\n${ctx.moduleMap}` : "",
		ctx?.conventions ? `HOUSE RULES\n${ctx.conventions}` : "",
		`Idea: ${trimmed}`,
	]
		.filter(Boolean)
		.join("\n\n");

	const result = await freeComplete({
		system: GROOM_SYSTEM,
		user,
		temperature: 0.2,
		// The map and rules go in, so the budget has to cover a spec that names
		// real paths rather than one that hand-waves.
		maxTokens: 1600,
		teamId,
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
	/** True when this returned an issue that already existed. */
	alreadyExisted: boolean;
}

interface OpenIssue {
	number: number;
	title: string;
	html_url: string;
	pull_request?: unknown;
}

/**
 * An open issue with the same title is the same spec, not a second one.
 *
 * A persisted chat thread keeps every draft card it ever produced, so the same
 * groomed spec can be filed again by clicking an older card — "Classify Project
 * Chat Messages" reached GitHub four times in one afternoon as #145, #148, #150
 * and #151. Each duplicate is claimed and burns a full Opus advise turn before
 * anyone notices, and parking one leaves the others queued behind it.
 *
 * Exact title match only, and only against open issues: a spec whose work is
 * done and closed should be fileable again. Pure, so the rule is testable
 * without the network.
 */
export const findDuplicateSpec = (
	openIssues: OpenIssue[],
	title: string,
): OpenIssue | null => {
	const wanted = title.trim().toLowerCase();
	return (
		openIssues.find(
			(i) => !i.pull_request && i.title.trim().toLowerCase() === wanted,
		) ?? null
	);
};

/**
 * File an approved draft as a spec:ready issue. This is the human-in-the-loop
 * gate: only an explicit approve reaches here, and only here does the factory
 * gain a new claimable task.
 *
 * Idempotent by title: re-approving a spec that is already open returns the
 * existing issue rather than filing a twin.
 */
export const createReadySpec = async (input: {
	repo: string;
	ghToken: string;
	title: string;
	body: string;
	tier: Tier;
}): Promise<CreatedSpec> => {
	// Best-effort: if the lookup fails we would rather file a possible duplicate
	// than refuse to queue work at all.
	const existing = await gh<OpenIssue[]>(
		`/repos/${input.repo}/issues?state=open&per_page=100`,
		input.ghToken,
	)
		.then((issues) => findDuplicateSpec(issues, input.title))
		.catch(() => null);
	if (existing) {
		return {
			issue: existing.number,
			url: existing.html_url,
			alreadyExisted: true,
		};
	}

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
	return {
		issue: created.number,
		url: created.html_url,
		alreadyExisted: false,
	};
};

import { ghRequest } from "@backend/modules/yantra/services/gh_client.yantra.service";

/**
 * Reads harness files (prompt templates, .brain/*) straight from the
 * project's repo via the contents API. The deployed backend image is pruned
 * (no ops/, no .brain/), and fetching at run time keeps ONE source of truth:
 * a prompt edit merged to the base branch takes effect on the next run, no
 * redeploy. Cached briefly so one turn doesn't refetch the same template.
 */

const API = "https://api.github.com";
const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new Map<string, { at: number; text: string | null }>();

export const fetchRepoFile = async (
	repo: string,
	path: string,
	ref: string,
	token: string,
): Promise<string | null> => {
	const key = `${repo}@${ref}:${path}`;
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.text;

	let text: string | null = null;
	try {
		const res = await fetch(
			`${API}/repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
			{
				headers: {
					authorization: `Bearer ${token}`,
					accept: "application/vnd.github.raw+json",
					"x-github-api-version": "2022-11-28",
				},
			},
		);
		if (res.ok) text = await res.text();
	} catch {
		text = null;
	}
	cache.set(key, { at: Date.now(), text });
	return text;
};

/** prompt-version header, e.g. `<!-- prompt-version: 1 -->` → 1. */
export const parsePromptVersion = (template: string): number => {
	const m = template.match(/prompt-version:\s*(\d+)/);
	return m?.[1] ? Number(m[1]) : 1;
};

// Re-export for callers that need issue metadata alongside files.
export { ghRequest };

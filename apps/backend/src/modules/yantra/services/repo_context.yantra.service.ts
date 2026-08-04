import { gh } from "@backend/modules/yantra/services/gh_client.yantra.service";
import { logger } from "@backend/utils/logger.utils";

/**
 * Repo context for the groomer — the missing half of spec intake.
 *
 * Grooming used to be deliberately "pure text (no repo, no container)": cheap,
 * fast, and completely blind. The advise gate then rejected what it produced,
 * in its own words: "No file paths, table name, column name, or module location
 * are given... a cheap model would not know where the chat message row lives."
 * A spec that can't name what it touches isn't executable, so every draft died
 * at the gate and the queue drained to nothing.
 *
 * This gives the groomer just enough to write a real spec: the module map and
 * the house rules. Not the source — a directory-level map plus the conventions
 * and decisions docs, which is what a new engineer would read before writing a
 * ticket. Two or three GitHub calls, cached, versus a container.
 */

/** Long enough that a burst of grooming is one fetch; short enough to follow a merge. */
const CACHE_TTL_MS = 10 * 60 * 1000;

/** Docs that describe how this repo wants to be worked on, best-effort. */
const CONTEXT_DOCS = [
	"AGENTS.md",
	".brain/conventions.md",
	".brain/decisions.md",
] as const;

/** Per-doc cap: enough to carry the rules, not enough to blow a free model's window. */
const DOC_CHARS = 4_000;
/** Directories are what a spec needs to name; the full file list is noise. */
const MAX_MAP_ENTRIES = 120;

const SOURCE_RE = /\.(ts|tsx|js|jsx|py|go|rs|rb|java|kt|swift|php|cs)$/;
const IGNORED_RE =
	/(^|\/)(node_modules|dist|build|coverage|\.git|\.turbo|\.next|vendor)(\/|$)/;

interface RepoContext {
	/** Directory map: "path/ — n files" lines, deepest-meaningful first. */
	moduleMap: string;
	/** Concatenated house-rules docs, truncated. Empty when the repo has none. */
	conventions: string;
}

interface CacheEntry {
	at: number;
	value: RepoContext;
}

const cache = new Map<string, CacheEntry>();

interface TreeResponse {
	tree?: { path?: string; type?: string }[];
	truncated?: boolean;
}

/**
 * Collapse a file list into a directory census. "apps/backend/src/modules/
 * yantra/services/ — 23 files" tells a groomer where work lands; 400 individual
 * filenames just crowd out the idea.
 */
export const buildModuleMap = (paths: string[]): string => {
	const counts = new Map<string, number>();
	for (const p of paths) {
		if (IGNORED_RE.test(p) || !SOURCE_RE.test(p)) continue;
		const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".";
		counts.set(dir, (counts.get(dir) ?? 0) + 1);
	}
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, MAX_MAP_ENTRIES)
		.map(([dir, n]) => `${dir}/ — ${n} file${n === 1 ? "" : "s"}`)
		.join("\n");
};

const fetchDoc = async (
	repo: string,
	branch: string,
	path: string,
	token: string,
): Promise<string | null> => {
	try {
		const res = await gh<{ content?: string; encoding?: string }>(
			`/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
			token,
		);
		if (!res.content || res.encoding !== "base64") return null;
		return Buffer.from(res.content, "base64").toString("utf8");
	} catch {
		// A repo without conventions is normal, not an error worth failing over.
		return null;
	}
};

/**
 * Best-effort: a repo we can't read still grooms, just blindly — the same
 * behaviour as before this existed. Never throws.
 */
export const getRepoContext = async (input: {
	repo: string;
	branch: string;
	ghToken: string;
}): Promise<RepoContext> => {
	const key = `${input.repo}@${input.branch}`;
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

	const empty: RepoContext = { moduleMap: "", conventions: "" };
	try {
		const tree = await gh<TreeResponse>(
			`/repos/${input.repo}/git/trees/${encodeURIComponent(input.branch)}?recursive=1`,
			input.ghToken,
		);
		const paths = (tree.tree ?? [])
			.filter((n) => n.type === "blob" && typeof n.path === "string")
			.map((n) => n.path as string);

		const docs = await Promise.all(
			CONTEXT_DOCS.map(async (path) => {
				const body = await fetchDoc(
					input.repo,
					input.branch,
					path,
					input.ghToken,
				);
				return body ? `--- ${path} ---\n${body.slice(0, DOC_CHARS)}` : null;
			}),
		);

		const value: RepoContext = {
			moduleMap: buildModuleMap(paths),
			conventions: docs.filter((d): d is string => d !== null).join("\n\n"),
		};
		cache.set(key, { at: Date.now(), value });
		return value;
	} catch (err) {
		logger.warn(
			{ err, repo: input.repo },
			"repo context unavailable — grooming blind",
		);
		return empty;
	}
};

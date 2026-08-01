/**
 * Minimal GitHub REST client for the harness — token-per-call because
 * credentials are project-scoped (D23), never ambient. Shared by the shadow
 * tick and the H5 role runners; keep it dependency-free (plain fetch).
 *
 * Every call is bounded. `fetch` has no default request timeout, and these
 * calls run inside long-lived background loops that hold single-flight latches
 * — one connection that never answers is enough to stop grading (or a tick)
 * for the whole process, with nothing in the logs to say why. A request that
 * hangs past the ceiling is a failure, and failures are already handled.
 */

const API = "https://api.github.com";

/**
 * Generous enough that a slow-but-alive GitHub still succeeds, short enough
 * that a dead connection surfaces inside one tick interval.
 */
export const GH_TIMEOUT_MS = 30_000;

export class GhTimeoutError extends Error {
	constructor(method: string, path: string, timeoutMs: number) {
		super(`GitHub ${method} ${path} timed out after ${timeoutMs}ms`);
		this.name = "GhTimeoutError";
	}
}

export const ghRequest = async <T>(
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
	path: string,
	token: string,
	body?: unknown,
	timeoutMs: number = GH_TIMEOUT_MS,
): Promise<T> => {
	let res: Response;
	try {
		res = await fetch(`${API}${path}`, {
			method,
			headers: {
				authorization: `Bearer ${token}`,
				accept: "application/vnd.github+json",
				"x-github-api-version": "2022-11-28",
				...(body !== undefined ? { "content-type": "application/json" } : {}),
			},
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (err) {
		// Distinguish "GitHub is wedged" from "GitHub said no" — callers that
		// swallow errors otherwise report a timeout as an empty result.
		if (err instanceof Error && err.name === "TimeoutError") {
			throw new GhTimeoutError(method, path, timeoutMs);
		}
		throw err;
	}
	if (!res.ok) {
		throw new Error(`GitHub ${res.status} ${method} ${path}`);
	}
	// 204s (variable PATCH, label ops) have no body.
	if (res.status === 204) return undefined as T;
	return (await res.json()) as T;
};

export const gh = <T>(path: string, token: string): Promise<T> =>
	ghRequest<T>("GET", path, token);

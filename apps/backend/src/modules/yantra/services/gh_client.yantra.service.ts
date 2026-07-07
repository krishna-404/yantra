/**
 * Minimal GitHub REST client for the harness — token-per-call because
 * credentials are project-scoped (D23), never ambient. Shared by the shadow
 * tick and the H5 role runners; keep it dependency-free (plain fetch).
 */

const API = "https://api.github.com";

export const ghRequest = async <T>(
	method: "GET" | "POST" | "PATCH" | "DELETE",
	path: string,
	token: string,
	body?: unknown,
): Promise<T> => {
	const res = await fetch(`${API}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
			...(body !== undefined ? { "content-type": "application/json" } : {}),
		},
		body: body !== undefined ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		throw new Error(`GitHub ${res.status} ${method} ${path}`);
	}
	// 204s (variable PATCH, label ops) have no body.
	if (res.status === 204) return undefined as T;
	return (await res.json()) as T;
};

export const gh = <T>(path: string, token: string): Promise<T> =>
	ghRequest<T>("GET", path, token);

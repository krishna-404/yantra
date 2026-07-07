import { getDockerStatus } from "@backend/modules/yantra/services/docker_status.yantra.service";
import {
	gh,
	ghRequest,
} from "@backend/modules/yantra/services/gh_client.yantra.service";
import {
	linkedIssue,
	tierRank,
} from "@backend/modules/yantra/services/grade_runner.yantra.service";
import { fetchRepoFile } from "@backend/modules/yantra/services/repo_files.yantra.service";
import { afterEach, describe, expect, it, vi } from "vitest";

/** I/O-thin plumbing pinned with a stubbed fetch — no network, no docker. */

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
});

const stubFetch = (
	handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) => {
	globalThis.fetch = vi.fn(async (input: unknown, init?: unknown) =>
		handler(String(input), init as RequestInit),
	) as unknown as typeof fetch;
};

describe("ghRequest / gh", () => {
	it("sends the token + api headers and parses JSON", async () => {
		const seen = { url: "", auth: null as string | null };
		stubFetch((url, init) => {
			const headers = new Headers(init?.headers);
			seen.url = url;
			seen.auth = headers.get("authorization");
			return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
		});
		const out = await gh<{ ok: number }>("/repos/a/b/issues/1", "tok-123");
		expect(out.ok).toBe(1);
		expect(seen.url).toBe("https://api.github.com/repos/a/b/issues/1");
		expect(seen.auth).toBe("Bearer tok-123");
	});

	it("returns undefined for 204 and throws on non-ok", async () => {
		stubFetch(() => new Response(null, { status: 204 }));
		await expect(
			ghRequest("PATCH", "/repos/a/b/actions/variables/X", "t", { v: 1 }),
		).resolves.toBeUndefined();

		stubFetch(() => new Response("nope", { status: 403 }));
		await expect(gh("/repos/a/b", "t")).rejects.toThrow("GitHub 403");
	});
});

describe("fetchRepoFile", () => {
	it("returns raw text on 200 and null on 404, with per-key caching", async () => {
		let calls = 0;
		stubFetch(() => {
			calls++;
			return new Response("# prompt", { status: 200 });
		});
		const a = await fetchRepoFile("a/b", "ops/p.md", "staging", "t");
		const b = await fetchRepoFile("a/b", "ops/p.md", "staging", "t");
		expect(a).toBe("# prompt");
		expect(b).toBe("# prompt");
		expect(calls).toBe(1); // second hit served from cache

		stubFetch(() => new Response("missing", { status: 404 }));
		expect(await fetchRepoFile("a/b", "gone.md", "staging", "t")).toBeNull();
	});
});

describe("grade helpers", () => {
	it("tierRank orders tiers, unknown = T3", () => {
		expect(tierRank("T0")).toBe(0);
		expect(tierRank("T3")).toBe(3);
		expect(tierRank("weird")).toBe(3);
	});

	it("linkedIssue parses 'Closes #N' case-insensitively", () => {
		expect(linkedIssue("Fixes stuff\n\ncloses #41")).toBe(41);
		expect(linkedIssue("Closes #7 and more")).toBe(7);
		expect(linkedIssue("no link")).toBe(0);
		expect(linkedIssue(null)).toBe(0);
	});
});

describe("getDockerStatus", () => {
	it("fails soft when no docker socket exists (this sandbox)", async () => {
		const status = await getDockerStatus();
		// Structured result either way — never throws.
		expect(typeof status.reachable).toBe("boolean");
		if (!status.reachable) {
			expect(status.version).toBeNull();
			expect(status.execImagePresent).toBe(false);
			expect(status.error).toBeTruthy();
		}
	});
});

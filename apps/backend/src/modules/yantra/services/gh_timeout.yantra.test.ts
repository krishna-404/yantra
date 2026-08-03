import {
	GH_TIMEOUT_MS,
	GhTimeoutError,
	ghRequest,
} from "@backend/modules/yantra/services/gh_client.yantra.service";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Every GitHub call runs inside a background loop that holds a single-flight
 * latch. One unbounded request is enough to stop grading for the whole process,
 * so the bound itself is pinned here rather than trusted to `fetch`.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

describe("ghRequest timeouts", () => {
	it("passes an abort signal on every request", async () => {
		const spy = vi.fn(
			async (_url: string, _init?: RequestInit) =>
				new Response(JSON.stringify({ ok: true }), { status: 200 }),
		);
		globalThis.fetch = spy as unknown as typeof fetch;

		await ghRequest("GET", "/repos/a/b", "tok");

		expect(spy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
	});

	it("surfaces a hung request as GhTimeoutError, not a silent empty result", async () => {
		// A connection that never answers — the failure mode a plain `fetch` has
		// no opinion about.
		globalThis.fetch = ((_url: string, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					const err = new Error("The operation was aborted due to timeout");
					err.name = "TimeoutError";
					reject(err);
				});
			})) as unknown as typeof fetch;

		await expect(
			ghRequest("GET", "/repos/a/b", "tok", undefined, 10),
		).rejects.toBeInstanceOf(GhTimeoutError);
	});

	it("names the call in the timeout message so logs identify the wedge", async () => {
		globalThis.fetch = ((_url: string, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => {
					const err = new Error("aborted");
					err.name = "TimeoutError";
					reject(err);
				});
			})) as unknown as typeof fetch;

		await expect(
			ghRequest("PUT", "/repos/a/b/pulls/7/merge", "tok", {}, 10),
		).rejects.toThrow(
			/PUT \/repos\/a\/b\/pulls\/7\/merge timed out after 10ms/,
		);
	});

	it("leaves non-timeout failures alone", async () => {
		globalThis.fetch = (async () =>
			new Response("nope", { status: 422 })) as unknown as typeof fetch;

		const err = await ghRequest("GET", "/repos/a/b", "tok").catch((e) => e);
		expect(err).not.toBeInstanceOf(GhTimeoutError);
		expect(String(err)).toContain("GitHub 422");
	});

	it("keeps a default ceiling short enough to surface inside one tick", () => {
		// The live tick runs every few minutes; a request may not outlive it.
		expect(GH_TIMEOUT_MS).toBeGreaterThan(0);
		expect(GH_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
	});
});

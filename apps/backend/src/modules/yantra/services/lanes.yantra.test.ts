import { db } from "@backend/db/db";
import {
	getAppSecretValue,
	setAppSecret,
} from "@backend/modules/yantra/services/app_secrets.yantra.service";
import {
	LANES,
	listLanes,
	runLaneSmoke,
} from "@backend/modules/yantra/services/lanes.yantra.service";
import { afterEach, describe, expect, it, vi } from "vitest";

const realFetch = globalThis.fetch;
afterEach(async () => {
	globalThis.fetch = realFetch;
	vi.restoreAllMocks();
	await db.yantraAppSecrets
		.where({
			key: { in: ["NVIDIA_API_KEY", "GROQ_API_KEY", "GEMINI_API_KEY"] },
		})
		.delete();
});

describe("lane registry", () => {
	it("every lane maps to a real app-secret key and a models URL", () => {
		for (const lane of LANES) {
			expect(lane.id).toBeTruthy();
			expect(lane.secretKey).toMatch(/_API_KEY$/);
			expect(lane.modelsUrl).toMatch(/^https:\/\//);
			expect(["bearer", "query"]).toContain(lane.auth);
		}
	});
});

describe("runLaneSmoke", () => {
	it("reports no-key when the lane key isn't stored", async () => {
		const r = await runLaneSmoke("nvidia");
		expect(r.keyPresent).toBe(false);
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/no key/);
	});

	it("bearer lane: sends the key, counts models, picks a sample", async () => {
		await setAppSecret("NVIDIA_API_KEY", "nvapi-test-key-0000000000");
		let sentAuth: string | null = null;
		let sentUrl = "";
		globalThis.fetch = vi.fn(async (url: unknown, init?: unknown) => {
			sentUrl = String(url);
			sentAuth = new Headers((init as RequestInit)?.headers).get(
				"authorization",
			);
			return new Response(
				JSON.stringify({
					data: [{ id: "meta/llama-3.1-8b-instruct" }, { id: "x" }],
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;

		const r = await runLaneSmoke("nvidia");
		expect(sentUrl).toBe("https://integrate.api.nvidia.com/v1/models");
		expect(sentAuth).toBe("Bearer nvapi-test-key-0000000000");
		expect(r.ok).toBe(true);
		expect(r.modelCount).toBe(2);
		expect(r.sampleModel).toBe("meta/llama-3.1-8b-instruct");
	});

	it("query lane (Gemini): passes the key as ?key= and reads models[].name", async () => {
		await setAppSecret("GEMINI_API_KEY", "gemini-test-key-0000000000");
		let sentUrl = "";
		globalThis.fetch = vi.fn(async (url: unknown) => {
			sentUrl = String(url);
			return new Response(
				JSON.stringify({ models: [{ name: "models/gemini-1.5-flash" }] }),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;

		const r = await runLaneSmoke("gemini");
		expect(sentUrl).toContain("?key=gemini-test-key-0000000000");
		expect(r.ok).toBe(true);
		expect(r.sampleModel).toBe("models/gemini-1.5-flash");
	});

	it("surfaces a provider HTTP error without throwing", async () => {
		await setAppSecret("GROQ_API_KEY", "gsk-test-key-00000000000000");
		globalThis.fetch = vi.fn(
			async () => new Response("unauthorized", { status: 401 }),
		) as unknown as typeof fetch;
		const r = await runLaneSmoke("groq");
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/HTTP 401/);
	});

	it("throws only for an unknown lane id", async () => {
		await expect(runLaneSmoke("does-not-exist")).rejects.toThrow(
			"unknown lane",
		);
	});
});

describe("listLanes", () => {
	it("reports key presence per lane, never the key", async () => {
		await setAppSecret("GROQ_API_KEY", "gsk-present-000000000000");
		const lanes = await listLanes();
		expect(lanes.find((l) => l.id === "groq")?.keyPresent).toBe(true);
		expect(lanes.find((l) => l.id === "nvidia")?.keyPresent).toBe(false);
		expect(JSON.stringify(lanes)).not.toContain("gsk-present");
		// sanity: the internal reader still returns the raw value
		expect(await getAppSecretValue("GROQ_API_KEY")).toBe(
			"gsk-present-000000000000",
		);
	});
});

import { setAppSecret } from "@backend/modules/yantra/services/app_secrets.yantra.service";
import { resolveFreeProviders } from "@backend/modules/yantra/services/lanes.yantra.service";
import { describe, expect, it } from "vitest";

/**
 * resolveFreeProviders reads the stored app-secrets and reports which free
 * providers are usable right now — the keys to inject into a run container and
 * the sources to draw ensemble candidates from. Groq comes first (fastest, and
 * the catalog lists it first). DB-backed; each test runs in a rolled-back tx.
 */
describe("resolveFreeProviders", () => {
	it("reports nothing when no provider key is set", async () => {
		const { providerKeys, sources } = await resolveFreeProviders();
		expect(sources).toEqual([]);
		expect(providerKeys).toEqual({});
	});

	it("includes Groq first, then NVIDIA, with their decrypted keys", async () => {
		await setAppSecret("NVIDIA_API_KEY", "nvapi-test-abcd1234");
		await setAppSecret("GROQ_API_KEY", "gsk_test_abcd1234");

		const { providerKeys, sources } = await resolveFreeProviders();

		expect(sources).toEqual(["groq", "nvidia"]);
		expect(providerKeys.GROQ_API_KEY).toBe("gsk_test_abcd1234");
		expect(providerKeys.NVIDIA_API_KEY).toBe("nvapi-test-abcd1234");
	});

	it("reports only the providers whose key is present", async () => {
		await setAppSecret("GROQ_API_KEY", "gsk_only_abcd1234");

		const { providerKeys, sources } = await resolveFreeProviders();

		expect(sources).toEqual(["groq"]);
		expect(providerKeys).toEqual({ GROQ_API_KEY: "gsk_only_abcd1234" });
	});
});

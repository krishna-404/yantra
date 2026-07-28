import { describe, expect, it } from "vitest";
import {
	generateApiKey,
	hashApiKey,
	verifyApiKey,
} from "./apiKeyGenerator.utils";

describe("generateApiKey", () => {
	it("returns a string starting with sk_live_", () => {
		const key = generateApiKey();
		expect(key.startsWith("sk_live_")).toBe(true);
	});

	it("returns a 32 char random portion after the prefix", () => {
		const key = generateApiKey();
		expect(key.slice("sk_live_".length)).toHaveLength(32);
	});

	it("returns a different key on each call", () => {
		const first = generateApiKey();
		const second = generateApiKey();
		expect(first).not.toBe(second);
	});
});

describe("hashApiKey", () => {
	it("returns a salt:hash string with both parts hex encoded", async () => {
		const hash = await hashApiKey("sk_live_test-key");
		const parts = hash.split(":");
		expect(parts).toHaveLength(2);
		const [salt, derivedHash] = parts;
		expect(salt).toMatch(/^[0-9a-f]+$/);
		expect(derivedHash).toMatch(/^[0-9a-f]+$/);
	});

	it("returns a different hash for the same key on each call", async () => {
		const key = "sk_live_test-key";
		const first = await hashApiKey(key);
		const second = await hashApiKey(key);
		expect(first).not.toBe(second);
	});
});

describe("verifyApiKey", () => {
	it("returns true for a key against its own hash", async () => {
		const key = "sk_live_test-key";
		const hash = await hashApiKey(key);
		await expect(verifyApiKey(key, hash)).resolves.toBe(true);
	});

	it("returns false for a wrong key", async () => {
		const hash = await hashApiKey("sk_live_test-key");
		await expect(verifyApiKey("sk_live_wrong-key", hash)).resolves.toBe(false);
	});

	it("returns false for a malformed hash missing a colon", async () => {
		await expect(
			verifyApiKey("sk_live_test-key", "not-a-valid-hash"),
		).resolves.toBe(false);
	});
});

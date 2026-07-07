import {
	openSecret,
	sealSecret,
} from "@backend/modules/yantra/services/secret_box.yantra.service";
import { describe, expect, it } from "vitest";

describe("yantra secret box", () => {
	it("round-trips a PAT-shaped secret", () => {
		const token = "ghp_1234567890abcdefghijklmnopqrstuvwxYZ";
		const sealed = sealSecret(token);
		expect(sealed.startsWith("v1:")).toBe(true);
		expect(sealed).not.toContain(token);
		expect(openSecret(sealed)).toBe(token);
	});

	it("uses a fresh IV every seal (same plaintext ⇒ different ciphertext)", () => {
		expect(sealSecret("same")).not.toBe(sealSecret("same"));
	});

	it("round-trips unicode and empty-ish strings", () => {
		for (const s of ["", " ", "प्रोजेक्ट-token-🔐"]) {
			expect(openSecret(sealSecret(s))).toBe(s);
		}
	});

	it("rejects tampered ciphertext (GCM auth)", () => {
		const sealed = sealSecret("secret");
		const raw = Buffer.from(sealed.slice(3), "base64");
		raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 0xff;
		expect(() => openSecret(`v1:${raw.toString("base64")}`)).toThrow();
	});

	it("rejects unknown versions and truncated payloads", () => {
		expect(() => openSecret("v2:abcd")).toThrow("unknown payload version");
		expect(() => openSecret("v1:AAAA")).toThrow("payload too short");
	});
});

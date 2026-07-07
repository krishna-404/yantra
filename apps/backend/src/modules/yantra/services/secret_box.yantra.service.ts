import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	scryptSync,
} from "node:crypto";
import { env } from "@backend/configs/env.config";

/**
 * Small AES-256-GCM box for project-scoped secrets (D23): GitHub PATs live in
 * yantra_projects encrypted at rest, keyed off the server's existing
 * BETTER_AUTH_SECRET — no new env var, and a DB dump alone can't leak tokens.
 *
 * Payload format: base64(iv[12] ‖ authTag[16] ‖ ciphertext), versioned with a
 * "v1:" prefix so a future key rotation / algorithm change can coexist.
 */

const VERSION = "v1:";
const IV_BYTES = 12;
const TAG_BYTES = 16;

// scrypt is deliberately slow; derive once per process, not per call.
let cachedKey: Buffer | null = null;
const key = (): Buffer => {
	if (!cachedKey) {
		cachedKey = scryptSync(env.BETTER_AUTH_SECRET, "yantra-secret-box", 32);
	}
	return cachedKey;
};

export const sealSecret = (plaintext: string): string => {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key(), iv);
	const encrypted = Buffer.concat([
		cipher.update(plaintext, "utf8"),
		cipher.final(),
	]);
	const packed = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
	return `${VERSION}${packed.toString("base64")}`;
};

export const openSecret = (sealed: string): string => {
	if (!sealed.startsWith(VERSION)) {
		throw new Error("secret box: unknown payload version");
	}
	const packed = Buffer.from(sealed.slice(VERSION.length), "base64");
	// Zero-length ciphertext is valid GCM (empty plaintext still carries a tag).
	if (packed.length < IV_BYTES + TAG_BYTES) {
		throw new Error("secret box: payload too short");
	}
	const iv = packed.subarray(0, IV_BYTES);
	const tag = packed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
	const ciphertext = packed.subarray(IV_BYTES + TAG_BYTES);
	const decipher = createDecipheriv("aes-256-gcm", key(), iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([
		decipher.update(ciphertext),
		decipher.final(),
	]).toString("utf8");
};

import { db } from "@backend/db/db";
import {
	openSecret,
	sealSecret,
} from "@backend/modules/yantra/services/secret_box.yantra.service";

/**
 * App-level secrets for the harness (encrypted at rest, write-only API).
 * Keys are a closed set — each one exists because a runner needs it, not as
 * a general vault. CLAUDE_CODE_OAUTH_TOKEN feeds the execute/advise/grade
 * containers; the *_API_KEY entries feed the Phase-3 free-lane runner
 * (OpenCode container) so cheaper models can do T0/T1 work.
 */

export const APP_SECRET_KEYS = [
	"CLAUDE_CODE_OAUTH_TOKEN",
	"NVIDIA_API_KEY",
	"GEMINI_API_KEY",
	"GROQ_API_KEY",
	// OpenCode Zen — the CLI's own hosted free models (opencode/*), auth'd via
	// this key (from https://opencode.ai/auth). Read by opencode automatically.
	"OPENCODE_API_KEY",
] as const;
export type AppSecretKey = (typeof APP_SECRET_KEYS)[number];

export interface AppSecretView {
	key: string;
	valueHint: string;
	updatedAt: number;
}

export const setAppSecret = async (
	key: AppSecretKey,
	value: string,
): Promise<void> => {
	const v = value.trim();
	if (v.length < 8) throw new Error("secret value looks too short");
	const data = {
		valueCiphertext: sealSecret(v),
		valueHint: v.slice(-4),
	};
	const existing = await db.yantraAppSecrets.findByOptional({ key });
	if (existing) {
		await db.yantraAppSecrets.findBy({ key }).update(data);
	} else {
		await db.yantraAppSecrets.create({ key, ...data });
	}
};

export const listAppSecrets = async (): Promise<AppSecretView[]> => {
	const rows = await db.yantraAppSecrets
		.select("key", "valueHint", "updatedAt")
		.order({ key: "ASC" });
	return rows;
};

/** Internal only — feeds the runners. Never expose through the API. */
export const getAppSecretValue = async (
	key: AppSecretKey,
): Promise<string | null> => {
	const row = await db.yantraAppSecrets.findByOptional({ key });
	return row ? openSecret(row.valueCiphertext) : null;
};

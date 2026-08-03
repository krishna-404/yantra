import { db } from "@backend/db/db";
import {
	openSecret,
	sealSecret,
} from "@backend/modules/yantra/services/secret_box.yantra.service";

/**
 * Provider secrets for the harness (encrypted at rest, write-only API).
 * Keys are a closed set — each one exists because a runner needs it, not as
 * a general vault. CLAUDE_CODE_OAUTH_TOKEN feeds the execute/advise/grade
 * containers; the *_API_KEY entries feed the Phase-3 free-lane runner
 * (OpenCode container) so cheaper models can do T0/T1 work.
 *
 * Scoping (#138): every read resolves "this team's key, else the installation
 * key". A team that hasn't set its own inherits the operator's, so nothing has
 * to be configured twice; a team that sets one is insulated from every other
 * team's rotations. `teamId = null` is the installation row.
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

/**
 * Which scope a stored key belongs to. Runners pass the owning team; operator
 * tooling passes nothing and works on the installation row.
 */
export type SecretScope = string | null;

export interface AppSecretView {
	key: string;
	valueHint: string;
	updatedAt: number;
	/** False when this row is the installation fallback, not the team's own. */
	teamOwned: boolean;
}

export const setAppSecret = async (
	key: AppSecretKey,
	value: string,
	teamId: SecretScope = null,
): Promise<void> => {
	const v = value.trim();
	if (v.length < 8) throw new Error("secret value looks too short");
	const data = {
		valueCiphertext: sealSecret(v),
		valueHint: v.slice(-4),
	};
	const existing = await db.yantraAppSecrets
		.where({ key, teamId })
		.takeOptional();
	if (existing) {
		await db.yantraAppSecrets.findBy({ id: existing.id }).update(data);
	} else {
		await db.yantraAppSecrets.create({ key, teamId, ...data });
	}
};

/** Drops a team's override so it falls back to the installation key again. */
export const clearTeamSecret = async (
	key: AppSecretKey,
	teamId: string,
): Promise<void> => {
	await db.yantraAppSecrets.where({ key, teamId }).delete();
};

/**
 * What's set for a team, with the installation key standing in wherever the
 * team hasn't overridden — the same resolution the runners use, so the UI shows
 * what a run would actually pick up rather than merely what's stored.
 */
export const listAppSecrets = async (
	teamId: SecretScope = null,
): Promise<AppSecretView[]> => {
	const installation = await db.yantraAppSecrets
		.where({ teamId: null })
		.select("key", "valueHint", "updatedAt")
		.order({ key: "ASC" });

	if (teamId === null) {
		return installation.map((r) => ({ ...r, teamOwned: false }));
	}

	const owned = await db.yantraAppSecrets
		.where({ teamId })
		.select("key", "valueHint", "updatedAt")
		.order({ key: "ASC" });

	const byKey = new Map<string, AppSecretView>();
	for (const r of installation) byKey.set(r.key, { ...r, teamOwned: false });
	for (const r of owned) byKey.set(r.key, { ...r, teamOwned: true });
	return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
};

/**
 * Internal only — feeds the runners. Never expose through the API.
 * Resolves the team's key first and falls back to the installation key, so a
 * team with no override still runs on the operator's credentials.
 */
export const getAppSecretValue = async (
	key: AppSecretKey,
	teamId: SecretScope = null,
): Promise<string | null> => {
	if (teamId !== null) {
		const owned = await db.yantraAppSecrets
			.where({ key, teamId })
			.takeOptional();
		if (owned) return openSecret(owned.valueCiphertext);
	}
	const shared = await db.yantraAppSecrets
		.where({ key, teamId: null })
		.takeOptional();
	return shared ? openSecret(shared.valueCiphertext) : null;
};

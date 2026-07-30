import { change } from "../db_script";

/**
 * yantra_projects (D23) — project-scoped harness credentials. Each row is a
 * repo + base branch the harness works on, with its GitHub PAT encrypted at
 * rest (AES-256-GCM via the secret-box service). Tenant-zero is added through
 * the cockpit; nothing lives in server env.
 *
 * NOTE: the generator also re-proposed its recurring index-naming churn on the
 * sync-infra tables (files/push_devices/team_members/teams_app) — trimmed here
 * exactly as in 0008/0009; D16 forbids touching sync infra.
 */
change(async (db) => {
	await db.createTable(
		"yantra_projects",
		(t) => ({
			id: t.string(26).primaryKey(),
			repo: t.string(),
			baseBranch: t.string().default("staging"),
			ghTokenCiphertext: t.text(),
			ghTokenHint: t.string(4).default(""),
			enabled: t.boolean().default(true),
			createdAt: t.timestamp().default(t.sql`clock_timestamp()`),
			updatedAt: t.timestamp().default(t.sql`clock_timestamp()`),
		}),
		(t) => t.unique(["repo", "baseBranch"]),
	);
});

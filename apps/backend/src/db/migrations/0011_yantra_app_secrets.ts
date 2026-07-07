import { change } from "../db_script";

/**
 * yantra_app_secrets (D23/D24) — app-level harness credentials (e.g. the
 * Claude OAuth token for execute containers), encrypted at rest by the
 * secret-box service. Generator's recurring sync-infra index churn trimmed
 * exactly as in 0008/0009/0010 (D16 forbids touching sync infra).
 */
change(async (db) => {
	await db.createTable("yantra_app_secrets", (t) => ({
		id: t.string(26).primaryKey(),
		key: t.string(100).unique(),
		valueCiphertext: t.text(),
		valueHint: t.string(4).default(""),
		createdAt: t.timestamp().default(t.sql`clock_timestamp()`),
		updatedAt: t.timestamp().default(t.sql`clock_timestamp()`),
	}));
});

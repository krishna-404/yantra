import { change } from "../db_script";

/**
 * Provider keys per team (#138).
 *
 * `yantra_app_secrets` was keyed on `key` alone, so the Claude token and the
 * free-lane API keys belonged to the whole installation. With one team that is
 * invisible; with two, one team's rotation silently changes what every other
 * team runs on.
 *
 * `team_id IS NULL` stays the installation-level fallback, so every existing
 * row keeps working untouched and a team that hasn't set its own key inherits
 * the operator's. Resolution is `team key ?? installation key`.
 *
 * Two partial unique indexes rather than one on (team_id, key): Postgres treats
 * NULLs as distinct, so a plain composite unique would happily accept two
 * installation-level rows for the same key — exactly the ambiguity this is
 * meant to remove.
 */
change(async (db) => {
	await db.changeTable("yantra_app_secrets", (t) => ({
		teamId: t.add(
			t
				.string(26)
				.foreignKey("teams_app", "id", {
					onUpdate: "RESTRICT",
					onDelete: "CASCADE",
				})
				.nullable(),
		),
		key: t.change(t.string(100).unique(), t.string(100)),
	}));

	await db.addIndex("yantra_app_secrets", ["teamId", "key"], {
		name: "yantra_app_secrets_team_key_idx",
		unique: true,
		where: "team_id IS NOT NULL",
	});
	await db.addIndex("yantra_app_secrets", ["key"], {
		name: "yantra_app_secrets_installation_key_idx",
		unique: true,
		where: "team_id IS NULL",
	});
});

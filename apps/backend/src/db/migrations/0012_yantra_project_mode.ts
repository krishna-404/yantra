import { change } from "../db_script";

/**
 * yantra_projects.mode (H5) — "shadow" (decide + record) vs "live" (claim,
 * spawn containers, open PRs). The per-project H9 cutover lever. Generator's
 * recurring sync-infra index churn trimmed as in 0008–0011 (D16).
 */
change(async (db) => {
	await db.changeTable("yantra_projects", (t) => ({
		mode: t.add(t.varchar(10).default("shadow")),
	}));
});

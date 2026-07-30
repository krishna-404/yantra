import { change } from "../db_script";

/**
 * yantra_projects.autoMergeToMain — per-project autonomy toggle. When true,
 * yantra may merge a passing feature branch to main (prod) on its own; when
 * false (default), the feature→main merge waits for a human click in the yantra
 * UI. Set per project so trusted projects go hands-off while others keep a gate.
 *
 * Separate from 0013 so it applies cleanly on environments where 0013 already
 * ran (the staging force-push preview) — migrations are append-only once shipped.
 */
change(async (db) => {
	await db.changeTable("yantra_projects", (t) => ({
		autoMergeToMain: t.add(t.boolean().default(false)),
	}));
});

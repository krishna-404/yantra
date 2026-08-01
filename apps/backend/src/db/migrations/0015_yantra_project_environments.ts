import { change } from "../db_script";

/**
 * Per-project environments (#24). A project has TWO environments, not one base
 * branch: every feature branch is checked on staging, then promoted to prod.
 *
 * - productionBranch: the merge target when promoting (default "main").
 * - productionUrl / stagingUrl: where each environment is served, so the system
 *   can health-check a deploy after it lands.
 *
 * `baseBranch` is intentionally KEPT and now means "the staging branch" — the
 * execute/grade/tick services already thread it as the branch work is based on
 * and checked against, so this is a widening rather than a risky rename.
 * `autoMergeToMain` (0014) is the per-project auto-promote toggle.
 */
change(async (db) => {
	await db.changeTable("yantra_projects", (t) => ({
		productionBranch: t.add(t.varchar(255).default("main")),
		productionUrl: t.add(t.varchar(500).default("")),
		stagingUrl: t.add(t.varchar(500).default("")),
	}));
});

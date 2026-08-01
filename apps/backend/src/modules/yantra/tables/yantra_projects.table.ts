import { BaseTable } from "@backend/db/base_table";

/**
 * A project the harness works on: a repo + base branch + the credentials the
 * workers use there (D21/D23). Tenant-zero is krishna-404/yantra @ staging,
 * added through the cockpit like any future project — secrets live HERE,
 * scoped to the project, never in the server's env.
 *
 * ghTokenCiphertext is AES-256-GCM sealed by the secret-box service (key
 * derived from BETTER_AUTH_SECRET); the API layer only ever returns the
 * last-4 hint. Phase-4 multi-tenant adds a teamId column — a widening,
 * not a rewrite.
 */
export class YantraProjectTable extends BaseTable {
	readonly table = "yantra_projects";

	columns = this.setColumns(
		(t) => ({
			id: t.ulidWithDefault().primaryKey(),
			// Multi-tenant (Phase 4): the team that owns this project. Every member
			// of the team can see/manage it and its routines. Nullable so the
			// original single-operator tenant-zero row stays valid; team-scoped
			// projects set it, super-admin-only projects leave it null.
			teamId: t
				.ulid()
				.foreignKey("teams_app", "id", {
					onUpdate: "RESTRICT",
					onDelete: "CASCADE",
				})
				.nullable(),
			repo: t.string(255),
			// The STAGING branch — every feature branch is force-pushed here and
			// checked on stagingUrl before promotion. (Named baseBranch for history:
			// the execute/grade/tick services thread it as the branch work is based
			// on; #24 widened the model rather than renaming it.)
			baseBranch: t.string(255).default("staging"),
			// The promotion target — where verified work ships (prod).
			productionBranch: t.string(255).default("main"),
			// Where each environment is served, so deploys can be health-checked.
			productionUrl: t.string(500).default(""),
			stagingUrl: t.string(500).default(""),
			ghTokenCiphertext: t.text(),
			// Last 4 chars of the PAT, for "ghp_…abcd" hints in the UI.
			ghTokenHint: t.string(4).default(""),
			enabled: t.boolean().default(true),
			// "shadow" = decide + record only. "live" = act (claim, spawn advise/
			// execute containers, open PRs). The H9 cutover lever, per project.
			mode: t.string(10).default("shadow"),
			// Per-project autonomy: may yantra merge a passing feature branch to
			// main (prod) on its own, or must a human click merge in the yantra UI?
			// Default false — a project goes straight to prod only when the team
			// opts in. The grade/merge path checks this before any merge to main.
			autoMergeToMain: t.boolean().default(false),
			...t.timestampsAsNumbers(),
		}),
		(t) => t.unique(["repo", "baseBranch"]),
	);
}

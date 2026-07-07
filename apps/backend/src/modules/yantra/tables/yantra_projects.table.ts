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
			repo: t.string(255),
			baseBranch: t.string(255).default("staging"),
			ghTokenCiphertext: t.text(),
			// Last 4 chars of the PAT, for "ghp_…abcd" hints in the UI.
			ghTokenHint: t.string(4).default(""),
			enabled: t.boolean().default(true),
			...t.timestampsAsNumbers(),
		}),
		(t) => t.unique(["repo", "baseBranch"]),
	);
}

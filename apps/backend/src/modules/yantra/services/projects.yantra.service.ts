import { db } from "@backend/db/db";
import {
	openSecret,
	sealSecret,
} from "@backend/modules/yantra/services/secret_box.yantra.service";

/**
 * Yantra projects (D23) — a project is a repo + base branch the harness works
 * on, with its GitHub credentials stored HERE, encrypted, scoped to the
 * project. Tenant-zero (krishna-404/yantra @ staging) is added through the
 * cockpit like any future project will be; the server env carries no harness
 * tokens at all.
 *
 * The plaintext token exists in exactly two places: the create/rotate input
 * (transient) and `listEnabledProjectsWithTokens` (consumed by the tick,
 * never serialized). Everything user-facing gets the last-4 hint only.
 */

export interface YantraProjectView {
	id: string;
	repo: string;
	baseBranch: string;
	enabled: boolean;
	ghTokenHint: string;
	mode: string;
	createdAt: number;
}

const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

export const addProject = async (input: {
	repo: string;
	baseBranch: string;
	ghToken: string;
}): Promise<YantraProjectView> => {
	const repo = input.repo.trim();
	const baseBranch = input.baseBranch.trim();
	const ghToken = input.ghToken.trim();
	if (!REPO_RE.test(repo)) {
		throw new Error("repo must look like owner/name");
	}
	if (baseBranch.length === 0) throw new Error("baseBranch is required");
	if (ghToken.length < 20)
		throw new Error("ghToken looks too short to be a PAT");

	const row = await db.yantraProjects.create({
		repo,
		baseBranch,
		ghTokenCiphertext: sealSecret(ghToken),
		ghTokenHint: ghToken.slice(-4),
		enabled: true,
	});
	return toView(row);
};

/** Re-seals a new token for an existing project (PAT rotation). */
export const rotateProjectToken = async (
	id: string,
	ghToken: string,
): Promise<void> => {
	const token = ghToken.trim();
	if (token.length < 20) throw new Error("ghToken looks too short to be a PAT");
	await db.yantraProjects.findBy({ id }).update({
		ghTokenCiphertext: sealSecret(token),
		ghTokenHint: token.slice(-4),
	});
};

export const setProjectEnabled = async (
	id: string,
	enabled: boolean,
): Promise<void> => {
	await db.yantraProjects.findBy({ id }).update({ enabled });
};

export const listProjects = async (): Promise<YantraProjectView[]> => {
	const rows = await db.yantraProjects
		.select(
			"id",
			"repo",
			"baseBranch",
			"enabled",
			"ghTokenHint",
			"mode",
			"createdAt",
		)
		.order({ createdAt: "ASC" });
	return rows.map(toView);
};

/**
 * The H9 cutover lever. Going live is deliberate: it makes the app CLAIM
 * issues and open PRs on this repo — never flip it while the v0 loop still
 * ticks the same repo (double-claim).
 */
export const setProjectMode = async (
	id: string,
	mode: "shadow" | "live",
): Promise<void> => {
	await db.yantraProjects.findBy({ id }).update({ mode });
};

/** Internal only — feeds the tick. Never expose through the API. */
export const listEnabledProjectsWithTokens = async (): Promise<
	{
		id: string;
		repo: string;
		baseBranch: string;
		productionBranch: string;
		autoMergeToMain: boolean;
		mode: string;
		ghToken: string;
		/** Owning team — picks which provider keys the run resolves (#138). */
		teamId: string | null;
	}[]
> => {
	const rows = await db.yantraProjects
		.where({ enabled: true })
		.select(
			"id",
			"repo",
			"baseBranch",
			"productionBranch",
			"autoMergeToMain",
			"mode",
			"ghTokenCiphertext",
			"teamId",
		)
		.order({ createdAt: "ASC" });
	return rows.map((r) => ({
		id: r.id,
		repo: r.repo,
		baseBranch: r.baseBranch,
		productionBranch: r.productionBranch,
		autoMergeToMain: r.autoMergeToMain,
		mode: r.mode,
		ghToken: openSecret(r.ghTokenCiphertext),
		teamId: r.teamId,
	}));
};

const toView = (row: {
	id: string;
	repo: string;
	baseBranch: string;
	enabled: boolean;
	ghTokenHint: string;
	mode: string;
	createdAt: number;
}): YantraProjectView => ({
	id: row.id,
	repo: row.repo,
	baseBranch: row.baseBranch,
	enabled: row.enabled,
	ghTokenHint: row.ghTokenHint,
	mode: row.mode,
	createdAt: row.createdAt,
});

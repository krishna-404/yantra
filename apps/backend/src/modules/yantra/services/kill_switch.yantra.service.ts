import { db } from "@backend/db/db";
import {
	gh,
	ghRequest,
} from "@backend/modules/yantra/services/gh_client.yantra.service";
import { openSecret } from "@backend/modules/yantra/services/secret_box.yantra.service";

/**
 * Kill switch (H10) — YANTRA_KILL is a GitHub Actions variable on the
 * project's repo; the v0 loop and the app's tick both read it and fail
 * CLOSED (missing/unreadable ⇒ treated as ON). This service makes the
 * cockpit the red button: read + flip it with the project's own token.
 *
 * Requires the project PAT to have Variables read (get) / read-write (set).
 */

const projectWithToken = async (id: string) => {
	const row = await db.yantraProjects
		.findBy({ id })
		.select("id", "repo", "ghTokenCiphertext");
	return {
		id: row.id,
		repo: row.repo,
		ghToken: openSecret(row.ghTokenCiphertext),
	};
};

export interface KillSwitchState {
	projectId: string;
	repo: string;
	/** true = harness halted. null = variable unreadable (fails closed). */
	kill: boolean | null;
}

export const getKillSwitch = async (
	projectId: string,
): Promise<KillSwitchState> => {
	const project = await projectWithToken(projectId);
	try {
		const v = await gh<{ value: string }>(
			`/repos/${project.repo}/actions/variables/YANTRA_KILL`,
			project.ghToken,
		);
		return { projectId, repo: project.repo, kill: v.value === "true" };
	} catch {
		return { projectId, repo: project.repo, kill: null };
	}
};

export const setKillSwitch = async (
	projectId: string,
	kill: boolean,
): Promise<KillSwitchState> => {
	const project = await projectWithToken(projectId);
	await ghRequest(
		"PATCH",
		`/repos/${project.repo}/actions/variables/YANTRA_KILL`,
		project.ghToken,
		{ name: "YANTRA_KILL", value: kill ? "true" : "false" },
	);
	return { projectId, repo: project.repo, kill };
};

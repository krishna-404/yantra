import { db } from "@backend/db/db";
import {
	getAppSecretValue,
	listAppSecrets,
	setAppSecret,
} from "@backend/modules/yantra/services/app_secrets.yantra.service";
import {
	addProject,
	listEnabledProjectsWithTokens,
	listProjects,
	rotateProjectToken,
	setProjectEnabled,
	setProjectMode,
} from "@backend/modules/yantra/services/projects.yantra.service";
import { afterAll, describe, expect, it } from "vitest";

/**
 * D23 contract tests: tokens go in, only hints come out; the tick reader is
 * the single decrypting path; mode/enabled flags drive what the tick does.
 */

const REPO = "test-owner/test-repo-projects";
const TOKEN = "ghp_test_1234567890abcdefghijklmn_FAKE";

afterAll(async () => {
	await db.yantraProjects.where({ repo: { in: [REPO, `${REPO}-tick`, `${REPO}-rot`] } }).delete();
	await db.yantraAppSecrets.where({ key: "CLAUDE_CODE_OAUTH_TOKEN" }).delete();
});

describe("yantra projects (D23)", () => {
	it("stores the PAT encrypted and only ever lists the last-4 hint", async () => {
		const view = await addProject({
			repo: REPO,
			baseBranch: "staging",
			ghToken: TOKEN,
		});
		expect(view.ghTokenHint).toBe(TOKEN.slice(-4));
		expect(view.mode).toBe("shadow");
		expect(JSON.stringify(view)).not.toContain(TOKEN);

		const listed = await listProjects();
		const mine = listed.find((p) => p.repo === REPO);
		expect(mine?.ghTokenHint).toBe(TOKEN.slice(-4));
		expect(JSON.stringify(listed)).not.toContain(TOKEN);

		const raw = await db.yantraProjects.findBy({ repo: REPO, baseBranch: "staging" });
		expect(raw.ghTokenCiphertext).not.toContain(TOKEN);
		expect(raw.ghTokenCiphertext.startsWith("v1:")).toBe(true);
	});

	it("rejects malformed repos and short tokens", async () => {
		await expect(
			addProject({
				repo: "https://github.com/a/b",
				baseBranch: "main",
				ghToken: TOKEN,
			}),
		).rejects.toThrow("owner/name");
		await expect(
			addProject({ repo: "a/b-short", baseBranch: "main", ghToken: "tiny" }),
		).rejects.toThrow("too short");
	});

	it("the tick reader decrypts, and honors enabled + mode flags", async () => {
		const mine = await addProject({
			repo: `${REPO}-tick`,
			baseBranch: "staging",
			ghToken: TOKEN,
		});

		let forTick = await listEnabledProjectsWithTokens();
		const row = forTick.find((p) => p.repo === `${REPO}-tick`);
		expect(row?.ghToken).toBe(TOKEN);
		expect(row?.mode).toBe("shadow");

		await setProjectMode(mine.id, "live");
		forTick = await listEnabledProjectsWithTokens();
		expect(forTick.find((p) => p.repo === `${REPO}-tick`)?.mode).toBe("live");

		await setProjectEnabled(mine.id, false);
		forTick = await listEnabledProjectsWithTokens();
		expect(forTick.find((p) => p.repo === `${REPO}-tick`)).toBeUndefined();
	});

	it("rotates to a new token", async () => {
		const mine = await addProject({
			repo: `${REPO}-rot`,
			baseBranch: "staging",
			ghToken: TOKEN,
		});
		const next = "github_pat_ROTATED_0000000000000000_FAKE";
		await rotateProjectToken(mine.id, next);
		const after = (await listProjects()).find((p) => p.repo === `${REPO}-rot`);
		expect(after?.ghTokenHint).toBe(next.slice(-4));
	});
});

describe("yantra app secrets", () => {
	it("set → masked list → internal read; update overwrites", async () => {
		await setAppSecret("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat-FAKE-11112222");
		let secrets = await listAppSecrets();
		const mine = secrets.find((s) => s.key === "CLAUDE_CODE_OAUTH_TOKEN");
		expect(mine?.valueHint).toBe("2222");
		expect(JSON.stringify(secrets)).not.toContain("FAKE-1111");

		await setAppSecret("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat-FAKE-33334444");
		secrets = await listAppSecrets();
		expect(
			secrets.find((s) => s.key === "CLAUDE_CODE_OAUTH_TOKEN")?.valueHint,
		).toBe("4444");
		expect(await getAppSecretValue("CLAUDE_CODE_OAUTH_TOKEN")).toBe(
			"sk-ant-oat-FAKE-33334444",
		);
	});

	it("rejects too-short values", async () => {
		await expect(setAppSecret("CLAUDE_CODE_OAUTH_TOKEN", "x")).rejects.toThrow(
			"too short",
		);
	});
});

import { db } from "@backend/db/db";
import {
	clearTeamSecret,
	getAppSecretValue,
	listAppSecrets,
	setAppSecret,
} from "@backend/modules/yantra/services/app_secrets.yantra.service";
import { defaultContext } from "@backend/test/setup";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Provider keys are what every run authenticates with, so "which key does this
 * team actually get" is the whole point of #138. Resolution is pinned here:
 * a team's own key wins, and anything it hasn't set falls back to the
 * operator's installation key.
 */

const KEY = "GROQ_API_KEY" as const;

const teamId = (): string => {
	const id = defaultContext?.user.activeTeamAppId;
	if (!id) throw new Error("test setup: no active team on the default user");
	return id;
};

/** A second team, so cross-team isolation is tested rather than assumed. */
const otherTeam = async (): Promise<string> => {
	const userId = defaultContext?.user.id;
	if (!userId) throw new Error("test setup: no user");
	const row = await db.teamsApp
		.create({ name: "Other team", createdByUserId: userId })
		.select("id");
	return row.id;
};

afterEach(async () => {
	await db.yantraAppSecrets.where({ key: KEY }).delete();
});

describe("provider key scoping", () => {
	it("falls back to the installation key when the team has none", async () => {
		await setAppSecret(KEY, "installation-secret");

		expect(await getAppSecretValue(KEY, teamId())).toBe("installation-secret");
		expect(await getAppSecretValue(KEY)).toBe("installation-secret");
	});

	it("prefers the team's own key over the installation key", async () => {
		await setAppSecret(KEY, "installation-secret");
		await setAppSecret(KEY, "team-secret", teamId());

		expect(await getAppSecretValue(KEY, teamId())).toBe("team-secret");
		// The operator's own key is untouched — this is the guarantee that one
		// team setting a key can't move what anyone else runs on.
		expect(await getAppSecretValue(KEY)).toBe("installation-secret");
	});

	it("keeps two teams' keys apart", async () => {
		const other = await otherTeam();
		await setAppSecret(KEY, "mine-key-aaaa", teamId());
		await setAppSecret(KEY, "their-key-bbbb", other);

		expect(await getAppSecretValue(KEY, teamId())).toBe("mine-key-aaaa");
		expect(await getAppSecretValue(KEY, other)).toBe("their-key-bbbb");
	});

	it("returns null when neither scope has the key", async () => {
		expect(await getAppSecretValue(KEY, teamId())).toBeNull();
		expect(await getAppSecretValue(KEY)).toBeNull();
	});

	it("rotating a team key replaces it rather than stacking rows", async () => {
		await setAppSecret(KEY, "first-value", teamId());
		await setAppSecret(KEY, "second-value", teamId());

		expect(await getAppSecretValue(KEY, teamId())).toBe("second-value");
		const rows = await db.yantraAppSecrets.where({
			key: KEY,
			teamId: teamId(),
		});
		expect(rows).toHaveLength(1);
	});

	it("clearing a team key falls back to the installation key again", async () => {
		await setAppSecret(KEY, "installation-secret");
		await setAppSecret(KEY, "team-secret", teamId());
		expect(await getAppSecretValue(KEY, teamId())).toBe("team-secret");

		await clearTeamSecret(KEY, teamId());
		expect(await getAppSecretValue(KEY, teamId())).toBe("installation-secret");
	});

	it("rejects a value too short to be a real credential", async () => {
		await expect(setAppSecret(KEY, "short", teamId())).rejects.toThrow(
			/too short/,
		);
	});
});

describe("listAppSecrets", () => {
	it("marks inherited keys as not team-owned", async () => {
		await setAppSecret(KEY, "installation-secret");

		const rows = await listAppSecrets(teamId());
		const row = rows.find((r) => r.key === KEY);
		expect(row?.teamOwned).toBe(false);
		expect(row?.valueHint).toBe("cret");
	});

	it("marks the team's own key as team-owned and shows its hint", async () => {
		await setAppSecret(KEY, "installation-secret");
		await setAppSecret(KEY, "team-value-1234", teamId());

		const rows = await listAppSecrets(teamId());
		const row = rows.find((r) => r.key === KEY);
		expect(row?.teamOwned).toBe(true);
		// The hint is the team's, not the operator's — the list has to show what
		// a run would actually pick up.
		expect(row?.valueHint).toBe("1234");
	});

	it("shows only the installation scope when no team is given", async () => {
		await setAppSecret(KEY, "installation-secret");
		await setAppSecret(KEY, "team-value-1234", teamId());

		const rows = await listAppSecrets();
		const row = rows.find((r) => r.key === KEY);
		expect(row?.valueHint).toBe("cret");
		expect(row?.teamOwned).toBe(false);
	});

	it("does not leak another team's key into this team's list", async () => {
		const other = await otherTeam();
		await setAppSecret(KEY, "theirs-9999", other);

		const rows = await listAppSecrets(teamId());
		expect(rows.find((r) => r.key === KEY)).toBeUndefined();
	});
});

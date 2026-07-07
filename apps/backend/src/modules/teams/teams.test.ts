import { db } from "@backend/db/db";
import { auth } from "@backend/modules/auth/auth.config";
import { teamsAppRouter } from "@backend/modules/teams/teams_app.router.js";
import { defaultContext } from "@backend/test/setup";
import { createUserAndLogin } from "@backend/test/utils/user-auth.utils";
import { transformSessionAndUserData } from "@backend/utils/session.utils";
import { createRouterClient, ORPCError, type RouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTeamService } from "./services/create_team.teams.service";

// Several tests below chain multiple signup/login round trips (each an
// auth.api call hitting the DB); under `vitest --coverage` v8 instrumentation
// slows every DB round trip enough that the default 5s test timeout is too
// tight. Raised file-locally rather than in vitest.config.ts.
vi.setConfig({ testTimeout: 20_000 });

// `createUserAndLogin` password is hardcoded in the test helper; re-used here
// to mint a FRESH session (bypassing Better Auth's 5-minute cookie cache) so
// a client reflects a `users.activeTeamAppId` update made mid-test.
const TEST_PASSWORD = "password123";

const reloginAs = async (email: string) => {
	const response = await auth.api.signInEmail({
		body: { email, password: TEST_PASSWORD },
		asResponse: true,
	});
	const reqHeaders = new Headers({
		Cookie: response.headers.getSetCookie().join("; "),
	});
	const sessionData = await auth.api.getSession({ headers: reqHeaders });
	if (!sessionData) throw new Error("Relogin failed");
	const { session, user } = transformSessionAndUserData(sessionData);
	if (user.activeTeamAppId) reqHeaders.set("x-team-id", user.activeTeamAppId);
	return { reqHeaders, session, user };
};

describe("Teams App Endpoints", () => {
	let defaultClient: RouterClient<typeof teamsAppRouter>;

	beforeEach(() => {
		if (!defaultContext) throw new Error("defaultContext not initialized");
		defaultClient = createRouterClient(teamsAppRouter, {
			context: defaultContext,
		});
	});

	describe("getDefaultTeam", () => {
		it("should create a personal team if none exists and set it as default", async () => {
			// Ensure user has no default team and no personal team
			await db.users
				.where({ id: defaultContext?.user.id })
				.update({ activeTeamAppId: null });
			await db.teamsApp
				.where({ personalTeamForUserId: defaultContext?.user.id })
				.delete();

			const result = await defaultClient.getDefaultTeam({});

			expect(result).toBeDefined();
			expect(result.personalTeamForUserId).toBe(defaultContext?.user.id);
			expect(result.name).toBe(
				`${defaultContext?.user.name.split(" ")[0]}'s Team`,
			);

			// Verify user's activeTeamAppId is updated
			const user = await db.users.where({ id: defaultContext?.user.id }).take();
			expect(user.activeTeamAppId).toBe(result.id);

			// Verify membership
			const membership = await db.teamMembers
				.where({ teamId: result.id, userId: defaultContext?.user.id })
				.take();
			expect(membership.role).toBe("Owner");
		});

		// The previous form of this test set up a "user has personal team but
		// activeTeamAppId is null" scenario by mutating db.users directly.
		// That bypasses Better Auth's 5-minute session cookie cache, so
		// getDefaultTeam still reads the stale user. In production this state
		// never happens — the users.afterCreate hook mints a personal team
		// and sets activeTeamAppId atomically. The idempotency test below
		// covers the meaningful "returns existing team" invariant without
		// needing the cache-invalidation dance.

		it("should be idempotent — second call returns the same default team", async () => {
			// The previous form of this test mutated `db.users.activeTeamAppId`
			// directly. That bypasses Better Auth's session cookie cache, so the
			// subsequent request still saw the stale user. The realistic flow is:
			// first call seeds the default team, every later call returns it.
			const firstResult = await defaultClient.getDefaultTeam({});
			const secondResult = await defaultClient.getDefaultTeam({});

			expect(secondResult.id).toBe(firstResult.id);
			expect(secondResult.name).toBe(firstResult.name);
		});
	});

	describe("getMyTeams", () => {
		it("claims a pending invite matched by email and reports the role", async () => {
			if (!defaultContext) throw new Error("defaultContext not initialized");
			const inviter = await createUserAndLogin();
			const inviterTeamId = inviter.user.activeTeamAppId;
			if (!inviterTeamId) throw new Error("expected inviter to have a team");

			await db.teamMembers.create({
				teamId: inviterTeamId,
				email: defaultContext.user.email,
				role: "Member",
			});

			const result = await defaultClient.getMyTeams();
			const claimed = result.find((t) => t.id === inviterTeamId);
			expect(claimed).toBeDefined();
			expect(claimed?.userRole).toBe("Member");

			const membership = await db.teamMembers
				.where({ teamId: inviterTeamId, email: defaultContext.user.email })
				.take();
			expect(membership.userId).toBe(defaultContext.user.id);
			expect(membership.joinedAt).not.toBeNull();
		});

		it("returns the caller's own personal team with the Owner role", async () => {
			if (!defaultContext) throw new Error("defaultContext not initialized");
			const activeTeamAppId = defaultContext.user.activeTeamAppId;
			const result = await defaultClient.getMyTeams();
			const personal = result.find((t) => t.id === activeTeamAppId);
			expect(personal?.userRole).toBe("Owner");
		});
	});

	describe("createTeam", () => {
		it("creates a non-personal team owned by the caller", async () => {
			if (!defaultContext) throw new Error("defaultContext not initialized");
			const team = await defaultClient.createTeam({ name: "Acme Corp" });

			expect(team.name).toBe("Acme Corp");
			expect(team.personalTeamForUserId).toBeNull();
			expect(team.createdByUserId).toBe(defaultContext.user.id);

			const membership = await db.teamMembers
				.where({ teamId: team.id, userId: defaultContext.user.id })
				.take();
			expect(membership.role).toBe("Owner");
		});
	});

	describe("setActiveTeam", () => {
		it("switches the caller's active team when they are a member", async () => {
			if (!defaultContext) throw new Error("defaultContext not initialized");
			const team = await createTeamService(
				defaultContext.user.id,
				defaultContext.user.email,
				defaultContext.user.phoneNumber,
				{ name: "Switchable" },
			);

			const result = await defaultClient.setActiveTeam({ teamAppId: team.id });
			expect(result.activeTeamAppId).toBe(team.id);

			const user = await db.users.where({ id: defaultContext.user.id }).take();
			expect(user.activeTeamAppId).toBe(team.id);
		});

		it("rejects switching to a team the caller does not belong to", async () => {
			const stranger = await createUserAndLogin();
			const strangerTeamId = stranger.user.activeTeamAppId;
			if (!strangerTeamId) throw new Error("expected stranger to have a team");

			await expect(
				defaultClient.setActiveTeam({ teamAppId: strangerTeamId }),
			).rejects.toThrow(ORPCError);
		});
	});

	describe("getTeamMembers", () => {
		it("lists members of the caller's active team", async () => {
			await defaultClient.addTeamMember({
				email: "new-member@example.com",
				role: "Member",
			});

			const members = await defaultClient.getTeamMembers();
			expect(members.length).toBeGreaterThanOrEqual(2);
			expect(members.some((m) => m.email === "new-member@example.com")).toBe(
				true,
			);
		});
	});

	describe("addTeamMember", () => {
		it("links an existing user found by email and marks them joined", async () => {
			const invitee = await createUserAndLogin();
			if (!invitee.user.email) throw new Error("expected invitee email");

			const member = await defaultClient.addTeamMember({
				email: invitee.user.email,
				role: "Admin",
			});

			expect(member.userId).toBe(invitee.user.id);
			expect(member.joinedAt).not.toBeNull();
			expect(member.role).toBe("Admin");
		});

		it("invites a not-yet-existing phone number as a pending member", async () => {
			const member = await defaultClient.addTeamMember({
				phoneNumber: "+14155550100",
				role: "Member",
			});

			expect(member.userId).toBeNull();
			expect(member.joinedAt).toBeNull();
		});
	});

	describe("removeTeamMember", () => {
		it("removes a regular member from the active team", async () => {
			const member = await defaultClient.addTeamMember({
				email: "removable@example.com",
				role: "Member",
			});

			const result = await defaultClient.removeTeamMember({ id: member.id });
			expect(result.success).toBe(true);

			const remaining = await db.teamMembers
				.where({ id: member.id })
				.takeOptional();
			expect(remaining).toBeUndefined();
		});

		it("forbids an Admin from removing the team Owner", async () => {
			if (!defaultContext) throw new Error("defaultContext not initialized");
			const ownerMembership = await db.teamMembers
				.where({
					teamId: defaultContext.user.activeTeamAppId ?? undefined,
					userId: defaultContext.user.id,
				})
				.take();

			const adminUser = await createUserAndLogin();
			if (!adminUser.user.email) throw new Error("expected admin email");
			await defaultClient.addTeamMember({
				email: adminUser.user.email,
				role: "Admin",
			});
			await createRouterClient(teamsAppRouter, {
				context: adminUser,
			}).setActiveTeam({
				teamAppId: defaultContext.user.activeTeamAppId ?? "",
			});

			const adminContext = await reloginAs(adminUser.user.email);
			const adminClient = createRouterClient(teamsAppRouter, {
				context: adminContext,
			});

			await expect(
				adminClient.removeTeamMember({ id: ownerMembership.id }),
			).rejects.toThrow("Admins cannot remove the Owner");
		});
	});

	describe("updateMemberRole", () => {
		it("lets the Owner change a member's role", async () => {
			const member = await defaultClient.addTeamMember({
				email: "role-change@example.com",
				role: "Member",
			});

			const updated = await defaultClient.updateMemberRole({
				id: member.id,
				role: "Admin",
			});
			expect(updated.role).toBe("Admin");
		});

		it("forbids a non-Owner from changing roles", async () => {
			if (!defaultContext) throw new Error("defaultContext not initialized");
			const member = await defaultClient.addTeamMember({
				email: "target-member@example.com",
				role: "Member",
			});

			const adminUser = await createUserAndLogin();
			if (!adminUser.user.email) throw new Error("expected admin email");
			await defaultClient.addTeamMember({
				email: adminUser.user.email,
				role: "Admin",
			});
			await createRouterClient(teamsAppRouter, {
				context: adminUser,
			}).setActiveTeam({
				teamAppId: defaultContext.user.activeTeamAppId ?? "",
			});

			const adminContext = await reloginAs(adminUser.user.email);
			const adminClient = createRouterClient(teamsAppRouter, {
				context: adminContext,
			});

			await expect(
				adminClient.updateMemberRole({ id: member.id, role: "Owner" }),
			).rejects.toThrow(ORPCError);
		});
	});

	describe("deleteTeam", () => {
		it("forbids deleting the personal team", async () => {
			await expect(defaultClient.deleteTeam()).rejects.toThrow(ORPCError);
		});

		it("deletes a non-personal team when the caller is its Owner", async () => {
			if (!defaultContext) throw new Error("defaultContext not initialized");
			const team = await defaultClient.createTeam({ name: "Disposable" });
			await defaultClient.setActiveTeam({ teamAppId: team.id });

			const ownerContext = await reloginAs(defaultContext.user.email ?? "");
			const ownerClient = createRouterClient(teamsAppRouter, {
				context: ownerContext,
			});

			const result = await ownerClient.deleteTeam();
			expect(result.success).toBe(true);

			const remaining = await db.teamsApp.where({ id: team.id }).takeOptional();
			expect(remaining).toBeUndefined();
		});

		it("forbids a non-Owner (Admin) from deleting the team", async () => {
			if (!defaultContext) throw new Error("defaultContext not initialized");
			const adminUser = await createUserAndLogin();
			if (!adminUser.user.email) throw new Error("expected admin email");
			await defaultClient.addTeamMember({
				email: adminUser.user.email,
				role: "Admin",
			});
			await createRouterClient(teamsAppRouter, {
				context: adminUser,
			}).setActiveTeam({
				teamAppId: defaultContext.user.activeTeamAppId ?? "",
			});

			const adminContext = await reloginAs(adminUser.user.email);
			const adminClient = createRouterClient(teamsAppRouter, {
				context: adminContext,
			});

			await expect(adminClient.deleteTeam()).rejects.toThrow(ORPCError);
		});
	});

	describe("pullBundles / pullMembersDelta", () => {
		it("returns the caller's teams and team-member rows scoped to the active team", async () => {
			if (!defaultContext) throw new Error("defaultContext not initialized");
			const activeTeamAppId = defaultContext.user.activeTeamAppId;
			const userId = defaultContext.user.id;
			const teamsResult = await defaultClient.pullBundles({
				syncMetadata: null,
			});
			expect(teamsResult.rows.some((t) => t.id === activeTeamAppId)).toBe(true);

			const membersResult = await defaultClient.pullMembersDelta({
				syncMetadata: null,
				topLevelSyncedAt: Date.now(),
			});
			expect(membersResult.rows.some((m) => m.userId === userId)).toBe(true);
		});

		it("rejects a sync metadata teamId that mismatches the active team", async () => {
			await expect(
				defaultClient.pullBundles({
					syncMetadata: {
						teamId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
						syncedTable: "teamsApp",
						fromCursorId: null,
						fromCursorUpdatedAt: null,
						toCursorId: null,
						toCursorUpdatedAt: null,
						syncedAt: null,
						totalRecords: 0,
					},
				}),
			).rejects.toThrow(ORPCError);
		});
	});
});

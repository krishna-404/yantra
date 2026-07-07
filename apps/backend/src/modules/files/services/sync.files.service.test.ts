import { db } from "@backend/db/db";
import { requestContext } from "@backend/lib/request-context";
import {
	pullFilesService,
	pushFilesCdnUpdatesService,
} from "@backend/modules/files/services/sync.files.service";
import { defaultContext } from "@backend/test/setup";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";

// `test-bucket` origin matches S3_PUBLIC_URL in .env.test; used to exercise
// the CDN origin allowlist without touching real network/S3.
const ALLOWED_CDN_URL =
	"https://test-bucket.blr1.cdn.digitaloceanspaces.com/a.png";
const ALLOWED_THUMB_URL =
	"https://test-bucket.blr1.cdn.digitaloceanspaces.com/a-thumb.png";
const DISALLOWED_URL = "https://evil.example.com/a.png";

const withTenantContext = <T>(fn: () => Promise<T>) => {
	if (!defaultContext) throw new Error("defaultContext not initialized");
	const teamId = defaultContext.user.activeTeamAppId;
	if (!teamId) throw new Error("expected an active team");
	return requestContext.run(
		{
			tenantTeamId: teamId,
			userId: defaultContext.user.id,
			teamMemberId: "test-member-sentinel",
			teamMemberRole: "Owner",
		},
		fn,
	);
};

const createFile = async (
	overrides: Partial<{ cdnUrl: string | null }> = {},
) => {
	if (!defaultContext) throw new Error("defaultContext not initialized");
	const teamId = defaultContext.user.activeTeamAppId;
	if (!teamId) throw new Error("expected an active team");
	return db.files.create({
		id: ulid(),
		tableName: "journalEntries",
		tableId: ulid(),
		type: "attachment",
		fileName: "test.png",
		mimeType: "image/png",
		createdByUserId: defaultContext.user.id,
		teamId,
		cdnUrl: overrides.cdnUrl ?? null,
	});
};

describe("pushFilesCdnUpdatesService", () => {
	it("returns an empty result immediately for an empty updates array", async () => {
		const result = await pushFilesCdnUpdatesService({ updates: [] });
		expect(result).toEqual({ results: [] });
	});

	it("fills cdnUrl and thumbnailCdnUrl when currently null", async () => {
		const file = await withTenantContext(() => createFile());

		const result = await withTenantContext(() =>
			pushFilesCdnUpdatesService({
				updates: [
					{
						id: file.id,
						cdnUrl: ALLOWED_CDN_URL,
						thumbnailCdnUrl: ALLOWED_THUMB_URL,
					},
				],
			}),
		);

		expect(result.results).toHaveLength(1);
		const [row] = result.results;
		if (!row?.ok || !row.row) throw new Error("expected ok result");
		expect(row.row.cdnUrl).toBe(ALLOWED_CDN_URL);
		expect(row.row.thumbnailCdnUrl).toBe(ALLOWED_THUMB_URL);

		const persisted = await db.files.where({ id: file.id }).take();
		expect(persisted.cdnUrl).toBe(ALLOWED_CDN_URL);
	});

	it("does not overwrite an already-set cdnUrl (no-op branch)", async () => {
		const file = await withTenantContext(() =>
			createFile({ cdnUrl: ALLOWED_CDN_URL }),
		);

		const result = await withTenantContext(() =>
			pushFilesCdnUpdatesService({
				updates: [
					{
						id: file.id,
						cdnUrl:
							"https://test-bucket.blr1.cdn.digitaloceanspaces.com/other.png",
					},
				],
			}),
		);

		const [row] = result.results;
		if (!row?.ok || !row.row) throw new Error("expected ok result");
		expect(row.row.cdnUrl).toBe(ALLOWED_CDN_URL);
	});

	it("flips isMainFileLost from false to true", async () => {
		const file = await withTenantContext(() => createFile());

		const result = await withTenantContext(() =>
			pushFilesCdnUpdatesService({
				updates: [{ id: file.id, isMainFileLost: true }],
			}),
		);

		const [row] = result.results;
		if (!row?.ok || !row.row) throw new Error("expected ok result");
		expect(row.row.isMainFileLost).toBe(true);
	});

	it("rejects a non-allowlisted CDN URL without writing it", async () => {
		const file = await withTenantContext(() => createFile());

		const result = await withTenantContext(() =>
			pushFilesCdnUpdatesService({
				updates: [{ id: file.id, cdnUrl: DISALLOWED_URL }],
			}),
		);

		const [row] = result.results;
		expect(row).toEqual({
			ok: false,
			id: file.id,
			error: "Not a permitted CDN URL",
		});

		const persisted = await db.files.where({ id: file.id }).take();
		expect(persisted.cdnUrl).toBeNull();
	});

	it("returns ok:false for a row that doesn't exist (or belongs to another tenant)", async () => {
		const missingId = ulid();
		const result = await withTenantContext(() =>
			pushFilesCdnUpdatesService({ updates: [{ id: missingId }] }),
		);

		expect(result.results).toEqual([
			{
				ok: false,
				id: missingId,
				error: "File row not found — parent bundle likely hasn't landed yet",
			},
		]);
	});
});

describe("pullFilesService", () => {
	it("returns the team's files scoped by tenant and advances the sync cursor", async () => {
		const file = await withTenantContext(() => createFile());

		const result = await withTenantContext(() =>
			pullFilesService({
				syncMetadata: null,
				topLevelSyncedAt: Date.now() + 10_000,
			}),
		);

		expect(result.rows.some((r) => r.id === file.id)).toBe(true);
		expect(result.syncMetadata.syncedTable).toBe("files");
		expect(result.syncMetadata.toCursorId).not.toBeNull();
	});

	it("excludes rows updated after the topLevelSyncedAt snapshot ceiling", async () => {
		await withTenantContext(() => createFile());

		const result = await withTenantContext(() =>
			pullFilesService({ syncMetadata: null, topLevelSyncedAt: 1 }),
		);

		expect(result.rows).toHaveLength(0);
	});
});

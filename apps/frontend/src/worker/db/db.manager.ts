import type { FileSelectAll } from "@connected-repo/zod-schemas/file.zod";
import type {
	TeamAppMemberSelectAll,
	TeamAppSelectAll,
} from "@connected-repo/zod-schemas/team_app.zod";
import Dexie, { type Table } from "dexie";
import type { StoredFile, StoredSyncMetadata, SyncCycleState } from "./schema.db.types";

/**
 * Local mirror of the server's synced tables plus a small amount of
 * client-only state (cursors, file-upload machine, sync cycle telemetry).
 *
 * The DB is **per-user** — the DB name is `app_db_v1_${userId}`. See
 * `db.lifecycle.ts` for open/close/switch semantics. On this-device
 * user-switch, the previous user's DB is dropped before opening the
 * new one; a user logging back in on the same device rehydrates their
 * own DB.
 *
 * Pending vs confirmed rows share the same Dexie table — a row is
 * "pending" when `createdAt` is falsy (`null` / `undefined` / `0`).
 *
 * Cross-context reactivity uses a hand-rolled `BroadcastChannel` (see
 * `notifySubscribers`) — Dexie's own `liveQuery` doesn't cross the
 * worker boundary.
 */

export type Pending<T extends { createdAt?: number | null }> = Omit<T, "createdAt"> & {
	createdAt: number | null;
};

export type WithSyncStatus<T extends { createdAt?: number | null }> = Pending<T> & {
	syncError?: string | null;
};

export const DEXIE_VERSION = 4;
export const DEXIE_DB_NAME_PREFIX = "app_db_v1_";

export const dbNameFor = (userId: string): string => `${DEXIE_DB_NAME_PREFIX}${userId}`;

export class ClientDatabase extends Dexie {
	files!: Table<StoredFile, string>;
	teamsApp!: Table<TeamAppSelectAll, string>;
	teamMembers!: Table<TeamAppMemberSelectAll, string>;
	syncMetadata!: Table<StoredSyncMetadata, [string, string]>;
	syncState!: Table<SyncCycleState, string>;

	constructor(dbName: string) {
		super(dbName);

		// Bumping DEXIE_VERSION to 4 drops the `journalEntries` and `prompts`
		// object stores on upgrade: Dexie diffs this (single, latest) schema
		// against the on-disk one and deletes any store not declared here.
		// Any locally-queued unsynced journal/prompt rows go with them —
		// intentional, the journal/prompt domain is being removed.
		this.version(DEXIE_VERSION).stores({
			files: "id, tableId, tableName, type, teamId, updatedAt, mainUploadState, thumbnailUploadState, createdAt, syncError",
			teamsApp: "id, updatedAt",
			teamMembers: "id, userId, teamId, updatedAt",
			// Composite PK: cursors are per-(table, team) so switching teams
			// doesn't collide. Client sends the correct cursor for the current
			// active team; the server rejects a cross-team cursor.
			syncMetadata: "[syncedTable+teamId], syncedTable, teamId",
			// singleton — key = "app"
			syncState: "key",
		});
	}
}

// ─── Cross-context reactivity ───────────────────────────────────────────
//
// The DataWorker mutates Dexie; the main thread reads through hooks. Both
// need to know when a table changed. `BroadcastChannel` fans out to every
// same-origin document + worker, so a single write notifies all of them.

export type AppDbTable =
	| "files"
	| "teamsApp"
	| "teamMembers"
	| "syncMetadata"
	| "syncState";

/**
 * Origin of a Dexie mutation, propagated to subscribers.
 *
 *   - `"sync"`     — write came from our own pull/push pipeline or
 *                    background upload worker (`bulkUpsertFromServer`,
 *                    `overwriteFromServer`, `markCdnPushed`,
 *                    `updateUploadState`, wipe cascades, cursor writes).
 *                    The SyncOrchestrator ignores these — reacting to them
 *                    would ping-pong every cycle back onto itself.
 *   - `"external"` — user or UI-driven write (`upsertLocal`,
 *                    `upsertPending`, etc.). The SyncOrchestrator DOES
 *                    react so the queued mutation gets pushed promptly.
 *
 * Defaults to `"external"` at every callsite so a missed tag errs on
 * the safe side (may cause an extra harmless cycle; never drops a real
 * user write).
 */
export type NotifySource = "sync" | "external";

const dbUpdatesChannel = new BroadcastChannel("db-updates");
const subscribers = new Set<(table: AppDbTable, source: NotifySource) => void>();

dbUpdatesChannel.onmessage = (event) => {
	const data = event.data as
		| { table?: AppDbTable; source?: NotifySource }
		| undefined;
	const table = data?.table;
	if (!table) return;
	const source: NotifySource = data?.source ?? "external";
	for (const cb of subscribers) cb(table, source);
};

/**
 * Notify every subscriber in this context AND every other same-origin
 * context that `table` changed. Callers MUST invoke this after every
 * write, otherwise UI hooks won't refetch.
 *
 * Pass `source: "sync"` when the write originates from the sync/upload
 * pipeline so the SyncOrchestrator's subscribe callback can skip it
 * without dropping subsequent user-driven writes.
 */
export const notifySubscribers = (
	table: AppDbTable,
	source: NotifySource = "external",
): void => {
	for (const cb of subscribers) cb(table, source);
	dbUpdatesChannel.postMessage({ table, source });
};

export const subscribe = (
	callback: (table: AppDbTable, source: NotifySource) => void,
): (() => void) => {
	subscribers.add(callback);
	return () => {
		subscribers.delete(callback);
	};
};

// ─── Type aliases for module DB adapters ────────────────────────────────

export type StoredTeam = TeamAppSelectAll;
export type StoredTeamMember = TeamAppMemberSelectAll;

export type { FileSelectAll };

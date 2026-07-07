---
name: strip-tasks-cascade-to-orphaned-infra-under-knip
description: Domain-strip tasks must cascade to files the removal orphans, because knip `files: error` gates CI on any newly-unreferenced file.
metadata:
  type: project
---

When a `strip-module` task removes a domain, the spec's `files_expected` list can be
**incomplete by construction**: deleting the last consumer of a "generic-looking" helper
file leaves it fully unreferenced, and this repo's `knip.jsonc` sets `files: "error"`, so a
newly-orphaned file turns CI red even though it isn't in the spec's edit list.

Concrete case (issue #12, journal+prompt data-layer strip): removing
`pushJournalEntryCreates` from `sync.orchestrator.ts` orphaned
`worker/sync/pending-edit-lock.registry.ts` — its only consumer. The fix was to delete the
orphan as a **justified addition beyond `files_expected`** (documented in the PR body), not
to leave it or add a knip ignore.

**How to apply:** after excising a domain, grep for each helper the removed code imported;
if a helper's only references were the code you deleted, delete the helper too and justify
it. Conversely, when the spec pins the exact file set, **preserve shared type/interface
shapes** (e.g. keep `SyncStatusSnapshot` fields, hardcoded to 0) so out-of-scope consumers
don't need edits. knip severities that gate: `files`, `dependencies`, `devDependencies`,
`unlisted` (all `error`); `exports`/`types`/`duplicates` are `warn` (non-gating backlog).

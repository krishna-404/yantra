---
title: README's stale "SSE realtime" claim is bigger than one line
strikes: 1
---

Issue #1 asked to fix one Tech Stack sentence claiming SSE-based realtime sync (the
actual mechanism is FCM silent push waking a service worker, which then pulls a
cursor-based delta — confirmed via `apps/backend/src/cron_jobs/silent_sync_dispatch.cron.ts`,
`apps/backend/src/modules/sync/services/sync_delta.sync.service.ts`, and the explicit
"no SSE" comment in `apps/frontend/src/worker/sync/sync.orchestrator.ts:79`). That one
line is fixed, but the same stale "SSE" claim also appears in the README's Project
Structure comment, the "Offline-First Architecture" and "Two-Worker Architecture"
sections, and a whole "### Real-Time Sync (SSE)" Key Features subsection with fabricated
code samples — none of which match the codebase. Those were left untouched because the
approved plan scoped this task to a single sentence and reserved a full rewrite for
Phase 1. Next docs pass (or Phase 1 rewrite) should grep README.md for "SSE" and correct
every remaining hit, not just the Tech Stack line — otherwise agents grepping for
"real-time" will still find the old, false architecture description.

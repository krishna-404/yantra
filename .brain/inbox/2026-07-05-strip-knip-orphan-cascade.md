# Lesson: domain-strip PRs orphan cross-module files through deleted entry points

**Context:** #8 (fold) stripped the backend journal domain under the `knip` CI gate.

**What bit us:** Deleting `modules/journal-entries/journal-entries.openapi.router.ts` (the
OneQ "metered journal API" demo endpoint) silently orphaned a chain of files in *other*
directories that were reachable ONLY through it — `modules/subscriptions/services/{get_active,
increment_usage}` and `utils/{create_request_log,subscription_check}`. `knip` (rule
`files: error`) then went red on files the spec never named, and `check-types` separately
broke on `db/seed/prompts.seed.ts` (its `db.prompts` reference stopped compiling once the
prompts table was deleted).

**Rule of thumb for strip / "fold" PRs:**
1. After deleting a module's public entry points, `grep` the deleted files' imports and
   trace which targets have **zero remaining importers** — those are new orphans that must
   be removed in the *same* PR (the whole point of an atomic fold is "no orphan left"). Run
   `yarn knip` locally before declaring done; a green `test:run` won't catch this.
2. A spec's "remove the X that lived in module M" can conflict with "keep live consumer Y"
   when X is shared infra merely *mislocated* inside M (here: the user-reminder handler
   served the still-live reminder cron). Resolution: **relocate + de-name**, don't delete —
   deleting would ship a live task with no handler.
3. Deleting an ORM table class breaks every non-test consumer that compiles against
   `db.<table>` (seeds, scripts). Sweep those even when they're nominally "out of scope,"
   because the gate is per-repo `check-types`, not per-issue scope.

Relates to [[fresh-container-bootstrap]] (gates false-red until `yarn build` + `test:db:setup`).

# Strip-task acceptance greps can collide with hard rules & sibling-ticket scope

**Context:** #11 (strip frontend journal UI). Its success criterion was a hard grep:
`grep -ri "journal" apps/frontend/src` must return ONLY `worker/`/`sw/` files. But the same
spec's *Out of scope* deferred "Worker/store/Dexie references" to #12, and other `journal`
tokens lived in a protected `*auth*` file (`journalReminderTimes` in Better Auth
additionalFields) and in retained PWA/notification infra copy. A literally-empty grep was
therefore unachievable without breaching D16/#12 or the `*auth*` guard.

**Lesson:** When a strip task's acceptance grep is broader than its stated scope, treat the
grep as expressing intent for the *target layer* (here: UI/routes/nav/page-state), not a
license to edit protected files or do a sibling ticket's work. Scope deletions to the
layer, and **document each residual grep hit with its owning ticket / guard** instead of
chasing a green grep across boundaries. Flag the criterion as partially-met with reasons —
that's more useful to the reviewer than a boundary breach or a blind `NEEDS_HUMAN`.

**Corollary:** A `*.spec.ts` file's *directory* can lie about what it tests. Before deleting
tests inside a module being removed, read them — a misfiled spec that covers *retained*
infra should be **relocated** (preserving coverage), not deleted. ("Never delete a test to
get green" applies even when the deletion is incidental to a directory nuke.)

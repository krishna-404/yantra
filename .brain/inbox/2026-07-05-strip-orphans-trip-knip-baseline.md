# Strip-task deletions orphan shared helpers/deps → knip zero-baseline CI red

**Context:** #11 (strip frontend journal UI). Deleting `CreateJournalEntryForm` (journal
UI) removed the *only* importer of three shared-looking main-thread helpers
(`SmartMediaUploader`, `NotificationPermissionDialog`, `thumbnail-video-ui`) and of the
`ulid` package. knip's `files: error` / `dependencies: error` rules run a zero baseline,
so the strip turned CI red on the **knip** job even though lint/types/tests were green —
the failure was one directory away from the files the spec named.

**Why it matters:** a "delete module X" task's real blast radius includes anything whose
last consumer lived in X. Grepping only the module dir misses these transitive orphans;
they only surface as a red knip leg in CI, not locally unless you run `yarn knip`.

**How to apply:**
- After a UI/module strip, run `yarn knip` locally (build `packages/zod-schemas` first)
  before finishing — it's a gated CI job, not covered by lint/types/tests.
- Delete genuinely-dead orphaned files that were only reachable through the removed code
  (justify them as beyond `files_expected` in the PR body).
- For an orphaned **package.json** dependency you can't remove (dependency sections are
  off-limits per the execute-agent rules), add it to knip `ignoreDependencies` at the
  workspace that *declares* it — a root-level dep goes in the **root** block, not the
  app workspace block — matching the existing "unused direct deps → follow-up" precedent.

See also [[strip-grep-vs-scope-boundaries]] and [[knip-ci-baseline-triage]].

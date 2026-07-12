---
strikes: 1
---

# biome lint scans generated `coverage/` even though the formatter excludes it

**Context:** Adding the CI coverage ratchet (#3). Running `yarn test:coverage` locally
creates `apps/backend/coverage/` (gitignored). `yarn lint` then failed on the generated
HTML/JS artifacts inside it.

**Root cause:** `biome.json` excludes `**/coverage` only under `formatter.includes`. The
`linter` block has no `includes`, so `biome check` (which runs lint + format + assist)
lints `coverage/`. `vcs.useIgnoreFile: true` did **not** save us here.

**Lesson / how to apply:**
- After running coverage locally, `rm -rf apps/backend/coverage` before `yarn lint`, or
  the artifact trips the linter. The Yantra harness runs `lint → check-types → test:run`
  (never `test:coverage`), and CI's `checks` job lints a fresh checkout, so neither hits
  this — it only bites interactive/local runs.
- Measure coverage baselines with the `json-summary` reporter
  (`--coverage.reporter=json-summary` → `coverage/coverage-summary.json`). The `text`
  reporter's totals ("All files" row) scroll off the top of a long table in captured logs.
- If this recurs, the clean fix is a `linter.includes` (or top-level `files.includes`)
  entry excluding `**/coverage` — out of scope for #3, flagging for a future cleanup.

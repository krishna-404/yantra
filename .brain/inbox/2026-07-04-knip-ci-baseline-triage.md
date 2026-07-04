# Lesson: gating a linter on a repo with an existing backlog

**Context:** Adding `knip` to CI (Y1.A). The repo had ~90 pre-existing findings,
mostly *real* dead code that was out of scope to delete.

**Lesson:** When wiring a whole-codebase linter (knip, ts-prune, depcheck, …) into
CI on a codebase with a large existing backlog, don't force a binary "green or
blanket-ignore" choice. Split by rule severity:

- Pin the rules you *can* bring to a **zero baseline** to `error` (they gate new
  rot). Here: `files`, `dependencies`, `devDependencies`, `unlisted`.
- Downgrade rules with an irreducible backlog to `warn` — still printed every run,
  not silenced — and enumerate the backlog as follow-up issues. Here: `exports`,
  `types`, `duplicates`. Re-promote to `error` once the backlog clears.

**Repo gotcha:** `yarn knip` needs `@connected-repo/zod-schemas` built first
(`yarn workspace @connected-repo/zod-schemas run build`) — knip loads the frontend
`vite.config.ts`, which resolves through that package's `dist/`. Same reason the
`tests` job builds it.

**Also:** declaring browser-loaded entrypoints (service worker `src/sw/sw.ts`) as
knip `entry` cleared several false-positive "unused dependency" findings
(`workbox-precaching`, `workbox-routing`) — check entrypoints before ignoring deps.

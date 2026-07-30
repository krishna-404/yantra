# Conventions — how we ship here

Distilled from `AGENTS.md` and the module deep-dives (`apps/*/AGENTS.md`,
`packages/AGENTS.md`). This is a working summary, not a substitute — when in doubt, read
the module's own `AGENTS.md` and match the surrounding code.

## Stack

- **Repo**: Turborepo + Yarn monorepo. Production full-stack TypeScript with E2E type
  safety and offline-first delta sync.
- **Backend** (`apps/backend`): oRPC + Orchid ORM + PostgreSQL + pg-tbus (event bus) +
  Better Auth. Event-driven; delta sync driven by Orchid ORM hooks.
- **Frontend** (`apps/frontend`): React 19 + Vite + React Router 7 + TanStack Query +
  oRPC client + Dexie.js (per-user IndexedDB) + Comlink workers + MUI + Sentry. PWA,
  offline-capable.
- **Packages**: shared Zod schemas, MUI UI components, TS configs.
- **Tooling**: Biome — tabs, 100-char width, double quotes.

## Architecture patterns

- **Bimodal docs**: `README.md` is for humans, `AGENTS.md` is for agents. Keep them in
  their lanes.
- **Two-worker isolation** (frontend): `DataWorker` (per-user Dexie DB + sync + file
  uploads) vs `MediaWorker` (stateless thumbnails + CDN). Main thread talks to workers
  **only** via Comlink proxies (`getDataProxy()` / `getMediaProxy()`); never
  `new Worker()` outside `worker.proxy.ts`.
- **Pull-based delta sync**: two-cursor pull-delta per table + push-creates for the
  offline queue. **No SSE, no long-lived socket.** Triggers: 60s interval +
  `visibilitychange` + `focus` + `online` + post-write kicks; `processQueue` is
  idempotent.
- **Per-user Dexie DB**: `dbNameFor(userId)`; signing in as another user drops the prior
  user's DB.
- **Active team = header + worker cache**: `setActiveTeam` flips the main-thread header
  cache and each worker's cache in lockstep — desync throws "Active team id mismatch."
- **Sync integrity**: offline mutations are allowed ONLY for still-unsynced records.
- **Event bus (pg-tbus)**: `tbus.emit(eventDef, payload)`;
  `tbus.registerTask(taskDef, handler)` with exponential backoff for async work
  (notifications, usage tracking).
- **Dual team model** (backend): `teams_app` (session/UI) vs `teams_api` (key/external).
- **No barrel exports** anywhere: direct file imports only, so tree-shaking works
  (`"sideEffects": false`). Within a package use relative imports; between packages use
  package `exports` paths.

## TypeScript rules

- **Strict**: no `any`, no `as unknown`, no `@ts-ignore`.
- Descriptive IDs: `userId`, `teamId` (PascalCase class, snake_case columns).
- oRPC handlers stamp server-owned identity (e.g. `authorUserId: context.user.id`) —
  never trust client-supplied ownership. Use `rpcSensitiveProcedure` for
  data-destructive actions; `rpcProtectedProcedure` for authed CRUD.

## Test rules

- **Backend**: Vitest. Test all CRUD operations. Use `createTestUserAndSession` to build
  auth context.
- **Frontend**: Playwright E2E is state-dependent — write conditional logic, don't assume
  fixed state.
- Add or update a test for every behavioral change. Never weaken, skip, or delete a test
  to get green — if a test looks wrong, stop and flag it for a human.
- Gate before finishing: `yarn lint && yarn check-types && yarn test:run` must be green.

## Environment gates vs. regressions

- A fresh checkout can show `yarn check-types` / `yarn test:run` red for reasons that
  have nothing to do with the diff. In `turbo.json`, `check-types` depends on
  `^check-types` (not `^build`) and `test:run` has no `dependsOn` at all — so a
  container that hasn't built packages yet, or has no test DB, gets false-red gates:
  - `check-types` fails with `Cannot find module '@zod-schemas/...'` until
    `packages/zod-schemas` has been built at least once (`yarn build`, or scoped:
    `yarn build --filter=@connected-repo/zod-schemas`).
  - `test:run` fails with `database "connected_repo_orpc_db_test" does not exist` until
    the test DB is provisioned: `cd apps/backend && yarn test:db:setup` (drop → create
    → migrate → seed).
  - `yarn knip` hits the same phantom-error gap: it loads the frontend `vite.config.ts`,
    which resolves through `packages/zod-schemas`' built `dist/`, so an unbuilt package
    tree produces false module-resolution failures, not real findings.
- Before treating a red gate as caused by your change, reproduce it on the unmodified
  base commit (`git stash -u`, or a clean checkout). Identical failure on the clean tree
  means it's a bootstrap gap, not a regression — bootstrap the container, don't chase it
  by editing unrelated code.

## Knip & strip-module rules

- Knip's severity tiers are the real CI acceptance bar, not just its exit code: `files`,
  `dependencies`, `devDependencies`, `unlisted` are `error` (gate CI); `exports`, `types`,
  `duplicates` are `warn` (printed every run, non-gating backlog). When wiring a
  whole-codebase linter into CI on a repo with a large pre-existing backlog, don't force
  a binary green-or-blanket-ignore choice — pin the rules you can bring to a zero
  baseline to `error`, downgrade the ones with an irreducible backlog to `warn`, and
  track that backlog as follow-up issues. A strip is "green" once the `error`-tier rules
  pass; new `warn`-tier findings it exposes in retained code are the sibling ticket's
  cleanup, not a blocker.
- A strip-module spec's stated scope (its file list, or "the workspace `package.json`"
  it names) is incomplete by construction: deleting the last consumer of a helper file,
  or the last importer of a dependency, orphans it — and the `error`-tier knip rules
  above will fail CI on that orphan even though it's outside the spec's literal edit
  list. After excising a domain, grep for every helper/dependency the removed code
  touched, including every `package.json` in the monorepo (a workspace can consume a
  hoisted root dependency without declaring it, so the orphan can surface at the root
  instead of the workspace the spec named). Delete what's now unreferenced — justified
  as an addition beyond the spec's list in the PR body, never left in or silenced with a
  knip ignore — and run `yarn install` afterward so the lockfile's merged version range
  collapses.

## Migration rules

- **Auto-gen is mandatory**: `yarn db g <name>` — never hand-write migration files.
- **Additive-only**: never rename or drop a column in the same deployment (zero-downtime,
  N-1 frontend compatibility). Deletions are two-step across deployments.
- **Snake_case columns** in raw SQL; PascalCase Orchid table classes.
- **Soft delete** via `deletedAt` is mandatory for sync compatibility — don't hard-delete
  synced rows.
- Use Orchid `afterCreate` / `afterUpdate` hooks to push entries into the sync service.

## Quick reference

- Dev: `yarn dev` · Build: `yarn build`
- Check: `yarn lint`, `yarn format`, `yarn check-types`, `yarn test:run`
- DB: `yarn db g <name>`, `yarn db up`, `yarn db seed`
- OpenAPI: `yarn gen:openapi`

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

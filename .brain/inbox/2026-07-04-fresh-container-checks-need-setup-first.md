---
title: Fresh execute containers need DB setup + a partial build before trusting red checks
---

A T0 docs-only PR (`.github/pull_request_template.md`, issue #6) showed
`yarn check-types` and `yarn test:run` red on a brand-new container with zero
repo changes. Root causes, all environment, not code:

- `check-types` failed with "Cannot find module '@zod-schemas/...'" until
  `packages/zod-schemas` was built once (`yarn build`, which can be stopped after
  that workspace succeeds — the frontend build step separately fails on missing
  Vite env vars, unrelated).
- `test:run` failed with "database ... does not exist" until
  `yarn test:db:setup` (from `apps/backend`) was run once.
- 8 backend tests failed due to a stray `NOVU_SECRET_KEY` already set in the
  container shell (not in `.env.test`), causing real Novu API calls instead of
  the expected "unconfigured" code path. Clearing it (`env -u NOVU_SECRET_KEY`)
  fixed all 8.

Lesson: before concluding a diff broke `check-types`/`test:run`, rule out
container bootstrap state (build order, missing test DB, leaked env vars) by
re-running the same command with the diff removed. If it's still red, it's
the diff; if it goes green, it's the environment.

---
title: Execute container gates are red until you build + provision the test DB
---

On a fresh execute container the three gates can be red for reasons that have nothing to
do with the diff:

- `yarn check-types` fails on backend with `Cannot find module '@zod-schemas/*.js'`
  because `packages/*` `dist` isn't built — backend type-checks against built package
  output, not source. Fix: `yarn build` first (frontend build may still fail on env
  validation with no secrets injected — that's fine; zod-schemas/backend still build).
- `yarn test:run` fails with `database "connected_repo_orpc_db_test" does not exist` —
  Postgres is running but the test DB isn't created. Fix:
  `cd apps/backend && yarn test:db:setup` (drop → create → up → seed).

Before diagnosing a red gate as caused by your change, confirm the same failure on a
clean tree (`git stash -u`). A docs-only diff (e.g. `.brain/**` markdown) cannot break
`.ts` lint/type/test, so identical failures on the clean tree = environment setup, not
regression. Consider adding these two setup steps to the execute container bootstrap so
future turns don't re-derive this.

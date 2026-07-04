# Fresh execute containers need a build + DB bootstrap before the gates go green

Symptom: `yarn check-types` fails in `@connected-repo/backend` with "Cannot find module
'@zod-schemas/enums.zod.js'" / `@connected-repo/zod-schemas/node_env`, and
`yarn test:run` fails with `database "connected_repo_orpc_db_test" does not exist` —
even on a purely docs-only diff, and even on a clean checkout of `main`/`staging`.

Root cause: `packages/zod-schemas` ships via a built `dist/`, but the `test:run` /
`check-types` turbo tasks don't declare a `dependsOn: ["^build"]`, so a fresh container
that hasn't run a build yet has no `dist/`. Separately, the backend test suite expects
`connected_repo_orpc_db_test` to already exist and be migrated/seeded.

Fix (not a code change — just container bootstrap, safe to redo every time):
```
yarn build --filter=@connected-repo/zod-schemas
cd apps/backend
NODE_ENV=test yarn db create
NODE_ENV=test yarn db up
NODE_ENV=test yarn db seed
```
(equivalently `NODE_ENV=test yarn db drop && yarn db create && yarn db up && yarn db seed`,
matching the `test:db:setup` script already in `apps/backend/package.json`).

Before concluding a gate failure means your change is broken: `git stash` and re-run the
failing gate against the unmodified base commit. If it fails identically, it's an
environment bootstrap gap, not something introduced by the diff — bootstrap the
container instead of trying to "fix" unrelated backend/db code from a docs-only spec.

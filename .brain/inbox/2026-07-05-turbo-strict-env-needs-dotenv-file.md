---
name: turbo-strict-env-needs-dotenv-file
description: Turbo 2.x strict env mode strips custom env vars from spawned tasks — supply them via a .env file, not job/process env
metadata:
  type: project
strikes: 2
---

Turbo 2.x defaults to **strict** env mode. Custom (non-system) environment
variables — e.g. `VITE_*` — set at the CI job level or in `process.env` are
**stripped** when Turbo spawns a task's child process; only a system allowlist
(`CI`, `PATH`, `HOME`, …) passes through. Verified on turbo 2.8.12: a
`VITE_PROBE=hi npx turbo run <task>` sees `CI` but not `VITE_PROBE`.

Consequence for CI: `yarn build` / `yarn test:e2e:with-build` (which run through
`turbo run`) will NOT see env vars you export in the workflow `env:` block. Vite's
`loadEnv` and libraries' `dotenv.config` read `.env*` files **from disk**, which
Turbo can't strip — so the reliable channel is an on-disk `.env` file. This is why
the existing `checks` job does `cp apps/frontend/.env.example .env` before
`yarn build`, and why the new `e2e` job writes `apps/frontend/.env.test` at
runtime rather than relying on job-level `VITE_*` vars.

**How to apply:** when a turbo-orchestrated build/test needs config env, write (or
`cp`) a `.env` file the tool loads from disk; don't assume workflow `env:` reaches
the child. Alternatively declare the vars in `turbo.json`
(`globalPassThroughEnv` / task `env`), but that's a wider change than a CI-local
`.env` write. See [[fresh-container-bootstrap]] for the related "gates go false-red
until packages are built / test DB exists" bootstrap gap.

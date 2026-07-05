---
name: e2e-typed-strip-needs-frontend-and-build-gate
description: A backend domain strip breaks the whole-repo `yarn build` because the frontend imports the backend router TYPE; the local gate (lint/check-types/test:run) misses it.
metadata:
  type: project
---

**Lesson (strip-module, E2E-typed monorepo):** stripping a backend DOMAIN cannot
land green on its own when the frontend is type-coupled to the backend router. The
frontend imports `UserAppRouter` directly (`apps/frontend/src/utils/orpc.client.ts`),
so deleting `journalEntries`/`prompts` procedures makes the frontend `tsc -b` build
fail on every `orpcFetch.journalEntries.*` / `orpcFetch.prompts.*` call — including the
D16-protected `apps/frontend/src/worker/sync/sync.orchestrator.ts` pull-cases.

**Why the local gate misses it:** the execute/harness gate is
`yarn lint && yarn check-types && yarn test:run`. Frontend `check-types` is
`tsc --noEmit` against a root tsconfig with `"files": []` + project references —
`--noEmit` does NOT traverse project references, so it checks ~zero files and passes in
<0.5s. Only `tsc -b` (run by `yarn build`) actually type-checks the frontend, and
`yarn build` is in CI's `checks` job but NOT in the harness gate. Net: harness pushes
green, CI `checks` goes red at `yarn build`, and `grade.sh` auto-FAILs on the red CI leg
before the rubric ever runs.

**How to apply:** an atomic domain strip in this repo must span backend AND frontend
(pages + `worker/` sync refs) in one PR, OR be merge-ordered frontend-first
(strip `orpcFetch.<domain>` callers before the backend procedures disappear). A
backend-only strip spec that says "frontend out of scope" is infeasible against the
whole-repo `yarn build` CI gate. Note also: knip-orphan self-clean (PR #50) does NOT
address this — it's a separate failure mode from the frontend type-coupling break.
See [[strip-knip-orphan-cascade]].

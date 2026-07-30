---
name: red-ci-can-be-a-broken-base-branch-not-your-diff
description: PR checks run against a merge commit with the base branch — a red "tests"/"coverage" leg can be pre-existing base-branch breakage, not caused by your diff
metadata:
  type: project
strikes: 1
---

On a RETRY with "CI leg red: fix the root cause," don't assume the failure lives in
your diff. GitHub Actions `pull_request` triggers check out the **merge commit** of
your branch with the current tip of the base branch (`staging` here, not `main`) — so
if the base branch has advanced and is itself broken, every open PR against it goes
red for a reason no PR-local fix can touch.

Diagnosed on issue #107 (apiKeyGenerator unit tests, PR #108): `tests` and `coverage`
failed with `GitHub 401 GET /repos/.../issues/7` inside
`ensemble_runner.yantra.test.ts`'s `runEnsembleExecute orchestration` describe block —
a test that didn't exist anywhere in this branch's own history. `yarn test:run` at the
exact PR head SHA passed 216/216 locally. `gh run list --branch staging --json
headSha,conclusion,event` showed the `push` event run for staging's current tip
(`a24b443`, merged after this branch was cut) already `failure` on the same two legs —
proof the breakage predates and is independent of this PR.

**How to apply:** when a CI leg is red and the failing test/file isn't touched by your
diff, run `git merge-base HEAD origin/<base>` and `git log HEAD..origin/<base>` to
check whether the base has moved; then `gh run list --branch <base> --json
headSha,conclusion,event` to see if the base's own `push`-triggered run is already
red at that SHA. If so, this is base-branch breakage outside a scoped spec's file
list — stop and report `NEEDS_HUMAN` with the base SHA and failing job IDs rather than
patching unrelated production code to chase a moving target.

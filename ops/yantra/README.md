# ops/yantra — runtime assets for the factory

The v0 shell loop that used to live here (`loop-tick.sh`, `advise.sh`,
`execute.sh`, `grade.sh`, `canary.sh`, `dream-nightly.sh`, `notify.sh`,
`lib.sh`, `setup-labels.sh`, `routing.json`, the systemd units and
`vps-bootstrap.sh`) is **retired**. It ran on a VPS under systemd timers, kept
its own clone of the repo, and opened PRs against a machine-level
`YANTRA_BASE_BRANCH` env var — configuration that lived outside the product,
drifted from it, and (once `staging` became a disposable preview branch) aimed
its PRs at a branch that gets force-pushed.

The factory now runs **inside the Yantra app**: tick, claim, advise, execute,
grade and auto-merge are backend services, and per-project configuration —
repo, staging/production branches and URLs, token, mode, auto-promote — lives in
`yantra_projects`, set from the UI rather than from a shell on a box.

## What's still here, and why

Everything below is fetched **at runtime** by the in-app engine. Deleting any of
it breaks the factory.

| Path | Consumed by | Purpose |
|---|---|---|
| `prompts/advise.md` | `advise_runner` | ADVISE turn prompt (§3) |
| `prompts/execute.md` | `execute_runner`, `ensemble_runner`, `free_lane_runner` | EXECUTE turn prompt |
| `prompts/grade.md` | `grade_runner` | GRADE rubric prompt |
| `prompts/dream-nightly.md` | DREAM (moving in-app) | nightly consolidation prompt |
| `Dockerfile` | builds `yantra-exec:0` | the **default** runner image every turn container uses |
| `oc/Dockerfile`, `oc/opencode.json` | `exec_image_builder` | builds `yantra-exec-oc:0` (opencode lane) |

The prompts are versioned documents the runners read from the repo at the
project's branch, so editing one changes agent behaviour without a deploy.
Prompt changes remain **T3** — the loop may never modify this directory (rail R2).

`Dockerfile` has no in-app builder yet (only the `oc` variant does). If
`yantra-exec:0` is ever pruned, rebuild it by hand:

```sh
docker build -t yantra-exec:0 ops/yantra
```

## Model routing

`routing.json` is gone. The role→model table is code now
(`turn_shared.yantra.service.ts` → `ROUTING`), so it type-checks and is pinned by
tests instead of living in a JSON file that nothing actually loaded at runtime.

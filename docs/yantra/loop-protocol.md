# Yantra Loop Protocol (v0/v1)

> **Deployment notes (2026-07-04):**
> **(D20)** The integration branch is configurable via `YANTRA_BASE_BRANCH` (v0
> default: `staging` — we always work on staging). Every mention of `main` below
> (clone base, PR target, canary branch, branch protection) reads as that base
> branch. `main` is the production branch Dokploy deploys; it moves only when a
> human promotes a green staging.
> **(D21)** Zero host-side runtime: the tick and dream orchestrators run inside
> the `yantra-exec` image (systemd `docker run`, socket-mounted, repo mounted
> read-only), spawning per-run containers as siblings. The VPS host runs only
> systemd + docker. §2.2's "on host" for advise reads as "inside the orchestrator
> container".

The exact machine. Loop v0 (Phase 0) implements this in scripts; the `apps/yantra`
harness (Phase 2) implements the same protocol and must pass the parity suite (§8).
Any behavior not specified here is a bug in this document — fix the document via PR
before changing the behavior.

---

## 1. Labels (the state machine's alphabet)

| Label | Meaning | Set by | Cleared by |
|---|---|---|---|
| `spec:ready` | Product Spec approved for intake (also = board column `Agent: ready`) | Human (or planner in P3+) | Harness on claim |
| `agent:working` | An execute turn owns this issue | Harness | Harness on PR-open / park / fail |
| `agent:pr-open` | PR exists, awaiting grade/CI/human | Harness | Merge or close |
| `needs-human` | Loop parked it; Novu push fired | Harness | Human (re-add `spec:ready` after fixing) |
| `agent:failed` | 2 attempts failed grade; parked with diagnosis comment | Harness | Human |
| `tier:T0` … `tier:T3` | Risk tier | Advise (proposed) → Grade (confirmed) | — |
| `yantra:exempt` | Loop must never touch this issue | Human | Human |

Board columns mirror labels: `Backlog → Agent: ready → In progress → PR open → Done / Parked`.

## 2. Turn state machine

```
IDLE ──poll (every 10 min)──▶ CLAIM ──▶ ADVISE ──▶ EXECUTE ──▶ GRADE ──▶ DREAM ──▶ IDLE
                                │          │           │          │
                                │          ▼           ▼          ▼
                                │      PARK(needs-  PARK/RETRY  RETRY(×1) then
                                │      human: bad   (infra      PARK(agent:failed)
                                ▼      spec)        error)
                          no capacity /
                          kill switch ⇒ exit
```

### 2.1 IDLE → CLAIM
Preconditions, checked in order; first failure ⇒ log + exit this tick:
1. `YANTRA_KILL` repo variable ≠ `"true"`.
2. Count of issues labeled `agent:working` < **3** (D18).
3. Auto-merges in the last 60 min < **4** (rail R3, §6).
4. ≥ 1 issue labeled `spec:ready` and not `yantra:exempt` and not `agent:working`.

Claim = atomically: add `agent:working`, remove `spec:ready`, comment
`🤖 yantra claim run=<ULID> role=execute model=<model>`. If the comment shows another
live claim (< 2 h old) from a different run id ⇒ back off, pick next issue.
A claim older than **2 h** with no PR is stale: any tick may reap it (remove
`agent:working`, re-add `spec:ready`, comment the reap).

### 2.2 ADVISE (plan gate — blocking, before any code)
- Input: issue body (the Product Spec), `.brain/decisions.md`, `.brain/conventions.md`,
  relevant `yantra-skills` entries (matched by the spec's `stack:` tags).
- Model: opus. Container: none needed (read-only; runs as `claude -p` on host or in the
  shared tools container).
- Output (posted as issue comment, exact fenced-JSON block so the harness can parse):

```json
{
  "verdict": "PROCEED" | "AMBIGUOUS" | "REJECT",
  "tier": "T0" | "T1" | "T2" | "T3",
  "plan": ["step 1", "step 2", "..."],
  "files_expected": ["path/…"],
  "risks": ["…"],
  "questions": ["only if AMBIGUOUS"]
}
```

- `AMBIGUOUS` or `REJECT` ⇒ park with `needs-human`, Novu push, release claim. A spec
  that triggers 12 follow-up questions is a planning failure, not an execution job.
- `PROCEED` ⇒ apply `tier:*` label, continue.

### 2.3 EXECUTE
- Container: `yantra-exec` image (see §7). Fresh clone of the repo at `main`,
  branch `yantra/<issue-number>-<slug>`.
- Prompt = Product Spec + Advise plan + `.brain/conventions.md` + matched skills.
  The execute agent MUST: implement the plan; add/update tests per the spec's
  success criteria; run `yarn lint && yarn check-types && yarn test:run` green locally
  before pushing; keep the diff inside `files_expected` ± justified additions; write a
  PR body containing: summary, spec-criteria checklist (each criterion → how satisfied →
  evidence pointer), and test output tail.
- Push branch, open PR (title `[Yantra][T<tier>] <issue title>`, closes-link the issue),
  swap labels `agent:working` → `agent:pr-open`.
- Infra failure (clone/push/API): retry once after 60 s; then park `needs-human` with
  the error tail. **Never** retry a failure by weakening tests.

### 2.4 GRADE
- Trigger: PR opened/synchronized (Phase 0: the loop tick polls; Phase 2: webhook).
- Two independent legs, both required:
  - **CI leg**: the `ci.yml` required checks, green.
  - **Rubric leg**: fresh `claude -p` (opus) container run, input = PR diff + Product
    Spec + `rubrics.md` for the confirmed tier. It re-derives the tier from the diff;
    if its tier > Advise's tier, its tier wins (tier honesty check).
  - Output posted as PR comment, fenced JSON:

```json
{
  "verdict": "PASS" | "FAIL",
  "tier_confirmed": "T0…T3",
  "criteria": [{"criterion": "…", "met": true, "evidence": "file/line, test name, or CI link"}],
  "rubric_scores": {"spec_fit": 0-2, "tests": 0-2, "scope": 0-2, "quality": 0-2},
  "failures": ["only if FAIL — each one actionable"]
}
```

- FAIL ⇒ one retry: re-enter EXECUTE with the failure list appended to the prompt
  (same branch, new commits). Second FAIL ⇒ `agent:failed` + `needs-human` + Novu.
- PASS + CI green + `tier_confirmed == T0` + rails (§6) ⇒ **auto-merge (squash)**.
- PASS + T1+ ⇒ Novu "ready for review" (batched digest, 2×/day per D13).

### 2.5 DREAM
- **Per-turn micro-write** (no PR, cheap): append one JSON line to the telemetry store
  (v0: `/opt/yantra/telemetry/runs.jsonl` on the VPS; v1: Postgres `yantra_runs`) —
  schema §5 — and, if the turn surfaced a lesson, one markdown stub into `.brain/inbox/`
  on the PR branch itself.
- **Nightly consolidation** (03:00 IST, one run, sonnet): reads the day's telemetry +
  merged/failed PRs + `.brain/inbox/*`; opens at most ONE `.brain/` PR and ONE
  `yantra-skills` PR containing only lessons that (a) generalize, (b) are supported by
  ≥ 2 independent runs or 1 run + explicit human confirmation. Everything else stays in
  inbox with a `strikes: n` counter; 3 strikes with no second occurrence ⇒ delete.
  These PRs are **T3 — never auto-merged** (D7, plan §9 "gate before autonomy").

## 3. Role prompts (v0 templates — live in `ops/yantra/prompts/`)

Templates are versioned files, not inline strings, so dream/telemetry can correlate
outcomes to prompt versions. Each file starts with `<!-- prompt-version: N -->`.

- `advise.md` — "You are Yantra's planning gate… output ONLY the JSON block…"
- `execute.md` — "You are a Yantra execute agent. Your ONLY goal is the spec below…
  You may not modify: `.github/workflows/*`, `ops/yantra/*`, `.brain/*` (outside
  `inbox/`), `LICENSE`, secrets/env files — if the spec requires it, stop and output
  `NEEDS_HUMAN: <reason>`…"
- `grade.md` — "You are Yantra's gate. You did not write this code. Be adversarial…
  verify each success criterion against the actual diff/CI evidence, never the PR
  body's claims…"
- `dream-nightly.md` — "Promote only what §2.5 allows. When in doubt, leave it in inbox."

Prompt changes are T3 (they ARE the harness).

## 4. Model routing table (v0, static — lives at `ops/yantra/routing.json`)

```json
{
  "advise":        {"lane": "claude-max", "model": "opus"},
  "grade":         {"lane": "claude-max", "model": "opus"},
  "execute.T0":    {"lane": "claude-max", "model": "sonnet"},
  "execute.T1":    {"lane": "claude-max", "model": "sonnet"},
  "execute.T2":    {"lane": "claude-max", "model": "opus"},
  "execute.T3":    {"lane": "claude-max", "model": "opus"},
  "dream":         {"lane": "claude-max", "model": "sonnet"}
}
```
Phase 3 adds `"lane": "opencode:<provider>"` entries per scorecard evidence. The file is
read fresh each turn — editing it (T3, human-merged) retunes the factory live.

## 5. Telemetry record (one line per run)

```json
{"run": "<ULID>", "turn": "<ULID>", "issue": 123, "role": "execute",
 "lane": "claude-max", "model": "sonnet", "prompt_version": 3,
 "tier": "T1", "task_type": "strip-module",
 "started_at": "...", "ended_at": "...", "wall_s": 512,
 "outcome": "grade_pass_first_try" | "grade_pass_retry" | "grade_fail" | "parked" | "infra_error",
 "pr": 45, "merged": true, "auto_merged": false, "reverted": false,
 "tokens_est": 0, "cost_usd": 0.0}
```
`task_type` comes from the Product Spec's `type:` field. This schema is the contract
for Phase 3 scorecards — extend it, never break it.

## 6. Auto-merge rails (ALL must hold; checked by the harness immediately before merge)

- **R1** `tier_confirmed == "T0"` AND rubric leg PASS AND all CI checks green.
- **R2** Diff ≤ **150 changed lines**, ≤ **5 files**, AND touches none of:
  `.github/`, `ops/yantra/`, `apps/yantra/` (once it exists), `.brain/` (outside inbox),
  `LICENSE`, `package.json` dependency sections, any file matching `*auth*`, `*secret*`,
  `*.env*`, DB migrations.
- **R3** < **4 auto-merges in the trailing 60 minutes** (repo-wide).
- **R4** `YANTRA_KILL != "true"` (re-checked at merge time, not just claim time).
- **R5** Post-merge canary: the next CI run on `main` fails ⇒ harness immediately opens
  a revert PR, labels it `tier:T0`, auto-merges it under the same rails (revert diffs
  are exempt from R2's line cap), sets `YANTRA_KILL=true`, and fires a Novu
  `needs-you-now`. A human must reset the kill switch — the loop never un-kills itself.

## 7. `yantra-exec` container image

`ops/yantra/Dockerfile`: `node:22-bookworm` + git + gh CLI + `@anthropic-ai/claude-code`
(pinned) + yarn. Run flags: `--memory=4g --cpus=2 --network=bridge`, no host mounts
except a read-only credentials file (`claude` token + PAT) injected via env-file;
workspace is cloned inside the container, discarded with it. One container = one run.

## 8. Parity suite (protects the v0 → v1 port, Phase 2)

Scenario tests, runnable against either implementation via a fake-GitHub fixture layer:
1. Kill switch on ⇒ no claim, no merge, clean exit, log line.
2. 3 issues working + 1 ready ⇒ no 4th claim.
3. Stale claim (2 h, no PR) ⇒ reaped exactly once (two harness ticks racing ⇒ one reap).
4. AMBIGUOUS advise ⇒ needs-human + Novu + claim released, issue untouched otherwise.
5. Grade FAIL → retry carries failure list → second FAIL ⇒ agent:failed, no third try.
6. T0 PASS but 160-line diff ⇒ NO auto-merge (R2), queued for human instead.
7. 4 auto-merges in the hour ⇒ 5th eligible PR waits (R3).
8. Red canary on main ⇒ revert PR + kill switch + Novu within one tick (R5).
9. Grade re-derives higher tier than Advise ⇒ higher tier wins, auto-merge blocked.
10. Telemetry line written for every run, including parked/infra-error ones.

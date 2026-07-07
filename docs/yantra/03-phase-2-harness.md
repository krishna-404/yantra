# Phase 2 — Durable Harness (`apps/yantra`)

**Goal:** port loop v0 (bash) into a proper monorepo app on the boilerplate's own
substrate — pg-tbus jobs, Orchid state tables, oRPC admin endpoints, OTEL traces —
without changing the protocol. The parity suite (loop-protocol §8) is the contract.
**Executor:** the loop (this is the factory building its own engine mounts — expect
T3 density; your review windows get heavier this phase; D13's 1–2 h/day holds).
**Entry:** Phase 1 exit green. **Target:** ~1 week.

**Why port at all:** v0 has no queue semantics (a wedged tick delays everything), no
transactional state (labels ARE the state, races are reap-heuristics), no traces, no
dashboards. The boilerplate already ships all four. This is the "wrapper calls the
engine" boundary materializing: `apps/yantra` = harness/state/telemetry; Claude Code
containers stay the engine.

**Self-modification firewall (plan §13, mandatory this phase):** every `apps/yantra`
PR deploys to a **staging instance** (second Dokploy app, `YANTRA_STAGING=1`, pointed
at a scratch GitHub repo fixture) where the parity suite runs against real GitHub
before the PR is even human-reviewed. Promotion to the live harness = your explicit
Dokploy deploy action. One-command rollback = redeploy previous image. The live loop
keeps running on v0 scripts until cutover (H9) — the factory never rebuilds the engine
it is currently flying.

Parallel groups: **A (state) → B (workers) → cutover**, with **C (surface) ∥ B**.

---

## §0 — North star: the app builds itself (tenant-zero)

The defining outcome of this phase is not "a nicer harness." It is **self-hosting**:
`apps/yantra`'s first and only project — its *tenant-zero* — is **this repo's own
`staging` branch**. After cutover (H9), the loop that improves Yantra runs *inside the
Yantra app*, driving `staging` from within, with the v0 bash executor **fully retired**.
The operator's stated first task once the app is live: set up `staging` as tenant-zero
and work on it from the app itself.

Why this framing matters for how the phase is built:

- **The app is its own first customer.** Every `apps/yantra` capability (claim, advise,
  execute, grade, dream, rails, canary) must work end-to-end against `krishna-404/yantra`
  @ `staging` — the same branch the loop has been improving since Phase 0 — not just
  against fixtures. Fixtures prove correctness; tenant-zero proves it *in production on
  itself*.
- **v0 retirement is the completion condition, not a nice-to-have.** The phase is not
  done until `systemctl disable`'d timers, `ops/yantra/` moved to `attic/`, and
  `apps/yantra` is the sole driver of `staging`. The last thing the v0 loop ever does is
  help build the successor that replaces it (expect the final `apps/yantra` PRs to be
  human-authored/-merged if v0 is already mid-retirement — see H9).
- **Tenant-zero is the capability proof for the product.** A harness that can reliably
  self-improve one repo (its own) is the seed of a harness that improves *other* repos.
  Generalizing tenant-zero → multi-tenant is Phase 4 (`05-phase-4-expansion.md`); do not
  build multi-tenant abstractions here — build the single-tenant self-hosting loop well,
  and keep the tenant identifier (`repo`, `base_branch`) a first-class column in the H1
  state tables so the later generalization is a widening, not a rewrite.

**Reconciling with the self-modification firewall (below):** the firewall governs the
*build* — while `apps/yantra` is being written, v1 exercises a **scratch fixture repo**,
never the real one, so a half-built harness cannot corrupt the repo it lives in.
Tenant-zero is the *operating state after H9 cutover* — once parity + shadow prove v1
safe, its real tenant becomes `krishna-404/yantra` @ `staging`. Firewall = scaffolding;
tenant-zero = the finished building running on its own power.

---

## Group 2.A — State model (deps: none) — mostly T2

| ID | Task | Tier | Success criteria |
|---|---|---|---|
| H1 | Orchid tables: `yantra_turns`, `yantra_runs`, `yantra_verdicts`, `yantra_telemetry` | T2 | migrations up/down clean; schema ⊇ loop-protocol §5 fields; ULID PKs (repo already ships ulid); table tests |
| H2 | State machine module | T2 | pure functions: `canClaim(ctx)`, `transition(turn, event)` encoding §2 exactly; property tests: no transition outside the diagram; the 10 parity scenarios as unit fixtures |
| H3 | Importer: v0 telemetry JSONL → `yantra_telemetry` | T1 | idempotent backfill; row counts reconcile; keeps history continuous for Phase 3 scorecards |

## Group 2.B — Workers on pg-tbus (deps: H1, H2) — T2/T3

| ID | Task | Tier | Success criteria |
|---|---|---|---|
| H4 | `yantra.tick` task + cron registration | **T3** | pg-tbus task, cron via existing node-cron+advisory-lock pattern (multi-instance safe); replaces systemd timer semantics; kill-switch check = first statement |
| H5 | Role runners (advise/execute/grade/dream) as tbus tasks | **T3** | each spawns the same `yantra-exec` docker image via dockerode; per-run OTEL span; container caps per D18 enforced in code |
| H6 | GitHub webhook receiver | T2 | replaces PR-polling: `pull_request`, `check_suite`, `push` events drive GRADE + canary; HMAC-verified; falls back to polling if webhook silent > 30 min (self-healing) |
| H7 | Novu + digest scheduler ported | T1 | needs-you/digest/killed triggered from workers; D2 workflows reused |
| H8 | Rails module | **T3** | R1–R5 as one pure `checkRails(pr, ctx)` with table-driven tests (every rail × pass/fail case); merge path calls it; NO other code path can merge |

## Group 2.C — Operator surface (deps: H1; ∥ B) — T1/T2

| ID | Task | Tier | Success criteria |
|---|---|---|---|
| H10 | oRPC admin router `yantra.*` (super-admin-gated, existing pattern) | T2 | endpoints: turns list/detail, telemetry query, kill-switch get/set (writes the GitHub variable AND a DB flag — belt and braces), park/unpark |
| H11 | Minimal cockpit page in the frontend | T2 | one route: live turns, last 20 verdicts, kill switch button, spend/quota tiles; reuses MUI + existing auth; no realtime yet — 30 s poll (SSE is Phase 4) |
| H12 | OTEL dashboards note | T1 | ops doc: trace query recipes (turn waterfall, container durations) in existing Sentry/OTEL setup |

## H9 — Cutover (the phase's grade gate) — **T3, human-executed checklist**

1. Staging parity suite: 10/10 green for 3 consecutive days of shadow operation
   (v1 on staging processes MIRRORED events from the live repo, decisions compared:
   ≥ 95% identical claim/verdict decisions, all divergences explained in writing).
2. Freeze window: `YANTRA_KILL=true`, drain working issues to terminal states.
3. Deploy v1 live; move timer off; keep v0 scripts in `ops/yantra/attic/` (revert path).
4. Unkill; watch 5 turns end-to-end with AoE open.
5. 48 h stable (0 wedged turns, 0 rail violations, telemetry unbroken) ⇒ delete
   systemd units; Phase 2 exit.

**Exit criteria:** cutover complete + parity suite green in CI permanently + v0 retired
(timers disabled, `ops/yantra/` → `attic/`) + `apps/yantra` is the **sole driver of
`staging` (tenant-zero live)** + a full week of telemetry continuity across the port
(H3 verified).

## Test cases for the phase itself

1. Chaos tick: kill the worker mid-EXECUTE (docker kill) → turn lands `infra_error`,
   telemetry row written, issue reaped within one tick, no zombie containers
   (`docker ps` clean).
2. Webhook replay: same `check_suite` delivered 3× → exactly one grade run (idempotency
   via run ULID + event dedupe table).
3. Two harness instances (scale test): advisory locks ensure single tick execution;
   parity scenario 3 (stale-claim reap race) passes with real concurrency.
4. Kill switch via cockpit button → GitHub variable + DB flag both flip; a merge
   already in flight aborts at R4 re-check.
5. Staging cannot touch the real repo: staging env's PAT is scoped to the fixture repo
   only — attempt against the real repo in a test asserts 404 (secret tiering, plan §10).

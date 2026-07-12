# Decisions — Yantra project brain

Append-only log of locked decisions. **Do not re-litigate; do not edit or delete a
prior entry.** Change a locked decision only by appending a new entry that supersedes it
(and note the supersession in the new entry). Every entry carries a date and a status:

- **locked** — decided, in force; change only via a new superseding entry.
- **open** — tracked but not yet decided; blocks nothing until resolved.

D1–D19 and OD-1…OD-3 are seeded verbatim from `docs/yantra/00-overview.md` §1. The
source table carries no per-entry dates; D1–D19 are dated to the seed date below.

---

## D1 — Name
_2026-07-03 · status: locked_

**Yantra**

## D2 — Home
_2026-07-03 · status: locked_

**New private repo `yantra`**, owned by Balkrishna Agarwal's personal GitHub account.
Bootstrapped as a full copy of `shipmyapp/connected-repo`. License replaced (see D15).

## D3 — Engine
_2026-07-03 · status: locked_

**Claude Code headless (`claude -p`) inside Docker containers**, launched by the Yantra
harness on the VPS. NOT OpenHands (deferred to Phase 4 evaluation), NOT Agent of Empires
(that is the cockpit, see D4).

## D4 — Cockpit
_2026-07-03 · status: locked_

**Agent of Empires (AoE)** installed on the VPS for human monitoring/intervention of
live agent sessions (TUI + mobile web dashboard). It never drives the loop.

## D5 — Runtime host
_2026-07-03 · status: locked_

Existing dedicated VPS (4 vCPU / 24 GB / 200 GB), **Dokploy**, nothing else runs on it.

## D6 — Harness home
_2026-07-03 · status: locked_

Bootstrap harness = scripts on the VPS (Phase 0). Durable harness = **`apps/yantra`**
workspace inside the monorepo (Phase 2), reusing pg-tbus, Orchid ORM, oRPC, OTEL.

## D7 — Grade gate
_2026-07-03 · status: locked_

CI green + model-graded rubric on every PR. **T0 auto-merges from day 1** under the rails
in §6 of `loop-protocol.md`. Everything T1+ requires human merge.

## D8 — Tracker
_2026-07-03 · status: locked_

GitHub Issues (template-enforced Product Specs) + GitHub Projects board. Column
`Agent: ready` is the intake lane.

## D9 — Memory
_2026-07-03 · status: locked_

`.brain/` folder in-repo (project brain) + private **`yantra-skills`** repo (portable
craft). All durable writes via PR only.

## D10 — Model lanes
_2026-07-03 · status: locked_

Phase 0–2: **Claude Max only** (opus for advise/grade, sonnet for T0/T1 execute + dream).
Phase 3: add free lanes (Gemini AI Studio, Groq, NVIDIA NIM — NIM key already in hand)
via an OpenCode runner container. Antigravity: parked (IDE, not headless).

## D11 — Spend cap
_2026-07-03 · status: locked_

**≤ $25/month** discretionary, hard. Optimize free + existing subs first.

## D12 — Users
_2026-07-03 · status: locked_

Solo operator (Balkrishna) in Phase 0–3. Interface = GitHub + AoE + Novu notifications.
No product UI until Phase 4.

## D13 — Review budget
_2026-07-03 · status: locked_

1–2 h/day, two windows. Loop queues ≤ 20 PRs/day for human review.

## D14 — Notifications
_2026-07-03 · status: locked_

**Novu** (already wired in the codebase, workflows-as-code). "Needs-you" = push + email.
**No quiet hours.**

## D15 — License
_2026-07-03 · status: locked_

connected-repo is AGPL-3.0-only (author owns copyright, relicensing is his right). The
`yantra` repo starts **private, "All Rights Reserved"** placeholder; final license = open
decision `OD-1`.

## D16 — Offline infra
_2026-07-03 · status: locked_

OneQ journal *domain* is stripped; the **online-first-with-offline-fallback infra stays**
(Dexie, service worker, FCM silent sync, DataWorker/MediaWorker, sync engine).

## D17 — GitHub auth
_2026-07-03 · status: locked_

Week 1: fine-grained PAT for a dedicated machine user (`yantra-bot` recommended; owner's
PAT acceptable day 1). GitHub App with JIT installation tokens = Phase 2 task Y2.8.

## D18 — Concurrency
_2026-07-03 · status: locked_

Max **3 parallel execute containers**, 4 GB RAM cap each, 2 CPU cap each.

## D19 — Deadline
_2026-07-03 · status: locked_

Phase 0 (loop live, first auto-merged PR) — **by tomorrow morning.**

---

## OD-1 — Final license
_status: open_

Final license for the `yantra` repo (starts private, "All Rights Reserved" placeholder;
see D15).

## OD-2 — OpenRouter $10 unlock
_status: open_

Fits D11; decide in Phase 3.

## OD-3 — OpenHands adoption
_status: open_

Phase 4 spike Y4.6 decides.

---

## D20 — Branch model
_2026-07-04 · status: locked_

`staging` is the integration branch — the loop branches from / PRs into / canaries
staging only; `main` is the production branch Dokploy deploys, moved only by deliberate
human promotion of a green staging.

## D21 — Zero host-side runtime
_2026-07-04 · status: locked_

Zero host-side runtime on the VPS — every loop role including the tick orchestrator runs
in a docker container; the host runs only systemd + docker (plus the units' `git pull`
ExecStartPre); secrets are injected at container start from the root-only env file
(DB-backed secret store + JIT tokens = Phase 2, Y2.8).

## D22 — Harness home is the backend app (supersedes D6)
_2026-07-07 · status: locked_

The durable harness lives in **`apps/backend/src/modules/yantra/`**, not a separate
`apps/yantra` workspace. Rationale: the harness needs the deployed HTTP server (H10
cockpit routes), the Orchid DB, and pg-tbus — all of which ARE the backend; a separate
app would duplicate boot/env/deploy for one tenant. H1 (PR #80) landed on this path;
H2+ follow it. Revisit only at Phase-4 multi-tenant extraction, as a widening.

## D23 — Secrets are project-scoped, in the DB (fulfils D21's Phase-2 clause)
_2026-07-07 · status: locked_

Harness credentials belong to **projects, not the server**. A project = repo + base
branch + its own GitHub token, stored in `yantra_projects` encrypted at rest
(AES-256-GCM, key derived from the existing `BETTER_AUTH_SECRET` — no new env var).
Tokens are write-only through the API: the cockpit shows a last-4 hint, plaintext is
decrypted just-in-time by the tick/workers and never serialized. Tenant-zero
(`krishna-404/yantra` @ `staging`) is added through the cockpit's "Add project" form
like every future project will be. `YANTRA_GH_TOKEN` (briefly added for H4 shadow) is
removed. Phase-4 multi-tenant = add a `teamId` column + team-scoped gate — a widening,
not a rewrite.

## D24 — Parity window: 24 h, decision-weighted (amends H9 step 1)
_2026-07-07 · status: locked (operator delegated the call 2026-07-07)_

The doc's "3 consecutive days" of shadow parity measures wall-clock, but an idle
backlog produces idle ticks that prove nothing. Cutover gate instead: **24 hours of
shadow operation** AND all 10 §8 parity scenarios green in CI AND every non-idle
decision in the window (a would-claim / would-reap on either side) identical between
v0 and the app, or divergence explained in writing — with a **minimum of 5
decision-bearing comparisons**; if fewer occur naturally the window extends until 5
are seen. Stricter where it matters, faster where it doesn't.

## D25 — Control plane runs on prod, operates staging
_2026-07-07 · status: locked_

The harness deployment and the code it modifies are SEPARATED: the prod deployment
(main branch, human-promoted only) runs the cockpit + tick + runners, with
`krishna-404/yantra @ staging` as its project. A broken staging merge can kill the
staging app but never the control centre; the control centre itself only changes via
deliberate promotion. Staging's own deployment keeps a cockpit for preview but holds
no projects. Corollary: during Phase 2, promote main more often than usual — each
promotion is the human gate that keeps the surgeon separate from the patient.

## D26 — Continuous, self-maintaining multi-model evaluation & routing
_2026-07-07 · status: locked_

Model choice is a graded, self-correcting loop, not a fixed config. (1) A nightly
catalog-diff lists each lane's live models and records new/retired ones (models DO get
EOL'd — e.g. NVIDIA sunset qwen2.5-coder-32b 2026-05-12). (2) Scorecards per
(model × task_type × tier) accumulate first-try pass rate + grader score (primary) and
median wall-time (secondary — quality ≫ speed ≫ cost; free ≈ $0). (3) Learned routing
picks the best model per task-type from the scorecards, speed as tie-break, excluding
throttled/retired/confidential-blocked. Fast models execute; strong-but-slow models
grade. **Grading may run on a strong FREE model** (not a permanent Claude reservation),
under three invariants: the grader is never the model that wrote the code; the
deterministic gate (CI + rails) is unchanged and a model can't merge what tests reject;
and Claude periodically re-grades a sample to audit the free grader's false-pass rate,
pulling it if it drifts. A retired/410 model instantly falls back to Claude so it can
never wedge a task. Supersedes the Phase-3 plan's "advise/grade stay claude-max
permanently" clause (R3) — that reservation becomes an audited, data-driven choice.

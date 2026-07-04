# YANTRA HANDOFF DOCUMENT — v3 (FINAL)

Written 2026-07-04 ~18:45 UTC by the Claude session that pair-built Phase 0
with Balkrishna (operator, github: krishna-404). Purpose: any successor —
human or model, however small — must be able to operate, debug, and extend
the factory using only this document plus the repo. Assume the reader has
NEVER seen the conversation that built this.

Changes vs v2 (review pass 2): added the TL;DR page and command cheat-sheet;
verified every rail/threshold number against the actual scripts (150 lines /
5 files / 2h reap / 4-per-hour cap / exact marker strings); noted the reap's
open-PR exception, the any-depth package.json rail, and the revert-PR size
exemption; consistency pass between the ledger (§2) and the TODO list (§8).

---

## TL;DR — IF YOU READ NOTHING ELSE

1. A systemd timer on the VPS runs the factory every 10 minutes. It claims
   GitHub issues labeled `spec:ready`, writes code in throwaway containers,
   opens PRs against `staging`, grades them, and auto-merges ONLY tier-T0 PRs
   under hard rails. Everything else queues for a human.
2. **Emergency stop**: set the GitHub Actions VARIABLE `YANTRA_KILL` to `true`
   on krishna-404/yantra (Settings → Secrets and variables → Actions →
   Variables). Effective within 10 min. Immediate stop:
   `sudo systemctl stop yantra-loop.timer && sudo docker rm -f yantra-tick`.
3. The factory deploys ITSELF: merging to `staging` is the deploy (each run
   starts with `git pull --ff-only` on `/opt/yantra/repo`). Only systemd unit
   file changes need a manual copy + `systemctl daemon-reload`.
4. `main` = production, touched ONLY by a human merging a staging→main PR.
   The loop must never touch `main`. The systemd loop does NOT stop when
   production goes live — it stops only at the Phase-2 harness switchover
   (§7).
5. Two OPEN operator actions block the CI-hardening backlog: the PAT needs
   the **Workflows: Read and write** permission (§4.9), and merged issues
   must be closed by hand because `Closes #N` doesn't fire on staging merges
   (§4.10).

Contents: §0 glossary · §1 what this is · §2 current state · §3 how the loop
works · §4 gotchas/sinkholes/failed experiments · §5 standing decisions ·
§6 daily ops + cheat-sheet · §7 deployment model + switchover · §8 what's
next · §9 never-do list.

## 0. GLOSSARY

- **The loop / the factory**: systemd timers on the VPS running `ops/yantra/`
  scripts in docker containers against the GitHub repo.
- **Roles**: ADVISE (plan gate, opus) → EXECUTE (writes code, sonnet by
  routing.json) → GRADE (adversarial review + merge decision, opus) → DREAM
  (telemetry + lesson stubs; nightly consolidation 03:00 IST).
- **Tiers**: T0 trivial/docs (only tier that may auto-merge) · T1 normal ·
  T2 risky (migrations…) · T3 harness/CI/protected paths (always human
  merge). Advise and grade may re-tier; the HIGHER tier always wins.
- **Labels on issues** (the state machine): `spec:ready` → `agent:working` →
  `agent:pr-open` → (human closes); failure exits `needs-human`,
  `agent:failed`; `tier:T0..T3` mirror the tier; `yantra:exempt` = loop must
  ignore the issue. 10 labels total, created by `ops/yantra/setup-labels.sh`.
- **Claim / release markers**: the loop comments `🤖 yantra claim run=…` when
  claiming. A claim is DEAD once any later comment contains "parked",
  "yantra reap", or "claim released" — that's how back-off knows an issue is
  free again.
- **Rails R1–R5**: hard auto-merge limits, enforced in code
  (`ops/yantra/grade.sh`, function `rails_check`) — see §3.
- **Kill switch**: repo Actions VARIABLE `YANTRA_KILL`. `true` ⇒ every tick
  exits at the top. Reads fail CLOSED (can't read ⇒ treated as killed).
  Humans set it; the loop only ever sets it TO true (canary), never back.
- **Canary**: post-auto-merge staging-CI health check; red ⇒ auto-revert +
  kill (§3 step 2).

## 1. WHAT THIS IS

Yantra is a self-hosted autonomous code factory in the private repo
`krishna-404/yantra`. First tenant: its own monorepo (tenant-zero) — a
Turborepo/yarn-1 app (oRPC + Orchid ORM + Postgres backend, Vite/React PWA
frontend, Biome, vitest) that the factory strips of its previous product
("OneQ" journal domain) and rebuilds per the Phase plans.

Read these repo docs IN ORDER before doing anything:
1. `docs/yantra/00-overview.md` — locked decisions D1–D19, the loop, phases
2. `docs/yantra/loop-protocol.md` — the exact state machine (labels, rails,
   telemetry contract §5, parity suite §8)
3. `docs/yantra/rubrics.md` — how PRs are graded
4. `docs/yantra/01-phase-0-live-by-morning.md` — bootstrap runbook (complete)
5. `ops/yantra/README.md` — the v0 harness files + deploy + dry-run tests
6. `docs/yantra/02-phase-1-calibration.md` — the CURRENT phase plan + exit bar

## 2. CURRENT STATE (verified against GitHub, 2026-07-04 ~18:30 UTC)

### Phase 0: COMPLETE. All P0-EXIT boxes ticked.
- First fully autonomous merge: PR #29 (issue #1, README fixes) merged by the
  loop at 16:30:14Z — claim → advise PROCEED → execute (as `node`) → CI green
  → grade PASS (checkout-verified) → rails hold → direct squash merge.
- Kill-switch drill done (17:10 tick logged `killed`; resumed 17:20 after the
  operator reset the variable).
- Canary green on post-merge staging runs.

### Infrastructure that exists and runs
- VPS (`kmj-oci-worker-0`, Ubuntu, Dokploy installed). `/opt/yantra/`:
  - `repo/` — clone of `staging`; this IS the harness deployment
  - `env/yantra.env` — chmod 600, root-only: YANTRA_REPO, GH_TOKEN
    (fine-grained PAT), CLAUDE_CODE_OAUTH_TOKEN, NOVU_SECRET_KEY (unused)
  - `telemetry/` — loop.log, runs.jsonl, automerges.jsonl, canary.state
- Docker image `yantra-exec:0` from `ops/yantra/Dockerfile` (node:22-bookworm
  + git/gh/jq/postgresql + docker-ce-cli + @anthropic-ai/claude-code@2).
- systemd: `yantra-loop.timer` (every 10 min) + `yantra-dream.timer` (03:00
  IST). Both services `git pull --ff-only` the repo in ExecStartPre —
  script changes SELF-DEPLOY on merge to staging. Unit-file changes need:
  `sudo cp /opt/yantra/repo/ops/yantra/systemd/* /etc/systemd/system/ && sudo systemctl daemon-reload`.
- GitHub: 10 loop labels; issues #1–#23 = seed backlog (numbering contract:
  `ops/yantra/seed-issues/sb-NN.md` ⇒ issue #NN); Actions variable
  YANTRA_KILL; CI `.github/workflows/ci.yml` (jobs `checks` + `tests`) runs
  on PRs and pushes to main/staging.
- App: `yantra-staging.c4elabs.com` serves the `staging` branch via Dokploy.
  Production (main) NOT deployed yet — see §7.

### Live ledger
Merged via reviewed session PRs (harness/CI fixes): #25 #26 #27 #28 #30 #31
#33 #35. Merged by the operator: #24 (Phase-0 base). Merged BY THE LOOP
autonomously: #29.

Open PRs:
- **PR #32** (staging→main, operator's) — INTENTIONALLY HELD; the production
  switchover trigger; ONLY the operator merges it (§7).
- **PR #34** (loop, issue #6, PR template, T0) — graded **PASS 8/8** at
  18:00Z; rails REFUSED auto-merge (R2: `.github/` protected path); queued
  for human squash-merge. This is the system working as designed.
- **PR #36** (loop, issue #16, `.brain/` skeleton, T3) — opened 18:15Z.
  Touches `.brain/` outside `inbox/` ⇒ rails-protected ⇒ human merge.
  Review against #16's criteria: decisions.md carries D1–D19 (dated
  2026-07-03, locked) + OD-1..3 (open) + D20/D21 (2026-07-04, locked);
  conventions.md ≤150 lines; NK-1..6 present; inbox README.

Issues:
- **#1 OPEN despite PR #29 having merged** — gotcha §4.10; close manually,
  strip stale labels.
- #2 `spec:ready` (docs pointer file; safe T0 — loop will take it).
- #3 `agent:working` + `tier:T3` — coverage CI job, executing at time of
  writing. It edits `.github/workflows/ci.yml`, so its push will likely be
  REJECTED like #4's was (§4.9). Expect a park; fix PAT, re-ready.
- #4 `needs-human` + `tier:T3` — knip CI job. Execute FINISHED but the push
  was rejected (PAT lacks Workflows write, §4.9). The branch never reached
  GitHub; the work died with the throwaway container (by design). Re-run is
  cheap: fix PAT, re-ready.
- #21 `needs-human` — AoE cockpit doc; waits for the operator to supply
  install commands (they exist nowhere in the repo; correct park).
- #22 CLOSED not-planned (operator waived Novu).
- #5, #7–#15, #17–#20, #23 — waiting on `depends-on` chains or human
  preconditions (#17 needs the operator-created `yantra-skills` repo).

## 3. HOW THE LOOP WORKS

Every 10 min systemd starts one "tick": a container (image `yantra-exec:0`,
docker socket mounted so it can spawn sibling containers, repo mounted
read-only, env file mounted read-only) running `ops/yantra/loop-tick.sh`.
A tick with an execute leg takes 10–20 min (TimeoutStartSec=45min; overlap
impossible — the timer waits for the unit AND the fixed container name
`yantra-tick` is the backstop). Any crash inside the tick exits 0 (ERR trap)
so the timer never wedges. Order inside a tick:

1. **Kill check** — YANTRA_KILL true (or unreadable) ⇒ log + exit.
2. **Canary** — latest staging `ci.yml` run red AND an un-canaried auto-merge
   in the last 24h ⇒ branch a revert from origin/staging, open + directly
   merge a revert PR (size rails waived via `--revert`), set
   YANTRA_KILL=true, notify. The loop never un-kills itself.
3. **Reap stale claims** — `agent:working` issues whose newest claim comment
   is >7200s old: if an open PR with `Closes #N` exists, labels just lagged —
   NOT reaped; otherwise comment a reap marker + flip back to `spec:ready`.
4. **Grade scan** — for every open PR labeled `agent:pr-open`:
   - Fetch PR JSON (validated — empty/failed fetch ⇒ skip this tick, §4.5).
   - CI state via Actions REST `repos/{repo}/actions/runs?head_sha=<sha>`
     (NOT `gh pr checks` — §4.7): any run not completed ⇒ PENDING (skip);
     any failure/cancelled/timed_out ⇒ FAILURE; else SUCCESS.
   - Green ⇒ rubric leg: opus in a container WITH a git checkout at the PR
     head (§4.6); verifies each spec criterion against tree + diff, with the
     harness-fetched CI run URLs as the citable CI evidence.
   - Tier honesty: grade's `tier_confirmed` vs the label — higher wins.
   - PASS + T0 + `rails_check` holds ⇒ `gh pr merge --squash` + ledger line
     in automerges.jsonl. PASS + higher tier or rails refusal ⇒ comment and
     queue for human. FAIL ⇒ ONE execute retry on the same branch with the
     failure list; a second FAIL ⇒ `agent:failed` + `needs-human`.
5. **Claim preconditions** — skip claiming if: ≥3 issues `agent:working`, or
   ≥4 auto-merges in the trailing hour, or the candidate has open
   `depends-on` issues.
6. **Claim ONE** `spec:ready` issue: claim comment + `agent:working` label.
   Back-off: an issue with a claim comment <7200s old AND no later release
   marker is considered claimed by someone else — skipped (§4.4).
7. **Advise** (opus, text-only `claude -p`): judges the spec, outputs JSON
   verdict. PROCEED ⇒ `tier:T*` label + plan saved for execute. AMBIGUOUS or
   REJECT ⇒ `needs-human` + explicit "claim released" comment.
8. **Execute** (fresh sibling container): root starts postgres + chowns, then
   ALL work as user `node` (§4.3): clone `staging`, branch
   `yantra/<n>-<slug>`, strip Novu env (§4.8), `claude -p` with the approved
   plan (`--dangerously-skip-permissions` — allowed as non-root), self-check
   `yarn lint && yarn check-types && yarn test:db:setup && yarn test:run`
   with ONE fix pass, refuse empty diffs (exit 21), push, open PR
   `[Yantra][T<n>] <title>` (body: summary, criteria checklist with evidence,
   self-check tail, `Closes #<n>`), mirror labels. Infra failure ⇒ one retry
   after 60s ⇒ park with error tail.
9. **Dream micro** — telemetry line to runs.jsonl (contract: loop-protocol
   §5); execute also commits ONE `.brain/inbox/` lesson stub per turn
   (protocol §2.5 — graders must never count it as scope creep, §4 spec-bugs).

**Rails** (`grade.sh:rails_check`, verified against code):
- R1: rubric verdict PASS and tier T0 — nothing else auto-merges.
- R2: ≤150 changed lines (adds+dels), ≤5 files (both waived for `--revert`);
  NO file matching: `^.github/`, `^ops/yantra/`, `^apps/yantra/`,
  `^LICENSE$`, `auth`, `secret`, `.env`, `migrations/`, `^.brain/` (except
  `^.brain/inbox/`); NO `package.json` at ANY depth.
- R3: <4 auto-merges in the trailing 60 min (automerges.jsonl).
- R4: YANTRA_KILL re-checked at merge time.
- R5: canary (step 2) — revert + kill on post-merge red.

## 4. GOTCHAS, SINKHOLES, FAILED EXPERIMENTS

Ten numbered lessons from live fire. 1–8 FIXED in code; **9–10 OPEN — they
need operator action.**

1. **CI tests job missing dist/** (fixed, PR #25). Backend tests resolve
   `@connected-repo/zod-schemas` via package exports to `dist/`; fresh CI
   checkouts have no dist. Fix: tests job builds zod-schemas first. LESSON:
   verify from a CLEAN tree — a local pre-verify passed only because of an
   earlier build in the same tree. Related: turbo caches `test:db:setup`;
   use `npx turbo run … --force` when reproducing CI failures.
2. **Tick timeout too small** (fixed, PR #26). TimeoutStartSec was 9min; an
   execute tick takes 10–20. systemd killed the orchestrator mid-run (the
   sibling exec container survives, but label swaps die). Now 45min.
3. **Claude Code hard-refuses `--dangerously-skip-permissions` as root**
   (fixed, PR #26). In the exec container root does only privileged prep
   (postgres start, `chown /workspace`); everything else runs as user `node`
   via `su node -p` with HOME=/home/node. Text-only roles (advise/grade)
   don't need the flag — reads are permissionless.
4. **Claim back-off ignored releases** (fixed, PR #28). The 2h back-off
   counted the claim comment of an already-PARKED attempt, making every
   park→fix→re-ready cycle stall 2h. Fix: all parks/reaps post release
   markers ("parked" / "yantra reap" / "claim released"); back-off honors
   only claims with NO release marker after them.
5. **Silent PR-fetch failure ⇒ grade runaway** (fixed, PR #30). An 11-field
   `gh pr view --json` failed silently ⇒ empty sha ⇒ the CI-pending skip,
   per-SHA dedupe, and fail counter all ran on empty data ⇒ grade/retry
   fired every tick (3 cycles live). CONTAINMENT: remove the PR's
   `agent:pr-open` label — the scanner goes blind to it instantly. Fix:
   validate the fetch; empty ⇒ bail to next tick.
6. **Grader had no eyes** (fixed, PR #30). The rubric leg saw only the diff;
   state criteria ("grep X → 0 hits") failed for absence-of-a-hunk even when
   true in the tree — the grader even wrote "no repo checkout in /workspace"
   as evidence. Believe your tools' complaints. Fix: grade container clones
   and checks out the PR head; prompt v2 orders tree verification.
7. **Fine-grained PATs have NO Checks permission — it does not exist for
   that token class** (architecture, PR #31). `gh pr checks` and GraphQL
   `statusCheckRollup` can NEVER work here (Checks perms are GitHub-App-only).
   The CI leg reads Actions REST (`…/actions/runs?head_sha=…`, needs only
   Actions:Read). Do not "fix" this back. Stands until Phase 2's GitHub App.
8. **Secrets leak into the self-check** (fixed, PR #35). `--env-file`
   injects ALL keys into every run container; NOVU_SECRET_KEY isn't in
   `.env.test` so dotenv can't shadow it ⇒ notification tests hit the REAL
   Novu API. The executor itself diagnosed and disclosed this in PR #34's
   body — the disclosure pipeline works. Fix: work script unsets NOVU_* up
   front. GENERAL RULE: a run container gets ONLY the secrets its role needs.
9. **OPEN — the PAT cannot push workflow changes.** Issue #4's execute
   finished its work, then push was rejected: *"refusing to allow a Personal
   Access Token to create or update workflow .github/workflows/ci.yml
   without workflow scope"*. Fine-grained PATs need the **Workflows: Read
   and write** repository permission for any commit touching
   `.github/workflows/**`. Every CI-group issue (#3 #4 #5 #7) parks at the
   push until this is granted. OPERATOR FIX (~5 min):
   github.com/settings/personal-access-tokens → the Yantra token →
   Repository permissions → Workflows → Read and write → save. Token VALUE
   is unchanged ⇒ no VPS edit needed. Then re-ready #4 (and #3 when it
   parks). These PRs still end human-merged — rails protect `.github/`
   regardless of tier.
10. **OPEN — `Closes #N` never auto-closes issues here.** GitHub auto-closes
   linked issues only when a PR merges into the DEFAULT branch (`main`); the
   loop merges into `staging`. Merged work therefore leaves its issue open —
   issue #1 is open right now with a stale `agent:pr-open` label though PR
   #29 merged hours ago. Harmless to the loop (grade scans PRs, not issues)
   but it corrupts the "what's done" view and Phase-1 exit metrics. UNTIL
   FIXED: close the linked issue after every merge (§6 routine). PROPER FIX:
   file a T3 spec — grade.sh closes the linked issue after a successful
   auto-merge, and the morning routine covers human merges. (Switching the
   default branch to staging would also work but shifts every PR-base
   default; not worth the churn.)

### Spec-authoring bugs (caught by the advise gate — it does planning QA)
- #16 referenced "final plan §17" — a document that exists OUTSIDE the repo —
  and demanded per-entry dates the source table doesn't carry. Fixed by
  inlining the content and pinning an explicit dating rule. LESSON: every
  pointer in a spec must resolve INSIDE the repo; a spec must never require
  inventing facts.
- #21 requires AoE install commands present nowhere in the repo ⇒ correctly
  parked until the operator supplies them.
- Protocol conflict: execute MUST commit a `.brain/inbox/` lesson stub
  (§2.5), but SB-1 said "diff touches ONLY README.md" ⇒ false scope FAIL.
  Grade prompt v2 codifies: ONE inbox stub is protocol output, never a
  scope violation. When writing specs say "only file X plus the
  protocol-sanctioned inbox stub".

### Environment/platform sinkholes
- **raw.githubusercontent.com returns 404 (not 403) for private repos
  without auth** — "not found" from a curl|bash bootstrap usually means
  missing token, not a wrong URL.
- **GitHub Free plan + private repo: the "Allow auto-merge" setting and full
  branch protection DO NOT EXIST.** `gh pr merge --auto` can never work.
  The harness merges directly — safe because grade merges only after
  CI-green + rubric PASS + rails. CI-green enforcement lives in grade.sh,
  NOT in GitHub ⇒ humans must also never hand-merge red PRs; nothing on
  GitHub's side will stop you.
- **The Dokploy app container is NOT the VPS.** It's Alpine with only
  dist/ — running ops scripts inside it fails ("bash: not found"). The
  factory lives on the HOST (ssh + sudo).
- **/opt/yantra is root-owned (750)** — globs as the ubuntu user silently
  expand to nothing. Wrap reads in `sudo sh -c '…'`.
- **Novu 401** = wrong key or EU region (NOVU_API_URL=
  https://eu.api.novu.co). Moot — Novu waived; notify.sh no-ops. Don't "fix".
- Sandbox-only findings (the dev environment that built this, NOT the VPS):
  Docker Hub CDN egress-blocked (mirror.gcr.io worked); Debian apt mirrors
  blocked; npm needed NODE_EXTRA_CA_CERTS for the proxy CA; a fake `docker`
  stub reading stdin hung the test suite intermittently — fake binaries in
  tests must `exec 0</dev/null` (see `ops/yantra/tests/stub-tick-test.sh`).

### Failed/rejected experiments (do not retry)
- `gh pr checks` / statusCheckRollup with the PAT — permanently dead (§4.7).
- Novu notifications for the loop — waived (issue #22 closed not-planned).
- Token-in-database for loop credentials — REJECTED for Phase 0/1: kill and
  canary must work when the DB is down or mid-migration. Env file until
  Phase 2 (Y2.8: GitHub App + JIT tokens, DB-backed secret store).
- Webhooks for instant loop reactions — deferred to Phase 2 by design
  (loop-protocol §2.4: v0 polls). Do not bolt a listener onto v0.

## 5. STANDING OPERATOR DECISIONS (beyond D1–D19)
- **D20**: `staging` = the loop's integration branch (branch from, PR into,
  canary — staging only). `main` = production, moved only by deliberate
  human promotion of a green staging.
- **D21**: zero host-side runtime — every loop role including the tick
  orchestrator runs in a container; the host runs only systemd + docker
  (+ the units' git-pull ExecStartPre); secrets injected at container start
  from the root-only env file.
- Delegation to the assistant session: MAY open+merge harness/ops PRs after
  thorough verification (must print what the operator should spot-check),
  manage issue lifecycle (amend specs, re-ready, close) as delegate, work
  overnight unattended. May NOT: merge PR #32 or touch `main`, unset
  YANTRA_KILL, weaken rails/tests/specs.
- Novu waived ("once the app is up I will be notified and that's enough").
  A deploy-health canary via Dokploy webhook is a good future spec — the
  operator offered to wire webhooks.

## 6. DAILY OPERATIONS (the 10-minute morning routine)

On the VPS:
```bash
sudo tail -50 /opt/yantra/telemetry/loop.log
sudo jq -r '[.started_at,.role,.issue,.outcome]|@tsv' /opt/yantra/telemetry/runs.jsonl | tail -30
sudo cat /opt/yantra/telemetry/automerges.jsonl   # the R3 ledger — what self-merged
```
On GitHub:
1. Review + merge the human queue: every PR graded PASS but rails-refused or
   tier>T0 (the grade verdict comment is your first-pass review — read it,
   then the diff).
2. **Close each merged PR's linked issue** (§4.10) and strip stale labels.
3. For each `needs-human`/`agent:failed` issue: read the park comment (it
   contains the diagnosis tail), fix the spec or the world, remove failure
   labels, re-add `spec:ready`. Parks left release markers, so the next tick
   can claim immediately.
4. Release more backlog as `depends-on` parents close.

Cheat-sheet (any machine with `gh` authenticated to the repo):
```bash
gh variable list -R krishna-404/yantra                     # kill-switch state
gh variable set YANTRA_KILL -R krishna-404/yantra -b true  # STOP (human-only to set false!)
gh issue edit N -R krishna-404/yantra --remove-label needs-human --remove-label agent:failed --add-label spec:ready   # re-ready
gh issue close N -R krishna-404/yantra -c "Done in PR #M." # close after merge
gh pr edit N -R krishna-404/yantra --remove-label agent:pr-open  # blind grade to a runaway PR
gh pr merge N -R krishna-404/yantra --squash               # human merge (ONLY if CI green + graded PASS)
```
Panic buttons, in escalating order:
- Soft stop: `gh variable set YANTRA_KILL … -b true` (≤10 min).
- Hard stop: `sudo systemctl stop yantra-loop.timer && sudo docker rm -f yantra-tick`.
- One misbehaving PR: strip its `agent:pr-open` label, investigate calmly.
- After a canary kill: investigate the red run FIRST; only a human ever sets
  YANTRA_KILL back to false.

## 7. DEPLOYMENT MODEL + SWITCHOVER
("when do we switch over, and when does the systemd job stop?")

Two separate machines share the VPS. Never confuse them:
- **The FACTORY** = systemd timers + containers + `ops/yantra/`. NOT the
  app. It keeps running through every app deploy, forever, until the Phase-2
  harness switchover below. App deployment never stops it.
- **The APP** = the monorepo backend+frontend, deployed by Dokploy from git.

Target model (operator's goal): `main` runs the production app online; the
loop continuously improves `staging`; humans promote staging→main when
proven.

Where reality stands:
- Self-building on staging: **ALREADY TRUE** — yantra-staging.c4elabs.com
  tracks `staging` and the loop merges improvements into `staging`.
- Production from main: NOT YET — `main` is still the pre-Phase-0 commit;
  PR #32 (staging→main) is held for the operator.

SWITCHOVER RUNBOOK (operator, ~30 min, at the 10AM review):
1. Read the night's ledger (§6) and click through the staging app — healthy?
2. Squash-merge **PR #32**. `main` now equals reviewed staging. (If staging
   moved after your review, refresh the PR first — merge the diff you read.)
3. In Dokploy: create/repoint PRODUCTION backend+frontend services at branch
   `main` with the production domain + env (data setup — fresh DB vs
   promoted — is the operator's call; the factory doesn't care). Deploy,
   verify health endpoints.
4. Rhythm from then on: loop works `staging` → operator reviews →
   opens/refreshes staging→main PR → human merges → Dokploy redeploys
   production. Promotion is ALWAYS a human act in Phase 1 (D20). Automating
   it (auto-PR after N green days) is a future T3 spec — file it, don't
   improvise it.
5. The systemd loop does NOT change at this switchover. Do not stop the
   timers.

WHEN DOES THE systemd LOOP EVER STOP? Only at the Phase-2 harness
switchover, on mechanical criteria:
- The loop builds `apps/yantra` (durable in-app harness: pg-tbus scheduling,
  Postgres state, webhooks) per `docs/yantra/03-phase-2-harness.md`.
- Gate 1: v1 passes the parity suite (loop-protocol §8, all 10 scenarios)
  against fake-GitHub fixtures.
- Gate 2: SHADOW MODE for several days — v1 runs alongside v0; v0 KEEPS
  AUTHORITY; decisions compared in telemetry.
- Only after both: `sudo systemctl disable --now yantra-loop.timer
  yantra-dream.timer`; mark `ops/yantra/` retired in the docs.
- Rollback = re-enable the timers. Keep `ops/yantra/` green in tests until
  v1 has survived alone for a full phase.

## 8. WHAT NEEDS TO BE DONE (ordered)

Operator, morning of 2026-07-05 (est. 45 min total):
1. PAT: add **Workflows: Read and write** (§4.9) — unblocks #3 #4 #5 #7.
2. Review + squash-merge PR #34 (T0 PASS, rails-refused only for the
   `.github/` path); close issue #6, strip labels.
3. Review PR #36 against #16's criteria (§2 has the checklist); merge; close
   #16.
4. Close issue #1 (§4.10), strip stale labels.
5. Re-ready #4 (and #3 if parked): remove failure labels, add `spec:ready`.
6. Merge PR #32 + Dokploy production switchover (§7 runbook).
7. Unpark #21 (paste AoE install commands into the spec) or close it.
8. Create private `yantra-skills` repo; add YANTRA_SKILLS_REPO to
   `/opt/yantra/env/yantra.env` (unblocks #17→#18→#19).
9. Optional but recommended: file two T3 specs — (a) grade.sh auto-closes
   the linked issue after merge (§4.10); (b) deploy-health canary via
   Dokploy webhook.

Phase 1 (loop does the work; human reviews 1–2h/day; plan:
`docs/yantra/02-phase-1-calibration.md`):
- 1.A CI hardening: #3 coverage → #4 knip → #5 e2e → #7 protection (all
  T3/human-merge; all need the PAT fix).
- 1.B strip OneQ: #8→#9→#10 backend chain; #11→#12 frontend; #13 schemas;
  #14 migration (T2 — check its down-path rule); #15 closes the group.
- 1.C brain/skills: #16 (in PR), #17/#18/#19 (need the skills repo), #20.
- 1.D ops docs: #21, #23.
- EXIT BAR: ≥12 loop PRs merged, ≥70% first-try grade pass, 0 unreverted
  regressions — measured from runs.jsonl.

Phase 2+ (docs/yantra/03..05): `apps/yantra` durable harness (parity →
shadow → switchover §7), GitHub App + JIT tokens (kills BOTH PAT limits §4.7
+ §4.9), webhooks, AoE cockpit; Phase 3: free-model lanes + telemetry-driven
routing; Phase 4: expansion.

## 9. THINGS A SUCCESSOR MUST NEVER DO
- Never bypass rails or hand-merge a red PR — GitHub will NOT stop you
  (free-plan, §4); only discipline does.
- Never set YANTRA_KILL back to false after a canary kill without a human
  investigating the red run first.
- Never let the loop — or yourself without the operator — touch `main`.
- Never put secrets in images, code, logs, chat, or GitHub. The root-only
  env file is their only home.
- Never "fix" a grade FAIL by weakening tests or the spec — it destroys the
  only trust signal the factory has.
- Never edit `ops/yantra/` outside a reviewed PR — it is the machine itself.
- Never run factory workloads directly on the VPS host (D21) — containers
  only.
- Never trust a green local check that wasn't run from a clean tree (§4.1).

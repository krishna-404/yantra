# Yantra — CV / cover-letter highlights

Talking points for the "mid/senior dev, builders who augment their dev workflow with AI"
posting (US/Utah company, remote, two roles: computer vision + platform).

Everything below is verifiable from this repo's git history and GitHub PR list.

---

## 1. The one-line version

> Built **Yantra**, a self-hosted autonomous code factory that plans, implements, reviews
> and merges its own pull requests — then used it to build itself. **65 of the last 79
> merged PRs in the repo were authored end-to-end by the loop**, under hard auto-merge
> rails and a model-graded rubric, in about four weeks.

That sentence is the whole pitch for this posting. They asked for someone who augmented
their dev workflow with AI; most applicants will say "I use Copilot / Claude Code daily."
The differentiator here is that the workflow itself is the engineering artifact.

---

## 2. Their ask → your evidence

| What the post asks for | What Yantra demonstrates |
|---|---|
| "Builders who have augmented their dev workflows with AI to increase velocity and throughput" | Didn't just adopt a tool — designed, shipped and operated a four-role agent loop (advise → execute → grade → dream) with GitHub Issues as intake and CI + rubric as the gate. 82% of merged PRs are machine-authored. |
| "Experimental mindset… assist with A/B testing on certain features" | The execute stage runs **N models in parallel on the same task**, then a judge model *synthesises* one diff from all candidates. Telemetry writes one row per candidate model per run, so each model is scored over time on real outcomes (first-try pass rate, retry rate, wall time). That's A/B testing with a production success metric, not a vibes benchmark. |
| Platform role: "api infra, user hierarchies" | The substrate is a multi-tenant TypeScript platform: teams + role-based membership + pending invites matched on signup, tenant scoping enforced at the ORM query-scope layer, oRPC for internal APIs + REST/OpenAPI for external, token-bucket rate limiting with optimistic-lock retry, API-key auth, AES-256-GCM sealed per-project secrets. |
| Poster's stated worry about "negative reactions on AI adoption" | The most useful thing you bring: **autonomy with rails**. Every safety mechanism below exists because unbounded agent output is the failure mode, not the goal. This is the reassuring version of AI velocity — the one a skeptical senior engineer can actually accept. |

---

## 3. Verified numbers

| Metric | Value | Source |
|---|---|---|
| PRs authored + merged by the loop | **65** | GitHub search, `"[Yantra]" in:title is:merged` |
| Total merged PRs in repo | 79 | GitHub search |
| Share machine-authored | **~82%** | derived |
| Elapsed time | ~4 weeks (spec committed 2026-07-03 → 2026-07-30) | `git log` |
| Bootstrap harness (v0, bash) | ~1,265 lines across 10 scripts | `ops/yantra/` |
| Durable harness (v1, TypeScript) | ~5,000 lines, 20+ services, each with tests | `apps/backend/src/modules/yantra/` |
| Parity scenarios protecting the v0 → v1 port | 10 | `docs/yantra/loop-protocol.md` §8 |
| Hard monthly model spend cap | ≤ $25 (free lanes primary: Groq, NVIDIA NIM, OpenCode Zen) | decision D11, `ops/yantra/oc/opencode.json` |

---

## 4. The engineering worth talking about

**The gate, not the generator.** Anyone can make a model write code. The interesting work
is what refuses to merge it:

- **Adversarial grader.** A separate model, explicitly told it did not write the code,
  scores the diff on four dimensions (spec fit / tests / scope / quality). *Evidence or it
  didn't happen* — every "criterion met" must cite a file:line, a test name visible in CI
  output, or a CI check URL. The PR body's own claims are inadmissible.
- **Tier-honesty check.** The planner proposes a risk tier (T0 mechanical → T3 sensitive);
  the grader re-derives it from the diff alone, and the *higher* tier wins. An agent cannot
  downgrade its way into auto-merge.
- **Auto-merge rails (R1–R5), all of which must hold:** confirmed low tier + rubric pass +
  CI green; diff ≤ 150 lines and ≤ 5 files touching none of `.github/`, the harness itself,
  `LICENSE`, dependency sections, migrations, or any path matching `*auth*` / `*secret*` /
  `*.env*`; fewer than 4 auto-merges in the trailing hour; kill switch re-checked *at merge
  time*, not just at claim time.
- **Post-merge canary with auto-revert.** If the next CI run on the base branch goes red,
  the harness opens a revert PR, merges it, sets the kill switch, and pages a human. The
  loop can stop itself; it can never un-stop itself. A human resets the switch.
- **Failure is bounded.** Grade fail → exactly one retry, with the grader's failure list
  appended to the prompt. Second fail → parked with a diagnosis comment and a push
  notification. No third attempt, ever. The grader is also forbidden from suggesting the
  spec be weakened — a bad spec routes to a human, which is the correct outcome.

**Memory that has to earn its place.** A `.brain/` directory holds decisions, conventions
and an append-only *negative-knowledge* log (approaches tried and deliberately rejected,
with reasons, so the loop stops re-proposing them). Per-turn lessons land in an inbox; a
nightly consolidation run promotes only lessons supported by ≥ 2 independent runs or 1 run
plus explicit human confirmation, and unsupported entries expire after 3 strikes. Brain
promotions are classed T3 — never auto-merged.

**Operational reality, not a demo.** Runs on a single VPS; every role runs in a
memory- and CPU-capped throwaway container with no host mounts; max 3 concurrent execute
containers; stale claims older than 2h are reaped; the tick is contractually required to
exit 0 so a crash can never wedge the timer; the loop prunes its own Docker disk when the
volume drops below 15 GB and refuses to start new heavy work below 8 GB.

**It builds itself.** PRs #94–#127 are the loop shipping its own Phase 3 and 4 features:
the free-model lane registry, the parallel ensemble, the operator cockpit, the spec-intake
engine, and the multi-tenant projects + Routines schema.

---

## 5. Resume bullets

Pick 3–4. Numbers first, mechanism second.

- Designed and shipped **Yantra**, a self-hosted autonomous code factory (four-role agent
  loop: plan → implement → adversarially grade → learn) that took GitHub Issues as intake
  and opened, verified and merged its own PRs; **65 of 79 merged PRs (~82%) were authored
  end-to-end by the system**, including the majority of its own later feature work.
- Engineered the safety envelope that made autonomous merging acceptable: model-graded
  rubric with evidence citations, a tier-escalation check the agent can't game, diff-size
  and protected-path limits, hourly merge budget, a kill switch re-verified at merge time,
  and a post-merge canary that auto-reverts and halts the system on a red base branch.
- Built a **parallel multi-model ensemble** — N models solve each task concurrently in
  isolated containers, a judge model synthesises a single diff, and per-candidate telemetry
  scores each model on first-try pass rate and wall time — turning model selection into a
  data-driven A/B decision. Kept total model spend under a hard **$25/month** cap by
  routing to free lanes.
- Ported the bootstrap harness (~1,265 lines of bash) to a durable TypeScript service
  (~5,000 lines, 20+ unit-tested services on Postgres + a Postgres-backed event bus),
  protected by a 10-scenario parity suite written before the port.
- Built the multi-tenant platform underneath it: team hierarchies with role-based
  membership and invite-on-signup matching, tenant isolation enforced at the ORM query-scope
  layer, oRPC internal APIs alongside REST/OpenAPI external APIs, token-bucket rate limiting,
  API-key auth, and AES-256-GCM-sealed per-project credentials kept out of server env.
- Built an offline-first React 19 PWA with delta sync over silent push, a two-worker
  architecture (data + media), OPFS-backed media storage, and idempotent conflict-merge
  recovery.

---

## 6. Cover-letter draft

> I'm applying for the platform role.
>
> For the last month I've been building **Yantra**, a self-hosted autonomous code factory:
> GitHub Issues go in, and a four-role agent loop plans the change, implements it in a
> sandboxed container, grades the resulting diff against a rubric, and — if it passes CI,
> the rubric, and a set of hard rails — merges it. 65 of the last 79 merged PRs in that
> repo were written end-to-end by the loop, including most of the loop's own later
> features.
>
> I mention the ratio because your post asks for someone who has augmented their workflow
> with AI, and I think the interesting half of that work isn't the generation — it's the
> gate. The grader is a separate model that's told it didn't write the code and must cite
> a file:line or a CI check for every claim it accepts. The planner proposes a risk tier
> and the grader re-derives it independently, with the higher tier winning, so nothing can
> downgrade itself into an auto-merge. Diffs over 150 lines, or touching auth, secrets, CI
> or migrations, are never eligible. If the base branch goes red after a merge, the system
> opens a revert, merges it, halts itself, and pages me — and it can't restart itself. My
> read is that AI velocity gets adopted at the rate the rails are trusted, which is
> probably close to the honest feedback you were asking for in your post.
>
> On the platform side specifically, the substrate is a multi-tenant TypeScript monorepo I
> built and run: team hierarchies with role-based membership and pending invites resolved
> at signup, tenant isolation enforced in the ORM's default query scopes rather than
> per-endpoint, oRPC for internal APIs with REST/OpenAPI for external consumers,
> token-bucket rate limiting, API-key auth, and per-project credentials sealed with
> AES-256-GCM so they never sit in the server's environment. The most recent change was
> widening single-operator projects to team-owned ones — the kind of user-hierarchy work
> your platform role describes.
>
> On the experimentation angle: every task runs through several models in parallel and a
> judge synthesises one diff from the candidates, with telemetry recording a row per
> candidate so each model gets scored on real outcomes over time. It's A/B testing where
> the success metric is "did this merge on the first try," which has been more informative
> than any benchmark I could have read. The whole thing runs under a hard $25/month cap.
>
> Happy to walk through the repo, the failure cases, and the things I got wrong first.

---

## 7. Interview prep — lead with these

1. **"Where did it fail?"** Have two real answers ready. Good candidates from the repo's
   own history: the ping-pong sync update loops, the CI red that turned out to be a broken
   base branch rather than the diff (`.brain/inbox/2026-07-12-…`), models that hung and
   forced per-agent timeouts, and the disk-exhaustion problem that made the loop its own
   janitor. Talking about the negative-knowledge log is stronger than talking about the
   success rate.
2. **"Isn't this just letting AI write your code?"** No — the merge criteria are stricter
   than most human review processes. Walk through the rails. This is the answer that
   converts a skeptical interviewer.
3. **"How would you apply this here?"** Don't propose auto-merging into their repo on day
   one. Propose the gate first: rubric-graded PR review running in shadow mode, telemetry
   on where it agrees and disagrees with human reviewers, and only then a discussion about
   which tier of change earns autonomy. Shadow mode before live mode is already a
   first-class concept in Yantra (`mode: "shadow" | "live"` per project) — that's a
   credible, low-threat adoption story for a team that has pushed back on AI before.

---

## 8. Honest gaps

- **There is no computer vision in this project.** Apply to the platform role. If you want
  the CV role, this repo argues you're a strong systems engineer with unusual AI-tooling
  depth, but it's not domain evidence — don't imply otherwise.
- **Solo project, one repo.** Present it as a system you designed, operated and iterated on,
  not as team-scale delivery. The multi-tenant work is real but the tenant count is one.
- **The repo is private.** Prepare a walkthrough — a short screen-share of the loop
  protocol doc, the rails section, and a merged `[Yantra]` PR with its grade comment will
  land better than a link they can't open.

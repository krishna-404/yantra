# DAILY.md — the 10-minute morning ops one-pager

The fixed morning routine for the loop operator (D13: 1–2 h/day budget, this is the
first ~10 min of it). Run top-to-bottom once each morning; every block is
copy-pasteable and grounded in the real `ops/yantra/` scripts and telemetry paths.
Two decision points at the bottom close the loop.

> **Setup (once per shell).** SSH to the VPS and land in the deployment clone so `gh`
> resolves the repo automatically and the telemetry paths below are absolute:
>
> ```bash
> cd /opt/yantra/repo          # the clone IS the deployment (see README.md)
> ```
>
> Telemetry lives under `/opt/yantra/telemetry/` (`lib.sh`: `YANTRA_TELEMETRY_DIR`):
> `loop.log`, `runs.jsonl` (one JSON line per run), `automerges.jsonl` (the R3 ledger).

---

## 1 · Telemetry tail — what did the loop do overnight? (~2 min)

Last 50 log lines (one line per state transition; errors and parks stand out):

```bash
tail -50 /opt/yantra/telemetry/loop.log
```

Yesterday's run outcomes, tallied from `runs.jsonl` (`started_at` is UTC ISO-8601):

```bash
jq -r --arg d "$(date -u -d yesterday +%F)" \
  'select(.started_at | startswith($d)) | .outcome' \
  /opt/yantra/telemetry/runs.jsonl | sort | uniq -c
```

One line per run yesterday — role, outcome, tier, PR, merged — for a closer look:

```bash
jq -r --arg d "$(date -u -d yesterday +%F)" \
  'select(.started_at | startswith($d))
   | [.role, .outcome, .tier, ("#"+(.pr|tostring)), ("merged="+(.merged|tostring))]
   | @tsv' \
  /opt/yantra/telemetry/runs.jsonl | column -t
```

Look for: `grade_fail`, any `reverted:true`, or a `task_type` that ran long (`wall_s`).

---

## 2 · Parked issues — what is waiting for you? (~2 min)

Everything the loop parked (advise/execute parks add `needs-human`; a second grade
FAIL adds `agent:failed` on top — see `advise.sh`, `execute.sh`, `grade.sh`):

```bash
gh issue list --label needs-human --state open
```

The subset that burned both grade attempts (needs a fix or a close, not just a nudge):

```bash
gh issue list --label needs-human --label agent:failed --state open
```

---

## 3 · Kill-switch state — is the loop actually live? (~1 min)

The kill switch is the GitHub Actions repo variable `YANTRA_KILL` (`lib.sh`
`kill_switch_on`). `true` = killed; **unset or unreadable also counts as killed**
(fail-closed), so confirm it reads exactly `false`:

```bash
gh api "repos/{owner}/{repo}/actions/variables/YANTRA_KILL" --jq '.value' \
  2>/dev/null || echo "unset → loop treats as KILLED (fail-closed)"
```

To flip it (e.g. after resolving an incident the canary tripped):

```bash
gh variable set YANTRA_KILL --body false    # arm the loop
gh variable set YANTRA_KILL --body true     # halt everything at the next transition
```

---

## 4 · R3 ledger — auto-merge rate (~1 min)

R3 caps auto-merges to 4/hour (`loop-tick.sh`). Count the trailing hour exactly the
way `lib.sh` `automerges_last_hour` does:

```bash
jq -r --arg c "$(date -u -d '60 minutes ago' +%Y-%m-%dT%H:%M:%SZ)" \
  'select(.ts > $c) | .pr' \
  /opt/yantra/telemetry/automerges.jsonl 2>/dev/null | wc -l
```

The last few auto-merges (PR, sha, whether the canary has cleared them):

```bash
tail -10 /opt/yantra/telemetry/automerges.jsonl 2>/dev/null | jq -c '.'
```

An hour sitting at the cap of 4 means the loop stalled new claims — worth a look.

---

## 5 · Disk / RAM — is the host healthy? (~1 min)

The 50 G volume is shared with Dokploy builds; `loop-tick.sh` self-prunes under 15 G
free and refuses new claims under 8 G. Eyeball headroom:

```bash
df -h /opt/yantra
free -h
```

Under ~15 G free, the loop should have pruned already; under ~8 G it is skipping new
work — clear space (`docker image prune -f`, `docker builder prune -f`) or escalate.

---

## 6 · Review queue — PRs waiting on you (~2 min)

Grade routes every non-auto-merged PASS to the human review queue (label
`agent:pr-open`, target branch `staging` — see `execute.sh`, `grade.sh`):

```bash
gh pr list --label agent:pr-open --state open --base staging
```

Read the `🤖 yantra grade` comment on each (verdict JSON + tier), then merge the good
ones. These are the T1+ (and rails-refused T0) PRs that only a human can land.

---

## 7 · AoE session glance

_Stub._ Live agent-session monitoring via **Agent of Empires (AoE)** — attach to the
loop's tmux/exec sessions from your phone — activates once **#21** lands (AoE install
on the VPS, currently parked `needs-human`). Until then this minute is a no-op; the
other nine checks don't depend on it. See #21 and `docs/yantra/00-overview.md` (D4).

---

## Decision points — close the loop

You have now seen everything the loop touched. Two calls, every morning:

1. **Re-ready** — for each `needs-human` issue you can unblock: apply the fix (or edit
   the spec to remove the ambiguity that parked it), then hand it back to the loop:

   ```bash
   gh issue edit <n> --add-label spec:ready --remove-label "needs-human,agent:failed"
   ```

   The next tick (≤ 10 min) re-claims it.

2. **Escalate or close** — for anything that shouldn't go back to the loop: merge the
   ready review-queue PRs (check 6), and close the dead ends (bad spec, obsolete work,
   `agent:failed` with no viable fix):

   ```bash
   gh issue close <n> --reason "not planned"    # or --reason completed
   ```

That's the morning. If both lists are empty and the tallies look boring, you're done —
budget the rest of the D13 hour on the backlog, not on poking a healthy loop.

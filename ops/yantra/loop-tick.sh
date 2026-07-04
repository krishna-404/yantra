#!/usr/bin/env bash
# Yantra loop v0 — one tick (loop-protocol §2). Runs from systemd every 10 min.
# Order: kill check → canary → reap stale claims → grade open PRs → claim ONE new
# issue → advise → execute → dream micro-write. One issue per tick max.
# Contract: exit 0 ALWAYS — log errors, park work; a crashing tick must not wedge
# the timer. (Implemented via the ERR trap below: any unguarded failure logs and
# exits 0.)

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh" # sets -euo pipefail
OPS_DIR="$YANTRA_OPS_DIR"

trap 'log ERROR "tick crashed at line $LINENO (rc=$?) — exiting 0 per contract"; exit 0' ERR

TICK=$(ulid)
log INFO "tick start $TICK"

reap_stale_claims() {
	local n latest age has_pr
	for n in $(gh issue list --repo "$REPO" --label agent:working --state open --json number --jq '.[].number'); do
		latest=$(gh issue view "$n" --repo "$REPO" --json comments \
			--jq '[.comments[] | select(.body | contains("yantra claim")) | .createdAt] | sort | last // empty')
		[[ -z "$latest" ]] && continue
		age=$(( $(date -u +%s) - $(date -u -d "$latest" +%s) ))
		if (( age > 7200 )); then
			# An open PR means execute finished and only labels lagged — don't reap those.
			has_pr=$(gh pr list --repo "$REPO" --state open --search "in:body \"Closes #$n\"" --json number --jq 'length')
			if [[ "$has_pr" == "0" ]]; then
				gh issue edit "$n" --repo "$REPO" --add-label "spec:ready" --remove-label "agent:working"
				gh issue comment "$n" --repo "$REPO" --body "🤖 yantra reap: stale claim (>2 h, no PR) — released back to spec:ready."
				log WARN "reaped stale claim on issue #$n (age ${age}s)"
			fi
		fi
	done
	return 0
}

pick_ready_issue() { # first spec:ready issue that is not exempt/working and has no open deps
	local n body
	for n in $(gh issue list --repo "$REPO" --label spec:ready --state open \
		--json number,labels \
		--jq '[.[] | select(([.labels[].name] | index("yantra:exempt") or index("agent:working")) | not) | .number] | .[]'); do
		body=$(gh issue view "$n" --repo "$REPO" --json body --jq .body)
		if deps_open "$body"; then
			log INFO "skip issue #$n: open depends-on"
			continue
		fi
		echo "$n"
		return 0
	done
	return 0
}

dream_micro() { # §2.5 per-turn micro-write marker (telemetry rows are appended by each role)
	log INFO "dream micro-write turn=$1: $2 (no separate lesson this turn unless the execute agent committed an inbox stub)"
}

# ── Precondition 1: kill switch (first check; re-checked at every transition) ──
if kill_switch_on; then
	log INFO "tick $TICK: killed (YANTRA_KILL=true) — no claims, no merges, exit"
	exit 0
fi

# ── R5 canary scan ──
"$OPS_DIR/canary.sh" || log ERROR "tick $TICK: canary.sh errored"
if kill_switch_on; then log INFO "tick $TICK: killed during canary — exit"; exit 0; fi

# ── Reap stale claims (> 2 h, no PR) ──
reap_stale_claims

# ── Grade any PRs that are ready ──
"$OPS_DIR/grade.sh" || log ERROR "tick $TICK: grade.sh errored"
if kill_switch_on; then log INFO "tick $TICK: killed during grade — exit"; exit 0; fi

# ── Preconditions 2–4 for a new claim ──
working=$(gh issue list --repo "$REPO" --label agent:working --state open --json number --jq 'length')
if (( working >= 3 )); then
	log INFO "tick $TICK: no capacity ($working issues agent:working, cap 3)"
	exit 0
fi
automerges=$(automerges_last_hour)
if (( automerges >= 4 )); then
	log INFO "tick $TICK: R3 saturation ($automerges auto-merges in trailing hour) — no new claim"
	exit 0
fi
ready_issue=$(pick_ready_issue)
if [[ -z "$ready_issue" ]]; then
	log INFO "tick $TICK: nothing in spec:ready — idle"
	exit 0
fi

# ── CLAIM (labels + claim comment; back off from a live rival claim) ──
# A claim comment counts as live ONLY if nothing released it afterwards — parks
# (advise/execute) and reaps post a release marker; without this, every
# park→fix→re-ready cycle would stall for the full 2 h window.
turn=$(ulid)
last_claim=$(gh issue view "$ready_issue" --repo "$REPO" --json comments \
	--jq '[.comments[] | select(.body | contains("yantra claim")) | .createdAt] | sort | last // empty')
if [[ -n "$last_claim" ]]; then
	last_release=$(gh issue view "$ready_issue" --repo "$REPO" --json comments \
		--jq '[.comments[] | select(.body | (contains("parked") or contains("yantra reap") or contains("claim released"))) | .createdAt] | sort | last // empty')
	if [[ -z "$last_release" || "$last_release" < "$last_claim" ]]; then
		age=$(( $(date -u +%s) - $(date -u -d "$last_claim" +%s) ))
		if (( age < 7200 )); then
			log WARN "tick $TICK: issue #$ready_issue has a live unreleased claim (${age}s old) — backing off"
			exit 0
		fi
	fi
fi
exec_model=$(route_model "execute.T1") # provisional; advise confirms the tier
gh issue edit "$ready_issue" --repo "$REPO" --add-label "agent:working" --remove-label "spec:ready"
gh issue comment "$ready_issue" --repo "$REPO" \
	--body "🤖 yantra claim run=$turn role=execute model=$exec_model"
log INFO "tick $TICK: claimed issue #$ready_issue turn=$turn"

# ── ADVISE (blocking plan gate) ──
advise_rc=0
"$OPS_DIR/advise.sh" "$ready_issue" "$turn" || advise_rc=$?
if (( advise_rc == 10 )); then
	log INFO "tick $TICK: advise parked issue #$ready_issue — turn over"
	dream_micro "$turn" "advise parked #$ready_issue"
	exit 0
elif (( advise_rc != 0 )); then
	log ERROR "tick $TICK: advise infra error on #$ready_issue — releasing claim"
	gh issue edit "$ready_issue" --repo "$REPO" --add-label "spec:ready" --remove-label "agent:working" || true
	gh issue comment "$ready_issue" --repo "$REPO" --body "🤖 yantra: advise infra error — claim released, will retry next tick." || true
	exit 0
fi

# ── EXECUTE ──
if kill_switch_on; then
	log INFO "tick $TICK: killed before execute — releasing claim"
	gh issue edit "$ready_issue" --repo "$REPO" --add-label "spec:ready" --remove-label "agent:working" || true
	exit 0
fi
tier=$(jq -r .tier "$YANTRA_TELEMETRY_DIR/advise-$ready_issue.json")
"$OPS_DIR/execute.sh" "$ready_issue" "$turn" "$tier" \
	|| log ERROR "tick $TICK: execute parked/errored on #$ready_issue (handled inside)"

# ── DREAM micro-write ──
dream_micro "$turn" "turn on #$ready_issue complete"
log INFO "tick end $TICK"
exit 0

#!/usr/bin/env bash
# Yantra loop v0 — stub-harness scenario tests (no network, no real gh/claude/docker).
# Fakes gh + claude + docker on PATH and runs the REAL scripts end-to-end.
# Scenarios (subset of loop-protocol §8 parity suite):
#   A. kill switch on            → tick exits 0, zero mutating gh calls
#   B. vague spec                → advise AMBIGUOUS → needs-human, claim released
#   C. good T0 spec              → claim → advise PROCEED → execute → PR labels swapped
#   D. grade PASS T0 small diff  → rails hold → squash auto-merge + ledger entry
#   E. grade PASS T0 160-line    → rails refuse (R2), no merge
# Usage: bash ops/yantra/tests/stub-tick-test.sh   (exit 0 = all pass)

set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS="$(dirname "$HERE")"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
export GH_STATE="$WORK/state"
mkdir -p "$GH_STATE" "$WORK/bin" "$WORK/telemetry"

# ---- stubs -------------------------------------------------------------------
cat > "$WORK/bin/gh" <<'STUB'
#!/usr/bin/env bash
S="$GH_STATE"; echo "$*" >> "$S/calls.log"
case "$*" in
	"api repos/"*"/actions/variables/YANTRA_KILL --jq .value") cat "$S/kill" ;;
	"api -X PATCH"*) echo "$*" >> "$S/mutations.log" ;;
	"run list"*) echo "" ;;
	"issue list"*"--label agent:working"*"--jq length") echo 0 ;;
	"issue list"*"--label agent:working"*) echo "" ;;
	"pr list"*"--label agent:pr-open"*) cat "$S/propen" 2>/dev/null || echo "" ;;
	"issue list"*"--label spec:ready"*) cat "$S/ready" 2>/dev/null || echo "" ;;
	"issue view 42"*"--json comments"*) echo "" ;;
	"issue view 42"*"--json body --jq .body") cat "$S/body" ;;
	"issue view 42"*"--json state --jq .state") echo "CLOSED" ;;
	"issue view 42"*"--json number,title,body,labels,state")
		jq -n --rawfile b "$S/body" '{number:42,title:"[Spec] Stub test issue",body:$b,labels:[],state:"OPEN"}' ;;
	"issue view 42"*"--json title,body"*) echo "# Stub spec"; cat "$S/body" ;;
	"issue edit"*|"pr edit"*) echo "$*" >> "$S/mutations.log" ;;
	"issue comment"*|"pr comment"*) echo "$*" >> "$S/mutations.log" ;;
	"pr merge"*) echo "$*" >> "$S/mutations.log" ;;
	"pr list"*"--head"*) echo 55 ;;
	"pr list"*"--search"*) echo 0 ;;
	"pr view 77"*"--json number,title,headRefOid"*) cat "$S/pr77.json" ;;
	"pr view 77"*"--json body --jq .body") echo "stub body — Closes #42" ;;
	"pr view"*"--json mergeCommit"*) echo "deadbeef" ;;
	"pr diff 77"*) echo "--- a/README.md"; echo "+++ b/README.md"; echo "+stub" ;;
	*) echo "UNHANDLED gh: $*" >> "$S/unhandled.log"; echo "" ;;
esac
STUB

cat > "$WORK/bin/claude" <<'STUB'
#!/usr/bin/env bash
cat "$GH_STATE/claude_out"
STUB

cat > "$WORK/bin/docker" <<'STUB'
#!/usr/bin/env bash
# Never consume stdin: with an interactive/held-open stdin a blocking read
# would hang the whole suite (bit us twice). Heredoc-fed callers don't care.
exec 0</dev/null
echo "docker $*" >> "$GH_STATE/calls.log"
# grade's claude_container expects verdict JSON on stdout
if [[ -f "$GH_STATE/docker_out" ]]; then cat "$GH_STATE/docker_out"; fi
exit "${DOCKER_STUB_RC:-0}"
STUB
chmod +x "$WORK/bin/"*

export PATH="$WORK/bin:$PATH"
export YANTRA_HOME="$WORK" YANTRA_TELEMETRY_DIR="$WORK/telemetry" \
	YANTRA_ENV_FILE=/dev/null YANTRA_REPO=stub/yantra NOVU_SECRET_KEY=""

pass=0; failn=0
check() { # check <desc> <cmd…>
	local d="$1"; shift
	if "$@"; then echo "  PASS: $d"; pass=$((pass+1)); else echo "  FAIL: $d"; failn=$((failn+1)); fi
}
reset_state() {
	rm -f "$GH_STATE"/*.log "$GH_STATE"/propen "$GH_STATE"/ready "$WORK/telemetry"/*
	echo false > "$GH_STATE/kill"
	printf '### type\n\ndocs\n\n### depends-on\n\n—\n\n### Problem\n\nstub\n' > "$GH_STATE/body"
}

# ---- A. kill switch ------------------------------------------------------------
echo "Scenario A: kill switch on"
reset_state; echo true > "$GH_STATE/kill"
"$OPS/loop-tick.sh" >/dev/null 2>&1
check "tick exit 0" true
check "no mutations" test ! -s "$GH_STATE/mutations.log"

# ---- B. vague spec → AMBIGUOUS park ---------------------------------------------
echo "Scenario B: vague spec parks needs-human"
reset_state; echo 42 > "$GH_STATE/ready"
cat > "$GH_STATE/claude_out" <<'EOF'
```json
{"verdict":"AMBIGUOUS","tier":"T1","plan":[],"files_expected":[],"risks":[],"questions":["what exactly?"]}
```
EOF
"$OPS/loop-tick.sh" >/dev/null 2>&1
check "claimed (agent:working added)" grep -q -- "--add-label agent:working --remove-label spec:ready" "$GH_STATE/mutations.log"
check "parked needs-human + claim released" grep -q -- "--add-label needs-human --remove-label agent:working" "$GH_STATE/mutations.log"
check "no docker spawned" bash -c '! grep -q "^docker run" "$GH_STATE/calls.log"'
check "telemetry parked line" grep -q '"outcome":"parked"' "$WORK/telemetry/runs.jsonl"

# ---- C. good T0 spec → full execute path ----------------------------------------
echo "Scenario C: PROCEED T0 → execute → PR labels"
reset_state; echo 42 > "$GH_STATE/ready"
cat > "$GH_STATE/claude_out" <<'EOF'
```json
{"verdict":"PROCEED","tier":"T0","plan":["do it"],"files_expected":["README.md"],"risks":[]}
EOF
echo '```' >> "$GH_STATE/claude_out"
"$OPS/loop-tick.sh" >/dev/null 2>&1
check "tier label applied" grep -q -- "--add-label tier:T0" "$GH_STATE/mutations.log"
check "execute container ran" grep -q "docker run" "$GH_STATE/calls.log"
check "labels swapped to agent:pr-open" grep -q -- "--add-label agent:pr-open --remove-label agent:working" "$GH_STATE/mutations.log"
check "PR mirrored labels" grep -q "pr edit 55 .*--add-label agent:pr-open" "$GH_STATE/mutations.log"
check "advise+execute telemetry" bash -c '[ "$(grep -c "\"outcome\":\"ok\"" "$YANTRA_TELEMETRY_DIR/runs.jsonl")" -ge 2 ]'

# ---- D. grade PASS T0 small diff → auto-merge ------------------------------------
echo "Scenario D: grade PASS T0 → auto-merge under rails"
reset_state; echo 77 > "$GH_STATE/propen"
jq -n '{number:77,title:"[Yantra][T0] stub",headRefOid:"abc123",additions:3,deletions:1,changedFiles:1,
	files:[{path:"README.md"}],labels:[{name:"agent:pr-open"},{name:"tier:T0"}],
	statusCheckRollup:[{conclusion:"SUCCESS"},{conclusion:"SUCCESS"}],
	comments:[{body:"Closes #42"}],mergeStateStatus:"CLEAN"}' > "$GH_STATE/pr77.json"
# PR body lookup for linked_issue uses pr view --json body; reuse pr77.json path via comments? linked_issue greps body:
jq -n '{body:"stub body\n\nCloses #42"}' >/dev/null # (documentation: body served below)
cat > "$GH_STATE/docker_out" <<'EOF'
```json
{"verdict":"PASS","tier_confirmed":"T0","criteria":[{"criterion":"stub","met":true,"evidence":"README.md:1"}],"rubric_scores":{"spec_fit":2,"tests":2,"scope":2,"quality":2},"failures":[]}
```
EOF
"$OPS/grade.sh" >/dev/null 2>&1
check "verdict comment posted" grep -q "pr comment 77" "$GH_STATE/mutations.log"
check "auto-merge fired" grep -q "pr merge 77 --repo stub/yantra --squash" "$GH_STATE/mutations.log"
check "ledger entry written" test -s "$WORK/telemetry/automerges.jsonl"

# ---- E. grade PASS T0 but 160-line diff → rails refuse ---------------------------
echo "Scenario E: 160-line T0 → rails refuse, no merge"
reset_state; echo 77 > "$GH_STATE/propen"
jq -n '{number:77,title:"[Yantra][T0] big",headRefOid:"def456",additions:120,deletions:40,changedFiles:2,
	files:[{path:"README.md"}],labels:[{name:"agent:pr-open"},{name:"tier:T0"}],
	statusCheckRollup:[{conclusion:"SUCCESS"}],comments:[],mergeStateStatus:"CLEAN"}' > "$GH_STATE/pr77.json"
"$OPS/grade.sh" >/dev/null 2>&1
check "no merge attempted" bash -c '! grep -q "pr merge" "$GH_STATE/mutations.log"'
check "rails refusal commented" grep -q "auto-merge REFUSED" "$GH_STATE/mutations.log"

echo
echo "RESULT: $pass passed, $failn failed"
[[ -s "$GH_STATE/unhandled.log" ]] && { echo "unhandled gh calls:"; sort -u "$GH_STATE/unhandled.log"; }
exit $(( failn > 0 ? 1 : 0 ))

#!/usr/bin/env bash
# Yantra loop v0 — shared helpers. Sourced by every script in ops/yantra/.
# Contract: bash + gh + jq + docker only. No secrets ever echoed.

set -euo pipefail

YANTRA_HOME="${YANTRA_HOME:-/opt/yantra}"
YANTRA_ENV_FILE="${YANTRA_ENV_FILE:-$YANTRA_HOME/env/yantra.env}"
YANTRA_TELEMETRY_DIR="${YANTRA_TELEMETRY_DIR:-$YANTRA_HOME/telemetry}"
YANTRA_OPS_DIR="${YANTRA_OPS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
YANTRA_LOG="${YANTRA_LOG:-$YANTRA_TELEMETRY_DIR/loop.log}"
YANTRA_RUNS="${YANTRA_RUNS:-$YANTRA_TELEMETRY_DIR/runs.jsonl}"
YANTRA_AUTOMERGE_LEDGER="${YANTRA_AUTOMERGE_LEDGER:-$YANTRA_TELEMETRY_DIR/automerges.jsonl}"
YANTRA_EXEC_IMAGE="${YANTRA_EXEC_IMAGE:-yantra-exec:0}"

# Load credentials (GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, NOVU_SECRET_KEY, YANTRA_REPO).
# set -a exports them for gh / docker --env-file callers.
if [[ -f "$YANTRA_ENV_FILE" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "$YANTRA_ENV_FILE"
	set +a
fi

REPO="${YANTRA_REPO:?YANTRA_REPO must be set (owner/repo)}"
mkdir -p "$YANTRA_TELEMETRY_DIR"

# --- logging ---------------------------------------------------------------
log() { # log <level> <msg…>  — one line per state transition, never secrets
	local level="$1"; shift
	local line
	line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $level $*"
	echo "$line" >> "$YANTRA_LOG"
	echo "$line" >&2
}

# --- ids -------------------------------------------------------------------
ulid() { # Crockford-base32 ULID: 10-char ms timestamp + 16 random chars
	local alphabet="0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	local ts out="" i
	ts=$(date +%s%3N)
	for i in 9 8 7 6 5 4 3 2 1 0; do
		out+="${alphabet:$(( (ts >> (i * 5)) & 31 )):1}"
	done
	for _ in $(seq 1 16); do
		out+="${alphabet:$(( RANDOM % 32 )):1}"
	done
	echo "$out"
}

# --- kill switch (checked at every state transition; fail-closed) ----------
kill_switch_on() { # returns 0 (=killed) when YANTRA_KILL=="true" OR the API is unreachable
	local v
	if ! v=$(gh api "repos/$REPO/actions/variables/YANTRA_KILL" --jq .value 2>/dev/null); then
		log WARN "kill-switch read failed — failing closed (treating as killed)"
		return 0
	fi
	[[ "$v" == "true" ]]
}

# --- telemetry (loop-protocol §5 — one JSON line per run) -------------------
telemetry() { # telemetry <run> <turn> <issue> <role> <model> <tier> <task_type> <started_at> <outcome> [pr] [merged] [auto_merged] [prompt_version]
	local run="$1" turn="$2" issue="$3" role="$4" model="$5" tier="$6" task_type="$7" started_at="$8" outcome="$9"
	local pr="${10:-0}" merged="${11:-false}" auto_merged="${12:-false}" pv="${13:-1}"
	local ended_at wall_s
	ended_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	wall_s=$(( $(date -u +%s) - $(date -u -d "$started_at" +%s) ))
	jq -cn \
		--arg run "$run" --arg turn "$turn" --argjson issue "${issue:-0}" \
		--arg role "$role" --arg model "$model" --arg tier "$tier" \
		--arg task_type "$task_type" --arg started_at "$started_at" \
		--arg ended_at "$ended_at" --argjson wall_s "$wall_s" \
		--arg outcome "$outcome" --argjson pr "${pr:-0}" \
		--argjson merged "$merged" --argjson auto_merged "$auto_merged" \
		--argjson pv "$pv" \
		'{run:$run, turn:$turn, issue:$issue, role:$role, lane:"claude-max",
		  model:$model, prompt_version:$pv, tier:$tier, task_type:$task_type,
		  started_at:$started_at, ended_at:$ended_at, wall_s:$wall_s,
		  outcome:$outcome, pr:$pr, merged:$merged, auto_merged:$auto_merged,
		  reverted:false, tokens_est:0, cost_usd:0.0}' >> "$YANTRA_RUNS"
}

# --- routing ---------------------------------------------------------------
route_model() { # route_model <role-key: advise|grade|dream|execute.T0…>
	jq -r --arg k "$1" '.[$k].model // empty' "$YANTRA_OPS_DIR/routing.json"
}

# --- fenced-JSON extraction (last ```json block wins) -----------------------
extract_json_block() { # stdin: model output → stdout: last valid fenced JSON block
	awk '/^```json[[:space:]]*$/{buf=""; on=1; next} /^```[[:space:]]*$/{if(on){last=buf; on=0} next} on{buf=buf $0 "\n"} END{printf "%s", last}' \
		| jq -c . 2>/dev/null
}

# --- issue helpers ----------------------------------------------------------
issue_json() { gh issue view "$1" --repo "$REPO" --json number,title,body,labels,state; }

issue_field() { # issue_field <issue-body> <field-label> — parses "### label\n\nvalue" issue-form output OR "field: value" frontmatter
	local body="$1" field="$2"
	local v
	v=$(printf '%s\n' "$body" | awk -v f="### $field" '
		$0 == f {on=1; next}
		on && /^### / {exit}
		on && NF {print; exit}')
	if [[ -z "$v" ]]; then
		v=$(printf '%s\n' "$body" | grep -m1 -E "^${field}:" | sed -E "s/^${field}:[[:space:]]*//")
	fi
	printf '%s' "$v"
}

deps_open() { # deps_open <issue-body> — returns 0 if any depends-on issue is still open
	local body="$1" dep n
	dep=$(issue_field "$body" "depends-on")
	[[ -z "$dep" || "$dep" =~ ^(—|-|none|None|N/A|_No response_)$ ]] && return 1
	for n in $(printf '%s' "$dep" | grep -oE '#[0-9]+' | tr -d '#'); do
		if [[ "$(gh issue view "$n" --repo "$REPO" --json state --jq .state 2>/dev/null)" == "OPEN" ]]; then
			return 0
		fi
	done
	return 1
}

# --- auto-merge ledger (rail R3) --------------------------------------------
automerges_last_hour() {
	[[ -f "$YANTRA_AUTOMERGE_LEDGER" ]] || { echo 0; return; }
	local cutoff
	cutoff=$(date -u -d '60 minutes ago' +%Y-%m-%dT%H:%M:%SZ)
	jq -r --arg c "$cutoff" 'select(.ts > $c) | .pr' "$YANTRA_AUTOMERGE_LEDGER" 2>/dev/null | wc -l
}

record_automerge() { # record_automerge <pr> <head-sha>
	jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --argjson pr "$1" --arg sha "$2" \
		'{ts:$ts, pr:$pr, sha:$sha, canaried:false}' >> "$YANTRA_AUTOMERGE_LEDGER"
}

# --- claude-in-container (one container = one run) ---------------------------
claude_container() { # claude_container <model> <prompt-file> — read-only reasoning run, prints model output
	docker run --rm -i \
		--memory=4g --cpus=2 --network=bridge \
		--env-file "$YANTRA_ENV_FILE" \
		-e "PROMPT_B64=$(base64 -w0 "$2")" \
		-e "MODEL=$1" \
		"$YANTRA_EXEC_IMAGE" \
		bash -c 'echo "$PROMPT_B64" | base64 -d > /tmp/p.md && claude -p "$(cat /tmp/p.md)" --model "$MODEL" --dangerously-skip-permissions'
}

#!/usr/bin/env bash
# Yantra ADVISE (loop-protocol §2.2) — the blocking plan gate before any code.
# Usage: advise.sh <issue-number> <turn-ulid>
# Writes the parsed advise JSON to $YANTRA_TELEMETRY_DIR/advise-<issue>.json on PROCEED.
# Exit codes: 0 = PROCEED · 10 = parked (AMBIGUOUS/REJECT) · 1 = infra error (caller parks).

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ISSUE="${1:?usage: advise.sh <issue> <turn>}"
TURN="${2:?usage: advise.sh <issue> <turn>}"
RUN=$(ulid)
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
MODEL=$(route_model advise)
PV=$(grep -m1 -oE 'prompt-version: [0-9]+' "$YANTRA_OPS_DIR/prompts/advise.md" | grep -oE '[0-9]+')

ijson=$(issue_json "$ISSUE")
title=$(jq -r .title <<<"$ijson")
body=$(jq -r .body <<<"$ijson")
task_type=$(issue_field "$body" "type"); task_type="${task_type:-unknown}"

# Assemble the prompt: template + spec + brain (if present). Skills matching = Y1.C4.
prompt_file=$(mktemp)
trap 'rm -f "$prompt_file"' EXIT
{
	cat "$YANTRA_OPS_DIR/prompts/advise.md"
	echo; echo "## Product Spec (issue #$ISSUE): $title"; echo; echo "$body"
	for brain in decisions conventions; do
		f="$YANTRA_OPS_DIR/../../.brain/$brain.md"
		[[ -f "$f" ]] && { echo; echo "## .brain/$brain.md"; echo; cat "$f"; }
	done
} > "$prompt_file"

log INFO "advise start issue=#$ISSUE run=$RUN model=$MODEL"
if ! raw=$(CLAUDE_CODE_OAUTH_TOKEN="${CLAUDE_CODE_OAUTH_TOKEN:-}" \
	claude -p "$(cat "$prompt_file")" --model "$MODEL" 2>>"$YANTRA_LOG"); then
	log ERROR "advise infra error issue=#$ISSUE run=$RUN"
	telemetry "$RUN" "$TURN" "$ISSUE" advise "$MODEL" "" "$task_type" "$STARTED" infra_error 0 false false "$PV"
	exit 1
fi

verdict_json=$(extract_json_block <<<"$raw" || true)
if [[ -z "$verdict_json" ]]; then
	log ERROR "advise unparseable output issue=#$ISSUE run=$RUN"
	telemetry "$RUN" "$TURN" "$ISSUE" advise "$MODEL" "" "$task_type" "$STARTED" infra_error 0 false false "$PV"
	exit 1
fi

verdict=$(jq -r .verdict <<<"$verdict_json")
tier=$(jq -r .tier <<<"$verdict_json")

gh issue comment "$ISSUE" --repo "$REPO" --body "🤖 yantra advise run=$RUN model=$MODEL

\`\`\`json
$(jq . <<<"$verdict_json")
\`\`\`"

case "$verdict" in
	PROCEED)
		gh issue edit "$ISSUE" --repo "$REPO" --add-label "tier:$tier"
		echo "$verdict_json" > "$YANTRA_TELEMETRY_DIR/advise-$ISSUE.json"
		log INFO "advise PROCEED issue=#$ISSUE tier=$tier run=$RUN"
		telemetry "$RUN" "$TURN" "$ISSUE" advise "$MODEL" "$tier" "$task_type" "$STARTED" ok 0 false false "$PV"
		exit 0
		;;
	AMBIGUOUS|REJECT)
		gh issue edit "$ISSUE" --repo "$REPO" --add-label "needs-human" --remove-label "agent:working"
		gh issue comment "$ISSUE" --repo "$REPO" --body "🤖 yantra release run=$RUN — parked ($verdict), claim released."
		"$YANTRA_OPS_DIR/notify.sh" needs-human \
			"$(jq -cn --argjson i "$ISSUE" --arg v "$verdict" '{issue:$i, reason:("advise " + $v)}')"
		log INFO "advise $verdict issue=#$ISSUE parked needs-human run=$RUN"
		telemetry "$RUN" "$TURN" "$ISSUE" advise "$MODEL" "$tier" "$task_type" "$STARTED" parked 0 false false "$PV"
		exit 10
		;;
	*)
		log ERROR "advise unknown verdict '$verdict' issue=#$ISSUE run=$RUN"
		telemetry "$RUN" "$TURN" "$ISSUE" advise "$MODEL" "" "$task_type" "$STARTED" infra_error 0 false false "$PV"
		exit 1
		;;
esac

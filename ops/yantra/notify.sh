#!/usr/bin/env bash
# Yantra — Novu trigger wrapper. Events: needs-human | review-digest | killed.
# Usage: notify.sh <event> [payload-json]
# Fire-and-forget: a Novu failure must never wedge the loop (logged, exit 0).

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

EVENT="${1:?usage: notify.sh <needs-human|review-digest|killed> [payload-json]}"
PAYLOAD="${2:-{\}}"

# Y1.D2 ships the dedicated yantra workflows; until then YANTRA_NOVU_WORKFLOW
# can point every event at any existing, known-delivering workflow.
WORKFLOW="${YANTRA_NOVU_WORKFLOW:-yantra-$EVENT}"
SUBSCRIBER="${YANTRA_NOVU_SUBSCRIBER:-yantra-operator}"
NOVU_API_URL="${NOVU_API_URL:-https://api.novu.co}"

if [[ -z "${NOVU_SECRET_KEY:-}" ]]; then
	log WARN "notify: NOVU_SECRET_KEY unset — skipping '$EVENT'"
	exit 0
fi

body=$(jq -cn --arg name "$WORKFLOW" --arg sub "$SUBSCRIBER" --arg event "$EVENT" --argjson p "$PAYLOAD" \
	'{name:$name, to:{subscriberId:$sub}, payload:($p + {event:$event})}')

if curl -sS -m 15 -o /dev/null -f -X POST "$NOVU_API_URL/v1/events/trigger" \
	-H "Authorization: ApiKey $NOVU_SECRET_KEY" \
	-H "Content-Type: application/json" \
	-d "$body"; then
	log INFO "notify: sent '$EVENT' via workflow '$WORKFLOW'"
else
	log ERROR "notify: Novu trigger failed for '$EVENT' (loop continues)"
fi
exit 0

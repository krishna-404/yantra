#!/usr/bin/env bash
# Yantra — create/update the loop's GitHub labels (loop-protocol.md §1).
# Idempotent: `--force` updates color/description if the label already exists.
# Usage: YANTRA_REPO=<owner>/<repo> ./setup-labels.sh   (or pass repo as $1)

set -euo pipefail

REPO="${1:-${YANTRA_REPO:?set YANTRA_REPO=<owner>/<repo> or pass as arg}}"

create() { # name color description
	gh label create "$1" --repo "$REPO" --color "$2" --description "$3" --force
	echo "label ok: $1"
}

# State-machine labels
create "spec:ready"    "0E8A16" "Product Spec approved for intake (board: Agent: ready)"
create "agent:working" "FBCA04" "An execute turn owns this issue"
create "agent:pr-open" "1D76DB" "PR exists, awaiting grade/CI/human"
create "needs-human"   "D93F0B" "Loop parked it; Novu push fired. Re-add spec:ready after fixing"
create "agent:failed"  "B60205" "2 attempts failed grade; parked with diagnosis comment"
create "yantra:exempt" "5319E7" "Loop must never touch this issue"

# Risk tiers (proposed by Advise, confirmed by Grade)
create "tier:T0" "C2E0C6" "Mechanical change — auto-merge eligible under rails R1-R5"
create "tier:T1" "BFDADC" "Low-risk code — human merge"
create "tier:T2" "F9D0C4" "Feature / multi-file — human merge"
create "tier:T3" "E99695" "Sensitive (auth, CI, harness, .brain, LICENSE) — never auto-merged"

echo "done: 10 labels ensured on $REPO"

#!/usr/bin/env bash
# Yantra CANARY (rail R5, loop-protocol §6) — polled each tick.
# Red CI on main after a yantra auto-merge ⇒ revert PR (T0, size-cap-exempt),
# kill switch on, Novu needs-you-now. The loop never un-kills itself.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

STATE="$YANTRA_TELEMETRY_DIR/canary.state"

run=$(gh run list --repo "$REPO" --workflow ci.yml --branch main --limit 1 \
	--json databaseId,status,conclusion,headSha --jq '.[0] // empty' 2>/dev/null || true)
[[ -z "$run" ]] && { log INFO "canary: no main CI runs yet"; exit 0; }

status=$(jq -r .status <<<"$run")
run_id=$(jq -r .databaseId <<<"$run")
conclusion=$(jq -r .conclusion <<<"$run")

[[ "$status" != "completed" ]] && exit 0
[[ -f "$STATE" && "$(cat "$STATE")" == "$run_id" ]] && exit 0
echo "$run_id" > "$STATE"

if [[ "$conclusion" == "success" ]]; then
	log INFO "canary: main CI run $run_id green"
	exit 0
fi

# Red main. Only R5 if a yantra auto-merge is plausibly the cause (any un-canaried
# auto-merge in the trailing 24 h — start paranoid).
[[ -f "$YANTRA_AUTOMERGE_LEDGER" ]] || { log WARN "canary: main red but no auto-merge ledger — human problem, not R5"; exit 0; }
cutoff=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)
last_am=$(jq -c --arg c "$cutoff" 'select(.ts > $c and .canaried == false)' "$YANTRA_AUTOMERGE_LEDGER" | tail -1)
[[ -z "$last_am" ]] && { log WARN "canary: main red, no recent un-canaried auto-merge — human problem, not R5"; exit 0; }

pr=$(jq -r .pr <<<"$last_am")
log ERROR "canary RED on main (run $run_id) — R5: reverting auto-merged PR #$pr, killing loop"

merge_sha=$(gh pr view "$pr" --repo "$REPO" --json mergeCommit --jq '.mergeCommit.oid // empty')
if [[ -n "$merge_sha" ]]; then
	work=$(mktemp -d)
	git clone --quiet --depth 20 "https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git" "$work/repo"
	(
		cd "$work/repo"
		git config user.name "yantra-bot"
		git config user.email "yantra-bot@users.noreply.github.com"
		git checkout --quiet -b "yantra/revert-$pr" origin/main
		git revert --no-edit "$merge_sha"
		git push --quiet -u origin "yantra/revert-$pr"
	)
	rm -rf "$work"
	revert_pr=$(gh pr create --repo "$REPO" --base main --head "yantra/revert-$pr" \
		--title "[Yantra][T0] Revert #$pr (red canary on main)" \
		--body "R5 auto-revert: CI run $run_id on main went red after auto-merge of #$pr (commit \`$merge_sha\`). Kill switch has been set; a human must reset it." \
		--label "tier:T0" 2>/dev/null | grep -oE '[0-9]+$' || true)
	if [[ -n "$revert_pr" ]]; then
		# Revert diffs are exempt from R2's size caps (rails --revert); merge under the rails
		# BEFORE setting the kill switch (R4 would refuse afterwards — the prescribed order).
		source "$YANTRA_OPS_DIR/grade.sh" --lib-only
		pj=$(gh pr view "$revert_pr" --repo "$REPO" --json additions,deletions,changedFiles,files)
		if rail_msg=$(rails_check "$pj" "T0" "PASS" --revert); then
			gh pr merge "$revert_pr" --repo "$REPO" --squash --auto
			log INFO "canary: revert PR #$revert_pr auto-merge enabled"
		else
			log ERROR "canary: rails refused revert PR #$revert_pr: $rail_msg — leaving for human"
		fi
	fi
else
	log ERROR "canary: could not resolve merge commit of PR #$pr — no revert opened, killing anyway"
fi

# Kill the loop (a human must reset it) + mark ledger + page the operator.
gh api -X PATCH "repos/$REPO/actions/variables/YANTRA_KILL" -f name=YANTRA_KILL -f value=true \
	|| log ERROR "canary: FAILED to set YANTRA_KILL — set it manually NOW"
tmp=$(mktemp)
jq -c --argjson pr "$pr" 'if .pr == $pr then .canaried = true else . end' "$YANTRA_AUTOMERGE_LEDGER" > "$tmp" \
	&& mv "$tmp" "$YANTRA_AUTOMERGE_LEDGER"
"$YANTRA_OPS_DIR/notify.sh" killed \
	"$(jq -cn --argjson pr "$pr" --arg run "$run_id" '{reason:"red canary on main", pr:$pr, ci_run:$run}')"
log ERROR "canary: R5 complete — YANTRA_KILL=true, loop halted until human reset"
exit 0

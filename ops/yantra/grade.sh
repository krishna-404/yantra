#!/usr/bin/env bash
# Yantra GRADE (loop-protocol §2.4) + auto-merge rails (§6).
# Scan mode (no args): grade every open PR labeled agent:pr-open whose CI is done
# and whose head SHA has no verdict yet. PASS+T0+rails ⇒ squash auto-merge.
# FAIL ⇒ one execute retry; second FAIL ⇒ agent:failed + needs-human + Novu.
#
# Unit-testable: `source grade.sh --lib-only` exposes rails_check without side effects.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# --- rails R1–R4 (checked immediately before merge) --------------------------
# rails_check <pr-json> <tier_confirmed> <rubric-verdict> [--revert]
#   pr-json needs: .additions .deletions .changedFiles .files[].path
#   --revert: R5 revert PRs are exempt from R2's size caps only.
# Prints the first violated rail to stdout; returns 0 iff all rails hold.
rails_check() {
	local pr_json="$1" tier="$2" verdict="$3" revert="${4:-}"

	# R1 — T0 + rubric PASS (CI-green is a caller precondition, re-stated here)
	if [[ "$verdict" != "PASS" ]]; then echo "R1: rubric verdict is $verdict, not PASS"; return 1; fi
	if [[ "$tier" != "T0" ]]; then echo "R1: tier_confirmed=$tier — only T0 auto-merges"; return 1; fi

	# R2 — size caps + protected paths
	local adds dels files n
	adds=$(jq -r '.additions // 0' <<<"$pr_json")
	dels=$(jq -r '.deletions // 0' <<<"$pr_json")
	n=$(jq -r '.changedFiles // 0' <<<"$pr_json")
	if [[ "$revert" != "--revert" ]]; then
		if (( adds + dels > 150 )); then echo "R2: diff $((adds + dels)) changed lines > 150"; return 1; fi
		if (( n > 5 )); then echo "R2: $n files > 5"; return 1; fi
	fi
	local bad
	bad=$(jq -r '.files[].path' <<<"$pr_json" | grep -E \
		'^\.github/|^ops/yantra/|^apps/yantra/|^LICENSE$|auth|secret|\.env|migrations/|^\.brain/' \
		| grep -vE '^\.brain/inbox/' | head -1 || true)
	if [[ -n "$bad" ]]; then echo "R2: touches protected path: $bad"; return 1; fi
	if jq -r '.files[].path' <<<"$pr_json" | grep -qE '(^|/)package\.json$'; then
		echo "R2: touches package.json (dependency sections are rail-protected)"; return 1
	fi

	# R3 — < 4 auto-merges in the trailing 60 min (repo-wide)
	local count
	count=$(automerges_last_hour)
	if (( count >= 4 )); then echo "R3: $count auto-merges in the last hour (cap 4)"; return 1; fi

	# R4 — kill switch, re-checked at merge time
	if kill_switch_on; then echo "R4: YANTRA_KILL is true"; return 1; fi

	return 0
}

if [[ "${1:-}" == "--lib-only" ]]; then
	return 0 2>/dev/null || exit 0 # return when sourced; exit when executed
fi

# --- helpers -----------------------------------------------------------------
tier_rank() { case "$1" in T0) echo 0;; T1) echo 1;; T2) echo 2;; T3) echo 3;; *) echo 3;; esac; }

grade_container() { # grade_container <model> <prompt-file> <head-sha> — rubric leg with checkout
	docker run --rm -i \
		--memory=4g --cpus=2 --network=bridge \
		--env-file "$YANTRA_ENV_FILE" \
		-e "PROMPT_B64=$(base64 -w0 "$2")" \
		-e "MODEL=$1" -e "HEAD_SHA=$3" \
		"$YANTRA_EXEC_IMAGE" bash -s <<'GRADEBOOT'
set -euo pipefail
export GIT_TERMINAL_PROMPT=0
mkdir -p /workspace && cd /workspace
git clone --quiet "https://x-access-token:${GH_TOKEN}@github.com/${YANTRA_REPO}.git" repo
cd repo
git checkout --quiet "$HEAD_SHA"
echo "$PROMPT_B64" | base64 -d > /workspace/prompt.md
# Read-only run: no --dangerously-skip-permissions needed (Read/Grep/Glob are
# permissionless); root is fine without that flag.
claude -p "$(cat /workspace/prompt.md)" --model "$MODEL"
GRADEBOOT
}

linked_issue() { # from "Closes #N" in the PR body
	gh pr view "$1" --repo "$REPO" --json body --jq .body | grep -oiE 'closes #[0-9]+' | head -1 | grep -oE '[0-9]+' || true
}

grade_one() {
	local pr="$1"
	local turn run started model pv pjson sha
	run=$(ulid); turn=$(ulid); started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	model=$(route_model grade)
	pv=$(grep -m1 -oE 'prompt-version: [0-9]+' "$YANTRA_OPS_DIR/prompts/grade.md" | grep -oE '[0-9]+')

	pjson=$(gh pr view "$pr" --repo "$REPO" \
		--json number,title,headRefOid,additions,deletions,changedFiles,files,labels,comments || true)
	sha=$(jq -r '.headRefOid // empty' <<<"$pjson" 2>/dev/null || true)
	# A failed/partial fetch must never grade on empty data (live-fire bug: empty
	# sha broke the pending-skip, dedupe, and fail-count all at once).
	if [[ -z "$pjson" || -z "$sha" ]]; then
		log ERROR "grade pr=#$pr: PR fetch failed/incomplete — skipping this tick"
		return 0
	fi

	# CI leg via the Actions REST API — the fine-grained PAT lacks Checks:Read
	# (which gh pr checks / statusCheckRollup require), but Actions:Read is granted
	# and sufficient (canary's gh run list proves it every tick).
	local checks ci_state
	checks=$(gh api "repos/$REPO/actions/runs?head_sha=$sha&per_page=20" \
		--jq '[.workflow_runs[] | {name, status, conclusion, url: .html_url}]' 2>/dev/null || true)
	if [[ -z "$checks" ]] || ! jq -e 'length > 0' <<<"$checks" >/dev/null 2>&1; then
		log INFO "grade skip pr=#$pr: no CI runs for sha $sha yet"; return 0
	fi
	ci_state=$(jq -r 'if ([.[] | select(.status != "completed")] | length) > 0 then "PENDING"
		elif ([.[] | select(.conclusion == "failure" or .conclusion == "cancelled"
			or .conclusion == "timed_out" or .conclusion == "startup_failure")] | length) > 0 then "FAILURE"
		else "SUCCESS" end' <<<"$checks")
	if [[ "$ci_state" == "PENDING" ]]; then log INFO "grade skip pr=#$pr: CI pending"; return 0; fi

	# Already graded this SHA?
	if jq -r '.comments[].body' <<<"$pjson" | grep -q "yantra grade sha=$sha"; then
		log INFO "grade skip pr=#$pr: sha $sha already graded"; return 0
	fi

	local issue tier_label
	issue=$(linked_issue "$pr"); issue="${issue:-0}"
	tier_label=$(jq -r '[.labels[].name | select(startswith("tier:"))][0] // "tier:T3"' <<<"$pjson")
	tier_label="${tier_label#tier:}"

	local fail_count
	fail_count=$(jq -r '[.comments[].body | select(contains("yantra grade") and contains("\"verdict\": \"FAIL\""))] | length' <<<"$pjson")

	local verdict_json verdict tier_confirmed
	if [[ "$ci_state" == "FAILURE" ]]; then
		verdict="FAIL"; tier_confirmed="$tier_label"
		verdict_json=$(jq -cn --arg t "$tier_label" \
			'{verdict:"FAIL", tier_confirmed:$t, criteria:[], rubric_scores:{},
			  failures:["CI leg red: required checks failed on this PR — read the CI logs, fix the root cause; never weaken tests"]}')
	else
		# Rubric leg — fresh opus container WITH a checkout at the PR head, so
		# state-based criteria (greps, file existence) are verifiable, not guessed.
		local spec diff prompt_file raw
		spec=""
		[[ "$issue" != "0" ]] && spec=$(gh issue view "$issue" --repo "$REPO" --json title,body --jq '"# " + .title + "\n\n" + .body')
		diff=$(gh pr diff "$pr" --repo "$REPO" | head -c 180000)
		prompt_file=$(mktemp)
		{
			cat "$YANTRA_OPS_DIR/prompts/grade.md"
			echo; echo "## Rubric (rubrics.md)"; echo
			cat "$YANTRA_OPS_DIR/../../docs/yantra/rubrics.md"
			echo; echo "## Product Spec (issue #$issue)"; echo; echo "${spec:-<no linked issue found>}"
			echo; echo "## Advise tier label: $tier_label"
			echo; echo "## CI leg (harness-verified): $ci_state — these check results ARE the CI evidence; cite the links:"
			echo '```json'; echo "$checks"; echo '```'
			echo; echo "## PR #$pr diff"; echo '```diff'; echo "$diff"; echo '```'
		} > "$prompt_file"

		if ! raw=$(grade_container "$model" "$prompt_file" "$sha"); then
			rm -f "$prompt_file"
			log ERROR "grade infra error pr=#$pr run=$run"
			telemetry "$run" "$turn" "$issue" grade "$model" "$tier_label" unknown "$started" infra_error "$pr" false false "$pv"
			return 0
		fi
		rm -f "$prompt_file"
		verdict_json=$(extract_json_block <<<"$raw" || true)
		if [[ -z "$verdict_json" ]]; then
			log ERROR "grade unparseable verdict pr=#$pr run=$run"
			telemetry "$run" "$turn" "$issue" grade "$model" "$tier_label" unknown "$started" infra_error "$pr" false false "$pv"
			return 0
		fi
		verdict=$(jq -r .verdict <<<"$verdict_json")
		tier_confirmed=$(jq -r .tier_confirmed <<<"$verdict_json")
	fi

	# Tier honesty: the higher of advise-label vs grade re-derivation wins.
	if (( $(tier_rank "$tier_confirmed") < $(tier_rank "$tier_label") )); then
		tier_confirmed="$tier_label"
	elif [[ "$tier_confirmed" != "$tier_label" ]]; then
		gh pr edit "$pr" --repo "$REPO" --add-label "tier:$tier_confirmed" --remove-label "tier:$tier_label" 2>/dev/null || true
		[[ "$issue" != "0" ]] && gh issue edit "$issue" --repo "$REPO" --add-label "tier:$tier_confirmed" --remove-label "tier:$tier_label" 2>/dev/null || true
	fi

	gh pr comment "$pr" --repo "$REPO" --body "🤖 yantra grade sha=$sha run=$run model=$model

\`\`\`json
$(jq . <<<"$verdict_json")
\`\`\`"

	if [[ "$verdict" == "PASS" ]]; then
		if [[ "$tier_confirmed" == "T0" ]]; then
			local rail_fail=""
			rail_fail=$(rails_check "$pjson" "$tier_confirmed" "$verdict") || true
			if [[ -z "$rail_fail" ]]; then
				gh pr merge "$pr" --repo "$REPO" --squash
				record_automerge "$pr" "$sha"
				# PRs target the integration branch (staging), NOT the repo's default
				# branch, so GitHub never auto-closes the "Closes #N" issue on merge.
				# Close it explicitly — otherwise the done-but-open issue lingers in
				# `spec:ready`/deps and blocks every dependent (deps_open) forever.
				[[ "$issue" != "0" ]] && gh issue close "$issue" --repo "$REPO" --reason completed 2>/dev/null || true
				log INFO "grade PASS pr=#$pr T0 — auto-merged + issue #$issue closed run=$run"
				local outcome=grade_pass_first_try
				if (( fail_count > 0 )); then outcome=grade_pass_retry; fi
				telemetry "$run" "$turn" "$issue" grade "$model" "$tier_confirmed" unknown "$started" "$outcome" "$pr" true true "$pv"
			else
				gh pr comment "$pr" --repo "$REPO" --body "🤖 yantra rails: auto-merge REFUSED — $rail_fail. Queued for human review."
				"$YANTRA_OPS_DIR/notify.sh" review-digest "$(jq -cn --argjson pr "$pr" --arg r "$rail_fail" '{pr:$pr, reason:$r}')"
				log INFO "grade PASS pr=#$pr but rails refused: $rail_fail"
				telemetry "$run" "$turn" "$issue" grade "$model" "$tier_confirmed" unknown "$started" grade_pass_first_try "$pr" false false "$pv"
			fi
		else
			"$YANTRA_OPS_DIR/notify.sh" review-digest "$(jq -cn --argjson pr "$pr" --arg t "$tier_confirmed" '{pr:$pr, tier:$t, status:"ready for review"}')"
			log INFO "grade PASS pr=#$pr tier=$tier_confirmed — human review queue"
			local outcome=grade_pass_first_try
			if (( fail_count > 0 )); then outcome=grade_pass_retry; fi
			telemetry "$run" "$turn" "$issue" grade "$model" "$tier_confirmed" unknown "$started" "$outcome" "$pr" false false "$pv"
		fi
	else # FAIL
		telemetry "$run" "$turn" "$issue" grade "$model" "$tier_confirmed" unknown "$started" grade_fail "$pr" false false "$pv"
		if (( fail_count == 0 )); then
			# First FAIL → one retry: re-enter EXECUTE with the failure list (same branch).
			local ffile
			ffile=$(mktemp)
			jq -r '.failures[]? | "- " + .' <<<"$verdict_json" > "$ffile"
			log INFO "grade FAIL pr=#$pr attempt=1 — dispatching execute retry"
			"$YANTRA_OPS_DIR/execute.sh" "$issue" "$turn" "$tier_confirmed" --retry "$pr" "$ffile" || true
			rm -f "$ffile"
		else
			log INFO "grade FAIL pr=#$pr attempt=2 — parking agent:failed"
			[[ "$issue" != "0" ]] && gh issue edit "$issue" --repo "$REPO" \
				--add-label "agent:failed" --add-label "needs-human" --remove-label "agent:pr-open" 2>/dev/null || true
			gh pr comment "$pr" --repo "$REPO" --body "🤖 yantra: second grade FAIL — parked \`agent:failed\`. A human must intervene (fix and re-add \`spec:ready\`, or close)."
			"$YANTRA_OPS_DIR/notify.sh" needs-human "$(jq -cn --argjson pr "$pr" --argjson i "${issue:-0}" '{pr:$pr, issue:$i, reason:"second grade FAIL"}')"
		fi
	fi
}

# --- scan mode ----------------------------------------------------------------
if [[ -n "${1:-}" && "$1" != "--lib-only" ]]; then
	grade_one "$1"
	exit 0
fi

prs=$(gh pr list --repo "$REPO" --label agent:pr-open --state open --json number --jq '.[].number')
for pr in $prs; do
	if kill_switch_on; then log INFO "grade abort scan: kill switch on"; exit 0; fi
	grade_one "$pr" || log ERROR "grade_one pr=#$pr errored (scan continues)"
done
exit 0

#!/usr/bin/env bash
# Yantra EXECUTE (loop-protocol §2.3) — one containerized build run, one PR.
# Usage:
#   execute.sh <issue> <turn> <tier>                       # first attempt (branch from base branch)
#   execute.sh <issue> <turn> <tier> --retry <pr> <failures-file>   # grade-FAIL retry (same branch)
# Exit: 0 = PR open/updated · 10 = parked needs-human · 1 = infra error after retry.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ISSUE="${1:?usage: execute.sh <issue> <turn> <tier> [--retry <pr> <failures-file>]}"
TURN="${2:?}"
TIER="${3:?}"
RETRY_PR=""
FAILURES_FILE=""
if [[ "${4:-}" == "--retry" ]]; then
	RETRY_PR="${5:?--retry needs <pr>}"
	FAILURES_FILE="${6:?--retry needs <failures-file>}"
fi

RUN=$(ulid)
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
MODEL=$(route_model "execute.$TIER")
PV=$(grep -m1 -oE 'prompt-version: [0-9]+' "$YANTRA_OPS_DIR/prompts/execute.md" | grep -oE '[0-9]+')

ijson=$(issue_json "$ISSUE")
title=$(jq -r .title <<<"$ijson")
body=$(jq -r .body <<<"$ijson")
task_type=$(issue_field "$body" "type"); task_type="${task_type:-unknown}"
slug=$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]' | sed -E 's/\[spec\]//; s/[^a-z0-9]+/-/g; s/^-+|-+$//g' | cut -c1-40)
BRANCH="yantra/$ISSUE-$slug"

advise_file="$YANTRA_TELEMETRY_DIR/advise-$ISSUE.json"
advise_json="{}"; [[ -f "$advise_file" ]] && advise_json=$(cat "$advise_file")

# Assemble the execute prompt.
prompt_file=$(mktemp); trap 'rm -f "$prompt_file"' EXIT
{
	cat "$YANTRA_OPS_DIR/prompts/execute.md"
	echo; echo "## Product Spec (issue #$ISSUE): $title"; echo; echo "$body"
	echo; echo "## Approved plan (Advise, tier $TIER)"; echo '```json'; echo "$advise_json"; echo '```'
	f="$YANTRA_OPS_DIR/../../.brain/conventions.md"
	[[ -f "$f" ]] && { echo; echo "## .brain/conventions.md"; echo; cat "$f"; }
	if [[ -n "$FAILURES_FILE" && -f "$FAILURES_FILE" ]]; then
		echo; echo "## RETRY — the previous attempt FAILED grade. Fix exactly these, on the existing branch:"
		cat "$FAILURES_FILE"
	fi
} > "$prompt_file"

# In-container bootstrap: clone → branch → claude works → hard self-check → push → PR.
# The harness (not the model) owns push + PR + labels.
run_container() {
	docker run --rm -i \
		--memory=4g --cpus=2 --network=bridge \
		--env-file "$YANTRA_ENV_FILE" \
		-e "PROMPT_B64=$(base64 -w0 "$prompt_file")" \
		-e "MODEL=$MODEL" -e "BRANCH=$BRANCH" -e "ISSUE=$ISSUE" -e "TIER=$TIER" \
		-e "BASE_BRANCH=$BASE_BRANCH" \
		-e "TITLE_B64=$(printf '%s' "$title" | base64 -w0)" \
		-e "IS_RETRY=$([[ -n "$RETRY_PR" ]] && echo 1 || echo 0)" \
		"$YANTRA_EXEC_IMAGE" bash -s <<'BOOTSTRAP'
set -euo pipefail
# Root does only privileged prep: postgres for the self-check suite, workspace
# ownership. The actual work runs as the unprivileged `node` user — claude-code
# refuses --dangerously-skip-permissions under root.
pg_ctlcluster "$(ls /etc/postgresql | head -1)" main start
su postgres -c "psql -qc \"ALTER USER postgres PASSWORD 'postgres';\""
mkdir -p /workspace
echo "$PROMPT_B64" | base64 -d > /workspace/prompt.md
cat > /workspace/work.sh <<'WORK'
set -euo pipefail
# The env-file injects orchestrator-only secrets into every run container. The
# self-check suite must never see them: a leaked NOVU_SECRET_KEY (absent from
# .env.test, so dotenv can't override it) made notification tests call the REAL
# Novu API during PR #34's self-check. Execute needs only GH_TOKEN + the Claude
# token — strip the rest.
unset NOVU_SECRET_KEY NOVU_API_URL
export GIT_TERMINAL_PROMPT=0
git config --global user.name "yantra-bot"
git config --global user.email "yantra-bot@users.noreply.github.com"
cd /workspace
git clone --quiet -b "$BASE_BRANCH" "https://x-access-token:${GH_TOKEN}@github.com/${YANTRA_REPO}.git" repo
cd repo
if [[ "$IS_RETRY" == "1" ]]; then
	git checkout --quiet "$BRANCH"
else
	git checkout --quiet -b "$BRANCH" "origin/$BASE_BRANCH"
fi

yarn install --frozen-lockfile >/workspace/selfcheck.log 2>&1

# Build the workspace packages (zod-schemas, ui-mui) BEFORE the agent runs and before
# the self-check. Backend/frontend type-check resolves `@connected-repo/*` through each
# package's built `dist/` (package `exports`), so a fresh container with no `dist/`
# throws phantom `Cannot find module '@connected-repo/zod-schemas/…'` errors. Executors
# were mis-diagnosing that as a source bug and editing out-of-scope package files
# (parked #11 twice this way). CI builds the packages first; the container must too.
# App builds (frontend/backend) are intentionally excluded — they need env the container
# lacks and would abort here; only the leaf packages are needed for type resolution.
# (See .brain/conventions.md "Environment gates vs. regressions".)
yarn build --filter='./packages/*' >>/workspace/selfcheck.log 2>&1 || \
	echo "WARN: package pre-build returned non-zero; check-types may false-red" >>/workspace/selfcheck.log

claude -p "$(cat /workspace/prompt.md)" --model "$MODEL" --dangerously-skip-permissions

selfcheck() {
	# Mirror the CI gates so the executor catches failures locally (in the one fix
	# pass below) instead of pushing red and relying on the grade round-trip.
	# `knip` matters for strip/deletion work: removing a module orphans files/deps
	# that live outside it, and knip's error-level rules (files/dependencies/
	# unlisted) fail CI. Without knip here the executor can't see those orphans
	# before pushing, and the grade-FAIL retry only reports "CI red" without the
	# specifics — which wedges the turn (bit #44). knip's pre-existing `warn`
	# backlog (exports/types) does not fail, so this only trips on NEW rot.
	yarn lint && yarn check-types && yarn knip && yarn test:db:setup && yarn test:run
}
if ! selfcheck >>/workspace/selfcheck.log 2>&1; then
	echo "--- self-check failed; giving the agent one fix pass ---" >>/workspace/selfcheck.log
	claude -p "The self-check gate failed. Output tail:
$(tail -60 /workspace/selfcheck.log)
Fix the failures. You may not weaken or skip tests. Commit the fix." \
		--model "$MODEL" --dangerously-skip-permissions
	selfcheck >>/workspace/selfcheck.log 2>&1
fi

# refuse to ship an empty attempt
git diff --quiet "origin/$BASE_BRANCH"..HEAD 2>/dev/null && { echo "NO_DIFF"; exit 21; }

git push --quiet -u origin "$BRANCH"

if [[ "$IS_RETRY" == "0" ]]; then
	TITLE=$(echo "$TITLE_B64" | base64 -d)
	{
		cat /workspace/pr-body.md 2>/dev/null || echo "Automated Yantra change for #$ISSUE."
		echo; echo "## Self-check tail"; echo '```'
		tail -20 /workspace/selfcheck.log; echo '```'
		echo; echo "Closes #$ISSUE"
	} > /workspace/final-body.md
	gh pr create --repo "$YANTRA_REPO" --base "$BASE_BRANCH" --head "$BRANCH" \
		--title "[Yantra][$TIER] $TITLE" --body-file /workspace/final-body.md
fi
WORK
chown -R node:node /workspace
# su -p preserves the injected env (GH_TOKEN, MODEL, BRANCH…); HOME must be node's own.
su node -p -s /bin/bash -c 'export HOME=/home/node; bash /workspace/work.sh'
BOOTSTRAP
}

log INFO "execute start issue=#$ISSUE run=$RUN tier=$TIER model=$MODEL branch=$BRANCH retry=${RETRY_PR:-no}"

# §2.3: infra failure → retry once after 60 s → park needs-human with the error tail.
attempt_ok=false
for attempt in 1 2; do
	if kill_switch_on; then log INFO "execute abort: kill switch on"; exit 10; fi
	rc=0
	out=$(run_container 2>&1) || rc=$?
	if [[ $rc -eq 0 ]]; then attempt_ok=true; break; fi
	if [[ $rc -eq 21 ]]; then break; fi # empty diff — not infra, don't retry
	log WARN "execute container attempt $attempt failed rc=$rc issue=#$ISSUE"
	if [[ $attempt -eq 1 ]]; then sleep 60; fi
done

if [[ "$attempt_ok" != true ]]; then
	tail_out=$(printf '%s' "${out:-no output}" | tail -c 1500)
	gh issue edit "$ISSUE" --repo "$REPO" --add-label "needs-human" --remove-label "agent:working"
	gh issue comment "$ISSUE" --repo "$REPO" --body "🤖 yantra execute run=$RUN parked (infra/self-check failure). Tail:

\`\`\`
$tail_out
\`\`\`"
	"$YANTRA_OPS_DIR/notify.sh" needs-human "$(jq -cn --argjson i "$ISSUE" '{issue:$i, reason:"execute failed"}')"
	telemetry "$RUN" "$TURN" "$ISSUE" execute "$MODEL" "$TIER" "$task_type" "$STARTED" infra_error 0 false false "$PV"
	exit 10
fi

# Success: swap labels, mirror state label onto the PR for grade.sh's scan.
pr=$RETRY_PR
if [[ -z "$pr" ]]; then
	pr=$(gh pr list --repo "$REPO" --head "$BRANCH" --state open --json number --jq '.[0].number')
fi
gh issue edit "$ISSUE" --repo "$REPO" --add-label "agent:pr-open" --remove-label "agent:working" 2>/dev/null || true
[[ -n "$pr" ]] && gh pr edit "$pr" --repo "$REPO" --add-label "agent:pr-open" --add-label "tier:$TIER" 2>/dev/null || true

log INFO "execute done issue=#$ISSUE pr=#${pr:-?} run=$RUN"
telemetry "$RUN" "$TURN" "$ISSUE" execute "$MODEL" "$TIER" "$task_type" "$STARTED" ok "${pr:-0}" false false "$PV"
exit 0

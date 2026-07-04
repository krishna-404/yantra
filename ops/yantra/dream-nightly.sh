#!/usr/bin/env bash
# Yantra DREAM nightly consolidation (loop-protocol §2.5) — 03:00 IST, one run, sonnet.
# Opens at most ONE .brain/ PR (and one yantra-skills PR when that repo exists),
# labeled tier:T3 — NEVER auto-merged (D7).

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if kill_switch_on; then log INFO "dream-nightly: kill switch on — skipping"; exit 0; fi

RUN=$(ulid); TURN=$(ulid); STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
MODEL=$(route_model dream)
PV=$(grep -m1 -oE 'prompt-version: [0-9]+' "$YANTRA_OPS_DIR/prompts/dream-nightly.md" | grep -oE '[0-9]+')

cutoff=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ)
telemetry_day=""
[[ -f "$YANTRA_RUNS" ]] && telemetry_day=$(jq -c --arg c "$cutoff" 'select(.started_at > $c)' "$YANTRA_RUNS" 2>/dev/null || true)
prs_day=$(gh pr list --repo "$REPO" --state all --limit 50 \
	--json number,title,state,mergedAt,labels \
	--jq "[.[] | select((.mergedAt // \"\") > \"$cutoff\" or .state == \"OPEN\")]" 2>/dev/null || echo "[]")

prompt_file=$(mktemp); trap 'rm -f "$prompt_file"' EXIT
{
	cat "$YANTRA_OPS_DIR/prompts/dream-nightly.md"
	echo; echo "## Today's telemetry (runs.jsonl, last 24 h)"; echo '```'
	echo "${telemetry_day:-<none>}"; echo '```'
	echo; echo "## Today's PRs"; echo '```json'; echo "$prs_day"; echo '```'
	echo; echo "Skills repo configured: ${YANTRA_SKILLS_REPO:-<none — skip the skills PR>}"
	echo; echo "The repo is cloned at your CWD. \`.brain/inbox/\` contents are in the tree."
} > "$prompt_file"

log INFO "dream-nightly start run=$RUN model=$MODEL"

set +e
docker run --rm -i \
	--memory=4g --cpus=2 --network=bridge \
	--env-file "$YANTRA_ENV_FILE" \
	-e "PROMPT_B64=$(base64 -w0 "$prompt_file")" \
	-e "MODEL=$MODEL" -e "BASE_BRANCH=$BASE_BRANCH" \
	"$YANTRA_EXEC_IMAGE" bash -s <<'BOOTSTRAP'
set -euo pipefail
# Work runs as the unprivileged `node` user — claude-code refuses
# --dangerously-skip-permissions under root.
mkdir -p /workspace
echo "$PROMPT_B64" | base64 -d > /workspace/prompt.md
cat > /workspace/work.sh <<'WORK'
set -euo pipefail
export GIT_TERMINAL_PROMPT=0
git config --global user.name "yantra-bot"
git config --global user.email "yantra-bot@users.noreply.github.com"
cd /workspace
git clone --quiet -b "$BASE_BRANCH" "https://x-access-token:${GH_TOKEN}@github.com/${YANTRA_REPO}.git" repo
cd repo
claude -p "$(cat /workspace/prompt.md)" --model "$MODEL" --dangerously-skip-permissions
WORK
chown -R node:node /workspace
su node -p -s /bin/bash -c 'export HOME=/home/node; bash /workspace/work.sh'
BOOTSTRAP
rc=$?
set -e

outcome=ok
[[ $rc -ne 0 ]] && outcome=infra_error
telemetry "$RUN" "$TURN" 0 dream "$MODEL" "" consolidation "$STARTED" "$outcome" 0 false false "$PV"
log INFO "dream-nightly done rc=$rc run=$RUN"
exit 0

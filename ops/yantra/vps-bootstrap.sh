#!/usr/bin/env bash
# Yantra — one-shot VPS bootstrap (Y0.5). Run as root on the VPS, from anywhere:
#   curl -fsSL https://raw.githubusercontent.com/<you>/yantra/main/ops/yantra/vps-bootstrap.sh | bash
# or clone first and run ./ops/yantra/vps-bootstrap.sh
# Idempotent: safe to re-run after fixing a failed step. Prompts for secrets it
# doesn't have; never echoes them back.

set -euo pipefail

YANTRA_HOME=/opt/yantra
ENV_FILE=$YANTRA_HOME/env/yantra.env
REPO_DIR=$YANTRA_HOME/repo

say()  { echo -e "\n\033[1m== $*\033[0m"; }
fail() { echo "FATAL: $*" >&2; exit 1; }

say "1/8 Directories"
mkdir -p $YANTRA_HOME/{bin,prompts,telemetry,env}
chmod 700 $YANTRA_HOME/env

say "2/8 Host packages (docker expected via Dokploy)"
command -v docker >/dev/null || fail "docker missing — install Dokploy/docker first"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git jq curl >/dev/null
if ! command -v gh >/dev/null; then
	curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
		-o /usr/share/keyrings/githubcli-archive-keyring.gpg
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		> /etc/apt/sources.list.d/github-cli.list
	apt-get update -qq && apt-get install -y -qq gh >/dev/null
fi
echo "docker=$(docker --version | cut -d, -f1) gh=$(gh --version | head -1) jq=$(jq --version)"

say "3/8 Credentials → $ENV_FILE"
touch $ENV_FILE && chmod 600 $ENV_FILE
ensure_var() { # ensure_var NAME "prompt text"
	local name="$1" prompt="$2" val
	if grep -q "^$name=" $ENV_FILE 2>/dev/null && [[ -n "$(grep "^$name=" $ENV_FILE | cut -d= -f2-)" ]]; then
		echo "$name: already set — keeping"
		return
	fi
	read -r -s -p "$prompt: " val < /dev/tty; echo
	[[ -n "$val" ]] || fail "$name cannot be empty"
	grep -q "^$name=" $ENV_FILE && sed -i "s|^$name=.*|$name=$val|" $ENV_FILE || echo "$name=$val" >> $ENV_FILE
	echo "$name: saved"
}
ensure_var YANTRA_REPO "GitHub repo (owner/repo, e.g. krishna-404/yantra)"
ensure_var GH_TOKEN "Fine-grained PAT (Contents/Issues/PRs RW, Actions/Admin R, Variables RW)"
ensure_var CLAUDE_CODE_OAUTH_TOKEN "Claude token (run 'claude setup-token' on your Mac, paste output)"
ensure_var NOVU_SECRET_KEY "Novu secret key"
# Optional knobs — uncomment/set in $ENV_FILE by hand if needed:
#   YANTRA_NOVU_WORKFLOW=<existing workflow id to ride tonight>
#   YANTRA_NOVU_SUBSCRIBER=<subscriberId, default yantra-operator>
#   YANTRA_SKILLS_REPO=<owner/yantra-skills, Phase 1>

say "4/8 Repo clone → $REPO_DIR (the clone IS the deployment)"
# Integration branch: we always work on staging (convention since 2026-07-04).
grep -q "^YANTRA_BASE_BRANCH=" $ENV_FILE || echo "YANTRA_BASE_BRANCH=staging" >> $ENV_FILE
# shellcheck disable=SC1090
source <(grep -E '^(YANTRA_REPO|GH_TOKEN|YANTRA_BASE_BRANCH)=' $ENV_FILE)
if [[ -d $REPO_DIR/.git ]]; then
	git -C $REPO_DIR checkout "$YANTRA_BASE_BRANCH" && git -C $REPO_DIR pull --ff-only
else
	git clone -b "$YANTRA_BASE_BRANCH" "https://x-access-token:${GH_TOKEN}@github.com/${YANTRA_REPO}.git" $REPO_DIR
fi

say "5/8 gh auth + labels"
export GH_TOKEN
gh auth status >/dev/null 2>&1 || true
YANTRA_REPO=$YANTRA_REPO bash $REPO_DIR/ops/yantra/setup-labels.sh
gh api "repos/$YANTRA_REPO/actions/variables/YANTRA_KILL" --jq .value >/dev/null 2>&1 \
	|| echo "WARNING: Actions variable YANTRA_KILL not found — create it (value: false) in repo Settings → Secrets and variables → Actions → Variables"

say "6/8 Build yantra-exec image"
docker build -t yantra-exec:0 $REPO_DIR/ops/yantra/

say "7/8 Sanity checks"
echo "- claude auth in-container (must print READY):"
docker run --rm --env-file $ENV_FILE yantra-exec:0 claude -p "Say READY" --model sonnet \
	|| fail "claude auth failed in-container — see Phase-0 failure playbook (run execute on host tonight)"
echo "- Novu smoke (generic trigger; delivery on your phone = pipe proven):"
bash $REPO_DIR/ops/yantra/notify.sh needs-human '{"reason":"vps-bootstrap smoke test"}' || true

say "8/8 systemd units (loop timer NOT started — that's the Y0.8 go-live)"
cp $REPO_DIR/ops/yantra/systemd/* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now yantra-dream.timer
systemctl enable yantra-loop.timer
echo
echo "DONE. When SB-1 sits in 'Agent: ready' and you're watching (Y0.8):"
echo "    systemctl start yantra-loop.timer"
echo "Kill switch: repo Actions variable YANTRA_KILL=true stops everything at the next transition."

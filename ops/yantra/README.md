# ops/yantra — loop v0 (Phase 0 bootstrap harness)

Implements `docs/yantra/loop-protocol.md` in bash + `gh` + `jq` + `docker`.
Retired in Phase 2 when `apps/yantra` passes the parity suite. Everything here is
**T3** — the loop may never modify this directory (rail R2).

## Deploy (VPS)

The integration branch is `staging` (`YANTRA_BASE_BRANCH`, set in the env file):
execute branches from it, PRs target it, canary watches its CI, branch protection
+ required checks apply to it.

```bash
# one-time (after Y0.5's dirs/env/creds exist) — or just run vps-bootstrap.sh
git clone -b staging git@github.com:<you>/yantra.git /opt/yantra/repo   # the clone IS the deployment
docker build -t yantra-exec:0 /opt/yantra/repo/ops/yantra/
YANTRA_REPO=<you>/yantra /opt/yantra/repo/ops/yantra/setup-labels.sh
cp /opt/yantra/repo/ops/yantra/systemd/* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now yantra-dream.timer
systemctl start yantra-loop.timer          # ← the moment the factory goes live (Y0.8)

# update = git pull (nothing else)
git -C /opt/yantra/repo pull
```

`/opt/yantra/env/yantra.env` (chmod 600) needs: `YANTRA_REPO`, `GH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, `NOVU_SECRET_KEY` (+ optional `YANTRA_NOVU_WORKFLOW`,
`YANTRA_NOVU_SUBSCRIBER`, `YANTRA_SKILLS_REPO`).

## Y0.6 acceptance dry-run

```bash
# 1. Kill switch: set repo variable YANTRA_KILL=true, then
./loop-tick.sh            # → exits 0, logs "killed", zero label changes on any issue

# 2. Vague spec parks: file a fixture issue with a deliberately vague body, label it
#    spec:ready, run ./loop-tick.sh → issue gains needs-human, Novu fires, claim released.

# 3. Rails unit test (no network needed past the R2 check):
source ./grade.sh --lib-only
echo '{"additions":120,"deletions":40,"changedFiles":3,"files":[{"path":"README.md"}]}' \
  | { read -r pj; rails_check "$pj" T0 PASS; }   # → "R2: diff 160 changed lines > 150", rc 1
```

## Files

| File | Contract |
|---|---|
| `loop-tick.sh` | One tick: kill check → canary → reap → grade → claim → advise → execute → dream micro-write. Exit 0 always. |
| `advise.sh` | Plan gate (`claude -p`, opus, host-side). PROCEED/AMBIGUOUS/REJECT + tier label. |
| `execute.sh` | One containerized build run → one PR. Hard self-check gate before push. |
| `grade.sh` | CI leg + rubric leg (opus container). Rails R1–R4 → squash auto-merge (T0 only). Retry orchestration. |
| `canary.sh` | R5: red main CI after an auto-merge ⇒ revert PR + kill switch + Novu. |
| `dream-nightly.sh` | 03:00 IST consolidation; ≤ 1 `.brain/` PR + ≤ 1 skills PR, always T3. |
| `notify.sh` | Novu trigger wrapper (needs-human / review-digest / killed). Never wedges the loop. |
| `setup-labels.sh` | Idempotent label creation (loop-protocol §1). |
| `routing.json` | Static v0 role→model table (§4). Read fresh each turn. |
| `prompts/*.md` | Versioned role prompts (§3). Changes are T3. |
| `systemd/*` | `yantra-loop.timer` (10 min) · `yantra-dream.timer` (03:00 IST). |
| `Dockerfile` | `yantra-exec` image (§7): node 22 + git + gh + jq + postgres + claude-code. |

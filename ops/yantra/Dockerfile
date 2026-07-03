# yantra-exec — the one-run execute/grade/dream container (loop-protocol §7).
# Build:  docker build -t yantra-exec:0 ops/yantra/
# Run:    --memory=4g --cpus=2 --network=bridge --env-file /opt/yantra/env/yantra.env
# No host mounts; the workspace is cloned inside and dies with the container.

FROM node:22-bookworm

# git + gh CLI + jq + postgres (for the in-container self-check suite; matches
# apps/backend/.env.test: localhost:5432, postgres/postgres)
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl gnupg jq git \
	&& curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
		-o /usr/share/keyrings/githubcli-archive-keyring.gpg \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		> /etc/apt/sources.list.d/github-cli.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends gh postgresql \
	&& rm -rf /var/lib/apt/lists/*

# Claude Code — major-version pin; tighten to an exact version after the first
# successful VPS build (prompt/harness changes are T3 either way).
ARG CLAUDE_CODE_VERSION=2
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# yarn 1.x ships with the node image; verify the toolchain at build time.
RUN git --version && gh --version && jq --version && yarn --version && claude --version

WORKDIR /workspace

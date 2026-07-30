# yantra-exec-oc — the free-lane run container (Phase 3). Same in/out contract
# as yantra-exec (prompt in, branch+PR out), but the coding agent is OpenCode
# driving a free provider (NVIDIA today) instead of Claude Code.
#
# Build:  docker build -t yantra-exec-oc:0 ops/yantra/oc/
# Run:    --memory=4g --cpus=2 --network=bridge
#         -e NVIDIA_API_KEY=… -e MODEL=nvidia/<model> -e PROMPT_B64=… …
# No host mounts; the workspace is cloned inside and dies with the container.

FROM node:22-bookworm

# git + gh CLI + jq + postgres (in-container self-check suite; matches
# apps/backend/.env.test: localhost:5432, postgres/postgres) — identical to the
# Claude exec image so self-check behaves the same across lanes.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl gnupg jq git \
	&& curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
		-o /usr/share/keyrings/githubcli-archive-keyring.gpg \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		> /etc/apt/sources.list.d/github-cli.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends gh postgresql \
	&& rm -rf /var/lib/apt/lists/*

# OpenCode CLI — major-version pin; tighten to an exact version after the first
# successful VPS build (prompt/harness changes are T3 either way).
ARG OPENCODE_VERSION=latest
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}"

# The NVIDIA provider config (custom OpenAI-compatible provider; the API key is
# read from $NVIDIA_API_KEY at run time via {env:…}). Placed at the global
# config path so `opencode run` picks it up regardless of workspace cwd.
COPY opencode.json /root/.config/opencode/opencode.json

# node user needs the config too (claude-code refuses root; OpenCode likewise
# runs as the unprivileged node user for the actual work).
RUN mkdir -p /home/node/.config/opencode \
	&& cp /root/.config/opencode/opencode.json /home/node/.config/opencode/opencode.json \
	&& chown -R node:node /home/node/.config

# Verify the toolchain at build time (opencode --version proves the CLI works).
RUN git --version && gh --version && jq --version && yarn --version && opencode --version

WORKDIR /workspace

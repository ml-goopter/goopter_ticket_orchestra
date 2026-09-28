# orchestra/agent (docs/design.md §9.9). Build with deploy/agent-image/
# build.sh; its context is the repository root (this Dockerfile is passed
# with `-f`, not by `cd`-ing into this directory).
#
# Contents: Debian slim, git, gh, Node 22, the claude CLI, the codex CLI,
# and orchestra-review built from packages/review-wrapper. No repository
# toolchains, no secrets.

# ---------------------------------------------------------------------------
# Stage 1: build packages/review-wrapper and its workspace dependencies
# (@orchestra/core, @orchestra/prompts, @orchestra/adapters) from source.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

RUN corepack enable && corepack prepare pnpm@12.6.0 --activate

WORKDIR /repo
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @orchestra/review-wrapper... run build
# `pnpm deploy` clones the package plus its production dependency graph
# (workspace deps included, already built above) into a self-contained
# directory with real files rather than pnpm's workspace symlinks, so it
# survives the COPY --from below on its own.
RUN pnpm --filter @orchestra/review-wrapper deploy --prod --legacy /out/review-wrapper

# ---------------------------------------------------------------------------
# Stage 2: runtime image.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# Defaults: claude pinned to the claudeCodeVersion that
# @anthropic-ai/claude-agent-sdk@0.3.282 (packages/adapters/package.json)
# was published against; codex pinned to a known-good release. Both
# overridable with --build-arg.
ARG CLAUDE_CLI_VERSION=2.1.282
ARG CODEX_CLI_VERSION=0.158.0

# procps provides the standalone /usr/bin/kill binary `docker exec
# <container> kill -KILL -<pgid>` needs; the shells' builtin `kill` is not
# reachable that way.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git gh ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g \
      "@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}" \
      "@openai/codex@${CODEX_CLI_VERSION}" \
    && npm cache clean --force

COPY --from=builder /out/review-wrapper /opt/orchestra-review
RUN ln -s /opt/orchestra-review/bin/orchestra-review.js /usr/local/bin/orchestra-review

COPY deploy/agent-image/orchestra-launch /usr/local/bin/orchestra-launch
RUN chmod 0755 /usr/local/bin/orchestra-launch \
    # /run/orchestra must be writable by whatever uid `docker run --user`
    # picks at run time (D20: containers run as the worker's uid/gid, but
    # this image itself bakes in no fixed user), so it is world-writable
    # with the sticky bit, like /tmp.
    && mkdir -p /run/orchestra \
    && chmod 1777 /run/orchestra

# Idles between turns; every actual command runs through `docker exec`
# (docs/design.md §9.9).
CMD ["sleep", "infinity"]

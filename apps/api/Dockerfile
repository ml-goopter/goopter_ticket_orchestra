# Multi-stage build for @orchestra/api (design.md §15.1).
#
# The `migrate` compose service reuses this same image (design.md context for
# GOT.17: "prefer reusing the api image") and overrides `command` to run
# `pnpm --filter @orchestra/db migrate` instead of the default CMD below.
# The final stage keeps the full workspace install (including devDependencies
# such as tsx, needed by the db package's `migrate` script) rather than a
# pruned production install, so one image serves both services.
#
# Build context is the repository root (see docker-compose.yml).

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/adapters/package.json packages/adapters/package.json
COPY packages/prompts/package.json packages/prompts/package.json
COPY packages/review-wrapper/package.json packages/review-wrapper/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm -r build

# `apps/api/src/index.ts` is currently a placeholder export with no server
# (see apps/api/src/index.ts). `node apps/api/dist/index.js` will exit
# immediately until GOT.18 adds a Fastify server that listens and blocks.
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]

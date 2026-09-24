# Multi-stage build for @orchestra/web (design.md §15.1).
# Build stage compiles the Vite bundle; runtime stage serves apps/web/dist
# from nginx on port 8080 and proxies /api to the api service (nginx.conf).
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

FROM nginx:alpine AS runtime
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080

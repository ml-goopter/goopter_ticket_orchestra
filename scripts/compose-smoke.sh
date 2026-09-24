#!/usr/bin/env bash
# Smoke-tests the compose stack (design.md §15.1, GOT.17):
#   1. every design.md §15.3 env var appears exactly once in .env.example
#   2. db becomes healthy and migrate exits 0 against it
#   3. the tasks table exists after migrate runs
#   4. nginx -t passes and web serves / with no api container running (F1)
#   5. the SSE stream location matches /api/stream and /api/<id>/stream (F2)
# Uses a throwaway compose project so it never touches a developer's real
# `orchestra` project or volumes. Exits non-zero on any failure.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PROJECT="orchestra-smoke"
CREATED_ENV=0

cleanup() {
  local status=$?
  docker compose -p "$PROJECT" down -v --remove-orphans >/dev/null 2>&1 || true
  if [ "$CREATED_ENV" -eq 1 ]; then
    rm -f .env
  fi
  exit "$status"
}
trap cleanup EXIT

if [ ! -f .env ]; then
  cp .env.example .env
  CREATED_ENV=1
  echo "Created temp .env from .env.example."
fi

# --- AC4: every design.md §15.3 variable present exactly once ---
required_vars=(
  DATABASE_URL SESSION_SECRET JIRA_BASE_URL JIRA_EMAIL JIRA_API_TOKEN
  GITHUB_TOKEN ANTHROPIC_API_KEY OPENAI_API_KEY WORKER_HOST
  WORKER_CAPABILITIES WORKER_MAX_CONCURRENT WORKER_WORKSPACE_ROOT
  WORKER_TOOLS_PORT WORKER_DISK_HIGH_WATER_PCT AGENT_QUIET_TIMEOUT_MS
  PRICING_FILE PUBLIC_URL
)
missing=0
for var in "${required_vars[@]}"; do
  count=$(grep -cE "^${var}=" .env.example || true)
  if [ "$count" -ne 1 ]; then
    echo "FAIL: ${var} appears ${count} time(s) in .env.example (expected 1)" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "FAIL: .env.example does not list every design.md §15.3 variable exactly once" >&2
  exit 1
fi
echo "OK: all ${#required_vars[@]} design.md §15.3 variables present exactly once in .env.example"

# --- AC2: db healthy, migrate exits 0, tasks table present ---
db_user="$(grep -E '^POSTGRES_USER=' .env | head -1 | cut -d= -f2- | sed 's/#.*//' | xargs)"
db_name="$(grep -E '^POSTGRES_DB=' .env | head -1 | cut -d= -f2- | sed 's/#.*//' | xargs)"
db_user="${db_user:-orchestra}"
db_name="${db_name:-orchestra}"

echo "Bringing up db and migrate under project ${PROJECT}..."
docker compose -p "$PROJECT" up -d --build db migrate

migrate_cid="$(docker compose -p "$PROJECT" ps -q migrate)"
if [ -z "$migrate_cid" ]; then
  echo "FAIL: migrate container did not start" >&2
  exit 1
fi

echo "Waiting for migrate to exit..."
exit_code="$(docker wait "$migrate_cid")"
if [ "$exit_code" != "0" ]; then
  echo "FAIL: migrate exited ${exit_code}, expected 0" >&2
  docker compose -p "$PROJECT" logs migrate >&2 || true
  exit 1
fi
echo "OK: migrate exited 0"

db_cid="$(docker compose -p "$PROJECT" ps -q db)"
health="$(docker inspect -f '{{.State.Health.Status}}' "$db_cid" 2>/dev/null || echo unknown)"
if [ "$health" != "healthy" ]; then
  echo "FAIL: db healthcheck status is '${health}', expected 'healthy'" >&2
  exit 1
fi
echo "OK: db is healthy"

tables="$(docker compose -p "$PROJECT" exec -T db psql -U "$db_user" -d "$db_name" -c '\dt' 2>&1)"
echo "$tables"
if ! echo "$tables" | grep -qw "tasks"; then
  echo "FAIL: tasks table not found after migrate" >&2
  exit 1
fi
echo "OK: tasks table present"

# --- AC2: stream location regex matches /api/stream and /api/<id>/stream ---
stream_regex="$(awk '/location ~/ {print $3; exit}' apps/web/nginx.conf)"
if [ -z "$stream_regex" ]; then
  echo "FAIL: could not find stream location regex in apps/web/nginx.conf" >&2
  exit 1
fi
for path in "/api/stream" "/api/tasks/abc/stream"; do
  if ! printf '%s' "$path" | grep -qE "$stream_regex"; then
    echo "FAIL: stream regex '${stream_regex}' does not match '${path}'" >&2
    exit 1
  fi
done
echo "OK: stream location regex matches /api/stream and /api/tasks/<id>/stream"

# --- AC1: nginx -t passes and web serves / with no api container running ---
echo "Building web image under project ${PROJECT}..."
docker compose -p "$PROJECT" build web

echo "Checking nginx config with no api container running..."
if ! docker compose -p "$PROJECT" run --rm --no-deps web nginx -t; then
  echo "FAIL: nginx -t failed with no api container running" >&2
  exit 1
fi
echo "OK: nginx -t passed with no api container running"

echo "Starting web (no api) to verify / responds..."
docker compose -p "$PROJECT" up -d --no-deps web

response=""
for _ in $(seq 1 20); do
  response="$(docker compose -p "$PROJECT" exec -T web wget -S -O /dev/null http://127.0.0.1:8080/ 2>&1 || true)"
  if printf '%s' "$response" | grep -q "HTTP/1.1 200"; then
    break
  fi
  sleep 0.5
done
if ! printf '%s' "$response" | grep -q "HTTP/1.1 200"; then
  echo "FAIL: web did not return 200 for / with no api container running" >&2
  echo "$response" >&2
  exit 1
fi
echo "OK: web returns 200 for / with no api container running"

docker compose -p "$PROJECT" stop web >/dev/null

echo "compose-smoke: PASS (stack will be torn down on exit)"

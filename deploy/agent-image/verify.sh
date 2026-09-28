#!/usr/bin/env bash
# Verifies deploy/agent-image/Dockerfile and build.sh against docs/design.md
# §9.9 (written before the Dockerfile existed). Builds the image through
# build.sh and asserts every acceptance criterion; exits non-zero on the
# first failure.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

tmp_root="$(mktemp -d)"
container_name="orchestra-agent-verify-$$"
custom_image="orchestra/agent:verify-custom-$$"
override_image="orchestra/agent:verify-override-$$"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  docker rmi "$custom_image" >/dev/null 2>&1 || true
  docker rmi "$override_image" >/dev/null 2>&1 || true
  rm -rf "$tmp_root"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $1" >&2
  exit 1
}
pass() {
  echo "PASS: $1"
}

echo "== building image via build.sh (default version) =="
image="$(bash "$script_dir/build.sh")"
[ -n "$image" ] || fail "build.sh printed no image tag"
docker image inspect "$image" >/dev/null || fail "build.sh reported $image but it does not exist"
pass "built $image"

echo "== Debian slim base =="
os_release="$(docker run --rm "$image" cat /etc/os-release)"
echo "$os_release" | grep -q '^ID=debian' || fail "base image is not Debian: $os_release"
pass "Debian base"

echo "== default command is 'sleep infinity' =="
cmd_json="$(docker inspect --format '{{json .Config.Cmd}}' "$image")"
[ "$cmd_json" = '["sleep","infinity"]' ] \
  || fail "default CMD is $cmd_json, expected [\"sleep\",\"infinity\"]"
pass "default CMD is sleep infinity"

echo "== git, gh, Node 22, claude, codex, orchestra-review on PATH =="
docker run --rm "$image" git --version >/dev/null || fail "git missing"
docker run --rm "$image" gh --version >/dev/null || fail "gh missing"
node_version="$(docker run --rm "$image" node --version)"
case "$node_version" in
  v22.*) : ;;
  *) fail "node --version is $node_version, expected v22.x" ;;
esac
docker run --rm "$image" claude --version >/dev/null || fail "claude CLI missing or failed to start"
docker run --rm "$image" codex --version >/dev/null || fail "codex CLI missing or failed to start"
docker run --rm "$image" sh -c 'command -v orchestra-review' >/dev/null \
  || fail "orchestra-review is not on PATH"
pass "toolchain present"

echo "== claude/codex CLI versions pinned via build args =="
claude_version_output="$(docker run --rm "$image" claude --version)"
echo "$claude_version_output" | grep -q '2\.1\.282' \
  || fail "default claude version is '$claude_version_output', expected to contain 2.1.282 (the claudeCodeVersion @anthropic-ai/claude-agent-sdk@0.3.282 was published against)"

docker build \
  -f "$script_dir/Dockerfile" \
  --build-arg CLAUDE_CLI_VERSION=2.1.281 \
  --build-arg CODEX_CLI_VERSION=0.157.0 \
  -t "$custom_image" \
  "$repo_root" >"$tmp_root/custom-build.log" 2>&1 \
  || { cat "$tmp_root/custom-build.log" >&2; fail "build with overridden CLI version build-args failed"; }
custom_claude_version="$(docker run --rm "$custom_image" claude --version)"
echo "$custom_claude_version" | grep -q '2\.1\.281' \
  || fail "--build-arg CLAUDE_CLI_VERSION=2.1.281 did not take effect, got '$custom_claude_version'"
custom_codex_version="$(docker run --rm "$custom_image" codex --version)"
echo "$custom_codex_version" | grep -q '0\.157\.0' \
  || fail "--build-arg CODEX_CLI_VERSION=0.157.0 did not take effect, got '$custom_codex_version'"
pass "claude/codex CLI versions pinned and overridable via build args"

echo "== build.sh tags orchestra/agent:<version>, default and overridden =="
pkg_version="$(node -p "require('$repo_root/package.json').version")"
[ "$image" = "orchestra/agent:${pkg_version}" ] \
  || fail "default build tag is $image, expected orchestra/agent:${pkg_version}"

override_tag="$(bash "$script_dir/build.sh" verify-override-$$)"
[ "$override_tag" = "orchestra/agent:verify-override-$$" ] \
  || fail "version-argument override produced $override_tag, expected orchestra/agent:verify-override-$$"
docker image inspect "$override_tag" >/dev/null || fail "override-tagged image $override_tag does not exist"
pass "build.sh version tagging (default + override)"

echo "== no repository checkout, toolchain, or credential baked into the image =="
docker run --rm "$image" sh -c 'test ! -e /repo' \
  || fail "the builder stage's /repo checkout leaked into the runtime image"
env_json="$(docker inspect --format '{{json .Config.Env}}' "$image")"
if echo "$env_json" | grep -Eiq 'TOKEN|SECRET|API_KEY|PASSWORD'; then
  fail "image bakes in an env var that looks like a credential: $env_json"
fi
pass "no repo checkout or baked-in credential env vars"

echo "== arbitrary uid/gid: CLIs and orchestra-review start without a passwd entry or writes outside HOME =="
ro_home="$tmp_root/ro-home"
mkdir -p "$ro_home"
run_ro() {
  # --read-only: nothing but the HOME bind mount is writable, so any write
  # attempt outside HOME fails loudly instead of silently succeeding.
  docker run --rm --user 313131:313131 --read-only \
    -e HOME=/mnt/home -v "$ro_home:/mnt/home" "$image" "$@"
}
run_ro claude --version >/dev/null || fail "claude --version failed under an arbitrary uid with no passwd entry"
run_ro codex --version >/dev/null || fail "codex --version failed under an arbitrary uid with no passwd entry"
run_ro git --version >/dev/null || fail "git --version failed under an arbitrary uid with no passwd entry"
run_ro gh --version >/dev/null || fail "gh --version failed under an arbitrary uid with no passwd entry"
review_output="$(run_ro orchestra-review 2>&1 || true)"
echo "$review_output" | grep -q 'usage: orchestra-review --round' \
  || fail "orchestra-review did not start cleanly under an arbitrary uid: $review_output"
pass "arbitrary uid/gid works with no passwd entry and no writes outside HOME"

echo "== orchestra-launch: new process group, pid file, stdio passthrough, exit code =="
launch_home="$tmp_root/launch-home"
mkdir -p "$launch_home"
docker run -d --name "$container_name" --user 313131:313131 \
  -e HOME=/mnt/home -v "$launch_home:/mnt/home" "$image" >/dev/null

stdio_out="$(printf 'hello-stdin\n' | docker exec -i "$container_name" orchestra-launch t1 -- cat)"
[ "$stdio_out" = "hello-stdin" ] || fail "orchestra-launch did not pass stdin/stdout through, got '$stdio_out'"

stderr_out="$(docker exec "$container_name" sh -c 'orchestra-launch t2 -- sh -c "echo to-stderr >&2"' 2>&1 1>/dev/null)"
[ "$stderr_out" = "to-stderr" ] || fail "orchestra-launch did not pass stderr through, got '$stderr_out'"

set +e
docker exec "$container_name" orchestra-launch t3 -- sh -c 'exit 7'
launch_exit=$?
set -e
[ "$launch_exit" -eq 7 ] || fail "orchestra-launch exited $launch_exit, expected cmd's own exit code 7"
pass "orchestra-launch stdio passthrough and exit code passthrough"

echo "== orchestra-launch: <turn> cannot escape /run/orchestra =="
set +e
turn_output="$(docker exec "$container_name" orchestra-launch '../escape' -- true 2>&1)"
turn_exit=$?
set -e
[ "$turn_exit" -ne 0 ] || fail "orchestra-launch accepted a turn containing '/' instead of rejecting it"
echo "$turn_output" | grep -qi 'invalid' || fail "orchestra-launch's rejection message was unclear: $turn_output"
docker exec "$container_name" sh -c 'test ! -e /escape.pid && test ! -e /escape' \
  || fail "a path-traversing turn wrote a file outside /run/orchestra"
pass "invalid turn rejected, no path traversal"

echo "== /run/orchestra is writable by the arbitrary uid and records the process group id =="
docker exec -d "$container_name" orchestra-launch killme -- sh -c 'sleep 300 & sleep 300 & wait'
sleep 1
pgid="$(docker exec "$container_name" cat /run/orchestra/killme.pid)"
case "$pgid" in
  ''|*[!0-9]*) fail "pid file /run/orchestra/killme.pid did not contain a plain integer: '$pgid'" ;;
esac
before="$(docker top "$container_name")"
echo "$before" | grep -q 'sleep 300' \
  || fail "expected sleep 300 processes to be running before the kill test"
pass "pid file written under the arbitrary uid: pgid=$pgid"

echo "== a separate 'docker exec <container> kill -KILL -<pgid>' stops cmd and its children =="
docker exec "$container_name" kill -KILL -- -"$pgid"
sleep 1
after="$(docker top "$container_name")"
if echo "$after" | grep -q 'sleep 300'; then
  fail "sleep 300 processes survived kill -KILL -${pgid}: $after"
fi
pass "kill -KILL -<pgid> from a separate docker exec stopped cmd and its children"

echo
echo "ALL CHECKS PASSED: $image"

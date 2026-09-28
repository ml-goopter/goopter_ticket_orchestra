#!/usr/bin/env bash
# Builds orchestra/agent:<version> (docs/design.md §9.9).
#
#   deploy/agent-image/build.sh [version]
#
# <version> defaults to the root package.json version. The build context is
# the repository root, since the image is built from packages/review-wrapper
# and its workspace dependencies.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"

version="${1:-$(node -p "require('$repo_root/package.json').version")}"
image="orchestra/agent:${version}"

docker build \
  -f "$script_dir/Dockerfile" \
  -t "$image" \
  "$repo_root"

echo "$image"

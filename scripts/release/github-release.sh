#!/usr/bin/env bash
# Create the git tag and GitHub Release for one package, idempotently.
#
#   scripts/release/github-release.sh <package-id> <tag> <version> <prerelease:true|false> [asset...]
#
# Needs GH_TOKEN (contents: write) and GITHUB_SHA (the commit to tag).
# Re-running is safe: an existing release is left as is (missing assets are uploaded).
set -euo pipefail

if [ "$#" -lt 4 ]; then
  echo "usage: $0 <package-id> <tag> <version> <prerelease> [asset...]" >&2
  exit 2
fi
id=$1 tag=$2 version=$3 prerelease=$4
shift 4

: "${GH_TOKEN:?GH_TOKEN is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"

root=$(git rev-parse --show-toplevel)
notes=$(mktemp)
trap 'rm -f "$notes"' EXIT
node "$root/scripts/release/plan.mjs" notes "$id" >"$notes"

if gh release view "$tag" >/dev/null 2>&1; then
  echo "release $tag already exists"
  if [ "$#" -gt 0 ]; then
    gh release upload "$tag" "$@" --clobber
  fi
  exit 0
fi

flags=(--title "$id $version" --notes-file "$notes" --target "$GITHUB_SHA" --latest=false)
if [ "$prerelease" = "true" ]; then
  flags+=(--prerelease)
fi

# gh creates the tag at --target when it does not exist yet.
gh release create "$tag" "${flags[@]}" "$@"
echo "created release $tag"

#!/usr/bin/env bash
# GitHub's copy of the last registry signature (review #97 M1, R1): the newest unexpired
# `registry-signed` artefact of a run on `main` (merge signatures in website.yml, weekly re-signs
# in registry-resign.yml), unpacked into $1. It is only a floor and a fallback: registry-sign.mjs
# verifies it against the pinned roots before using it. Leaves $1 empty when there is none.
# Needs `gh` and GH_TOKEN with actions: read.
set -euo pipefail
out="$1"
mkdir -p "$out"
id="$(gh api "repos/$GITHUB_REPOSITORY/actions/artifacts?name=registry-signed&per_page=50" \
  --jq '[.artifacts[] | select(.expired == false and .workflow_run.head_branch == "main")] | sort_by(.created_at) | last | .id // empty')"
if [ -z "$id" ]; then
  echo "no registry signature is stored on GitHub yet"
  exit 0
fi
gh api "repos/$GITHUB_REPOSITORY/actions/artifacts/$id/zip" > "$RUNNER_TEMP/last-signed.zip"
unzip -q -o "$RUNNER_TEMP/last-signed.zip" -d "$out"
echo "last signature: artefact $id"

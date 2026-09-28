#!/usr/bin/env bash
# Publish public/ to the gh-pages branch (GitHub Pages serves it at
# https://dimkadimon.github.io/dual-2048/ ).
#
# The game is static and talks to the leaderboard store directly, so the
# branch is just a copy of public/ — run this after changing anything
# under public/.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
url="$(git -C "$root" remote get-url origin)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

cp -r "$root/public/." "$tmp/"
cd "$tmp"
git init -q
git add -A
git -c user.name='dual-2048 deploy' -c user.email='deploy@users.noreply.github.com' \
  commit -q -m "deploy: Dual 2048 static site $(date -u +%Y-%m-%dT%H:%MZ)"
git push -q -f "$url" HEAD:gh-pages

echo "published public/ → gh-pages"

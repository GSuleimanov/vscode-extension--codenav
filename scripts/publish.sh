#!/usr/bin/env bash
#
# Publish the extension to both the VS Code Marketplace (vsce) and Open VSX (ovsx).
#
# Builds a single .vsix and publishes that same artifact to both registries so the
# two listings are guaranteed identical.
#
# Prereqs (one-time):
#   npx vsce login <publisher>     # stores a Marketplace PAT
#   export OVSX_PAT=<token>        # or pass --pat to ovsx / store via your shell
#
# Usage:
#   scripts/publish.sh                 # publish current version in package.json
#   scripts/publish.sh patch           # bump patch, then publish
#   scripts/publish.sh minor|major     # bump minor/major, then publish
#   scripts/publish.sh 1.2.3           # set explicit version, then publish
#
# Env:
#   OVSX_PAT   Open VSX personal access token (required for the ovsx step).

set -euo pipefail

cd "$(dirname "$0")/.."

BUMP="${1:-}"

# --- optional version bump ---------------------------------------------------
if [[ -n "$BUMP" ]]; then
  echo "==> Bumping version: $BUMP"
  # --no-git-tag-version: we control commits/tags ourselves
  npm version "$BUMP" --no-git-tag-version >/dev/null
fi

VERSION="$(node -p "require('./package.json').version")"
NAME="$(node -p "require('./package.json').name")"
VSIX="${NAME}-${VERSION}.vsix"

echo "==> Packaging ${VSIX}"
rm -f "$VSIX"
npx vsce package -o "$VSIX"

echo "==> Publishing to VS Code Marketplace"
npx vsce publish --packagePath "$VSIX"

echo "==> Publishing to Open VSX"
if [[ -n "${OVSX_PAT:-}" ]]; then
  npx ovsx publish "$VSIX" -p "$OVSX_PAT"
else
  # Falls back to ovsx's stored credentials if OVSX_PAT is unset.
  npx ovsx publish "$VSIX"
fi

echo "==> Done: published v${VERSION} to both registries"
echo "    Marketplace: https://marketplace.visualstudio.com/items?itemName=$(node -p "require('./package.json').publisher").${NAME}"
echo "    Open VSX:    https://open-vsx.org/extension/$(node -p "require('./package.json').publisher")/${NAME}"

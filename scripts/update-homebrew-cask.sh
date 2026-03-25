#!/bin/bash
# Manually update the Homebrew cask in a local homebrew-tap checkout.
# Usage: ./scripts/update-homebrew-cask.sh [path-to-homebrew-tap]
#
# Defaults to ../homebrew-tap relative to this repo.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
TAP_DIR="${1:-$(dirname "$REPO_ROOT")/homebrew-tap}"

VERSION=$(node -p "require('$REPO_ROOT/package.json').version")
DMG_PATH="$REPO_ROOT/dist/Outworked-${VERSION}.dmg"

if [ ! -f "$DMG_PATH" ]; then
  echo "DMG not found at $DMG_PATH"
  echo "Run 'npm run electron:build' first, or pass the tap path after building."
  exit 1
fi

SHA=$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')
CASK="$TAP_DIR/Casks/outworked.rb"

if [ ! -f "$CASK" ]; then
  echo "Cask file not found at $CASK"
  exit 1
fi

sed -i '' "s/version \".*\"/version \"${VERSION}\"/" "$CASK"
sed -i '' "s/sha256 \".*\"/sha256 \"${SHA}\"/" "$CASK"

echo "Updated $CASK to version ${VERSION} (sha256: ${SHA})"

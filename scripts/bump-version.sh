#!/bin/bash
# Called by npm's "version" lifecycle hook.
# Updates version references in README.md and RELEASE_TEMPLATE.md
# to match the new version from package.json.

set -e

VERSION=$(node -p "require('./package.json').version")

# README.md — update badge, download link, and release tag references
sed -i '' \
  -e "s|version-[0-9]*\.[0-9]*\.[0-9]*-green|version-${VERSION}-green|g" \
  -e "s|releases/tag/v[0-9]*\.[0-9]*\.[0-9]*|releases/tag/v${VERSION}|g" \
  -e "s|releases/download/v[0-9]*\.[0-9]*\.[0-9]*/Outworked-[0-9]*\.[0-9]*\.[0-9]*|releases/download/v${VERSION}/Outworked-${VERSION}|g" \
  -e "s|Download_for_macOS-v[0-9]*\.[0-9]*\.[0-9]*|Download_for_macOS-v${VERSION}|g" \
  README.md

# RELEASE_TEMPLATE.md — update version in download links and filenames
sed -i '' \
  -e "s|Outworked-[0-9]*\.[0-9]*\.[0-9]*|Outworked-${VERSION}|g" \
  -e "s|download/v[0-9]*\.[0-9]*\.[0-9]*|download/v${VERSION}|g" \
  .github/RELEASE_TEMPLATE.md

# Stage the changed files so npm includes them in the version commit
git add README.md .github/RELEASE_TEMPLATE.md

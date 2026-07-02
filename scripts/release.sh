#!/bin/bash
set -e

# Cut a release: bump version, build, publish to npm, push, and create a
# GitHub release with the built files attached (for self-hosters).
#
# Usage: ./scripts/release.sh [patch|minor|major]

npm version "${1:-patch}"
npm run build
npm publish
git push --follow-tags

VERSION=$(node -p "require('./package.json').version")
gh release create "v$VERSION" --title "v$VERSION" \
  dist/lightbox3.min.js \
  dist/lightbox3.min.js.map \
  dist/lightbox3.css

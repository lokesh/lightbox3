#!/bin/bash
set -e

# Build the library first
npm run build

# Clean and create site directory
rm -rf site
mkdir -p site

# Copy library assets
cp dist/lightbox3.esm.js site/
cp dist/lightbox3.css site/

# Copy demo page and rewrite paths for flat structure
sed -e 's|/dist/lightbox3.css|./lightbox3.css|g' \
    -e 's|/dist/lightbox3.esm.js|./lightbox3.esm.js|g' \
    demo/index.html > site/index.html

echo "Site built in site/"

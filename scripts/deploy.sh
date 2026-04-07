#!/bin/bash
set -e

# Load env vars
if [ ! -f .env ]; then
  echo "Error: .env file not found. Copy .env.example to .env and fill in your credentials."
  exit 1
fi

source .env

if [ -z "$DEPLOY_HOST" ] || [ -z "$DEPLOY_USER" ] || [ -z "$DEPLOY_PATH" ]; then
  echo "Error: DEPLOY_HOST, DEPLOY_USER, and DEPLOY_PATH must be set in .env"
  exit 1
fi

echo "Building site..."
bash scripts/build-site.sh

echo "Deploying to ${DEPLOY_USER}@${DEPLOY_HOST}:${DEPLOY_PATH}"

# Upload site/ as a flat directory
sshpass -p "${DEPLOY_PASSWORD}" sftp -oBatchMode=no -oStrictHostKeyChecking=no "${DEPLOY_USER}@${DEPLOY_HOST}" <<EOF
-mkdir ${DEPLOY_PATH}
put site/* ${DEPLOY_PATH}/
EOF

echo "Done! Deployed to ${DEPLOY_HOST}:${DEPLOY_PATH}"

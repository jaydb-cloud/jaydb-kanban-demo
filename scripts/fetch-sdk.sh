#!/usr/bin/env bash
#
# Fetches the minimized JayDB Cloud SDK from the official distribution on GitHub Pages,
# falling back to the local sibling repository build if offline/unreleased.
#
set -euo pipefail

SDK_DIST_URL="${SDK_DIST_URL:-https://jaydb-cloud.github.io/jaydb-cloud-sdk/jaydb-cloud.esm.min.js}"
TARGET_FILE="jaydb-cloud.esm.min.js"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_PATH="${DIR}/${TARGET_FILE}"

echo "==> Fetching minimized JayDB Cloud SDK..."
if curl -fsSL -o "${TARGET_PATH}.tmp" "${SDK_DIST_URL}" 2>/dev/null; then
  mv "${TARGET_PATH}.tmp" "${TARGET_PATH}"
  echo "==> Successfully downloaded ${TARGET_FILE} from ${SDK_DIST_URL} ($(wc -c < "${TARGET_PATH}") bytes)"
elif [ -f "${DIR}/../jaydb-cloud-sdk/dist/jaydb-cloud.esm.min.js" ]; then
  echo "==> Remote distribution unavailable; syncing from local sibling ../jaydb-cloud-sdk/dist/..."
  cp "${DIR}/../jaydb-cloud-sdk/dist/jaydb-cloud.esm.min.js" "${TARGET_PATH}"
  echo "==> Synced ${TARGET_FILE} from local build ($(wc -c < "${TARGET_PATH}") bytes)"
else
  echo "ERROR: Failed to fetch ${SDK_DIST_URL} and no local build found." >&2
  exit 1
fi

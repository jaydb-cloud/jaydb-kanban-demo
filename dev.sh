#!/usr/bin/env bash
#
# Runs the kanban example against a local JayDB Cloud server.
#
# No AWS account and no S3 bucket: with JAYDB_STORAGE_BACKEND unset the server
# uses its in-memory driver, so everything here is disposable and vanishes when
# the process exits.
#
#   ./dev.sh
#
# Then open the URL it prints. It also prints the API key to paste in.
set -euo pipefail

API_PORT=${API_PORT:-8080}
WEB_PORT=${WEB_PORT:-5173}
NAMESPACE=${NAMESPACE:-kanban}

API_URL="http://localhost:${API_PORT}"
WEB_URL="http://localhost:${WEB_PORT}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# This example lives in its own repository, so the server has to be located
# rather than assumed to be a parent directory. Override with:
#   JAYDB_CLOUD_REPO=/path/to/jaydb-cloud ./dev.sh
repo="${JAYDB_CLOUD_REPO:-$(cd "${here}/../jaydb-cloud" 2>/dev/null && pwd || true)}"

if [[ -z "${repo}" || ! -d "${repo}/cmd/jaydb-cloud" ]]; then
  cat >&2 <<EOF
Could not find a jaydb-cloud checkout to build the server from.

  Tried: ${repo:-<no sibling ../jaydb-cloud>}

This script runs the example against a LOCAL server so you need no AWS account.
Point it at your checkout:

  JAYDB_CLOUD_REPO=/path/to/jaydb-cloud ./dev.sh

To run against a real tenant instead, you do not need this script at all -- just
serve this directory and enter your tenant URL, namespace and key in the page:

  python3 -m http.server 5173 --bind 127.0.0.1

(and allowlist http://localhost:5173 in the server's JAYDB_CORS_ALLOWED_ORIGINS)
EOF
  exit 1
fi

server_pid=""
web_pid=""
cleanup() {
  [[ -n "${server_pid}" ]] && kill "${server_pid}" 2>/dev/null || true
  [[ -n "${web_pid}" ]] && kill "${web_pid}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "==> Building the server"
# Built into this repo's ignored .bin/ rather than into the jaydb-cloud checkout,
# so running the example leaves no artifact in the other repo.
mkdir -p "${here}/.bin"
(cd "${repo}" && go build -o "${here}/.bin/jaydb-cloud" ./cmd/jaydb-cloud)

echo "==> Starting the API on ${API_URL}"
# The browser is a cross-origin caller here, so its exact origin has to be
# allowlisted. Without this every request fails as an opaque CORS error, since
# the gateway fails closed when JAYDB_CORS_ALLOWED_ORIGINS is unset.
JAYDB_E2E_TEST=true \
  JAYDB_CORS_ALLOWED_ORIGINS="${WEB_URL}" \
  "${here}/.bin/jaydb-cloud" server --port "${API_PORT}" >"${here}/.dev-server.log" 2>&1 &
server_pid=$!

ready=false
for _ in $(seq 1 30); do
  # Errors are expected until the listener is up, so keep them off the console.
  if [[ "$(curl -fsS -o /dev/null -w '%{http_code}' "${API_URL}/health" 2>/dev/null || true)" == "200" ]]; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "${ready}" != true ]]; then
  echo "!! Server did not come up. Log:" >&2
  cat "${here}/.dev-server.log" >&2
  exit 1
fi

json_field() { grep -o "\"$1\":\"[^\"]*" | head -1 | cut -d'"' -f4; }

echo "==> Creating an org, a namespace and a key"
# /v1/auth/test-session exists only under JAYDB_E2E_TEST and stands in for the
# OAuth login. In production these three steps happen in the web console.
session=$(curl -fsS -X POST "${API_URL}/v1/auth/test-session" \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@example.com","name":"Kanban Demo"}' | json_field token)

curl -fsS -X POST "${API_URL}/v1/auth/onboarding" \
  -H "X-JayDB-Session: ${session}" -H 'Content-Type: application/json' \
  -d '{"organization_name":"Kanban Demo","slug":"kanban-demo"}' >/dev/null

curl -fsS -X POST "${API_URL}/v1/admin/namespaces" \
  -H "X-JayDB-Session: ${session}" -H 'Content-Type: application/json' \
  -d "{\"name\":\"${NAMESPACE}\",\"description\":\"kanban example\"}" >/dev/null

api_key=$(curl -fsS -X POST "${API_URL}/v1/admin/keys" \
  -H "X-JayDB-Session: ${session}" -H 'Content-Type: application/json' \
  -d '{"name":"kanban example"}' | json_field key)

if [[ -z "${api_key}" ]]; then
  echo "!! Could not mint an API key" >&2
  exit 1
fi

echo "==> Serving the example on ${WEB_URL}"
python3 -m http.server "${WEB_PORT}" --bind 127.0.0.1 --directory "${here}" >/dev/null 2>&1 &
web_pid=$!
sleep 1

cat <<EOF

  Open ${WEB_URL}

    Tenant URL   ${API_URL}
    Namespace    ${NAMESPACE}
    API key      ${api_key}

  Open it in two windows to watch them converge.
  Ctrl-C to stop. Data is in memory only and will not survive this process.

EOF

wait "${server_pid}"

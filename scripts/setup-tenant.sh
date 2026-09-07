#!/usr/bin/env bash
#
# Registers the kanban demo's OIDC client and its Google + GitHub upstream IdPs
# on a jaydb-cloud tenant. The exact calls, verified against the admin surface in
# pkg/oidc/admin.go (POST /v1/admin/oidc/apps and /v1/admin/oidc/idps).
#
# The admin surface is authorized as an ORG-WIDE administrator: an org-scoped
# (NOT namespace-scoped) jcloud_sec_* key, or a console session. A
# namespace-scoped key is refused by requireOrgAdmin.
#
# Nothing here is a server change. The `scopes`/`audiences` fields are already
# accepted at registration; only the gateway's ENFORCEMENT of those scopes is the
# pending server work (see DESIGN-oidc-data-plane.md).
#
# Usage — set these, then run:
#   TENANT_URL=https://kanban.jaydb.com \
#   ADMIN_KEY=jcloud_sec_...            \  # org-wide admin key or session token
#   GOOGLE_CLIENT_ID=...  GOOGLE_CLIENT_SECRET=... \
#   GITHUB_CLIENT_ID=...  GITHUB_CLIENT_SECRET=... \
#   SITE_ORIGIN=https://avivklas.github.io \
#   ./setup-tenant.sh
set -euo pipefail

: "${TENANT_URL:?set TENANT_URL, e.g. https://kanban.jaydb.com}"
: "${ADMIN_KEY:?set ADMIN_KEY to an org-wide admin credential}"
: "${GOOGLE_CLIENT_ID:?}" ; : "${GOOGLE_CLIENT_SECRET:?}"
: "${GITHUB_CLIENT_ID:?}" ; : "${GITHUB_CLIENT_SECRET:?}"
SITE_ORIGIN="${SITE_ORIGIN:-https://avivklas.github.io}"
REDIRECT_URI="${SITE_ORIGIN}/jaydb-kanban/"

auth=(-H "X-JayDB-API-Key: ${ADMIN_KEY}" -H "Content-Type: application/json")

echo "==> Registering the public SPA client on ${TENANT_URL}"
# Public client (the surface never issues a secret). audiences=[jaydb-data] so
# the tokens it mints are for the data plane; scopes bounds what a login MAY
# receive — the two tiers the demo uses.
curl -fsS -X POST "${TENANT_URL}/v1/admin/oidc/apps" "${auth[@]}" -d @- <<JSON | python3 -m json.tool
{
  "name": "kanban-demo",
  "client_id": "kanban-demo",
  "redirect_uris": ["${REDIRECT_URI}"],
  "allowed_origins": ["${SITE_ORIGIN}"],
  "allowed_idps": ["google", "github"],
  "audiences": ["jaydb-data"],
  "scopes": ["read:boards/*", "write:boards/*"]
}
JSON

echo "==> Registering Google as an upstream IdP"
# preset lets authpole fill Google's well-known endpoints; client_secret is
# write-only (redacted on GET). It lives on the tenant issuer, never in the
# browser.
curl -fsS -X POST "${TENANT_URL}/v1/admin/oidc/idps" "${auth[@]}" -d @- <<JSON | python3 -m json.tool
{
  "id": "google",
  "name": "Google",
  "type": "oidc",
  "preset": "google",
  "client_id": "${GOOGLE_CLIENT_ID}",
  "client_secret": "${GOOGLE_CLIENT_SECRET}",
  "scopes": ["openid", "email", "profile"]
}
JSON

echo "==> Registering GitHub as an upstream IdP"
# This is WHY GitHub works through the issuer and not from a bare static page:
# the secret is held here, at the token exchange, not shipped to the browser.
curl -fsS -X POST "${TENANT_URL}/v1/admin/oidc/idps" "${auth[@]}" -d @- <<JSON | python3 -m json.tool
{
  "id": "github",
  "name": "GitHub",
  "type": "oauth2",
  "preset": "github",
  "client_id": "${GITHUB_CLIENT_ID}",
  "client_secret": "${GITHUB_CLIENT_SECRET}",
  "scopes": ["read:user", "user:email"]
}
JSON

cat <<EOF

Done. Registered on ${TENANT_URL}:
  - public client   kanban-demo  (redirect ${REDIRECT_URI}, aud jaydb-data)
  - upstream IdPs    google, github

REMINDER — the redirect URI and origin above must ALSO be added on the provider
side: ${REDIRECT_URI} as an authorized redirect URI in the Google and GitHub
OAuth apps, and ${SITE_ORIGIN} as an authorized origin.

This does not make sign-in gate data yet. The gateway must enforce the scopes
these tokens carry — the server PR in DESIGN-oidc-data-plane.md.
EOF

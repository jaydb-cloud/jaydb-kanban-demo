# Design: OIDC sign-in that actually reaches the data plane

**Status: proposal, awaiting approval. No server code written.**

This is the design for letting a Google or GitHub login authorize a document
read or write directly — so a static app's users are real end users, not sharers
of one embedded key. It is a change to **jaydb-cloud**, not to this example. The
example's current sign-in is identity-only (see the README); this is what turns
that into real access.

## The problem, precisely

The data plane authenticates exactly one credential. On current `main`,
`(*Server).Authenticate` in `pkg/gateway/api.go`:

```go
key := r.Header.Get("X-JayDB-API-Key")
if key == "" { /* Authorization: Bearer <value> */ }
if key == "" { /* ?api_key= */ }
return s.authMgr.ValidateKey(ctx, key)   // SHA-256 lookup of an opaque secret
```

`Authorization: Bearer` is an alternate transport for the same `jcloud_sec_*`
secret — it is **not** a JWT path. There is no signature check, no issuer, no
audience, no scope. So a signed OIDC token cannot authorize a data request today,
and an API key carries no user identity and no read-only variant: any key that
reads can also write and delete the whole namespace.

Two facts make the fix small rather than large:

1. **The verifier already exists.** authpole's
   `provider.VerifyAccessToken(ctx, tenant, audience, token)` (used today by
   `VerifyConsoleToken` for the console) does issuer derivation, JWKS, audience
   and `token_use` checks. A tenant-tier data verifier is a thin wrapper, not new
   crypto.
2. **The audience already exists.** The SVID work issues tokens with
   `aud=jaydb-data`. Nothing verifies them on the data plane, so that
   "API-key replacement" path is issuance-only right now. One data-plane JWT path
   serves both the SVID case and the browser case.

## Proposed change

### 1. Server — accept a tenant-issued JWT on the data plane

In `Authenticate`, when the `Authorization: Bearer` value **is shaped like a JWT**
(two dots, `header.payload.signature`), verify it instead of hashing it:

```
bearer := oidc.BearerFromRequest(r)
if looksLikeJWT(bearer) {
    claims, err := provider.VerifyAccessToken(ctx, tenantFromHost(r), DataAudience, bearer)
    // DataAudience = "jaydb-data"
    // -> resolve/authorize by (claims.OriginalIDP, claims.UpstreamSubject),
    //    the SAME identity tuple VerifyConsoleToken uses, never email
    // -> the tenant is the HOST's tenant; a token from another issuer is refused
}
// otherwise: existing ValidateKey(bearer) path, unchanged
```

Non-negotiable properties, each mirroring an existing decision:

- **Tenant-pinned.** The issuer must be the request host's own tenant issuer, so
  a token minted by tenant A cannot authorize a write to tenant B. This is the
  same pin `VerifyConsoleToken` makes for the account tier.
- **Audience-pinned** to `jaydb-data`, so a console token (`jaydb-cloud-api`) or
  an SVID for another resource cannot be replayed here, and vice versa.
- **`token_use=access`**, so an ID token cannot be replayed as an access token.
- **Identity by `(provider, upstream_subject)`, never email** — the
  account-takeover class the console path already refuses.
- **Fail-closed and additive.** A malformed or unverifiable bearer is 401, never
  a silent fall-through to the API-key path (which would let a bad JWT get hashed
  and rejected with a misleading error). The `jcloud_sec_*` and API-key paths are
  untouched — this is a third path beside them, per the standing rule that OIDC is
  net-new and preserves existing behavior.

**Open question for you — authorization, not authentication.** Verifying *who*
the user is does not decide *what* they may do. Options, cheapest first:

- **(a) Any verified token of this tenant may read+write the namespace.** Simplest;
  no per-user model.
- **(b) Key-prefix scope claims** — CHOSEN. See below.
- **(c) Per-document ownership** — out of scope for this app. See "Why not (c)".

### Chosen: (b) key-prefix scopes

A token carries scope claims naming a **capability + a key prefix**, and the
gateway enforces them against the request path with a string prefix match — no
storage read, decided entirely from the token:

```
scope: "read:boards/*  write:boards/demo/*"
```

- `read:<prefix>` gates GET and LIST; `write:<prefix>` gates PUT and DELETE.
- A request for key `K` by method `M` is allowed iff some `<cap>:<prefix>` in the
  token satisfies (cap covers M) AND (K starts with prefix, treating a trailing
  `*` as "any suffix"). No match → 403.
- The scopes a token *may* carry are bounded at registration by the app's
  `scopes` array (already a field on the registration surface — see below), and
  which ones a given login actually receives is the issuer's business.

This is what your `aud: "/users/*", "/tasks/*"` instinct was reaching for. The
correction is only in vocabulary: an **audience** names the resource server
(`jaydb-data`); "may touch `users/*` and `tasks/*`" is a **scope**. So it is a
claim beside the audience, not the audience itself:

```
aud:   "jaydb-data"
scope: "read:users/*  write:users/*  read:tasks/*"
```

For the kanban demo this gives a real read-only tier at last: a stranger's login
mints `read:boards/*` (watch the board), a player's mints
`read:boards/* write:boards/*` (play). The API has never had a read-only
credential before; this is it.

### Why not (c) — and why it is the wrong tool *here* specifically

(c) is per-**document** ownership: "Ada may edit `tasks/42` because
`tasks/42.owner == Ada`." The distinguishing test between (b) and (c) is whether
the rule depends on **which key** the caller touches (static, in the token) or on
**who** the caller is versus what the record says (dynamic, per-record):

| | decides from | cost |
|---|---|---|
| (b) prefix scope | the token + the request path | a string prefix match, no I/O |
| (c) ownership | the token + a field inside the stored document | a read-before-write on every mutation, an owner field, and rules for who may create / transfer / delete ownership |

(c) is not merely harder — it is a **different authorization model** the storage
layer has no notion of, on the hot path. And the kanban board is the clean case
*against* it: four players share one board and the whole point is that **anyone
may move anyone's card** — that collaboration is a violation under ownership but
correct under a shared `write:boards/demo/*` scope. So the demo wants (b) and
would actively fight (c).

(c) earns its cost only for an app whose documents genuinely have owners (a
per-user notes app, say). That is a real future feature; it is just not this one,
and bolting it on now would be building the expensive model the demo does not use.
So: **(b) with key-prefix scopes, and (c) deferred as a named future tier**, not
combined.

### 2. Tenant configuration (you, once)

On the throwaway tenant that hosts the demo (see below), register via
`POST /v1/admin/oidc/apps`:

```json
{
  "name": "kanban-demo",
  "client_id": "kanban-demo",
  "redirect_uris": ["https://avivklas.github.io/jaydb-kanban/"],
  "allowed_origins": ["https://avivklas.github.io"],
  "allowed_idps": ["google", "github"],
  "audiences": ["jaydb-data"]
}
```

This produces a **public** client (no secret — the admin surface never issues
one, which is exactly right for a browser). Then register google and github as
upstream IdPs on that tenant via `POST /v1/admin/oidc/idps`. GitHub's client
secret lives **here, on the tenant issuer** — which is the whole reason GitHub
works through this path and not through a bare static page. Reusing your existing
account-tier Google/GitHub OAuth apps should mean adding the tenant callback as an
authorized redirect URI, not creating new apps.

### 3. Client (this repo)

Replace the identity-only sign-in with a real PKCE flow:
`authorize` → `/callback` handling → token exchange → `Authorization: Bearer
<access_token>` on every data call → silent refresh. The `jaydb.js` client already
sends `Authorization: Bearer`, so most of the change is acquiring and refreshing
the token, plus a `/callback` route the static page currently lacks.

## The throwaway tenant

Real registered orgs are `acme`, `hey`, `rhhj` (rhhj is a different account).
`demo` is not registered. **Recommendation: create a dedicated throwaway org** —
say `kanban` — so the public demo's read-write-for-everyone blast radius is one
disposable namespace and never touches `acme`/`hey`. I need you to create it (or
authorize me to) and hand over the Google/GitHub client secrets for the IdP
registration; I cannot create or read those.

## What I need to proceed

1. **Authorization: (b) key-prefix scopes — CONFIRMED.** (c) deferred.
2. **The tenant** to host it (recommend a fresh `kanban` org).
3. **Google + GitHub OAuth client secrets** for the tenant IdP registration.

The exact admin API calls to register the client and the two IdPs live in
[`scripts/setup-tenant.sh`](./scripts/setup-tenant.sh) — a runnable script that
takes the org-admin key and the two OAuth secrets as environment variables, so
setup is a single deterministic command rather than four hand-copied curls. The
`scopes` and `audiences` fields it sends are already accepted by the registration
surface, so this half needs **no** server change — only the gateway's scope
*enforcement* (part 1) does.

With those three, the work is: one server PR (the data-plane JWT path + prefix-
scope enforcement + tests, proven against tokens that must be rejected as well as
accepted), the tenant registration (the script), and one client PR (PKCE flow
requesting the scopes for the signed-in user's tier).

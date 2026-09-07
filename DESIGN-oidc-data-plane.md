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

### (c) Per-document ownership — full design

Requested for the platform (not the kanban demo, which stays on (b)). This is the
tier for an app where a document belongs to a user: a notes app, a per-user
settings store, private drafts. It is a genuinely different authorization model
from (b), so it is specified separately here rather than folded in.

**What it decides.** For a mutating request on key `K` by principal `P`, the
storage record at `K` carries an owner, and the write is allowed iff `P` is that
owner (or holds an override capability — see below). Unlike (b), the decision
cannot be made from the token alone; it depends on state in the document.

**The storage reality that shapes it.** The db layer offers exactly one
server-side precondition: an ETag compare (`WithExpectedETag`, `CreateOnly`,
`WithDeleteExpectedETag` in `pkg/db/db.go`). There is **no** server-side "write
only if field X == Y" predicate. So ownership cannot be pushed into the driver;
it is enforced in the gateway as **read-check-write**, and that ordering is the
whole design, because a naive version has a TOCTOU hole.

**Where the owner lives.** Two options, and the choice is load-bearing:

- **Sidecar metadata key** (recommended): the owner is stored by the gateway at a
  reserved key derived from the document key, e.g. `K` → `__acl__/K`, holding
  `{"owner": "<provider>:<subject>", "created": ...}`. The document body is never
  touched, so an app's own schema is not invaded and a user cannot forge
  ownership by putting an `owner` field in their JSON. This is the clean seam.
- **In-body `owner` field** (rejected): reading ownership from the document body
  means the client controls it, so a caller could claim any document by writing
  the right field. Only viable if the gateway strips/overwrites the field on
  every write, which is more fragile than a separate key. Do not do this.

**The write path, TOCTOU-safe.** The danger: read the ACL, see `P` is the owner,
then write — but between the read and the write, ownership changed. The fix reuses
the ETag primitive that already exists:

```
On PUT/DELETE of K by principal P, when the namespace is ownership-enforced:
  1. GET __acl__/K  -> (acl, aclETag), or NOT-FOUND
  2. NOT-FOUND (first write):
       - allocate ownership to P: PUT __acl__/K {owner: P} with If-None-Match:*
         (CreateOnly). If it 412s, another writer claimed it first -> re-read,
         go to step 3 with their ACL.
       - then the user's PUT K proceeds.
  3. FOUND: if acl.owner != P and P lacks the override capability -> 403.
       - otherwise the user's PUT K proceeds, carrying the user's own If-Match on
         K as today (the two conditions compose: ownership gate THEN CAS).
  4. DELETE K also deletes __acl__/K (best-effort; a dangling ACL is harmless and
     re-adopted on next create).
```

The ACL read is the read-before-write cost, and the `CreateOnly` allocation is
what closes the first-writer race without a lock. Ownership *transfer* is a
gateway operation on `__acl__/K` gated on the current owner or an override.

**Who may override.** An ownership model needs an escape hatch or it strands data
(the owner deletes their account; an admin must clean up). Model it as a (b)-style
scope: a principal holding `admin:<prefix>` bypasses the owner check for keys
under that prefix. So (c) is layered ON (b), not instead of it — (b) gates which
prefixes you may touch at all, (c) gates ownership within them, and `admin:*` is
the operator override. That layering is why (b) had to come first.

**Cost, stated honestly.** Every mutation in an ownership-enforced namespace
becomes: one ACL GET + (first-write) one CreateOnly PUT + the user's own write —
2–3 storage ops where (b) is zero extra. On the read path, if reads are also
owner-scoped, a GET pays an ACL read too. The `$0-idle` cost story survives (still
DynamoDB, still scale-to-zero), but the per-request op count roughly doubles for
writes. That is the price of per-document authorization and it should be opt-in
**per namespace**, not global — a namespace flag `ownership: enforced`, off by
default, so (a)/(b) namespaces pay nothing.

**Boundary with the demo.** The kanban board must **not** enable this: shared
editing is the point, so every player holds `write:boards/demo/*` under (b) and no
ACL is consulted. (c) is a namespace opt-in for a *different* app.

**Scope of the eventual server work:** an `__acl__/` reserved-prefix convention
(and a guard so clients cannot write it directly), the read-check-write path above
wired into the same `Authenticate`→authorize seam as (b), a per-namespace
`ownership` flag, the `admin:<prefix>` override scope, and a transfer endpoint.
Larger than (b); still bounded. This is a design, not a commitment to build it
now — (b) ships first and stands alone.


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

1. **Authorization: (b) key-prefix scopes — CONFIRMED. (c) per-document ownership
   — designed above as a separate per-namespace opt-in tier, layered on (b).**
2. **The tenant** — a `kanban` org must be created; the E2E onboarding backdoor is
   closed in production (correctly), so this needs the maintainer's console
   session or an org-admin key. The agent cannot create it.
3. **OAuth secrets, handled out-of-band.** The Google client ID is public and set
   in `config.js`. The Google client SECRET was exposed in chat and **must be
   rotated**; the new value goes into `GOOGLE_CLIENT_SECRET` when running
   `scripts/setup-tenant.sh`, never into the repo. The GitHub client ID is
   `Ov23liITiMrudCQbBVmI`; its secret has not been shared and should stay
   out-of-band.

Provider-side reminder: `https://avivklas.github.io/jaydb-kanban/` must be an
authorized redirect URI, and `https://avivklas.github.io` an authorized origin,
in both the Google and GitHub OAuth apps.

With the tenant created and the (rotated) secrets in env, `scripts/setup-tenant.sh`
is one command. The server work is: the (b) JWT + prefix-scope PR first (it stands
alone and the demo needs only this), then optionally the (c) ownership tier as a
separate PR for a future app.

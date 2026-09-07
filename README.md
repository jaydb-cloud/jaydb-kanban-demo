# Shared kanban — a multi-user app with no backend

A kanban board that several people can use at once, built to show what
[JayDB Cloud](https://github.com/avivklas/jaydb-cloud) can do as an app's only
backend. There is no server of its own, no build step, and no framework: a
handful of static files that talk to the document API over `fetch`.

**Live: https://avivklas.github.io/jaydb-kanban/** — players sign in with Google
or GitHub; there is no key to paste. The served files carry no credential.

```
index.html   markup
styles.css   styling
config.js    tenant/OIDC config (public values only)
jaydb.js     the client for the document API (API key OR bearer token)
pkce.js      the browser PKCE sign-in flow
store.js     the board's data layer: sync, conflict handling, presence
app.js       DOM wiring
```

Deployment is `cp` — GitHub Pages serves this repository as-is
(`.github/workflows/pages.yml` uploads the files, no build).

## Run it

The demo authenticates with **sign-in**, so it needs a JayDB tenant that has an
OIDC issuer configured (see *Sign in* below). Point it at one and serve the
directory:

```bash
python3 -m http.server 5173 --bind 127.0.0.1
```

Set `oidc.issuer`/`oidc.clientId` in [`config.js`](./config.js) to your tenant,
and add `http://localhost:5173` as an authorized redirect URI on the tenant
client and both OAuth apps. The live deployment already points at its tenant, so
opening the live URL is the zero-setup way to try it.

Two server-side prerequisites on the tenant (both shipped in jaydb-cloud):

- the data-plane token path
  ([#58](https://github.com/avivklas/jaydb-cloud/pull/58)), so a bearer token
  authorizes reads/writes;
- the origin you load the page from must be allowed. CORS now reads each
  registered app's `allowed_origins`
  ([#60](https://github.com/avivklas/jaydb-cloud/pull/60)), so registering the
  app (via `scripts/setup-tenant.sh`) grants it — no operator env change.


## Server requirement

Conditional writes must actually work on the server you point this at. They were
broken until
[jaydb-cloud#54](https://github.com/avivklas/jaydb-cloud/pull/54): every
`If-Match` request returned `412` regardless of whether the client was current.
Against a server predating that fix, the board still loads and reads fine, but
every edit will look like a conflict — the drag retry exhausts and text edits show
the conflict dialog every time.

Quick check against your tenant — the second call must return `200`, not `412`:

```bash
NS=https://acme.jaydb.com/v1/n/default/docs
KEY=jcloud_sec_...

curl -sD - -o /dev/null "$NS/probe" -H "X-JayDB-API-Key: $KEY" | grep -i '^etag'
# then feed that exact value back:
curl -s -o /dev/null -w '%{http_code}\n' -X PUT "$NS/probe" \
  -H "X-JayDB-API-Key: $KEY" -H 'Content-Type: application/json' \
  -H 'If-Match: "<the etag>"' -d '{"v":2}'
```

## Sign in with Google / GitHub

Players **sign in with Google or GitHub** — that is the only way in. There is no
API key to paste and no shared credential: the connect screen asks only which
board to open.

Sign-in is an Authorization-Code + PKCE flow against your JayDB tenant. The
tenant issues a scoped access token, the app sends it as `Authorization: Bearer`,
and the **server authorizes each read/write by the token's scopes**
([jaydb-cloud#58](https://github.com/avivklas/jaydb-cloud/pull/58)). Every player
is a real, distinct user; nobody holds a namespace-wide key. GitHub works because
the **tenant issuer** holds GitHub's client secret — a static page never sees it,
and PKCE needs no secret of its own.

Setup (once):

1. Run [`scripts/setup-tenant.sh`](./scripts/setup-tenant.sh) to register the
   public PKCE client and the Google/GitHub upstream IdPs on your tenant.
2. Set `oidc.issuer` (e.g. `https://kanban.jaydb.com`), `oidc.clientId`,
   `oidc.scopes`, and `oidc.namespace` in [`config.js`](./config.js) — all public,
   no secret.
3. Add `https://avivklas.github.io/jaydb-kanban/` as an authorized redirect URI on
   the tenant client and both OAuth apps.

The tenant must have the data-plane token path deployed
([jaydb-cloud#58](https://github.com/avivklas/jaydb-cloud/pull/58)) and its origin
registered so CORS allows it
([jaydb-cloud#60](https://github.com/avivklas/jaydb-cloud/pull/60), which reads
the app's `allowed_origins`). Scopes are minted by the issuer, so a read-only tier
is `read:boards/*` and a player is `read+write:boards/*`.

## Security

The demo hands out **no shared credential**. Each player authenticates as
themselves via Google/GitHub and gets a token scoped to the board keyspace; the
served files carry no secret. Presence and card attribution are the signed-in
user's real identity, and the server — not the client — decides what each token
may read or write.

The `config.js` values (`oidc.issuer`, `oidc.clientId`) are public identifiers,
safe to commit. No client secret is ever in this repo or on the wire; the tenant
issuer holds the upstream OAuth secrets.

## What it demonstrates

Everything below is built from three primitives: a read that returns an ETag, a
write that can require one, and a prefix list.

### 1. Concurrent edits that don't overwrite each other

Every document read carries an `ETag`. A write can demand it:

```http
PUT /v1/n/kanban/docs/boards/demo/cards/card_x
If-Match: "4f865dbdabb46219"
```

If someone else wrote first, that ETag is stale and the write is refused with
`412` instead of silently discarding their change. This is the whole reason
several browsers can share mutable state with nothing coordinating them.

What you do with the `412` is a product decision, and the example deliberately
does it two different ways:

- **Dragging a card** re-reads the winning version, re-applies the move to it,
  and writes again (`store.js`, `#mutateCard`). A move only touches `column` and
  `order`, so replaying it onto fresh data is well defined. The user sees
  nothing but a brief "retried" note.
- **Editing a card's text** stops and shows both versions. Two people rewriting
  the same sentence is not mechanically resolvable, so the app asks instead of
  guessing.

Same primitive, opposite policy. Auto-merging text would lose work; prompting on
every drag would be unusable.

### 2. Document granularity is concurrency granularity

Each card is its own document (`boards/{board}/cards/{id}`), so two people
editing two cards never contend at all — their writes touch different keys. Had
the board been one document, every edit would contend with every other edit and
the retry loop would be doing constant work.

This is the main design decision to take away: **split documents along the lines
you expect people to edit independently.** The column layout stays in a single
`meta` document precisely because it changes rarely.

### 3. Allocating an id without a coordinator

There is no sequence generator, so ids are generated client-side. `If-None-Match: *`
makes that safe:

```http
PUT /v1/n/kanban/docs/boards/demo/meta
If-None-Match: *
```

The write succeeds only if the key is unused. Two people opening a new board at
the same instant cannot overwrite each other — the loser gets `412` and reads
what the winner wrote. Compare with an unconditional `PUT`, which would silently
destroy the other board.

### 4. Reading efficiently

A list returns each key's metadata — including its ETag — and never the bodies:

```json
{
  "count": 2,
  "items": [
    { "key": "boards/demo/cards/card_a", "etag": "\"4f865dbd\"", "mod_time": "…", "size": 39 }
  ],
  "next_cursor": null
}
```

So the sync loop lists, compares each ETag against the copy it already holds, and
re-reads only what actually changed. A board nobody is touching costs one request
per poll no matter how many cards it has. The inspector panel shows the reads
this skips.

### 5. Writes that never conflict, and state that expires

Two patterns that avoid CAS altogether:

- **The activity feed** appends to `activity/{timestamp}_{random}`. No two
  writers ever target the same key, so no conditional write is needed.
- **Presence** has each client write `presence/{clientId}` on a timer and judge
  everyone else by `mod_time`. Nothing holds a connection open; "who's here" is
  just recently-written documents, and any client may delete one that has gone
  cold. Expiry by convention, since the store has no TTL.

## Limits worth knowing

**Updates arrive by polling.** The API is request/response — there is no SSE or
websocket endpoint — so `store.js` polls every 2.5s and backs off on failure.
Changes appear within a poll, not instantly. If you want them faster, poll faster
and accept the request cost; the ETag diffing keeps a quiet board cheap.

**The ETag header is invisible to browsers by default.** `ETag` is not a
CORS-safelisted response header, so `response.headers.get('ETag')` returns `null`
cross-origin unless the server sends `Access-Control-Expose-Headers: ETag`. Since
a client that cannot read an ETag cannot send `If-Match`, that alone disables
optimistic concurrency from a browser — the exact case this example exists to
demonstrate. Fixed server-side in
[jaydb-cloud#55](https://github.com/avivklas/jaydb-cloud/pull/55).

Until that is deployed, `jaydb.js` recovers the ETag from a listing, where it
travels in the JSON body instead, and the sync loop hands over the ETag it
already listed so the recovery costs no extra request. The fallback logs one
warning and disappears on its own once the header is exposed. Worth knowing
because it is a trap you cannot see from outside a browser: `curl` and Node's
`fetch` ignore CORS, so the header looks perfectly readable in any non-browser
test.

**Two ETag encodings.** The `ETag` response header is `"abc"`, and the `etag`
field in list and PUT *bodies* has historically carried the quotes inside the
JSON string (`"\"abc\""`);
[jaydb-cloud#56](https://github.com/avivklas/jaydb-cloud/pull/56) makes the body
form bare. `jaydb.js` normalises both to a bare value on the way in and re-quotes
on the way out, so it works either side of that change. Comparing a listed ETag
against a header one without normalising silently never matches.

**Other limits.** Documents cap at 10 MB. A list page caps at 1000 keys (the
example pages through with the cursor). The data API must be called on a tenant
subdomain — the apex and `app.` hosts are refused.

## Layout

```
boards/{board}/meta                    column layout        contended, conditional writes
boards/{board}/cards/{cardId}          one card             independent, conditional writes
boards/{board}/presence/{clientId}     who's here           last-writer-wins, expires by age
boards/{board}/activity/{ts}_{rand}    append-only feed     conflict-free by construction
```

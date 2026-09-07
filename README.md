# Shared kanban — a multi-user app with no backend

A kanban board that several people can use at once, built to show what
[JayDB Cloud](https://github.com/avivklas/jaydb-cloud) can do as an app's only
backend. There is no server of its own, no build step, and no framework: five
static files that talk to the document API over `fetch`.

**Live: https://avivklas.github.io/jaydb-kanban/** — it asks for a tenant URL,
namespace and API key on load. The deployed page ships **no** credential; you
bring your own (and see the security note below before you hand the URL around).

```
index.html   markup
styles.css   styling
jaydb.js     ~280 lines — the whole client for the document API
store.js     the board's data layer: sync, conflict handling, presence
app.js       DOM wiring
```

Deployment is `cp` — GitHub Pages serves this repository as-is
(`.github/workflows/pages.yml` uploads the files, no build).

## Run it

Against a **local** server, so you need no AWS account and nothing persistent:

```bash
JAYDB_CLOUD_REPO=/path/to/jaydb-cloud ./dev.sh
```

It builds the server, starts it on an in-memory store, creates an org, a
namespace and an API key, serves the page, and prints what to paste in. Drop the
env var if your `jaydb-cloud` checkout is a sibling directory. Everything
disappears when you stop the process.

To point it at a **real tenant** instead, serve the directory (or just open the
live URL) and enter your tenant URL (`https://acme.jaydb.com`), a namespace, and
a key:

```bash
python3 -m http.server 5173 --bind 127.0.0.1
```

Either way, one thing has to be true server-side first:

```bash
# whichever origin you are loading the page from
JAYDB_CORS_ALLOWED_ORIGINS="https://avivklas.github.io,http://localhost:5173"
```

The gateway fails closed when that is unset, so without it every request fails as
an opaque CORS error. It accepts exact origins, single-label wildcards
(`https://*.example.com`), or `*`.

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

## Read this before you share the URL

**The API key is readable by anyone who can open the page.** The app asks for it
at runtime and keeps it in `localStorage`, so the hosted files contain no
credential and nothing is committed — but that is deployment hygiene, not a
security boundary. Anything running on the page can read it, and the key travels
with anyone you give it to.

That matters more than it might sound, because of two properties of the data API
as it stands:

- **Keys are read-write.** There is no read-only key. An `APIKey` carries only an
  org and an optional namespace, and the method is not checked against any
  permission, so any key that can read can also write and delete.
- **There is no end-user identity.** The document API authenticates the *key*,
  not the person. It accepts only a `jcloud_sec_*` secret — there is no OIDC or
  JWT path on `/v1/n/.../docs/...` — so the server cannot distinguish your users
  from each other and cannot scope a document to one of them.

So everyone you hand this URL to gets full read-write access to the whole
namespace, and the board's honesty about who moved a card is a UI convention that
any user can forge. That is fine for a demo, an internal tool, or a trusted
group. It is **not** the shape to give anonymous users on the public internet.

Two things to do regardless:

1. Scope the key to a single namespace, not the whole org, so the blast radius is
   one namespace of disposable data. (`dev.sh` mints an org-wide key for
   convenience — `namespace_id` comes back empty.)
2. Treat the namespace as public data.

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

# JayDB Kanban Demo — Multi-User App with No Backend

A shared, collaborative Kanban board built to show how simple it is to build and ship production-ready applications with **[JayDB Cloud](https://jaydb.com)** as your only backend.

As described on [jaydb.com](https://jaydb.com), building with JayDB means **shipping apps with no backend of your own at all**: not serverless functions, not complex BaaS wrappers, and no server infrastructure to maintain, scale, or pay for while idle. This demo proves that architecture in practice: a folder of static files talking directly from the browser to the database.

**[Try the Live Demo](https://avivklas.github.io/jaydb-kanban/)** *(Open it in two browser windows side-by-side to see multi-user sync and presence in real time)*.

---

## Why This Architecture Changes How You Build

When you build applications on JayDB Cloud, an entire layer of traditional backend complexity simply vanishes:

- **Zero Servers to Operate or Deploy**  
  The entire application is static files (HTML, CSS, and modern JavaScript). You can host it on GitHub Pages, Cloudflare Pages, Netlify, or an S3 bucket. There are no API servers, no container builds, and no deployment pipelines to break.
- **Real Per-User Authentication Out of the Box**  
  Users sign in with their existing Google or GitHub accounts via standard OAuth/OIDC + PKCE. JayDB Cloud issues scoped tokens directly to the browser. Your frontend carries no client secrets, and you don't have to stand up or manage a custom auth service.
- **Seamless Collaboration Without Overwrites**  
  Multiple users can manipulate the board concurrently. JayDB Cloud leverages standard HTTP conditional requests (`ETag` / `If-Match`) to ensure conflicting writes are caught immediately rather than silently overwriting another user's work.
- **Real-Time Presence and Audit Feeds**  
  See who is online and track every card move in an activity feed without running persistent WebSocket servers, socket gateways, or message brokers.
- **$0 When Idle**  
  Because there are no always-on servers or idle instance fees, your applications cost nothing when nobody is using them. Spin up prototypes, internal tools, or side projects with zero financial overhead.

---

## How It Works

The board is built from standard web primitives talking directly to JayDB Cloud's document API over `fetch`:

```
┌────────────────────────────────────────────────────────┐
│                        Browser                         │
│   (Static HTML + Vanilla JS, running on GitHub Pages)  │
└──────────────┬──────────────────────────┬──────────────┘
               │ 1. Sign in with PKCE     │ 2. Direct HTTP / REST
               │    (Google / GitHub)     │    (GET / PUT with Bearer token)
               ▼                          ▼
┌────────────────────────────────────────────────────────┐
│                      JayDB Cloud                       │
│  - Per-tenant OIDC Issuer & Scoped Authorization       │
│  - Document Storage with ETag Conditional Writes       │
└────────────────────────────────────────────────────────┘
```

### 1. Direct-to-Database Sign-In (OIDC + PKCE)
Users sign in directly through your JayDB tenant's built-in OIDC issuer. The browser runs an Authorization Code + PKCE flow:
1. The user authenticates with Google or GitHub.
2. JayDB Cloud returns an access token scoped specifically to the board keyspace (e.g. `read:boards/*`, `write:boards/*`).
3. The browser sends this token in the standard `Authorization: Bearer <token>` header on every request.

No client secrets ever ship to the browser, and you don't need a backend server to broker credentials.

### 2. Conflict Prevention with Standard HTTP ETags
Every document read from JayDB Cloud returns an `ETag`. When a client saves changes, it includes that ETag in the `If-Match` header:

```http
PUT /v1/n/kanban/docs/boards/demo/cards/card_123
Authorization: Bearer <token>
If-Match: "4f865dbdabb46219"
```

If another user updated that card first, the server rejects the write with `412 Precondition Failed` instead of clobbering data:
- **Card Dragging**: The application automatically fetches the latest card position and replays the move. The user sees a seamless, conflict-free transition.
- **Text Editing**: If two users edit the same card text at once, the application surfaces both versions so the user can choose how to merge without losing work.

### 3. Lightweight, Cost-Efficient Polling
Rather than maintaining costly long-lived socket connections, the client polls the board prefix. JayDB's list endpoint returns lightweight metadata—including ETags—without the document payloads. The client compares ETags against its local cache and only downloads the specific documents that actually changed. A quiet board costs just one tiny request per sync cycle.

### 4. Ephemeral Presence Without Sockets
Active clients write a small heartbeat document (`boards/{board}/presence/{clientId}`) on a timer. The client lists the presence directory to show who is currently active based on document modification time (`mod_time`). If a user closes their tab, their heartbeat stops and they cleanly disappear from the presence list.

---

## Clean, Readable Codebase

There is no framework boilerplate, no transpilation step, and no heavy dependency tree:

```
index.html   Semantic HTML markup for the board and connect screens
styles.css   Responsive stylesheet
config.js    Tenant and public OIDC configuration
jaydb.js     Lightweight fetch-based client for JayDB Cloud
pkce.js      Browser-native PKCE authentication flow
store.js     Data synchronization, ETag conflict handling, and presence
app.js       DOM event listeners and UI interactions
```

---

## Quickstart: Run It Locally

You can run this demo locally with any static file server in seconds:

```bash
# Serve the directory
python3 -m http.server 5173 --bind 127.0.0.1
```

Open `http://localhost:5173` in your browser. The live demo configuration is already wired to point to the demo tenant, letting you test the full sign-in and board experience immediately.

---

## Connecting to Your Own JayDB Tenant

To point this board at your own JayDB Cloud organization:

1. **Get your tenant**: Sign up at **[jaydb.com](https://jaydb.com)**.
2. **Register the client and providers**: Run the setup script to register the public PKCE client and your OAuth identity providers on your tenant:
   ```bash
   TENANT_URL=https://<your-tenant>.jaydb.com \
   ADMIN_KEY=jcloud_sec_... \
   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... \
   GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=... \
   SITE_ORIGIN=http://localhost:5173 \
   ./scripts/setup-tenant.sh
   ```
3. **Update configuration**: Set your tenant URL and client ID in [`config.js`](./config.js):
   ```javascript
   export const CONFIG = {
     oidc: {
       issuer: 'https://<your-tenant>.jaydb.com',
       clientId: 'kanban-demo',
       scopes: ['read:boards/*', 'write:boards/*'],
       namespace: 'kanban',
     },
   };
   ```
4. **Deploy anywhere**: Commit and push to GitHub Pages, Cloudflare Pages, Vercel, or any static host. No build command needed.

---

## Next Steps

- Explore **[jaydb.com](https://jaydb.com)** for guides, documentation, and to start building your own backend-free applications.
- Read [`store.js`](./store.js) to see how optimistic concurrency and ETag diffing are implemented in under 300 lines of clean JavaScript.

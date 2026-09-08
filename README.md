# JayDB Kanban Demo

A real-time, multi-user Kanban board built with **zero backend servers**.

This demo shows how simple it is to build full applications on **[JayDB Cloud](https://jaydb.com)**. As featured on the [JayDB website](https://jaydb.com), you can ship apps with **no backend of your own at all**—no API servers, no custom auth services, and no databases to manage. Your app is just static files, and the browser talks directly to JayDB Cloud for both login and data.

👉 **[Try the Live Demo](https://avivklas.github.io/jaydb-kanban/)**  
*(Tip: Open it in two browser windows side-by-side to watch cards, edits, and presence sync in real time.)*

---

## What You Get

- **Zero Backend to Maintain** — Ship your app as static HTML & JS anywhere (GitHub Pages, Cloudflare Pages, S3). No servers to patch, scale, or monitor.
- **Built-in Per-User Auth** — Users sign in with Google or GitHub via standard PKCE. The browser receives a scoped token with zero client secrets exposed.
- **Conflict-Free Collaboration** — Multiple people can edit and move cards simultaneously. Standard HTTP ETags (`If-Match`) prevent accidental overwrites.
- **Live Presence Without WebSockets** — See who's active on the board using lightweight document heartbeats.
- **$0 When Idle** — With no servers or instances running, side projects and prototypes cost $0 while idle.

---

## How It Works

Everything runs on standard browser `fetch` calls directly to JayDB Cloud:

1. **Sign In**: The user authenticates with Google or GitHub. JayDB Cloud mints a scoped access token.
2. **Direct Reads & Writes**: The browser reads and updates card documents directly:
   ```http
   PUT /v1/n/kanban/docs/boards/demo/cards/card_1
   Authorization: Bearer <token>
   If-Match: "<etag>"
   ```
   If someone else updated the card in the meantime, the write returns `412 Precondition Failed` so the app can safely replay or merge changes without losing data.
3. **Smart Sync & Presence**: The board periodically checks for modified document metadata so it only downloads what actually changed, and writes a heartbeat document to announce who is online.

---

## Simple, Readable Code

No build tools, no bundlers, and no framework bloat—just pure vanilla JavaScript:

```
index.html   UI markup
styles.css   Responsive styles
config.js    Tenant configuration
jaydb.js     Lightweight fetch client for JayDB Cloud
pkce.js      Browser sign-in flow
store.js     Data sync, conflict handling, and presence
app.js       DOM interactions and drag-and-drop
```

---

## Run It Locally

```bash
python3 -m http.server 5173 --bind 127.0.0.1
```

Open `http://localhost:5173` to test the board immediately against the live demo tenant.

---

## Build Your Own

Ready to ship apps with no backend? Head over to **[jaydb.com](https://jaydb.com)** to learn more and get started for free.

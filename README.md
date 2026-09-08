# JayDB Kanban Demo

A real-time, multi-user Kanban board built with **zero backend servers**.

Built on **[JayDB Cloud](https://jaydb.com)**, this demo shows how simple it is to build collaborative web apps with **no backend of your own at all**—no API servers, no custom auth services, and no databases to manage. Your app is just a few static files; the browser talks directly to JayDB Cloud for login and data.

👉 **[Try the Live Demo](https://jaydb-cloud.github.io/jaydb-kanban-demo/)**  
*(Tip: Open it in two browser windows side-by-side to watch cards, edits, and presence sync in real time.)*

---

## Why JayDB?

- **No backend to run** — Ship your app as static HTML & JS on GitHub Pages, Cloudflare Pages, or S3.
- **Built-in per-user login** — Users sign in with Google or GitHub; JayDB Cloud handles tokens directly in the browser with zero client secrets exposed.
- **Conflict-free collaboration** — Move cards and edit text together. Standard HTTP ETags prevent accidental overwrites.
- **Live presence** — See who's online without WebSocket servers.
- **$0 while idle** — No servers running means no idle hosting bills.

---

## How It Works

The browser communicates directly with JayDB Cloud using standard `fetch`:

1. **Sign In**: User signs in with Google or GitHub (PKCE). JayDB issues a scoped access token.
2. **Direct Storage**: The browser reads and updates cards with standard HTTP requests (`GET` and `PUT`).
3. **Sync & Presence**: The client polls for card changes and sends heartbeats to show who's active.

---

## Run It Locally

```bash
python3 -m http.server 5173 --bind 127.0.0.1
```

Open `http://localhost:5173` in your browser.

---

## Build Your Own

Visit **[jaydb.com](https://jaydb.com)** to learn more and get started for free.

# GriffinGames Backend Deployment Guide

Deploy the full backend (HTTP + WebSocket) to **Render** — one host for everything, similar to Fly.io, with a **free tier**.

## 1. Requirements

- Node.js 18+
- Git
- GitHub repo containing `griffinhgames-server`
- [Render](https://render.com) account (free)

## 2. Local Setup

```bash
npm install
npm start
```

This starts the **full server** (HTTP + WebSocket) at `http://localhost:3000`.

**Frontend (local):** point your client to:

```js
const socket = io("http://localhost:3000");
```

## 3. Deploy to Render (everything on one host)

Use **one Render Web Service** for the whole backend — health check, `/games`, and Socket.IO — just like a single Fly.io app.

1. Go to [render.com](https://render.com) and sign up (GitHub login is easiest).
2. **New** → **Web Service**.
3. Connect your GitHub account and select the `griffinhgames-server` repo.
4. Configure:
   - **Name:** e.g. `griffinhgames-server`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** **Free**
5. Click **Create Web Service**. Render builds and deploys. Your URL will be like `https://griffinhgames-server.onrender.com`.

No code changes needed; the app already uses `process.env.PORT`.

**Production URL (this deployment):** `https://griffinhgames-server.onrender.com`

**Frontend (e.g. Netlify):** point your app to this URL for both API and Socket.IO:

```js
const socket = io("https://griffinhgames-server.onrender.com");
// Same base URL for fetch('/games') etc. if needed
```

**Free tier:**

- Service **spins down** after ~15 minutes with no traffic. First request after that can take 30–60 seconds (cold start), then it's fast. Fine for low traffic.
- 750 hours/month on the free tier.
- WebSockets work; very long idle connections may drop on free tier — clients can reconnect.

## 4. Verifying deployment

- Open **https://griffinhgames-server.onrender.com/** → `{ "status": "ok", "service": "griffinhgames-server" }`
- Open **https://griffinhgames-server.onrender.com/games** → games list JSON
- In your frontend, connect with Socket.IO to the same URL and test creating/joining rooms and real-time updates.

## 5. Frontend (Netlify) – point to Render

The frontend repo **griffinhgames** is hosted on Netlify. To use the Render backend:

- **Socket.IO:** Wherever you create the socket client, use:
  ```js
  const socket = io("https://griffinhgames-server.onrender.com");
  ```
- **API (e.g. fetch `/games`):** Use the same base URL: `https://griffinhgames-server.onrender.com`.

Optional: In Netlify, set an env var (e.g. `VITE_API_URL` or `GATSBY_API_URL` depending on your build tool) to `https://griffinhgames-server.onrender.com` and use it in code so you can change it without editing source. For a static site, hardcoding the URL in the script that connects to the backend is also fine.

## 6. Environment

- The server uses `process.env.PORT || 3000`. Render sets `PORT` automatically.
- No extra env vars required for the backend.

## 7. Optional: Vercel (API only, no WebSockets)

If you only need the HTTP API (`/`, `/games`) on Vercel (e.g. for a separate frontend or serverless use), the repo is set up for it: **`src/app.js`** is the Express app Vercel runs. Vercel does **not** support Socket.IO, so for the full multiplayer backend use Render (or another host that supports WebSockets) as in section 3.

## 8. Summary

- **Render:** One Web Service runs the full server (HTTP + Socket.IO). Free tier, same idea as running everything on Fly.io.
- **Local:** `npm start` → full server on port 3000.
- **Vercel:** Optional, API-only; use when you don't need WebSockets on that deployment.

# GriffinGames Backend Deployment Guide

This document explains how to deploy the GriffinGames backend to **Vercel**, how the HTTP API and WebSocket support work, and how to run everything locally.

## 1. Requirements

- Node.js 18+
- Git
- GitHub repo containing `griffinhgames-server`
- Vercel account (for production deployment)

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

## 3. Vercel Deployment (HTTP API)

The repo is set up for Vercel:

- **`src/app.js`** – Express app with HTTP routes only (`/`, `/games`). Vercel runs this as a serverless function (zero config: Vercel detects the default export).
- **`vercel.json`** – Optional build/install commands.

### Deploy to Vercel

1. Log into [Vercel](https://vercel.com).
2. **New Project** → Import your `griffinhgames-server` repo.
3. Vercel will detect the Express app (from `src/app.js`). Deploy.

After linking GitHub, every push to `main` can trigger a new deployment (enable in project settings).

### What runs on Vercel

| Endpoint   | Supported on Vercel |
|-----------|----------------------|
| `GET /`   | ✅ Health check      |
| `GET /games` | ✅ Games list     |
| **Socket.IO (WebSockets)** | ❌ **Not supported** |

**Why no WebSockets?** Vercel serverless functions are stateless and short-lived. They do not support long-lived WebSocket connections. Socket.IO cannot run on Vercel.

## 4. Real-time (WebSocket) options

To keep multiplayer rooms and real-time game state, you have two approaches.

### Option A: Hybrid – Vercel (API) + separate WebSocket host

- **Vercel:** Serves `GET /` and `GET /games`.
- **Another host:** Run the **full** server (Socket.IO) somewhere that supports long-lived connections:
  - **Fly.io** – deploy with `fly launch` / `fly deploy` (use the same repo; run `node server.js`).
  - **Railway** – connect repo, set start command `npm start`.
  - **Render, Railway, etc.** – any Node host that keeps a process running.

Frontend:

- API/base URL: `https://your-app.vercel.app`
- Socket URL: `https://your-websocket-host.fly.dev` (or Railway URL, etc.)

### Option B: Full server on a single host (no Vercel for backend)

Deploy only the full Node server (`server.js`) to Fly.io, Railway, Render, etc. That single URL serves both HTTP and WebSocket. No Vercel for this repo in that case.

## 5. Environment

- The server uses `process.env.PORT || 3000`. Vercel and most hosts set `PORT` automatically.
- No extra env vars are required for the basic HTTP API.

## 6. Verifying deployment

**Vercel (HTTP only):**

- Visit `https://your-app.vercel.app/`  
  You should see: `{ "status": "ok", "service": "griffinhgames-server" }`
- Visit `https://your-app.vercel.app/games` for the games list.

**Full server (local or hybrid WebSocket host):**

- Same JSON at `/` and `/games`.
- Use the same URL as the Socket.IO endpoint in the frontend and test creating/joining rooms and real-time updates.

## 7. Summary

- **Vercel:** Use for the HTTP API (`/`, `/games`) via `src/app.js`; no code changes needed for deploy.
- **WebSockets:** Not supported on Vercel; run `server.js` on Fly.io, Railway, or another Node host for Socket.IO.
- **Local:** `npm start` runs the full server (HTTP + WebSocket) on port 3000.

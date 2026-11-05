# GriffinGames Server

[![Tests](https://github.com/griffinhaag/griffinhgames-server/actions/workflows/test.yml/badge.svg)](https://github.com/griffinhaag/griffinhgames-server/actions/workflows/test.yml)

The real-time backend for [GriffinGames](https://github.com/griffinhaag/griffinhgames). It runs the rooms, players, and game logic for **LOCKED IN**, a buzzer-style trivia game where a host runs the game on a shared screen and everyone else plays from their phone.

Built with Node.js, Express, and Socket.IO. Deployed on Render at https://griffinhgames-server.onrender.com.

## What it does

- **Rooms.** The host creates a room and gets a short code. Players join with that code and a name. Room state is pushed to every client whenever it changes.
- **The game.** Question flow, buzz-in locking (first press wins), answer timers, scoring, pausing, skipping, and restarts are all handled server-side so every screen stays in sync.
- **Reconnects.** Phones lock and Wi-Fi drops, so players and hosts can rejoin a game in progress. Host control is handed off predictably if the host leaves, and name conflicts are rejected rather than kicking the original player.
- **Question banks.** About 6,000 questions across 11 categories (geography, sports, history, flags, movies & TV, and more), stored as JSON and deduplicated when the server starts.
- **"Off the Dome" grading.** Free-response answers are checked by an LLM (Llama 3.1 via Groq) so typos, alternate spellings, and last-name-only answers are accepted. A few hard rules run first, so acronyms with swapped letters don't slip through. If no API key is set, AI grading is simply turned off.

## Project layout

```
server.js            Express + Socket.IO setup and HTTP routes
socketHandlers.js    All socket events (create/join room, buzz, judge, pause, kick, ...)
core/
  RoomManager.js     Rooms, players, host assignment, reconnect handling
  GameEngine.js      Loads game modules and keeps one game instance per room
  EventRouter.js     Routes generic game events to the active game
games/
  index.js           Registry of available games
  buzzin/            LOCKED IN game logic and question banks
utils/               Room code generator, logging
src/tests/           RoomManager tests
```

Games are pluggable. A game module exports an id, a name, and a `create()` function, and gets added to `games/index.js`. The room and socket code don't need to change to add a new one.

## HTTP routes

| Route | Returns |
| --- | --- |
| `GET /` | Health check |
| `GET /games` | Available games, for the frontend menu |
| `GET /buzzin/category-counts` | Number of questions in each category |

## Running locally

Requires Node 18+.

```bash
npm install
PORT=3000 npm start   # the frontend looks for the server on port 3000 locally
npm test
```

To turn on AI grading, set `GROQ_API_KEY` in your environment. It's never stored in the repo. In production it's set as an environment variable on Render.

When the frontend is opened on `localhost`, it connects to `http://localhost:3000` automatically.

More detail: [TechnicalREADME.md](TechnicalREADME.md) (architecture and socket events) and [DeploymentREADME.md](DeploymentREADME.md) (Render setup).

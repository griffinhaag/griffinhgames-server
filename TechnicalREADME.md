TechnicalREADME.md — GriffinGames Multiplayer Backend

This document provides a complete technical overview of the GriffinGames multiplayer backend. It explains the architecture, server flow, room system, extensibility, and how the modular game engine works internally.

1. Overview

This backend powers real-time multiplayer drinking games for GriffinGames. It uses:

Node.js

Express

Socket.IO (WebSockets)

Modular, pluggable game engine

Room-based multiplayer system

Stateless frontend (Netlify) + Stateful backend (Railway)

The system is intentionally designed for easy expansion, clean separation of concerns, and future migration to platforms like AWS, Fly.io, or Render without rewriting code.

2. Repository Structure
griffinhgames-server/
│
├── package.json
├── server.js
├── socketHandlers.js
├── README.md
├── TechnicalREADME.md
├── DeploymentREADME.md
│
├── core/
│   ├── RoomManager.js        # Manages rooms, players, host roles
│   ├── GameEngine.js         # Loads game modules, manages active games
│   └── EventRouter.js        # Optional event routing subsystem
│
├── games/
│   ├── index.js              # Central registry of all game modules
│   ├── reflex/
│   │   └── index.js          # Basic reflex game placeholder
│   └── trivia/
│       └── index.js          # Basic trivia game placeholder
│
└── utils/
    ├── codes.js              # Generates room codes
    └── logger.js             # Logging helpers


This structure reflects a production-grade modular game engine, allowing unlimited games without modifying core server files.

3. Core Architecture
3.1 server.js

Initializes:

Express app

HTTP server

Socket.IO server

CORS

RoomManager

GameEngine

Socket handlers

PORT auto-binding for cloud environments

This is the main entrypoint for Railway or any Node hosting provider.

3.2 socketHandlers.js

Handles all incoming socket events:

Lobby Events

host:createRoom

player:joinRoom

player:setName

room:getState

Game Lifecycle

host:startGame

game:event (generic event router)

Disconnect Logic

Cleans up player

Reassigns host if needed

Destroys empty rooms

Broadcasts updated room state

Frontends rely on room:state updates to stay synced with the server.

3.3 RoomManager.js (core)

Tracks:

Active rooms

Active players

Host socket

Player names

Room lifecycle

Player index mapping

Room serialization for the frontend

Rooms are stored in memory using Map() objects.
The manager is game-agnostic, meaning it works for any game type.

3.4 GameEngine.js (core)

Loads a game by its gameType and creates a game instance per room:

Each game instance may implement:

handleEvent()

getState()

teardown()

The GameEngine stores:

activeGames = Map<roomCode, { gameType, instance }>


This ensures:

multiple rooms can play different games simultaneously

each room has its own isolated game state

all game logic is separate from server infrastructure

3.5 Game Modules (games/)

Every game lives in its own folder, for example:

games/
  reflex/
    index.js


A game module exports an object:

{
  id: "reflex",
  name: "Reflex Challenge",
  create({ io, room, roomManager }) { ... }
}


Game modules handle gameplay logic independently, keeping the backend maintainable.

To add a new game:

Create folder in /games

Export module with create()

Add it to games/index.js

No other file needs to change — this is the benefit of the modular engine.

4. Networking Model
Frontend → Backend

Clients emit:

host:createRoom

player:joinRoom

player:setName

host:startGame

game:event

Backend → Frontend

Backend emits:

room:created

room:state

room:closed

room:error

game:started

game:ended

Room state objects include:

{
  code,
  hostSocketId,
  players: [
    { socketId, name, isHost }
  ],
  phase,        // lobby, in-progress, ended
  gameType,
}

5. Local Development Flow

Run backend:

npm install
npm start


Frontend communicates with:

http://localhost:3000


You can test everything without deploying.

6. Production Deployment Flow

Frontend (Netlify) connects to backend (Railway) via:

const socket = io("https://your-railway-url.up.railway.app");


Deployment is automatic whenever you push to GitHub.

7. Scalability Notes

This architecture supports:

Multiple rooms

Multiple simultaneous games

Modular expansion

Future Redis session storage

Migration to AWS ECS/EB without code changes

For now, in-memory storage is ideal for rapid development and low concurrency.

8. Summary

This backend is engineered for:

Clean modularity

Unlimited future expansion

High code maintainability

Real-time multiplayer

Cloud portability

Rapid iteration in Cursor

You now have a professional-grade multiplayer game backend foundation built with industry best practices.
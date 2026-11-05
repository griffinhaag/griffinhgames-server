# Technical Notes

How the GriffinGames server is put together. For setup, see [README.md](README.md). For hosting, see [DeploymentREADME.md](DeploymentREADME.md).

## Overview

The frontend is a static site on Netlify. This server holds all the state: rooms, players, scores, and the current question. Clients send actions over Socket.IO, the server decides what happens, and then it broadcasts the new state back out. Clients don't trust each other or keep their own copy of the game rules.

Everything is kept in memory (`Map`s), with no database. A restart clears active rooms, which is fine for party games that last about 20 minutes.

## Pieces

**`server.js`** sets up Express and Socket.IO, registers the HTTP routes (`/`, `/games`, `/buzzin/category-counts`), and binds to `process.env.PORT`.

**`socketHandlers.js`** is the single place where socket events come in. It validates the request (is this socket the host? is it in this room?) and then calls the RoomManager or the active game.

**`core/RoomManager.js`** tracks rooms, players, names, and which socket is the host. It also handles the messy parts of real phones:
- A player who disconnects can rejoin under the same name for up to 10 minutes and keep their score.
- A room with nobody connected stays alive for 5 minutes before it's cleaned up.
- If the host drops, host control moves to another player in a consistent order, and goes back if the host returns.

**`core/GameEngine.js`** creates one game instance per room from the registry in `games/index.js`, forwards events to it, and tears it down when the game ends.

**`games/buzzin/`** is LOCKED IN. Its phases are `lobby → countdown → waiting → question → result → end`. It builds a question pool from the chosen categories, controls buzz locking and answer timers, scores answers, and grades "Off the Dome" free-response answers with Groq (Llama 3.1). Grading has a 6-second timeout and a few hard rules that run first, like rejecting acronyms with the letters swapped.

## Socket events

Client → server:

| Event | Who | Purpose |
| --- | --- | --- |
| `host:createRoom` | host | Create a room, get a code |
| `player:joinRoom`, `player:setName`, `player:quit` | player | Join, rename, leave |
| `room:getState` | anyone | Ask for the current room state |
| `host:startGame`, `host:restartGame`, `host:endGame` | host | Game lifecycle |
| `host:showQuestion`, `host:nextQuestion`, `host:skipRound` | host | Move through questions |
| `host:pauseGame`, `host:resumeGame` | host | Pause, then resume after a 3-2-1 countdown |
| `player:buzz`, `player:submitAnswer` | player | Buzz in and answer |
| `host:judgeAnswer`, `host:flagQuestion`, `host:shuffleQuestions` | host | Manual judging and question control |
| `host:previewCategories`, `host:kickPlayer` | host | Lobby tools |
| `game:event` | anyone | Generic event passed to the active game |

Server → client: `room:created`, `room:state`, `room:error`, `room:closed`, `game:started`, `game:state`, `game:ended`, `host:changed`, `host:transferred`, `host:restored`, `player:kicked`, `lobby:categoriesPreview`.

## Adding a game

1. Create `games/<id>/index.js` that exports `{ id, name, description, minPlayers, maxPlayers, create({ io, room, roomManager }) }`.
2. `create()` returns an object with `handleEvent()`, `getState()`, and `teardown()`.
3. Register it in `games/index.js`.

No changes are needed in the room or socket code.

## Tests

`npm test` runs `src/tests/roomManager.test.js`, which covers joining, host transfer, and reconnect behavior.

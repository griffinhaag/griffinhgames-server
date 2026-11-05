import gameRegistry from "../games/index.js";
import { logInfo, logWarn } from "../utils/logger.js";

export function createGameEngine(io, roomManager) {
  // Map<roomCode, { gameType, instance }>
  const activeGames = new Map();

  // Tear down a room's game when the room itself is destroyed so timers and state don't leak
  roomManager.onRoomDestroyed?.((roomCode) => endGame(roomCode, "room_destroyed"));

  function startGame(roomCode, requestedGameType, startPayload = {}) {
    const room = roomManager.getRoom(roomCode);
    if (!room) {
      throw new Error("Room does not exist.");
    }

    const gameType =
      requestedGameType ||
      room.gameType ||
      "reflex"; // default fallback

    const gameModule = gameRegistry[gameType];
    if (!gameModule) {
      throw new Error(`Unknown game type: ${gameType}`);
    }

    const existing = activeGames.get(roomCode);
    if (existing) {
      // A duplicate start (e.g. double-clicked START) must not spawn a second game whose
      // timers keep running alongside the first. Ignore it while a game is under way;
      // otherwise tear the old instance down before replacing it.
      const existingPhase = existing.instance.getState?.()?.phase;
      if (existingPhase && existingPhase !== "lobby" && existingPhase !== "end") {
        logWarn(`Game already in progress in room ${roomCode}, ignoring duplicate start.`);
        return;
      }
      logWarn(`Game already active in room ${roomCode}, restarting.`);
      existing.instance.teardown?.();
      activeGames.delete(roomCode);
    }

    const instance = gameModule.create({
      io,
      room,
      roomManager
    });

    activeGames.set(roomCode, {
      gameType,
      instance
    });

    room.gameType = gameType;
    room.phase = "in-progress";

    const roomState = roomManager.serializeRoom(roomCode);

    io.to(roomCode).emit("game:started", {
      gameType,
      room: roomState
    });

    logInfo(`Game started in room ${roomCode}: ${gameType}`);
    
    // Route initial start event to game instance with payload
    if (typeof instance.handleEvent === "function") {
      instance.handleEvent({
        eventName: "host:startGame",
        payload: startPayload,
        socketId: room.hostSocketId
      });
    }
  }

  function handleGameEvent({ roomCode, eventName, payload, socketId }) {
    const entry = activeGames.get(roomCode);
    if (!entry) return;

    const { gameType, instance } = entry;

    if (typeof instance.handleEvent === "function") {
      instance.handleEvent({
        eventName,
        payload,
        socketId
      });
    } else {
      logWarn(
        `Game '${gameType}' in room ${roomCode} does not implement handleEvent`
      );
    }
  }

  function endGame(roomCode, reason = "ended") {
    const entry = activeGames.get(roomCode);
    if (!entry) return;

    const { gameType, instance } = entry;

    if (typeof instance.teardown === "function") {
      instance.teardown();
    }

    activeGames.delete(roomCode);

    const room = roomManager.getRoom(roomCode);
    if (room) {
      room.phase = "ended";
      room.updatedAt = Date.now();
    }

    io.to(roomCode).emit("game:ended", {
      gameType,
      reason
    });

    logInfo(`Game ended in room ${roomCode}: ${reason}`);
  }

  function getGameState(roomCode) {
    const entry = activeGames.get(roomCode);
    if (!entry || !entry.instance) return null;
    
    if (typeof entry.instance.getState === "function") {
      return entry.instance.getState();
    }
    return null;
  }

  return {
    startGame,
    handleGameEvent,
    endGame,
    getGameState
  };
}

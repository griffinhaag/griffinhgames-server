import gameRegistry from "../games/index.js";
import { logInfo, logWarn } from "../utils/logger.js";

export function createGameEngine(io, roomManager) {
  // Map<roomCode, { gameType, instance }>
  const activeGames = new Map();

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

    if (activeGames.has(roomCode)) {
      logWarn(`Game already active in room ${roomCode}, restarting.`);
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

  return {
    startGame,
    handleGameEvent,
    endGame
  };
}

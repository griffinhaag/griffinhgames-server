import { generateRoomCode } from "../utils/codes.js";
import { logInfo } from "../utils/logger.js";

export function createRoomManager() {
  // Map<roomCode, Room>
  const rooms = new Map();
  // Map<socketId, { roomCode, playerId }>
  const playerIndex = new Map();
  // Map<socketId, displayName>
  const names = new Map();
  // Map<roomCode, timeoutId>
  const destructionTimers = new Map();
  // Map<roomCode, Map<playerName, DisconnectedPlayer>>
  const disconnectedPlayers = new Map();
  const GRACE_PERIOD_MS = 60000; // 60 seconds to rejoin (increased for reconnection)
  const PLAYER_RECONNECT_WINDOW_MS = 600000; // 10 minutes to reconnect as same player

  function createRoom({ hostSocketId, gameType = null }) {
    let code;
    do {
      code = generateRoomCode();
    } while (rooms.has(code));

    const room = {
      code,
      hostSocketId,
      gameType,
      phase: "lobby", // lobby | in-progress | ended
      createdAt: Date.now(),
      updatedAt: Date.now(),
      players: new Map() // Map<socketId, Player>
    };

    rooms.set(code, room);
    logInfo(`Room created: ${code}`);

    return room;
  }

  function getRoom(code) {
    return rooms.get(code) || null;
  }

  function deleteRoom(code) {
    rooms.delete(code);
  }

  function addPlayerToRoom(roomCode, { socketId, name, isHost = false }) {
    // Cancel destruction if scheduled
    if (destructionTimers.has(roomCode)) {
      clearTimeout(destructionTimers.get(roomCode));
      destructionTimers.delete(roomCode);
      logInfo(`Room ${roomCode} destruction cancelled (player joined).`);
    }

    const room = rooms.get(roomCode);
    if (!room) return { success: false };

    // Check if this is a reconnecting player
    let isReconnecting = false;
    let wasHost = false;
    const roomDisconnected = disconnectedPlayers.get(roomCode);
    if (roomDisconnected && name) {
      const disconnectedData = roomDisconnected.get(name.toLowerCase());
      if (disconnectedData) {
        isReconnecting = true;
        wasHost = disconnectedData.wasHost;
        // Clear the disconnected player data
        roomDisconnected.delete(name.toLowerCase());
        if (roomDisconnected.size === 0) {
          disconnectedPlayers.delete(roomCode);
        }
        logInfo(`Player ${name} reconnecting to room ${roomCode} (was host: ${wasHost})`);
      }
    }

    // Determine if this player should be host
    let finalIsHost = isHost || wasHost;

    // If room has no active host, this player becomes host
    if (!room.hostSocketId || !room.players.has(room.hostSocketId)) {
      finalIsHost = true;
    }

    // If this reconnecting player was the host, restore their host status
    if (finalIsHost) {
      room.hostSocketId = socketId;
    }

    const player = {
      socketId,
      name,
      isHost: finalIsHost,
      joinedAt: Date.now()
    };

    room.players.set(socketId, player);
    room.updatedAt = Date.now();

    playerIndex.set(socketId, {
      roomCode,
      playerId: socketId
    });

    names.set(socketId, name);

    return { success: true, isReconnecting, wasHost };
  }

  function removePlayerBySocket(socketId) {
    const info = playerIndex.get(socketId);
    if (!info) {
      return null;
    }

    const { roomCode } = info;
    const room = rooms.get(roomCode);

    if (!room) {
      playerIndex.delete(socketId);
      names.delete(socketId);
      return null;
    }

    // Get player data before removing
    const player = room.players.get(socketId);
    const playerName = player?.name || names.get(socketId);

    // Save disconnected player data for potential reconnection
    if (playerName && player) {
      if (!disconnectedPlayers.has(roomCode)) {
        disconnectedPlayers.set(roomCode, new Map());
      }
      const roomDisconnected = disconnectedPlayers.get(roomCode);
      roomDisconnected.set(playerName.toLowerCase(), {
        name: playerName,
        wasHost: player.isHost,
        disconnectedAt: Date.now(),
        originalSocketId: socketId
      });
      logInfo(`Saved disconnected player ${playerName} in room ${roomCode} for reconnection`);

      // Schedule cleanup of disconnected player data
      setTimeout(() => {
        const roomDisc = disconnectedPlayers.get(roomCode);
        if (roomDisc) {
          const data = roomDisc.get(playerName.toLowerCase());
          if (data && data.originalSocketId === socketId) {
            roomDisc.delete(playerName.toLowerCase());
            logInfo(`Cleared reconnection data for ${playerName} in room ${roomCode}`);
            if (roomDisc.size === 0) {
              disconnectedPlayers.delete(roomCode);
            }
          }
        }
      }, PLAYER_RECONNECT_WINDOW_MS);
    }

    room.players.delete(socketId);
    room.updatedAt = Date.now();
    playerIndex.delete(socketId);
    names.delete(socketId);

    let roomDestroyed = false;

    // If room is empty, schedule destruction instead of deleting immediately
    if (room.players.size === 0) {
      const timer = setTimeout(() => {
        if (rooms.has(roomCode)) {
          deleteRoom(roomCode);
          disconnectedPlayers.delete(roomCode); // Clean up disconnected players too
          logInfo(`Room ${roomCode} destroyed (empty after grace period).`);
        }
        destructionTimers.delete(roomCode);
      }, GRACE_PERIOD_MS);

      destructionTimers.set(roomCode, timer);
      logInfo(`Room ${roomCode} empty, scheduled destruction in ${GRACE_PERIOD_MS}ms`);

      // Return false so we don't emit room:closed yet
      roomDestroyed = false;
    } else if (room.hostSocketId === socketId) {
      // Host left: DON'T promote a new host immediately - wait for reconnection
      // Only promote if there are other players and host doesn't reconnect
      logInfo(`Host ${playerName} disconnected from room ${roomCode}, waiting for reconnection`);
      // We'll handle host promotion in addPlayerToRoom if someone else joins
    }

    return { roomCode, roomDestroyed, playerName, wasHost: player?.isHost };
  }

  function getRoomCodeForSocket(socketId) {
    const info = playerIndex.get(socketId);
    return info ? info.roomCode : null;
  }

  function setPlayerName(socketId, name) {
    names.set(socketId, name);

    const info = playerIndex.get(socketId);
    if (!info) return;

    const room = rooms.get(info.roomCode);
    if (!room) return;

    const player = room.players.get(socketId);
    if (player) {
      player.name = name;
      room.updatedAt = Date.now();
    }
  }

  function getPlayerName(socketId) {
    return names.get(socketId) || null;
  }

  function serializeRoom(roomCode) {
    const room = rooms.get(roomCode);
    if (!room) return null;

    return {
      code: room.code,
      hostSocketId: room.hostSocketId,
      gameType: room.gameType,
      phase: room.phase,
      createdAt: room.createdAt,
      updatedAt: room.updatedAt,
      players: Array.from(room.players.values()).map((p) => ({
        socketId: p.socketId,
        name: p.name,
        isHost: p.isHost,
        joinedAt: p.joinedAt
      }))
    };
  }

  function getDisconnectedPlayer(roomCode, playerName) {
    const roomDisconnected = disconnectedPlayers.get(roomCode);
    if (!roomDisconnected || !playerName) return null;
    return roomDisconnected.get(playerName.toLowerCase()) || null;
  }

  function isPlayerReconnecting(roomCode, playerName) {
    return !!getDisconnectedPlayer(roomCode, playerName);
  }

  return {
    createRoom,
    getRoom,
    deleteRoom,
    addPlayerToRoom,
    removePlayerBySocket,
    getRoomCodeForSocket,
    serializeRoom,
    setPlayerName,
    getPlayerName,
    getDisconnectedPlayer,
    isPlayerReconnecting
  };
}

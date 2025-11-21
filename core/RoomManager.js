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
  const GRACE_PERIOD_MS = 10000; // 10 seconds to rejoin

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
    if (!room) return false;

    // If room has no host (e.g. host disconnected and room was empty), assign this player as host
    // Or if the requested isHost is true (though usually we respect the room's state)
    // Better logic: If no active host in room, make this player host.
    let finalIsHost = isHost;
    if (!room.hostSocketId || !room.players.has(room.hostSocketId)) {
      finalIsHost = true;
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

    return true;
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
          logInfo(`Room ${roomCode} destroyed (empty after grace period).`);
        }
        destructionTimers.delete(roomCode);
      }, GRACE_PERIOD_MS);
      
      destructionTimers.set(roomCode, timer);
      logInfo(`Room ${roomCode} empty, scheduled destruction in ${GRACE_PERIOD_MS}ms`);
      
      // Return false so we don't emit room:closed yet
      roomDestroyed = false;
    } else if (room.hostSocketId === socketId) {
      // Host left: promote a new host
      const [newHost] = room.players.values();
      if (newHost) {
        newHost.isHost = true;
        room.hostSocketId = newHost.socketId;
        room.updatedAt = Date.now();
      }
      // If no new host found (should be covered by size===0 check), logic flows through
    }

    return { roomCode, roomDestroyed };
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

  return {
    createRoom,
    getRoom,
    deleteRoom,
    addPlayerToRoom,
    removePlayerBySocket,
    getRoomCodeForSocket,
    serializeRoom,
    setPlayerName,
    getPlayerName
  };
}

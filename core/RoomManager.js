import { generateRoomCode } from "../utils/codes.js";
import { logInfo } from "../utils/logger.js";

export function createRoomManager() {
  // Map<roomCode, Room>
  const rooms = new Map();
  // Map<socketId, { roomCode, playerId }>
  const playerIndex = new Map();
  // Map<socketId, displayName>
  const names = new Map();

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
    const room = rooms.get(roomCode);
    if (!room) return false;

    const player = {
      socketId,
      name,
      isHost,
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

    // If room is empty, delete it
    if (room.players.size === 0) {
      deleteRoom(roomCode);
      roomDestroyed = true;
    } else if (room.hostSocketId === socketId) {
      // Host left: promote a new host
      const [newHost] = room.players.values();
      if (newHost) {
        newHost.isHost = true;
        room.hostSocketId = newHost.socketId;
        room.updatedAt = Date.now();
      } else {
        deleteRoom(roomCode);
        roomDestroyed = true;
      }
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

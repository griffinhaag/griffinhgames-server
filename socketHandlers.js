import { logInfo, logWarn } from "./utils/logger.js";

export default function registerSocketHandlers(io, roomManager, gameEngine) {
  io.on("connection", (socket) => {
    logInfo(`Socket connected: ${socket.id}`);

    // Optional: allow clients to set a display name
    socket.on("player:setName", (name) => {
      const trimmed = typeof name === "string" ? name.trim() : "";
      const finalName = trimmed || `Player-${socket.id.slice(0, 4)}`;

      roomManager.setPlayerName(socket.id, finalName);

      const roomCode = roomManager.getRoomCodeForSocket(socket.id);
      if (roomCode) {
        const roomState = roomManager.serializeRoom(roomCode);
        io.to(roomCode).emit("room:state", roomState);
      }
    });

    // Host creates a room (optionally with a chosen game type)
    socket.on("host:createRoom", ({ gameType } = {}) => {
      const playerName = roomManager.getPlayerName(socket.id) ||
        `Host-${socket.id.slice(0, 4)}`;

      const room = roomManager.createRoom({
        hostSocketId: socket.id,
        gameType: gameType || null
      });

      roomManager.addPlayerToRoom(room.code, {
        socketId: socket.id,
        name: playerName,
        isHost: true
      });

      socket.join(room.code);

      const roomState = roomManager.serializeRoom(room.code);
      socket.emit("room:created", roomState);
      logInfo(`Room ${room.code} created by ${socket.id}`);
    });

    // Player joins an existing room by code
    socket.on("player:joinRoom", ({ roomCode, name }) => {
      const code = typeof roomCode === "string"
        ? roomCode.trim().toUpperCase()
        : "";

      if (!code) {
        socket.emit("room:error", "Invalid room code.");
        return;
      }

      const room = roomManager.getRoom(code);
      if (!room) {
        socket.emit("room:error", "Room not found.");
        return;
      }

      const finalName =
        (typeof name === "string" && name.trim()) ||
        `Player-${socket.id.slice(0, 4)}`;

      const joined = roomManager.addPlayerToRoom(code, {
        socketId: socket.id,
        name: finalName,
        isHost: false
      });

      if (!joined) {
        socket.emit("room:error", "Unable to join room.");
        return;
      }

      socket.join(code);

      const roomState = roomManager.serializeRoom(code);
      io.to(code).emit("room:state", roomState);

      logInfo(`Socket ${socket.id} joined room ${code}`);
    });

    // Generic "get current room state"
    socket.on("room:getState", () => {
      const roomCode = roomManager.getRoomCodeForSocket(socket.id);
      if (!roomCode) {
        socket.emit("room:error", "You are not in a room.");
        return;
      }

      const roomState = roomManager.serializeRoom(roomCode);
      socket.emit("room:state", roomState);
    });

    // (Future) host starts a game of a given type
    socket.on("host:startGame", ({ roomCode, gameType }) => {
      const code = roomCode ||
        roomManager.getRoomCodeForSocket(socket.id);

      if (!code) {
        socket.emit("room:error", "No room associated with this host.");
        return;
      }

      // Validate host
      const room = roomManager.getRoom(code);
      if (!room || room.hostSocketId !== socket.id) {
        socket.emit("room:error", "Only the host can start the game.");
        return;
      }

      try {
        gameEngine.startGame(code, gameType);
      } catch (err) {
        logWarn(`Failed to start game: ${err?.message}`);
        socket.emit("room:error", err.message || "Failed to start game.");
      }
    });

    // Generic route for future in-game events:
    // e.g. "game:event" with { roomCode, eventName, payload }
    socket.on("game:event", ({ roomCode, eventName, payload }) => {
      const code = roomCode ||
        roomManager.getRoomCodeForSocket(socket.id);

      if (!code) return;

      gameEngine.handleGameEvent({
        roomCode: code,
        eventName,
        payload,
        socketId: socket.id
      });
    });

    // Handle disconnects
    socket.on("disconnect", () => {
      const result = roomManager.removePlayerBySocket(socket.id);

      if (result && result.roomCode) {
        const { roomCode, roomDestroyed } = result;

        if (roomDestroyed) {
          io.to(roomCode).emit("room:closed");
          logInfo(`Room ${roomCode} destroyed (last player left).`);
        } else {
          const roomState = roomManager.serializeRoom(roomCode);
          io.to(roomCode).emit("room:state", roomState);
          logInfo(`Socket ${socket.id} left room ${roomCode}`);
        }
      } else {
        logInfo(`Socket disconnected (no room): ${socket.id}`);
      }
    });
  });
}

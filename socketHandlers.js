import { logInfo, logWarn } from "./utils/logger.js";

export default function registerSocketHandlers(io, roomManager, gameEngine) {
  // Helper: get the real client IP, respecting reverse-proxy X-Forwarded-For header
  function getClientIP(sock) {
    return sock.handshake.headers["x-forwarded-for"]?.split(",")[0]?.trim()
      || sock.handshake.address
      || null;
  }

  // Helper: returns true if socketId is the host (handles stale hostSocketId after reconnect)
  function checkIsHost(socket, room) {
    if (!room) return false;
    if (room.hostSocketId === socket.id) return true;
    const player = room.players.get(socket.id);
    if (player?.isHost) {
      room.hostSocketId = socket.id; // Fix stale reference after reconnect
      return true;
    }
    return false;
  }

  function promoteNewHostIfNeeded(roomCode, wasHost) {
    if (!wasHost) return;
    // Delay host promotion by 30 seconds so the original host can reconnect
    // after WiFi drops or mobile browser backgrounding before we transfer host
    // to someone else. addPlayerToRoom restores their status within this window.
    setTimeout(() => {
      const room = roomManager.getRoom(roomCode);
      if (!room || room.players.size === 0) return;

      // Check whether the original host already came back
      const hasActiveHost = room.hostSocketId && room.players.has(room.hostSocketId);
      if (hasActiveHost) {
        logInfo(`Host already reconnected to room ${roomCode}, skipping promotion`);
        return;
      }

      // Find the first non-host player (longest connected = lowest insertion order in Map)
      const newHostPlayer = [...room.players.values()].find(p => !p.isHost);
      if (!newHostPlayer) return;

      // Clear isHost on all current players, then set on new host
      room.players.forEach(p => { p.isHost = false; });
      newHostPlayer.isHost = true;
      room.hostSocketId = newHostPlayer.socketId;

      io.to(newHostPlayer.socketId).emit("host:transferred", {
        roomCode,
        message: "Host has left. You are now the host."
      });

      // Broadcast updated room state so all clients sync their isHost flag
      const roomState = roomManager.serializeRoom(roomCode);
      if (roomState) io.to(roomCode).emit("room:state", roomState);

      logInfo(`Host transferred to ${newHostPlayer.name} in room ${roomCode} (after reconnect grace period)`);
    }, 30000);
  }

  // When a host's old socket disconnects AFTER the host already rejoined under a new socket
  // (stale-socket refresh race: new socket arrived before old one fired disconnect),
  // find the already-rejoined socket by name and immediately restore host status to it.
  function restoreDeferredHost(roomCode, disconnectedPlayerName) {
    const room = roomManager.getRoom(roomCode);
    if (!room || !disconnectedPlayerName) return false;

    const nameLower = disconnectedPlayerName.toLowerCase();
    const alreadyRejoined = [...room.players.values()].find(
      p => p.name?.toLowerCase() === nameLower
    );

    if (!alreadyRejoined) return false;
    if (alreadyRejoined.isHost) return true; // already has host, nothing to do

    logInfo(`Deferred host restore: granting host to ${alreadyRejoined.name} (${alreadyRejoined.socketId}) in room ${roomCode}`);
    room.players.forEach(p => { p.isHost = false; });
    alreadyRejoined.isHost = true;
    room.hostSocketId = alreadyRejoined.socketId;

    io.to(alreadyRejoined.socketId).emit("host:restored", {
      roomCode,
      message: "You have been restored as host."
    });

    const roomState = roomManager.serializeRoom(roomCode);
    if (roomState) io.to(roomCode).emit("room:state", roomState);
    return true;
  }

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

      // Validate game type if provided
      if (gameType && gameType !== "buzzin") {
        socket.emit("room:error", `Unknown game type: ${gameType}. Please use 'buzzin' or leave empty.`);
        return;
      }

      const room = roomManager.createRoom({
        hostSocketId: socket.id,
        gameType: gameType || "buzzin" // Default to buzzin
      });

      const addResult = roomManager.addPlayerToRoom(room.code, {
        socketId: socket.id,
        name: playerName,
        isHost: true
      });

      if (!addResult.success) {
        socket.emit("room:error", "Failed to add host to room.");
        return;
      }

      socket.join(room.code);

      const roomState = roomManager.serializeRoom(room.code);
      socket.emit("room:created", roomState);
      
      // Also broadcast to room (though only host is in it)
      io.to(room.code).emit("room:state", roomState);
      
      logInfo(`Room ${room.code} created by ${socket.id} (${playerName})`);
    });

    // Player joins an existing room by code
    socket.on("player:joinRoom", ({ roomCode, name, isHost: claimsHost }) => {
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

      // Validate and sanitize name
      let finalName = typeof name === "string" ? name.trim() : "";
      // Fall back to any name previously stored for this socket (e.g. from player:setName)
      if (!finalName) finalName = roomManager.getPlayerName(socket.id) || "";
      // Reject nameless joins — they create ghost players that pollute the game
      if (!finalName) {
        socket.emit("room:error", "A name is required to join.");
        return;
      }
      // Limit name length
      if (finalName.length > 20) {
        finalName = finalName.substring(0, 20);
      }

      // Store name immediately
      roomManager.setPlayerName(socket.id, finalName);

      // Check if this socket is already in the room
      if (room.players.has(socket.id)) {
        // Already in the room, just send current state
        socket.join(code);
        const roomState = roomManager.serializeRoom(code);
        socket.emit("room:state", roomState);
        logInfo(`Player ${socket.id} reconnected to room ${code}`);
        return;
      }

      // Handle live-socket name conflicts: same name, different socket, socket is still connected.
      // Same IP   → legitimate device switch (e.g. host moved to another tab/device on same network).
      //             Notify the old device, evict its socket, then let the join proceed normally.
      // Diff IP   → potential hijack. Reject immediately.
      // No match  → no conflict, fall through.
      let ipVerifiedSwitch = false;
      for (const [existingSocketId, existingPlayer] of room.players) {
        if (
          existingPlayer.name?.toLowerCase() === finalName.toLowerCase() &&
          existingSocketId !== socket.id &&
          io.sockets.sockets.has(existingSocketId)
        ) {
          const existingSocket = io.sockets.sockets.get(existingSocketId);
          const existingIP = getClientIP(existingSocket);
          const newIP = getClientIP(socket);

          if (existingIP && newIP && existingIP === newIP) {
            // Same IP — graceful device switch. Notify old device then evict it.
            logInfo(`IP-verified device switch for ${finalName} in room ${code} (IP: ${newIP})`);
            if (existingPlayer.isHost) {
              existingSocket.emit("host:deviceChanged", {
                roomCode: code,
                message: "Your host session has moved to another device. Rejoin to reclaim host."
              });
            } else {
              existingSocket.emit("room:deviceChanged", {
                roomCode: code,
                message: "Your session has moved to another device."
              });
            }
            roomManager.removePlayerBySocket(existingSocketId);
            existingSocket.disconnect(true);
            ipVerifiedSwitch = true;
          } else {
            // Different IP — reject to prevent impersonation / hijacking.
            logInfo(`Rejecting join for ${finalName} in room ${code}: active socket ${existingSocketId} holds that name (IP mismatch)`);
            socket.emit("room:error", "Someone with that name is already active in this room.");
            return;
          }
          break;
        }
      }

      // Check if room has an active host (host socket exists AND is in players)
      const hasActiveHost = room.hostSocketId && room.players.has(room.hostSocketId);

      // Determine if this player should be host:
      // 1. If room has no active host, first joiner becomes host
      // 2. If player claims to be host (from setup redirect) and no active host, they become host
      const shouldBeHost = !hasActiveHost || (claimsHost && !hasActiveHost);

      // Pass live socket IDs so addPlayerToRoom can distinguish a genuine stale socket
      // (confirmed disconnected) from a name conflict / impersonation attempt.
      const liveSocketIds = new Set(io.sockets.sockets.keys());
      const joinResult = roomManager.addPlayerToRoom(code, {
        socketId: socket.id,
        name: finalName,
        isHost: shouldBeHost,
        liveSocketIds
      });

      if (!joinResult.success) {
        socket.emit("room:error", "Unable to join room.");
        return;
      }

      socket.join(code);

      const roomState = roomManager.serializeRoom(code);
      io.to(code).emit("room:state", roomState);

      // If game is in progress, send current game state to the player
      if (roomState.phase === "in-progress") {
        // Trigger player:joined event so game can restore state
        gameEngine.handleGameEvent({
          roomCode: code,
          eventName: "player:joined",
          payload: { isReconnecting: joinResult.isReconnecting },
          socketId: socket.id
        });
      }

      // Notify the rejoining player that they are host again — only when they actually
      // reclaimed host status (hostRestored=true). If a promoted host is already active,
      // hostRestored is false so the original host rejoins silently as a regular player.
      if ((joinResult.genuineReconnect || ipVerifiedSwitch) && joinResult.hostRestored) {
        socket.emit("host:restored", {
          roomCode: code,
          message: "You have been restored as host."
        });

        // Broadcast updated room:state covers any demotion; also send explicit event
        // to the previously-promoted socket so the client can react immediately.
        for (const [sid, p] of room.players) {
          if (sid !== socket.id) {
            io.to(sid).emit("host:changed", { newHostSocketId: socket.id });
          }
        }
      }

      const statusMsg = joinResult.isReconnecting
        ? ` (reconnected${joinResult.wasHost ? ', restored as host' : ''})`
        : (shouldBeHost ? ' as host' : '');
      logInfo(`Socket ${socket.id} joined room ${code}${statusMsg}`);
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
    socket.on("host:startGame", ({ roomCode, gameType, ...payload }) => {
      const code = roomCode ||
        roomManager.getRoomCodeForSocket(socket.id);

      if (!code) {
        socket.emit("room:error", "No room associated with this host.");
        return;
      }

      // Validate host
      const room = roomManager.getRoom(code);
      if (!checkIsHost(socket, room)) {
        socket.emit("room:error", "Only the host can start the game.");
        return;
      }

      try {
        // Pass payload (categories, questionCount, etc.) to startGame
        gameEngine.startGame(code, gameType, payload);
      } catch (err) {
        logWarn(`Failed to start game: ${err?.message}`);
        socket.emit("room:error", err.message || "Failed to start game.");
      }
    });

    // Host shows question (after selecting it)
    socket.on("host:showQuestion", ({ roomCode }) => {
      const code = roomCode || roomManager.getRoomCodeForSocket(socket.id);
      if (!code) return;
      
      const room = roomManager.getRoom(code);
      if (!checkIsHost(socket, room)) return;
      
      gameEngine.handleGameEvent({
        roomCode: code,
        eventName: "host:showQuestion",
        payload: {},
        socketId: socket.id
      });
    });
    
    // Player submits answer
    socket.on("player:submitAnswer", ({ roomCode, answer }) => {
      const code = roomCode || roomManager.getRoomCodeForSocket(socket.id);
      if (!code) return;
      
      gameEngine.handleGameEvent({
        roomCode: code,
        eventName: "player:submitAnswer",
        payload: { answer },
        socketId: socket.id
      });
    });
    
    // Host next question
    socket.on("host:nextQuestion", ({ roomCode }) => {
      const code = roomCode || roomManager.getRoomCodeForSocket(socket.id);
      if (!code) return;
      
      const room = roomManager.getRoom(code);
      if (!checkIsHost(socket, room)) return;
      
      gameEngine.handleGameEvent({
        roomCode: code,
        eventName: "host:nextQuestion",
        payload: {},
        socketId: socket.id
      });
    });
    
    // Player buzz
    socket.on("player:buzz", ({ roomCode }) => {
      const code = roomCode || roomManager.getRoomCodeForSocket(socket.id);
      if (!code) return;
      
      gameEngine.handleGameEvent({
        roomCode: code,
        eventName: "player:buzz",
        payload: {},
        socketId: socket.id
      });
    });
    
    // Host judge answer
    socket.on("host:judgeAnswer", ({ roomCode, correct }) => {
      const code = roomCode || roomManager.getRoomCodeForSocket(socket.id);
      if (!code) return;
      
      const room = roomManager.getRoom(code);
      if (!checkIsHost(socket, room)) return;
      
      gameEngine.handleGameEvent({
        roomCode: code,
        eventName: "host:judgeAnswer",
        payload: { correct },
        socketId: socket.id
      });
    });
    
    // Host restart game
    socket.on("host:restartGame", ({ roomCode, ...restPayload }) => {
      const code = roomCode || roomManager.getRoomCodeForSocket(socket.id);
      if (!code) return;
      
      const room = roomManager.getRoom(code);
      if (!checkIsHost(socket, room)) return;
      
      gameEngine.handleGameEvent({
        roomCode: code,
        eventName: "host:restartGame",
        payload: restPayload,
        socketId: socket.id
      });
    });
    
    // Host kick player
    socket.on("host:kickPlayer", ({ roomCode, socketId: targetSocketId }) => {
      const code = roomCode || roomManager.getRoomCodeForSocket(socket.id);
      if (!code) return;
      const room = roomManager.getRoom(code);
      if (!checkIsHost(socket, room)) return;
      if (!targetSocketId || targetSocketId === socket.id) return; // can't kick self

      // Guard: cannot kick another player who currently holds host status
      const targetPlayer = room.players.get(targetSocketId);
      if (targetPlayer?.isHost) {
        socket.emit("room:error", "Cannot kick the host.");
        return;
      }

      // Guard: cannot kick an actively connected, non-ghost player during a live game.
      // "Active" = socket is connected AND the player has a real (non-auto-generated) name.
      const targetIsLive = io.sockets.sockets.has(targetSocketId);
      const targetName = targetPlayer?.name || "";
      const isGhostName = /^Player-[a-zA-Z0-9]{4}$/.test(targetName);
      if (room.phase === "in-progress" && targetIsLive && !isGhostName) {
        // Allow kick — hosts can legitimately remove disruptive active players
        // but we log a warning for audit purposes.
        logInfo(`Host ${socket.id} kicking active player ${targetName} from live game ${code}`);
      }

      // Notify the kicked player
      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.emit("player:kicked");
        targetSocket.leave(code);
      }

      // Remove from room
      roomManager.removePlayerBySocket(targetSocketId);

      // Notify game engine so kicked player disappears from scores/leaderboard
      // (their score is preserved in scoresByName so it restores if they rejoin)
      if (room.phase === "in-progress") {
        gameEngine.handleGameEvent({
          roomCode: code,
          eventName: "player:kicked",
          payload: { socketId: targetSocketId, playerName: targetName },
          socketId: socket.id
        });
      }

      // Broadcast updated room state
      const roomState = roomManager.serializeRoom(code);
      io.to(code).emit("room:state", roomState);
      logInfo(`Host kicked player ${targetSocketId} (${targetName}) from room ${code}`);
    });

    // Host end game
    socket.on("host:endGame", ({ roomCode }) => {
      const code = roomCode || roomManager.getRoomCodeForSocket(socket.id);
      if (!code) return;

      const room = roomManager.getRoom(code);
      if (!checkIsHost(socket, room)) return;

      gameEngine.handleGameEvent({
        roomCode: code,
        eventName: "host:endGame",
        payload: {},
        socketId: socket.id
      });
    });

    // Host skip round (force advance to results/next question)
    socket.on("host:skipRound", ({ roomCode }) => {
      const code = roomCode || roomManager.getRoomCodeForSocket(socket.id);
      if (!code) return;

      const room = roomManager.getRoom(code);
      if (!checkIsHost(socket, room)) return;

      gameEngine.handleGameEvent({
        roomCode: code,
        eventName: "host:skipRound",
        payload: {},
        socketId: socket.id
      });
    });

    // Host broadcasts selected categories to lobby players (lobby phase only — no game instance yet)
    socket.on("host:previewCategories", ({ roomCode, categories } = {}) => {
      const code = roomCode || roomManager.getRoomCodeForSocket(socket.id);
      if (!code) return;
      const room = roomManager.getRoom(code);
      if (!checkIsHost(socket, room)) return;
      io.to(code).emit("lobby:categoriesPreview", {
        categories: Array.isArray(categories) ? categories : []
      });
    });

    // Host flags the current question as bad (no scores counted for the round)
    socket.on("host:flagQuestion", ({ roomCode }) => {
      const code = roomCode || roomManager.getRoomCodeForSocket(socket.id);
      if (!code) return;
      const room = roomManager.getRoom(code);
      if (!checkIsHost(socket, room)) return;
      gameEngine.handleGameEvent({
        roomCode: code,
        eventName: "host:flagQuestion",
        payload: {},
        socketId: socket.id
      });
    });

    // Host shuffle remaining questions
    socket.on("host:shuffleQuestions", ({ roomCode }) => {
      const code = roomCode || roomManager.getRoomCodeForSocket(socket.id);
      if (!code) return;

      const room = roomManager.getRoom(code);
      if (!checkIsHost(socket, room)) return;

      gameEngine.handleGameEvent({
        roomCode: code,
        eventName: "host:shuffleQuestions",
        payload: {},
        socketId: socket.id
      });
    });

    // Host pause game
    socket.on("host:pauseGame", ({ roomCode }) => {
      const code = roomCode || roomManager.getRoomCodeForSocket(socket.id);
      if (!code) return;
      const room = roomManager.getRoom(code);
      if (!checkIsHost(socket, room)) return;
      gameEngine.handleGameEvent({
        roomCode: code,
        eventName: "host:pauseGame",
        payload: {},
        socketId: socket.id
      });
    });

    // Host resume game
    socket.on("host:resumeGame", ({ roomCode }) => {
      const code = roomCode || roomManager.getRoomCodeForSocket(socket.id);
      if (!code) return;
      const room = roomManager.getRoom(code);
      if (!checkIsHost(socket, room)) return;
      gameEngine.handleGameEvent({
        roomCode: code,
        eventName: "host:resumeGame",
        payload: {},
        socketId: socket.id
      });
    });

    // Client keepalive — just keeps the socket connection alive; no-op on server
    socket.on("heartbeat", () => { /* no-op */ });

    // Player voluntarily quits mid-game (score preserved, can rejoin)
    socket.on("player:quit", ({ roomCode: quitRoomCode } = {}) => {
      const code = quitRoomCode || roomManager.getRoomCodeForSocket(socket.id);
      if (!code) return;

      const room = roomManager.getRoom(code);
      const gameInProgress = room?.phase === "in-progress";
      const playerBeforeRemoval = room?.players?.get(socket.id);
      const playerNameBeforeRemoval = playerBeforeRemoval?.name;

      const result = roomManager.removePlayerBySocket(socket.id);
      socket.leave(code);

      if (result && result.roomCode) {
        if (gameInProgress) {
          gameEngine.handleGameEvent({
            roomCode: code,
            eventName: "player:disconnected",
            payload: { socketId: socket.id, playerName: playerNameBeforeRemoval },
            socketId: socket.id
          });
        }
        // Promote a new host if the quitting player was host
        promoteNewHostIfNeeded(code, result.wasHost);

        const roomState = roomManager.serializeRoom(code);
        if (roomState) io.to(code).emit("room:state", roomState);
        logInfo(`Player ${playerNameBeforeRemoval} quit room ${code}`);
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
      // Get room info BEFORE removing player so we can pass the name to the game engine
      const roomCode = roomManager.getRoomCodeForSocket(socket.id);
      const room = roomCode ? roomManager.getRoom(roomCode) : null;
      const gameInProgress = room?.phase === "in-progress";

      // Capture player name before removal — room.players will no longer have this socket after removePlayerBySocket
      const playerBeforeRemoval = room?.players?.get(socket.id);
      const playerNameBeforeRemoval = playerBeforeRemoval?.name;

      const result = roomManager.removePlayerBySocket(socket.id);

      if (result && result.roomCode) {
        const { roomCode: code, roomDestroyed } = result;

        if (roomDestroyed) {
          io.to(code).emit("room:closed");
          logInfo(`Room ${code} destroyed (last player left).`);
        } else {
          // Notify game engine about player disconnect if game is in progress.
          // Pass playerName so the game can save the score even though room.players no longer has this socket.
          if (gameInProgress) {
            gameEngine.handleGameEvent({
              roomCode: code,
              eventName: "player:disconnected",
              payload: { socketId: socket.id, playerName: playerNameBeforeRemoval },
              socketId: socket.id
            });
          }

          // If the disconnecting socket was the host AND the same player already rejoined
          // under a new socket (stale-socket refresh race), restore host status immediately
          // instead of waiting for the 4-second promotion timer.
          if (result.wasHost) {
            const restored = restoreDeferredHost(code, playerNameBeforeRemoval);
            if (!restored) {
              // No matching rejoined socket found — fall back to delayed promotion.
              promoteNewHostIfNeeded(code, true);
            }
          }

          const roomState = roomManager.serializeRoom(code);
          io.to(code).emit("room:state", roomState);
          logInfo(`Socket ${socket.id} left room ${code}`);
        }
      } else {
        logInfo(`Socket disconnected (no room): ${socket.id}`);
      }
    });
  });
}

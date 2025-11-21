import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";

import { createRoomManager } from "./core/RoomManager.js";
import { createGameEngine } from "./core/GameEngine.js";
import registerSocketHandlers from "./socketHandlers.js";
import { logInfo, logError } from "./utils/logger.js";

// Global error handlers - must be set before any async operations
process.on("unhandledRejection", (reason, promise) => {
  logError(`Unhandled Rejection at: ${promise}, reason: ${reason}`);
  console.error(reason);
});

process.on("uncaughtException", (error) => {
  logError(`Uncaught Exception: ${error.message}`);
  console.error(error);
  // Don't exit immediately - let the server try to handle it
});

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: "*"
  }
});

// Socket.IO error handler
io.on("error", (error) => {
  logError(`Socket.IO error: ${error.message}`);
  console.error(error);
});

try {
  // Core managers
  const roomManager = createRoomManager();
  const gameEngine = createGameEngine(io, roomManager);

  // Wire socket handlers
  registerSocketHandlers(io, roomManager, gameEngine);

  // Simple health route
  app.get("/", (req, res) => {
    res.json({ status: "ok", service: "griffinhgames-server" });
  });

  // Error handling middleware (must be after routes)
  app.use((err, req, res, next) => {
    logError(`Express error: ${err.message}`);
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  // Railway port binding
  const PORT = process.env.PORT || 3000;

  // HTTP server error handler (must be set before listen)
  httpServer.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      logError(`Port ${PORT} is already in use`);
    } else {
      logError(`HTTP Server error: ${error.message}`);
    }
    console.error(error);
  });

  httpServer.listen(PORT, () => {
    logInfo(`Server running on port ${PORT}`);
  });
} catch (error) {
  logError(`Failed to start server: ${error.message}`);
  console.error(error);
  process.exit(1);
}

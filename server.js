import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { createRoomManager } from "./core/RoomManager.js";
import { createGameEngine } from "./core/GameEngine.js";
import registerSocketHandlers from "./socketHandlers.js";
import { logInfo, logError } from "./utils/logger.js";
import gameRegistry from "./games/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// Only the GriffinGames site (and local development) may call this server from a browser.
const ALLOWED_ORIGINS = [
  /^https:\/\/(www\.)?griffinhgames\.xyz$/,
  /^https:\/\/([a-z0-9-]+--)?griffinhgames\.netlify\.app$/, // production + Netlify previews
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
];
const corsOrigin = (origin, callback) => {
  // Requests without an Origin header (curl, health checks) aren't from a browser page
  if (!origin || ALLOWED_ORIGINS.some(re => re.test(origin))) return callback(null, true);
  callback(null, false);
};

const app = express();
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

const httpServer = createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: corsOrigin
  },
  pingTimeout: 120000,   // 2 minutes before disconnect
  pingInterval: 30000    // ping every 30 seconds
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

  // BuzzIn: return deduplicated question counts per category.
  // Uses the game module's pre-computed categoryCounts so the client slider always
  // reflects the true available pool (identical to what buildQuestionPool draws from).
  app.get("/buzzin/category-counts", (req, res) => {
    const buzzin = gameRegistry.buzzin;
    if (buzzin?.categoryCounts) {
      return res.json({
        ...buzzin.categoryCounts,
        _maxPerGame: buzzin.maxQuestionsPerGame ?? 100
      });
    }
    // Fallback — should never reach here in normal operation
    logError("buzzin.categoryCounts not available");
    return res.status(500).json({ error: "Category counts unavailable" });
  });

  // Games list endpoint for frontend discovery
  app.get("/games", (req, res) => {
    const games = Object.values(gameRegistry).map(game => ({
      id: game.id,
      name: game.name,
      description: game.description || "",
      minPlayers: game.minPlayers || 1,
      maxPlayers: game.maxPlayers || 10,
      icon: game.icon || "🎮",
      type: "multiplayer" // Indicates this is a backend multiplayer game
    }));
    res.json({ games });
  });

  // Error handling middleware (must be after routes)
  app.use((err, req, res, next) => {
    logError(`Express error: ${err.message}`);
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  // Hosting providers (Render) set PORT; 3000 is the local default the frontend expects
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

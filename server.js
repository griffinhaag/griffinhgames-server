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

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: "*"
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

  // BuzzIn: return actual question counts per category (reads live from files)
  app.get("/buzzin/category-counts", (req, res) => {
    const categoriesDir = path.join(__dirname, "games/buzzin/categories");
    const categoryNames = {
      "general-knowledge": "General Knowledge",
      "science": "Science",
      "movies-tv": "Movies & TV",
      "music": "Music",
      "sports": "Sports",
      "history": "History",
      "geography": "Geography",
      "pop-culture": "Pop Culture",
      "games": "Games",
      "random": "Random"
    };
    const counts = {};
    try {
      const files = fs.readdirSync(categoriesDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          const key = file.replace(".json", "");
          const name = categoryNames[key] || key;
          try {
            const questions = JSON.parse(fs.readFileSync(path.join(categoriesDir, file), "utf-8"));
            counts[name] = questions.length;
          } catch (e) {
            counts[name] = 0;
          }
        }
      }
    } catch (e) {
      logError(`Failed to read category counts: ${e.message}`);
      return res.status(500).json({ error: "Failed to read categories" });
    }
    res.json(counts);
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

  // Port binding: use PORT from environment (Vercel, Railway, Fly, etc.) or 3000 for local
  const PORT = process.env.PORT || 10000;

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

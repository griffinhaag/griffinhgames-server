import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";

import { createRoomManager } from "./core/RoomManager.js";
import { createGameEngine } from "./core/GameEngine.js";
import registerSocketHandlers from "./socketHandlers.js";
import { logInfo } from "./utils/logger.js";

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: "*"
  }
});

// Core managers
const roomManager = createRoomManager();
const gameEngine = createGameEngine(io, roomManager);

// Wire socket handlers
registerSocketHandlers(io, roomManager, gameEngine);

// Simple health route
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "griffinhgames-server" });
});

// Railway port binding
const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, () => {
  logInfo(`Server running on port ${PORT}`);
});

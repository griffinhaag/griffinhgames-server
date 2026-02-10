/**
 * Express app for Vercel serverless deployment.
 * Serves HTTP API only (/, /games). WebSockets (Socket.IO) are not supported on Vercel;
 * use a separate WebSocket host or real-time provider if needed.
 */
import express from "express";
import cors from "cors";
import gameRegistry from "../games/index.js";
import { logError } from "../utils/logger.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.json({ status: "ok", service: "griffinhgames-server" });
});

app.get("/games", (req, res) => {
  const games = Object.values(gameRegistry).map((game) => ({
    id: game.id,
    name: game.name,
    description: game.description || "",
    minPlayers: game.minPlayers || 1,
    maxPlayers: game.maxPlayers || 10,
    icon: game.icon || "🎮",
    type: "multiplayer",
  }));
  res.json({ games });
});

app.use((err, req, res, next) => {
  logError(`Express error: ${err.message}`);
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

export default app;

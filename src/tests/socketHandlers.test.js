/**
 * Regression tests for socketHandlers.js, driven through a fake Socket.IO server.
 * Run with: node src/tests/socketHandlers.test.js
 */

import assert from "node:assert/strict";
import { installFakeClock, createFakeIO, createRunner } from "./fakes.js";

const clock = installFakeClock();
const { createRoomManager } = await import("../../core/RoomManager.js");
const { createGameEngine } = await import("../../core/GameEngine.js");
const { default: registerSocketHandlers } = await import("../../socketHandlers.js");

const { test, finish } = createRunner();

function setup() {
  const { io, connect } = createFakeIO();
  const roomManager = createRoomManager();
  const gameEngine = createGameEngine(io, roomManager);
  registerSocketHandlers(io, roomManager, gameEngine);

  function createRoom(name = "Hosty", opts) {
    const host = connect(opts);
    host.send("player:setName", name);
    host.send("host:createRoom", {});
    return { host, code: host.last("room:created").code };
  }
  function join(code, name, opts) {
    const s = connect(opts);
    s.send("player:joinRoom", { roomCode: code, name });
    return s;
  }
  const playerIn = (code, name) =>
    [...roomManager.getRoom(code).players.values()].find(p => p.name === name);

  return { io, connect, roomManager, gameEngine, createRoom, join, playerIn };
}

const START = { gameType: "buzzin", categories: ["Science"], questionCount: 5, offTheDomeCount: 0 };

// Start a game and advance through the 10s countdown to the first question
async function startAndShow(ctx, host, code) {
  host.send("host:startGame", { roomCode: code, ...START });
  await clock.advance(10500);
  host.send("host:showQuestion", { roomCode: code });
  return host.last("game:state").currentQuestion;
}

// ─── game:event route ───────────────────────────────────────────────────────

console.log("\ngame:event — server-internal events cannot be spoofed:");
{
  const ctx = setup();
  const { host, code } = ctx.createRoom();
  const alice = ctx.join(code, "Alice");
  ctx.join(code, "Bob");
  const outsider = ctx.connect({ ip: "10.9.9.9" });
  const q = await startAndShow(ctx, host, code);

  alice.send("player:submitAnswer", { roomCode: code, answer: q.answer });
  outsider.send("game:event", { roomCode: code, eventName: "player:kicked", payload: { socketId: alice.id } });
  outsider.send("game:event", { roomCode: code, eventName: "player:disconnected", payload: { playerName: "Alice" } });
  host.send("player:submitAnswer", { roomCode: code, answer: "nope" });

  await test("outsider cannot erase another player's answer", () =>
    assert.equal(host.last("game:state").answeredCount, 2));
  await test("outsider cannot remove a player from the scoreboard", () =>
    assert.ok(host.last("game:state").scores.some(s => s.name === "Alice")));

  const bob = [...ctx.io.sockets.sockets.values()].find(s => ctx.playerIn(code, "Bob")?.socketId === s.id);
  bob.send("game:event", { roomCode: code, eventName: "player:kicked", payload: { socketId: alice.id } });
  await test("room member cannot spoof player:kicked either", () =>
    assert.equal(host.last("game:state").answeredCount, 2));
}

// ─── Host grace period ──────────────────────────────────────────────────────

console.log("\nHost grace period — other players cannot grab host while host is away:");
{
  const ctx = setup();
  const { host, code } = ctx.createRoom();
  ctx.join(code, "Alice");
  const bob = ctx.join(code, "Bob");

  host.disconnect();
  await clock.advance(200);
  bob.disconnect();
  ctx.join(code, "Bob"); // Bob refreshes during the grace period

  await test("refreshing player does not become host during grace period", () =>
    assert.equal(ctx.playerIn(code, "Bob").isHost, false));

  ctx.join(code, "Hosty");
  await test("original host gets host back when rejoining within grace period", () =>
    assert.equal(ctx.playerIn(code, "Hosty").isHost, true));
}
{
  const ctx = setup();
  const { host, code } = ctx.createRoom();
  ctx.join(code, "Alice");
  host.disconnect();
  await clock.advance(31000);
  await test("a player is promoted once the 30s grace period expires", () =>
    assert.equal(ctx.playerIn(code, "Alice").isHost, true));
  ctx.join(code, "Hosty");
  await test("original host rejoining after promotion stays a regular player", () =>
    assert.equal(ctx.playerIn(code, "Hosty").isHost, false));
}
{
  const ctx = setup();
  const { host, code } = ctx.createRoom();
  const alice = ctx.join(code, "Alice");
  host.disconnect();
  alice.disconnect();
  ctx.join(code, "Alice");
  await test("first player back into an empty room becomes host", () =>
    assert.equal(ctx.playerIn(code, "Alice").isHost, true));
}

// ─── Name validation ────────────────────────────────────────────────────────

console.log("\nplayer:setName validation:");
{
  const ctx = setup();
  const s = ctx.connect();
  s.send("player:setName", { evil: true });
  await test("non-string names are rejected", () => assert.equal(ctx.roomManager.getPlayerName(s.id), null));
  s.send("player:setName", "  " + "N".repeat(50) + "  ");
  await test("names are trimmed and capped at 20 characters", () =>
    assert.equal(ctx.roomManager.getPlayerName(s.id), "N".repeat(20)));
}

finish();

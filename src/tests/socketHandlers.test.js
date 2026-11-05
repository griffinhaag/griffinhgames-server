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

// ─── Game lifecycle ─────────────────────────────────────────────────────────

console.log("\nGame lifecycle — duplicate start and room destruction:");
{
  const ctx = setup();
  const { host, code } = ctx.createRoom();
  const alice = ctx.join(code, "Alice");
  host.send("host:startGame", { roomCode: code, ...START });
  await clock.advance(400);
  host.send("host:startGame", { roomCode: code, ...START });
  await clock.advance(10500);
  const countdownTicks = alice.all("game:state").filter(s => s.phase === "countdown").length;
  await test("a duplicate start does not run a second countdown", () => assert.equal(countdownTicks, 11));
  const firstQuestions = new Set(alice.all("game:state").filter(s => s.phase === "waiting").map(s => s.currentQuestion.question));
  await test("only one first question is broadcast", () => assert.equal(firstQuestions.size, 1));

  host.disconnect();
  alice.disconnect();
  await clock.advance(5 * 60 * 1000 + 1000);
  await test("room destruction tears down the active game", () => {
    assert.equal(ctx.roomManager.getRoom(code), null);
    assert.equal(ctx.gameEngine.getGameState(code), null);
  });
}

// ─── Switching rooms ────────────────────────────────────────────────────────

console.log("\nSwitching rooms — no ghost player left behind:");
{
  const ctx = setup();
  const { host, code } = ctx.createRoom();
  const alice = ctx.join(code, "Alice");
  host.send("host:createRoom", {});
  const code2 = host.last("room:created").code;
  await test("creating a second room removes the host from the first", () =>
    assert.equal(ctx.playerIn(code, "Hosty"), undefined));
  await test("host is in the new room", () => assert.equal(ctx.playerIn(code2, "Hosty")?.isHost, true));

  alice.send("player:joinRoom", { roomCode: code2, name: "Alice" });
  await test("joining another room removes the player from the old one", () =>
    assert.equal(ctx.roomManager.getRoom(code).players.size, 0));
  await test("player is in the new room", () => assert.ok(ctx.playerIn(code2, "Alice")));
}

// ─── Kicks ──────────────────────────────────────────────────────────────────

console.log("\nKicked players cannot rejoin:");
{
  const ctx = setup();
  const { host, code } = ctx.createRoom();
  const alice = ctx.join(code, "Alice");
  ctx.join(code, "Bob");
  host.send("host:kickPlayer", { roomCode: code, socketId: alice.id });
  await test("kicked player is removed", () => assert.equal(ctx.playerIn(code, "Alice"), undefined));

  alice.send("player:joinRoom", { roomCode: code, name: "alice" });
  await test("rejoin with the same name is rejected", () => assert.equal(ctx.playerIn(code, "alice"), undefined));
  await test("rejection message mentions the kick", () => assert.match(alice.last("room:error"), /kicked/));

  const fresh = ctx.join(code, "Alice ");
  await test("a fresh socket with the same name is also rejected", () =>
    assert.match(fresh.last("room:error"), /kicked/));

  const { code: otherCode } = ctx.createRoom("Other");
  const carol = ctx.join(otherCode, "Carol");
  host.send("host:kickPlayer", { roomCode: code, socketId: carol.id });
  await test("host cannot kick a player who is in a different room", () =>
    assert.ok(ctx.playerIn(otherCode, "Carol")));
}

// ─── Setup page → game page hand-off ─────────────────────────────────────────
// Creating a room happens on setup.html; the browser then loads index.html, which opens a
// new connection and joins with the one-time hand-off code from room:created. That is the
// same host continuing, never "host restored" or a "device switch".

console.log("\nSetup → game page hand-off:");
{
  // Path 1: setup page's connection is still open when the game page joins (common online)
  const ctx = setup();
  const { host: setupPage, code } = ctx.createRoom("Hosty");
  const token = setupPage.last("room:created").handoffToken;
  await test("room:created includes a hand-off code for the setup page", () => assert.ok(token));
  await test("the hand-off code is not broadcast to the room", () =>
    assert.equal(setupPage.last("room:state").handoffToken, undefined));

  const gamePage = ctx.connect();
  gamePage.send("player:joinRoom", { roomCode: code, name: "Hosty", isHost: true, handoffToken: token });
  await test("game page joins as host", () => assert.equal(ctx.playerIn(code, "Hosty")?.isHost, true));
  await test("no 'host status restored' message when the setup page is still connected", () =>
    assert.equal(gamePage.all("host:restored").length, 0));
  await test("the setup page is not told its session moved to another device", () =>
    assert.equal(setupPage.all("host:deviceChanged").length, 0));
  await test("there is only one Hosty in the room", () =>
    assert.equal([...ctx.roomManager.getRoom(code).players.values()].filter(p => p.name === "Hosty").length, 1));

  setupPage.disconnect(); // the old connection finally closes later
  await clock.advance(1000);
  await test("no 'host status restored' when the old setup connection closes later", () =>
    assert.equal(gamePage.all("host:restored").length, 0));
}
{
  // Path 2: setup connection closed, game page is slow to load (> 5 seconds)
  const ctx = setup();
  const { host: setupPage, code } = ctx.createRoom("Hosty");
  const token = setupPage.last("room:created").handoffToken;
  setupPage.disconnect();
  await clock.advance(6000);
  const gamePage = ctx.connect();
  gamePage.send("player:joinRoom", { roomCode: code, name: "Hosty", isHost: true, handoffToken: token });
  await test("slow page load still joins as host", () => assert.equal(ctx.playerIn(code, "Hosty")?.isHost, true));
  await test("no 'host status restored' message after a slow page load", () =>
    assert.equal(gamePage.all("host:restored").length, 0));

  // A real return later (no hand-off code) still gets the message
  gamePage.disconnect();
  await clock.advance(6000);
  const back = ctx.connect();
  back.send("player:joinRoom", { roomCode: code, name: "Hosty", isHost: true });
  await test("a host who leaves and comes back still sees 'host status restored'", () =>
    assert.equal(back.all("host:restored").length, 1));
  await test("'restored' arrives before the room update (the join page redirects on room:state)", () => {
    const order = back.received.map(r => r.event);
    assert.ok(order.indexOf("host:restored") < order.indexOf("room:state"), order.join(", "));
  });
}
{
  // The hand-off code works once, and only for the right room
  const ctx = setup();
  const { host: setupPage, code } = ctx.createRoom("Hosty");
  const token = setupPage.last("room:created").handoffToken;
  const alice = ctx.join(code, "Alice");
  const gamePage = ctx.connect();
  gamePage.send("player:joinRoom", { roomCode: code, name: "Hosty", isHost: true, handoffToken: token });
  const impostor = ctx.connect({ ip: "10.7.7.7" });
  impostor.send("player:joinRoom", { roomCode: code, name: "Hosty", isHost: true, handoffToken: token });
  await test("a used hand-off code can't take over the host's name", () =>
    assert.match(impostor.last("room:error") || "", /already active/));
  await test("the real host keeps host", () => assert.equal(ctx.playerIn(code, "Hosty")?.isHost, true));

  const guesser = ctx.connect({ ip: "10.8.8.8" });
  guesser.send("player:joinRoom", { roomCode: code, name: "Alice", isHost: true, handoffToken: "wrong" });
  await test("a wrong hand-off code is ignored (normal name rules apply)", () =>
    assert.match(guesser.last("room:error") || "", /already active/));
  await test("Alice is still in the room", () => assert.ok(ctx.playerIn(code, "Alice")));
  void alice;
}
{
  // Promotion is still announced to the player who becomes host
  const ctx = setup();
  const { host, code } = ctx.createRoom("Hosty");
  const alice = ctx.join(code, "Alice");
  host.disconnect();
  await clock.advance(31000);
  await test("a promoted player is told they are now the host", () =>
    assert.equal(alice.all("host:transferred").length, 1));
  await test("the promoted player does not get a 'restored' message", () =>
    assert.equal(alice.all("host:restored").length, 0));
}

finish();

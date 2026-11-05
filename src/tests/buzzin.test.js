/**
 * Regression tests for the LOCKED IN (buzzin) game module, driven directly with a fake io.
 * Run with: node src/tests/buzzin.test.js
 */

import assert from "node:assert/strict";
import { installFakeClock, createRunner } from "./fakes.js";

const clock = installFakeClock();
const { createRoomManager } = await import("../../core/RoomManager.js");
const { default: buzzin } = await import("../../games/buzzin/index.js");

const { test, finish } = createRunner();

// Host + (n - 1) players in a fresh room with a game instance
function setup(n = 3) {
  const log = [];
  const io = { to: (target) => ({ emit: (event, data) => log.push({ target, event, data }) }) };
  const rm = createRoomManager();
  const room = rm.createRoom({ hostSocketId: "h" });
  rm.addPlayerToRoom(room.code, { socketId: "h", name: "Host", isHost: true });
  for (let i = 1; i < n; i++) rm.addPlayerToRoom(room.code, { socketId: `p${i}`, name: `P${i}` });
  const game = buzzin.create({ io, room, roomManager: rm });
  const ev = (socketId, eventName, payload = {}) => game.handleEvent({ socketId, eventName, payload });
  const events = (type) => log.filter(l => l.event === "game:event" && l.data?.type === type).map(l => l.data);
  const score = (name) => game.getState().scores.filter(s => s.name === name).map(s => s.score);
  return { log, rm, room, game, ev, events, score };
}

async function startAndShow(t, settings = {}) {
  t.ev("h", "host:startGame", { categories: ["Science"], questionCount: 5, offTheDomeCount: 0, ...settings });
  await clock.advance(10500);
  t.ev("h", "host:showQuestion");
  return t.game.getState().currentQuestion;
}

// ─── Answer validation ──────────────────────────────────────────────────────

console.log("\nAnswer validation:");
{
  const t = setup(3);
  const q = await startAndShow(t);
  t.ev("h", "player:submitAnswer", { answer: q.answer });
  t.ev("p1", "player:submitAnswer", { answer: q.answer });
  t.ev("p2", "player:submitAnswer", { answer: 123 });
  t.ev("p2", "player:submitAnswer", { answer: ["x"] });
  t.ev("p2", "player:submitAnswer", { answer: { a: 1 } });
  await clock.flush();
  await test("non-string answers are ignored (round still waiting on that player)", () =>
    assert.equal(t.game.getState().phase, "question"));
  t.ev("p2", "player:submitAnswer", { answer: "x".repeat(5000) });
  await clock.flush();
  await test("round completes normally once a string answer arrives", () =>
    assert.equal(t.events("round_results").length, 1));
  const p2 = t.events("round_results")[0].results.find(r => r.socketId === "p2");
  await test("long answers are capped at 200 characters", () => assert.equal(p2.answer.length, 200));
  await test("correct players are scored", () => assert.deepEqual(t.score("P1"), [100]));
}
{
  const t = setup(2);
  const q = await startAndShow(t);
  t.ev("h", "player:submitAnswer", { answer: `   ${q.answer}  ` });
  t.ev("p1", "player:submitAnswer", { answer: "nope" });
  await clock.flush();
  const host = t.events("round_results")[0].results.find(r => r.socketId === "h");
  await test("answers are trimmed before being stored and graded", () => {
    assert.equal(host.answer, q.answer);
    assert.equal(host.isCorrect, true);
  });
}

finish();

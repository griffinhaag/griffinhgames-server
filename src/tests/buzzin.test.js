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

// ─── Flag questions ─────────────────────────────────────────────────────────

console.log("\nFlag questions — shared display text does not merge questions:");
{
  const t = setup(2);
  t.ev("h", "host:startGame", { categories: ["Flags"], questionCount: 20, offTheDomeCount: 1, otdAtEnd: true });
  await clock.advance(10500);
  let otd = 0;
  let pictureFlags = 0;
  for (let i = 0; i < 20 && t.game.getState().phase !== "end"; i++) {
    const s = t.game.getState();
    if (s.isOffTheDome) otd++;
    if (s.currentQuestion.imageDisplay) pictureFlags++;
    t.ev("h", "host:flagQuestion"); // advance without answering
  }
  await test("flag emoji is moved out of the question text", () => assert.ok(pictureFlags > 1));
  await test("exactly the configured number of OTD questions", () => assert.equal(otd, 1));
}

// ─── Question bank ──────────────────────────────────────────────────────────

console.log("\nQuestion bank — multiple-choice options are unique:");
{
  // Play through every Sports question (the category with the most duplicate-choice entries)
  const t = setup(2);
  t.ev("h", "host:startGame", { categories: ["Sports"], questionCount: 100, offTheDomeCount: 0 });
  await clock.advance(10500);
  const dupes = [];
  for (let i = 0; i < 100 && t.game.getState().phase !== "end"; i++) {
    const q = t.game.getState().currentQuestion;
    const lower = (q.choices || []).map(c => c.toLowerCase().trim());
    if (new Set(lower).size !== lower.length) dupes.push(q.question);
    t.ev("h", "host:flagQuestion");
  }
  await test("no question is served with duplicate choices", () => assert.deepEqual(dupes, []));
}

// ─── Disconnects mid-round ──────────────────────────────────────────────────

// Simulate what socketHandlers does when a socket disconnects mid-game
function disconnect(t, sid) {
  const name = t.room.players.get(sid)?.name;
  t.rm.removePlayerBySocket(sid);
  t.ev(sid, "player:disconnected", { socketId: sid, playerName: name });
}
function rejoin(t, sid, name) {
  const r = t.rm.addPlayerToRoom(t.room.code, { socketId: sid, name });
  t.ev(sid, "player:joined", { isReconnecting: r.isReconnecting });
}

console.log("\nDisconnects mid-round:");
{
  const t = setup(3);
  const q = await startAndShow(t);
  t.ev("p1", "player:submitAnswer", { answer: q.answer });
  disconnect(t, "p1");
  t.ev("h", "player:submitAnswer", { answer: q.answer });
  await clock.flush();
  await test("round keeps waiting for players still in the room", () =>
    assert.equal(t.game.getState().phase, "question"));
  t.ev("p2", "player:submitAnswer", { answer: "nope" });
  await clock.flush();
  await test("round ends once every remaining player answered", () =>
    assert.equal(t.game.getState().phase, "result"));
}

console.log("\nAnswer, refresh, rejoin — answer and points follow the player:");
{
  const t = setup(3);
  let q = await startAndShow(t);
  t.ev("p1", "player:submitAnswer", { answer: q.answer });
  disconnect(t, "p1");
  rejoin(t, "p1b", "P1");
  t.ev("p1b", "player:submitAnswer", { answer: "second try" });
  t.ev("h", "player:submitAnswer", { answer: "nope" });
  t.ev("p2", "player:submitAnswer", { answer: "nope" });
  await clock.flush();
  const res = t.events("round_results")[0].results;
  await test("rejoined player cannot answer twice", () =>
    assert.deepEqual(res.filter(r => r.name === "P1").map(r => r.answer), [q.answer]));
  await test("points go to the rejoined player's live entry", () => assert.deepEqual(t.score("P1"), [150]));
  await test("no ghost Player-XXXX row on the scoreboard", () =>
    assert.ok(!t.game.getState().scores.some(s => s.name.startsWith("Player-"))));

  t.ev("h", "host:nextQuestion");
  t.ev("h", "host:showQuestion");
  q = t.game.getState().currentQuestion;
  t.ev("p1b", "player:submitAnswer", { answer: q.answer });
  t.ev("h", "player:submitAnswer", { answer: "nope" });
  t.ev("p2", "player:submitAnswer", { answer: "nope" });
  await clock.flush();
  await test("later points add onto the carried-over score", () => assert.deepEqual(t.score("P1"), [300]));
}
{
  const t = setup(3);
  const q = await startAndShow(t);
  t.ev("p1", "player:submitAnswer", { answer: q.answer });
  disconnect(t, "p1");
  t.ev("h", "player:submitAnswer", { answer: "nope" });
  t.ev("p2", "player:submitAnswer", { answer: "nope" });
  await clock.flush();
  await test("player still away at round end gets no ghost row", () =>
    assert.ok(!t.game.getState().scores.some(s => s.name.startsWith("Player-"))));
  rejoin(t, "p1b", "P1");
  await test("their points are restored when they come back", () => assert.deepEqual(t.score("P1"), [150]));
  t.ev("h", "host:flagQuestion");
  await test("flagging the round rolls those points back", () => assert.deepEqual(t.score("P1"), [0]));
}

// ─── Async grading ──────────────────────────────────────────────────────────

console.log("\nHost actions while OTD answers are still being graded:");
{
  const t = setup(3);
  await startAndShow(t, { offTheDomeCount: 5 });
  t.ev("p1", "player:submitAnswer", { answer: "needs the AI grader" });
  t.ev("p2", "player:submitAnswer", { answer: "also needs grading" });
  t.ev("h", "player:submitAnswer", { answer: "me too" });
  // Grading is async: these arrive before results are revealed
  t.ev("h", "host:nextQuestion");
  t.ev("h", "host:flagQuestion");
  t.ev("h", "host:shuffleQuestions");
  await clock.flush();
  await test("next/flag/shuffle are ignored until results are revealed", () => {
    assert.equal(t.game.getState().phase, "result");
    assert.equal(t.game.getState().currentQuestionIndex, 0);
  });
  await test("round results still include every answer", () =>
    assert.equal(t.events("round_results")[0]?.results.length, 3));
  t.ev("h", "host:nextQuestion");
  await test("host can advance once results are out", () =>
    assert.equal(t.game.getState().phase, "waiting"));
}
{
  const t = setup(2);
  await startAndShow(t, { offTheDomeCount: 5 });
  t.ev("p1", "player:submitAnswer", { answer: "needs the AI grader" });
  t.ev("h", "player:submitAnswer", { answer: "me too" });
  t.ev("h", "host:restartGame", {});
  await clock.flush();
  await test("results from an abandoned round are discarded after a restart", () => {
    assert.equal(t.events("round_results").length, 0);
    assert.equal(t.game.getState().phase, "countdown");
  });
}

finish();

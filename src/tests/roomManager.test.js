/**
 * Group 3 targeted tests for RoomManager.
 * Covers host transfer determinism and player rejoin flows.
 * Run with: node src/tests/roomManager.test.js
 */

import assert from "node:assert/strict";
import { createRoomManager } from "../../core/RoomManager.js";

let passed = 0;
let failed = 0;

function test(label, fn) {
  try {
    fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${label}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ─── Host Transfer Tests ────────────────────────────────────────────────────

console.log("\nHost transfer — original host rejoins before promotion (grace period):");
{
  const rm = createRoomManager();
  const room = rm.createRoom({ hostSocketId: "host-s1" });
  rm.addPlayerToRoom(room.code, { socketId: "host-s1", name: "Alice", isHost: true });
  rm.addPlayerToRoom(room.code, { socketId: "player-s2", name: "Bob", isHost: false });

  // Simulate host disconnect and reconnect within grace period (no promotion yet)
  const removeResult = rm.removePlayerBySocket("host-s1");
  // No promotion timer fires — original host rejoins immediately
  const rejoinResult = rm.addPlayerToRoom(room.code, {
    socketId: "host-s3",
    name: "Alice",
    isHost: false, // shouldBeHost=false because the socketId changed but name matches
    liveSocketIds: new Set(["player-s2", "host-s3"])
  });

  test("isReconnecting=true when same name rejoins", () =>
    assert.equal(rejoinResult.isReconnecting, true));
  test("wasHost=true when original host rejoins", () =>
    assert.equal(rejoinResult.wasHost, true));
  test("hostRestored=true when no promoted host exists", () =>
    assert.equal(rejoinResult.hostRestored, true));

  const r = rm.getRoom(room.code);
  test("room.hostSocketId points to new socket", () =>
    assert.equal(r.hostSocketId, "host-s3"));
  test("Alice is marked isHost in players map", () => {
    const alice = r.players.get("host-s3");
    assert.equal(alice?.isHost, true);
  });
  test("Bob is not marked isHost", () => {
    const bob = r.players.get("player-s2");
    assert.equal(bob?.isHost, false);
  });
}

console.log("\nHost transfer — original host rejoins AFTER a player was promoted:");
{
  const rm = createRoomManager();
  const room = rm.createRoom({ hostSocketId: "host-s1" });
  rm.addPlayerToRoom(room.code, { socketId: "host-s1", name: "Alice", isHost: true });
  rm.addPlayerToRoom(room.code, { socketId: "player-s2", name: "Bob", isHost: false });

  // Alice disconnects
  rm.removePlayerBySocket("host-s1");

  // Simulate 30s timer firing: Bob gets promoted manually (as the server timer would do)
  const r = rm.getRoom(room.code);
  r.players.forEach(p => { p.isHost = false; });
  const bob = r.players.get("player-s2");
  bob.isHost = true;
  r.hostSocketId = "player-s2";

  // Alice tries to rejoin — should NOT displace Bob
  const rejoinResult = rm.addPlayerToRoom(room.code, {
    socketId: "host-s4",
    name: "Alice",
    isHost: false,
    liveSocketIds: new Set(["player-s2", "host-s4"])
  });

  test("isReconnecting=true (was in disconnectedPlayers)", () =>
    assert.equal(rejoinResult.isReconnecting, true));
  test("wasHost=true (was originally host)", () =>
    assert.equal(rejoinResult.wasHost, true));
  test("hostRestored=false because Bob is already the promoted host", () =>
    assert.equal(rejoinResult.hostRestored, false));
  test("genuineReconnect=false (suppressed so host:restored event is not emitted)", () =>
    assert.equal(rejoinResult.genuineReconnect, false));

  const room2 = rm.getRoom(room.code);
  test("Bob keeps hostSocketId after Alice rejoins", () =>
    assert.equal(room2.hostSocketId, "player-s2"));
  test("Bob still isHost", () => {
    const b = room2.players.get("player-s2");
    assert.equal(b?.isHost, true);
  });
  test("Alice rejoins as regular player", () => {
    const alice = room2.players.get("host-s4");
    assert.equal(alice?.isHost, false);
  });
}

// ─── Player Rejoin Tests ────────────────────────────────────────────────────

console.log("\nPlayer rejoin — exact same name + same code:");
{
  const rm = createRoomManager();
  const room = rm.createRoom({ hostSocketId: "host-s1" });
  rm.addPlayerToRoom(room.code, { socketId: "host-s1", name: "Alice", isHost: true });
  rm.addPlayerToRoom(room.code, { socketId: "player-s2", name: "Charlie", isHost: false });

  rm.removePlayerBySocket("player-s2"); // Charlie disconnects

  const rejoin = rm.addPlayerToRoom(room.code, {
    socketId: "player-s3",
    name: "Charlie",
    isHost: false,
    liveSocketIds: new Set(["host-s1", "player-s3"])
  });

  test("Charlie reconnects successfully", () => assert.equal(rejoin.success, true));
  test("isReconnecting=true", () => assert.equal(rejoin.isReconnecting, true));
  test("wasHost=false (Charlie was not host)", () => assert.equal(rejoin.wasHost, false));

  const r = rm.getRoom(room.code);
  test("Charlie is back in players map under new socket", () => {
    const charlie = r.players.get("player-s3");
    assert.equal(charlie?.name, "Charlie");
  });
}

console.log("\nPlayer rejoin — similar but not exact name (should be treated as new player):");
{
  const rm = createRoomManager();
  const room = rm.createRoom({ hostSocketId: "host-s1" });
  rm.addPlayerToRoom(room.code, { socketId: "host-s1", name: "Alice", isHost: true });
  rm.addPlayerToRoom(room.code, { socketId: "player-s2", name: "Charlie", isHost: false });

  rm.removePlayerBySocket("player-s2");

  // "Charlei" (typo) — different name, should not match reconnect window
  const newJoin = rm.addPlayerToRoom(room.code, {
    socketId: "player-s3",
    name: "Charlei",
    isHost: false,
    liveSocketIds: new Set(["host-s1", "player-s3"])
  });

  test("Join succeeds", () => assert.equal(newJoin.success, true));
  test("isReconnecting=false (different name, no match)", () =>
    assert.equal(newJoin.isReconnecting, false));
  test("wasHost=false", () => assert.equal(newJoin.wasHost, false));
}

console.log("\nGhost player prevention — stale socket still live is not immediately replaced:");
{
  const rm = createRoomManager();
  const room = rm.createRoom({ hostSocketId: "host-s1" });
  rm.addPlayerToRoom(room.code, { socketId: "host-s1", name: "Alice", isHost: true });

  // Old socket "host-s1" is still in liveSocketIds — stale-socket refresh race
  const result = rm.addPlayerToRoom(room.code, {
    socketId: "host-s5",
    name: "Alice",
    isHost: false,
    liveSocketIds: new Set(["host-s1", "host-s5"])
  });

  test("Join still succeeds", () => assert.equal(result.success, true));
  test("deferredHostRestore=true so disconnect handler can reconcile", () =>
    assert.equal(result.deferredHostRestore, true));
}

console.log("\nHostRestored return value — fresh join (non-reconnect):");
{
  const rm = createRoomManager();
  const room = rm.createRoom({ hostSocketId: "host-s1" });
  const r = rm.addPlayerToRoom(room.code, { socketId: "host-s1", name: "Alice", isHost: true });

  test("hostRestored=false on initial join (wasHost was false)", () =>
    assert.equal(r.hostRestored, false));
}

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

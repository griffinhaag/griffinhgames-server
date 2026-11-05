/**
 * Test doubles shared by the test files:
 * - a fake Socket.IO server/socket pair that drives socketHandlers.js without a network
 * - a fake clock that replaces the global timer functions and Date.now
 */

// ─── Fake clock ─────────────────────────────────────────────────────────────

export function installFakeClock() {
  const realNow = Date.now;
  const realSetImmediate = globalThis.setImmediate;
  let now = realNow();
  let nextId = 1;
  const timers = new Map(); // id -> { at, fn, interval }

  const add = (fn, ms, interval) => {
    const id = nextId++;
    timers.set(id, { at: now + Math.max(0, ms || 0), fn, interval: interval ? Math.max(1, ms || 0) : 0 });
    return { id, unref() { return this; }, ref() { return this; }, hasRef: () => true, [Symbol.toPrimitive]: () => id };
  };
  const clear = (t) => { if (t != null) timers.delete(typeof t === "object" ? t.id : t); };

  globalThis.setTimeout = (fn, ms) => add(fn, ms, false);
  globalThis.setInterval = (fn, ms) => add(fn, ms, true);
  globalThis.clearTimeout = clear;
  globalThis.clearInterval = clear;
  Date.now = () => now;

  const flush = () => new Promise(r => realSetImmediate(r));

  // Advance virtual time, firing due timers in order and letting promises settle between them
  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      await flush();
      let nextIdKey = null;
      let next = null;
      for (const [id, t] of timers) {
        if (t.at <= target && (!next || t.at < next.at)) { next = t; nextIdKey = id; }
      }
      if (!next) break;
      now = next.at;
      if (next.interval) next.at += next.interval;
      else timers.delete(nextIdKey);
      next.fn();
    }
    now = target;
    await flush();
  }

  return { advance, flush, pendingCount: () => timers.size };
}

// ─── Fake Socket.IO ─────────────────────────────────────────────────────────

export function createFakeIO() {
  let connectionHandler = null;
  const sockets = new Map(); // socketId -> fake socket
  let counter = 0;

  function deliver(target, event, data) {
    for (const s of sockets.values()) {
      if (s.id === target || s.rooms.has(target)) s.received.push({ event, data });
    }
  }

  const io = {
    on(event, fn) { if (event === "connection") connectionHandler = fn; },
    to(target) { return { emit: (event, data) => deliver(target, event, data) }; },
    sockets: { sockets }
  };

  function connect({ ip = "10.0.0.1" } = {}) {
    const id = `sock${++counter}`;
    const handlers = {};
    const socket = {
      id,
      connected: true,
      rooms: new Set(),
      received: [],
      handshake: { headers: {}, address: ip },
      on(event, fn) { handlers[event] = fn; },
      emit(event, data) { this.received.push({ event, data }); },
      join(room) { this.rooms.add(room); },
      leave(room) { this.rooms.delete(room); },
      disconnect() {
        if (!this.connected) return;
        this.connected = false;
        sockets.delete(id);
        handlers.disconnect?.();
      },
      // Simulate the client emitting an event to the server
      send(event, payload) { handlers[event]?.(payload); },
      last(event) {
        for (let i = this.received.length - 1; i >= 0; i--) {
          if (this.received[i].event === event) return this.received[i].data;
        }
        return undefined;
      },
      all(event) { return this.received.filter(r => r.event === event).map(r => r.data); }
    };
    sockets.set(id, socket);
    connectionHandler(socket);
    return socket;
  }

  return { io, connect };
}

// Minimal test runner matching roomManager.test.js output style
export function createRunner() {
  let passed = 0;
  let failed = 0;
  async function test(label, fn) {
    try {
      await fn();
      console.log(`  ✓ ${label}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${label}`);
      console.error(`    ${err.message}`);
      failed++;
    }
  }
  function finish() {
    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    process.exit(failed > 0 ? 1 : 0);
  }
  return { test, finish };
}

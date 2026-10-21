/*
  Three DirectPlay nodes on this machine: a host and two that join, as MTM2 machines do. Each has
  its own ports; the host's enumeration port is moved off 47624.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { createDirectPlay } from "../dplay/provider.js";

const APP = "{6CD1C6E0-96FB-11D1-A268-00A024F2C995}";
const ENUM_PORT = 47700 + Math.floor(Math.random() * 200);
const node = (k) => createDirectPlay({ application: APP, bind: "127.0.0.1", enumPort: ENUM_PORT, tcpPorts: [41000 + k * 10, 41009 + k * 10], udpPorts: [42000 + k * 10, 42009 + k * 10] });
const until = (fn, ms = 3000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const check = () => { const v = fn(); if (v) resolve(v); else if (Date.now() - t0 > ms) reject(new Error("timed out")); else setTimeout(check, 10); };
  check();
});

test("host, find, join, talk, leave, and the host leaving", async () => {
  const host = node(0), a = node(1), b = node(2);
  try {
    await host.host({ name: "Host's Truckin' Game", playerName: "Host" });
    const found = await a.enumerate("127.0.0.1", { timeoutMs: 300 });
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "Host's Truckin' Game");
    assert.equal(found[0].maxPlayers, 8);
    assert.equal(found[0].flags, 0x46);

    const joinedA = await a.join(found[0], { playerName: "Alice" });
    assert.ok(joinedA.playerId);
    await until(() => host.players().length === 2);
    const found2 = await b.enumerate("127.0.0.1", { timeoutMs: 300 });
    await b.join(found2[0], { playerName: "Bob" });
    await until(() => host.players().length === 3 && a.players().length === 3 && b.players().length === 3);
    assert.deepEqual(a.players().map((p) => p.name).sort(), ["Alice", "Bob", "Host"]);

    // Game messages: guaranteed (TCP) and not (UDP), to all and to one.
    const got = { host: [], a: [], b: [] };
    host.on("message", (m) => got.host.push([m.from, m.payload[0]]));
    a.on("message", (m) => got.a.push([m.from, m.payload[0]]));
    b.on("message", (m) => got.b.push([m.from, m.payload[0]]));
    assert.equal(b.send(0, new Uint8Array([0x02]), { guaranteed: false }), 2);
    a.send(host.self().playerId, new Uint8Array([0x14]), { guaranteed: true });
    await until(() => got.host.length === 2 && got.a.length === 1);
    assert.deepEqual(got.a, [[b.self().playerId, 0x02]]);
    assert.ok(got.host.some(([from, t]) => from === a.self().playerId && t === 0x14));
    assert.equal(got.b.length, 0, "nobody hears themselves");

    // Bob leaves: the others see his player go.
    const gone = [];
    host.on("player", (p) => { if (!p.joined) gone.push(p.name); });
    b.leave();
    await until(() => gone.includes("Bob") && a.players().length === 2);

    // The host leaves: Alice is the only machine left and takes over.
    let newHost = null;
    a.on("host", (h) => (newHost = h));
    host.leave();
    await until(() => newHost?.local === true);
    assert.equal(a.isHost(), true);
    assert.deepEqual(a.players().map((p) => p.name), ["Alice"]);
  } finally {
    await Promise.all([host.stop(), a.stop(), b.stop()]);
  }
});

test("a full session refuses another machine", async () => {
  const host = node(3), a = node(4);
  try {
    await host.host({ name: "Tiny", playerName: "Host", maxPlayers: 1 });
    const found = await a.enumerate("127.0.0.1", { timeoutMs: 300, all: true });
    assert.equal(found.length, 1);
    await assert.rejects(a.join(found[0], { playerName: "Late" }), /full/);
  } finally {
    await Promise.all([host.stop(), a.stop()]);
  }
});

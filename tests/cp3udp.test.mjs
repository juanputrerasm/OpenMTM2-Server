/*
  Community Patch 3's direct connect (cp3udp/): the datagrams as the analysis describes them, and a
  host with two clients on this machine: joining, the relay, reliable delivery under loss, leaving,
  and the host going quiet.
*/
import test from "node:test";
import assert from "node:assert/strict";
import dgram from "node:dgram";
import { encode, decode, TYPE, MAGIC, encodeRoster, decodeRoster, nameBytes, readName } from "../cp3udp/codec.js";
import { createDirectConnect } from "../cp3udp/node.js";

const until = (fn, ms = 4000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const check = () => { const v = fn(); if (v) resolve(v); else if (Date.now() - t0 > ms) reject(new Error("timed out")); else setTimeout(check, 10); };
  check();
});

test("datagrams: the 20-byte header, names, the roster", () => {
  const bytes = encode({ type: TYPE.RELIABLE, a: 7, b: 2, c: 0, payload: new Uint8Array([0x80, 1, 2]) });
  assert.equal(bytes.length, 23);
  assert.equal(bytes.readUInt32LE(0), MAGIC);
  assert.deepEqual([...bytes.subarray(0, 4)], [0x4d, 0x54, 0x55, 0x33], "MTU3");
  assert.equal(bytes[4], 2);
  assert.equal(bytes.readUInt16LE(6), 3);
  const d = decode(bytes);
  assert.deepEqual([d.type, d.a, d.b, d.c, [...d.payload]], [2, 7, 2, 0, [0x80, 1, 2]]);
  assert.equal(decode(bytes.subarray(0, 19)), null);
  assert.equal(readName(nameBytes("Juan")), "Juan");
  assert.equal(nameBytes("x".repeat(40)).length, 32);
  const roster = encodeRoster([{ id: 2, ip: "192.168.1.20", port: 51000 }, { id: 3, ip: "10.0.0.5", port: 2350 }]);
  assert.equal(roster.length, 24);
  assert.deepEqual([...roster.subarray(8, 12)], [192, 168, 1, 20], "address in network order");
  assert.deepEqual([...roster.subarray(12, 14)], [0xc7, 0x38], "port in network order");
  assert.deepEqual(decodeRoster(roster), [{ id: 2, ip: "192.168.1.20", port: 51000 }, { id: 3, ip: "10.0.0.5", port: 2350 }]);
});

const fast = { timing: { pingEveryMs: 100, rosterEveryMs: 100, timeoutMs: 600, tickMs: 10 } };

test("a host and two clients: join, ids, the relay, reliable and not, to one and to all, leaving", async () => {
  const port = 46000 + Math.floor(Math.random() * 1000);
  const host = createDirectConnect({ bind: "127.0.0.1", ...fast });
  const ann = createDirectConnect({ bind: "127.0.0.1", ...fast });
  const ben = createDirectConnect({ bind: "127.0.0.1", ...fast });
  const got = { host: [], ann: [], ben: [] };
  host.on("message", (m) => got.host.push(m));
  ann.on("message", (m) => got.ann.push(m));
  ben.on("message", (m) => got.ben.push(m));
  const hostPlayers = [];
  host.on("player", (p) => hostPlayers.push(p));
  try {
    assert.equal((await host.host({ playerName: "Host", port })).playerId, 1);
    assert.equal((await ann.join({ ip: "127.0.0.1", port, playerName: "Ann" })).playerId, 2);
    assert.equal((await ben.join({ ip: "127.0.0.1", port, playerName: "Ben" })).playerId, 3);
    assert.deepEqual(hostPlayers.filter((p) => !p.local).map((p) => [p.id, p.name, p.joined]), [[2, "Ann", true], [3, "Ben", true]]);
    assert.equal(ann.hostId(), 1);

    // Ann to everyone: the host keeps it and passes it to Ben, with Ann as the sender.
    ann.send(0, new Uint8Array([0x80, 1]));
    // Ben to Ann only, through the host; the host does not keep it.
    ben.send(2, new Uint8Array([0x80, 2]));
    // Truck state goes unreliably; it still arrives on a quiet network.
    host.send(0, new Uint8Array([0x02, 3]));
    await until(() => got.ben.length >= 2 && got.ann.length >= 2 && got.host.length >= 1);
    assert.deepEqual(got.host.map((m) => [m.from, m.payload[1]]), [[2, 1]]);
    assert.deepEqual(got.ben.map((m) => [m.from, m.payload[1]]).sort(), [[1, 3], [2, 1]]);
    assert.deepEqual(got.ann.map((m) => [m.from, m.to, m.payload[1]]).sort(), [[1, 0, 3], [3, 2, 2]]);

    // Many reliable messages arrive once each, in order.
    for (let i = 0; i < 30; i++) ann.send(0, new Uint8Array([0x80, 100 + i]));
    await until(() => got.ben.filter((m) => m.payload[1] >= 100).length === 30);
    assert.deepEqual(got.ben.filter((m) => m.payload[1] >= 100).map((m) => m.payload[1]), Array.from({ length: 30 }, (_, i) => 100 + i));

    // Ben leaves: the host reports it.
    ben.leave();
    await until(() => hostPlayers.some((p) => p.id === 3 && !p.joined));
  } finally {
    ann.leave(); ben.leave(); host.leave();
  }
});

test("reliable messages survive a lossy link, through a lossy relay", async () => {
  const port = 47000 + Math.floor(Math.random() * 1000);
  // A proxy in front of the host drops a third of the datagrams both ways.
  const host = createDirectConnect({ bind: "127.0.0.1", ...fast });
  await host.host({ playerName: "Host", port });
  const proxy = dgram.createSocket("udp4");
  const proxyPort = port + 1;
  let client = null, dropped = 0;
  await new Promise((r) => proxy.bind(proxyPort, "127.0.0.1", r));
  const out = dgram.createSocket("udp4");
  await new Promise((r) => out.bind(0, "127.0.0.1", r));
  const lossy = () => { const d = Math.random() < 0.33; if (d) dropped++; return d; };
  proxy.on("message", (m, r) => { client = r; if (!lossy()) out.send(m, port, "127.0.0.1"); });
  out.on("message", (m) => { if (client && !lossy()) proxy.send(m, client.port, client.address); });
  const ann = createDirectConnect({ bind: "127.0.0.1", timing: { ...fast.timing, connectForMs: 5000, joinForMs: 5000, timeoutMs: 5000 } });
  const got = [];
  host.on("message", (m) => got.push(m.payload[1]));
  try {
    await ann.join({ ip: "127.0.0.1", port: proxyPort, playerName: "Ann" });
    for (let i = 0; i < 40; i++) ann.send(0, new Uint8Array([0x80, i]));
    await until(() => got.length >= 40, 15000);
    assert.deepEqual(got.slice(0, 40), Array.from({ length: 40 }, (_, i) => i), "every one, once, in order");
    assert.ok(dropped > 5, "the link did lose datagrams");
  } finally {
    ann.leave(); host.leave(); proxy.close(); out.close();
  }
});

test("the host goes quiet: the lowest id in its roster takes over, the other follows", async () => {
  const port = 48000 + Math.floor(Math.random() * 1000);
  const host = createDirectConnect({ bind: "127.0.0.1", ...fast });
  const ann = createDirectConnect({ bind: "127.0.0.1", ...fast });
  const ben = createDirectConnect({ bind: "127.0.0.1", ...fast });
  try {
    await host.host({ playerName: "Host", port });
    await ann.join({ ip: "127.0.0.1", port, playerName: "Ann" });
    await ben.join({ ip: "127.0.0.1", port, playerName: "Ben" });
    // Let the roster reach both clients, then the host vanishes without a word.
    await new Promise((r) => setTimeout(r, 300));
    const hosts = { ann: null, ben: null };
    ann.on("host", (h) => (hosts.ann = h));
    ben.on("host", (h) => (hosts.ben = h));
    host.vanish();
    await until(() => hosts.ann && hosts.ben, 5000);
    assert.deepEqual(hosts.ann, { id: 2, local: true });
    assert.deepEqual(hosts.ben, { id: 2, local: false });
    assert.equal(ann.isHost(), true);
    // The new host relays.
    const got = [];
    ann.on("message", (m) => got.push(m.payload[1]));
    ben.send(0, new Uint8Array([0x80, 9]));
    await until(() => got.includes(9));
  } finally {
    ann.leave(); ben.leave();
  }
});

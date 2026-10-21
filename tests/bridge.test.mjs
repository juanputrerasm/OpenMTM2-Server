/*
  The desktop helper (bin/openmtm2-bridge.mjs): two pages, each through its own helper, meet over
  DirectPlay on this machine.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { startBridge, originAllowed } from "../bin/openmtm2-bridge.mjs";
import { connect } from "./helpers/ws-client.mjs";

const ENUM_PORT = 46700 + Math.floor(Math.random() * 300);
const helper = (k) => startBridge({ port: 0, token: `t${k}`, dplay: { bind: "127.0.0.1", enumPort: ENUM_PORT, tcpPorts: [43000 + k * 10, 43009 + k * 10], udpPorts: [44000 + k * 10, 44009 + k * 10] } });
const result = (ws, id) => ws.next((m) => m.json && m.json.id === id && (m.json.type === "result" || m.json.type === "error")).then((m) => m.json);

test("who may connect: the site, pages from this computer, nobody else", () => {
  assert.ok(originAllowed("https://juanputrerasm.github.io"));
  assert.ok(originAllowed("http://localhost:8080"));
  assert.ok(originAllowed("https://127.0.0.1:8443"));
  assert.ok(!originAllowed("https://evil.example"));
  assert.ok(!originAllowed(null));
});

test("a foreign page is turned away, a wrong token closes the connection", async () => {
  const b = await helper(0);
  try {
    await assert.rejects(connect(`ws://127.0.0.1:${b.port}/bridge`, { origin: "https://evil.example" }), (e) => e.status === 403);
    const ws = await connect(`ws://127.0.0.1:${b.port}/bridge`);
    ws.json({ id: 1, type: "hello", token: "nope" });
    assert.equal((await ws.closed).code, 4001);
  } finally {
    await b.close();
  }
});

test("host through one helper, join through another, exchange MTM2 packets", async () => {
  const b1 = await helper(1), b2 = await helper(2);
  const p1 = await connect(`ws://127.0.0.1:${b1.port}/bridge`), p2 = await connect(`ws://127.0.0.1:${b2.port}/bridge`);
  try {
    p1.json({ id: 1, type: "hello", token: "t1" });
    p2.json({ id: 1, type: "hello", token: "t2" });
    assert.equal((await result(p1, 1)).protocol, 1);
    await result(p2, 1);

    p1.json({ id: 2, type: "host", name: "Ann's Truckin' Game", playerName: "Ann" });
    const hosted = await result(p1, 2);
    assert.equal(hosted.isHost, true);

    p2.json({ id: 2, type: "enum", ip: "127.0.0.1", timeoutMs: 300 });
    const { sessions } = await result(p2, 2);
    assert.equal(sessions[0].name, "Ann's Truckin' Game");
    p2.json({ id: 3, type: "join", instance: sessions[0].instance, playerName: "Ben" });
    const joined = await result(p2, 3);
    assert.equal(joined.players.length, 2);
    const ben = await p1.next((m) => m.json?.type === "player" && m.json.joined && !m.json.local);
    assert.equal(ben.json.name, "Ben");

    // Ben's truck state to everyone, not guaranteed: [to 0][flags 0][packet].
    const packet = Buffer.alloc(61);
    packet[0] = 0x02;
    p2.send(Buffer.concat([Buffer.from([0, 0, 0, 0, 0]), packet]));
    const got = await p1.next((m) => m.binary);
    assert.equal(got.binary.readUInt32LE(0), joined.playerId);
    assert.equal(got.binary.readUInt32LE(4), hosted.playerId);
    assert.equal(got.binary[8], 0x02);
    assert.equal(got.binary.length, 8 + 61);

    // Ben's page closes: Ann sees him leave.
    p2.close();
    const left = await p1.next((m) => m.json?.type === "player" && !m.json.joined);
    assert.equal(left.json.name, "Ben");
  } finally {
    p1.close();
    await Promise.all([b1.close(), b2.close()]);
  }
});

test("CP3 direct connect through two helpers: host, join by address, packets both ways", async () => {
  const b1 = await helper(3), b2 = await helper(4);
  const p1 = await connect(`ws://127.0.0.1:${b1.port}/bridge`), p2 = await connect(`ws://127.0.0.1:${b2.port}/bridge`);
  const port = 45500 + Math.floor(Math.random() * 400);
  try {
    p1.json({ id: 1, type: "hello", token: "t3" });
    p2.json({ id: 1, type: "hello", token: "t4" });
    await result(p1, 1);
    await result(p2, 1);
    p1.json({ id: 2, type: "host", kind: "cp3", port, playerName: "Host" });
    const hosted = await result(p1, 2);
    assert.deepEqual([hosted.kind, hosted.playerId, hosted.isHost, hosted.hostPlayerId], ["cp3", 1, true, 1]);
    p2.json({ id: 2, type: "join", kind: "cp3", ip: "127.0.0.1", port, playerName: "Ann" });
    const joined = await result(p2, 2);
    assert.deepEqual([joined.playerId, joined.isHost, joined.hostPlayerId], [2, false, 1]);
    assert.equal((await p1.next((m) => m.json?.type === "player" && m.json.joined && !m.json.local)).json.name, "Ann");
    // A chat packet (0x80) from Ann to everyone: [u32 to][u8 flags][packet].
    const packet = Buffer.alloc(96); packet[0] = 0x80;
    p2.send(Buffer.concat([Buffer.from([0, 0, 0, 0, 1]), packet]));
    const got = (await p1.next((m) => !!m.binary)).binary;
    assert.equal(got.readUInt32LE(0), 2, "from Ann");
    assert.equal(got[8], 0x80);
    p2.json({ id: 3, type: "leave" });
    await result(p2, 3);
    assert.equal((await p1.next((m) => m.json?.type === "player" && !m.json.joined)).json.id, 2);
  } finally {
    p1.close(); p2.close();
    await b1.close(); await b2.close();
  }
});

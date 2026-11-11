/*
  Relay rooms (docs/PROTOCOL.md "Relay rooms"): hello.caps, the capability gate, relay frames stamped with
  their sender, to one member or all the others, the byte rate, oversize frames, relay frames ignored in
  ordinary rooms, no server barriers in relay rooms, the truck checksum, and the test room.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoomServer, TEST_ROOM_CODE } from "../rooms/room-server.js";
import { startDaemon } from "../bin/openmtm2d.mjs";
import { loadConfig, parseArgs } from "../lib/config.js";
import { connect } from "./helpers/ws-client.mjs";
import {
  checkClient, encodeRelay, decodeRelay, ROOM_PROTOCOL, CAPS, RELAY_TAG, RELAY_MAX_PAYLOAD, RELAY_MAX_RELIABLE, RELAY_RELIABLE, RELAY_RATE, ERROR,
} from "../protocol/room-messages.js";

const RELAY = [CAPS.CP3_RELAY];

/** A room server with a clock the test moves. */
function server(config = {}) {
  let t = 1_000_000;
  const rooms = createRoomServer({ config: { idleTimeoutS: 0, startDelayMs: 0, ...config }, now: () => t });
  return { rooms, advance: (ms) => { t += ms; } };
}

/** A client on it: `req` answers at once (no message here waits). */
function client(rooms, name, caps) {
  const text = [], bin = [];
  const conn = rooms.connect({ ip: "127.0.0.1", send: (d) => (typeof d === "string" ? text.push(JSON.parse(d)) : bin.push(d)), close() {} });
  let id = 1;
  const c = {
    conn, text, bin,
    req(type, fields = {}) { const rid = id++; conn.text(JSON.stringify({ type, id: rid, ...fields })); return text.find((m) => m.id === rid); },
    seen: (type) => text.filter((m) => m.type === type),
    relays: () => bin.map((b) => decodeRelay(b)).filter(Boolean),
  };
  c.hello = c.req("hello", { protocol: ROOM_PROTOCOL, name, ...(caps ? { caps } : {}) });
  c.id = c.hello.you.id;
  return c;
}

test("hello.caps: up to 16 short names of a-z, 0-9, dot, slash, hyphen", () => {
  assert.deepEqual(checkClient({ type: "hello", protocol: 1, name: "A", caps: ["cp3-relay/1", "x.y"] }).message.caps, ["cp3-relay/1", "x.y"]);
  assert.equal(checkClient({ type: "hello", protocol: 1, name: "A" }).message.caps, undefined, "optional");
  assert.equal(checkClient({ type: "hello", protocol: 1, name: "A", caps: ["CP3"] }).ok, false, "lower case only");
  assert.equal(checkClient({ type: "hello", protocol: 1, name: "A", caps: ["a".repeat(33)] }).ok, false);
  assert.equal(checkClient({ type: "hello", protocol: 1, name: "A", caps: [""] }).ok, false);
  assert.equal(checkClient({ type: "hello", protocol: 1, name: "A", caps: Array(17).fill("a") }).ok, false);
  assert.equal(checkClient({ type: "hello", protocol: 1, name: "A", caps: "cp3-relay/1" }).ok, false, "a list");
  assert.equal(checkClient({ type: "profile", truckCrc: 0xdeadbeef }).message.truckCrc, 0xdeadbeef);
  assert.equal(checkClient({ type: "profile", truckCrc: 2 ** 32 }).ok, false);
});

test("relay frames: encode and decode", () => {
  const f = encodeRelay({ flags: 5, member: 0x1234, payload: new Uint8Array([9, 8, 7]) });
  assert.deepEqual([...f], [RELAY_TAG, 5, 0x34, 0x12, 9, 8, 7]);
  assert.deepEqual({ ...decodeRelay(f), payload: [...decodeRelay(f).payload] }, { flags: 5, member: 0x1234, payload: [9, 8, 7] });
  assert.equal(decodeRelay(new Uint8Array([RELAY_TAG, 0, 0])), null, "shorter than the header");
  assert.equal(decodeRelay(new Uint8Array(4 + RELAY_MAX_PAYLOAD + 1).fill(RELAY_TAG)), null, "too long");
  assert.throws(() => encodeRelay({ payload: new Uint8Array(RELAY_MAX_PAYLOAD + 1) }));
  // A reliable frame (flags bit 0) carries at most 1024 bytes, udpnet's own reliable limit.
  assert.equal(RELAY_MAX_RELIABLE, 1024);
  assert.ok(encodeRelay({ flags: RELAY_RELIABLE, payload: new Uint8Array(RELAY_MAX_RELIABLE) }));
  assert.throws(() => encodeRelay({ flags: RELAY_RELIABLE, payload: new Uint8Array(RELAY_MAX_RELIABLE + 1) }));
  const reliable = new Uint8Array(4 + RELAY_MAX_RELIABLE + 1);
  reliable[0] = RELAY_TAG;
  assert.ok(decodeRelay(reliable), "unreliable at 1025 bytes is fine");
  reliable[1] = RELAY_RELIABLE;
  assert.equal(decodeRelay(reliable), null, "reliable at 1025 bytes is too long");
  assert.deepEqual(RELAY_RATE, { bytesPerSecond: 49152, burst: 65536 });
});

test("a relay room: the creator's capability makes it one, and only clients with it may join", () => {
  const { rooms } = server();
  const cp3 = client(rooms, "Cp3", RELAY);
  assert.ok(cp3.hello.features.includes(CAPS.CP3_RELAY));
  assert.equal(cp3.hello.relay.maxPayload, RELAY_MAX_PAYLOAD);
  assert.equal(cp3.hello.relay.maxReliable, RELAY_MAX_RELIABLE);
  assert.equal(cp3.hello.relay.bytesPerSecond, 49152);
  const { room } = cp3.req("create", { name: "CP4 night" });
  assert.equal(room.relay, true);
  assert.deepEqual(room.members[0].caps, RELAY);
  const om = client(rooms, "Om");
  const refused = om.req("join", { room: room.code });
  assert.equal(refused.code, ERROR.CAPABILITY);
  assert.equal(rooms.list()[0].relay, true, "the room list says so");
  assert.equal(om.req("create", { name: "Nope", relay: true }).code, ERROR.CAPABILITY, "no relay room without the capability");
  // An OpenMTM2 room stays open to everyone, CP3 clients included.
  const plain = om.req("create", { name: "Plain" }).room;
  assert.equal(plain.relay, false);
  const cp3b = client(rooms, "Cp3b", RELAY);
  assert.equal(cp3b.req("join", { room: plain.code }).type, "result");
  // A relay-capable creator may still ask for an ordinary room.
  assert.equal(client(rooms, "Cp3c", RELAY).req("create", { name: "Mixed", relay: false }).room.relay, false);
});

test("relay frames are stamped with the sender, sent to one member or to all the others", () => {
  const { rooms } = server();
  const a = client(rooms, "A", RELAY), b = client(rooms, "B", RELAY), c = client(rooms, "C", RELAY);
  const { room } = a.req("create", { name: "Relay" });
  b.req("join", { room: room.code });
  c.req("join", { room: room.code });

  // Broadcast, in the lobby, with a forged sender id: the server writes A's id over it.
  a.conn.binary(encodeRelay({ flags: 1, member: 0, payload: new Uint8Array([1, 2, 3]) }));
  for (const x of [b, c]) {
    const [f] = x.relays();
    assert.deepEqual([f.flags, f.member, [...f.payload]], [1, a.id, [1, 2, 3]]);
  }
  assert.equal(a.relays().length, 0, "not back to the sender");

  // To one member: only B; the field said B, the frame says A.
  b.bin.length = c.bin.length = 0;
  a.conn.binary(encodeRelay({ member: b.id, payload: new Uint8Array([7]) }));
  assert.deepEqual(b.relays().map((f) => f.member), [a.id]);
  assert.equal(c.relays().length, 0);

  // To someone not in the room, or to oneself: dropped.
  b.bin.length = 0;
  const outsider = client(rooms, "Out", RELAY);
  a.conn.binary(encodeRelay({ member: outsider.id }));
  a.conn.binary(encodeRelay({ member: a.id }));
  assert.equal(outsider.relays().length + a.relays().length + b.relays().length, 0);

  // A frame of the header alone is fine; one past the limit is dropped.
  a.conn.binary(encodeRelay({}));
  assert.equal(b.relays().length, 1);
  const big = new Uint8Array(4 + RELAY_MAX_PAYLOAD + 1);
  big[0] = RELAY_TAG;
  a.conn.binary(big);
  a.conn.binary(new Uint8Array([RELAY_TAG, 0, 0]));
  const bigReliable = new Uint8Array(4 + RELAY_MAX_RELIABLE + 1);
  bigReliable[0] = RELAY_TAG;
  bigReliable[1] = RELAY_RELIABLE;
  a.conn.binary(bigReliable);
  assert.equal(b.bin.length, 1, "oversize, oversize reliable and short frames are dropped");
  assert.equal(rooms.status().relayDropped, 3);
});

test("the relay's byte rate: a burst, then the sustained rate; the rest dropped silently", () => {
  const { rooms, advance } = server({ relayBytesPerSecond: 10000, relayBurst: 20000 });
  const a = client(rooms, "A", RELAY), b = client(rooms, "B", RELAY);
  b.req("join", { room: a.req("create", { name: "Rate" }).room.code });
  const frame = encodeRelay({ payload: new Uint8Array(996) }); // 1000 bytes
  for (let i = 0; i < 25; i++) a.conn.binary(frame);
  assert.equal(b.bin.length, 20, "the burst");
  assert.equal(a.seen("error").length, 0, "no error for it");
  advance(500);
  for (let i = 0; i < 10; i++) a.conn.binary(frame);
  assert.equal(b.bin.length, 25, "half a second of 10000 bytes a second");
});

test("relay frames are ignored in an ordinary room, and state frames keep their rules", () => {
  const { rooms } = server();
  const a = client(rooms, "A", RELAY), b = client(rooms, "B", RELAY);
  b.req("join", { room: a.req("create", { name: "Plain", relay: false }).room.code });
  a.conn.binary(encodeRelay({ payload: new Uint8Array([1]) }));
  assert.equal(b.bin.length, 0);
  assert.equal(rooms.status().relayDropped, 0, "not counted: there is no relay here");
});

test("a relay room runs no barriers: start goes straight to racing, loaded and result do nothing, finish ends it", () => {
  const { rooms } = server();
  const a = client(rooms, "A", RELAY), b = client(rooms, "B", RELAY);
  const { room } = a.req("create", { name: "Relay race" });
  b.req("join", { room: room.code });
  a.req("settings", { track: { sit: "TPARK.SIT", crc: 99 } });
  b.req("profile", { ready: true, truck: "BIGFOOT.TRK", truckCrc: 0x1234abcd });
  assert.equal(b.seen("member").at(-1).member.truckCrc, 0x1234abcd);
  assert.equal(a.req("start", { weather: 0 }).type, "result");
  const [starting] = b.seen("starting");
  assert.equal(starting.race.entrants.find((e) => e.member === b.id).truckCrc, 0x1234abcd);
  assert.equal(rooms.view(room.code).state, "racing", "no loading barrier");
  assert.equal(a.req("loaded").type, "result");
  assert.equal(b.req("result", { laps: 1, total: 1, best: 1 }).type, "result");
  assert.equal(a.req("result", { laps: 1, total: 1, best: 1 }).type, "result");
  assert.equal(a.seen("waiting").length + a.seen("synced").length + a.seen("results").length, 0);
  // The relay carries on during the race.
  a.conn.binary(encodeRelay({ payload: new Uint8Array([4]) }));
  assert.equal(b.relays().length, 1);
  assert.equal(b.req("finish").code, ERROR.NOT_OWNER);
  assert.equal(a.req("finish").type, "result");
  assert.equal(b.seen("room").at(-1).room.state, "lobby");
  assert.equal(b.seen("results").length, 0, "the clients' own results");
  // An ordinary room has no finish.
  const c = client(rooms, "C");
  c.req("create", { name: "Plain" });
  assert.equal(c.req("finish").code, ERROR.STATE);
});

test("a relay room: the owner leaving moves ownership as in any room", () => {
  const { rooms } = server();
  const a = client(rooms, "A", RELAY), b = client(rooms, "B", RELAY), c = client(rooms, "C", RELAY);
  const { room } = a.req("create", { name: "Relay" });
  b.req("join", { room: room.code });
  c.req("join", { room: room.code });
  a.conn.closed();
  assert.equal(b.seen("left").at(-1).member, a.id);
  assert.equal(b.seen("owner").at(-1).member, b.id);
  assert.equal(c.seen("owner").at(-1).member, b.id);
});

test("member ids fit the relay's u16 and wrap past 65535", () => {
  const { rooms } = server({ maxMembers: 70000 });
  let last = null;
  for (let i = 0; i < 65536; i++) {
    const conn = rooms.connect({ send() {}, close() {} });
    if (i < 65535) conn.closed(); else last = conn;
  }
  assert.ok(last.id >= 1 && last.id <= 0xffff);
});

test("the test room: there at start, nobody's, the first to join owns it, it stays when empty, and it echoes", () => {
  const { rooms } = server({ testRoom: "CP4 test", testRoomRelay: true, testRoomEcho: true });
  const listed = rooms.list().find((r) => r.code === TEST_ROOM_CODE);
  assert.deepEqual([listed.name, listed.relay, listed.test, listed.players, listed.owner], ["CP4 test", true, true, 0, ""]);
  const om = client(rooms, "Om");
  assert.equal(om.req("join", { room: TEST_ROOM_CODE }).code, ERROR.CAPABILITY);
  const a = client(rooms, "A", RELAY);
  assert.ok(a.hello.features.includes("testRoom"));
  assert.equal(a.req("join", { room: TEST_ROOM_CODE }).room.owner, a.id);
  // Echo: alone in the room, a client gets its own frames back, stamped with its own id.
  a.conn.binary(encodeRelay({ flags: 2, payload: new Uint8Array([42]) }));
  a.conn.binary(encodeRelay({ member: a.id, payload: new Uint8Array([43]) }));
  assert.deepEqual(a.relays().map((f) => [f.member, f.flags, f.payload[0]]), [[a.id, 2, 42], [a.id, 0, 43]]);
  a.req("leave");
  const after = rooms.list().find((r) => r.code === TEST_ROOM_CODE);
  assert.deepEqual([after.players, after.owner], [0, ""], "still there, nobody's");
  assert.equal(rooms.closeRoom(TEST_ROOM_CODE), true);
  assert.ok(rooms.list().some((r) => r.code === TEST_ROOM_CODE), "an admin close empties it, and it stays");
});

test("--test-room on the command line, and the daemon makes the room at start", async () => {
  assert.deepEqual(parseArgs(["--test-room"]).overrides, { testRoom: "Test room" });
  assert.deepEqual(parseArgs(["--test-room", "CP4", "--test-room-relay", "--test-room-echo"]).overrides, { testRoom: "CP4", testRoomRelay: true, testRoomEcho: true });
  assert.deepEqual(parseArgs(["--test-room", "--port", "1"]).overrides, { testRoom: "Test room", port: "1" });
  const dir = mkdtempSync(join(tmpdir(), "openmtm2d-"));
  const quiet = Object.assign(() => {}, { setLevel() {}, setFormat() {} });
  let d = null;
  for (let port = 48500 + Math.floor(Math.random() * 400); !d; port++) {
    try {
      d = await startDaemon({ load: () => loadConfig({ env: {}, overrides: { host: "127.0.0.1", port, stateDir: dir, testRoom: "Bench", testRoomRelay: true } }), log: quiet });
    } catch (err) { if (err.code !== "EADDRINUSE") throw err; }
  }
  try {
    const listed = await (await fetch(`http://127.0.0.1:${d.port}/rooms`)).json();
    assert.deepEqual(listed.rooms.map((r) => [r.code, r.name, r.relay]), [[TEST_ROOM_CODE, "Bench", true]]);
    // Over a real socket: two clients relay through the test room.
    const ws = [await connect(`ws://127.0.0.1:${d.port}/play`, { origin: null }), await connect(`ws://127.0.0.1:${d.port}/play`, { origin: null })];
    const ids = [];
    for (const [i, w] of ws.entries()) {
      w.json({ type: "hello", id: 1, protocol: ROOM_PROTOCOL, name: `P${i}`, caps: RELAY });
      ids.push((await w.next((m) => m.json?.id === 1)).json.you.id);
      w.json({ type: "join", id: 2, room: TEST_ROOM_CODE });
      await w.next((m) => m.json?.id === 2);
    }
    ws[0].send(encodeRelay({ member: 0xffff, payload: new Uint8Array([1, 2]) }));
    ws[0].send(encodeRelay({ member: 0, payload: new Uint8Array([3, 4]) }));
    const got = decodeRelay(new Uint8Array((await ws[1].next((m) => !!m.binary)).binary));
    assert.deepEqual([got.member, [...got.payload]], [ids[0], [3, 4]], "the frame for nobody is dropped; the broadcast is stamped");
    for (const w of ws) w.close();
  } finally {
    await d.stop({ drainS: 0 });
    rmSync(dir, { recursive: true, force: true });
  }
});

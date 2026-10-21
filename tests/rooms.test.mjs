/*
  The room server over real WebSockets (in this process): rooms, lobby, the race barriers, relay
  and results, ownership, limits.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "./helpers/ws-client.mjs";
import { startDaemon } from "../bin/openmtm2d.mjs";
import { loadConfig } from "../lib/config.js";
import { encodeState, decodeState, ROOM_PROTOCOL } from "../protocol/room-messages.js";

const quiet = Object.assign(() => {}, { setLevel() {}, setFormat() {} });

async function daemon(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "openmtm2d-"));
  const d = await startDaemon({ load: () => loadConfig({ env: {}, overrides: { host: "127.0.0.1", port: 0, stateDir: dir, ...overrides } }), log: quiet });
  return { ...d, dir, done: async () => { await d.stop({ drainS: 0 }); rmSync(dir, { recursive: true, force: true }); } };
}

let nextPort = 47900 + Math.floor(Math.random() * 500);
async function server(overrides = {}) {
  for (;;) {
    try { return await daemon({ port: nextPort++, ...overrides }); } catch (err) { if (err.code !== "EADDRINUSE") throw err; }
  }
}

async function player(d, name, origin = "http://localhost:8080") {
  const ws = await connect(`ws://127.0.0.1:${d.port}/play`, { origin });
  let id = 1;
  const c = {
    ws,
    req(type, fields = {}) {
      const rid = id++;
      ws.json({ type, id: rid, ...fields });
      return ws.next((m) => m.json?.id === rid).then((m) => m.json);
    },
    next: (type, ms) => ws.next((m) => m.json?.type === type, ms).then((m) => m.json),
    nextBinary: (ms) => ws.next((m) => !!m.binary, ms).then((m) => m.binary),
  };
  c.hello = await c.req("hello", { protocol: ROOM_PROTOCOL, name, client: "test" });
  return c;
}

test("hello, create, list, join by code, chat, kick", async () => {
  const d = await server();
  try {
    const ann = await player(d, "Ann");
    assert.equal(ann.hello.type, "result");
    assert.equal(typeof ann.hello.you.id, "number");
    const created = await ann.req("create", { name: "Mud Pit", maxPlayers: 4 });
    const code = created.room.code;
    assert.match(code, /^[A-Z2-9]{6}$/);
    assert.equal(created.room.owner, ann.hello.you.id);

    const ben = await player(d, "Ann");
    const listed = await ben.req("list");
    assert.equal(listed.rooms.length, 1);
    assert.equal(listed.rooms[0].name, "Mud Pit");
    const joined = await ben.req("join", { room: code.toLowerCase() });
    assert.equal(joined.type, "result");
    assert.deepEqual(joined.room.members.map((m) => m.name), ["Ann", "Ann (2)"], "names are made unique in a room");
    const seen = await ann.next("member");
    assert.equal(seen.member.name, "Ann (2)");

    await ben.req("chat", { text: "hello" });
    const heard = await ann.next("chat");
    assert.deepEqual([heard.name, heard.text, heard.private], ["Ann (2)", "hello", false]);
    await ann.req("chat", { text: "psst", to: ben.hello.you.id });
    assert.equal((await ben.next("chat")).private, true);

    const notOwner = await ben.req("kick", { member: ann.hello.you.id });
    assert.equal(notOwner.code, "not-owner");
    await ann.req("kick", { member: ben.hello.you.id });
    assert.equal((await ben.next("kicked")).reason, "removed");
    assert.equal((await ann.next("left")).reason, "removed");

    // Joining a full room, a locked room, a missing room.
    const locked = await ann.req("create", { name: "Private", password: "x", maxPlayers: 2 });
    assert.equal((await ben.req("join", { room: locked.room.code })).code, "password");
    assert.equal((await ben.req("join", { room: "ZZZZZZ" })).code, "not-found");
    ann.ws.close();
    ben.ws.close();
  } finally {
    await d.done();
  }
});

test("a race: start needs everyone ready, loading barrier, relay, results, back to the lobby", async () => {
  const d = await server({ startDelayMs: 0 });
  try {
    const ann = await player(d, "Ann");
    const { room } = await ann.req("create", { name: "Race" });
    const ben = await player(d, "Ben");
    await ben.req("join", { room: room.code });
    await ann.req("settings", { track: { sit: "TPARK.SIT", name: "Farm Road 29", crc: 99 }, laps: 2, computers: 1 });
    assert.equal((await ben.next("room")).room.settings.track.sit, "TPARK.SIT");
    await ann.req("profile", { truck: "BIGFOOT.TRK", ready: true });
    const early = await ann.req("start", { weather: 2 });
    assert.equal(early.code, "state", "Ben is not ready");
    await ben.req("profile", { truck: "GRAVE.TRK", ready: true });
    assert.equal((await ann.req("start", { weather: 2, computers: [{ name: "Bot", truck: "BIGFOOT.TRK" }] })).type, "result");
    const [sa, sb] = await Promise.all([ann.next("starting"), ben.next("starting")]);
    assert.deepEqual(sa.race, sb.race, "everyone gets the same seating");
    assert.equal(sa.race.entrants.length, 3);
    assert.deepEqual(sa.race.entrants.map((e) => e.vehicle), [1, 2, 3]);
    const bot = sa.race.entrants.find((e) => e.computer);
    assert.equal(bot.owner, ann.hello.you.id);
    const annV = sa.race.entrants.find((e) => e.member === ann.hello.you.id).vehicle;
    const benV = sa.race.entrants.find((e) => e.member === ben.hello.you.id).vehicle;

    // Joining a racing room is refused.
    const cy = await player(d, "Cy");
    assert.equal((await cy.req("join", { room: room.code })).code, "state");

    await ann.req("loaded");
    assert.deepEqual((await ann.next("waiting")).left, ["Ben"]);
    await ben.req("loaded");
    const [ga] = await Promise.all([ann.next("synced"), ben.next("synced")]);
    assert.ok(ga.startAt >= ga.serverTime);

    // Truck state: our own and the owner's computer truck are relayed; someone else's vehicle is not.
    ann.ws.send(encodeState({ vehicle: annV, seq: 1, pos: [1, 2, 3] }));
    ann.ws.send(encodeState({ vehicle: bot.vehicle, seq: 1, pos: [4, 5, 6] }));
    ben.ws.send(encodeState({ vehicle: annV, seq: 9, pos: [9, 9, 9] }));
    const got = [decodeState(new Uint8Array(await ben.nextBinary())), decodeState(new Uint8Array(await ben.nextBinary()))];
    assert.deepEqual(got.map((s) => s.vehicle).sort(), [annV, bot.vehicle].sort());
    await assert.rejects(ann.nextBinary(300), "Ben's forged frame is dropped");

    // Events: relayed with the sender; a forged vehicle is dropped.
    ann.ws.json({ type: "race", e: { kind: "horn", vehicle: annV } });
    ben.ws.json({ type: "race", e: { kind: "horn", vehicle: annV } });
    const horn = await ben.next("race");
    assert.deepEqual([horn.from, horn.e.kind, horn.e.vehicle], [ann.hello.you.id, "horn", annV]);
    await assert.rejects(ann.next("race", 300));

    // Results: once both report, everyone gets them and the room is back in the lobby.
    await ann.req("result", { laps: 2, total: 120.5, best: 59 });
    await ben.req("result", { laps: 2, total: 130, best: 61 });
    const [ra] = await Promise.all([ann.next("results"), ben.next("results")]);
    assert.equal(ra.results[benV].total, 130);
    assert.equal(ra.results[annV].total, 120.5);
    const back = await ann.next("room");
    assert.equal(back.room.state, "lobby");
    assert.equal(back.room.members.every((m) => !m.ready), true);
    for (const c of [ann, ben, cy]) c.ws.close();
  } finally {
    await d.done();
  }
});

test("the owner leaving mid-race: their trucks go, ownership moves, the race goes on", async () => {
  const d = await server({ startDelayMs: 0 });
  try {
    const ann = await player(d, "Ann");
    const { room } = await ann.req("create", { name: "Race" });
    const ben = await player(d, "Ben");
    const cy = await player(d, "Cy");
    await ben.req("join", { room: room.code });
    await cy.req("join", { room: room.code });
    await ann.req("settings", { track: { sit: "TPARK.SIT", crc: 1 }, computers: 1 });
    await ben.req("profile", { ready: true });
    await cy.req("profile", { ready: true });
    await ann.req("start", { weather: 0, computers: [{ name: "Bot", truck: "X.TRK" }] });
    const { race } = await ben.next("starting");
    for (const c of [ann, ben, cy]) await c.req("loaded");
    await ben.next("synced");
    ann.ws.close();
    const gone = [(await ben.next("race")).e, (await ben.next("race")).e];
    const annV = race.entrants.find((e) => e.member === ann.hello.you.id).vehicle;
    const botV = race.entrants.find((e) => e.computer).vehicle;
    assert.deepEqual(gone.map((e) => e.kind), ["gone", "gone"]);
    assert.deepEqual(gone.map((e) => e.vehicle).sort(), [annV, botV].sort());
    assert.equal((await ben.next("owner")).member, ben.hello.you.id);
    await ben.req("result", { laps: 1, total: 1, best: 1 });
    await cy.req("result", { laps: 1, total: 2, best: 2 });
    assert.equal(Object.keys((await cy.next("results")).results).length, 2);
    ben.ws.close();
    cy.ws.close();
  } finally {
    await d.done();
  }
});

test("origins, the protocol version, hello first, and per-address limits", async () => {
  const d = await server({ maxConnectionsPerIp: 2 });
  try {
    await assert.rejects(connect(`ws://127.0.0.1:${d.port}/play`, { origin: "https://evil.example" }), /403/);
    const native = await connect(`ws://127.0.0.1:${d.port}/play`, { origin: null });
    native.json({ type: "list", id: 1 });
    assert.equal((await native.next((m) => m.json?.id === 1)).json.code, "hello-first");
    native.json({ type: "hello", id: 2, protocol: 99, name: "Old" });
    assert.equal((await native.next((m) => m.json?.id === 2)).json.code, "protocol");
    assert.equal((await native.closed).code, 4000);
    const a = await connect(`ws://127.0.0.1:${d.port}/play`);
    const b = await connect(`ws://127.0.0.1:${d.port}/play`);
    await assert.rejects(connect(`ws://127.0.0.1:${d.port}/play`), /429/);
    a.close();
    b.close();
  } finally {
    await d.done();
  }
});

test("a ban drops the address and refuses it again", async () => {
  const d = await server({ adminToken: "s3cret" });
  try {
    const ann = await player(d, "Ann");
    const base = `http://127.0.0.1:${d.port}`;
    assert.equal((await fetch(`${base}/admin/bans`)).status, 401);
    const res = await fetch(`${base}/admin/bans`, { method: "POST", headers: { authorization: "Bearer s3cret" }, body: JSON.stringify({ ip: "127.0.0.1", minutes: 5 }) });
    assert.equal((await res.json()).dropped, 1);
    assert.equal((await ann.ws.closed).code, 4003);
    await assert.rejects(connect(`ws://127.0.0.1:${d.port}/play`), /403/);
    const lifted = await fetch(`${base}/admin/bans/127.0.0.1`, { method: "DELETE", headers: { authorization: "Bearer s3cret" } });
    assert.equal(lifted.status, 200);
    (await connect(`ws://127.0.0.1:${d.port}/play`)).close();
    const status = await (await fetch(`${base}/status`)).json();
    assert.equal(status.protocol, ROOM_PROTOCOL);
  } finally {
    await d.done();
  }
});

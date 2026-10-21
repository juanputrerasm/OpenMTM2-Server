/*
  The DirectPlay gateway: an OpenMTM2 player in a classic room (WebSocket) and a stand-in for the
  retail game (a DirectPlay node speaking MTM2's packets) find each other, chat, race and get the
  results, all on this machine with the enumeration port moved off 47624.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "./helpers/ws-client.mjs";
import { startDaemon } from "../bin/openmtm2d.mjs";
import { loadConfig } from "../lib/config.js";
import { createDirectPlay } from "../dplay/provider.js";
import { MTM2_APPLICATION, encodePacket, decodePacket, BARRIER, GUARANTEED, TYPES, stateFields } from "../protocol/mtm2-packets.js";
import { ROOM_PROTOCOL, encodeState, decodeState } from "../protocol/room-messages.js";

const quiet = Object.assign(() => {}, { setLevel() {}, setFormat() {} });
const until = (fn, ms = 4000) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const check = () => { const v = fn(); if (v) resolve(v); else if (Date.now() - t0 > ms) reject(new Error("timed out")); else setTimeout(check, 10); };
  check();
});

/** A retail machine, as far as the gateway can tell: a DirectPlay node that sends and reads MTM2 packets. */
function retail(enumPort) {
  const dp = createDirectPlay({ application: MTM2_APPLICATION, bind: "127.0.0.1", enumPort, tcpPorts: [43010, 43019], udpPorts: [43020, 43029] });
  const got = [];
  dp.on("message", ({ from, to, payload }) => got.push({ from, to, ...decodePacket(payload) }));
  const me = () => dp.self().playerId;
  return {
    dp, got,
    send(kind, fields = {}, to = 0) { dp.send(to, encodePacket(kind, fields, me()), { guaranteed: GUARANTEED.has(TYPES[kind]) }); },
    find: (kind, test = () => true) => got.find((p) => p.kind === kind && test(p)),
    wait: (kind, test) => until(() => got.find((p) => p.kind === kind && (!test || test(p)))),
    me,
  };
}

test("a classic room: a retail player and an OpenMTM2 player race together", { timeout: 30000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "openmtm2d-gw-"));
  const enumPort = 47800 + Math.floor(Math.random() * 100);
  const port = 48800 + Math.floor(Math.random() * 100);
  const d = await startDaemon({
    load: () => loadConfig({ env: {}, overrides: {
      host: "127.0.0.1", port, stateDir: dir, startDelayMs: 0, gateway: true, gatewayBind: "127.0.0.1",
      gatewayEnumPort: enumPort, gatewayTcpPorts: "43000-43009", gatewayUdpPorts: "43030-43039",
    } }),
    log: quiet,
  });
  const rex = retail(enumPort);
  let ann;
  try {
    // Ann makes a room open to classic players.
    const ws = await connect(`ws://127.0.0.1:${port}/play`);
    let id = 1;
    const req = (type, fields = {}) => { const rid = id++; ws.json({ type, id: rid, ...fields }); return ws.next((m) => m.json?.id === rid).then((m) => m.json); };
    const next = (type, test = () => true) => ws.next((m) => m.json?.type === type && test(m.json)).then((m) => m.json);
    ann = ws;
    const hello = await req("hello", { protocol: ROOM_PROTOCOL, name: "Ann" });
    assert.deepEqual(hello.features, ["classic"]);
    const made = await req("create", { name: "Classic night", classic: true, maxPlayers: 12 });
    assert.equal(made.room.classic, true);
    assert.equal(made.room.maxPlayers, 8, "the game's limit");
    assert.equal((await req("create", { name: "Another", classic: true })).code, "limit", "one classic room per server");
    await req("profile", { truck: "BIGFOOT.TRK", skill: 2 });
    await req("settings", { track: { sit: "TPARK.SIT", name: "Farm Road 29", crc: 0x1234 }, laps: 2, weather: 1, computers: 3 });
    assert.equal((await next("room")).room.settings.computers, 0, "no computer players in a classic room");

    // Rex finds it by the server's address and joins, as the game does.
    const found = await rex.dp.enumerate("127.0.0.1", { timeoutMs: 300 });
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "Classic night");
    await rex.dp.join(found[0], { playerName: "Rex" });
    const rexMember = (await next("member", (m) => m.member.name === "Rex")).member;
    assert.equal(rexMember.classic, true);
    assert.equal(rexMember.client, "MTM2 (classic)");

    // Rex is greeted: Ann's info from her DirectPlay player, and the host's settings.
    const annInfo = await rex.wait("info");
    const annV = annInfo.sender;
    assert.equal(annInfo.truck, "BIGFOOT.TRK");
    assert.equal(annInfo.skill, 2);
    assert.equal((await rex.wait("track")).sit, "TPARK.SIT");
    assert.equal((await rex.wait("laps")).laps, 2);
    assert.equal((await rex.wait("weather")).weather, 1);
    assert.equal((await rex.wait("checksum")).crc, 0x1234);
    assert.deepEqual(rex.dp.players().map((p) => p.name).sort(), ["Ann", "Rex"]);

    // Rex's lobby packets become his profile; broadcast copies count once.
    rex.send("info", { truck: "GRAVE.TRK", status: 0, version: 0x0201, location: 5, skill: 1, setup: [1, 1, 600, 1, 0], team: 0 });
    rex.send("checksum", { sit: "TPARK.SIT", name: "Farm Road 29", crc: 0x1234 });
    rex.send("ready", { ready: 1 });
    const ready = await next("member", (m) => m.member.name === "Rex" && m.member.ready);
    assert.equal(ready.member.truck, "GRAVE.TRK");
    assert.deepEqual(ready.member.content, { sit: "TPARK.SIT", crc: 0x1234 });

    // Chat both ways, and privately.
    rex.send("chat", { flag: 0, private: 0, text: "howdy" });
    assert.equal((await next("chat")).text, "howdy");
    await req("chat", { text: "hi Rex" });
    assert.equal((await rex.wait("chat", (p) => p.text === "hi Rex")).sender, annV);
    await req("chat", { text: "psst", to: rexMember.id });
    assert.equal((await rex.wait("chat", (p) => p.text === "psst")).private, 1);
    rex.send("chat", { flag: 0, private: 1, text: "back at you" }, annV);
    const priv = await next("chat", (m) => m.text === "back at you");
    assert.equal(priv.private, true);

    // A change of hers reaches him as the game's packet.
    await req("profile", { ready: false, location: 4 });
    assert.equal((await rex.wait("location", (p) => p.sender === annV)).location, 4);

    // The start: slots for both, then 0x14 from the host.
    await req("start", { weather: 1 });
    const starting = await next("starting");
    const annVehicle = starting.race.entrants.find((e) => e.name === "Ann").vehicle;
    const rexVehicle = starting.race.entrants.find((e) => e.name === "Rex").vehicle;
    await rex.wait("start");
    // 0x8a and 0x87 go as the game sends them, not guaranteed (UDP), so they may come after 0x14.
    await rex.wait("listState");
    await until(() => rex.got.filter((p) => p.kind === "slot").length >= 2);
    const slots = [...new Map(rex.got.filter((p) => p.kind === "slot").map((s) => [s.dpid, s])).values()];
    assert.ok(rex.got.findIndex((p) => p.kind === "start") > rex.got.findIndex((p) => p.kind === "slot"), "the slots come first");
    assert.deepEqual(slots.map((s) => [s.dpid, s.slot]).sort((a, b) => a[1] - b[1]),
      [[annV, annVehicle], [rex.me(), rexVehicle]].sort((a, b) => a[1] - b[1]));

    // Loading: Rex's sync barrier stands for "loaded"; once Ann loads too, Rex gets hers.
    rex.send("barrier", { code: BARRIER.SYNC });
    assert.deepEqual((await next("waiting")).left, ["Ann"]);
    await req("loaded");
    await next("synced");
    await rex.wait("barrier", (p) => p.sender === annV && p.code === BARRIER.SYNC);

    // Start positions and trucks both ways.
    ws.json({ type: "race", e: { kind: "positions", positions: [null, [1, 2, 3], [4, 5, 6]] } });
    assert.deepEqual((await rex.wait("positions")).positions[1], [1, 2, 3]);
    ws.send(encodeState({ vehicle: annVehicle, seq: 1, pos: [10, 20, 30], euler: [0, 0, 1], throttle: 1, gear: 4 }));
    const st = await rex.wait("state");
    assert.equal(st.vehicle, annVehicle);
    assert.deepEqual(st.pos, [10, 20, 30]);
    rex.send("state", { ...stateFields({ pos: [7, 8, 9], bvel: [0, 0, 5], euler: [0, 0, 0], steer: 0, throttle: 0.5, brakeRear: 0, gear: 4, autoShift: true }), vehicle: rexVehicle });
    const frame = decodeState(new Uint8Array((await ws.next((m) => !!m.binary)).binary));
    assert.equal(frame.vehicle, rexVehicle);
    assert.deepEqual(frame.pos, [7, 8, 9]);
    rex.send("horn", { truck: rexVehicle });
    assert.deepEqual((await next("race")).e, { kind: "horn", vehicle: rexVehicle });

    // Results: Rex's 0x18 and Ann's result; Rex gets hers as 0x18, then the host's 0x0e.
    rex.send("result", { code: BARRIER.RESULTS, lapsLed: 2, laps: 2, total: 95.5, best: 47 });
    await req("result", { laps: 2, total: 99, best: 49 });
    const res = await next("results");
    assert.equal(res.results[rexVehicle].total, 95.5);
    const hers = await rex.wait("result", (p) => p.sender === annV);
    assert.equal(hers.total, 99);
    await rex.wait("exit");

    // Ann leaves: nobody can own the room, so it closes, and so does the DirectPlay session.
    ws.close();
    await until(() => d.gateway.sessions === 0);
    await until(() => rex.dp.players().length <= 1);
  } finally {
    await rex.dp.stop();
    await d.stop({ drainS: 0 });
    rmSync(dir, { recursive: true, force: true });
  }
});

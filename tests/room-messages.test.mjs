import test from "node:test";
import assert from "node:assert/strict";
import {
  checkClient, checkRaceEvent, encodeState, decodeState, STATE_SIZE, seqNewer, roomCode, isRoomCode, ERROR, LIMITS,
} from "../protocol/room-messages.js";

test("a client's messages are checked and trimmed to their fields", () => {
  const ok = checkClient({ type: "create", id: 3, name: "  Mud Pit  ", maxPlayers: 6, extra: "dropped" });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.message, { type: "create", id: 3, name: "Mud Pit", maxPlayers: 6 });
  assert.equal(checkClient({ type: "create", name: "" }).ok, false);
  assert.equal(checkClient({ type: "create", name: "x", maxPlayers: 40 }).ok, false);
  assert.equal(checkClient({ type: "nope" }).code, ERROR.BAD_REQUEST);
  assert.equal(checkClient({ type: "__proto__" }).ok, false);
  assert.equal(checkClient([]).ok, false);
  assert.equal(checkClient({ type: "chat", text: "hi\u0000there" }).message.text, "hithere");
  const settings = checkClient({ type: "settings", track: { sit: "TPARK.SIT", name: "Farm Road 29", crc: 0x1234 }, laps: 5 });
  assert.deepEqual(settings.message.track, { sit: "TPARK.SIT", name: "Farm Road 29", crc: 0x1234 });
  assert.equal(checkClient({ type: "settings", track: null }).ok, true, "null clears the track");
});

test("race events: only the known kinds, with their fields", () => {
  assert.equal(checkRaceEvent({ kind: "split", vehicle: 2, next: 3, split: 12.5 }).ok, true);
  assert.equal(checkRaceEvent({ kind: "split", vehicle: 0, next: 3, split: 12.5 }).ok, false);
  assert.equal(checkRaceEvent({ kind: "teleport", vehicle: 1 }).ok, false);
  const p = checkRaceEvent({ kind: "positions", positions: [null, [1, 2, 3], [4, 5, 6]] });
  assert.equal(p.ok, true);
  assert.equal(checkRaceEvent({ kind: "positions", positions: [[1, 2]] }).ok, false);
  assert.equal(checkClient({ type: "race", e: { kind: "horn", vehicle: 3 } }).ok, true);
  const mode = checkClient({ type: "race", e: { kind: "mode", data: { it: 2, points: { 1: 100, 2: 98 } } } });
  assert.deepEqual(mode.message.e.data, { it: 2, points: { 1: 100, 2: 98 } }, "a mode's state is kept whole");
  assert.equal(checkClient({ type: "race", e: { kind: "mode", data: [1] } }).ok, false);
  assert.equal(checkClient({ type: "race", e: { kind: "modeTruck", vehicle: 2, data: { trucks: { 2: { hp: 900 } } } } }).ok, true);
  assert.equal(checkClient({ type: "race", e: { kind: "modeTruck", data: {} } }).ok, false, "a modeTruck names its vehicle");
  assert.equal(checkClient({ type: "race", e: { kind: "wheels", vehicle: 3, lost: 5, axles: 1, wear: [1, 0.5, 0, 0.25], repairs: 2, pits: 1 } }).ok, true);
  assert.equal(checkClient({ type: "race", e: { kind: "wheels", vehicle: 3, lost: 16, axles: 0 } }).ok, false, "four wheels, four bits");
  assert.equal(checkClient({ type: "race", e: { kind: "wheels", vehicle: 3, lost: 1, axles: 0, wear: [2, 0, 0, 0] } }).ok, false, "wear is a share");
  assert.equal(checkClient({ type: "settings", wheels: true, wheelsRepairS: 12 }).ok, true);
  const rules = checkClient({ type: "settings", rules: { physics: "evo2", aiBehaviour: "omtm2", "ext.combat.names": false, aiSpeed: 1.2 } });
  assert.equal(rules.ok, true);
  assert.deepEqual(rules.message.rules, { physics: "evo2", aiBehaviour: "omtm2", "ext.combat.names": false, aiSpeed: 1.2 }, "the host's rules are kept whole");
  assert.equal(checkClient({ type: "settings", rules: { nested: { a: 1 } } }).ok, false, "rules are flat");
  assert.equal(checkClient({ type: "settings", rules: { "bad key": 1 } }).ok, false);
  assert.equal(checkClient({ type: "settings", rules: { "ext.race-rumble.laps": 3, "ext.cops-robbers.minutes": 5 } }).ok, true, "an extension id may have hyphens");
  assert.equal(checkClient({ type: "settings", rules: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, "x".repeat(20)])) }).ok, false, "bounded");
});

test("OpenMTM2's Deathmatch fits: the mode, its host rules, and a full room's modeTruck within one text frame", () => {
  assert.equal(checkClient({ type: "settings", mode: "deathmatch" }).ok, true);
  const rules = {
    "ext.deathmatch.minutes": 5, "ext.deathmatch.toughness": "normal", "ext.deathmatch.respawn": true, "ext.deathmatch.repairs": false,
    "ext.deathmatch.cpuRepairs": true, "ext.deathmatch.helicopter": false, "ext.deathmatch.names": true, "ext.deathmatch.aggression": "high",
  };
  assert.equal(checkClient({ type: "settings", rules }).ok, true);
  // The owner judging eight trucks (its own and seven computer ones), each as OpenMTM2 0.7.0 sends it, and owing all of them.
  const truck = (v) => ({
    g: 0.123456789012345, e: 0.987654321098765, b: 0.5555555555555556, w: [0.1111111111111111, 0.2222222222222222, 0.3333333333333333, 1],
    l: [false, true, false, false], cr: 12345, d: 6789, wk: 12, rp: 3, wr: false, q: false, by: v % 8 + 1, sw: 2, dt: 9, rs: 9,
  });
  const data = { trucks: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i + 1, truck(i + 1)])), owed: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [i + 1, { hp: 123456.789, wrecks: 40 }])) };
  const frame = JSON.stringify({ type: "race", e: { kind: "modeTruck", vehicle: 1, data } });
  assert.ok(frame.length < LIMITS.textFrame / 2, `${frame.length} bytes`);
  const checked = checkClient(JSON.parse(frame));
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.message.e.data, data, "kept whole");
  assert.equal(checkClient({ type: "race", e: { kind: "mode", data: { over: false, winner: 0, rules: { toughness: "tough", respawn: true, repairs: false, helicopter: false } } } }).ok, true);
});

test("truck state round-trips through its 68 bytes", () => {
  const s = {
    vehicle: 3, seq: 65535, time: 123456789, pos: [100.5, -2.25, 3000], bvel: [0, 1, 55.5], euler: [0.1, -0.2, 3.0],
    steer: -0.3, throttle: 1, brakeRear: 0.5, brakeFront: 0, gear: -1, autoShift: true, score: 42,
  };
  const bytes = encodeState(s);
  assert.equal(bytes.length, STATE_SIZE);
  assert.equal(bytes[0], 1);
  const back = decodeState(bytes);
  assert.equal(back.vehicle, 3);
  assert.equal(back.seq, 65535);
  assert.equal(back.gear, -1);
  assert.equal(back.autoShift, true);
  for (const k of ["pos", "bvel", "euler"]) back[k].forEach((v, i) => assert.ok(Math.abs(v - s[k][i]) < 1e-4));
  assert.equal(decodeState(bytes.subarray(1)), null);
  const bad = encodeState({ ...s, pos: [NaN, 0, 0] });
  assert.equal(decodeState(bad), null, "non-finite numbers are refused");
});

test("sequence numbers wrap; room codes avoid look-alikes", () => {
  assert.equal(seqNewer(1, 65535), true);
  assert.equal(seqNewer(65535, 1), false);
  assert.equal(seqNewer(5, 5), false);
  const code = roomCode(() => 0.5);
  assert.equal(isRoomCode(code), true);
  assert.equal(isRoomCode("ABCDE0"), false, "0 is not in the alphabet");
});

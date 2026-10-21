import test from "node:test";
import assert from "node:assert/strict";
import {
  checkClient, checkRaceEvent, encodeState, decodeState, STATE_SIZE, seqNewer, roomCode, isRoomCode, ERROR,
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

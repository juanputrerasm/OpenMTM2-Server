/*
  Community Patch 3 and 4 packet profiles (OpenMTM2 docs/CP4_EXE_ANALYSIS.md section 9).
*/
import test from "node:test";
import assert from "node:assert/strict";
import {
  encodePacket, decodePacket, packetSize, PROFILES, profileForVersion, knownVersion, MTM2_NET_VERSION, CP3_NET_VERSION, CP4_NET_VERSION,
  CP_TICK_S, stateFields, stateFromPacket, TYPES,
} from "../protocol/mtm2-packets.js";

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const f32 = (x) => Math.fround(x);

test("the version in 0x03 picks the profile", () => {
  assert.equal(CP3_NET_VERSION, 0x3400);
  assert.equal(CP4_NET_VERSION, 0x3402);
  assert.equal(profileForVersion(MTM2_NET_VERSION), PROFILES.retail);
  assert.equal(profileForVersion(0x3400), PROFILES.cp3);
  assert.equal(profileForVersion(0x3402), PROFILES.cp4);
  assert.equal(profileForVersion(0x0204), PROFILES.retail, "anything else is retail's layout");
  assert.equal(profileForVersion(undefined), PROFILES.retail);
  // A patch build names its own layouts; one we have no profile for is unknown, not retail.
  for (const v of [MTM2_NET_VERSION, 0x0204, CP3_NET_VERSION, CP4_NET_VERSION]) assert.equal(knownVersion(v), true, v.toString(16));
  for (const v of [0x3401, 0x3403, 0x3500, undefined]) assert.equal(knownVersion(v), false, String(v));
  // 0x03 is the same in every profile, so it can be read before the profile is known.
  for (const name of ["retail", "cp3", "cp4"]) assert.equal(packetSize(0x03, name), 92);
  const info = encodePacket("info", { truck: "Bigfoot", version: CP4_NET_VERSION }, 1, "cp4");
  assert.equal(new DataView(info.buffer).getUint16(0x3a, true), 0x3402);
  assert.equal(decodePacket(info).version, 0x3402);
});

test("sizes by profile", () => {
  const sizes = {
    retail: { 0x02: 61, 0x14: 36, 0x25: 116, 0x26: null, 0x27: null, 0x28: null, 0x29: null },
    cp3: { 0x02: 65, 0x14: 36, 0x25: 116, 0x26: 24, 0x27: 44, 0x28: null, 0x29: null },
    cp4: { 0x02: 116, 0x14: 40, 0x25: 116, 0x26: 24, 0x27: 44, 0x28: 16, 0x29: 16 },
  };
  for (const [name, table] of Object.entries(sizes)) {
    for (const [type, size] of Object.entries(table)) assert.equal(packetSize(Number(type), name), size, `${name} 0x${Number(type).toString(16)}`);
    // All other packets keep their retail sizes.
    for (const t of [0x01, 0x03, 0x0b, 0x12, 0x15, 0x17, 0x18, 0x80, 0x81, 0x8a]) assert.equal(packetSize(t, name), packetSize(t));
  }
  assert.throws(() => encodePacket("progress", {}, 1), /retail/);
  assert.throws(() => encodePacket("raceLoaded", {}, 1, "cp3"), /cp3/);
});

test("CP3 0x02 (65 bytes): retail order, radians, the sender tick at +0x3D", () => {
  const s = { pos: [1, 2, 3], bvel: [4, 5, 6], euler: [0.5, -1.25, 3.0], steer: -0.3, throttle: 1, brakeRear: 0.5, gear: 4, autoShift: true, vehicle: 3, score: 42.5, tick: 123456 };
  const b = encodePacket("state", stateFields(s, "cp3"), 2, "cp3");
  assert.equal(b.length, 65);
  const v = new DataView(b.buffer);
  assert.equal(v.getFloat32(0x24, true), f32(0.5), "theta as f32 radians");
  assert.equal(v.getFloat32(0x2c, true), f32(3.0));
  assert.equal(v.getFloat32(0x30, true), f32(-0.3), "steering as f32 radians");
  assert.deepEqual([...b.slice(0x34, 0x39)], [255, 127, 4, 1, 3]);
  assert.equal(v.getFloat32(0x39, true), 42.5);
  assert.equal(v.getUint32(0x3d, true), 123456);
  const p = decodePacket(b, "cp3");
  assert.equal(p.kind, "state");
  assert.equal(p.tick, 123456);
  const back = stateFromPacket(p, "cp3");
  assert.deepEqual(back.pos, [1, 2, 3]);
  assert.ok(near(back.euler[0], 0.5) && near(back.euler[1], -1.25) && near(back.euler[2], 3.0));
  assert.ok(near(back.steer, -0.3));
  assert.equal(back.tick, 123456);
  assert.equal(back.poses, undefined);
});

test("CP4 0x02 (116 bytes): CP3's plus two older poses with their ages", () => {
  const s = {
    pos: [10, 20, 30], bvel: [0, 0, 50], euler: [0.1, -0.2, 1.5], steer: 0.25, throttle: 0.5, brakeRear: 0, gear: 5, autoShift: false, vehicle: 2, score: 0, tick: 777,
    poses: [{ age: 2, pos: [9, 19, 29], euler: [0.11, -0.21, 1.49] }, { age: 5, pos: [8, 18, 28], euler: [0.12, -0.22, 1.48] }],
  };
  const b = encodePacket("state", stateFields(s, "cp4"), 3, "cp4");
  assert.equal(b.length, 116);
  const v = new DataView(b.buffer);
  assert.equal(v.getUint32(0x3d, true), 777);
  assert.equal(b[0x41], 2, "pose count");
  assert.deepEqual([b[0x42], b[0x43]], [2, 5], "ages in ticks");
  assert.equal(v.getFloat32(0x44, true), 9);
  assert.equal(v.getFloat32(0x50, true), 8, "the second pose's x");
  assert.equal(v.getFloat32(0x5c, true), f32(0.11));
  assert.equal(v.getFloat32(0x60, true), f32(0.12));
  assert.equal(v.getFloat32(0x64, true), f32(-0.21));
  assert.equal(v.getFloat32(0x6c, true), f32(1.49));
  assert.equal(v.getFloat32(0x70, true), f32(1.48));
  const back = stateFromPacket(decodePacket(b, "cp4"), "cp4");
  assert.deepEqual(back.pos, [10, 20, 30], "the packet's own pose is the newest");
  assert.ok(near(back.euler[2], 1.5));
  assert.equal(back.tick, 777);
  assert.equal(back.poses.length, 2);
  assert.equal(back.poses[1].age, 5);
  assert.deepEqual(back.poses[1].pos, [8, 18, 28]);
  assert.ok(near(back.poses[0].euler[1], -0.21));
  // None to send is valid; more than two is dropped, as CP4's receiver does.
  const none = decodePacket(encodePacket("state", stateFields({ ...s, poses: [] }, "cp4"), 3, "cp4"), "cp4");
  assert.equal(none.poseCount, 0);
  assert.deepEqual(stateFromPacket(none, "cp4").poses, []);
  const three = b.slice();
  three[0x41] = 3;
  const bad = decodePacket(three, "cp4");
  assert.equal(bad.kind, null);
  assert.match(bad.reason, /poses/);
  assert.ok(near(CP_TICK_S, 0.0399932861));
});

test("CP4 0x14 (40 bytes) carries the raceId at +0x24; 0x28 and 0x29 carry it at +0x0C", () => {
  const raceId = (0x1234567 ^ (2 << 20)) | 1;
  const b = encodePacket("start", { sit: "TPARK.SIT", laps: 3, weather: 1, raceId }, 1, "cp4");
  assert.equal(b.length, 40);
  assert.equal(new DataView(b.buffer).getUint32(0x24, true), raceId >>> 0);
  const p = decodePacket(b, "cp4");
  assert.deepEqual([p.kind, p.sit, p.laps, p.weather, p.raceId], ["start", "TPARK.SIT", 3, 1, raceId >>> 0]);
  for (const kind of ["raceLoaded", "raceRelease"]) {
    const m = encodePacket(kind, { raceId }, 2, "cp4");
    assert.equal(m.length, 16);
    assert.equal(m[0], TYPES[kind]);
    assert.equal(decodePacket(m, "cp4").raceId, raceId >>> 0);
  }
  assert.equal(TYPES.raceLoaded, 0x28);
  assert.equal(TYPES.raceRelease, 0x29);
  assert.ok(PROFILES.cp4.guaranteed.has(0x28) && PROFILES.cp4.guaranteed.has(0x29));
  assert.ok(!PROFILES.retail.guaranteed.has(0x28));
  // CP3's start is retail's.
  assert.equal(decodePacket(encodePacket("start", { sit: "A.SIT", laps: 2 }, 1, "cp3"), "cp3").raceId, undefined);
});

test("0x26 progress and 0x27 collision (CP3 and CP4)", () => {
  for (const prof of ["cp3", "cp4"]) {
    const g = encodePacket("progress", { truck: 4, segments: 37, total: 81.25 }, 1, prof);
    assert.equal(g.length, 24);
    const v = new DataView(g.buffer);
    assert.deepEqual([v.getUint32(0x0c, true), v.getUint32(0x10, true), v.getFloat32(0x14, true)], [4, 37, 81.25]);
    assert.deepEqual((({ kind, truck, segments, total }) => ({ kind, truck, segments, total }))(decodePacket(g, prof)), { kind: "progress", truck: 4, segments: 37, total: 81.25 });
    const c = encodePacket("collision", { target: 1, source: 6, linear: [1.5, -2, 3], angular: [0.25, 0.5, -1] }, 1, prof);
    assert.equal(c.length, 44);
    const w = new DataView(c.buffer);
    assert.equal(w.getFloat32(0x14, true), 1.5);
    assert.equal(w.getFloat32(0x28, true), -1, "the angular impulse's z at +0x28");
    const d = decodePacket(c, prof);
    assert.deepEqual([d.kind, d.target, d.source, d.linear, d.angular], ["collision", 1, 6, [1.5, -2, 3], [0.25, 0.5, -1]]);
  }
});

test("0x25 is retail's in every profile", () => {
  for (const prof of ["retail", "cp3", "cp4"]) {
    const p = decodePacket(encodePacket("checksum", { sit: "TPARK.SIT", name: "Farm Road 29", crc: 0xdeadbeef }, 1, prof), prof);
    assert.deepEqual([p.kind, p.sit, p.name, p.crc], ["checksum", "TPARK.SIT", "Farm Road 29", 0xdeadbeef]);
  }
});

test("retail stays as it was: same bytes with or without the profile", () => {
  const s = { pos: [10, 20, 30], bvel: [0, 0, 50], euler: [0.1, -0.2, 3], steer: -0.3, throttle: 1, brakeRear: 0.5, gear: 5, autoShift: true, vehicle: 2, score: 0 };
  assert.deepEqual(encodePacket("state", stateFields(s), 9), encodePacket("state", stateFields(s, "retail"), 9, PROFILES.retail));
  assert.deepEqual(stateFields(s), stateFields(s, PROFILES.retail));
  const b = encodePacket("state", stateFields(s), 9);
  assert.equal(b.length, 61);
  assert.equal(new DataView(b.buffer).getFloat32(0x24, true), 4, "byte-coded theta: 0.1 rad is byte 4");
  assert.deepEqual(stateFromPacket(decodePacket(b)), stateFromPacket(decodePacket(b, "retail"), "retail"));
  assert.equal(encodePacket("start", { sit: "A.SIT" }).length, 36);
});

test("decoding is strict: the profile's exact size, else kind null with a reason", () => {
  const cp3State = encodePacket("state", stateFields({ pos: [1, 2, 3], bvel: [0, 0, 0], euler: [0, 0, 0] }, "cp3"), 5, "cp3");
  assert.equal(cp3State.length, 65);
  const asRetail = decodePacket(cp3State);
  assert.equal(asRetail.kind, null, "a 65-byte 0x02 is not retail's");
  assert.match(asRetail.reason, /65 bytes.*61/);
  assert.equal(asRetail.bytes.length, 65, "kept for a relay");
  assert.equal(asRetail.sender, 5);
  assert.equal(decodePacket(cp3State, "cp3").kind, "state");
  assert.equal(decodePacket(cp3State, "cp4").kind, null);
  const retail = encodePacket("state", { pos: [0, 0, 0] });
  assert.equal(decodePacket(retail, "cp3").kind, null, "a 61-byte 0x02 is not CP3's");
  const long = new Uint8Array(20);
  long.set(encodePacket("go"));
  assert.equal(decodePacket(long).kind, null, "longer than the packet is rejected too");
  const unknown = decodePacket(encodePacket("progress", {}, 1, "cp3"));
  assert.equal(unknown.kind, null);
  assert.match(unknown.reason, /not in the retail profile/);
  const radio = new Uint8Array(12);
  radio[0] = 0x89;
  assert.match(decodePacket(radio).reason, /radio shorter/);
});

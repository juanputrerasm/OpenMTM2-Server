/*
  MTM2's packets (OpenMTM2 docs/MONSTER_EXE_ANALYSIS.md 14.2) and the track checksum.
*/
import test from "node:test";
import assert from "node:assert/strict";
import {
  encodePacket, decodePacket, packetSize, TYPES, GUARANTEED, BARRIER, MTM2_NET_VERSION,
  angleToByte, byteToAngle, stateFields, stateFromPacket, pingTime, pingMs,
} from "../protocol/mtm2-packets.js";
import { trackCrc, crcStart, crcUpdate } from "../protocol/track-crc.js";

test("every packet has the game's wire size", () => {
  const sizes = {
    0x02: 61, 0x03: 92, 0x06: 16, 0x0b: 24, 0x0d: 56, 0x0e: 16, 0x0f: 32, 0x10: 16, 0x11: 16, 0x12: 112, 0x13: 16,
    0x14: 36, 0x15: 16, 0x16: 16, 0x17: 120, 0x18: 32, 0x19: 16, 0x1a: 92, 0x1b: 16, 0x1c: 12, 0x1d: 16, 0x1e: 16,
    0x1f: 20, 0x20: 20, 0x21: 16, 0x22: 48, 0x23: 16, 0x24: 12, 0x25: 116, 0x80: 96,
    0x81: 96, 0x82: 100, 0x83: 16, 0x84: 16, 0x85: 16, 0x86: 96, 0x87: 20, 0x88: 16, 0x8a: 16,
  };
  for (const [type, size] of Object.entries(sizes)) {
    assert.equal(packetSize(Number(type)), size, `type 0x${Number(type).toString(16)}`);
    assert.equal(encodePacket(Number(type)).length, size);
  }
});

test("the header: type, zero padding, u32 0, the sender's DPID at +8", () => {
  const b = encodePacket("go", {}, 0x12345678);
  assert.deepEqual([...b.slice(0, 12)], [0x19, 0, 0, 0, 0, 0, 0, 0, 0x78, 0x56, 0x34, 0x12]);
  assert.equal(decodePacket(b).sender, 0x12345678);
});

test("the truck state (0x02) at its offsets", () => {
  const b = encodePacket("state", {
    pos: [1, 2, 3], bvel: [4, 5, 6], theta: 7, phi: 8, psi: 9, steer: 10, throttle: 255, brake: 128,
    gear: 4, autoShift: 1, vehicle: 3, score: 42.5,
  }, 7);
  const v = new DataView(b.buffer);
  assert.equal(v.getFloat32(0x0c, true), 1);
  assert.equal(v.getFloat32(0x20, true), 6);
  assert.equal(v.getFloat32(0x2c, true), 9);
  assert.equal(v.getFloat32(0x30, true), 10);
  assert.deepEqual([...b.slice(0x34, 0x39)], [255, 128, 4, 1, 3]);
  assert.equal(v.getFloat32(0x39, true), 42.5, "the score is unaligned at +0x39");
  const p = decodePacket(b);
  assert.equal(p.kind, "state");
  assert.deepEqual(p.pos, [1, 2, 3]);
});

test("angles travel as byte values, 256 a turn, and come back within +-pi", () => {
  assert.equal(angleToByte(0), 0);
  assert.equal(angleToByte(Math.PI / 2), 64);
  assert.equal(angleToByte(-Math.PI / 2), 192);
  assert.ok(Math.abs(byteToAngle(192) + Math.PI / 2) < 1e-9);
  const s = { pos: [10, 20, 30], bvel: [0, 0, 50], euler: [0.1, -0.2, 3], steer: -0.3, throttle: 1, brakeRear: 0.5, gear: 5, autoShift: true, vehicle: 2, score: 0 };
  const back = stateFromPacket(decodePacket(encodePacket("state", stateFields(s))));
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(back.euler[k] - s.euler[k]) < (2 * Math.PI) / 256 + 1e-6);
  assert.ok(Math.abs(back.steer - s.steer) < (2 * Math.PI) / 256 + 1e-6);
  assert.equal(back.throttle, 1);
  assert.equal(back.gear, 5);
  assert.equal(back.autoShift, true);
});

test("strings are fixed fields, NUL-terminated", () => {
  const p = decodePacket(encodePacket("track", { sit: "TPARK.SIT", name: "Farm Road 29" }));
  assert.equal(p.sit, "TPARK.SIT");
  assert.equal(p.name, "Farm Road 29", "a field called name does not clash with the kind");
  assert.equal(p.kind, "track");
  const long = decodePacket(encodePacket("truck", { truck: "X".repeat(40) }));
  assert.equal(long.truck.length, 19, "room is kept for the NUL");
});

test("player info carries version 0x0201; start positions are nine points", () => {
  assert.equal(MTM2_NET_VERSION, 0x0201);
  const info = decodePacket(encodePacket("info", { truck: "Bigfoot", version: MTM2_NET_VERSION, skill: 2, setup: [1, 1, 600, 1, 0] }));
  assert.equal(info.version, 0x0201);
  assert.deepEqual(info.setup, [1, 1, 600, 1, 0]);
  const pos = Array.from({ length: 9 }, (_, i) => [i, i * 2, i * 3]);
  assert.deepEqual(decodePacket(encodePacket("positions", { positions: pos })).positions, pos);
});

test("barrier codes are C multi-character constants", () => {
  assert.equal(BARRIER.SYNC, 0x73796e63);
  assert.equal(BARRIER.RESULTS, 0x72736c74);
});

test("which packets go guaranteed", () => {
  for (const name of ["info", "location", "track", "start", "barrier", "result", "kick"]) assert.ok(GUARANTEED.has(TYPES[name]), name);
  for (const name of ["state", "go", "split", "chat", "damage"]) assert.ok(!GUARANTEED.has(TYPES[name]), name);
});

test("unknown packets are passed through undecoded", () => {
  const b = new Uint8Array(20);
  b[0] = 0x89;
  const p = decodePacket(b);
  assert.equal(p.kind, null);
  assert.equal(p.bytes.length, 20);
});

test("ping times: 1.179648 MHz ticks, a second is 0x120000", () => {
  assert.equal(pingTime(1000), 1179648);
  assert.equal(pingMs(pingTime(1000), pingTime(1250)), 250);
});

test("the track checksum is CRC-32/MPEG-2", () => {
  // The standard check value for "123456789".
  assert.equal(trackCrc(new TextEncoder().encode("123456789")), 0x0376e6e7);
  const a = new TextEncoder().encode("12345"), b = new TextEncoder().encode("6789");
  assert.equal(crcUpdate(crcUpdate(crcStart(), a), b), 0x0376e6e7);
});

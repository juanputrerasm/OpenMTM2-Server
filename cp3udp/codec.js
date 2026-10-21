/*
  Community Patch 3's direct connect datagrams (OpenMTM2 docs/MONSTER_EXE_ANALYSIS.md 14.5): a
  20-byte header and a payload, little-endian. Written from that description; CP3's author
  published no source code.

      0 u32 "MTU3"   4 u8 type   5 u8 0   6 u16 payload length
      8 u32 A (sequence, or a clock)   12 u32 B (the sender's ID)   16 u32 C (the target, 0 for all)
*/

export const MAGIC = 0x3355544d;
export const HEADER = 20;
/** The most payload a datagram carries, and the most a reliable message may. */
export const MAX_PAYLOAD = 1200, MAX_RELIABLE = 1024;
/** CP3's default port (`[Network] Port`). */
export const DEFAULT_PORT = 2350;
/** The host's ID; joiners count from 2. */
export const HOST_ID = 1;
/** Most peers a host holds. */
export const MAX_PEERS = 8;
/** The name field of a join. */
export const NAME_BYTES = 32;

export const TYPE = Object.freeze({
  DATA: 1, RELIABLE: 2, ACK: 3, CONNECT: 4, CONNECTED: 5, JOIN: 6, WELCOME: 7, LEAVE: 8, PING: 9, PONG: 10, ROSTER: 11,
});

/** One datagram's bytes. */
export function encode({ type, a = 0, b = 0, c = 0, payload = new Uint8Array(0) }) {
  if (payload.length > MAX_PAYLOAD) throw new Error("Payload too large");
  const out = Buffer.alloc(HEADER + payload.length);
  out.writeUInt32LE(MAGIC, 0);
  out.writeUInt8(type, 4);
  out.writeUInt16LE(payload.length, 6);
  out.writeUInt32LE(a >>> 0, 8);
  out.writeUInt32LE(b >>> 0, 12);
  out.writeUInt32LE(c >>> 0, 16);
  out.set(payload, HEADER);
  return out;
}

/** A datagram's fields, or null when it is not one. The payload is cut to its length field, as CP3 does. */
export function decode(bytes) {
  if (!bytes || bytes.length < HEADER) return null;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.readUInt32LE(0) !== MAGIC) return null;
  const length = Math.min(buf.readUInt16LE(6), buf.length - HEADER);
  return {
    type: buf.readUInt8(4), a: buf.readUInt32LE(8), b: buf.readUInt32LE(12), c: buf.readUInt32LE(16),
    payload: new Uint8Array(buf.buffer, buf.byteOffset + HEADER, length),
  };
}

/** A join's name: up to 31 characters, NUL-padded to 32 bytes. */
export function nameBytes(name) {
  const out = new Uint8Array(NAME_BYTES);
  const s = String(name ?? "");
  for (let i = 0; i < Math.min(s.length, NAME_BYTES - 1); i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
export function readName(bytes) {
  let s = "";
  for (let i = 0; i < Math.min(bytes.length, NAME_BYTES - 1) && bytes[i]; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
export const idPayload = (id) => new Uint8Array(u32(id));
export const readId = (payload) => (payload.length >= 4 ? Buffer.from(payload.buffer, payload.byteOffset, 4).readUInt32LE(0) : 0);

/** The host's roster: u32 n, then n x { u32 ID, IPv4 address, u16 port }, address and port in network order. */
export function encodeRoster(peers) {
  const list = peers.slice(0, MAX_PEERS);
  const out = Buffer.alloc(4 + list.length * 10);
  out.writeUInt32LE(list.length, 0);
  list.forEach((p, i) => {
    const at = 4 + i * 10;
    out.writeUInt32LE(p.id >>> 0, at);
    String(p.ip).split(".").forEach((x, k) => out.writeUInt8(Number(x) & 0xff, at + 4 + k));
    out.writeUInt16BE(p.port, at + 8);
  });
  return new Uint8Array(out);
}
export function decodeRoster(payload) {
  if (payload.length < 4) return null;
  const buf = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const n = Math.min(buf.readUInt32LE(0), MAX_PEERS);
  if (4 + n * 10 > buf.length) return null;
  const out = [];
  for (let i = 0; i < n; i++) {
    const at = 4 + i * 10;
    out.push({ id: buf.readUInt32LE(at), ip: [0, 1, 2, 3].map((k) => buf.readUInt8(at + 4 + k)).join("."), port: buf.readUInt16BE(at + 8) });
  }
  return out;
}

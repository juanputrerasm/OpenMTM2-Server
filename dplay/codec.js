/*
  DirectPlay 4 over TCP/IP, the messages: written from Microsoft's open specification
  [MC-DPL4CS] "DirectPlay 4 Protocol: Core and Service Providers" (section numbers below are its).
  Only what a game like Monster Truck Madness 2 needs: no groups of its own, no security, no
  reliable protocol ([MC-DPL4R]), no fragmenting.

  Framing (2.1, 2.2.6):
  - Every message sent over TCP, and every system message over UDP, starts with a 20-byte prefix:
    u32 size (low 20 bits, the whole message) | token << 20 (0xFAB), then a SOCKADDR_IN holding
    the sender's TCP listening port and the address 0.0.0.0 ("use where it came from").
  - A system message follows: 'play', u16 command, u16 dialect version, then its fields. Every
    offset inside a message counts from the 'play' signature.
  - A player (game) message has no 'play': u32 idFrom, u32 idTo, the game's bytes. Over UDP it is
    sent bare, with no prefix; over TCP the prefix still frames it.

  Little-endian except the port and address inside a SOCKADDR_IN, which are network order.
  Strings are NUL-terminated UTF-16LE.
*/

export const SIGNATURE = 0x79616c70; // 'play'
export const TOKEN = Object.freeze({ REMOTE: 0xfab, FORWARD: 0xcab, SERVER: 0xbab });
export const PREFIX = 20;
export const HEADER = 28;
/** The port games are found on (1.9), and the range peers listen in (2.1). */
export const ENUM_PORT = 47624;
export const PORT_RANGE = Object.freeze({ tcp: [2300, 2350], udp: [2350, 2400] });

/** Dialect versions (2.2.3). */
export const VERSION = Object.freeze({ DX6: 9, DX61: 10, DX61A: 11, DX71: 12, DX8: 13, DX9: 14 });

/** Command values (2.2.6). */
export const CMD = Object.freeze({
  ENUMSESSIONSREPLY: 0x01, ENUMSESSIONS: 0x02, ENUMPLAYERSREPLY: 0x03, ENUMPLAYER: 0x04,
  REQUESTPLAYERID: 0x05, REQUESTGROUPID: 0x06, REQUESTPLAYERREPLY: 0x07, CREATEPLAYER: 0x08, CREATEGROUP: 0x09,
  PLAYERMESSAGE: 0x0a, DELETEPLAYER: 0x0b, DELETEGROUP: 0x0c, ADDPLAYERTOGROUP: 0x0d, DELETEPLAYERFROMGROUP: 0x0e,
  PLAYERDATACHANGED: 0x0f, PLAYERNAMECHANGED: 0x10, GROUPDATACHANGED: 0x11, GROUPNAMECHANGED: 0x12,
  ADDFORWARDREQUEST: 0x13, PACKET: 0x15, PING: 0x16, PINGREPLY: 0x17, YOUAREDEAD: 0x18, PLAYERWRAPPER: 0x19,
  SESSIONDESCCHANGED: 0x1a, CHALLENGE: 0x1c, ACCESSGRANTED: 0x1d, LOGONDENIED: 0x1e, AUTHERROR: 0x1f,
  NEGOTIATE: 0x20, CHALLENGERESPONSE: 0x21, SIGNED: 0x22, ADDFORWARDREPLY: 0x24, ASK4MULTICAST: 0x25,
  ASK4MULTICASTGUARANTEED: 0x26, ADDSHORTCUTTOGROUP: 0x27, DELETEGROUPFROMGROUP: 0x28, SUPERENUMPLAYERSREPLY: 0x29,
  KEYEXCHANGE: 0x2b, KEYEXCHANGEREPLY: 0x2c, CHAT: 0x2d, ADDFORWARD: 0x2e, ADDFORWARDACK: 0x2f,
  PACKET2_DATA: 0x30, PACKET2_ACK: 0x31, IAMNAMESERVER: 0x35, VOICE: 0x36, MULTICASTDELIVERY: 0x37, CREATEPLAYERVERIFY: 0x38,
});

/** Player flags (2.2.2): system player, name server (host), in a group (every system player), local. */
export const PLAYER = Object.freeze({ SYSTEM: 0x1, NAMESERVER: 0x2, INGROUP: 0x4, LOCAL: 0x8 });
/** Session flags (2.2.5), as the DirectPlay headers number them. */
export const SESSION = Object.freeze({
  NEWPLAYERSDISABLED: 0x1, MIGRATEHOST: 0x4, NOMESSAGEID: 0x8, JOINDISABLED: 0x20, KEEPALIVE: 0x40,
  NODATAMESSAGES: 0x80, SECURESERVER: 0x100, PRIVATE: 0x200, PASSWORDREQUIRED: 0x400, MULTICASTSERVER: 0x800,
  CLIENTSERVER: 0x1000, DIRECTPLAYPROTOCOL: 0x2000,
});
/** EnumSessions flags (2.2.29). */
export const ENUM = Object.freeze({ AVAILABLE: 0x1, ALL: 0x2, PASSWORDREQUIRED: 0x40 });
/** HRESULTs used. */
export const DPERR = Object.freeze({ OK: 0, NONEWPLAYERS: 0x8877014a });

// ---- Small pieces ----

/** A GUID string "{6CD1C6E0-96FB-11D1-A268-00A024F2C995}" as its 16 bytes (Data1-3 little-endian). */
export function guidBytes(text) {
  const hex = String(text).replace(/[{}-]/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`Bad GUID ${text}`);
  const b = Uint8Array.from(hex.match(/../g).map((h) => parseInt(h, 16)));
  const swap = (a, n) => b.subarray(a, a + n).reverse();
  swap(0, 4); swap(4, 2); swap(6, 2);
  return b;
}
/** 16 GUID bytes back as "{...}" text. */
export function guidText(bytes) {
  const b = Uint8Array.from(bytes.subarray ? bytes.subarray(0, 16) : bytes.slice(0, 16));
  const swap = (a, n) => b.subarray(a, a + n).reverse();
  swap(0, 4); swap(4, 2); swap(6, 2);
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `{${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}}`;
}
export const GUID_NULL = new Uint8Array(16);

/** A dotted IPv4 address as a u32 in network order, read as a number (0.0.0.0 is 0). */
export const ipToInt = (ip) => String(ip ?? "0.0.0.0").split(".").reduce((a, x) => ((a << 8) | (Number(x) & 255)) >>> 0, 0);
export const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");

/** UTF-16LE with its NUL. */
export function utf16z(text) {
  const s = String(text ?? "");
  const out = new Uint8Array((s.length + 1) * 2);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); out[2 * i] = c & 255; out[2 * i + 1] = c >> 8; }
  return out;
}
/** A NUL-terminated UTF-16LE string at `at`: `{ text, end }` (end past the NUL). */
export function readUtf16z(view, at) {
  let s = "", i = at;
  for (; i + 1 < view.byteLength; i += 2) {
    const c = view.getUint16(i, true);
    if (!c) return { text: s, end: i + 2 };
    s += String.fromCharCode(c);
  }
  return { text: s, end: view.byteLength };
}

/** A growable little-endian byte writer. */
class Writer {
  constructor() { this.bytes = new Uint8Array(256); this.length = 0; }
  room(n) {
    if (this.length + n <= this.bytes.length) return;
    const next = new Uint8Array(Math.max(this.bytes.length * 2, this.length + n));
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
  }
  u8(v) { this.room(1); this.bytes[this.length++] = v & 255; return this; }
  u16(v) { this.room(2); new DataView(this.bytes.buffer).setUint16(this.length, v & 0xffff, true); this.length += 2; return this; }
  u32(v) { this.room(4); new DataView(this.bytes.buffer).setUint32(this.length, v >>> 0, true); this.length += 4; return this; }
  be16(v) { this.room(2); new DataView(this.bytes.buffer).setUint16(this.length, v & 0xffff, false); this.length += 2; return this; }
  be32(v) { this.room(4); new DataView(this.bytes.buffer).setUint32(this.length, v >>> 0, false); this.length += 4; return this; }
  raw(b) { this.room(b.length); this.bytes.set(b, this.length); this.length += b.length; return this; }
  zero(n) { this.room(n); this.bytes.fill(0, this.length, this.length + n); this.length += n; return this; }
  /** Overwrite a u32 already written. */
  put32(at, v) { new DataView(this.bytes.buffer).setUint32(at, v >>> 0, true); }
  done() { return this.bytes.slice(0, this.length); }
}

/** A SOCKADDR_IN (2.2.1): family 2, port and address in network order, 8 zero bytes. */
export function writeSockaddr(w, { port = 0, ip = "0.0.0.0" } = {}) {
  return w.u16(2).be16(port).be32(typeof ip === "number" ? ip : ipToInt(ip)).zero(8);
}
export function readSockaddr(view, at) {
  return { family: view.getUint16(at, true), port: view.getUint16(at + 2, false), ip: intToIp(view.getUint32(at + 4, false)) };
}

// ---- Framing ----

/** The 20-byte prefix: size and token, then the sender's TCP port at address 0.0.0.0. */
export function prefix(total, port, token = TOKEN.REMOTE) {
  const w = new Writer();
  w.u32(((token & 0xfff) << 20) | (total & 0xfffff));
  writeSockaddr(w, { port, ip: 0 });
  return w.done();
}
/** A message body (from 'play' on, or a player message) framed with the prefix. */
export function frame(body, port) {
  const out = new Uint8Array(PREFIX + body.length);
  out.set(prefix(out.length, port), 0);
  out.set(body, PREFIX);
  return out;
}
/** Read a prefix: `{ size, token, sockaddr }`, or null when the bytes do not look like one. */
export function readPrefix(bytes) {
  if (bytes.length < PREFIX) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mixed = view.getUint32(0, true);
  const token = mixed >>> 20, size = mixed & 0xfffff;
  if (![TOKEN.REMOTE, TOKEN.FORWARD, TOKEN.SERVER].includes(token) || size < PREFIX) return null;
  return { size, token, sockaddr: readSockaddr(view, 4) };
}
/** Whether a body starts with 'play' (a system message). */
export const isSystem = (body) => body.length >= 8 && new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0, true) === SIGNATURE;

/**
 * One UDP datagram split into `{ prefix, body }`: a system message carries the prefix with 'play' at offset 20; a
 * datagram without it is a bare player message. A player message that came prefixed is also accepted.
 */
export function splitDatagram(bytes) {
  if (bytes.length >= PREFIX + 4) {
    const p = readPrefix(bytes);
    if (p && p.size <= bytes.length && p.sockaddr.family === 2) return { prefix: p, body: bytes.subarray(PREFIX, p.size) };
  }
  return { prefix: null, body: bytes };
}

/**
 * Pull whole messages out of a TCP stream: give it chunks, it calls `onMessage({ prefix, body })` for each message.
 * Throws on a broken stream (bad token or size), which should close the connection.
 */
export function createStreamReader(onMessage, maxSize = 0xfffff) {
  let buf = new Uint8Array(0);
  return (chunk) => {
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf, 0);
    next.set(chunk, buf.length);
    buf = next;
    while (buf.length >= PREFIX) {
      const p = readPrefix(buf);
      if (!p || p.size > maxSize) throw new Error("Not a DirectPlay stream");
      if (buf.length < p.size) break;
      onMessage({ prefix: p, body: buf.slice(PREFIX, p.size) });
      buf = buf.subarray(p.size);
    }
  };
}

// ---- System message bodies ----

function start(cmd, version) {
  return new Writer().u32(SIGNATURE).u16(cmd).u16(version);
}

/** DPSESSIONDESC2 (2.2.5), 80 bytes. `desc`: `{ flags, instance, application, maxPlayers, currentPlayers, reserved1, reserved2, user: [4] }`. */
export function writeSessionDesc(w, d) {
  w.u32(80).u32(d.flags ?? 0).raw(d.instance ?? GUID_NULL).raw(d.application ?? GUID_NULL)
    .u32(d.maxPlayers ?? 0).u32(d.currentPlayers ?? 0).u32(0).u32(0).u32(d.reserved1 ?? 0).u32(d.reserved2 ?? 0);
  for (let i = 0; i < 4; i++) w.u32(d.user?.[i] ?? 0);
  return w;
}
export function readSessionDesc(view, at) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  return {
    size: view.getUint32(at, true), flags: view.getUint32(at + 4, true),
    instance: bytes.slice(at + 8, at + 24), application: bytes.slice(at + 24, at + 40),
    maxPlayers: view.getUint32(at + 40, true), currentPlayers: view.getUint32(at + 44, true),
    reserved1: view.getUint32(at + 56, true), reserved2: view.getUint32(at + 60, true),
    user: [0, 1, 2, 3].map((i) => view.getUint32(at + 64 + 4 * i, true)),
  };
}

/** The Winsock provider's SP data: the TCP address, then the UDP address (2.2.2). */
function spData(player) {
  const w = new Writer();
  writeSockaddr(w, player.tcp ?? {});
  writeSockaddr(w, player.udp ?? {});
  return w.done();
}

/**
 * DPLAYI_PACKEDPLAYER (2.2.2). `player`: `{ id, flags, shortName, longName, tcp: { port, ip }, udp: { port, ip },
 * data?: Uint8Array, systemPlayerId, version }`.
 */
export function writePackedPlayer(w, p) {
  const short = p.shortName ? utf16z(p.shortName) : new Uint8Array(0);
  const long = p.longName ? utf16z(p.longName) : new Uint8Array(0);
  const sp = spData(p);
  const data = p.data ?? new Uint8Array(0);
  w.u32(48 + short.length + long.length + sp.length + data.length).u32(p.flags ?? 0).u32(p.id)
    .u32(short.length).u32(long.length).u32(sp.length).u32(data.length).u32(0)
    .u32(p.systemPlayerId ?? p.id).u32(48).u32(p.version ?? VERSION.DX9).u32(0)
    .raw(short).raw(long).raw(sp).raw(data);
  return w;
}
export function readPackedPlayer(view, at) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const u = (o) => view.getUint32(at + o, true);
  const size = u(0), flags = u(4), id = u(8), shortLength = u(12), longLength = u(16), spLength = u(20), dataLength = u(24);
  const players = u(28), systemPlayerId = u(32), fixed = u(36) || 48, version = u(40), parentId = u(44);
  let p = at + fixed;
  const shortName = shortLength ? readUtf16z(view, p).text : "";
  p += shortLength;
  const longName = longLength ? readUtf16z(view, p).text : "";
  p += longLength;
  const sp = spLength >= 32 ? { tcp: readSockaddr(view, p), udp: readSockaddr(view, p + 16) } : {};
  p += spLength;
  const data = bytes.slice(p, p + dataLength);
  p += dataLength;
  const members = Array.from({ length: players }, (_, i) => view.getUint32(p + 4 * i, true));
  return { size, flags, id, shortName, longName, ...sp, data, systemPlayerId, version, parentId, members, end: at + Math.max(size, p + 4 * players - at) };
}

/** DPLAYI_SUPERPACKEDPLAYER (2.2.3), for players only (no groups or shortcuts). */
export function writeSuperPackedPlayer(w, p) {
  const system = !!(p.flags & PLAYER.SYSTEM);
  let mask = 0;
  if (p.shortName) mask |= 0x1;
  if (p.longName) mask |= 0x2;
  // The Winsock provider sends its 32 bytes of SP data with a 1-byte length (product note <3>).
  mask |= 1 << 2;
  const data = p.data ?? new Uint8Array(0);
  if (data.length) mask |= (data.length < 256 ? 1 : data.length < 65536 ? 2 : 3) << 4;
  w.u32(16).u32(p.flags ?? 0).u32(p.id).u32(mask).u32(system ? (p.version ?? VERSION.DX9) : p.systemPlayerId);
  if (p.shortName) w.raw(utf16z(p.shortName));
  if (p.longName) w.raw(utf16z(p.longName));
  if (data.length) {
    const size = (mask >> 4) & 3;
    if (size === 1) w.u8(data.length); else if (size === 2) w.u16(data.length); else w.u32(data.length);
    w.raw(data);
  }
  w.u8(32).raw(spData(p));
  return w;
}
export function readSuperPackedPlayer(view, at) {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const flags = view.getUint32(at + 4, true), id = view.getUint32(at + 8, true), mask = view.getUint32(at + 12, true);
  const vs = view.getUint32(at + 16, true);
  let p = at + (view.getUint32(at, true) || 16) + 4;
  const sized = (code) => {
    if (code === 1) { const v = view.getUint8(p); p += 1; return v; }
    if (code === 2) { const v = view.getUint16(p, true); p += 2; return v; }
    if (code === 3) { const v = view.getUint32(p, true); p += 4; return v; }
    return 0;
  };
  const out = { flags, id, version: flags & PLAYER.SYSTEM ? vs : null, systemPlayerId: flags & PLAYER.SYSTEM ? id : vs, shortName: "", longName: "" };
  if (mask & 0x1) { const s = readUtf16z(view, p); out.shortName = s.text; p = s.end; }
  if (mask & 0x2) { const s = readUtf16z(view, p); out.longName = s.text; p = s.end; }
  const dataLength = sized((mask >> 4) & 3);
  out.data = bytes.slice(p, p + dataLength);
  p += dataLength;
  const spLength = sized((mask >> 2) & 3);
  if (spLength >= 32) { out.tcp = readSockaddr(view, p); out.udp = readSockaddr(view, p + 16); }
  p += spLength;
  const count = sized((mask >> 6) & 3);
  out.members = Array.from({ length: count }, (_, i) => view.getUint32(p + 4 * i, true));
  p += 4 * count;
  if (mask & 0x100) { out.parentId = view.getUint32(p, true); p += 4; }
  const shortcuts = sized((mask >> 9) & 3);
  p += 4 * shortcuts;
  out.end = p;
  return out;
}

// Message bodies by command. Each `encode.<name>(fields, version)` returns the body from 'play' on.
export const encode = {
  enumSessions({ application, flags = ENUM.AVAILABLE, password = "" }, version) {
    const w = start(CMD.ENUMSESSIONS, version).raw(application).u32(password ? 32 : 0).u32(flags);
    if (password) w.raw(utf16z(password));
    return w.done();
  },
  enumSessionsReply({ desc, name }, version) {
    const w = start(CMD.ENUMSESSIONSREPLY, version);
    writeSessionDesc(w, desc);
    w.u32(name ? 8 + 80 + 4 : 0);
    if (name) w.raw(utf16z(name));
    return w.done();
  },
  requestPlayerId({ flags }, version) {
    return start(CMD.REQUESTPLAYERID, version).u32(flags).done();
  },
  requestPlayerReply({ id, result = DPERR.OK }, version) {
    return start(CMD.REQUESTPLAYERREPLY, version).u32(id).zero(24).u32(0).u32(0).u32(result).done();
  },
  addForwardRequest({ toId = 0, playerId, player, password = "", tick = 0 }, version) {
    const w = start(CMD.ADDFORWARDREQUEST, version).u32(toId).u32(playerId).u32(0).u32(28);
    const pwAt = w.length;
    w.u32(0);
    writePackedPlayer(w, player);
    w.put32(pwAt, w.length);
    w.raw(utf16z(password)).u32(tick);
    return w.done();
  },
  addForward({ toId = 0, playerId, player }, version) {
    const w = start(CMD.ADDFORWARD, version).u32(toId).u32(playerId).u32(0).u32(28).u32(0);
    return writePackedPlayer(w, player).done();
  },
  addForwardAck({ id }, version) {
    return start(CMD.ADDFORWARDACK, version).u32(id).done();
  },
  addForwardReply({ error }, version) {
    return start(CMD.ADDFORWARDREPLY, version).u32(error).done();
  },
  superEnumPlayersReply({ desc, name, password = "", players }, version) {
    const w = start(CMD.SUPERENUMPLAYERSREPLY, version).u32(players.length).u32(0);
    const packedAt = w.length;
    w.u32(0).u32(0).u32(36);
    const nameAt = w.length;
    w.u32(0);
    const pwAt = w.length;
    w.u32(0);
    writeSessionDesc(w, desc);
    if (name) { w.put32(nameAt, w.length); w.raw(utf16z(name)); }
    if (password) { w.put32(pwAt, w.length); w.raw(utf16z(password)); }
    w.put32(packedAt, w.length);
    for (const p of players) writeSuperPackedPlayer(w, p);
    return w.done();
  },
  createPlayer({ playerId, player }, version, cmd = CMD.CREATEPLAYER) {
    const w = start(cmd, version).u32(0).u32(playerId).u32(0).u32(28).u32(0);
    return writePackedPlayer(w, player).u16(0).u32(0).done();
  },
  createPlayerVerify(fields, version) {
    return encode.createPlayer(fields, version, CMD.CREATEPLAYERVERIFY);
  },
  deletePlayer({ playerId }, version) {
    return start(CMD.DELETEPLAYER, version).u32(0).u32(playerId).u32(0).u32(0).u32(0).done();
  },
  ping({ fromId, tick }, version) {
    return start(CMD.PING, version).u32(fromId).u32(tick).done();
  },
  pingReply({ fromId, tick }, version) {
    return start(CMD.PINGREPLY, version).u32(fromId).u32(tick).done();
  },
  youAreDead(_, version) {
    return start(CMD.YOUAREDEAD, version).done();
  },
  iAmNameServer({ toId = 0, hostId, flags = PLAYER.SYSTEM | PLAYER.NAMESERVER | PLAYER.INGROUP, tcpPort, udpPort }, version) {
    const w = start(CMD.IAMNAMESERVER, version).u32(toId).u32(hostId).u32(flags).u32(32);
    writeSockaddr(w, { port: tcpPort, ip: 0 });
    writeSockaddr(w, { port: udpPort, ip: 0 });
    return w.done();
  },
  playerWrapper({ message }, version) {
    return start(CMD.PLAYERWRAPPER, version).raw(message).done();
  },
};

/** A player (game) message body: idFrom, idTo, the bytes; wrapped when the bytes would be taken for 'play' (3.1.4.16.2). */
export function playerMessage(from, to, payload, version) {
  const w = new Writer().u32(from).u32(to).raw(payload);
  const body = w.done();
  if (body.length >= 4 && isSystem(body)) return encode.playerWrapper({ message: body }, version);
  return body;
}

/**
 * A system message body (from 'play' on) read into `{ cmd, version, ...fields }`; unknown commands give `{ cmd, version }`.
 * Malformed messages throw, and are to be ignored (3).
 */
export function decodeSystem(body) {
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  if (view.getUint32(0, true) !== SIGNATURE) throw new Error("No 'play' signature");
  const cmd = view.getUint16(4, true), version = view.getUint16(6, true);
  const u = (o) => view.getUint32(8 + o, true);
  const out = { cmd, version };
  switch (cmd) {
    case CMD.ENUMSESSIONS: {
      out.application = body.slice(8, 24);
      const pwOffset = u(16);
      out.flags = u(20);
      out.password = pwOffset ? readUtf16z(view, pwOffset).text : "";
      break;
    }
    case CMD.ENUMSESSIONSREPLY: {
      out.desc = readSessionDesc(view, 8);
      const nameOffset = view.getUint32(88, true);
      out.name = nameOffset ? readUtf16z(view, nameOffset).text : "";
      break;
    }
    case CMD.REQUESTPLAYERID:
    case CMD.REQUESTGROUPID:
      out.flags = u(0);
      break;
    case CMD.REQUESTPLAYERREPLY:
      out.id = u(0);
      out.result = u(36);
      break;
    case CMD.ADDFORWARDREQUEST:
    case CMD.ADDFORWARD:
    case CMD.CREATEPLAYER:
    case CMD.CREATEPLAYERVERIFY: {
      out.toId = u(0);
      out.playerId = u(4);
      out.groupId = u(8);
      const createOffset = u(12) || 28;
      const pwOffset = u(16);
      out.player = readPackedPlayer(view, createOffset);
      if (cmd === CMD.ADDFORWARDREQUEST && pwOffset) {
        const pw = readUtf16z(view, pwOffset);
        out.password = pw.text;
        out.tick = pw.end + 4 <= body.length ? view.getUint32(pw.end, true) : 0;
      }
      break;
    }
    case CMD.ADDFORWARDACK:
      out.id = u(0);
      break;
    case CMD.ADDFORWARDREPLY:
      out.error = u(0);
      break;
    case CMD.SUPERENUMPLAYERSREPLY: {
      const players = u(0), groups = u(4), packed = u(8), shortcuts = u(12), descOffset = u(16), nameOffset = u(20), pwOffset = u(24);
      out.desc = readSessionDesc(view, descOffset || 36);
      out.name = nameOffset ? readUtf16z(view, nameOffset).text : "";
      out.password = pwOffset ? readUtf16z(view, pwOffset).text : "";
      out.players = [];
      out.groups = [];
      let p = packed;
      for (let i = 0; i < players + groups + shortcuts && p < body.length; i++) {
        const sp = readSuperPackedPlayer(view, p);
        p = sp.end;
        if (i < players) out.players.push(sp);
        else if (i < players + groups) out.groups.push(sp);
      }
      break;
    }
    case CMD.DELETEPLAYER:
      out.playerId = u(4);
      break;
    case CMD.PING:
    case CMD.PINGREPLY:
      out.fromId = u(0);
      out.tick = u(4);
      break;
    case CMD.IAMNAMESERVER:
      out.toId = u(0);
      out.hostId = u(4);
      out.flags = u(8);
      if (u(12) >= 32) { out.tcp = readSockaddr(view, 24); out.udp = readSockaddr(view, 40); }
      break;
    case CMD.PLAYERWRAPPER:
      out.message = body.slice(8);
      break;
    case CMD.SESSIONDESCCHANGED: {
      const nameOffset = u(4);
      out.desc = readSessionDesc(view, 20);
      out.name = nameOffset ? readUtf16z(view, nameOffset).text : "";
      break;
    }
    default:
      break;
  }
  return out;
}

/** A player message body read: `{ from, to, payload }`. */
export function decodePlayerMessage(body) {
  if (body.length < 8) throw new Error("Player message too short");
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  return { from: view.getUint32(0, true), to: view.getUint32(4, true), payload: body.slice(8) };
}

/**
 * Player IDs as a host hands them out (3.2.5.4): the low 16 bits an index no live ID uses, the high 16 bits a counter
 * that goes up with every ID, the whole XORed with the session's Reserved1.
 */
export function createIdAllocator(key, start = 0) {
  let counter = start & 0xffff;
  const used = new Set();
  return {
    key,
    next() {
      let index = 0;
      while (used.has(index)) index++;
      used.add(index);
      counter = (counter + 1) & 0xffff;
      return (((counter << 16) | index) ^ key) >>> 0;
    },
    release(id) { used.delete(((id ^ key) >>> 0) & 0xffff); },
    /** Mark an ID handed out by an earlier host as taken (after a host migration). */
    claim(id) { used.add(((id ^ key) >>> 0) & 0xffff); },
  };
}

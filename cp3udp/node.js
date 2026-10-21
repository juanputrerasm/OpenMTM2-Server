/*
  A Community Patch 3 direct connect node (OpenMTM2 docs/MONSTER_EXE_ANALYSIS.md 14.5): hosts or
  joins a game of CP3's own UDP protocol, a star in which the host relays everything. Same events as
  dplay/provider.js, so the helper and the page treat both alike:

      "player" { id, name, joined, local }   "message" { from, to, payload }
      "host" { id, local }                   "lost" { reason }        "log" (text)

  A player's ID is its direct connect ID (the host 1, joiners from 2), and the game uses it as its
  player ID. A client hears only of the host here; the game's own 0x81 packets tell it of the others.
  Node only; no dependencies. Written from the analysis; CP3's author published no source code.
*/
import { EventEmitter } from "node:events";
import dgram from "node:dgram";
import {
  TYPE, HOST_ID, MAX_PEERS, MAX_PAYLOAD, MAX_RELIABLE, DEFAULT_PORT, encode, decode, nameBytes, readName, idPayload, readId,
  encodeRoster, decodeRoster,
} from "./codec.js";

/** Timings (14.5). `timeoutMs` and the others may be shortened for tests. */
export const TIMING = Object.freeze({
  connectEveryMs: 200, connectForMs: 3000, joinEveryMs: 150, joinForMs: 4000, pingEveryMs: 1000, rosterEveryMs: 2000,
  timeoutMs: 8000, resendMinMs: 60, resendMaxMs: 1200, tickMs: 25,
});
const RTT_START = 100, RTT_KEEP = 0.875, RTT_TAKE = 0.125, RTT_IGNORE = 10000;
const HELD = 16, RECENT = 256, UNACKED = 64;
/** The truck state, the one game packet CP3 sends unreliably unless told otherwise. */
const STATE_PACKET = 0x02;

export function createDirectConnect(options = {}) {
  const t = { ...TIMING, ...(options.timing ?? {}) };
  const now = options.now ?? (() => Date.now());
  const events = new EventEmitter();
  const log = (text) => events.emit("log", text);
  let sock = null, selfId = 0, isHost = false, hostId = 0, myName = "", nextId = 2, roster = [];
  let ticker = null, lastRoster = 0, closed = false;
  /** Peers by ID (a client has one: the host). */
  const peers = new Map();
  const waits = new Set();

  const newPeer = (id, ip, port, name = "") => ({
    id, ip, port, name, lastRecv: now(), lastPing: now(), rtt: RTT_START,
    sendSeq: 0, expect: 1, recent: [], held: new Map(), unacked: new Map(),
  });
  const peerAt = (ip, port) => { for (const p of peers.values()) if (p.ip === ip && p.port === port) return p; return null; };
  const raw = (ip, port, d) => { if (sock && !closed) sock.send(encode(d), port, ip); };
  const rto = (p) => Math.max(t.resendMinMs, Math.min(t.resendMaxMs, p.rtt * 1.5));

  // ---- Sending ----

  function sendReliable(p, payload, from, to) {
    if (p.unacked.size >= UNACKED) { log(`peer ${p.id}: too many unacknowledged messages`); return false; }
    const seq = ++p.sendSeq;
    const d = { type: TYPE.RELIABLE, a: seq, b: from, c: to, payload };
    p.unacked.set(seq, { d, sentAt: now() });
    raw(p.ip, p.port, d);
    return true;
  }
  /** Data to a peer, reliably or not, from `from` to `to` (0 for all). */
  function toPeer(p, payload, reliable, from, to) {
    if (reliable) return sendReliable(p, payload, from, to);
    raw(p.ip, p.port, { type: TYPE.DATA, b: from, c: to, payload });
    return true;
  }
  /**
   * Game bytes to player `to` (0: everyone else). As CP3's game does by default, everything is reliable but the truck
   * state, unless `guaranteed` asks for it.
   */
  function send(to, payload, { guaranteed = false } = {}) {
    if (!selfId) return 0;
    const reliable = guaranteed || payload[0] !== STATE_PACKET;
    if (payload.length > (reliable ? MAX_RELIABLE : MAX_PAYLOAD)) throw new Error("Message too large");
    let n = 0;
    for (const p of peers.values()) {
      // A client sends everything to the host, which relays; the host sends to the peers the target matches.
      if (isHost && to && p.id !== to) continue;
      if (toPeer(p, payload, reliable, selfId, to || 0)) n++;
    }
    return n;
  }

  // ---- Receiving ----

  /** A game message for this machine, or one the host passes on. */
  function arrived(from, to, payload, reliable, via) {
    if (isHost && from !== selfId) {
      for (const p of peers.values()) if (p !== via && (!to || p.id === to)) toPeer(p, payload, reliable, from, to);
      if (to && to !== selfId) return;
    }
    events.emit("message", { from, to, payload: new Uint8Array(payload) });
  }

  function onDatagram(msg, rinfo) {
    const d = decode(new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength));
    if (!d) return;
    const ip = rinfo.address.replace(/^::ffff:/, ""), port = rinfo.port;
    const p = peerAt(ip, port);
    if (p) p.lastRecv = now();
    for (const w of waits) if (w.test(d, ip, port)) { waits.delete(w); w.resolve(d); }
    switch (d.type) {
      case TYPE.DATA:
        arrived(d.b, d.c, d.payload, false, p);
        return;
      case TYPE.RELIABLE: {
        if (!p) return;
        const ack = () => raw(ip, port, { type: TYPE.ACK, a: d.a, b: selfId });
        // Had already (delivered, or held): acknowledged again, not used again.
        if (d.a < p.expect || p.held.has(d.a) || p.recent.includes(d.a)) { ack(); return; }
        // Ours: an early message that cannot be held is not acknowledged, so it comes again. CP3 acknowledges
        // every copy first and loses that one (MONSTER_EXE_ANALYSIS.md 14.5); both work with either.
        if (d.a > p.expect && (p.held.size >= HELD || d.payload.length > MAX_RELIABLE)) return;
        ack();
        p.recent.push(d.a);
        if (p.recent.length > RECENT) p.recent.shift();
        if (d.a === p.expect) {
          arrived(d.b, d.c, d.payload, true, p);
          p.expect++;
          // Those that came early, in order.
          for (let next = p.held.get(p.expect); next; next = p.held.get(p.expect)) {
            p.held.delete(p.expect);
            arrived(next.b, next.c, next.payload, true, p);
            p.expect++;
          }
        } else p.held.set(d.a, { b: d.b, c: d.c, payload: new Uint8Array(d.payload) });
        return;
      }
      case TYPE.ACK:
        p?.unacked.delete(d.a);
        return;
      case TYPE.CONNECT:
        if (isHost) raw(ip, port, { type: TYPE.CONNECTED, b: selfId });
        return;
      case TYPE.JOIN: {
        if (!isHost) return;
        let q = p;
        if (!q) {
          if (peers.size >= MAX_PEERS) return;
          q = newPeer(nextId++, ip, port, readName(d.payload));
          peers.set(q.id, q);
          log(`${q.name || "a player"} joined as ${q.id} from ${ip}:${port}`);
          events.emit("player", { id: q.id, name: q.name, joined: true, local: false });
        }
        raw(ip, port, { type: TYPE.WELCOME, b: selfId, payload: idPayload(q.id) });
        return;
      }
      case TYPE.LEAVE:
        if (!p) return;
        if (isHost) drop(p, "left");
        else end("the host left");
        return;
      case TYPE.PING:
        raw(ip, port, { type: TYPE.PONG, a: d.a, b: selfId });
        return;
      case TYPE.PONG: {
        if (!p) return;
        const sample = (now() >>> 0) - d.a;
        if (sample >= 0 && sample < RTT_IGNORE) p.rtt = p.rtt * RTT_KEEP + sample * RTT_TAKE;
        return;
      }
      case TYPE.ROSTER:
        if (!isHost) roster = decodeRoster(d.payload) ?? roster;
        return;
      default:
    }
  }

  function wait(test, ms) {
    return new Promise((resolve, reject) => {
      const w = { test, resolve: (d) => { clearTimeout(w.timer); resolve(d); } };
      w.timer = setTimeout(() => { waits.delete(w); reject(new Error("No answer")); }, ms);
      waits.add(w);
    });
  }
  /** Send `d` every `every` ms until `test` matches an answer, for up to `ms`. */
  async function ask(ip, port, d, test, every, ms) {
    raw(ip, port, d);
    const again = setInterval(() => raw(ip, port, d), every);
    try { return await wait(test, ms); } finally { clearInterval(again); }
  }

  // ---- Upkeep ----

  function drop(p, reason) {
    if (!peers.delete(p.id)) return;
    log(`peer ${p.id} gone (${reason})`);
    events.emit("player", { id: p.id, name: p.name, joined: false, local: false });
  }
  function tick() {
    const tNow = now();
    if (isHost && tNow - lastRoster >= t.rosterEveryMs) {
      lastRoster = tNow;
      const list = encodeRoster([...peers.values()]);
      for (const p of peers.values()) raw(p.ip, p.port, { type: TYPE.ROSTER, b: selfId, payload: list });
    }
    for (const p of [...peers.values()]) {
      for (const u of p.unacked.values()) if (tNow - u.sentAt >= rto(p)) { u.sentAt = tNow; raw(p.ip, p.port, u.d); }
      if (tNow - p.lastPing >= t.pingEveryMs) { p.lastPing = tNow; raw(p.ip, p.port, { type: TYPE.PING, a: tNow >>> 0, b: selfId }); }
      if (tNow - p.lastRecv >= t.timeoutMs) {
        if (isHost) drop(p, "no answer");
        else migrate(p);
      }
    }
  }
  /** The host went quiet (14.5): the lowest ID in its last roster takes over. */
  function migrate(lost) {
    peers.delete(lost.id);
    const next = roster.filter((r) => r.id !== lost.id).sort((a, b) => a.id - b.id)[0];
    if (!next) { end("the host is gone"); return; }
    events.emit("player", { id: lost.id, name: lost.name, joined: false, local: false });
    if (next.id === selfId) {
      isHost = true;
      hostId = selfId;
      for (const r of roster) if (r.id !== selfId && r.id !== lost.id && !peers.has(r.id)) peers.set(r.id, newPeer(r.id, r.ip, r.port));
      nextId = Math.max(selfId, ...roster.map((r) => r.id)) + 1;
      log("this machine is the host now");
      events.emit("host", { id: selfId, local: true });
    } else {
      hostId = next.id;
      peers.set(next.id, newPeer(next.id, next.ip, next.port));
      log(`the host is now ${next.id}`);
      events.emit("host", { id: next.id, local: false });
    }
  }

  // ---- Life cycle ----

  async function open(port) {
    closed = false;
    sock = dgram.createSocket({ type: "udp4", reuseAddr: false });
    sock.on("message", onDatagram);
    sock.on("error", (err) => log(`udp: ${err.message}`));
    await new Promise((resolve, reject) => { sock.once("error", reject); sock.bind(port, options.bind ?? "0.0.0.0", () => { sock.off("error", reject); resolve(); }); });
    ticker = setInterval(tick, t.tickMs);
    ticker.unref?.();
  }

  /** Host on `port` (CP3's default 2350) as `playerName`. */
  async function host({ playerName = "Host", port = DEFAULT_PORT } = {}) {
    if (sock) throw new Error("Already in a game");
    await open(port);
    selfId = HOST_ID;
    hostId = HOST_ID;
    isHost = true;
    myName = playerName;
    nextId = 2;
    events.emit("host", { id: selfId, local: true });
    events.emit("player", { id: selfId, name: myName, joined: true, local: true });
    return { playerId: selfId, port: sock.address().port };
  }

  /** Join the host at `ip`:`port` as `playerName` (connect, then join, 14.5). */
  async function join({ ip, port = DEFAULT_PORT, playerName = "Driver" }) {
    if (sock) throw new Error("Already in a game");
    await open(0);
    try {
      const hello = await ask(ip, port, { type: TYPE.CONNECT }, (d, fromIp, fromPort) => d.type === TYPE.CONNECTED && fromIp === ip && fromPort === port,
        t.connectEveryMs, t.connectForMs).catch(() => { throw new Error(`No CP3 host answers at ${ip}:${port}.`); });
      hostId = hello.b || HOST_ID;
      peers.set(hostId, newPeer(hostId, ip, port));
      const welcome = await ask(ip, port, { type: TYPE.JOIN, payload: nameBytes(playerName) },
        (d) => d.type === TYPE.WELCOME && readId(d.payload) !== 0, t.joinEveryMs, t.joinForMs).catch(() => { throw new Error("The host did not let us in (full, or gone)."); });
      selfId = readId(welcome.payload);
      myName = playerName;
      isHost = false;
      events.emit("host", { id: hostId, local: false });
      events.emit("player", { id: hostId, name: "", joined: true, local: false });
      events.emit("player", { id: selfId, name: myName, joined: true, local: true });
      return { playerId: selfId };
    } catch (err) {
      close();
      throw err;
    }
  }

  /** Stop. `linger` keeps the socket open a moment, so datagrams just sent (the goodbyes) still go out. */
  function close(linger = 0) {
    clearInterval(ticker);
    ticker = null;
    for (const w of waits) { clearTimeout(w.timer); }
    waits.clear();
    closed = true;
    const s = sock;
    sock = null;
    const shut = () => { try { s?.close(); } catch { /* closed already */ } };
    if (linger) setTimeout(shut, linger).unref?.(); else shut();
    peers.clear();
    selfId = 0;
  }
  function end(reason) {
    if (!sock) return;
    close();
    events.emit("lost", { reason });
  }
  /** Leave: every peer is told (type 8), then the socket closes. */
  function leave() {
    if (!sock) return;
    for (const p of peers.values()) raw(p.ip, p.port, { type: TYPE.LEAVE, b: selfId, payload: idPayload(selfId) });
    close(100);
  }

  return {
    on: (name, fn) => { events.on(name, fn); return () => events.off(name, fn); },
    host, join, leave, send,
    stop: async () => leave(),
    /** Close without telling anyone, as a crash or a pulled cable would (for tests). */
    vanish: () => close(),
    self: () => ({ playerId: selfId, systemId: selfId }),
    isHost: () => isHost,
    hostId: () => hostId,
    session: () => (sock ? { name: isHost ? `${myName}'s game` : "", maxPlayers: MAX_PEERS, isHost } : null),
    players: () => [
      ...(selfId ? [{ id: selfId, name: myName, local: true, systemPlayerId: selfId }] : []),
      ...[...peers.values()].map((p) => ({ id: p.id, name: p.name, local: false, systemPlayerId: p.id })),
    ],
    ports: () => ({ udpPort: sock?.address().port ?? 0 }),
    get rtt() { return Object.fromEntries([...peers.values()].map((p) => [p.id, Math.round(p.rtt)])); },
  };
}

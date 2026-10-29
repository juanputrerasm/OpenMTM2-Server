/*
  The DirectPlay gateway (docs/GATEWAY.md): a classic room is also a DirectPlay session on this
  server, so Monster Truck Madness 2 itself (retail, patched, Community Patch 3's DirectPlay
  connection) joins it by the server's address, as it joins any host.

  - The server's DirectPlay node hosts the session. Every OpenMTM2 member of the room is a game
    player on it, so the classic players see them in their list, with their truck, level and
    status, and race against them.
  - Every classic player is a member of the room, driven from here: its packets become room
    messages, and what the room sends that concerns it alone (a private line, a removal) goes back
    as packets.
  - Classic players reach each other directly, as DirectPlay always connects every machine to every
    other; the gateway translates only between them and the room's OpenMTM2 members.

  The game's packets are those of MONSTER_EXE_ANALYSIS.md 14 (protocol/mtm2-packets.js). What the
  game expects from the session's host (track, laps, weather, slots, start, start positions) comes
  from the player who owns the room.
*/
import { createDirectPlay } from "../dplay/provider.js";
import { SESSION, VERSION } from "../dplay/codec.js";
import {
  MTM2_APPLICATION, MTM2_NET_VERSION, BARRIER, encodePacket, decodePacket, TYPES, GUARANTEED, stateFields, stateFromPacket,
  pingTime, pingMs,
} from "../protocol/mtm2-packets.js";
import { ROOM_PROTOCOL, encodeState, decodeState } from "../protocol/room-messages.js";

/** What a classic player shows as its client. */
export const CLASSIC_CLIENT = "MTM2 (classic)";
/** Copies of one broadcast reach the gateway once for each of its players; repeats closer than this are one. */
const DUPLICATE_MS = 150;
/** Truck state to classic players at most this often per truck (the game itself sends 4 a second over TCP/IP). */
const STATE_TO_CLASSIC_HZ = 10;
const PING_EVERY_MS = 5000;
/** The game's default truck setup in its player info (as legacy-session.js sends it). */
const DEFAULT_SETUP = [1, 1, 600, 1, 0];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.trunc(Number(v) || 0)));
const hex = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");

/**
 * `options`: `bind`, `tcpPorts`, `udpPorts`, `enumPort` for the DirectPlay node; `isBanned(ip)`; `log`. Call `attach(rooms)`
 * with the room server, and give `hooks` to it.
 */
export function createGateway({ bind = "0.0.0.0", tcpPorts, udpPorts, enumPort, pingMs: keepaliveMs, isBanned = () => false, log = () => {}, now = Date.now } = {}) {
  let rooms = null;
  const sessions = new Map();

  async function roomOpened(room) {
    const dp = createDirectPlay({ application: MTM2_APPLICATION, version: VERSION.DX9, bind, tcpPorts, udpPorts, enumPort, pingMs: keepaliveMs });
    dp.on("log", (text) => log("debug", "dplay", { room: room.code, text }));
    // Keepalive on; the host does not migrate, since the session lives on this server.
    await dp.host({ name: room.name, playerName: null, maxPlayers: room.maxPlayers, flags: SESSION.KEEPALIVE | 0x2, password: room.password ?? "" });
    const g = {
      code: room.code, password: room.password ?? "", dp,
      vOf: new Map(), memberOfV: new Map(), classic: new Map(), classicOfMember: new Map(),
      shown: new Map(), settings: { track: null, laps: null, weather: null, crc: null }, owner: null,
      race: null, stateSent: new Map(), pinger: null,
    };
    sessions.set(room.code, g);
    dp.on("player", (p) => { if (!p.local) (p.joined ? classicJoined(g, p) : classicLeft(g, p.id)); });
    dp.on("message", ({ from, to, payload }) => fromClassic(g, from, to, payload));
    g.pinger = setInterval(() => pingClassic(g), PING_EVERY_MS);
    g.pinger.unref?.();
    const { tcpPort, udpPort } = dp.ports();
    log("info", "gateway open", { room: room.code, tcpPort, udpPort });
  }

  function roomClosed(room) {
    const g = sessions.get(room.code);
    if (!g) return;
    sessions.delete(room.code);
    clearInterval(g.pinger);
    for (const c of g.classic.values()) c.conn.closed();
    g.dp.stop().catch(() => {});
    log("info", "gateway closed", { room: room.code });
  }

  // ---- Sending to the classic players ----

  /** A packet from one of our players (`from`) to one classic player, or to all of them (`to` 0). */
  function packet(g, kind, fields, from, to = 0) {
    if (!from) return;
    const bytes = encodePacket(kind, fields, from);
    g.dp.send(to, bytes, { from, guaranteed: GUARANTEED.has(TYPES[kind]) });
  }
  const hostV = (g) => g.vOf.get(g.owner) ?? [...g.vOf.values()][0] ?? 0;
  const info = (m) => ({
    truck: m.truck ?? "", status: m.ready ? 1 : 0, version: MTM2_NET_VERSION, location: m.location ?? 5, skill: m.skill ?? 1,
    setup: DEFAULT_SETUP, team: m.team ?? 0, unknown1: 1, unknown2: 0,
  });
  /** What a newcomer is told (MONSTER_EXE_ANALYSIS.md 14.3): each of our players' info, and the host's settings. */
  function greet(g, to) {
    const host = hostV(g), s = g.settings;
    // The host's player list (14.2): every player already listed (0x81), the active ones (0x82), and the host (0x88).
    for (const [memberId, v] of g.vOf) packet(g, "addPlayer", { name: g.shown.get(memberId)?.name ?? "", dpid: v }, host, to);
    for (const [memberId, v] of g.vOf) packet(g, "activatePlayer", { name: g.shown.get(memberId)?.name ?? "", dpid: v, flag: 1 }, host, to);
    if (host) packet(g, "host", { dpid: host }, host, to);
    for (const [memberId, v] of g.vOf) packet(g, "info", info(g.shown.get(memberId) ?? {}), v, to);
    if (s.track) packet(g, "track", { sit: s.track.sit, name: s.track.name || s.track.sit }, host, to);
    packet(g, "laps", { laps: s.laps ?? 3 }, host, to);
    packet(g, "weather", { weather: s.weather ?? 0 }, host, to);
    packet(g, "teamPlay", { on: 0 }, host, to);
    if (s.track && s.crc !== null && s.crc !== -1) packet(g, "checksum", { sit: s.track.sit, name: s.track.name || s.track.sit, crc: s.crc }, host, to);
  }

  /** Bring the DirectPlay side in line with the room: our players, their lobby state, the host's settings. */
  function reconcile(g) {
    const view = rooms.view(g.code);
    if (!view) return;
    const ours = view.members.filter((m) => !m.classic);
    const ids = new Set(ours.map((m) => m.id));
    for (const [memberId, v] of [...g.vOf]) {
      if (ids.has(memberId)) continue;
      packet(g, "removePlayer", { dpid: v }, hostV(g) === v ? [...g.vOf.values()].find((x) => x !== v) ?? v : hostV(g));
      g.dp.removeLocalPlayer(v);
      g.vOf.delete(memberId);
      g.memberOfV.delete(v);
      g.shown.delete(memberId);
    }
    const ownerBefore = g.owner;
    g.owner = view.owner;
    for (const m of ours) {
      let v = g.vOf.get(m.id);
      const before = g.shown.get(m.id);
      g.shown.set(m.id, { ...m });
      if (!v) {
        v = g.dp.addLocalPlayer(m.name);
        g.vOf.set(m.id, v);
        g.memberOfV.set(v, m.id);
        packet(g, "addPlayer", { name: m.name, dpid: v }, hostV(g) || v);
        packet(g, "info", info(m), v);
        continue;
      }
      if (before.truck !== m.truck) packet(g, "truck", { truck: m.truck }, v);
      if (before.skill !== m.skill) packet(g, "skill", { skill: m.skill }, v);
      if (before.location !== m.location) packet(g, "location", { location: m.location }, v);
      if (before.ready !== m.ready) packet(g, "ready", { ready: m.ready ? 1 : 0 }, v);
      if (before.team !== m.team) packet(g, "joinTeam", { team: m.team }, v);
    }
    const host = hostV(g);
    if (ownerBefore !== null && ownerBefore !== view.owner && host) packet(g, "host", { dpid: host }, host);
    const s = view.settings, was = g.settings;
    const trackKey = (t) => (t ? `${t.sit}:${t.crc}` : "");
    if (trackKey(s.track) !== trackKey(was.track)) {
      if (s.track) {
        packet(g, "track", { sit: s.track.sit, name: s.track.name || s.track.sit }, host);
        if (s.track.crc !== -1) packet(g, "checksum", { sit: s.track.sit, name: s.track.name || s.track.sit, crc: s.track.crc }, host);
      }
      was.track = s.track;
      was.crc = s.track?.crc ?? null;
    }
    if (s.laps !== was.laps) { if (was.laps !== null) packet(g, "laps", { laps: s.laps }, host); was.laps = s.laps; }
    if (s.weather !== was.weather) { if (was.weather !== null) packet(g, "weather", { weather: s.weather }, host); was.weather = s.weather; }
  }

  // ---- The room, as the gateway sees it ----

  function broadcast(room, msg) {
    const g = sessions.get(room.code);
    if (!g) return;
    const fromClassicMember = (id) => g.classicOfMember.has(id);
    switch (msg.type) {
      case "member": case "left": case "owner": case "room":
        reconcile(g);
        return;
      case "chat":
        if (!msg.private && !fromClassicMember(msg.from)) packet(g, "chat", { flag: 0, private: 0, text: msg.text.slice(0, 81) }, g.vOf.get(msg.from));
        return;
      case "shutdown":
        packet(g, "chat", { flag: 0, private: 0, text: (msg.text || "The server is shutting down.").slice(0, 81) }, hostV(g));
        return;
      case "starting":
        return startRace(g, msg.race);
      case "synced": {
        // The game's sync barrier: each of our racers says it is there (0x15), twice to be sure.
        const say = () => { for (const v of racersV(g)) packet(g, "barrier", { code: BARRIER.SYNC }, v); };
        say();
        setTimeout(say, 1000).unref?.();
        return;
      }
      case "race":
        if (msg.from && fromClassicMember(msg.from)) return;
        return raceEvent(g, msg.e);
      case "results":
        return results(g, msg.results);
      default:
        return;
    }
  }

  const entrantOf = (g, vehicle) => g.race?.entrants.find((e) => e.vehicle === vehicle) ?? null;
  const vOfVehicle = (g, vehicle) => g.vOf.get(entrantOf(g, vehicle)?.member) ?? 0;
  const racersV = (g) => (g.race?.entrants ?? []).map((e) => g.vOf.get(e.member)).filter(Boolean);

  /** The host's start (14.3): close the list, every player's slot (its vehicle number), then 0x14. */
  function startRace(g, race) {
    g.race = { entrants: race.entrants };
    g.stateSent.clear();
    for (const c of g.classic.values()) { c.loaded = false; c.seq = 0; }
    const host = hostV(g);
    // The game sends 0x8a and 0x87 unguaranteed (UDP) and 0x14 guaranteed (TCP): over the internet the start could
    // overtake a slot. The list and slots go twice, and the start 300 ms after them.
    const slots = () => {
      packet(g, "listState", { a: 1, b: 0, c: 0 }, host);
      for (const e of race.entrants) {
        const dpid = g.vOf.get(e.member) ?? g.classicOfMember.get(e.member);
        if (dpid) packet(g, "slot", { dpid, slot: e.vehicle }, host);
      }
    };
    slots();
    setTimeout(() => { if (sessions.get(g.code) === g) slots(); }, 150).unref?.();
    setTimeout(() => { if (sessions.get(g.code) === g) packet(g, "start", { sit: race.sit, laps: race.laps, weather: race.weather }, host); }, 300).unref?.();
  }

  function raceEvent(g, e) {
    if (!g.race) return;
    switch (e.kind) {
      case "positions": {
        const positions = Array.from({ length: 9 }, (_, i) => e.positions[i] ?? [0, 0, 0]);
        packet(g, "positions", { positions }, hostV(g));
        return;
      }
      case "go": packet(g, "go", { zero: 0 }, hostV(g)); return;
      case "split": packet(g, "split", { truck: e.vehicle, next: e.next, split: e.split }, vOfVehicle(g, e.vehicle)); return;
      case "damage": packet(g, "damage", { vehicle: e.vehicle, code: e.code }, vOfVehicle(g, e.vehicle)); return;
      case "lights": packet(g, "lights", { vehicle: e.vehicle, lamps: e.lamps }, vOfVehicle(g, e.vehicle)); return;
      case "horn": packet(g, "horn", { truck: e.vehicle }, vOfVehicle(g, e.vehicle)); return;
      case "yeehaw": packet(g, "yeehaw", { truck: e.vehicle }, vOfVehicle(g, e.vehicle)); return;
      // A classic player's truck is handed over by DirectPlay itself; ours by 0x1c from its player, if still there.
      case "gone": packet(g, "gone", {}, vOfVehicle(g, e.vehicle)); return;
      default:
    }
  }

  /** The results barrier: each of our racers' 0x18, then the host leaves the race (0x0e). */
  function results(g, byVehicle) {
    for (const [vehicle, r] of Object.entries(byVehicle)) {
      const v = vOfVehicle(g, Number(vehicle));
      if (v) packet(g, "result", { code: BARRIER.RESULTS, lapsLed: r.lapsLed ?? 0, laps: r.laps, total: r.total, best: r.best }, v);
    }
    packet(g, "exit", { code: 0 }, hostV(g));
    g.race = null;
  }

  function state(room, bytes, member) {
    const g = sessions.get(room.code);
    if (!g || member.classic || !g.race) return;
    const s = decodeState(bytes);
    if (!s) return;
    const t = now();
    if (t - (g.stateSent.get(s.vehicle) ?? 0) < 1000 / STATE_TO_CLASSIC_HZ) return;
    g.stateSent.set(s.vehicle, t);
    packet(g, "state", { ...stateFields(s), vehicle: s.vehicle }, vOfVehicle(g, s.vehicle));
  }

  // ---- Classic players ----

  function classicJoined(g, p) {
    if (p.ip && isBanned(p.ip)) { log("info", "gateway refused banned address", { room: g.code, ip: p.ip }); g.dp.removeRemote(p.id); return; }
    const c = { dpid: p.id, name: p.name || "Driver", ip: p.ip ?? "", conn: null, memberId: null, joined: false, loaded: false, seq: 0, recent: new Map() };
    g.classic.set(p.id, c);
    c.conn = rooms.connect({
      ip: c.ip,
      send: (data) => toClassic(g, c, data),
      // The room server let go of this member (removed by an admin, banned, shutting down).
      close: () => { if (g.classic.has(c.dpid)) g.dp.removeRemote(c.dpid); },
    }, { classic: true });
    c.memberId = c.conn.id;
    g.classicOfMember.set(c.memberId, c.dpid);
    c.conn.text(JSON.stringify({ type: "hello", id: 1, protocol: ROOM_PROTOCOL, name: c.name.slice(0, 24), client: CLASSIC_CLIENT }));
    c.conn.text(JSON.stringify({ type: "join", id: 2, room: g.code, ...(g.password ? { password: g.password } : {}) }));
    log("info", "gateway join", { room: g.code, dpid: p.id >>> 0, name: c.name, ip: c.ip });
  }
  function classicLeft(g, dpid) {
    const c = g.classic.get(dpid);
    if (!c) return;
    g.classic.delete(dpid);
    g.classicOfMember.delete(c.memberId);
    c.conn?.closed();
    log("info", "gateway leave", { room: g.code, dpid: dpid >>> 0, name: c.name });
  }

  /** What the room server sends to a classic player's member: only what concerns that player alone is passed on. */
  function toClassic(g, c, data) {
    if (typeof data !== "string") return;
    const m = JSON.parse(data);
    if (m.id === 2 && m.type === "result") { c.joined = true; greet(g, c.dpid); return; }
    if (m.id === 2 && m.type === "error") {
      log("info", "gateway join refused", { room: g.code, name: c.name, why: m.message });
      setTimeout(() => g.dp.removeRemote(c.dpid), 0);
      return;
    }
    // A private or team line for this player: the original game has no team chat, so it shows as a private line.
    if (m.type === "chat" && (m.private || m.team)) { packet(g, "chat", { flag: 0, private: 1, text: m.text.slice(0, 81) }, g.vOf.get(m.from), c.dpid); return; }
    if (m.type === "kicked" && m.reason === "removed") {
      packet(g, "kick", {}, hostV(g), c.dpid);
      setTimeout(() => { if (g.classic.has(c.dpid)) g.dp.removeRemote(c.dpid); }, 2000).unref?.();
    }
  }

  const roomSay = (c, msg) => c.conn.text(JSON.stringify(msg));

  /** A packet from a classic player. Broadcasts arrive once per player of ours; repeats are dropped. */
  function fromClassic(g, from, to, payload) {
    const c = g.classic.get(from);
    if (!c?.joined) return;
    let p;
    try { p = decodePacket(payload); } catch { return; }
    if (p.kind === "ping") { packet(g, "pong", { time: p.time }, g.memberOfV.has(to) ? to : hostV(g), c.dpid); return; }
    if (p.kind === "pong") { roomSay(c, { type: "profile", latency: clamp(pingMs(p.time, pingTime(now())), 0, 60000) }); return; }
    if (p.kind === "chat" && p.private) {
      const member = g.memberOfV.get(to);
      if (member && p.text) roomSay(c, { type: "chat", text: p.text, to: member });
      return;
    }
    const key = `${p.kind}:${hex(payload)}`;
    const t = now();
    if (t - (c.recent.get(key) ?? -Infinity) < DUPLICATE_MS) return;
    c.recent.set(key, t);
    if (c.recent.size > 64) for (const [k, at] of c.recent) if (t - at > DUPLICATE_MS) c.recent.delete(k);
    const mine = () => g.race?.entrants.find((e) => e.member === c.memberId)?.vehicle ?? 0;
    switch (p.kind) {
      case "info":
        roomSay(c, { type: "profile", truck: String(p.truck).slice(0, 40), ready: !!p.status, location: clamp(p.location, 0, 99), skill: clamp(p.skill, 0, 2), team: clamp(p.team, 0, 15) });
        return;
      case "truck": roomSay(c, { type: "profile", truck: String(p.truck).slice(0, 40) }); return;
      case "skill": roomSay(c, { type: "profile", skill: clamp(p.skill, 0, 2) }); return;
      case "location": roomSay(c, { type: "profile", location: clamp(p.location, 0, 99) }); return;
      case "ready": case "ready0": roomSay(c, { type: "profile", ready: !!p.ready }); return;
      case "joinTeam": roomSay(c, { type: "profile", team: clamp(p.team, 0, 15) }); return;
      case "checksum": if (p.sit) roomSay(c, { type: "profile", content: { sit: p.sit.slice(0, 20), crc: p.crc >>> 0 } }); return;
      case "noTrack": {
        const sit = rooms.view(g.code)?.settings.track?.sit;
        if (sit) roomSay(c, { type: "profile", content: { sit, crc: -1 } });
        return;
      }
      case "chat": case "quick": if (p.text) roomSay(c, { type: "chat", text: p.text }); return;
      case "barrier":
        if (p.code === BARRIER.SYNC && g.race && !c.loaded) { c.loaded = true; roomSay(c, { type: "loaded" }); }
        return;
      case "state": {
        const s = stateFromPacket(p);
        c.seq = (c.seq + 1) & 0xffff;
        c.conn.binary(encodeState({ ...s, brakeFront: s.brakeRear, seq: c.seq, time: t }));
        return;
      }
      case "go": roomSay(c, { type: "race", e: { kind: "go" } }); return;
      case "split": roomSay(c, { type: "race", e: { kind: "split", vehicle: p.truck, next: clamp(p.next, 0, 1000), split: Math.max(0, Math.min(1e6, p.split || 0)) } }); return;
      case "damage": roomSay(c, { type: "race", e: { kind: "damage", vehicle: p.vehicle, code: p.code >>> 0 } }); return;
      case "lights": roomSay(c, { type: "race", e: { kind: "lights", vehicle: p.vehicle, lamps: p.lamps >>> 0 } }); return;
      case "horn": case "yeehaw": if (p.truck > 0) roomSay(c, { type: "race", e: { kind: p.kind, vehicle: p.truck } }); return;
      case "gone": if (mine()) roomSay(c, { type: "race", e: { kind: "gone", vehicle: mine() } }); return;
      case "result":
        roomSay(c, { type: "result", laps: clamp(p.laps, 0, 10000), total: Math.max(0, Math.min(1e7, p.total || 0)), best: Math.max(-1e7, Math.min(1e7, p.best || 0)), lapsLed: clamp(p.lapsLed, 0, 10000) });
        return;
      default:
    }
  }

  /** The Latency column for classic players: the gateway pings each every 5 s. */
  function pingClassic(g) {
    const host = hostV(g);
    if (!host || g.race) return;
    for (const c of g.classic.values()) if (c.joined) packet(g, "ping", { time: pingTime(now()) }, host, c.dpid);
  }

  return {
    attach(roomServer) { rooms = roomServer; },
    hooks: { roomOpened, roomClosed, broadcast, state },
    /** Close every session (the daemon is stopping). */
    async stop() { for (const g of [...sessions.values()]) roomClosed({ code: g.code }); },
    get sessions() { return sessions.size; },
  };
}

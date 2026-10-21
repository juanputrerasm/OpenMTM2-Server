/*
  The rooms: who is connected, which room each is in, and what each room is doing (docs/PROTOCOL.md).
  No sockets here: the daemon hands every connection in as a `client` and every frame to its handler,
  so tests drive it directly.

      const rooms = createRoomServer({ config, log });
      const conn = rooms.connect({ ip, send(objOrBytes), close(code, reason) });
      conn.text(string); conn.binary(uint8array); conn.closed();

  The server needs no game files: tracks are known by their SIT name and checksum, trucks by their
  file name. It relays truck state and race events between the members of a room, seats them, runs
  the loading and results barriers, and moves a room's ownership on when its owner leaves.

  A classic room is also open to Monster Truck Madness 2 itself through the DirectPlay gateway
  (rooms/gateway.js). Its classic players are members the gateway drives (`connect(client, {
  classic: true })`); they never own the room, and the room closes when only they are left. The
  gateway follows the room through `hooks`: `roomOpened(room)`, `roomClosed(room)`,
  `broadcast(room, message)` for every message sent to the whole room, and `state(room, bytes,
  member)` for every truck state frame.
*/
import {
  ROOM_PROTOCOL, LIMITS, ERROR, CLOSE, ROOM_STATE, checkClient, decodeState, STATE_MAX_HZ, roomCode, isRoomCode,
} from "../protocol/room-messages.js";

/** A token bucket: `take()` is false when the rate is spent. */
export function createBucket(perSecond, burst, now) {
  let tokens = burst, at = now();
  return {
    take(n = 1) {
      const t = now();
      tokens = Math.min(burst, tokens + ((t - at) / 1000) * perSecond);
      at = t;
      if (tokens < n) return false;
      tokens -= n;
      return true;
    },
    setRate(r, b = burst) { perSecond = r; burst = b; },
  };
}

export const ROOM_DEFAULTS = Object.freeze({
  name: "OpenMTM2 server", motd: "", maxRooms: 50, maxPlayers: 8, maxMembers: 200,
  maxGatewayRooms: 1, loadTimeoutS: 120, resultsTimeoutS: 30, startDelayMs: 1500, messagesPerSecond: 20, chatPerSecond: 2,
});

export function createRoomServer({ config = {}, now = Date.now, random = Math.random, log = () => {}, version = "0", hooks = {} } = {}) {
  let cfg = { ...ROOM_DEFAULTS, ...config };
  const members = new Map();
  const rooms = new Map();
  let nextMember = 1;
  let draining = null;
  let gatewayRooms = 0;
  const started = now();
  const counters = { connections: 0, races: 0, framesRelayed: 0 };

  // ---- Snapshots ----

  const memberView = (m) => ({
    id: m.id, name: m.name, client: m.clientName, truck: m.truck, skill: m.skill, location: m.location, ready: m.ready,
    team: m.team, latency: m.latency, content: m.content, classic: m.classic,
  });
  const roomView = (r) => ({
    code: r.code, name: r.name, owner: r.owner, locked: !!r.password, public: r.public, maxPlayers: r.maxPlayers, state: r.state,
    classic: r.classic, settings: { ...r.settings }, members: r.order.map((id) => memberView(members.get(id))),
    race: r.race ? raceView(r.race) : null,
  });
  const raceView = (race) => ({
    id: race.id, sit: race.sit, track: race.track, laps: race.laps, weather: race.weather, mode: race.mode,
    entrants: race.entrants.map(({ vehicle, member, computer, name, truck, owner }) => ({ vehicle, member, computer, name, truck, owner })),
  });
  const summary = (r) => ({
    code: r.code, name: r.name, players: r.order.length, maxPlayers: r.maxPlayers, locked: !!r.password, state: r.state, classic: r.classic,
    track: r.settings.track ? { sit: r.settings.track.sit, name: r.settings.track.name } : null, mode: r.settings.mode,
    owner: members.get(r.owner)?.name ?? "",
  });

  // ---- Sending ----

  const send = (m, obj) => { if (m && !m.gone) m.client.send(JSON.stringify(obj)); };
  const sendRoom = (r, obj, except = null) => {
    if (r.classic) hooks.broadcast?.(r, obj);
    const text = JSON.stringify(obj);
    for (const id of r.order) if (id !== except) { const m = members.get(id); if (m && !m.gone) m.client.send(text); }
  };
  const error = (m, id, code, message) => send(m, { type: "error", ...(id !== undefined ? { id } : {}), code, message });

  // ---- Rooms ----

  function newCode() {
    for (;;) { const c = roomCode(random); if (!rooms.has(c)) return c; }
  }
  function uniqueName(r, name) {
    const taken = new Set(r.order.map((id) => members.get(id).name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let n = 2; ; n++) {
      const t = `${name.slice(0, LIMITS.playerName - 4)} (${n})`;
      if (!taken.has(t.toLowerCase())) return t;
    }
  }
  function enter(m, r) {
    m.room = r;
    m.name = uniqueName(r, m.baseName);
    Object.assign(m, { ready: false, location: m.location ?? 5, content: null });
    r.order.push(m.id);
    sendRoom(r, { type: "member", member: memberView(m) }, m.id);
    log("info", "join", { room: r.code, member: m.id, name: m.name });
  }
  function exit(m, reason) {
    const r = m.room;
    if (!r) return;
    m.room = null;
    r.order = r.order.filter((id) => id !== m.id);
    log("info", "leave", { room: r.code, member: m.id, reason });
    if (!r.order.length || r.order.every((id) => members.get(id).classic)) {
      // Nobody left who can own the room: the classic players go too.
      for (const id of [...r.order]) { const c = members.get(id); send(c, { type: "kicked", reason: "closed" }); c.room = null; }
      r.order = [];
      dropRoom(r, "empty");
      return;
    }
    sendRoom(r, { type: "left", member: m.id, reason });
    if (r.race) {
      // Their trucks drive themselves everywhere; the owner's computer trucks too if the owner left.
      for (const e of r.race.entrants) {
        if ((e.member === m.id || (e.computer && e.owner === m.id)) && !r.race.gone.has(e.vehicle)) goneVehicle(r, e.vehicle);
      }
    }
    if (r.owner === m.id) {
      r.owner = r.order.find((id) => !members.get(id).classic);
      sendRoom(r, { type: "owner", member: r.owner });
    }
    if (r.race) checkBarriers(r);
  }
  function goneVehicle(r, vehicle) {
    r.race.gone.add(vehicle);
    sendRoom(r, { type: "race", from: 0, e: { kind: "gone", vehicle } });
  }
  function dropRoom(r, reason) {
    clearRace(r);
    if (!rooms.delete(r.code)) return;
    log("info", "room closed", { room: r.code, reason });
    if (r.classic) { gatewayRooms--; hooks.roomClosed?.(r); }
  }
  function closeRoom(code, reason = "closed") {
    const r = rooms.get(code);
    if (!r) return false;
    for (const id of [...r.order]) {
      const m = members.get(id);
      if (!m?.room) continue;
      send(m, { type: "kicked", reason });
      exit(m, reason);
    }
    dropRoom(r, reason);
    return true;
  }

  // ---- The race ----

  function clearRace(r) {
    if (!r.race) return;
    clearTimeout(r.race.loadTimer);
    clearTimeout(r.race.resultsTimer);
    r.race = null;
  }
  /** The members still in the race (connected and not gone). */
  const racers = (r) => r.race.entrants.filter((e) => e.member && !e.computer && !r.race.gone.has(e.vehicle) && r.order.includes(e.member));

  function startRace(r, owner, { weather, computers = [] }) {
    const humans = r.order.map((id) => members.get(id));
    const bots = computers.slice(0, Math.max(0, Math.min(r.settings.computers, LIMITS.maxPlayers - humans.length)));
    const seats = [...humans.map((m) => ({ member: m.id, computer: false, name: m.name, truck: m.truck, owner: m.id })),
      ...bots.map((c) => ({ member: null, computer: true, name: c.name, truck: c.truck, owner: owner.id }))];
    for (let i = seats.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [seats[i], seats[j]] = [seats[j], seats[i]];
    }
    counters.races++;
    r.race = {
      id: counters.races, sit: r.settings.track.sit, track: r.settings.track, laps: r.settings.laps, weather, mode: r.settings.mode,
      entrants: seats.map((s, i) => ({ ...s, vehicle: i + 1 })), loaded: new Set(), gone: new Set(), results: new Map(),
      synced: false, loadTimer: null, resultsTimer: null,
    };
    r.state = ROOM_STATE.LOADING;
    for (const id of r.order) members.get(id).ready = false;
    r.race.loadTimer = setTimeout(() => loadDeadline(r), cfg.loadTimeoutS * 1000);
    r.race.loadTimer.unref?.();
    sendRoom(r, { type: "starting", race: raceView(r.race) });
    log("info", "race", { room: r.code, race: r.race.id, sit: r.race.sit, entrants: seats.length });
  }
  function loadDeadline(r) {
    if (!r.race || r.race.synced) return;
    for (const e of racers(r)) if (!r.race.loaded.has(e.member)) goneVehicle(r, e.vehicle);
    synced(r);
  }
  function synced(r) {
    const race = r.race;
    race.synced = true;
    clearTimeout(race.loadTimer);
    r.state = ROOM_STATE.RACING;
    sendRoom(r, { type: "synced", startAt: now() + cfg.startDelayMs, serverTime: now() });
  }
  function checkBarriers(r) {
    const race = r.race;
    if (!race) return;
    const left = racers(r);
    if (!race.synced) {
      const waiting = left.filter((e) => !race.loaded.has(e.member));
      sendRoom(r, { type: "waiting", left: waiting.map((e) => e.name) });
      if (!waiting.length) synced(r);
      return;
    }
    if (race.results.size && left.every((e) => race.results.has(e.vehicle))) endRace(r);
    else if (!left.length) endRace(r);
  }
  function endRace(r) {
    const race = r.race;
    const results = Object.fromEntries([...race.results].map(([v, x]) => [v, x]));
    clearRace(r);
    r.state = ROOM_STATE.LOBBY;
    for (const id of r.order) members.get(id).ready = false;
    sendRoom(r, { type: "results", race: race.id, results });
    sendRoom(r, { type: "room", room: roomView(r) });
    log("info", "race over", { room: r.code, race: race.id, results: race.results.size });
  }
  /** Whether member `m` may speak for `vehicle` in this race. */
  function owns(r, m, vehicle) {
    const e = r.race?.entrants.find((x) => x.vehicle === vehicle);
    return !!e && (e.member === m.id || (e.computer && r.owner === m.id));
  }

  // ---- Messages ----

  async function handle(m, msg) {
    const { type, id } = msg;
    const reply = (obj = {}) => send(m, { type: "result", ...(id !== undefined ? { id } : {}), ...obj });
    const fail = (code, message) => error(m, id, code, message);
    if (type === "ping") return send(m, { type: "pong", t: msg.t, server: now(), ...(id !== undefined ? { id } : {}) });
    if (type === "hello") {
      if (m.hello) return fail(ERROR.STATE, "Already said hello.");
      if (msg.protocol !== ROOM_PROTOCOL) {
        fail(ERROR.PROTOCOL, `This server speaks room protocol ${ROOM_PROTOCOL}.`);
        m.client.close(CLOSE.PROTOCOL, "Protocol version");
        return;
      }
      m.hello = true;
      m.baseName = m.name = msg.name;
      m.clientName = msg.client ?? "";
      return reply({
        protocol: ROOM_PROTOCOL, you: { id: m.id }, server: { name: cfg.name, motd: cfg.motd, version },
        limits: { ...LIMITS, maxPlayers: Math.min(LIMITS.maxPlayers, cfg.maxPlayers) },
        features: hooks.roomOpened ? ["classic"] : [],
      });
    }
    if (!m.hello) return fail(ERROR.HELLO_FIRST, "Say hello first.");
    const r = m.room;
    const owner = r && r.owner === m.id;
    switch (type) {
      case "list":
        return reply({ rooms: [...rooms.values()].filter((x) => x.public).map(summary) });
      case "create": {
        if (draining) return fail(ERROR.SHUTDOWN, "The server is shutting down.");
        if (rooms.size >= cfg.maxRooms) return fail(ERROR.LIMIT, "The server has no room for another room.");
        if (m.classic) return fail(ERROR.STATE, "Classic players cannot make rooms.");
        if (msg.classic && !(hooks.roomOpened && gatewayRooms < cfg.maxGatewayRooms)) {
          return fail(ERROR.LIMIT, hooks.roomOpened ? "This server's room for classic players is taken." : "This server does not open rooms to classic players.");
        }
        if (r) exit(m, "left");
        // A classic room keeps the game's limits: 8 players, no computer players over the network.
        const cap = msg.classic ? Math.min(8, cfg.maxPlayers) : cfg.maxPlayers;
        const room = {
          code: newCode(), name: msg.name, password: msg.password || "", public: msg.public !== false, classic: !!msg.classic,
          maxPlayers: Math.min(msg.maxPlayers ?? cap, cap), owner: m.id, order: [], state: ROOM_STATE.LOBBY,
          settings: { track: null, laps: 3, weather: 0, mode: "", computers: 0, damage: true, collisions: true }, race: null,
        };
        rooms.set(room.code, room);
        log("info", "room created", { room: room.code, by: m.id, classic: room.classic });
        if (room.classic) {
          gatewayRooms++;
          try {
            await hooks.roomOpened(room);
          } catch (err) {
            gatewayRooms--;
            rooms.delete(room.code);
            log("warn", "gateway failed", { room: room.code, error: err.message });
            return fail(ERROR.LIMIT, "The server could not open the room to classic players.");
          }
          if (m.gone) { dropRoom(room, "empty"); return; }
        }
        enter(m, room);
        return reply({ room: roomView(room) });
      }
      case "join": {
        if (draining) return fail(ERROR.SHUTDOWN, "The server is shutting down.");
        const code = msg.room.toUpperCase();
        const room = isRoomCode(code) ? rooms.get(code) : null;
        if (!room) return fail(ERROR.NOT_FOUND, "There is no such room.");
        if (room === r) return reply({ room: roomView(room) });
        if (room.password && msg.password !== room.password) return fail(ERROR.PASSWORD, "Wrong password.");
        if (room.order.length >= room.maxPlayers) return fail(ERROR.FULL, "The room is full.");
        if (room.state !== ROOM_STATE.LOBBY) return fail(ERROR.STATE, "The room is racing; try again after the race.");
        if (r) exit(m, "left");
        enter(m, room);
        return reply({ room: roomView(room) });
      }
      case "leave":
        if (r) exit(m, "left");
        return reply();
    }
    if (!r) return fail(ERROR.NOT_IN_ROOM, "Join a room first.");
    switch (type) {
      case "profile": {
        for (const k of ["truck", "skill", "location", "ready", "team", "latency", "content"]) if (msg[k] !== undefined) m[k] = msg[k];
        sendRoom(r, { type: "member", member: memberView(m) });
        return reply();
      }
      case "chat": {
        if (!m.chatBucket.take()) return fail(ERROR.RATE, "Slow down.");
        const out = { type: "chat", from: m.id, name: m.name, text: msg.text, private: !!msg.to };
        if (msg.to) {
          if (!r.order.includes(msg.to)) return fail(ERROR.NOT_FOUND, "That player is not in the room.");
          send(members.get(msg.to), out);
        } else sendRoom(r, out, m.id);
        return reply();
      }
      case "settings": {
        if (!owner) return fail(ERROR.NOT_OWNER, "Only the room's owner can change that.");
        if (r.state !== ROOM_STATE.LOBBY) return fail(ERROR.STATE, "Not during a race.");
        const s = r.settings;
        const trackChanged = msg.track !== undefined && (msg.track?.sit !== s.track?.sit || msg.track?.crc !== s.track?.crc);
        for (const k of ["track", "laps", "weather", "mode", "computers", "damage", "collisions"]) if (msg[k] !== undefined) s[k] = msg[k];
        if (r.classic) { s.computers = 0; s.mode = ""; }
        if (trackChanged) for (const id of r.order) members.get(id).content = null;
        sendRoom(r, { type: "room", room: roomView(r) });
        return reply();
      }
      case "kick": {
        if (!owner) return fail(ERROR.NOT_OWNER, "Only the room's owner can do that.");
        const target = members.get(msg.member);
        if (!target || target.room !== r || target === m) return fail(ERROR.NOT_FOUND, "That player is not in the room.");
        send(target, { type: "kicked", reason: "removed" });
        exit(target, "removed");
        return reply();
      }
      case "start": {
        if (!owner) return fail(ERROR.NOT_OWNER, "Only the room's owner can start.");
        if (r.state !== ROOM_STATE.LOBBY) return fail(ERROR.STATE, "The room is racing.");
        if (!r.settings.track) return fail(ERROR.STATE, "Choose a track first.");
        const notReady = r.order.map((x) => members.get(x)).filter((x) => x !== m && !x.ready);
        if (notReady.length) return fail(ERROR.STATE, `Not ready: ${notReady.map((x) => x.name).join(", ")}.`);
        startRace(r, m, msg);
        return reply();
      }
      case "loaded": {
        if (r.state !== ROOM_STATE.LOADING) return reply();
        r.race.loaded.add(m.id);
        checkBarriers(r);
        return reply();
      }
      case "race": {
        if (!r.race) return;
        const e = msg.e;
        if (e.kind === "positions" || e.kind === "mode") { if (!owner) return; }
        else if (e.kind !== "go" && !owns(r, m, e.vehicle)) return;
        if (e.kind === "gone") { if (!r.race.gone.has(e.vehicle)) goneVehicle(r, e.vehicle); checkBarriers(r); return; }
        sendRoom(r, { type: "race", from: m.id, e }, m.id);
        return;
      }
      case "result": {
        if (!r.race?.synced) return reply();
        const mine = r.race.entrants.find((x) => x.member === m.id);
        if (!mine) return reply();
        r.race.results.set(mine.vehicle, { laps: msg.laps, total: msg.total, best: msg.best, lapsLed: msg.lapsLed ?? 0 });
        if (!r.race.resultsTimer) {
          const race = r.race;
          race.resultsTimer = setTimeout(() => { if (r.race === race) endRace(r); }, cfg.resultsTimeoutS * 1000);
          race.resultsTimer.unref?.();
        }
        checkBarriers(r);
        return reply();
      }
      default:
        return fail(ERROR.BAD_REQUEST, "Unknown message.");
    }
  }

  function binary(m, bytes) {
    const r = m.room;
    if (!r?.race?.synced) return;
    const s = decodeState(bytes);
    if (!s || !owns(r, m, s.vehicle) || r.race.gone.has(s.vehicle)) return;
    const ownedCount = r.race.entrants.filter((e) => owns(r, m, e.vehicle)).length;
    m.stateBucket.setRate(STATE_MAX_HZ * ownedCount, STATE_MAX_HZ * ownedCount);
    if (!m.stateBucket.take()) return;
    if (r.classic) hooks.state?.(r, bytes, m);
    for (const id of r.order) {
      if (id === m.id) continue;
      const other = members.get(id);
      if (other && !other.gone) { other.client.send(bytes); counters.framesRelayed++; }
    }
  }

  // ---- Connections ----

  function connect(client, { classic = false } = {}) {
    if (members.size >= cfg.maxMembers) { client.close(CLOSE.TOO_MANY, "The server is full"); return { text() {}, binary() {}, closed() {} }; }
    counters.connections++;
    const m = {
      id: nextMember++, client, ip: client.ip ?? "", hello: false, baseName: "", name: "", clientName: "",
      truck: "", skill: 1, location: 5, ready: false, team: 0, latency: null, content: null, room: null, gone: false,
      bucket: createBucket(cfg.messagesPerSecond, cfg.messagesPerSecond * 2, now),
      chatBucket: createBucket(cfg.chatPerSecond, cfg.chatPerSecond * 3, now),
      stateBucket: createBucket(STATE_MAX_HZ, STATE_MAX_HZ, now),
      strikes: 0, classic,
    };
    members.set(m.id, m);
    if (draining) send(m, { type: "shutdown", text: draining.text, inMs: Math.max(0, draining.at - now()) });
    return {
      id: m.id,
      text(data) {
        if (m.gone) return;
        if (!m.bucket.take()) {
          // A client that keeps flooding is dropped.
          if (++m.strikes > cfg.messagesPerSecond * 4) { client.close(CLOSE.RATE, "Too many messages"); return; }
          return error(m, undefined, ERROR.RATE, "Too many messages.");
        }
        if (typeof data !== "string" || data.length > LIMITS.textFrame) return error(m, undefined, ERROR.BAD_REQUEST, "Message too long.");
        let parsed;
        try { parsed = JSON.parse(data); } catch { return error(m, undefined, ERROR.BAD_REQUEST, "Not JSON."); }
        const checked = checkClient(parsed);
        if (!checked.ok) return error(m, Number.isInteger(parsed?.id) ? parsed.id : undefined, checked.code, checked.message);
        // Runs at once up to its first wait (only making a classic room waits), so messages keep their order.
        handle(m, checked.message).catch((err) => {
          log("error", "message failed", { member: m.id, type: checked.message.type, error: err.message });
          error(m, checked.message.id, ERROR.BAD_REQUEST, "The server could not do that.");
        });
      },
      binary(bytes) { if (!m.gone && m.hello) binary(m, bytes); },
      closed() {
        if (m.gone) return;
        exit(m, "disconnected");
        m.gone = true;
        members.delete(m.id);
      },
    };
  }

  // ---- The daemon's side ----

  return {
    connect,
    /** Public rooms, as `list` answers them (and GET /rooms). */
    list: () => [...rooms.values()].filter((x) => x.public).map(summary),
    /** Every room, for admins. */
    all: () => [...rooms.values()].map((r) => ({ ...summary(r), public: r.public, members: r.order.map((id) => ({ id, name: members.get(id).name, ip: members.get(id).ip })) })),
    status: () => ({
      name: cfg.name, version, protocol: ROOM_PROTOCOL, uptimeS: Math.round((now() - started) / 1000), rooms: rooms.size,
      players: members.size, racing: [...rooms.values()].filter((r) => r.state !== ROOM_STATE.LOBBY).length, draining: !!draining, ...counters,
    }),
    closeRoom,
    /** A room as its members see it, or null. */
    view: (code) => (rooms.has(code) ? roomView(rooms.get(code)) : null),
    /** Close one member's connection (admin kick). */
    kick(id, code = CLOSE.KICKED, reason = "Removed by the server") {
      const m = members.get(id);
      if (!m) return false;
      m.client.close(code, reason);
      return true;
    },
    /** Close every connection from an IP (after a ban). */
    dropIp(ip, code = CLOSE.BANNED, reason = "Banned") {
      let n = 0;
      for (const m of members.values()) if (m.ip === ip) { m.client.close(code, reason); n++; }
      return n;
    },
    /** New settings (SIGHUP): limits apply to new rooms and messages from now on. */
    reconfigure(next) {
      cfg = { ...ROOM_DEFAULTS, ...next };
      for (const m of members.values()) { m.bucket.setRate(cfg.messagesPerSecond, cfg.messagesPerSecond * 2); m.chatBucket.setRate(cfg.chatPerSecond, cfg.chatPerSecond * 3); }
    },
    /** Stop taking new rooms and tell everyone; resolves when no race is running or after `maxMs`. */
    drain({ text = "The server is shutting down.", maxMs = 60000 } = {}) {
      draining = { text, at: now() + maxMs };
      for (const m of members.values()) send(m, { type: "shutdown", text, inMs: maxMs });
      return new Promise((resolve) => {
        const check = () => {
          const racing = [...rooms.values()].some((r) => r.state !== ROOM_STATE.LOBBY);
          if (!racing || now() >= draining.at) { clearInterval(timer); resolve(); }
        };
        const timer = setInterval(check, 250);
        check();
      });
    },
    /** Close every connection (end of a drain). */
    closeAll(code = 1001, reason = "Server shutting down") {
      for (const m of [...members.values()]) m.client.close(code, reason);
      for (const r of rooms.values()) clearRace(r);
    },
    get members() { return members.size; },
  };
}

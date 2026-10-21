/*
  A DirectPlay 4 node over TCP/IP: finds, hosts and joins sessions and carries game messages, as
  [MC-DPL4CS] section 3 describes (the host's duties in 3.2). One machine, one system player and
  one game player, which is all Monster Truck Madness 2 uses; a host may hold more game players
  (`addLocalPlayer`), as the room server's gateway does for the players of a room.

      const dp = createDirectPlay({ application: "{6CD1C6E0-96FB-11D1-A268-00A024F2C995}" });
      await dp.start();
      const sessions = await dp.enumerate("192.168.1.20");
      await dp.join(sessions[0], { playerName: "Juan" });        // or dp.host({ name, playerName })
      dp.on("message", ({ from, payload }) => ...);
      dp.send(0, bytes, { guaranteed: false });                  // 0: every other player

  Events: "player" { id, name, joined, local, ip }, "message" { from, to, payload }, "host" { id, local },
  "lost" { reason }, "log" (text).

  Topology is a full mesh: every machine reaches every other on the TCP and UDP ports it
  advertises, so this machine must accept connections on its own (PORT_RANGE, and ENUM_PORT when
  hosting). Node only; no dependencies.
*/
import { EventEmitter } from "node:events";
import net from "node:net";
import dgram from "node:dgram";
import { randomBytes, randomInt } from "node:crypto";
import {
  CMD, ENUM, ENUM_PORT, PORT_RANGE, PLAYER, SESSION, VERSION, DPERR, guidBytes, guidText, frame,
  splitDatagram, createStreamReader, isSystem, decodeSystem, decodePlayerMessage, encode, playerMessage, createIdAllocator,
} from "./codec.js";

/** Time-outs (3.1.2): a request waits 5 s; enumeration waits 1 s by default (MTM2 asks for 1000 ms). */
const REQUEST_MS = 5000, ADDFORWARD_MS = 15000, PING_MS = 35000, PING_TRIES = 8;

const sameGuid = (a, b) => a.length === 16 && b.length === 16 && a.every((x, i) => x === b[i]);
const cleanIp = (ip) => String(ip ?? "").replace(/^::ffff:/, "");

/**
 * @param {{ application: string, version?: number, bind?: string, tcpPorts?: number[], udpPorts?: number[],
 *   enumPort?: number, tickMs?: () => number, now?: () => number }} options
 *   `enumPort` lets tests run two nodes on one machine.
 */
export function createDirectPlay(options) {
  const events = new EventEmitter();
  const application = guidBytes(options.application);
  const version = options.version ?? VERSION.DX9;
  const bind = options.bind ?? "0.0.0.0";
  const enumPort = options.enumPort ?? ENUM_PORT;
  const tick = options.tickMs ?? (() => Math.trunc(performance.now()) >>> 0);
  const log = (text) => events.emit("log", text);

  let tcpServer = null, udp = null, enumUdp = null, enumTcp = null;
  let tcpPort = 0, udpPort = 0;
  /** Outgoing TCP connections by "ip:port". */
  const outgoing = new Map();
  const incoming = new Set();
  /** Replies awaited: `{ cmd, resolve, reject, timer, match }`. */
  const waiting = new Set();
  /** Enumeration in progress: instance GUID text -> session. */
  let enumerating = null;

  // ---- Session state ----
  let session = null; // { desc, name, password, hostId, isHost, ids? }
  /** Every player by ID: `{ id, flags, shortName, longName, tcp, udp, systemPlayerId, version, local, chatter, pings }`. */
  const players = new Map();
  let systemId = 0, playerId = 0;
  let lastLocalCreate = 0;
  let pingTimer = null;

  // ---- Sockets ----

  async function listenRange(make, range) {
    const [lo, hi] = range;
    for (let port = lo; port <= hi; port++) {
      try {
        return await make(port);
      } catch (err) {
        if (err.code !== "EADDRINUSE" && err.code !== "EACCES") throw err;
      }
    }
    throw new Error(`No free port in ${lo}-${hi}`);
  }
  const listenTcp = (port, onSocket) => new Promise((resolve, reject) => {
    const server = net.createServer(onSocket);
    server.once("error", reject);
    server.listen(port, bind, () => { server.off("error", reject); resolve(server); });
  });
  const bindUdp = (port, onMessage) => new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: "udp4", reuseAddr: false });
    sock.once("error", reject);
    sock.on("message", onMessage);
    sock.bind(port, bind, () => {
      sock.off("error", reject);
      sock.on("error", (err) => log(`udp: ${err.message}`));
      try { sock.setBroadcast(true); } catch { /* not needed for unicast */ }
      resolve(sock);
    });
  });

  function acceptTcp(socket) {
    incoming.add(socket);
    const ip = cleanIp(socket.remoteAddress);
    const read = createStreamReader(({ prefix: p, body }) => receive(body, { ip, port: p.sockaddr.port, via: "tcp", prefix: p }));
    socket.on("data", (chunk) => {
      try { read(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)); } catch (err) { log(`tcp from ${ip}: ${err.message}`); socket.destroy(); }
    });
    socket.on("error", () => {});
    socket.on("close", () => incoming.delete(socket));
  }

  function onDatagram(msg, rinfo) {
    const bytes = new Uint8Array(msg.buffer, msg.byteOffset, msg.byteLength);
    const { prefix: p, body } = splitDatagram(bytes);
    receive(body, { ip: cleanIp(rinfo.address), port: p?.sockaddr.port ?? 0, udpPort: rinfo.port, via: "udp", prefix: p });
  }

  /** An outgoing connection to a TCP address, made on first use; messages wait until it connects. */
  function connection(ip, port) {
    const key = `${ip}:${port}`;
    let c = outgoing.get(key);
    if (c && !c.dead) return c;
    const socket = net.createConnection({ host: ip, port });
    c = { socket, ready: false, queue: [], dead: false };
    outgoing.set(key, c);
    socket.setNoDelay(true);
    socket.on("connect", () => { c.ready = true; for (const b of c.queue.splice(0)) socket.write(b); });
    socket.on("error", (err) => { log(`connect ${key}: ${err.message}`); c.dead = true; });
    socket.on("close", () => { c.dead = true; if (outgoing.get(key) === c) outgoing.delete(key); lostConnection(ip, port); });
    // What the other side sends back on our own connection is read too.
    const read = createStreamReader(({ prefix: p, body }) => receive(body, { ip, port: p.sockaddr.port, via: "tcp", prefix: p }));
    socket.on("data", (chunk) => { try { read(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)); } catch { socket.destroy(); } });
    return c;
  }
  function sendTcp(ip, port, body) {
    if (!ip || !port) return;
    const c = connection(ip, port);
    const bytes = Buffer.from(frame(body, tcpPort));
    if (c.ready) c.socket.write(bytes); else c.queue.push(bytes);
  }
  function sendUdp(ip, port, bytes) {
    if (!ip || !port || !udp) return;
    udp.send(Buffer.from(bytes), port, ip);
  }
  const sendSystemUdp = (ip, port, body) => sendUdp(ip, port, frame(body, tcpPort));

  // ---- Players ----

  const machines = () => [...players.values()].filter((p) => p.flags & PLAYER.SYSTEM);
  const remoteMachines = () => machines().filter((p) => !p.local);
  const playerName = (p) => p.longName || p.shortName;
  /** A player record from what a message described, its addresses completed with where the message came from. */
  function record(info, fromIp) {
    const fix = (a) => (a ? { port: a.port, ip: a.ip && a.ip !== "0.0.0.0" ? a.ip : fromIp } : null);
    return {
      id: info.id, flags: info.flags & ~PLAYER.LOCAL, shortName: info.shortName ?? "", longName: info.longName ?? "",
      tcp: fix(info.tcp), udp: fix(info.udp), systemPlayerId: info.systemPlayerId ?? info.id,
      version: info.version ?? version, local: false, chatter: 0, pings: 0,
    };
  }
  function addPlayer(p) {
    const known = players.has(p.id);
    players.set(p.id, p);
    if (session?.isHost && session.ids) session.ids.claim(p.id);
    if (!known && !(p.flags & PLAYER.SYSTEM)) events.emit("player", { id: p.id, name: playerName(p), joined: true, local: p.local, ip: p.local ? null : machineOf(p.id)?.tcp?.ip ?? p.tcp?.ip ?? null });
    return !known;
  }
  function removePlayer(id) {
    const p = players.get(id);
    if (!p) return;
    players.delete(id);
    session?.ids?.release(id);
    if (!(p.flags & PLAYER.SYSTEM)) events.emit("player", { id, name: playerName(p), joined: false, local: p.local });
    else for (const q of [...players.values()]) if (q.systemPlayerId === id && q.id !== id) removePlayer(q.id);
  }
  const machineOf = (id) => {
    const p = players.get(id);
    return p && (p.flags & PLAYER.SYSTEM ? p : players.get(p.systemPlayerId));
  };
  /** Our own players as the messages describe them (addresses at 0.0.0.0: "where this came from"). */
  const own = (id, flags, name) => ({
    id, flags, shortName: name, longName: name, systemPlayerId: systemId, version,
    tcp: { port: tcpPort, ip: 0 }, udp: { port: udpPort, ip: 0 },
  });
  /** A system player as other machines are told of it (the host fills in addresses). */
  const described = (p) => ({ ...p, tcp: p.local ? { port: tcpPort, ip: 0 } : p.tcp, udp: p.local ? { port: udpPort, ip: 0 } : p.udp });

  // ---- Requests ----

  function expect(cmd, match = () => true, ms = REQUEST_MS) {
    return new Promise((resolve, reject) => {
      const w = { cmd, match, resolve, reject };
      w.timer = setTimeout(() => { waiting.delete(w); reject(new Error(`No reply (${cmd})`)); }, ms);
      waiting.add(w);
    });
  }
  function settle(msg, from) {
    for (const w of waiting) {
      if (w.cmd !== msg.cmd || !w.match(msg, from)) continue;
      waiting.delete(w);
      clearTimeout(w.timer);
      w.resolve({ msg, from });
      return true;
    }
    return false;
  }

  // ---- Receiving ----

  function receive(body, from) {
    if (!body.length) return;
    if (!isSystem(body)) {
      let m;
      try { m = decodePlayerMessage(body); } catch { return; }
      const machine = machineOf(m.from);
      if (machine) machine.chatter++;
      if (m.to && m.to !== systemId && !players.get(m.to)?.local) return;
      if (!session) return;
      events.emit("message", { from: m.from, to: m.to, payload: m.payload });
      return;
    }
    let msg;
    try { msg = decodeSystem(body); } catch { return; }
    if (msg.cmd === CMD.PLAYERWRAPPER) return receive(msg.message, from);
    try {
      handle(msg, from);
    } catch (err) {
      log(`message ${msg.cmd} from ${from.ip}: ${err.message}`);
    }
  }

  function handle(msg, from) {
    if (settle(msg, from)) return;
    switch (msg.cmd) {
      case CMD.ENUMSESSIONS:
        return onEnumSessions(msg, from);
      case CMD.ENUMSESSIONSREPLY:
        return onEnumSessionsReply(msg, from);
      case CMD.REQUESTPLAYERID:
        return onRequestPlayerId(msg, from);
      case CMD.ADDFORWARDREQUEST:
        return onAddForwardRequest(msg, from);
      case CMD.ADDFORWARD:
        // A new machine (3.1.5.10): remember it and acknowledge to the host.
        if (!session) return;
        addPlayer(record(msg.player, from.ip));
        hostSend(encode.addForwardAck({ id: msg.playerId }, version));
        return;
      case CMD.CREATEPLAYER:
      case CMD.CREATEPLAYERVERIFY:
        return onCreatePlayer(msg, from);
      case CMD.DELETEPLAYER:
        if (players.get(msg.playerId)?.local) return;
        removePlayer(msg.playerId);
        afterLoss();
        return;
      case CMD.PING: {
        const p = players.get(msg.fromId);
        if (!p) {
          if (session?.isHost) sendTcp(from.ip, from.port, encode.youAreDead({}, version));
          return;
        }
        machineOf(msg.fromId).chatter++;
        const m = machineOf(msg.fromId);
        sendTcp(m.tcp.ip, m.tcp.port, encode.pingReply({ fromId: msg.fromId, tick: msg.tick }, version));
        return;
      }
      case CMD.PINGREPLY:
        // The reply echoes our own ID: credit the machine it came from.
        for (const q of remoteMachines()) if (q.tcp.ip === from.ip && (!from.port || q.tcp.port === from.port)) { q.chatter++; q.pings = 0; }
        return;
      case CMD.IAMNAMESERVER:
        if (!session) return;
        if (session.isHost) { sendTcp(from.ip, msg.tcp?.port || from.port, encode.youAreDead({}, version)); return; }
        setHost(msg.hostId);
        return;
      case CMD.YOUAREDEAD:
        close("removed");
        return;
      case CMD.SESSIONDESCCHANGED:
        if (session && !session.isHost) { session.desc = msg.desc; if (msg.name) session.name = msg.name; }
        return;
      default:
        return;
    }
  }

  // ---- Finding games (3.1.4.1, 3.2.5.3) ----

  async function enumerate(hostIp, { timeoutMs = 1000, password = "", all = false } = {}) {
    await start();
    enumerating = new Map();
    const body = encode.enumSessions({ application, flags: all ? ENUM.ALL : ENUM.AVAILABLE, password }, version);
    // The request goes over UDP to the host's port 47624 (broadcast without an address); some hosts listen over TCP there too.
    const target = hostIp || "255.255.255.255";
    sendSystemUdp(target, enumPort, body);
    if (hostIp) {
      const s = net.createConnection({ host: hostIp, port: enumPort });
      s.on("error", () => {});
      s.on("connect", () => { s.write(Buffer.from(frame(body, tcpPort))); setTimeout(() => s.end(), 200); });
    }
    await new Promise((r) => setTimeout(r, timeoutMs));
    const found = [...enumerating.values()];
    enumerating = null;
    return found;
  }
  function onEnumSessionsReply(msg, from) {
    if (!enumerating || !sameGuid(msg.desc.application, application)) return;
    const key = guidText(msg.desc.instance);
    // The reply's prefix holds the port joiners must reach the host on.
    enumerating.set(key, {
      name: msg.name, instance: key, maxPlayers: msg.desc.maxPlayers, currentPlayers: msg.desc.currentPlayers,
      flags: msg.desc.flags, user: msg.desc.user, host: { ip: from.ip, port: from.port }, version: msg.version, desc: msg.desc,
    });
  }
  function onEnumSessions(msg, from) {
    if (!session?.isHost || !sameGuid(msg.application, application)) return;
    const d = session.desc;
    const full = gamePlayerCount() >= d.maxPlayers;
    if ((msg.flags & ENUM.AVAILABLE) && (full || d.flags & (SESSION.JOINDISABLED | SESSION.NEWPLAYERSDISABLED))) return;
    if (session.password && !(msg.flags & ENUM.PASSWORDREQUIRED) && msg.password !== session.password) return;
    sendTcp(from.ip, from.port, encode.enumSessionsReply({ desc: currentDesc(), name: session.name }, version));
  }

  const gamePlayerCount = () => [...players.values()].filter((p) => !(p.flags & PLAYER.SYSTEM)).length;
  const currentDesc = () => ({ ...session.desc, currentPlayers: gamePlayerCount() });

  // ---- Hosting (3.2) ----

  /** Host a session: `{ name, playerName, maxPlayers = 8, flags, password, user }`. MTM2's flags are 0x46. */
  async function host({ name, playerName: me, maxPlayers = 8, flags = SESSION.KEEPALIVE | SESSION.MIGRATEHOST | 0x2, password = "", user = [0, 0, 0, 0] }) {
    if (session) throw new Error("Already in a session");
    await start();
    const key = randomBytes(4).readUInt32LE(0);
    session = {
      isHost: true, name, password, hostId: 0,
      desc: { flags, instance: randomBytes(16), application, maxPlayers, currentPlayers: 0, reserved1: key, reserved2: 0, user },
      ids: createIdAllocator(key, randomInt(0, 0x10000)),
    };
    await openEnumPorts();
    systemId = session.ids.next();
    session.hostId = systemId;
    players.set(systemId, { ...own(systemId, PLAYER.SYSTEM | PLAYER.NAMESERVER | PLAYER.INGROUP, ""), local: true, chatter: 0, pings: 0 });
    // A host with no player of its own (playerName null) adds them later with addLocalPlayer.
    if (me !== null && me !== undefined) {
      playerId = session.ids.next();
      addPlayer({ ...own(playerId, 0, me), local: true, chatter: 0, pings: 0 });
    }
    startPings();
    events.emit("host", { id: systemId, local: true });
    return { systemId, playerId };
  }
  async function openEnumPorts() {
    if (enumUdp) return;
    enumUdp = await bindUdp(enumPort, onDatagram);
    try { enumTcp = await listenTcp(enumPort, acceptTcp); } catch (err) { log(`TCP ${enumPort}: ${err.message}`); }
  }
  function onRequestPlayerId(msg, from) {
    if (!session?.isHost) return;
    const system = !!(msg.flags & PLAYER.SYSTEM);
    const d = session.desc;
    const refused = gamePlayerCount() >= d.maxPlayers
      || (system ? d.flags & SESSION.JOINDISABLED : d.flags & SESSION.NEWPLAYERSDISABLED);
    const id = refused ? 0 : session.ids.next();
    // The reply goes to the requester's own TCP port (its prefix).
    sendTcp(from.ip, from.port, encode.requestPlayerReply({ id, result: refused ? DPERR.NONEWPLAYERS : DPERR.OK }, version));
  }
  function onAddForwardRequest(msg, from) {
    if (!session?.isHost) return;
    if (session.password && msg.password !== session.password) {
      sendTcp(from.ip, from.port, encode.addForwardReply({ error: 0x88770154 /* DPERR_INVALIDPASSWORD */ }, version));
      return;
    }
    const joiner = record({ ...msg.player, id: msg.playerId }, from.ip);
    // <22>: the address is the sender's, the port the one its message said.
    joiner.tcp = { ip: from.ip, port: msg.player.tcp?.port || from.port };
    joiner.udp = { ip: from.ip, port: msg.player.udp?.port || 0 };
    joiner.flags = PLAYER.SYSTEM | PLAYER.INGROUP;
    const others = remoteMachines();
    addPlayer(joiner);
    const reply = () => sendTcp(joiner.tcp.ip, joiner.tcp.port, encode.superEnumPlayersReply({
      desc: currentDesc(), name: session.name, password: session.password, players: [...players.values()].map(described),
    }, version));
    if (!others.length) return reply();
    // Tell the others, wait for each to acknowledge (3.2.5.5, 3.2.5.6), then answer the joiner.
    const acks = others.map((m) => expect(CMD.ADDFORWARDACK, (a, f) => a.id === joiner.id && f.ip === m.tcp.ip, ADDFORWARD_MS).catch(() => null));
    for (const m of others) sendTcp(m.tcp.ip, m.tcp.port, encode.addForward({ toId: m.id, playerId: joiner.id, player: joiner }, version));
    Promise.all(acks).then(reply);
  }

  // ---- Joining (3.1.4.2, 3.1.5.1, 3.1.5.7) ----

  /** Join a session `enumerate` found, as `playerName`. Resolves when this machine's game player exists everywhere. */
  async function join(found, { playerName: me, password = "" }) {
    if (session) throw new Error("Already in a session");
    await start();
    const hostAddr = found.host;
    const ask = expect(CMD.REQUESTPLAYERREPLY);
    sendTcp(hostAddr.ip, hostAddr.port, encode.requestPlayerId({ flags: PLAYER.SYSTEM | PLAYER.LOCAL }, version));
    const { msg: idReply } = await ask;
    if (idReply.result) throw new Error(idReply.result === DPERR.NONEWPLAYERS ? "The session is full." : `Refused (0x${idReply.result.toString(16)})`);
    systemId = idReply.id;
    const enumReply = expect(CMD.SUPERENUMPLAYERSREPLY, () => true, ADDFORWARD_MS + REQUEST_MS);
    const failed = expect(CMD.ADDFORWARDREPLY, () => true, ADDFORWARD_MS + REQUEST_MS).then(({ msg }) => { throw new Error(`Join refused (0x${msg.error.toString(16)})`); }, () => new Promise(() => {}));
    sendTcp(hostAddr.ip, hostAddr.port, encode.addForwardRequest({
      toId: 0, playerId: systemId, player: own(systemId, PLAYER.SYSTEM | PLAYER.INGROUP | PLAYER.LOCAL, ""), password, tick: tick(),
    }, version));
    const { msg: table, from } = await Promise.race([enumReply, failed]);
    session = { isHost: false, name: table.name || found.name, password, desc: table.desc, hostId: 0, ids: null };
    for (const p of table.players) {
      if (p.id === systemId) continue;
      // The host's own players come with address 0.0.0.0: the host's.
      const r = record(p, hostAddr.ip);
      if (p.flags & PLAYER.NAMESERVER) session.hostId = p.id;
      addPlayer(r);
    }
    players.set(systemId, { ...own(systemId, PLAYER.SYSTEM | PLAYER.INGROUP, ""), local: true, chatter: 0, pings: 0 });
    // Now the game player (3.1.4.4): an ID from the host, then CREATEPLAYER to every machine.
    const ask2 = expect(CMD.REQUESTPLAYERREPLY);
    hostSend(encode.requestPlayerId({ flags: PLAYER.LOCAL }, version));
    const { msg: id2 } = await ask2;
    if (id2.result) throw new Error("The session is full.");
    playerId = id2.id;
    const mine = { ...own(playerId, 0, me), local: true, chatter: 0, pings: 0 };
    addPlayer(mine);
    lastLocalCreate = Date.now();
    for (const m of remoteMachines()) sendTcp(m.tcp.ip, m.tcp.port, encode.createPlayer({ playerId, player: own(playerId, 0, me) }, version));
    startPings();
    events.emit("host", { id: session.hostId, local: false });
    return { systemId, playerId };
  }
  function hostSend(body) {
    const h = players.get(session?.hostId);
    if (h && !h.local) sendTcp(h.tcp.ip, h.tcp.port, body);
  }
  function onCreatePlayer(msg, from) {
    if (!session) return;
    const p = record({ ...msg.player, id: msg.playerId }, from.ip);
    const m = players.get(p.systemPlayerId);
    if (m) { p.tcp = m.tcp; p.udp = m.udp; }
    const isNew = addPlayer(p);
    // 2.2.22: a DX8 or later machine is told of our recent player again, in case it missed it.
    if (isNew && msg.cmd === CMD.CREATEPLAYER && msg.version >= VERSION.DX8 && !session.isHost && !(p.flags & PLAYER.SYSTEM)
      && Date.now() - lastLocalCreate < 40000 && m) {
      const mine = players.get(playerId);
      sendTcp(m.tcp.ip, m.tcp.port, encode.createPlayerVerify({ playerId, player: own(playerId, 0, playerName(mine)) }, version));
    }
  }

  // ---- Sending game messages (3.1.4.16) ----

  /**
   * Send game bytes to a player, or to every other player with `to` 0 (the game's DPID_ALLPLAYERS). Guaranteed goes over
   * TCP, the rest over UDP. Each receiving player gets its own copy addressed to it.
   */
  function send(to, payload, { guaranteed = false, from = playerId } = {}) {
    if (!session || !from || !players.get(from)?.local) return 0;
    const targets = to ? [players.get(to)].filter(Boolean) : [...players.values()].filter((p) => !p.local && !(p.flags & PLAYER.SYSTEM));
    let sent = 0;
    for (const p of targets) {
      const m = machineOf(p.id);
      if (!m || m.local) continue;
      const body = playerMessage(from, p.id, payload, version);
      if (guaranteed || isSystem(body)) sendTcp(m.tcp.ip, m.tcp.port, body);
      else sendUdp(m.udp.ip, m.udp.port, body);
      sent++;
    }
    return sent;
  }

  // ---- More players on this machine (the host only) ----

  /** A game player of this machine, made known to every other machine (3.1.4.4). Returns its ID. */
  function addLocalPlayer(name) {
    if (!session?.isHost) throw new Error("Only the host adds players here");
    const id = session.ids.next();
    addPlayer({ ...own(id, 0, name), local: true, chatter: 0, pings: 0 });
    for (const m of remoteMachines()) sendTcp(m.tcp.ip, m.tcp.port, encode.createPlayer({ playerId: id, player: own(id, 0, name) }, version));
    return id;
  }
  /** Remove one of this machine's game players everywhere (3.1.4.5). */
  function removeLocalPlayer(id) {
    const p = players.get(id);
    if (!p?.local || p.flags & PLAYER.SYSTEM) return false;
    for (const m of remoteMachines()) sendTcp(m.tcp.ip, m.tcp.port, encode.deletePlayer({ playerId: id }, version));
    removePlayer(id);
    return true;
  }
  /** Remove a remote player's machine from the session (the host only): it is told so, the others delete its players. */
  function removeRemote(id) {
    const m = machineOf(id);
    if (!session?.isHost || !m || m.local) return false;
    sendTcp(m.tcp.ip, m.tcp.port, encode.youAreDead({}, version));
    dropMachine(m.id, "removed");
    return true;
  }

  // ---- Keepalive and host migration (3.1.2.5, 3.1.6.2, 3.1.7.1, 3.2.2.2) ----

  function startPings() {
    if (pingTimer || !(session.desc.flags & SESSION.KEEPALIVE)) return;
    pingTimer = setInterval(pingRound, options.pingMs ?? PING_MS);
    pingTimer.unref?.();
  }
  function pingRound() {
    if (!session) return;
    // The host pings every quiet machine; the others ping only the host.
    const targets = session.isHost ? remoteMachines() : [players.get(session.hostId)].filter((m) => m && !m.local);
    for (const m of targets) {
      if (m.chatter > 0) { m.chatter = 0; m.pings = 0; continue; }
      if (++m.pings > PING_TRIES) { dropMachine(m.id, "no answer"); continue; }
      sendTcp(m.tcp.ip, m.tcp.port, encode.ping({ fromId: systemId, tick: tick() }, version));
    }
  }
  function dropMachine(id, why) {
    log(`machine ${id >>> 0} gone (${why})`);
    if (session?.isHost) {
      const ids = [...players.values()].filter((p) => p.systemPlayerId === id || p.id === id).map((p) => p.id);
      for (const pid of ids) for (const m of remoteMachines()) if (m.id !== id) sendTcp(m.tcp.ip, m.tcp.port, encode.deletePlayer({ playerId: pid }, version));
    }
    removePlayer(id);
    afterLoss();
  }
  /** A connection closed: when it was the only way to a machine, that machine has left. */
  function lostConnection(ip, port) {
    if (!session) return;
    for (const m of remoteMachines()) {
      if (m.tcp.ip !== ip || m.tcp.port !== port) continue;
      // Try once more; a refused connection means it is gone.
      const probe = net.createConnection({ host: ip, port });
      probe.on("connect", () => probe.end());
      probe.on("error", () => { if (players.has(m.id)) dropMachine(m.id, "connection lost"); });
    }
  }
  /** After a machine left: was it the host? */
  function afterLoss() {
    if (!session || session.isHost || players.has(session.hostId)) return;
    if (!(session.desc.flags & SESSION.MIGRATEHOST)) { close("session lost"); return; }
    // The system player with the lowest ID left becomes the host.
    const lowest = machines().map((m) => m.id >>> 0).sort((a, b) => a - b)[0];
    if (lowest === systemId >>> 0) becomeHost();
  }
  async function becomeHost() {
    session.isHost = true;
    session.hostId = systemId;
    session.ids = createIdAllocator(session.desc.reserved1, randomInt(0, 0x10000));
    for (const id of players.keys()) session.ids.claim(id);
    players.get(systemId).flags |= PLAYER.NAMESERVER;
    try { await openEnumPorts(); } catch (err) { log(`enumeration port: ${err.message}`); }
    for (const m of remoteMachines()) sendTcp(m.tcp.ip, m.tcp.port, encode.iAmNameServer({ toId: m.id, hostId: systemId, tcpPort, udpPort }, version));
    events.emit("host", { id: systemId, local: true });
  }
  function setHost(id) {
    if (!session) return;
    const old = players.get(session.hostId);
    if (old) old.flags &= ~PLAYER.NAMESERVER;
    session.hostId = id;
    const h = players.get(id);
    if (h) h.flags |= PLAYER.NAMESERVER;
    events.emit("host", { id, local: false });
  }

  // ---- Life cycle ----

  async function start() {
    if (tcpServer) return { tcpPort, udpPort };
    tcpServer = await listenRange((port) => listenTcp(port, acceptTcp), options.tcpPorts ?? PORT_RANGE.tcp);
    tcpPort = tcpServer.address().port;
    udp = await listenRange((port) => bindUdp(port, onDatagram), options.udpPorts ?? PORT_RANGE.udp);
    udpPort = udp.address().port;
    return { tcpPort, udpPort };
  }
  /** Leave the session: our players are deleted on every machine (3.1.4.5), then everything closes down. */
  function leave() {
    if (!session) return;
    const mine = [...players.values()].filter((p) => p.local && !(p.flags & PLAYER.SYSTEM)).map((p) => p.id);
    for (const m of remoteMachines()) {
      for (const id of [...mine, systemId]) if (id) sendTcp(m.tcp.ip, m.tcp.port, encode.deletePlayer({ playerId: id }, version));
    }
    resetSession();
  }
  function resetSession() {
    session = null;
    players.clear();
    systemId = playerId = 0;
    clearInterval(pingTimer);
    pingTimer = null;
    for (const w of waiting) { clearTimeout(w.timer); w.reject(new Error("Left the session")); }
    waiting.clear();
    // Let pending writes (the deletes) go out before the connections close.
    setTimeout(() => { for (const c of outgoing.values()) c.socket.end(); outgoing.clear(); }, 200).unref?.();
    enumUdp?.close(); enumUdp = null;
    enumTcp?.close(); enumTcp = null;
  }
  function close(reason) {
    const was = !!session;
    resetSession();
    if (was) events.emit("lost", { reason });
  }
  async function stop() {
    leave();
    await new Promise((r) => setTimeout(r, 250));
    for (const s of incoming) s.destroy();
    for (const c of outgoing.values()) c.socket.destroy();
    tcpServer?.close(); tcpServer = null;
    udp?.close(); udp = null;
    enumUdp?.close(); enumUdp = null;
    enumTcp?.close(); enumTcp = null;
  }

  return {
    on: (name, fn) => { events.on(name, fn); return () => events.off(name, fn); },
    start, stop, enumerate, host, join, leave, send, addLocalPlayer, removeLocalPlayer, removeRemote,
    ports: () => ({ tcpPort, udpPort }),
    self: () => ({ systemId, playerId }),
    isHost: () => !!session?.isHost,
    hostId: () => session?.hostId ?? 0,
    session: () => (session ? { name: session.name, maxPlayers: session.desc.maxPlayers, flags: session.desc.flags, isHost: session.isHost } : null),
    players: () => [...players.values()].filter((p) => !(p.flags & PLAYER.SYSTEM)).map((p) => ({ id: p.id, name: playerName(p), local: p.local, systemPlayerId: p.systemPlayerId })),
  };
}

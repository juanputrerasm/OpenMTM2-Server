#!/usr/bin/env node
/*
  openmtm2d: the room server for OpenMTM2's online play (docs/DAEMON.md, docs/PROTOCOL.md). Runs
  headless on any machine with Node 22, as a systemd service or in a container; needs no game files.

      node bin/openmtm2d.mjs --config /etc/openmtm2/server.json
      node bin/openmtm2d.mjs --port 47660 --state-dir ./state --log-format text

  Endpoints on one port:
    ws   /play                        the room protocol
    GET  /healthz                     "ok" (503 while shutting down)
    GET  /status                      uptime, rooms, players, version
    GET  /rooms                       the public rooms
    with "Authorization: Bearer <adminToken>":
    GET  /admin/rooms                 every room with its members and their addresses
    POST /admin/rooms/<code>/close    close a room
    POST /admin/members/<id>/kick     disconnect a member
    GET  /admin/bans                  the bans
    POST /admin/bans                  { ip, minutes?, reason? } ban an address (0 minutes: for good)
    DELETE /admin/bans/<ip>           lift a ban
    POST /admin/reload                as SIGHUP

  Signals: SIGHUP reloads the settings and the ban list; SIGTERM and SIGINT stop taking new rooms,
  tell everyone, let running races finish (up to `drainS`), then exit 0. A second one exits at once.
*/
import http from "node:http";
import https from "node:https";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachWebSocket } from "../lib/ws.js";
import { loadConfig, parseArgs, redact, USAGE } from "../lib/config.js";
import { createLogger } from "../lib/log.js";
import { createBans, normalizeIp } from "../lib/bans.js";
import { originAllowed } from "../lib/origins.js";
import { createRoomServer, createBucket } from "../rooms/room-server.js";
import { createGateway } from "../rooms/gateway.js";
import { ROOM_PATH, ROOM_PROTOCOL, LIMITS } from "../protocol/room-messages.js";

export { originAllowed };

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

/** A slow client's queue past this many bytes misses truck state; past the second, it is dropped. */
const SLOW_BYTES = 256 * 1024, STUCK_BYTES = 4 * 1024 * 1024;

/**
 * The daemon as a function, for tests and embedding. `load()` returns the settings (called again on reload). Resolves
 * to `{ port, rooms, bans, reload(), stop() }`.
 */
export async function startDaemon({ load, log = createLogger() }) {
  let cfg = load();
  log.setLevel?.(cfg.logLevel);
  log.setFormat?.(cfg.logFormat);
  const bans = createBans({ stateDir: cfg.stateDir, log });
  if (!bans.persistent) log("warn", "no state folder; bans are kept in memory only");
  // Classic rooms through the DirectPlay gateway, when switched on.
  const gateway = cfg.gateway ? createGateway({
    bind: cfg.gatewayBind, tcpPorts: cfg.gatewayTcpPorts, udpPorts: cfg.gatewayUdpPorts, enumPort: cfg.gatewayEnumPort,
    isBanned: (ip) => bans.isBanned(ip), log,
  }) : null;
  const rooms = createRoomServer({ config: cfg, log, version: VERSION, hooks: gateway?.hooks ?? {} });
  gateway?.attach(rooms);
  const perIp = new Map();
  let stopping = false;

  const clientIp = (req) => {
    if (cfg.trustProxy) {
      const fwd = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      if (fwd.length) return normalizeIp(fwd[fwd.length - 1]);
    }
    return normalizeIp(req.socket.remoteAddress);
  };
  const ipState = (ip) => {
    let s = perIp.get(ip);
    if (!s) { s = { open: 0, bucket: createBucket(cfg.connectionsPerMinutePerIp / 60, cfg.connectionsPerMinutePerIp, Date.now) }; perIp.set(ip, s); }
    return s;
  };

  const json = (res, status, body, extra = {}) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra });
    res.end(`${JSON.stringify(body)}\n`);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on("data", (c) => { size += c.length; if (size > 16384) { reject(new Error("too big")); req.destroy(); } else parts.push(c); });
    req.on("end", () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {}); } catch { reject(new Error("not JSON")); } });
    req.on("error", reject);
  });

  async function admin(req, res, path) {
    if (!cfg.adminToken) return json(res, 404, { error: "admin is off" });
    if (req.headers.authorization !== `Bearer ${cfg.adminToken}`) return json(res, 401, { error: "unauthorized" });
    let m;
    if (req.method === "GET" && path === "/admin/rooms") return json(res, 200, { rooms: rooms.all() });
    if (req.method === "GET" && path === "/admin/bans") return json(res, 200, { bans: bans.list(), persistent: bans.persistent });
    if (req.method === "POST" && path === "/admin/reload") { reload(); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && (m = path.match(/^\/admin\/rooms\/([A-Z0-9]+)\/close$/i))) {
      const ok = rooms.closeRoom(m[1].toUpperCase(), "closed by the server");
      log("info", "admin close room", { room: m[1], ok });
      return json(res, ok ? 200 : 404, { ok });
    }
    if (req.method === "POST" && (m = path.match(/^\/admin\/members\/(\d+)\/kick$/))) {
      const ok = rooms.kick(Number(m[1]));
      log("info", "admin kick", { member: Number(m[1]), ok });
      return json(res, ok ? 200 : 404, { ok });
    }
    if (req.method === "POST" && path === "/admin/bans") {
      const body = await readBody(req);
      const b = bans.ban(body.ip, { minutes: Number(body.minutes) || 0, reason: body.reason ?? "" });
      const dropped = rooms.dropIp(b.ip);
      log("info", "ban", { ip: b.ip, until: b.until, dropped });
      return json(res, 200, { ban: b, dropped });
    }
    if (req.method === "DELETE" && (m = path.match(/^\/admin\/bans\/(.+)$/))) {
      const ok = bans.unban(decodeURIComponent(m[1]));
      log("info", "unban", { ip: m[1], ok });
      return json(res, ok ? 200 : 404, { ok });
    }
    return json(res, 404, { error: "not found" });
  }

  async function onRequest(req, res) {
    const path = new URL(req.url, "http://x").pathname;
    const cors = { "access-control-allow-origin": "*" };
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...cors, "access-control-allow-methods": "GET, POST, DELETE", "access-control-allow-headers": "authorization, content-type" });
        return res.end();
      }
      if (path === "/healthz") { res.writeHead(stopping ? 503 : 200, { "content-type": "text/plain" }); return res.end(stopping ? "stopping\n" : "ok\n"); }
      if (req.method === "GET" && path === "/status") return json(res, 200, { ...rooms.status(), maxRooms: cfg.maxRooms, maxPlayers: cfg.maxPlayers, motd: cfg.motd }, cors);
      if (req.method === "GET" && path === "/rooms") return json(res, 200, { protocol: ROOM_PROTOCOL, rooms: rooms.list() }, cors);
      if (req.method === "GET" && path === "/") return json(res, 200, { name: cfg.name, server: "openmtm2d", version: VERSION, protocol: ROOM_PROTOCOL, play: ROOM_PATH }, cors);
      if (path.startsWith("/admin/")) return await admin(req, res, path);
      json(res, 404, { error: "not found" });
    } catch (err) {
      log("warn", "http request failed", { path, error: err.message });
      if (!res.headersSent) json(res, 400, { error: err.message });
    }
  }

  const server = cfg.cert
    ? https.createServer({ cert: readFileSync(cfg.cert), key: readFileSync(cfg.key) }, onRequest)
    : http.createServer(onRequest);
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;

  const wss = attachWebSocket(server, {
    path: ROOM_PATH,
    maxPayload: LIMITS.textFrame,
    idleMs: 20000,
    allowOrigin: (origin) => originAllowed(origin, cfg),
    accept: (req) => {
      if (stopping) return 503;
      const ip = clientIp(req);
      if (bans.isBanned(ip)) return 403;
      const s = ipState(ip);
      if (s.open >= cfg.maxConnectionsPerIp || !s.bucket.take()) return 429;
      return true;
    },
  });
  wss.on("connection", (ws, req) => {
    const ip = clientIp(req);
    const s = ipState(ip);
    s.open++;
    const conn = rooms.connect({
      ip,
      send(data) {
        if (typeof data !== "string") {
          if (ws.bufferedAmount > SLOW_BYTES) return;
        } else if (ws.bufferedAmount > STUCK_BYTES) {
          ws.close(1008, "Too slow");
          return;
        }
        ws.send(data);
      },
      close: (code, reason) => ws.close(code, reason),
    });
    log("debug", "connect", { member: conn.id, ip });
    ws.on("message", (data, isBinary) => (isBinary ? conn.binary(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) : conn.text(data)));
    ws.on("close", (code) => {
      conn.closed();
      s.open--;
      if (s.open <= 0) perIp.delete(ip);
      log("debug", "disconnect", { member: conn.id, code });
    });
  });

  function reload() {
    try {
      const next = load();
      if (next.port !== cfg.port || next.host !== cfg.host || next.cert !== cfg.cert) log("warn", "the address and certificate change on restart only");
      cfg = { ...next, port: cfg.port, host: cfg.host, cert: cfg.cert, key: cfg.key };
      log.setLevel?.(cfg.logLevel);
      log.setFormat?.(cfg.logFormat);
      rooms.reconfigure(cfg);
      bans.load();
      log("info", "reloaded", { config: redact(cfg) });
    } catch (err) {
      log("error", "reload failed; keeping the old settings", { error: err.message });
    }
  }

  /** Stop: no new connections, tell everyone, wait for races (up to drainS), close, resolve. */
  async function stop({ drainS = cfg.drainS } = {}) {
    if (stopping) return;
    stopping = true;
    log("info", "shutting down", { drainS });
    await rooms.drain({ text: "The server is shutting down.", maxMs: drainS * 1000 });
    rooms.closeAll(1001, "Server shutting down");
    await gateway?.stop();
    await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
    log("info", "stopped");
  }

  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(cfg.port, cfg.host, resolve); });
  const port = server.address().port;
  log("info", "listening", { host: cfg.host, port, tls: !!cfg.cert, path: ROOM_PATH, version: VERSION, protocol: ROOM_PROTOCOL, gateway: !!gateway });
  return { port, rooms, bans, gateway, reload, stop, get config() { return cfg; } };
}

// ---- Command line ----

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) { console.log(USAGE); process.exit(0); }
  if (args.version) { console.log(`openmtm2d ${VERSION} (room protocol ${ROOM_PROTOCOL})`); process.exit(0); }
  const configFile = args.configFile ?? process.env.OPENMTM2_CONFIG ?? null;
  const load = () => loadConfig({ file: configFile, env: process.env, overrides: args.overrides });
  let first;
  try {
    first = load();
  } catch (err) {
    console.error(`openmtm2d: ${err.message}`);
    process.exit(2);
  }
  if (args.printConfig) { console.log(JSON.stringify(redact(first), null, 2)); process.exit(0); }
  const log = createLogger({ level: first.logLevel, format: first.logFormat });
  process.on("uncaughtException", (err) => { log("error", "crash", { error: err.stack ?? String(err) }); process.exit(1); });
  try {
    const daemon = await startDaemon({ load, log });
    let signals = 0;
    const quit = (sig) => {
      if (++signals > 1) { log("warn", "second signal, exiting now", { signal: sig }); process.exit(0); }
      daemon.stop().then(() => process.exit(0), () => process.exit(1));
    };
    process.on("SIGTERM", () => quit("SIGTERM"));
    process.on("SIGINT", () => quit("SIGINT"));
    process.on("SIGHUP", () => daemon.reload());
  } catch (err) {
    log("error", "cannot start", { error: err.message });
    process.exit(1);
  }
}

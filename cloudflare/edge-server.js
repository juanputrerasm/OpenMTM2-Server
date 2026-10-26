/*
  The room server on Cloudflare: the same rooms as openmtm2d (rooms/room-server.js), behind the
  same endpoints, inside one Durable Object (cloudflare/worker.js). No Cloudflare imports here, so
  the tests run it on Node with stand-in sockets.

      const edge = createEdgeServer({ settings, store, log, version });
      return edge.fetch(request);   // HTTP, or the WebSocket upgrade on /play

  What differs from the daemon:
    - No DirectPlay gateway: Cloudflare carries only web traffic, so rooms are for OpenMTM2 players.
    - Settings come from the Worker's variables and change on a deploy; /admin/reload only reads the
      ban list again. A deploy restarts the object and drops every connection.
    - The player's address is Cloudflare's CF-Connecting-IP header.
    - Cloudflare does not say how much is queued for a socket, so a slow client is not dropped for it.
*/
import { createRoomServer, createBucket } from "../rooms/room-server.js";
import { createBanList } from "../lib/ban-list.js";
import { originAllowed } from "../lib/origins.js";
import { ROOM_PATH, ROOM_PROTOCOL, LIMITS } from "../protocol/room-messages.js";

/**
 * `settings` as lib/settings.js builds them, `store` where the bans are kept (`read()`, `write(list)`), `log(level, msg,
 * fields)`. `WebSocketPair` and `upgradeResponse(socket)` are Cloudflare's; tests pass stand-ins.
 */
export function createEdgeServer({
  settings, store = null, log = () => {}, version = "0", now = Date.now,
  WebSocketPair = globalThis.WebSocketPair,
  upgradeResponse = (socket) => new Response(null, { status: 101, webSocket: socket }),
}) {
  const cfg = settings;
  const bans = createBanList({ store, now });
  const rooms = createRoomServer({ config: cfg, log, version, now });
  const perIp = new Map();

  const ipState = (ip) => {
    let s = perIp.get(ip);
    if (!s) { s = { open: 0, bucket: createBucket(cfg.connectionsPerMinutePerIp / 60, cfg.connectionsPerMinutePerIp, now) }; perIp.set(ip, s); }
    return s;
  };
  const cors = { "access-control-allow-origin": "*" };
  const json = (status, body, extra = {}) => new Response(`${JSON.stringify(body)}\n`, {
    status, headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
  const text = (status, body) => new Response(`${body}\n`, { status, headers: { "content-type": "text/plain" } });

  async function readBody(request) {
    const body = await request.text();
    if (body.length > 16384) throw new Error("too big");
    try { return body ? JSON.parse(body) : {}; } catch { throw new Error("not JSON"); }
  }

  async function admin(request, path) {
    if (!cfg.adminToken) return json(404, { error: "admin is off" });
    if (request.headers.get("authorization") !== `Bearer ${cfg.adminToken}`) return json(401, { error: "unauthorized" });
    const method = request.method;
    let m;
    if (method === "GET" && path === "/admin/rooms") return json(200, { rooms: rooms.all() });
    if (method === "GET" && path === "/admin/bans") return json(200, { bans: bans.list(), persistent: bans.persistent });
    if (method === "POST" && path === "/admin/reload") { bans.load(); log("info", "reloaded the bans"); return json(200, { ok: true }); }
    if (method === "POST" && (m = path.match(/^\/admin\/rooms\/([A-Z0-9]+)\/close$/i))) {
      const ok = rooms.closeRoom(m[1].toUpperCase(), "closed by the server");
      log("info", "admin close room", { room: m[1], ok });
      return json(ok ? 200 : 404, { ok });
    }
    if (method === "POST" && (m = path.match(/^\/admin\/members\/(\d+)\/kick$/))) {
      const ok = rooms.kick(Number(m[1]));
      log("info", "admin kick", { member: Number(m[1]), ok });
      return json(ok ? 200 : 404, { ok });
    }
    if (method === "POST" && path === "/admin/bans") {
      const body = await readBody(request);
      const b = bans.ban(body.ip, { minutes: Number(body.minutes) || 0, reason: body.reason ?? "" });
      const dropped = rooms.dropIp(b.ip);
      log("info", "ban", { ip: b.ip, until: b.until, dropped });
      return json(200, { ban: b, dropped });
    }
    if (method === "DELETE" && (m = path.match(/^\/admin\/bans\/(.+)$/))) {
      const ok = bans.unban(decodeURIComponent(m[1]));
      log("info", "unban", { ip: m[1], ok });
      return json(ok ? 200 : 404, { ok });
    }
    return json(404, { error: "not found" });
  }

  /** A WebSocket on /play: the same checks as the daemon, then the room server takes it. */
  function play(request) {
    if (String(request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") return text(426, "Upgrade to a WebSocket");
    if (!originAllowed(request.headers.get("origin"), cfg)) return text(403, "Forbidden");
    const ip = request.headers.get("cf-connecting-ip") ?? "";
    if (bans.isBanned(ip)) return text(403, "Forbidden");
    const s = ipState(ip);
    if (s.open >= cfg.maxConnectionsPerIp || !s.bucket.take()) return text(429, "Too Many Requests");

    const [client, server] = Object.values(new WebSocketPair());
    // Binary frames as ArrayBuffers. With recent compatibility dates, Workers hand them over as Blobs by default
    // (the web standard), and a Blob read as bytes is empty: every truck state frame would be dropped.
    try { server.binaryType = "arraybuffer"; } catch { /* an older runtime: ArrayBuffers already */ }
    server.accept();
    s.open++;
    let conn = null, done = false;
    // Once, whoever ends it: the player, the room server, or a failed socket.
    const finish = (code) => {
      if (done) return;
      done = true;
      conn?.closed();
      s.open--;
      if (s.open <= 0) perIp.delete(ip);
      log("debug", "disconnect", { member: conn?.id, code });
    };
    const close = (code, reason) => {
      try { server.close(code, reason); } catch { /* already closed */ }
      finish(code);
    };
    conn = rooms.connect({
      ip,
      send(data) {
        try { server.send(data); } catch { close(1011, "Send failed"); }
      },
      close,
    });
    if (done) conn.closed();
    log("debug", "connect", { member: conn.id, ip });
    server.addEventListener("message", (event) => {
      const data = event.data;
      if (typeof data === "string") return conn.text(data);
      const take = (bytes) => {
        if (bytes.byteLength > LIMITS.textFrame) return close(1009, "Message too big");
        conn.binary(bytes);
      };
      if (data instanceof ArrayBuffer) return take(new Uint8Array(data));
      if (ArrayBuffer.isView(data)) return take(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      // A Blob, should the runtime ignore binaryType: read it (a state frame arriving late is still better than none).
      if (typeof data?.arrayBuffer === "function") {
        if (data.size > LIMITS.textFrame) return close(1009, "Message too big");
        data.arrayBuffer().then((buffer) => { if (!done) take(new Uint8Array(buffer)); }, () => {});
      }
    });
    // Answer the player's close, then let go of them.
    server.addEventListener("close", (event) => {
      try { server.close(1000, ""); } catch { /* already closed */ }
      finish(event.code);
    });
    server.addEventListener("error", () => finish(1006));
    return upgradeResponse(client);
  }

  async function fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      if (path === ROOM_PATH) return play(request);
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET, POST, DELETE", "access-control-allow-headers": "authorization, content-type" } });
      }
      if (path === "/healthz") return text(200, "ok");
      if (request.method === "GET" && path === "/status") return json(200, { ...rooms.status(), maxRooms: cfg.maxRooms, maxPlayers: cfg.maxPlayers, motd: cfg.motd }, cors);
      if (request.method === "GET" && path === "/rooms") return json(200, { protocol: ROOM_PROTOCOL, rooms: rooms.list() }, cors);
      if (request.method === "GET" && path === "/") return json(200, { name: cfg.name, server: "openmtm2-worker", version, protocol: ROOM_PROTOCOL, play: ROOM_PATH }, cors);
      if (path.startsWith("/admin/")) return await admin(request, path);
      return json(404, { error: "not found" });
    } catch (err) {
      log("warn", "http request failed", { path, error: err.message });
      return json(400, { error: err.message });
    }
  }

  return { fetch, rooms, bans };
}

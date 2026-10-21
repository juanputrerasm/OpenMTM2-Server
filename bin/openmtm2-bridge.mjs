#!/usr/bin/env node
/*
  openmtm2-bridge: the desktop helper for classic multiplayer. OpenMTM2 runs in a browser, which
  cannot open the TCP and UDP sockets DirectPlay needs; this small program does it for the page.
  It speaks DirectPlay 4 to Monster Truck Madness 2 (retail, patched, Community Patch 3's
  DirectPlay connection) and other OpenMTM2 players, and WebSocket to the page on this computer.

      node bin/openmtm2-bridge.mjs                  listen on ws://127.0.0.1:47650/bridge
      node bin/openmtm2-bridge.mjs --port 47651 --token mysecret --origin https://example.org

  It listens on this computer only. The page must come from an allowed origin (OpenMTM2's site,
  or localhost) and give the pairing token printed at start. One page at a time.

  Ports DirectPlay uses on this computer: TCP 2300-2350 and UDP 2350-2400, and 47624 when
  hosting. Other players must be able to reach them (forward them, or play over a VPN). A
  MONSTER.EXE running on the same computer needs the same ports, so run one or the other.

  The page's protocol (docs/BRIDGE.md):
    page -> bridge   JSON { id, type: "hello" | "enum" | "host" | "join" | "leave", ... }
                     binary [u32 to][u8 flags: 1 guaranteed][MTM2 packet]
    bridge -> page   JSON { id, type: "result" | "error", ... } and events
                     { type: "player" | "host" | "lost" | "log", ... }
                     binary [u32 from][u32 to][MTM2 packet]
*/
import http from "node:http";
import { randomBytes } from "node:crypto";
import { attachWebSocket } from "../lib/ws.js";
import { createDirectPlay } from "../dplay/provider.js";
import { createDirectConnect } from "../cp3udp/node.js";
import { DEFAULT_PORT as CP3_PORT } from "../cp3udp/codec.js";
import { VERSION, SESSION } from "../dplay/codec.js";

import { MTM2_APPLICATION } from "../protocol/mtm2-packets.js";
export { MTM2_APPLICATION };
export const BRIDGE_PORT = 47650;
export const BRIDGE_PROTOCOL = 1;
const DEFAULT_ORIGINS = ["https://juanputrerasm.github.io"];

/** Whether a page's origin may use the helper: the allowed list, or any page served from this computer. */
export function originAllowed(origin, allowed = DEFAULT_ORIGINS) {
  if (!origin) return false;
  if (allowed.includes(origin)) return true;
  try {
    const u = new URL(origin);
    return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

/**
 * The helper as a function, for tests and for embedding: `{ port, host, token, origins, dplay }` (`dplay` options go to
 * createDirectPlay). Resolves to `{ port, token, close() }`.
 */
export async function startBridge({ port = BRIDGE_PORT, host = "127.0.0.1", token = randomBytes(4).toString("hex"), origins = DEFAULT_ORIGINS, dplay = {}, log = () => {} } = {}) {
  const server = http.createServer((req, res) => {
    // A plain GET answers whether the helper runs (the page's status light).
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": originAllowed(req.headers.origin, origins) ? req.headers.origin : "null" });
    res.end(JSON.stringify({ name: "openmtm2-bridge", protocol: BRIDGE_PROTOCOL, busy: !!current }));
  });
  const wss = attachWebSocket(server, { path: "/bridge", maxPayload: 1 << 16, allowOrigin: (o) => originAllowed(o, origins) });
  let current = null;

  wss.on("connection", (ws) => {
    if (current) { ws.close(4002, "Another page is using the helper"); return; }
    current = ws;
    let paired = false;
    /** The game's network: a DirectPlay node, or a Community Patch 3 direct connect node (`kind: "cp3"`). */
    let dp = null, kind = null;
    const event = (obj) => ws.send(JSON.stringify(obj));
    const reply = (id, obj) => event({ id, type: "result", ...obj });

    const wire = (n) => {
      n.on("player", (p) => event({ type: "player", ...p }));
      // The host is a machine (its system player); the page wants that machine's game player.
      n.on("host", (h) => event({ type: "host", ...h, playerId: hostPlayer() }));
      n.on("lost", (l) => event({ type: "lost", ...l }));
      n.on("log", (text) => { log(text); event({ type: "log", text }); });
      n.on("message", ({ from, to, payload }) => {
        const out = Buffer.allocUnsafe(8 + payload.length);
        out.writeUInt32LE(from >>> 0, 0);
        out.writeUInt32LE(to >>> 0, 4);
        out.set(payload, 8);
        ws.send(out);
      });
      return n;
    };
    /** The node for `want` ("dplay" or "cp3"); a node of the other kind is closed first, as both use port 2350. */
    const node = async (want = "dplay") => {
      if (dp && kind === want) return dp;
      if (dp) { await dp.stop().catch(() => {}); dp = null; }
      kind = want;
      dp = wire(want === "cp3" ? createDirectConnect({ bind: dplay.bind, timing: dplay.cp3Timing })
        : createDirectPlay({ application: MTM2_APPLICATION, version: dplay.version ?? VERSION.DX9, ...dplay }));
      return dp;
    };
    const hostPlayer = () => dp?.players().find((p) => p.systemPlayerId === dp.hostId())?.id ?? null;
    const describe = () => ({ ...dp.self(), isHost: dp.isHost(), hostId: dp.hostId(), hostPlayerId: hostPlayer(), session: dp.session(), players: dp.players(), ports: dp.ports() });
    let sessions = new Map();

    ws.on("message", async (data, isBinary) => {
      if (isBinary) {
        if (!paired || !dp || data.length < 5) return;
        dp.send(data.readUInt32LE(0), new Uint8Array(data.subarray(5)), { guaranteed: !!(data[4] & 1) });
        return;
      }
      let req;
      try { req = JSON.parse(data); } catch { return ws.close(1003, "Not JSON"); }
      const { id, type } = req;
      try {
        if (type === "hello") {
          if (String(req.token ?? "") !== token) { ws.close(4001, "Wrong pairing token"); return; }
          paired = true;
          return reply(id, { name: "openmtm2-bridge", protocol: BRIDGE_PROTOCOL });
        }
        if (!paired) { ws.close(4001, "Say hello first"); return; }
        if (type === "enum") {
          const found = await (await node("dplay")).enumerate(String(req.ip ?? ""), { timeoutMs: Math.min(5000, req.timeoutMs ?? 1000), all: !!req.all });
          sessions = new Map(found.map((s) => [s.instance, s]));
          return reply(id, { sessions: found.map(({ desc, ...s }) => s) });
        }
        if (type === "host" && req.kind === "cp3") {
          await (await node("cp3")).host({ playerName: String(req.playerName ?? "Driver").slice(0, 31), port: Number(req.port) || CP3_PORT });
          return reply(id, { ...describe(), kind });
        }
        if (type === "join" && req.kind === "cp3") {
          const ip = String(req.ip ?? "").trim();
          if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) throw new Error("Type the host's IPv4 address.");
          await (await node("cp3")).join({ ip, port: Number(req.port) || CP3_PORT, playerName: String(req.playerName ?? "Driver").slice(0, 31) });
          return reply(id, { ...describe(), kind });
        }
        if (type === "host") {
          const flags = SESSION.KEEPALIVE | 0x2 | (req.migrateHost === false ? 0 : SESSION.MIGRATEHOST);
          await (await node("dplay")).host({ name: String(req.name ?? "Truckin' Game").slice(0, 80), playerName: String(req.playerName ?? "Driver").slice(0, 40), maxPlayers: Math.max(2, Math.min(8, req.maxPlayers ?? 8)), flags });
          return reply(id, describe());
        }
        if (type === "join") {
          const s = sessions.get(req.instance);
          if (!s) throw new Error("That session is no longer listed; refresh.");
          await (await node("dplay")).join(s, { playerName: String(req.playerName ?? "Driver").slice(0, 40), password: String(req.password ?? "") });
          return reply(id, describe());
        }
        if (type === "leave") {
          dp?.leave();
          // A direct connect node is used once; DirectPlay's stays for the next search.
          if (kind === "cp3") { dp = null; kind = null; }
          return reply(id, {});
        }
        if (type === "state") return reply(id, dp ? describe() : {});
        throw new Error(`Unknown request ${type}`);
      } catch (err) {
        event({ id, type: "error", message: err.message });
      }
    });
    ws.on("close", () => {
      if (current === ws) current = null;
      dp?.stop().catch(() => {});
      dp = null;
    });
  });

  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  return {
    port: server.address().port, token,
    close: () => new Promise((resolve) => { current?.close(1001, "Helper closing"); server.close(() => resolve()); }),
  };
}

// ---- Command line ----

function parseArgs(argv) {
  const out = { origins: [...DEFAULT_ORIGINS] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") out.port = Number(argv[++i]);
    else if (a === "--token") out.token = argv[++i];
    else if (a === "--origin") out.origins.push(argv[++i]);
    else if (a === "--bind") out.dplay = { ...(out.dplay ?? {}), bind: argv[++i] };
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`Unknown option ${a}`);
  }
  return out;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log("usage: openmtm2-bridge [--port 47650] [--token <pairing token>] [--origin <allowed page origin>] [--bind <address for DirectPlay>]");
      process.exit(0);
    }
    const bridge = await startBridge({ ...args, log: (t) => console.log(t) });
    console.log(`OpenMTM2 helper on ws://127.0.0.1:${bridge.port}/bridge`);
    console.log(`Pairing token: ${bridge.token}`);
    console.log("Classic multiplayer uses TCP 2300-2350, UDP 2350-2400 and, when hosting, port 47624.");
    const quit = () => bridge.close().then(() => process.exit(0));
    process.on("SIGINT", quit);
    process.on("SIGTERM", quit);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

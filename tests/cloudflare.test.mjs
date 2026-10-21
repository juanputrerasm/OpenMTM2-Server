/*
  The Cloudflare Worker's room server (cloudflare/edge-server.js) on Node, with stand-ins for
  Cloudflare's WebSocketPair: the endpoints, a room and a race over its sockets, the connection
  checks, bans kept in its store, and the Worker's settings.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { createEdgeServer } from "../cloudflare/edge-server.js";
import { workerSettings } from "../cloudflare/worker.js";
import { buildSettings } from "../lib/settings.js";
import { encodeState, decodeState, ROOM_PROTOCOL } from "../protocol/room-messages.js";

/** Cloudflare's WebSocketPair, enough for the server: [the player's end, the server's end]. */
class FakePair {
  constructor() {
    const end = () => ({
      listeners: {}, received: [], closed: null, accepted: false,
      addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
      emit(type, event) { for (const fn of this.listeners[type] ?? []) fn(event); },
      accept() { this.accepted = true; },
      send(data) { if (this.closed) throw new Error("closed"); this.peer.received.push(data); },
      close(code, reason) { if (this.closed) throw new Error("closed"); this.closed = { code, reason }; this.peer.peerClosed = { code, reason }; },
    });
    this.client = end();
    this.server = end();
    this.client.peer = this.server;
    this.server.peer = this.client;
  }
}

function edge(overrides = {}, store = null) {
  const settings = buildSettings({ overrides: { startDelayMs: 0, ...overrides } });
  return createEdgeServer({ settings, store, WebSocketPair: FakePair, upgradeResponse: (socket) => ({ status: 101, socket }) });
}

const request = (path, { method = "GET", headers = {}, body } = {}) => new Request(`https://rooms.example.workers.dev${path}`, { method, headers, body });

/** A player on the server: `req` sends a request and returns its answer; `seen(type)` the messages of a type so far. */
async function player(e, name, { ip = "203.0.113.1", origin = "https://juanputrerasm.github.io" } = {}) {
  const headers = { upgrade: "websocket", "cf-connecting-ip": ip, ...(origin ? { origin } : {}) };
  const res = await e.fetch(request("/play", { headers }));
  if (res.status !== 101) return { status: res.status };
  const ws = res.socket;
  let id = 1;
  const json = () => ws.received.filter((d) => typeof d === "string").map((d) => JSON.parse(d));
  const p = {
    status: 101, ws,
    send: (obj) => ws.peer.emit("message", { data: JSON.stringify(obj) }),
    sendBinary: (bytes) => ws.peer.emit("message", { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }),
    req(type, fields = {}) {
      const rid = id++;
      p.send({ type, id: rid, ...fields });
      return json().find((m) => m.id === rid);
    },
    seen: (type) => json().filter((m) => m.type === type),
    binary: () => ws.received.filter((d) => typeof d !== "string").map((d) => decodeState(new Uint8Array(d.buffer ?? d))),
    leave: () => ws.peer.emit("close", { code: 1000 }),
  };
  p.hello = p.req("hello", { protocol: ROOM_PROTOCOL, name, client: "test" });
  return p;
}

test("worker: the endpoints answer as openmtm2d's do", async () => {
  const e = edge({ name: "Edge", adminToken: "tok" });
  const root = await (await e.fetch(request("/"))).json();
  assert.deepEqual([root.name, root.server, root.play], ["Edge", "openmtm2-worker", "/play"]);
  assert.equal(await (await e.fetch(request("/healthz"))).text(), "ok\n");
  const status = await (await e.fetch(request("/status"))).json();
  assert.deepEqual([status.rooms, status.players, status.maxPlayers], [0, 0, 8]);
  assert.deepEqual((await (await e.fetch(request("/rooms"))).json()).rooms, []);
  assert.equal((await e.fetch(request("/nothing"))).status, 404);
  assert.equal((await e.fetch(request("/play"))).status, 426, "plain GET on /play");
  assert.equal((await e.fetch(request("/admin/rooms"))).status, 401);
  assert.equal((await e.fetch(request("/admin/rooms", { headers: { authorization: "Bearer tok" } }))).status, 200);
  assert.equal((await edge().fetch(request("/admin/rooms"))).status, 404, "admin is off without a token");
});

test("worker: a room and a race over its sockets", async () => {
  const e = edge();
  const ann = await player(e, "Ann");
  assert.equal(ann.ws.peer.accepted, true);
  const { room } = ann.req("create", { name: "Edge Race" });
  const ben = await player(e, "Ben", { ip: "203.0.113.2" });
  assert.deepEqual(ben.req("join", { room: room.code }).room.members.map((m) => m.name), ["Ann", "Ben"]);
  assert.equal((await (await e.fetch(request("/rooms"))).json()).rooms[0].players, 2);

  ann.req("settings", { track: { sit: "TPARK.SIT", name: "Farm Road 29", crc: 99 }, laps: 1 });
  ann.req("profile", { truck: "BIGFOOT.TRK", ready: true });
  ben.req("profile", { truck: "GRAVE.TRK", ready: true });
  assert.equal(ann.req("start", { weather: 0 }).type, "result");
  const race = ann.seen("starting")[0].race;
  ann.req("loaded");
  ben.req("loaded");
  assert.equal(ben.seen("synced").length, 1);

  const annV = race.entrants.find((x) => x.member === ann.hello.you.id).vehicle;
  ann.sendBinary(encodeState({ vehicle: annV, seq: 1, pos: [1, 2, 3] }));
  ben.sendBinary(encodeState({ vehicle: annV, seq: 2, pos: [9, 9, 9] }));
  assert.deepEqual(ben.binary().map((s) => s.pos), [[1, 2, 3]], "Ann's state reaches Ben");
  assert.deepEqual(ann.binary(), [], "Ben's forged frame is dropped");

  ann.req("result", { laps: 1, total: 60, best: 60 });
  ben.req("result", { laps: 1, total: 61, best: 61 });
  assert.equal(ann.seen("results").length, 1);

  // Ben leaves: the room is told, and the server answers his close.
  ben.leave();
  assert.equal(ann.seen("left")[0].member, ben.hello.you.id);
  assert.equal(ben.ws.peerClosed.code, 1000);
  assert.equal((await (await e.fetch(request("/status"))).json()).players, 1);
});

test("worker: origins, per-address limits and bans kept in the store", async () => {
  let saved = null;
  const store = { read: () => saved, write: (list) => { saved = structuredClone(list); return true; } };
  const e = edge({ adminToken: "tok", maxConnectionsPerIp: 2 }, store);
  assert.equal((await player(e, "Eve", { origin: "https://evil.example" })).status, 403);
  assert.equal((await player(e, "Dev", { origin: "http://localhost:8080" })).status, 101, "local pages may connect");
  assert.equal((await player(e, "Cp3", { origin: null, ip: "198.51.100.9" })).status, 101, "native clients send no origin");
  assert.equal((await player(e, "Two", { origin: "http://localhost:8080" })).status, 101);
  assert.equal((await player(e, "Three", { origin: "http://localhost:8080" })).status, 429, "two per address");

  const target = await player(e, "Troll", { ip: "192.0.2.7" });
  const auth = { authorization: "Bearer tok", "content-type": "application/json" };
  const banned = await (await e.fetch(request("/admin/bans", { method: "POST", headers: auth, body: JSON.stringify({ ip: "192.0.2.7", reason: "test" }) }))).json();
  assert.equal(banned.dropped, 1);
  assert.equal(target.ws.peerClosed.code, 4003);
  assert.equal((await player(e, "Troll", { ip: "192.0.2.7" })).status, 403);
  assert.equal(saved[0].ip, "192.0.2.7", "the ban is in the store");

  // A new object (after a deploy) reads the ban back.
  const again = edge({}, store);
  assert.equal((await player(again, "Troll", { ip: "192.0.2.7" })).status, 403);
  assert.equal((await again.fetch(request("/admin/bans/192.0.2.7", { method: "DELETE", headers: auth }))).status, 404, "admin is off there");
  assert.equal((await e.fetch(request("/admin/bans/192.0.2.7", { method: "DELETE", headers: auth }))).status, 200);
  assert.deepEqual(saved, []);
});

test("worker: settings from the Worker's variables", () => {
  const cfg = workerSettings({
    OPENMTM2_NAME: "Cloud", OPENMTM2_ORIGINS: "https://a.example, https://b.example", OPENMTM2_GATEWAY: "true",
    OPENMTM2_SETTINGS: { maxRooms: 5, messagesPerSecond: 30 }, ROOMS: {},
  });
  assert.deepEqual([cfg.name, cfg.origins, cfg.maxRooms, cfg.messagesPerSecond, cfg.gateway], ["Cloud", ["https://a.example", "https://b.example"], 5, 30, false]);
  assert.equal(workerSettings({ OPENMTM2_SETTINGS: "{\"maxPlayers\": 4}" }).maxPlayers, 4, "or as JSON text");
  assert.throws(() => workerSettings({ OPENMTM2_SETTINGS: { maxPlayers: 40 } }), /maxPlayers/);
  assert.throws(() => workerSettings({ OPENMTM2_SETTINGS: { nope: 1 } }), /unknown setting nope/);
});

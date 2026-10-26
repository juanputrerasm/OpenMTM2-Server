/*
  Silent members are dropped (rooms/room-server.js `idleTimeoutS`): a connection that died without a
  close, which a Cloudflare Worker never hears of, must not keep its room open.
*/
import test from "node:test";
import assert from "node:assert/strict";
import { createRoomServer } from "../rooms/room-server.js";
import { ROOM_PROTOCOL, CLOSE } from "../protocol/room-messages.js";

function setup(t, config = {}) {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const rooms = createRoomServer({ config: { idleTimeoutS: 60, ...config }, now: () => Date.now() });
  const join = (name) => {
    const sent = [];
    const client = { closedWith: null, send: (d) => sent.push(d), close(code) { this.closedWith = code; } };
    const conn = rooms.connect(client);
    const say = (obj) => conn.text(JSON.stringify(obj));
    say({ type: "hello", id: 0, protocol: ROOM_PROTOCOL, name });
    const json = () => sent.filter((d) => typeof d === "string").map((d) => JSON.parse(d));
    return { client, conn, say, json, id: json()[0].you.id };
  };
  return { rooms, join };
}

test("a member silent past idleTimeoutS is dropped, and their room closes or changes owner", (t) => {
  const { rooms, join } = setup(t);
  const ann = join("Ann");
  ann.say({ type: "create", id: 1, name: "Ghost town" });
  const code = ann.json().find((m) => m.id === 1).room.code;
  const ben = join("Ben");
  ben.say({ type: "join", id: 1, room: code });
  // Ben keeps talking; Ann's connection has died without a word.
  for (let s = 0; s < 70; s += 10) { t.mock.timers.tick(10000); ben.say({ type: "ping", t: s }); }
  t.mock.timers.tick(15000);
  assert.equal(ann.client.closedWith, CLOSE.IDLE);
  assert.equal(ben.client.closedWith, null, "a member who talks stays");
  assert.equal(rooms.view(code).owner, ben.id, "the room moves to Ben");
  assert.ok(ben.json().some((m) => m.type === "left" && m.member === ann.id));
  // Ben goes quiet too: the room is gone.
  t.mock.timers.tick(90000);
  assert.equal(rooms.view(code), null);
  assert.equal(rooms.status().timedOut, 2);
});

test("idleTimeoutS 0 keeps silent members", (t) => {
  const { rooms, join } = setup(t, { idleTimeoutS: 0 });
  const ann = join("Ann");
  ann.say({ type: "create", id: 1, name: "Kept" });
  t.mock.timers.tick(600000);
  assert.equal(ann.client.closedWith, null);
  assert.equal(rooms.list().length, 1);
});

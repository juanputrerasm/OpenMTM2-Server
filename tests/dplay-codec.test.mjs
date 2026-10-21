/*
  The DirectPlay 4 messages against [MC-DPL4CS] (section numbers are the specification's).
*/
import test from "node:test";
import assert from "node:assert/strict";
import {
  CMD, ENUM, PLAYER, SESSION, VERSION, SIGNATURE, guidBytes, guidText, frame, readPrefix, splitDatagram, createStreamReader,
  encode, decodeSystem, playerMessage, decodePlayerMessage, isSystem, createIdAllocator, readPackedPlayer, writePackedPlayer,
} from "../dplay/codec.js";

const MTM2 = "{6CD1C6E0-96FB-11D1-A268-00A024F2C995}";

test("GUIDs: MTM2's application GUID in wire order", () => {
  assert.deepEqual([...guidBytes(MTM2)], [0xe0, 0xc6, 0xd1, 0x6c, 0xfb, 0x96, 0xd1, 0x11, 0xa2, 0x68, 0x00, 0xa0, 0x24, 0xf2, 0xc9, 0x95]);
  assert.equal(guidText(guidBytes(MTM2)), MTM2);
});

test("4.1: an EnumSessions with a password is 70 bytes, its password at offset 32 from 'play'", () => {
  const body = encode.enumSessions({ application: guidBytes("{A052A50B-FFE0-CF11-9C4E-00A0C905425E}"), flags: ENUM.ALL, password: "Password" }, VERSION.DX9);
  const msg = frame(body, 2300);
  assert.equal(msg.length, 70);
  const p = readPrefix(msg);
  assert.equal(p.token, 0xfab);
  assert.equal(p.size, 70);
  assert.deepEqual(p.sockaddr, { family: 2, port: 2300, ip: "0.0.0.0" });
  assert.deepEqual([...msg.slice(4, 8)], [2, 0, 0x08, 0xfc], "family little-endian, port in network order");
  const d = decodeSystem(body);
  assert.equal(d.cmd, CMD.ENUMSESSIONS);
  assert.equal(d.version, 14);
  assert.equal(d.flags, ENUM.ALL);
  assert.equal(d.password, "Password");
  assert.equal(new DataView(body.buffer).getUint32(24, true), 32);
});

test("4.2: an EnumSessionsReply named LOTHAIR is 128 bytes, the name at offset 92", () => {
  const desc = { flags: 0x404, instance: guidBytes("{21FAA08E-42FC-B546-AFD3-5E1584FBBB60}"), application: guidBytes(MTM2), maxPlayers: 1000, currentPlayers: 1, reserved1: 0x1e52a0a1, user: [0, 2, 3, 4] };
  const body = encode.enumSessionsReply({ desc, name: "LOTHAIR" }, VERSION.DX9);
  assert.equal(frame(body, 2300).length, 128);
  const d = decodeSystem(body);
  assert.equal(d.name, "LOTHAIR");
  assert.equal(d.desc.size, 80);
  assert.equal(d.desc.maxPlayers, 1000);
  assert.equal(d.desc.reserved1, 0x1e52a0a1);
  assert.deepEqual(d.desc.user, [0, 2, 3, 4]);
  assert.equal(guidText(d.desc.application), MTM2);
});

test("2.2.50: a RequestPlayerReply is 68 bytes with the result last", () => {
  const body = encode.requestPlayerReply({ id: 0x12345678, result: 0x8877014a }, VERSION.DX9);
  assert.equal(frame(body, 2300).length, 68);
  const d = decodeSystem(body);
  assert.equal(d.id, 0x12345678);
  assert.equal(d.result, 0x8877014a);
});

test("2.2.2: a packed player with names and the Winsock provider's two addresses", () => {
  const player = { id: 7, flags: PLAYER.SYSTEM | PLAYER.INGROUP, shortName: "Juan", longName: "Juan P", tcp: { port: 2301, ip: "10.0.0.5" }, udp: { port: 2351, ip: "10.0.0.5" }, systemPlayerId: 7, version: 14 };
  const body = encode.addForwardRequest({ playerId: 7, player, password: "", tick: 99 }, 14);
  const d = decodeSystem(body);
  assert.equal(d.playerId, 7);
  assert.equal(d.player.shortName, "Juan");
  assert.equal(d.player.longName, "Juan P");
  assert.deepEqual(d.player.tcp, { family: 2, port: 2301, ip: "10.0.0.5" });
  assert.equal(d.player.udp.port, 2351);
  assert.equal(d.tick, 99);
  assert.equal(new DataView(body.buffer).getUint32(20, true), 28, "CreateOffset is 28");
});

test("2.2.53: SuperEnumPlayersReply carries the session and every player", () => {
  const desc = { flags: 0x46, instance: new Uint8Array(16).fill(1), application: guidBytes(MTM2), maxPlayers: 8, reserved1: 0xdeadbeef };
  const players = [
    { id: 1, flags: PLAYER.SYSTEM | PLAYER.NAMESERVER | PLAYER.INGROUP, tcp: { port: 2300 }, udp: { port: 2350 }, version: 14 },
    { id: 2, flags: 0, shortName: "Host", longName: "Host", tcp: { port: 2300 }, udp: { port: 2350 }, systemPlayerId: 1 },
    { id: 3, flags: PLAYER.SYSTEM | PLAYER.INGROUP, tcp: { port: 2301, ip: "10.0.0.9" }, udp: { port: 2351, ip: "10.0.0.9" }, version: 11 },
  ];
  const body = encode.superEnumPlayersReply({ desc, name: "Juan's Truckin' Game", players }, 14);
  assert.equal(new DataView(body.buffer).getUint32(24, true), 36, "DescriptionOffset");
  const d = decodeSystem(body);
  assert.equal(d.name, "Juan's Truckin' Game");
  assert.equal(d.desc.reserved1, 0xdeadbeef);
  assert.equal(d.players.length, 3);
  assert.equal(d.players[0].version, 14);
  assert.equal(d.players[1].systemPlayerId, 1);
  assert.equal(d.players[1].longName, "Host");
  assert.deepEqual(d.players[2].tcp, { family: 2, port: 2301, ip: "10.0.0.9" });
  assert.equal(d.players[2].version, 11);
});

test("2.2.45: player messages have no 'play'; one that would look like one is wrapped (3.1.4.16.2)", () => {
  const plain = playerMessage(5, 6, new Uint8Array([2, 0, 0, 0]), 14);
  assert.ok(!isSystem(plain));
  assert.deepEqual(decodePlayerMessage(plain), { from: 5, to: 6, payload: new Uint8Array([2, 0, 0, 0]) });
  // An idFrom of 'play' would read as a signature.
  const odd = playerMessage(SIGNATURE, 6, new Uint8Array([1]), 14);
  const d = decodeSystem(odd);
  assert.equal(d.cmd, CMD.PLAYERWRAPPER);
  assert.equal(decodePlayerMessage(d.message).from, SIGNATURE);
});

test("UDP: a system message keeps its prefix, a bare player message has none", () => {
  const sys = frame(encode.ping({ fromId: 1, tick: 2 }, 14), 2300);
  assert.equal(decodeSystem(splitDatagram(sys).body).cmd, CMD.PING);
  const bare = playerMessage(1, 2, new Uint8Array(61), 14);
  const s = splitDatagram(bare);
  assert.equal(s.prefix, null);
  assert.equal(s.body.length, 69);
});

test("TCP: a stream split anywhere gives whole messages", () => {
  const a = frame(encode.ping({ fromId: 1, tick: 2 }, 14), 2300), b = frame(playerMessage(3, 4, new Uint8Array([9, 9]), 14), 2300);
  const all = new Uint8Array([...a, ...b]);
  const got = [];
  const read = createStreamReader((m) => got.push(m.body.length));
  for (let i = 0; i < all.length; i += 7) read(all.slice(i, i + 7));
  assert.deepEqual(got, [a.length - 20, b.length - 20]);
  assert.throws(() => createStreamReader(() => {})(new Uint8Array(24).fill(0xff)));
});

test("3.2.5.4: player IDs are an index and a counter XORed with Reserved1", () => {
  const ids = createIdAllocator(0x5a5a1234, 0);
  const a = ids.next(), b = ids.next();
  assert.equal((a ^ 0x5a5a1234) >>> 0, 0x00010000);
  assert.equal((b ^ 0x5a5a1234) >>> 0, 0x00020001);
  ids.release(a);
  assert.equal(((ids.next() ^ 0x5a5a1234) >>> 0) & 0xffff, 0, "a freed index is used again");
});

test("session flags MTM2 uses: 0x46 is keepalive, migrate host and 0x2", () => {
  assert.equal(SESSION.KEEPALIVE | SESSION.MIGRATEHOST | 0x2, 0x46);
});

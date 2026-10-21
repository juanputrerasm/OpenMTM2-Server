# The DirectPlay gateway

With the gateway on, an OpenMTM2 player can open a room to **classic players**: people playing
Monster Truck Madness 2 itself (retail 2.00.42, the patched game, or Community Patch 3's
DirectPlay connection). In the game they choose Multiplayer, TCP/IP, Join, and type the room
server's address. The room appears in the game's session list under its own name. Once they join,
both sides share one lobby and race together.

```sh
node bin/openmtm2d.mjs --gateway
```

## How it works

The room server hosts a DirectPlay session for the room (`rooms/gateway.js`, over the DirectPlay
node in `dplay/`).

- **OpenMTM2 players → the game.** Every OpenMTM2 member of the room is a game player in that
  session, on the server's machine. Classic players see them in their list with name, truck,
  level and status. Their truck state, events and chat are passed on as the game's own packets.
  OpenMTM2 players send truck state 20 times a second; the gateway passes on at most 10 a
  second.
- **The game → the room.** Every classic player is a member of the room, labelled
  `MTM2 (classic)`, that the gateway drives. The gateway turns its packets into room messages:
  - player info, ready and location become its profile;
  - its track checksum becomes the room's track check;
  - its sync barrier means "loaded";
  - its truck state, checkpoints, damage, headlights, horn and YeeHaw become race traffic;
  - its 0x18 becomes its result.
- **The player list.** As the game's host does (OpenMTM2's `MONSTER_EXE_ANALYSIS.md` 14.2), the
  gateway sends 0x81 about every OpenMTM2 player it adds, and 0x83 when one goes. A newcomer gets
  0x81 and 0x82 for each OpenMTM2 player, and 0x88 naming the host.
- **Classic to classic.** Classic players reach each other directly, as DirectPlay always
  connects every machine to every other. The gateway does not carry that traffic.
- **The host.** In the session the server's machine is the host, and the room's owner speaks for
  it. The owner's track, laps and weather are sent with the host's packets. So are the start:
  0x8a, a 0x87 slot for every racer, then 0x14. The start positions (0x17) and the end of the
  race (0x0e) also go this way. A new owner is announced with 0x88. The lobby's latency for
  classic players comes from the gateway's own pings.

What the packets mean is in OpenMTM2's `docs/MONSTER_EXE_ANALYSIS.md`, section 14.

## Rules of a classic room

- **Players:** up to 8, the game's limit. There are no computer opponents and no extension
  modes, since the classic packets for computer players are not confirmed.
- **Ownership:** only an OpenMTM2 player can make or own the room. When only classic players are
  left, the room and its session close, and the game reports the session as lost.
- **How many:** one classic room at a time per server (`maxGatewayRooms`), because DirectPlay finds
  games on one port, 47624, per address.
- **Passwords:** a room with a password is hidden from classic players, since the game's Join
  dialog cannot ask for one.
- **Bans:** banned addresses are refused here too.

## Ports

The gateway is DirectPlay, so it needs DirectPlay's ports on the server, opened in its firewall:

| Port | Protocol | |
|---|---|---|
| 47624 | UDP and TCP | the game finds the session |
| 2300 to 2350 | TCP | `gatewayTcpPorts` |
| 2350 to 2400 | UDP | `gatewayUdpPorts` |

DirectPlay also connects back to every player. So, as in any classic game, **classic players need
their own DirectPlay ports reachable**: forwarded on their router, or through a VPN shared with the
server. OpenMTM2 players need nothing beyond the room server's one port.

With Docker, publish the ports too (`-p 47624:47624/udp -p 47624:47624 -p 2300-2350:2300-2350
-p 2350-2400:2350-2400/udp`) and give the gateway the host's own address. Host networking
(`--network host`) is simpler, because DirectPlay messages carry addresses.

## Settings

| Setting | Default | |
|---|---|---|
| `gateway` | false | `--gateway`, `OPENMTM2_GATEWAY` |
| `gatewayBind` | `0.0.0.0` | Address the DirectPlay sockets use (`--gateway-bind`, `OPENMTM2_GATEWAY_BIND`) |
| `maxGatewayRooms` | 1 | Classic rooms at a time |
| `gatewayEnumPort` | 47624 | Only for tests: the game always looks on 47624 |
| `gatewayTcpPorts` | 2300-2350 | |
| `gatewayUdpPorts` | 2350-2400 | |

## To check against the game

`tests/gateway.test.mjs` plays both sides on one machine. Its stand-in for the game is our own
DirectPlay node sending MTM2's packets, so these points still need the game itself:

- that the game lists several players on one machine (the server's), each with its own info;
- that it takes the room owner's packets as the host's, and shows "(Host)" where expected;
- the start through the gateway (slots, then 0x14), and the race and results both ways;
- that classic players behind a router can play once their ports are forwarded.

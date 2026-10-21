# OpenMTM2 Server

Network services for [OpenMTM2](https://github.com/juanputrerasm/OpenMTM2), the browser
reimplementation of Monster Truck Madness 2. Node 22.18 or newer, no dependencies.

| Program | What it does | Status |
|---|---|---|
| `bin/openmtm2-bridge.mjs` | The desktop helper for **classic multiplayer**. A browser cannot open the TCP and UDP sockets DirectPlay needs, so OpenMTM2 asks this program, running on the same computer, to do it. With it OpenMTM2 hosts and joins games with Monster Truck Madness 2 itself (retail 2.00.42, the patched game, and Community Patch 3's DirectPlay connection). | Ready to try |
| `bin/openmtm2d.mjs` | The **room server** for online play: a room list, room codes and invite links, the lobby and the race. Runs headless as a daemon (systemd, Docker). Needs no game files. | Ready to try |
| `cloudflare/` | Optional: the same room server as a **Cloudflare Worker**, on Cloudflare's free plan with no machine to run. Online rooms only, no DirectPlay gateway. | Ready to try |

## Classic multiplayer: the helper

```sh
node bin/openmtm2-bridge.mjs
```

It prints a pairing token. In OpenMTM2, open **Multiplayer** and type the token, then host a
game or type the host's IP address and find its games. The **Connection** list picks DirectPlay
(every version of the game) or **CP3 direct connect**, Community Patch 3's own UDP connection,
which needs only UDP port 2350 on the host.

- **Allowed pages:** the helper listens on `127.0.0.1:47650` only. Only OpenMTM2's own site, and
  pages served from this computer, may use it, and only with the token. Add another origin with
  `--origin https://example.org`. Keep the same token across restarts with `--token <text>`.
- **One at a time:** one page at a time. A MONSTER.EXE running on the same computer needs the
  same ports, so run one or the other there.
- **Ports:** DirectPlay connects every player to every other. Each computer must accept
  connections on TCP 2300 to 2350 and UDP 2350 to 2400, and the host also on TCP and UDP 47624.
  Forward them on the router, or play over a VPN such as Radmin VPN, as MTM2 players do today.

The helper's protocol with the page is in `docs/BRIDGE.md`.

## Online rooms: the room server

```sh
node bin/openmtm2d.mjs --state-dir ./state --log-format text
```

In OpenMTM2, open **Multiplayer**, type the server's address under **Online rooms** (`localhost`
for this computer), and browse, make or join a room. Players need nothing open on their side.
A public server needs TLS, normally from a reverse proxy.

- Running it, settings, signals, admin endpoints, systemd and Docker: `docs/DAEMON.md`
- The protocol, for other clients: `docs/PROTOCOL.md` (draft of version 1)
- Online rooms explained for Community Patch 3's developer, with open questions: `docs/ONLINE_ROOMS_CP3.md`
- `deploy/`: a systemd unit, a sample `server.json`, a Dockerfile, Caddy and nginx examples

No machine to run it on? `npm run worker:deploy` puts the same rooms on Cloudflare's free Workers
plan, with TLS included and no payment card. It has daily limits and no gateway for classic players;
see `docs/CLOUDFLARE.md`.

With `--gateway`, a room can also be opened to **classic players**: Monster Truck Madness 2
itself joins it by typing the server's address, as it joins any host, and races with the
room's OpenMTM2 players. One such room at a time; see `docs/GATEWAY.md`.

## How it is built

| Folder | |
|---|---|
| `dplay/` | DirectPlay 4 over TCP/IP, written from Microsoft's open specification [MC-DPL4CS](https://learn.microsoft.com/en-us/openspecs/windows_protocols/mc-dpl4cs/): the messages (`codec.js`) and a node that finds, hosts and joins sessions (`provider.js`) |
| `cp3udp/` | Community Patch 3's own UDP direct connect, from the trace in OpenMTM2's `docs/MONSTER_EXE_ANALYSIS.md` 14.5 (CP3's author published no source code): the datagrams (`codec.js`) and a node that hosts or joins (`node.js`) |
| `protocol/` | Monster Truck Madness 2's own packets, the room protocol's messages and truck state, and the track checksum. Plain modules that also run in a browser. OpenMTM2 uses a copy: `node tools/vendor.mjs ~/dev/OpenMTM2/src/net/vendor/mtmnet` |
| `rooms/` | The rooms: lobby, seating, the loading and results barriers, relaying (`room-server.js`); the DirectPlay gateway for classic players (`gateway.js`) |
| `lib/` | A small WebSocket server (`ws.js`), the daemon's settings, log and ban list |
| `cloudflare/` | The room server as a Cloudflare Worker: one Durable Object holding every room (`docs/CLOUDFLARE.md`) |
| `tests/` | `npm test` (`node --test tests/`) |

What Monster Truck Madness 2 sends is documented in OpenMTM2's `docs/MONSTER_EXE_ANALYSIS.md`,
section 14, and the design in its `docs/MULTIPLAYER.md`. No code here comes from the game or from
other DirectPlay implementations.

## Licence

Apache 2.0, as OpenMTM2.

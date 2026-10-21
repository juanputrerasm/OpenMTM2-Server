# Running the room server (openmtm2d)

`openmtm2d` hosts OpenMTM2's online rooms: a list of rooms, room codes and invite links, a lobby
with chat, and the race itself, relayed between the players. It needs Node 22.18 or newer and
nothing else: no game files, no database, no dependencies. One small process holds dozens of
rooms.

```sh
node bin/openmtm2d.mjs                                   # port 47660, every address
node bin/openmtm2d.mjs --config /etc/openmtm2/server.json
node bin/openmtm2d.mjs --port 47660 --state-dir ./state --log-format text
node bin/openmtm2d.mjs --print-config                    # the settings it would use, then exit
```

Players type the server's address on OpenMTM2's Multiplayer screen, under **Online rooms**. A
name such as `rooms.example.org` means `wss://rooms.example.org/play`; `localhost` and plain IP
addresses mean `ws://` on port 47660.

## TLS

OpenMTM2's site is served over HTTPS, and a page served over HTTPS may only open `wss://`
connections. A public server therefore needs TLS. The usual way is a reverse proxy on the same
machine (`deploy/Caddyfile` or `deploy/nginx.conf`), with the daemon on `127.0.0.1` and
`trustProxy` on, so bans and limits see the players' own addresses. The daemon can also serve TLS
itself with `cert` and `key` (PEM files), but it does not renew certificates.

Players on a home network can use the daemon without TLS by serving OpenMTM2 locally too
(`tools/serve.mjs` in OpenMTM2), since a page from `http://localhost` may open `ws://`.

## Settings

Settings come from, in order, the defaults, a JSON file (`--config` or `OPENMTM2_CONFIG`),
environment variables, and command-line flags; each overrides the one before. A bad value stops
the daemon at start with exit code 2. `deploy/server.example.json` is a starting file.

| Setting | Default | Environment | Flag | |
|---|---|---|---|---|
| `host` | `0.0.0.0` | `OPENMTM2_HOST` | `--host` | Address to listen on. `127.0.0.1` behind a proxy |
| `port` | 47660 | `OPENMTM2_PORT` | `--port` | |
| `name` | OpenMTM2 server | `OPENMTM2_NAME` | `--name` | Shown in the room list |
| `motd` | | `OPENMTM2_MOTD` | `--motd` | A message shown above the room list |
| `origins` | OpenMTM2's site | `OPENMTM2_ORIGINS` (commas) | `--origin` (repeat) | Web pages allowed to connect; `*` for any |
| `allowLocalOrigins` | true | | | Also pages served from the player's own computer |
| `allowNoOrigin` | true | | | Clients that send no `Origin`, such as native games |
| `maxRooms` | 50 | `OPENMTM2_MAX_ROOMS` | `--max-rooms` | |
| `maxPlayers` | 8 | `OPENMTM2_MAX_PLAYERS` | `--max-players` | Per room, 2 to 16. A track's start grid limits how many can race on it |
| `maxMembers` | 200 | | | Connections in all |
| `maxConnectionsPerIp` | 8 | | | |
| `connectionsPerMinutePerIp` | 30 | | | |
| `messagesPerSecond` | 20 | | | Per connection; a client that keeps flooding is dropped |
| `chatPerSecond` | 2 | | | |
| `loadTimeoutS` | 120 | | | How long a race waits for everyone to load |
| `resultsTimeoutS` | 30 | | | How long it waits for everyone's results |
| `startDelayMs` | 1500 | | | From "everyone loaded" to the start, so all clients start together |
| `drainS` | 60 | | `--drain` | On stop, how long running races may go on |
| `logLevel` | info | `OPENMTM2_LOG_LEVEL` | `--log-level` | debug, info, warn, error |
| `logFormat` | json | `OPENMTM2_LOG_FORMAT` | `--log-format` | json (one object per line) or text |
| `adminToken` | | `OPENMTM2_ADMIN_TOKEN` | `--admin-token` | Turns on `/admin/`; keep it secret |
| `stateDir` | `/var/lib/openmtm2` | `OPENMTM2_STATE_DIR`, `STATE_DIRECTORY` | `--state-dir` | Where the ban list is kept |
| `trustProxy` | false | `OPENMTM2_TRUST_PROXY` | `--trust-proxy` | Read the player's address from `X-Forwarded-For` |
| `cert`, `key` | | `OPENMTM2_CERT`, `OPENMTM2_KEY` | `--cert`, `--key` | Serve TLS directly |
| `gateway` | false | `OPENMTM2_GATEWAY` | `--gateway` | Rooms open to the original game through DirectPlay (`docs/GATEWAY.md`) |
| `gatewayBind` | `0.0.0.0` | `OPENMTM2_GATEWAY_BIND` | `--gateway-bind` | The DirectPlay sockets' address |
| `maxGatewayRooms`, `gatewayTcpPorts`, `gatewayUdpPorts`, `gatewayEnumPort` | 1, 2300-2350, 2350-2400, 47624 | | | See `docs/GATEWAY.md` |

systemd's `StateDirectory=` sets `STATE_DIRECTORY`, which then wins over the file's `stateDir`.
When the state folder cannot be written, bans are kept in memory and a warning is logged.

## Signals

| Signal | What happens |
|---|---|
| `SIGHUP` | Reads the settings and the ban list again. The address, port and certificate change only on a restart; a reload with a bad file keeps the old settings and logs an error |
| `SIGTERM`, `SIGINT` | Stops taking connections and new rooms, tells every player the server is shutting down, lets running races finish for up to `drainS`, then closes everything and exits 0. A second signal exits at once |

An unexpected error is logged and the process exits 1, for systemd or Docker to restart it.
Bad messages from a client never reach that far: each is answered with an error.

## HTTP

| | |
|---|---|
| `GET /healthz` | `ok`, or 503 while shutting down |
| `GET /status` | name, version, protocol, uptime, rooms, players, races running, counters |
| `GET /rooms` | the public rooms, as the room list shows them |
| `GET /` | what this server is, and the WebSocket path |

With `adminToken` set and `Authorization: Bearer <adminToken>`:

| | |
|---|---|
| `GET /admin/rooms` | every room, private ones too, with its members and their addresses |
| `POST /admin/rooms/<code>/close` | closes a room; its players go back to the list |
| `POST /admin/members/<id>/kick` | disconnects a player |
| `GET /admin/bans` | the bans |
| `POST /admin/bans` | `{ "ip": "203.0.113.9", "minutes": 60, "reason": "..." }` bans an address (no minutes: for good) and drops its connections |
| `DELETE /admin/bans/<ip>` | lifts a ban |
| `POST /admin/reload` | as `SIGHUP` |

```sh
curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:47660/admin/rooms
curl -X POST -H "Authorization: Bearer $TOKEN" -d '{"ip":"203.0.113.9","minutes":60}' http://127.0.0.1:47660/admin/bans
```

The admin endpoints listen wherever the daemon listens. Behind a proxy, keep `/admin/` off the
public side, or reach it on the machine itself.

## systemd

```sh
sudo cp -r bin lib dplay protocol rooms package.json /opt/openmtm2-server/
sudo mkdir -p /etc/openmtm2 && sudo cp deploy/server.example.json /etc/openmtm2/server.json
sudo cp deploy/openmtm2d.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now openmtm2d
systemctl status openmtm2d
journalctl -u openmtm2d -f
sudo systemctl reload openmtm2d        # after editing server.json
```

The unit runs the daemon as a throwaway user (`DynamicUser`) with a private state folder, a
read-only system and no extra privileges. Every port it uses is above 1024.

## Docker

```sh
docker build -f deploy/Dockerfile -t openmtm2d .
docker run -d --name openmtm2d --restart unless-stopped -p 47660:47660 -v openmtm2:/data \
  -e OPENMTM2_NAME="My server" -e OPENMTM2_ADMIN_TOKEN=change-me openmtm2d
docker kill -s HUP openmtm2d           # reload
docker stop -t 90 openmtm2d            # drain, then stop
```

## Firewall

Open the one port players connect to: 443 when a proxy serves TLS, otherwise 47660 (TCP). Online
rooms need nothing open on the players' side. With the gateway on, also open 47624 (UDP and TCP), TCP 2300 to 2350 and
UDP 2350 to 2400.

## Logs

One line per event. In JSON: `{"t":"2026-10-20T18:02:11.513Z","level":"info","msg":"join","room":"K7QX2M","member":12,"name":"Ann"}`.
Rooms created and closed, joins and leaves, races and their results, bans, reloads and errors are
logged at `info` and above; connections at `debug`. Chat is never logged.

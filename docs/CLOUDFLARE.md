# Online rooms on Cloudflare

An optional way to host the room server: on Cloudflare's free Workers plan instead of running
`openmtm2d` on a machine. The free plan needs no payment card. When a daily limit runs out,
requests fail until the counters reset at 00:00 UTC; nothing is billed.

It runs the same rooms as `openmtm2d` (`rooms/room-server.js`) behind the same endpoints, so
OpenMTM2 needs no change: players type the Worker's address, such as
`openmtm2-rooms.example.workers.dev`, under **Online rooms**.

| | `openmtm2d` | Cloudflare Worker |
|---|---|---|
| Rooms, lobby, race, relay | Yes | Yes, the same code |
| `/status`, `/rooms`, `/healthz`, `/admin/...` | Yes | Yes (`/admin/reload` reads the bans again) |
| Classic players through the DirectPlay gateway | Yes | No: Cloudflare carries web traffic only |
| TLS | A reverse proxy, or `--cert` | Included |
| Settings | File, environment, flags; SIGHUP | The Worker's variables; change on a deploy |
| Bans | `<stateDir>/bans.json` | The object's own storage |
| Draining on shutdown | Yes | No: a deploy drops every connection |

## How it is built

| File | |
|---|---|
| `cloudflare/worker.js` | The Worker: sends every request to one Durable Object, `RoomsObject`, which holds every room. Reads the settings and keeps the bans in the object's SQLite storage |
| `cloudflare/edge-server.js` | The endpoints and the WebSocket checks (origin, bans, per-address limits), as in `bin/openmtm2d.mjs`. No Cloudflare imports, so `tests/cloudflare.test.mjs` runs it on Node |
| `cloudflare/wrangler.toml` | The Worker's name, its Durable Object, and its settings |

Shared with the daemon: `rooms/room-server.js`, `protocol/`, `lib/settings.js` (defaults and
checks), `lib/ban-list.js`, `lib/origins.js`, `lib/log.js`.

One object holds every room, so every player sees every room, as on one `openmtm2d`. It keeps its
sockets open the whole time players are connected (no hibernation), so rooms and races live in
memory exactly as in the daemon.

## Deploying

You need a free Cloudflare account and Node 22. Wrangler, Cloudflare's tool, runs through `npx`;
the project still has no dependencies.

```sh
npx wrangler login
npm run worker:deploy                  # npx wrangler deploy --config cloudflare/wrangler.toml
npx wrangler secret put OPENMTM2_ADMIN_TOKEN --config cloudflare/wrangler.toml   # optional: the admin endpoints
```

The address is printed at the end: `https://openmtm2-rooms.<your account>.workers.dev`. Check it:

```sh
curl https://openmtm2-rooms.<your account>.workers.dev/status
```

- **Logs:** `npm run worker:tail`, or the Worker's page in the Cloudflare dashboard.
- **Your own domain:** add a route or custom domain to the Worker in the dashboard. Players then
  type that name.
- **Try it on your computer first:** `npm run worker:dev`, then type `localhost:8787` in OpenMTM2.

## Settings

In `cloudflare/wrangler.toml`, under `[vars]`, then `npm run worker:deploy` again:

| Variable | |
|---|---|
| `OPENMTM2_NAME`, `OPENMTM2_MOTD`, `OPENMTM2_ORIGINS`, `OPENMTM2_MAX_ROOMS`, `OPENMTM2_MAX_PLAYERS`, `OPENMTM2_LOG_LEVEL` | As in `docs/DAEMON.md` |
| `OPENMTM2_SETTINGS` | Any other setting of `docs/DAEMON.md`, as in `server.json` (`maxMembers`, `messagesPerSecond`, `loadTimeoutS` and so on). The variables above win over it |
| `OPENMTM2_LOCATION` | Where the object lives: `wnam` (western North America), `enam` (eastern North America), `weur`, `eeur`, `apac`, `oc`, `afr`, `me`. Empty: near the first player. It applies when the object is first made |
| `OPENMTM2_ADMIN_TOKEN` | A secret, set with `wrangler secret put`, not in the file |

`host`, `port`, `cert`, `key`, `stateDir`, `trustProxy`, `drainS` and the gateway's settings do
nothing here. The player's address is Cloudflare's `CF-Connecting-IP`.

## What the free plan allows

From Cloudflare's Durable Objects pricing page (check it for changes):

- **100,000 requests a day.** Every 20 messages a player sends count as one request; messages the
  server sends count for nothing. A racer sends truck state up to 30 times a second
  (`STATE_MAX_HZ`), so an 8-player race uses about 12 requests a second: about **2.3 hours of
  8-player racing a day**, roughly 27 five-minute races. With 4 players, about 4.6 hours. The
  lobby costs almost nothing.
- **13,000 GB-s of running time a day.** The object counts as 128 MB while anyone is connected,
  so even players connected all day (10,800 GB-s) fit.
- **Storage:** the bans are one row; far inside the limits.
- **One object** handles about a thousand messages a second, more than the free requests allow.

When the requests run out, new connections and messages fail until 00:00 UTC. `/status` shows
`framesRelayed` and `connections` to see how close a server gets.

# The helper's protocol (openmtm2-bridge)

The page connects to `ws://127.0.0.1:47650/bridge`. A plain `GET http://127.0.0.1:47650/` answers
`{ "name": "openmtm2-bridge", "protocol": 1, "busy": false }`, so the page can tell whether the
helper runs.

**Origin:** the connection is refused (HTTP 403) unless the page's origin is OpenMTM2's site, a
page served from this computer, or one given with `--origin`. A second page while one is
connected is closed with code 4002.

## Requests and replies (text frames, JSON)

Every request has an `id`. The reply is `{ id, type: "result", ... }`, or
`{ id, type: "error", message }`.

| Request | Fields | Result |
|---|---|---|
| `hello` | `token` | `{ name, protocol }`. Must come first; a wrong token closes the connection with code 4001 |
| `enum` | `ip` (empty: broadcast on the local network), `timeoutMs` (up to 5000, default 1000), `all` | `{ sessions: [{ instance, name, maxPlayers, currentPlayers, flags, user, host: { ip, port }, version }] }` |
| `host` | `name`, `playerName`, `maxPlayers` (2 to 8), `migrateHost` (default true) | the session, below |
| `join` | `instance` (from `enum`), `playerName`, `password` | the session, below |
| `host` with `kind: "cp3"` | `playerName`, `port` (default 2350) | the session, with `kind: "cp3"` |
| `join` with `kind: "cp3"` | `ip`, `port` (default 2350), `playerName` | the session, with `kind: "cp3"` |
| `leave` | | `{}` |
| `state` | | the session, or `{}` |

The session:

```
{ systemId, playerId, isHost, hostId, hostPlayerId,
  session: { name, maxPlayers, flags, isHost },
  players: [{ id, name, local, systemPlayerId }], ports: { tcpPort, udpPort } }
```

`playerId` is this page's DirectPlay player. `hostPlayerId` is the host machine's player.

**Community Patch 3's direct connect** (`kind: "cp3"`, `cp3udp/`, OpenMTM2's
`docs/MONSTER_EXE_ANALYSIS.md` 14.5) is CP3's own UDP connection: no game list, the host's address
and port typed in, the host relaying for everyone. Player IDs are its own (the host 1, joiners from
2). A client hears only of the host here; the game's 0x81 packets tell it of the others. Packets go
reliably except the truck state (0x02), as CP3 sends them, unless flag bit 0 asks for it. A direct
connect node and DirectPlay both use UDP port 2350, so the helper closes one before opening the
other.

## Events (text frames, JSON)

| Event | Fields |
|---|---|
| `player` | `id, name, joined, local`: a player joined or left |
| `host` | `id` (the host's system player), `local`, `playerId` (its game player) |
| `lost` | `reason`: the session ended |
| `log` | `text`: diagnostics |

## Game messages (binary frames)

- **Page to helper:** `[u32 to][u8 flags][packet]`. `to` is a player ID, or 0 for every other
  player. Flag bit 0 means guaranteed (TCP); otherwise the packet goes over UDP.
- **Helper to page:** `[u32 from][u32 to][packet]`.

The packet is one of Monster Truck Madness 2's own (`protocol/mtm2-packets.js`), starting with
its type byte.

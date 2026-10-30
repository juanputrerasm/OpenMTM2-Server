# The OpenMTM2 room protocol, version 1

**Status: draft.** Version 1 is frozen after a review with Community Patch 3's developer. Until
then, details may change. `protocol/room-messages.js` is the reference implementation of the
messages and the state frame; `rooms/room-server.js` is the server.

This is how a game client talks to an OpenMTM2 room server (`openmtm2d`) to play Monster Truck
Madness 2 online in rooms. It is independent of DirectPlay and of the game's own packets.

## Connection

- One WebSocket (RFC 6455) per client, to `wss://<server>/play` (`ws://` on a local network).
  The default port, without a proxy, is 47660.
- Browsers send `Origin`, which the server checks. Native clients send none and are allowed by
  default.
- **Text frames** hold one JSON object each (UTF-8), at most 8192 bytes. **Binary frames** hold
  truck state, 68 bytes each.
- The server pings every 20 s. A client that answers no ping for two rounds is dropped.
  Standard WebSocket libraries answer pings by themselves.
- A Cloudflare Worker cannot ping, so the room server also drops a client it has heard nothing
  from for `idleTimeoutS` (120 s by default), closing with code 4010, and the player leaves their
  room as if they had disconnected. Clients send `ping` every 15 s to stay in (OpenMTM2 does).

## Requests and answers

Every client message has a `type`. It may carry an `id`, a whole number from 0 to 2^31 - 1.
Messages with an `id` are answered with:

```json
{ "type": "result", "id": 7, ...fields }
{ "type": "error", "id": 7, "code": "full", "message": "The room is full." }
```

An error caused by a message without an `id` comes back without one. Unknown fields are
ignored. Text is trimmed, and control characters are removed.

| Error code | |
|---|---|
| `bad-request` | The message is malformed or a field is out of range (`message` says which) |
| `protocol` | Another protocol version. The connection is then closed with 4000 |
| `hello-first` | Anything other than `hello` or `ping` before `hello` |
| `not-found` | No such room or player |
| `full` | The room is full |
| `password` | Wrong password for the room |
| `not-owner` | Only the room's owner may do that |
| `state` | Not now. Examples: start while not everyone is ready, or join a room that is racing |
| `not-in-room` | The client must join a room first |
| `rate-limited` | Too many messages. Slow down |
| `limit` | The server has no room for another room |
| `shutting-down` | The server takes no new rooms |

| Close code | |
|---|---|
| 1001 | The server is shutting down |
| 1008 | The client reads too slowly |
| 4000 | Protocol version |
| 4003 | Banned |
| 4004 | Removed by the server's admin |
| 4008 | Kept flooding after rate-limit errors |
| 4009 | The server is full |
| 4010 | Nothing heard from the client for `idleTimeoutS` |

## Client messages

| Type | Fields | Answer |
|---|---|---|
| `hello` | `protocol` (1), `name` (1 to 24), `client` (optional, up to 40, such as "OpenMTM2" or "CP3 2.0.52") | `protocol`, `you: { id }`, `server: { name, motd, version }`, `limits`, `features`: `classic` when the server can open rooms to classic players, `teamChat` when it routes team lines (`chat` with `team`) |
| `ping` | `t`, any number | `{ type: "pong", t, server }`, where `server` is the server's clock in ms |
| `list` | | `rooms`: the public rooms (below) |
| `create` | `name` (1 to 40), `password` (optional, up to 32), `maxPlayers` (2 to the server's limit), `public` (default true), `classic` (optional: open to the original game through the server's DirectPlay gateway, `docs/GATEWAY.md`) | `room`. The client is now in it and owns it |
| `join` | `room` (its code, any case), `password` | `room` |
| `leave` | | |
| `profile` | Any of: `truck` (file name), `skill` (0 Rookie, 1 Intermediate, 2 Professional), `location` (below), `ready`, `team`, `latency` (ms), `content: { sit, crc }` | Every member gets `member` |
| `chat` | `text` (1 to 160), `to` (optional, a member id: private), `team` (optional, member ids: a team line, sent to those of them in the room; `to` wins over it) | |
| `settings` | Owner only, in the lobby. Any of: `track: { sit, name, crc }` or null, `laps` (1 to 99), `weather` (-1 Random, 0 to 15), `mode` (empty for a plain race), `computers` (0 to 15), `damage`, `collisions`, `wheels` and `wheelsRepairS` (0 to 600: OpenMTM2's Wheels damage, on or off, and the seconds before the wheels go back on, 0 never; default off and 8) | Every member gets `room` |
| `kick` | `member`. Owner only | That member gets `kicked`; the others get `left` |
| `start` | `weather` (0 to 15, already drawn when Random), `computers: [{ name, truck }]`. Owner only, with a track, with every other member ready, and with no member whose `content` says it lacks the track | Every member gets `starting` |
| `loaded` | | The loading barrier, below |
| `race` | `e`, a race event (below) | No answer |
| `result` | `laps`, `total` (s), `best` (s, or the score in Summit), `lapsLed` | The results barrier, below |

**Locations** (the lobby's Status column) are the classic game's: 1 Start Screen, 2 Driver
Check-in, 3 Race Screen, 4 Garage, 5 Multiplayer Screen, 6 Hall Of Fame, 7 Viewing Results,
8 Instant Replay, 9 Racing.

**Tracks** are named by their SIT file name (`TPARK.SIT`) and a checksum. The checksum is the
classic game's: CRC-32/MPEG-2 (polynomial 0x04C11DB7, initial value 0xFFFFFFFF, not reflected,
no final XOR) over the whole POD archive that holds `WORLD\<SIT>`. The value is -1 when the
client does not have the track. After every change of track, each member reports
`content: { sit, crc }` for its own copy.

## Server messages

| Type | Fields | When |
|---|---|---|
| `member` | `member` | Someone joined or changed their profile |
| `left` | `member` (id), `reason` (`left`, `disconnected`, `removed`) | Someone left |
| `owner` | `member` | The owner left; the longest-present member owns the room now |
| `room` | `room` | Settings changed, or a race ended |
| `chat` | `from`, `name`, `text`, `private`, `team` (a team line) | Senders do not get their own lines back |
| `kicked` | `reason` (`removed`, or why the admin closed the room) | This client is out of the room, but still connected |
| `starting` | `race` | The owner started |
| `waiting` | `left`: names | Someone loaded; these have not yet |
| `synced` | `startAt`, `serverTime` (server clock, ms) | Everyone loaded |
| `race` | `from` (member id, 0 for the server), `e` | Another member's race event |
| `results` | `race`, `results: { "<vehicle>": { laps, total, best, lapsLed } }` | The race is over |
| `shutdown` | `text`, `inMs` | The server is stopping |

**A room** is `{ code, name, owner, locked, public, maxPlayers, state, classic, settings, members, race }`.
`state` is `lobby`, `loading` or `racing`. **A member** is `{ id, name, client, truck, skill,
location, ready, team, latency, content, classic }`; `classic` marks a player of the original game,
in the room through the gateway. Names are unique within a room: a second "Ann"
becomes "Ann (2)". **A room in the list** is `{ code, name, players, maxPlayers, locked, state,
classic, track: { sit, name } | null, mode, owner }`, with the owner's name.

**A classic room** keeps the original game's limits: at most 8 players, no computer opponents
(`computers` stays 0), no `mode`. Its classic members never own it; when only they are left, the
room closes. One classic room may be open per server at a time (`create` answers `limit`).

Room codes are six characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. OpenMTM2's invite
links are its own page address with `?room=CODE&server=<address>` added.

## A race

1. **Start.** The owner sends `start`. The server seats everyone in random order and gives
   each truck a **vehicle number** from 1. The start grid place is the vehicle number minus 1.
   It answers with `starting`: `race: { id, sit, track, laps, weather, mode, entrants }`, each
   entrant being `{ vehicle, member, computer, name, truck, owner }`. Computer trucks have
   `member: null`, and the owner's client drives them.
2. **Loading.** Each client loads the track, then sends `loaded`. The server sends `waiting`
   as clients finish. When all have loaded, or after 120 s, it sends `synced` with `startAt`,
   a little after now. Clients that never loaded are out: their trucks get a `gone` event.
3. **Start positions.** The owner sends `race { e: { kind: "positions", positions } }`. The
   array is indexed by vehicle number, with index 0 unused.
4. **Countdown.** Each client starts its countdown at `startAt` in its own clock, offset by the
   server's clock from `ping`. The first client whose countdown ends sends `race { e: { kind:
   "go" } }`, and the others start their race at once if they have not yet.
5. **Racing.** Each client sends the state of the trucks it owns (its own, plus the computer
   trucks for the owner) as binary frames, 20 a second. It also sends race events as they
   happen.
6. **Results.** Each client sends `result` for its own truck when its race ends. When every
   client still racing has sent one, or 30 s after the first, the server sends `results`. It
   then sends `room`, with the room back in the lobby and nobody ready.

A client that leaves during a race sends `race { e: { kind: "gone", vehicle } }`. The server
sends the same when a client disconnects, and also for the owner's computer trucks when the
owner leaves. From then on, every client drives that truck with its own computer driver.

### Race events

| `kind` | Fields | |
|---|---|---|
| `positions` | `positions` | Owner only |
| `go` | | |
| `split` | `vehicle`, `next`, `split` | A checkpoint pass: the next checkpoint, and the seconds since the truck's last pass |
| `damage` | `vehicle`, `code` | The truck's damage code, as the classic packet 0x20 carries it (OpenMTM2's `docs/MONSTER_EXE_ANALYSIS.md`, section 14) |
| `lights` | `vehicle`, `lamps` | Headlights |
| `horn`, `yeehaw` | `vehicle` | |
| `gone` | `vehicle` | The truck now drives itself everywhere |
| `mode` | `data`, an object | An extension mode's state (Hockey, Tag), owner only. Its shape is the mode's own; OpenMTM2 sends it 5 times a second and at once on an event |
| `modeTruck` | `vehicle`, `data`, an object | An extension mode's state for the trucks the sender drives (Combat's hit points, wheels and credits), sent as the sender's vehicle |
| `wheels` | `vehicle`, `lost` (0 to 15), `axles` (0 to 3), optional `wear` (four numbers 0 to 1), `repairs`, `pits` | OpenMTM2's Wheels damage: the truck's wheels as the machine that drives it judges them. `lost` and `axles` are bit masks (wheels 0 to 3; axle 0 front, 1 rear). Sent on a change, and the wear at most once a second |

A client may only send events for trucks it owns. Anything else is dropped without an error.

### Truck state (binary, 68 bytes, little-endian)

| Offset | Type | |
|---|---|---|
| 0 | u8 | 1, a truck state frame |
| 1 | u8 | vehicle number |
| 2 | u16 | sequence number; wraps; a frame older than the last one is dropped |
| 4 | u32 | the sender's clock in ms; wraps |
| 8 | f32 x 3 | position, feet, in the track's world coordinates |
| 20 | f32 x 3 | velocity in the truck's own axes, feet per second |
| 32 | f32 x 3 | angles in radians: theta, phi, psi, in the classic packet 0x02's order; psi is the heading |
| 44 | f32 | steering, radians of front-wheel angle |
| 48 | f32 | throttle, 0 to 1 |
| 52 | f32 | rear brake, 0 to 1 |
| 56 | f32 | front brake, 0 to 1 |
| 60 | s8 | gear: 1 Park, 2 Reverse, 3 Neutral, 4 and up the forward gears |
| 61 | u8 | flags: bit 0 automatic gearbox |
| 62 | u16 | reserved, 0 |
| 64 | f32 | score (Summit Rumble), otherwise 0 |

The server forwards a frame unchanged to the room's other members. It does this only during a
race, only for a truck the sender owns, and at most 30 frames a second per truck. A frame with
any number that is not finite is dropped.

**Remote trucks.** Each client simulates the other trucks as ordinary physics bodies. Every
frame sets their controls, velocity and angles. OpenMTM2 blends the position error away over
0.5 s, and moves the truck at once when the error is beyond 100 ft. Collisions between trucks
are worked out on each machine against its own copies, as in the classic game.

## Extension modes

A room's `settings.mode` names an extension mode (OpenMTM2's Hockey or Tag), empty for a plain race.
Every client runs the same mode. The owner's client judges it: it runs the mode's rules and sends
their state as `race { e: { kind: "mode", data } }`. The others apply that state instead of
deciding goals, tags or scores themselves. When the owner leaves, the new owner's client takes over
from the last state. Per-truck values in `data` are keyed by vehicle number. A client that does not
know a room's mode should not join its races; the server does not check this.

Some modes judge each truck on the client that drives it, as only that client sees its truck's own crashes
(OpenMTM2's Combat: each truck's hit points, wheels and credits). Such a client sends the state of the trucks it
drives as `race { e: { kind: "modeTruck", vehicle, data } }`, `vehicle` being its player's (the owner's message
covers its computer trucks too). Any player may send it, for a vehicle it owns, like a damage code. The owner still
sends `mode` for what only one client may decide (the end and the winner).

## Compatibility

- `hello.protocol` is the major version. The server refuses another one with `protocol` and
  close code 4000.
- Within a version, new fields and new message types may appear. Clients ignore what they do
  not know. Servers ignore unknown fields and answer unknown types with `bad-request`.
- `client` in `hello` is shown to other players and logged. It is not used to make decisions.

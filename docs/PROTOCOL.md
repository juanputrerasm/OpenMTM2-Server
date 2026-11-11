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
  truck state, 68 bytes each, or, in a relay room, relay frames (first byte 0xC3, below). A
  binary frame over 8192 bytes closes the connection with 1009.
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
| `capability` | The room needs a capability this client did not declare in `hello.caps` (a relay room needs `cp3-relay/1`) |

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
| `hello` | `protocol` (1), `name` (1 to 24), `client` (optional, up to 40, such as "OpenMTM2" or "CP3 2.0.52"), `caps` (optional: up to 16 capability names, each 1 to 32 of `a-z 0-9 . / -`, such as `cp3-relay/1`) | `protocol`, `you: { id }` (1 to 65535), `server: { name, motd, version }`, `limits`, `features`: `classic` when the server can open rooms to classic players, `teamChat` when it routes team lines (`chat` with `team`), `cp3-relay/1` when it has relay rooms, `testRoom` when it has a test room; `relay: { tag, header, maxPayload, maxReliable, bytesPerSecond, burst }` |
| `ping` | `t`, any number | `{ type: "pong", t, server }`, where `server` is the server's clock in ms |
| `list` | | `rooms`: the public rooms (below) |
| `create` | `name` (1 to 40), `password` (optional, up to 32), `maxPlayers` (2 to the server's limit), `public` (default true), `classic` (optional: open to the original game through the server's DirectPlay gateway, `docs/GATEWAY.md`), `relay` (optional: a relay room, below; by default true when the creator declared `cp3-relay/1`, and never with `classic`) | `room`. The client is now in it and owns it |
| `join` | `room` (its code, any case), `password` | `room` |
| `leave` | | |
| `profile` | Any of: `truck` (file name), `truckCrc` (the checksum of the POD that holds the truck, as for tracks; -1 unknown), `skill` (0 Rookie, 1 Intermediate, 2 Professional), `location` (below), `ready`, `team`, `latency` (ms), `content: { sit, crc }` | Every member gets `member` |
| `chat` | `text` (1 to 160), `to` (optional, a member id: private), `team` (optional, member ids: a team line, sent to those of them in the room; `to` wins over it) | |
| `settings` | Owner only, in the lobby. Any of: `track: { sit, name, crc }` or null, `laps` (1 to 99), `weather` (-1 Random, 0 to 15), `mode` (empty for a plain race), `computers` (0 to 15), `damage`, `collisions`, `wheels` and `wheelsRepairS` (0 to 600: OpenMTM2's Wheels damage, on or off, and the seconds before the wheels go back on, 0 never; default off and 8), `rules` (0.4.0: OpenMTM2's host rules, a flat object of text, number or true/false values under names of letters, digits, dots, underscores and hyphens, 2048 bytes as JSON at most; default `{}`) | Every member gets `room` |
| `kick` | `member`. Owner only | That member gets `kicked`; the others get `left` |
| `start` | `weather` (0 to 15, already drawn when Random), `computers: [{ name, truck }]`. Owner only, with a track, with every other member ready, and with no member whose `content` says it lacks the track | Every member gets `starting` |
| `loaded` | | The loading barrier, below |
| `race` | `e`, a race event (below) | No answer |
| `result` | `laps`, `total` (s), `best` (s, or the score in Summit), `lapsLed` | The results barrier, below |
| `finish` | Owner only, relay rooms only | The race is over: every member gets `room`, back in the lobby (no `results`) |

**Locations** (the lobby's Status column) are the classic game's: 1 Start Screen, 2 Driver
Check-in, 3 Race Screen, 4 Garage, 5 Multiplayer Screen, 6 Hall Of Fame, 7 Viewing Results,
8 Instant Replay, 9 Racing.

**Tracks** are named by their SIT file name (`TPARK.SIT`) and a checksum. The checksum is the
classic game's: CRC-32/MPEG-2 (polynomial 0x04C11DB7, initial value 0xFFFFFFFF, not reflected,
no final XOR) over the whole POD archive that holds `WORLD\<SIT>`. The value is -1 when the
client does not have the track. After every change of track, each member reports
`content: { sit, crc }` for its own copy.

**Trucks** are named by their TRK file name and, optionally, `truckCrc`: the same CRC-32/MPEG-2,
over the whole POD archive that holds the truck. The server passes it on in the member and in
each race entrant (and a computer truck's, from `start`) and does not act on it: a client that
wants every copy of a truck to match compares the values itself.

## Server messages

| Type | Fields | When |
|---|---|---|
| `member` | `member` | Someone joined or changed their profile |
| `left` | `member` (id), `reason` (`left`, `disconnected`, `removed`) | Someone left |
| `owner` | `member` | The owner left; the longest-present member owns the room now (classic players never do). Also when someone joins the empty test room. Every client follows the server's choice |
| `room` | `room` | Settings changed, or a race ended |
| `chat` | `from`, `name`, `text`, `private`, `team` (a team line) | Senders do not get their own lines back |
| `kicked` | `reason` (`removed`, or why the admin closed the room) | This client is out of the room, but still connected |
| `starting` | `race` | The owner started |
| `waiting` | `left`: names | Someone loaded; these have not yet |
| `synced` | `startAt`, `serverTime` (server clock, ms) | Everyone loaded |
| `race` | `from` (member id, 0 for the server), `e` | Another member's race event |
| `results` | `race`, `results: { "<vehicle>": { laps, total, best, lapsLed } }` | The race is over |
| `shutdown` | `text`, `inMs` | The server is stopping |

**A room** is `{ code, name, owner, locked, public, maxPlayers, state, classic, relay, test, settings, members, race }`;
`relay` marks a relay room, `test` the server's test room, whose `owner` is 0 while it is empty.
`state` is `lobby`, `loading` or `racing`. **A member** is `{ id, name, client, truck, skill,
location, ready, team, latency, content, classic, truckCrc, caps }`; `classic` marks a player of the original game,
in the room through the gateway, and `caps` is what it declared in `hello`. Names are unique within a room: a second "Ann"
becomes "Ann (2)". **A room in the list** is `{ code, name, players, maxPlayers, locked, state,
classic, relay, test, track: { sit, name } | null, mode, owner }`, with the owner's name.

**A classic room** keeps the original game's limits: at most 8 players, no computer opponents
(`computers` stays 0), no `mode`. Its classic members never own it; when only they are left, the
room closes. One classic room may be open per server at a time (`create` answers `limit`).

Room codes are six characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. OpenMTM2's invite
links are its own page address with `?room=CODE&server=<address>` added.

## A race

1. **Start.** The owner sends `start`. The server seats everyone in random order and gives
   each truck a **vehicle number** from 1. The start grid place is the vehicle number minus 1.
   It answers with `starting`: `race: { id, sit, track, laps, weather, mode, entrants }`, each
   entrant being `{ vehicle, member, computer, name, truck, truckCrc, owner }`. Computer trucks have
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
| `modeTruck` | `vehicle`, `data`, an object | An extension mode's state for the trucks the sender drives (Combat's and Deathmatch's hit points, wheels and credits; Deathmatch's also each truck's own wrecks, times wrecked and respawns), sent as the sender's vehicle |
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

## Relay rooms

A relay room carries a client's own game packets, opaque to the server, instead of the truck
state frame and the server's race barriers. It is for Community Patch 3 and 4, whose packets
(their own position, collision and load barrier packets) do not fit the 68-byte frame. Its
capability is `cp3-relay/1`.

**Who.** A room's kind is fixed when it is made. A client that declared `cp3-relay/1` in
`hello.caps` makes a relay room by default (`create { relay: false }` for an ordinary one); a
client without it cannot make one. Only clients that declared `cp3-relay/1` may join a relay room;
the others get `capability`. So every member of a relay room speaks the relay. Ordinary rooms stay
open to every client, as before. The room list and the room carry `relay`.

**Relay frames** are binary frames, little-endian, whose first byte is 0xC3 (a state frame's is 1):

```
client to server                         server to client
 0  u8   tag     0xC3                     0  u8   tag     0xC3
 1  u8   flags   the client's own         1  u8   flags   as the sender sent them
 2  u16  to      member id, 0 = all       2  u16  from    the sender's member id
         the other members                        (written by the server)
 4  ...  payload, 0 to 1200 bytes         4  ...  payload, unchanged
```

- The server writes the sender's member id into bytes 2 and 3 of every frame it forwards, over
  whatever the sender put there, so a client cannot speak as another. Member ids are 1 to 65535.
- `to` 0 sends the frame to every other member of the room; a member id sends it to that member
  only, if it is in the room. A frame for anyone else, or for the sender itself, is dropped.
- Relay frames pass whenever the sender is in a relay room: in the lobby, while loading and while
  racing. Outside a relay room, a frame tagged 0xC3 is dropped.
- A frame shorter than 4 bytes or with more than 1200 bytes of payload is dropped. Flags bit 0
  marks a frame its sender meant to be reliable; such a frame carries at most 1024 bytes
  (`maxReliable`, udpnet's own reliable limit), or it is dropped. The server does nothing else
  with the flags. Any binary frame over 8192 bytes closes the connection with 1009.
- **Rate**: each connection may send 49152 bytes a second of relay frames (whole frames, header
  included), with bursts up to 65536 bytes (`relayBytesPerSecond`, `relayBurst`; `hello` says the
  server's). Frames past it are dropped silently: the relay is for unreliable traffic, and a client
  that needs delivery acknowledges over it. Truck state frames keep their own limit.
- A receiver whose WebSocket has more than 256 KB waiting misses binary frames (state and relay)
  until it catches up; at 4 MB of waiting text it is closed with 1008. (On Cloudflare, which does
  not report it, neither applies.)
- The frames are relayed in the order the server receives them; order across senders is not kept.

**No server barriers.** In a relay room the clients run their own loading barrier and results over
the relay. `start` still checks the owner, the track, Ready and the members' `content`, seats the
race and sends `starting`, and the room is `racing` at once: there is no `waiting` and no `synced`,
`loaded` and `result` are answered and do nothing, and there is no `results`. The owner sends
`finish` when the race is over; the room is then back in the lobby and every member gets `room`. If
every member leaves the race, the room goes back to the lobby by itself. Room membership, chat,
settings, `kick`, the `owner` choice and `gone` work as in any room. The owner's client drives the
computer trucks, as in any room.

**The test room.** A server started with `--test-room` has one permanent public room, code `TESTRM`
(`features` has `testRoom`). With `--test-room-relay` it is a relay room; with `--test-room-echo` it
also sends each relay frame for everyone, or for the sender's own id, back to the sender. See
`docs/DAEMON.md`.

## Extension modes

A room's `settings.mode` names an extension mode (OpenMTM2's Hockey, Tag, Combat or Deathmatch), empty for a plain race.
Every client runs the same mode. The owner's client judges it: it runs the mode's rules and sends
their state as `race { e: { kind: "mode", data } }`. The others apply that state instead of
deciding goals, tags or scores themselves. When the owner leaves, the new owner's client takes over
from the last state. Per-truck values in `data` are keyed by vehicle number. A client that does not
know a room's mode should not join its races; the server does not check this.

Some modes judge each truck on the client that drives it, as only that client sees its truck's own crashes
(OpenMTM2's Combat and Deathmatch: each truck's hit points, wheels and credits). Such a client sends the state of the trucks it
drives as `race { e: { kind: "modeTruck", vehicle, data } }`, `vehicle` being its player's (the owner's message
covers its computer trucks too). Any player may send it, for a vehicle it owns, like a damage code. The owner still
sends `mode` for what only one client may decide (the end and the winner).

## Compatibility

- `hello.protocol` is the major version. The server refuses another one with `protocol` and
  close code 4000.
- Within a version, new fields and new message types may appear. Clients ignore what they do
  not know. Servers ignore unknown fields and answer unknown types with `bad-request`.
- `client` in `hello` is shown to other players and logged. It is not used to make decisions.

# Online rooms for Monster Truck Madness 2: an overview for Community Patch 3

**Status: a proposal, open for discussion.** Nothing here is final. The room protocol is a draft
of version 1, and it is frozen only after Community Patch 3's developer has reviewed it. His
answers to the questions at the end may change it. OpenMTM2 and its server will then follow
whatever is agreed.

This document is for the developer of Community Patch 3 (CP3). It assumes you know Monster Truck
Madness 2 and C++, and that you have not seen OpenMTM2's code. It covers:

1. what online rooms are, and why we propose them;
2. what a player sees and does;
3. the room server, and how to run one;
4. the protocol, from the point of view of a C++ client;
5. how the protocol lines up with the game's own packets, so CP3's existing code can be reused;
6. what is settled and what is not;
7. our questions for you.

The field-by-field reference is [`PROTOCOL.md`](PROTOCOL.md). This document explains it and
should be read first; where the two disagree, `PROTOCOL.md` is right.

## 1. What online rooms are

Today an MTM2 game over the Internet means one player hosts, the others type the host's IP
address, and someone has to open ports on a router or set up a VPN such as Radmin VPN. CP3's own
UDP direct connect already makes this much easier (only the host's UDP port has to be reachable),
but players still have to find each other outside the game.

**Online rooms** move that job to a small server on the Internet:

- A player types a server's address once. The game shows the rooms on it: who is in each, the
  track, whether it is racing.
- They join one, make their own, or join a private one by its six-letter **room code** or an
  **invite link**.
- The room is the usual multiplayer lobby: players, trucks, levels, latency, status, chat, Ready,
  the owner's track, laps and weather. Then the race and the results, and back to the room.
- Every player only makes an **outgoing** connection to the server. Nobody opens ports, nobody
  needs a VPN, and players behind any router can play together.

The server relays the room's traffic. It does not run the game: each machine still simulates its
own truck and sends its state, exactly as MTM2 does over DirectPlay. The server adds what a relay
can do well: the room list, seating, the loading and results barriers, a common clock, and
looking after a room when its owner leaves.

**Rooms are an extra connection type, not a replacement.** CP3's DirectPlay connection and its
UDP direct connect stay exactly as they are. Rooms would be a third choice beside them.

### Who can play together today

| | OpenMTM2 (browser) | Retail MTM2 2.00.42 and the patched game | CP3 |
|---|---|---|---|
| Classic TCP/IP (DirectPlay) | yes, through a small helper program on the player's PC | yes | yes, through CP3's DirectPlay connection |
| CP3 UDP direct connect | yes, through the same helper | no | yes |
| Online rooms | yes | yes, in a "classic room", through the server's DirectPlay gateway (section 3) | **not yet: this proposal** |

OpenMTM2 speaks CP3's direct connect from a trace of CP3's executable, since CP3's author
published no source code. If you ever find our implementation behaving differently from CP3,
that is our bug, and we would like to hear about it.

## 2. What a player sees

This is how OpenMTM2 does it. CP3 is of course free to present rooms its own way; only the
protocol has to match.

**Finding a room.** On the Multiplayer screen, *Online rooms* is the first choice. The player
types the server's address (`rooms.example.org`, or `localhost` for a server on the same
computer). The room list shows each public room's name, players (`3/8`), track and state
(Waiting, Loading, Racing), with a lock for rooms that need a password. From there:

- **Join** a room in the list. A room that is racing or full cannot be joined until it is back in
  its lobby or has space.
- **Quick Join:** the fullest open room, or a new room when there is none.
- **Create Room:** a name, an optional password, the most players (2 to 8 by default, up to 16 if
  the server allows it), and whether the room is listed or reachable by code only.
- **Join by code:** six characters such as `K7QX2M`. Codes avoid look-alike characters (no 0, O,
  1, I).
- **Invite links:** OpenMTM2 adds `?room=K7QX2M&server=rooms.example.org` to its own address.
  A native game could offer the same through a command-line argument or a URL handler; that is
  up to you.

**In the room.** The lobby looks like the game's own Multiplayer screen:

- the players, with Level, Truck, Latency and Status (the game's locations: Garage, Race Screen,
  Racing and so on);
- chat to everyone, or privately to one player;
- Ready and Not Ready;
- the room code and an invite button;
- a mark next to any player whose copy of the chosen track is missing or differs from the owner's.

The player who made the room **owns** it, as the host does in a classic game. The owner picks the
track, laps, weather (including Random), the number of computer opponents and, in OpenMTM2, an
extension mode. The owner can remove a player, and starts the race once everyone else is Ready.
When the owner leaves, the player who has been in the room longest owns it, and the room goes on.

**The race.** Everyone loads the track, then waits ("Waiting for other players") until all have
loaded. The countdowns then start together, because the server gives every machine the same start
time. During the race the trucks, checkpoints, damage,
headlights, horn and YeeHaw go both ways. A player who leaves mid-race hands their truck to the
computer driver on every machine. At the end the results are gathered by the server, shown to
everyone, and the room goes back to its lobby with nobody Ready.

**Other things a player may see:**

- "The room is full", "Wrong password", "There is no such room", "The room is racing; try again
  after the race": the server's own messages, ready to show as they are.
- Removed from the room by its owner: the player is back at the room list, still connected.
- The server shutting down: a notice with how long running races may go on.
- A server that speaks another protocol version: the connection is refused with a clear reason.

## 3. The room server (`openmtm2d`)

`openmtm2d` is a small program (Node.js 22, no other dependencies, Apache 2.0 licence). It needs
**no game files**: it knows tracks by their SIT name and checksum, and trucks by their file name.
One process holds dozens of rooms.

### Running one on your own computer

For development, the simplest setup is a server on the same machine:

```sh
node bin/openmtm2d.mjs --state-dir ./state --log-format text
```

It listens on port 47660, with no TLS. A client connects to `ws://localhost:47660/play`, or to
`ws://<LAN address>:47660/play` from another machine at home. The log prints every room, join,
race and error, one line each (chat is never logged).

`openmtm2d --print-config` shows the settings it would use. `docs/DAEMON.md` has all of them; the
ones a client developer meets are the limits:

| Setting | Default | |
|---|---|---|
| `maxPlayers` | 8 | per room, 2 to 16 |
| `messagesPerSecond` | 20 | JSON messages per connection; truck state is counted separately |
| `chatPerSecond` | 2 | |
| `loadTimeoutS` | 120 | how long a race waits for everyone to load |
| `resultsTimeoutS` | 30 | how long it waits for the results after the first one |
| `startDelayMs` | 1500 | from "everyone loaded" to the start of the countdown |

### Running a public one

A public server runs headless on any Linux machine: a systemd unit and a Docker image are
included, with graceful shutdown (running races may finish), configuration reload without a
restart, a health check, a status page, and admin commands to close rooms, remove players and ban
addresses. It sits behind a TLS reverse proxy (Caddy or nginx examples included), so players
connect with `wss://rooms.example.org/play` on port 443. Only that one port is open.

There is no public server yet. Who runs one, and whether CP3 would ship with a default address,
is one of the questions below.

### Classic rooms (the DirectPlay gateway)

With `--gateway`, the server can also open one room at a time to the **original game**. The
server hosts a DirectPlay session for that room. Players of retail MTM2, the patched game, or
CP3's DirectPlay connection choose TCP/IP, Join, type the server's address, and find the room in
the game's session list. Inside the room, they appear as players marked "(Classic)", and they
race with the room's other players using the game's own packets.

Such a room keeps the game's limits: 8 players, no computer opponents, no extension modes.
Classic players still need their DirectPlay ports reachable, as in any DirectPlay game. This is
how CP3 players can already join rooms today, before CP3 speaks the room protocol itself.
`docs/GATEWAY.md` has the details.

## 4. The protocol, for a C++ client

### 4.1 The connection

- **One WebSocket** (RFC 6455) per player, to `wss://<server>/play` on the Internet, or
  `ws://<server>:47660/play` without TLS on a home network.
- **Text frames** carry one JSON object each, UTF-8, at most 8192 bytes.
- **Binary frames** carry truck state, exactly 68 bytes each.
- The server sends a WebSocket ping every 20 seconds. Any WebSocket library answers it by itself.
  A client that misses two is dropped.
- A native client sends no `Origin` header, and the server allows that by default. (Browsers send
  one, and the server checks it.)

Ways to do this in C++ on Windows, none of which we require:

- **WinHTTP's WebSocket API** (`WinHttpWebSocketCompleteUpgrade`, `WinHttpWebSocketSend`,
  `WinHttpWebSocketReceive`), part of Windows 8 and later. It handles TLS through the system and
  adds no dependency.
- **IXWebSocket**, **libwebsockets**, **Boost.Beast** or **websocketpp**, if CP3 already uses one
  of them or wants something portable.
- For JSON, **nlohmann/json** or **RapidJSON**, or any small parser: the messages are flat and
  short.

A simple design is one network thread that owns the WebSocket, and two queues to and from the
game thread. Nothing in the protocol needs an answer within a frame's time.

### 4.2 Requests and answers

Every JSON message has a `type`. A message from the client may carry an `id`, a whole number from
0 to 2^31 - 1, and is then answered with the same `id`:

```json
{ "type": "result", "id": 7, ... }
{ "type": "error", "id": 7, "code": "full", "message": "The room is full." }
```

`message` is plain English that can be shown to the player as it is. `code` is for the program;
`PROTOCOL.md` lists them all. Messages from the server without an `id` are events (someone joined,
a chat line, the race started).

The server checks every message: sizes, ranges, types. Unknown fields are ignored and dropped.
Text is trimmed, and control characters are removed. A message that breaks a rule gets an error
and changes nothing. A client may also send a message without an `id` when it does not need the
answer; errors still come back, without an `id`.

### 4.3 A whole session, step by step

`→` is the client, `←` the server. Ids, names and numbers are examples.

**Saying hello.** The first message must be `hello`:

```json
→ { "type": "hello", "id": 1, "protocol": 1, "name": "Ann", "client": "CP3 2.0.52" }
← { "type": "result", "id": 1, "protocol": 1, "you": { "id": 12 },
    "server": { "name": "Ann's server", "motd": "Welcome!", "version": "0.1.0" },
    "limits": { "playerName": 24, "roomName": 40, "chat": 160, "maxPlayers": 8, ... },
    "features": ["classic", "teamChat"] }
```

`you.id` is this player's **member id** on the server. `client` is shown to other players and
logged, never used to decide anything. `features` lists optional server features (`classic`
means the server can make classic rooms; `teamChat` means a `chat` may carry `team`, the member ids
of the sender's teammates, and only they get the line).

**The clock.** Send `ping` a few times and keep the answer with the shortest round trip:

```json
→ { "type": "ping", "id": 2, "t": 52811 }
← { "type": "pong", "id": 2, "t": 52811, "server": 1761060000123 }
```

`t` is any number of yours, sent back unchanged; `server` is the server's clock in milliseconds.
With `rtt` the round trip measured on your clock:

```
offset = server - (t + rtt / 2)        // server time = your time + offset
```

OpenMTM2 pings every 5 seconds in a room and reports the round trip as its `latency`, which fills
the lobby's Latency column.

**The room list.**

```json
→ { "type": "list", "id": 3 }
← { "type": "result", "id": 3, "rooms": [
    { "code": "K7QX2M", "name": "Mud Pit", "players": 3, "maxPlayers": 8, "locked": false,
      "state": "lobby", "classic": false, "track": { "sit": "TPARK.SIT", "name": "Farm Road 29" },
      "mode": "", "owner": "Ben" } ] }
```

Private rooms (made with `"public": false`) are not listed; they are reached by code.

**Making or joining a room.**

```json
→ { "type": "create", "id": 4, "name": "Ann's room", "maxPlayers": 8 }
→ { "type": "join", "id": 4, "room": "k7qx2m", "password": "" }
← { "type": "result", "id": 4, "room": { ... the whole room, below ... } }
```

The answer holds the **whole room**, which is everything a lobby needs to draw:

```json
{ "code": "K7QX2M", "name": "Mud Pit", "owner": 7, "locked": false, "public": true,
  "maxPlayers": 8, "state": "lobby", "classic": false,
  "settings": { "track": { "sit": "TPARK.SIT", "name": "Farm Road 29", "crc": 305419896 },
                "laps": 3, "weather": -1, "mode": "", "computers": 2,
                "damage": true, "collisions": true },
  "members": [ { "id": 7, "name": "Ben", "client": "OpenMTM2", "truck": "GRAVE.TRK", "skill": 2,
                 "location": 5, "ready": true, "team": 0, "latency": 48,
                 "content": { "sit": "TPARK.SIT", "crc": 305419896 }, "classic": false } ],
  "race": null }
```

From then on the server keeps the client's copy up to date with events:

| Event | What changed |
|---|---|
| `member` | a player joined, or changed truck, level, status, Ready, latency or track check; holds the whole member |
| `left` | a player left: `reason` is `left`, `disconnected` or `removed` |
| `owner` | the room has a new owner |
| `room` | the owner changed the settings, or a race ended; holds the whole room again |
| `chat` | a chat line: `from`, `name`, `text`, `private` |
| `kicked` | this player is out of the room (removed, or the room was closed), but still connected |

Names are unique within a room: a second "Ann" becomes "Ann (2)". Always show the name the server
gives.

**The player's own details.** Send them after joining, and whenever they change:

```json
→ { "type": "profile", "truck": "BIGFOOT.TRK", "skill": 1, "location": 5, "ready": false }
```

Every member, the sender included, then gets a `member` event. The fields:

| Field | |
|---|---|
| `truck` | the truck's file name, as the game's 0x03 and 0x0f packets carry it |
| `skill` | 0 Rookie, 1 Intermediate, 2 Professional |
| `location` | the game's player locations: 1 Start Screen, 2 Driver Check-in, 3 Race Screen, 4 Garage, 5 Multiplayer Screen, 6 Hall Of Fame, 7 Viewing Results, 8 Instant Replay, 9 Racing |
| `ready` | true or false |
| `team` | team number, 0 for none |
| `latency` | the player's round trip to the server, in ms |
| `content` | `{ sit, crc }`: this player's copy of the room's track (below) |

**The track check.** The room's track is named by its SIT file and a checksum: **CRC-32/MPEG-2
over the whole POD archive that holds `WORLD\<SIT>`**, the same value the game sends in its 0x25
packet. It is -1 when a player does not have the track. After every change of track, each player
sends `content` for its own copy. Clients compare it with the owner's and warn as the game does
("You do not have this track", "a different version"). The server only passes the values on.

```cpp
// CRC-32/MPEG-2: polynomial 0x04C11DB7, most significant bit first,
// initial value 0xFFFFFFFF, not reflected, no final XOR.
uint32_t TrackCrc(const uint8_t* p, size_t n, uint32_t c = 0xFFFFFFFFu) {
    while (n--) {
        c ^= uint32_t(*p++) << 24;
        for (int k = 0; k < 8; k++)
            c = (c & 0x80000000u) ? (c << 1) ^ 0x04C11DB7u : (c << 1);
    }
    return c;
}
```

**Chat.**

```json
→ { "type": "chat", "text": "Ready when you are" }
→ { "type": "chat", "text": "Nice jump", "to": 7 }
```

Up to 160 characters; `to` makes it private. Senders do not get their own lines back. The server
allows 2 lines a second, with a short burst.

**The owner's controls.**

```json
→ { "type": "settings", "id": 9, "track": { "sit": "TPARK.SIT", "name": "Farm Road 29", "crc": 305419896 },
    "laps": 3, "weather": -1, "computers": 2 }
→ { "type": "kick", "id": 10, "member": 12 }
→ { "type": "start", "id": 11, "weather": 4,
    "computers": [ { "name": "Bubba", "truck": "RAM.TRK" }, { "name": "Scooter", "truck": "SUDDEN.TRK" } ] }
```

- `settings` may hold any of `track` (or null), `laps` (1 to 99), `weather` (-1 Random, or the
  same number the game's 0x1b packet carries), `mode`, `computers` (0 to 15), `damage`,
  `collisions`. Every member gets the whole `room` back.
- `start` is accepted once a track is chosen and every other member is Ready. The owner draws
  Random weather itself, from what the track allows, and sends the result. It also names the
  computer opponents; the server takes as many as `settings.computers`, within the room's size.

### 4.4 The race

```
owner → start                     ← starting  (seats and vehicle numbers)
each  → loaded                    ← waiting   (who has not loaded yet)
                                  ← synced    (startAt, in the server's clock)
owner → race { positions }        ← race { positions }
each counts down from startAt;
first → race { go }               ← race { go }
each  → binary state, 20 a second, and race events
each  → result                    ← results
                                  ← room      (back in the lobby)
```

1. **Seating.** On `start` the server shuffles everyone (players and computer opponents) and gives
   each truck a **vehicle number** from 1. A truck's start grid place is its vehicle number minus
   1. Everyone gets `starting`:

   ```json
   ← { "type": "starting", "race": { "id": 5, "sit": "TPARK.SIT", "track": { ... }, "laps": 3,
       "weather": 4, "mode": "",
       "entrants": [ { "vehicle": 1, "member": 12, "computer": false, "name": "Ann", "truck": "BIGFOOT.TRK", "owner": 12 },
                     { "vehicle": 2, "member": null, "computer": true, "name": "Bubba", "truck": "RAM.TRK", "owner": 7 },
                     { "vehicle": 3, "member": 7, "computer": false, "name": "Ben", "truck": "GRAVE.TRK", "owner": 7 } ] } }
   ```

   Vehicle numbers play the part of the DirectPlay grid slots (packet 0x87). The **owner's
   machine drives the computer trucks** and sends their state, as the host does in a classic
   game.

2. **Loading.** Each client loads the race, then sends `loaded`. As others finish, the server
   sends `waiting` with the names still loading ("Waiting for other players"). When all have
   loaded, or after 120 seconds, it sends `synced`:

   ```json
   ← { "type": "synced", "startAt": 1761060012500, "serverTime": 1761060011000 }
   ```

   Anyone who had not loaded by then is out of the race; their truck gets a `gone` event.

3. **Start positions.** The owner sends the grid, indexed by vehicle number (index 0 unused), as
   the game's 0x17 does:

   ```json
   → { "type": "race", "e": { "kind": "positions", "positions": [null, [10.5, 2.0, -40.0], [15.5, 2.0, -40.0], [20.5, 2.0, -40.0]] } }
   ```

4. **Countdown.** Each client begins its countdown at `startAt - offset` on its own clock. The
   first client whose countdown ends sends `race { e: { kind: "go" } }`, as the game's 0x19; a
   client that receives `go` before its own countdown ends starts racing at once.

5. **Racing.** Each client sends the state of every truck it owns as binary frames, 20 a second
   (4.5), and race events as they happen (4.6).

6. **Results.** When its race is over, each client sends its own result:

   ```json
   → { "type": "result", "laps": 3, "total": 312.4, "best": 98.1, "lapsLed": 2 }
   ```

   `total` and `best` are seconds; in Summit Rumble `best` holds the score. When every player
   still racing has sent one, or 30 seconds after the first, the server sends `results`, keyed by
   vehicle number, then `room` with the room back in its lobby:

   ```json
   ← { "type": "results", "race": 5, "results": { "1": { "laps": 3, "total": 312.4, "best": 98.1, "lapsLed": 2 },
                                                 "3": { "laps": 3, "total": 318.0, "best": 99.7, "lapsLed": 1 } } }
   ```

   Computer trucks are not in `results`: each machine takes theirs from its own race.

**Someone leaves mid-race.** The leaving client sends `race { e: { kind: "gone", vehicle } }` for
its truck. When a client simply disconnects, the server sends it instead, and also for the
computer trucks if the owner left. From then on every machine drives that truck with its own
computer driver, as the game does when a DirectPlay player drops. A new owner is announced with
`owner`.

### 4.5 Truck state: the binary frame

68 bytes, little-endian, packed. On x64 Windows a packed struct can be sent and received as it is:

```cpp
#pragma pack(push, 1)
struct RoomTruckState {
    uint8_t  kind;          //  0  always 1
    uint8_t  vehicle;       //  1  vehicle number (1 to 16)
    uint16_t seq;           //  2  sequence number, wraps
    uint32_t timeMs;        //  4  sender's clock in ms, wraps
    float    pos[3];        //  8  position in the track's world coordinates, feet
    float    bodyVel[3];    // 20  velocity in the truck's own axes, feet per second
    float    angles[3];     // 32  radians: theta, phi, psi, in packet 0x02's order; psi is the heading
    float    steer;         // 44  front-wheel angle, radians
    float    throttle;      // 48  0 to 1
    float    brakeRear;     // 52  0 to 1
    float    brakeFront;    // 56  0 to 1
    int8_t   gear;          // 60  1 Park, 2 Reverse, 3 Neutral, 4 and up forward
    uint8_t  flags;         // 61  bit 0: automatic gearbox
    uint16_t reserved;      // 62  0
    float    score;         // 64  Summit Rumble score, otherwise 0
};
#pragma pack(pop)
static_assert(sizeof(RoomTruckState) == 68, "room truck state is 68 bytes");

// A frame is newer than the last one taken when:
inline bool SeqNewer(uint16_t a, uint16_t b) { uint16_t d = uint16_t(a - b); return d != 0 && d < 0x8000; }
```

It carries the same values as the game's 0x02 packet, at full precision, plus a sequence number,
the sender's time and the front brake.

- **Who may send what.** A client sends frames only for the trucks it owns: its own, and for the
  owner, the computer trucks. The server drops anything else silently, as well as frames outside
  a race, frames for a truck that is gone, and frames holding a number that is not finite.
- **Rate.** OpenMTM2 sends 20 frames a second per truck. The server passes on at most 30 a second
  per truck and drops the rest.
- **Relay.** The server forwards each frame, unchanged, to every other member of the room. It
  does not reorder, merge or delay them. Over a WebSocket they arrive in order, so `seq` matters
  mostly for a client that queues frames itself.
- **Remote trucks.** As in the game, every machine simulates the other trucks as ordinary
  physics bodies, and every frame sets their controls, velocity and angles. The game snaps a
  remote truck's position at most once a second. With 20 frames a second, OpenMTM2 instead
  blends the position error away over half a second, and moves the truck at once only when it is
  more than 100 ft off. Collisions between trucks are worked out on each machine against its own
  copies, as in the game. How CP3 applies remote trucks is entirely its own choice.

### 4.6 Race events

Sent as `{ "type": "race", "e": { "kind": ..., ... } }`, without an `id` and never answered.
Others receive `{ "type": "race", "from": <member id>, "e": { ... } }`, with `from` 0 when the
server sends it.

| `kind` | Fields | Sent by | |
|---|---|---|---|
| `positions` | `positions` | owner | the start grid, by vehicle number |
| `go` | | anyone | the first countdown ended |
| `split` | `vehicle`, `next`, `split` | the truck's owner | a checkpoint pass: the next checkpoint, and the seconds since the truck's last pass |
| `damage` | `vehicle`, `code` | the truck's owner | the damage code as packet 0x20 carries it (12 zones, 2 bits each), when it changes |
| `lights` | `vehicle`, `lamps` | the truck's owner | the headlight switch as packet 0x1f carries it (0 or 2) |
| `horn`, `yeehaw` | `vehicle` | the truck's owner | |
| `gone` | `vehicle` | the truck's owner, or the server | the truck now drives itself everywhere |
| `mode` | `data` | owner | an extension mode's state (below) |
| `modeTruck` | `vehicle`, `data` | the truck's owner | an extension mode's state for the trucks the sender drives (Combat) |

**Extension modes.** OpenMTM2 adds two game modes of its own, Hockey and Tag. A room names one in
`settings.mode`, empty for an ordinary race. The owner's machine runs the mode's rules and sends
their state as `mode` events, 5 times a second and at once when something happens (a goal, a
tag). The others show that state instead of deciding it themselves. `data` is the mode's own JSON
object, with per-truck values keyed by vehicle number. A client that does not know a room's mode
should not race in it; `mode` is in the room list, so CP3 can simply show such rooms as not
joinable. The same mechanism would carry any CP3 mode that needs one machine to judge it.

### 4.7 Errors, limits and closing

| Error `code` | |
|---|---|
| `bad-request` | malformed message or a value out of range; `message` says which field |
| `protocol` | another protocol version; the connection is closed with 4000 |
| `hello-first` | anything other than `hello` or `ping` before `hello` |
| `not-found` | no such room or player |
| `full` | the room is full |
| `password` | wrong password |
| `not-owner` | only the owner may do that |
| `state` | not now: for example `start` while someone is not Ready, or `join` while the room races |
| `not-in-room` | join a room first |
| `rate-limited` | too many messages, slow down |
| `limit` | the server has no space for another room |
| `shutting-down` | the server takes no new rooms |

| Close code | |
|---|---|
| 1001 | the server is shutting down |
| 1008 | the client reads too slowly |
| 4000 | protocol version |
| 4003 | this address is banned |
| 4004 | removed by the server's admin |
| 4008 | kept flooding after `rate-limited` errors |
| 4009 | the server is full |

Before a shutdown the server sends `{ "type": "shutdown", "text": "...", "inMs": 60000 }`. No new
rooms are made after that; running races may finish within that time.

### 4.8 Versions and compatibility

- `hello.protocol` is the major version, 1 for now. Another major version is refused.
- Within a version, new fields and new message types may appear. **Clients must ignore what they
  do not know.** The server ignores unknown fields, and answers unknown message types with
  `bad-request`, so a client can try a newer message and fall back.
- Version 1 is not frozen yet (section 6). Until it is, breaking changes are possible, and we will
  tell you about each one.

## 5. Rooms and the game's own packets

CP3 already has code for every one of these through its existing connections. The room protocol
was designed so that each room message has a counterpart in the game's own protocol, and CP3 can
translate one into the other at the edge, keeping its lobby and race logic as they are.

| Room protocol | MTM2 packet (over DirectPlay or CP3's direct connect) |
|---|---|
| `hello`, member ids | joining the session; the DirectPlay player id |
| `member` events, `left` | 0x81, 0x82, 0x83 and the create and destroy player messages |
| `profile` truck, skill, location, ready, team | 0x03 player info, 0x0f truck, 0x10 skill, 0x11 location, 0x13 ready, 0x21 to 0x23 teams |
| `profile` content | 0x25 track checksum |
| `settings` track, laps, weather | 0x12, 0x16, 0x1b |
| `owner` | 0x88 host change |
| `kick`, `kicked` | 0x24 |
| `chat` | 0x80 |
| `start`, `starting` | 0x8a, then 0x87 grid slots, then 0x14 |
| `loaded`, `waiting`, `synced` | the `sync` barrier (0x15) |
| `race` `positions` | 0x17 start positions |
| `race` `go` | 0x19 |
| binary truck state | 0x02 |
| `race` `split` | 0x0b |
| `race` `damage` | 0x20 |
| `race` `lights` | 0x1f |
| `race` `horn`, `yeehaw` | 0x1d, 0x1e |
| `race` `gone` | 0x1c, or a player dropping |
| `result`, `results` | the `rslt` barrier (0x18) |
| `ping`, `pong` | 0x84, 0x85 |
| (nothing yet) | 0x06 Remote Ridicule, 0x0d quick messages, 0x89 voice radio |

The differences are deliberate:

- **One connection, to the server.** Clients never talk to each other, so nobody needs open ports.
- **The server seats, waits and times.** Seating, the two barriers and the start time are the
  server's, so they hold even when the owner's connection is slow, and the countdowns start
  together.
- **More state, more often.** 20 frames a second at full precision instead of 4 with bytes for
  the controls, which makes remote trucks smoother.
- **Ownership moves on.** When the owner leaves, the room and the race go on.

## 6. What is settled and what is not

**Built, and through a first play test between OpenMTM2 players:** the server, the room list,
making and joining rooms, the lobby, chat, Ready, the race with its barriers and results. Room
codes, invite links, the track check, owner changes, removing players, computer opponents and
leaving mid-race are built and covered by automated tests. Extension modes are built and tested
automatically, not yet in play.

**Built, waiting for a play test with the original game:** classic rooms through the DirectPlay
gateway, and OpenMTM2's support of CP3's direct connect.

**Open, and likely to change after your review:**

- every message and field of protocol version 1;
- the truck state frame (section 4.5), in particular whether CP3 needs more in it;
- whether truck state should also be offered over UDP (questions 1 and 2);
- how CP3's own modes and content are named (questions 6 to 8);
- quick messages and Remote Ridicule, which rooms do not carry yet.

**Not built yet:**

- a test mode in the server (`openmtm2d --test-room`) that checks every frame a client sends and
  logs what is wrong with it, to help write a client;
- a public server;
- the final version of `PROTOCOL.md` with a conformance checklist for client authors.

## 7. Questions for the CP3 developer

**Transport**

1. Is a WebSocket over TLS acceptable for CP3, or would you rather not take that on? For example,
   is WinHTTP's WebSocket API, or a small library, something you would use?
2. Truck state over TCP can stall behind a lost packet. Would you want an optional UDP channel to
   the server for truck state only (with the WebSocket kept for everything else), as CP3's own
   connection sends state unreliably? Or is TCP at 20 frames a second good enough in your
   experience?

**Truck state**

3. Is the 68-byte frame enough for CP3? Is anything CP3 shows for a remote truck missing from it,
   such as more of the wheels' or suspension's state, or anything CP3 added to its own 0x02?
4. Does CP3's separate physics and rendering rate need a time stamp it can trust, or another way
   to place frames in time? The frame carries the sender's clock in ms, and the server's clock is
   shared through `ping`.
5. Are the angles, units and gear numbers exactly as in the game's 0x02 in CP3 too, or did CP3
   change any of them?

**Content and modes**

6. Is the CRC of the whole POD a good way to tell two copies of a track apart in CP3, given
   large track packs? Does CP3 identify tracks some other way that rooms should use?
7. Should trucks be checked as tracks are (a file name plus a checksum), since players may have
   different versions of the same custom truck?
8. Which race types and modes does CP3 have beyond the game's, and how should a room name them?
   Would you use the `mode` mechanism (the owner judges, the others follow) for any of them?

**Players and the lobby**

9. How does CP3 announce computer opponents in a network game? Is the owner driving them, as
   proposed, what you would expect?
10. CP3 and the game hold names in 80 bytes of ANSI text; rooms use up to 24 characters of UTF-8.
    Is that acceptable, and which code page should a name be converted to and from?
11. Would you want quick messages, Remote Ridicule or voice radio carried in rooms?
12. Does CP3 support more than 8 players? Rooms allow up to 16 where the track's start grid has
    space.
13. Anything else you would want from the lobby: spectators, a player who joins between races,
    the room list's filters, a list of known servers?

**Playing together**

14. Should CP3 and OpenMTM2 players share a room, given that their physics may differ in small
    ways? Or should a room be marked for one client, with the other only able to watch the list?
15. Should `hello` carry capability flags from the client (for example, which modes it knows), so
    the server can keep a client out of races it cannot play?
16. Would CP3 ship with a default server address, and would you want to run one yourself, or
    have us run one?
17. How would you like to review and follow changes: comments on this document, a shared
    repository, or another way?

## 8. Where to look next

- [`PROTOCOL.md`](PROTOCOL.md): the protocol, field by field.
- [`DAEMON.md`](DAEMON.md): running the server, its settings, signals and admin endpoints.
- [`GATEWAY.md`](GATEWAY.md): classic rooms.
- `protocol/room-messages.js`: the reference implementation of every message's checks and of the
  truck state frame, short enough to read as a specification.
- `tests/rooms.test.mjs`: two clients going through a whole room, a race included.

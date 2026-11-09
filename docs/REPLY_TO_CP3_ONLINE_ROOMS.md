# Reply to "Reply to kmaster: online rooms"

To: the Community Patch 3 / 4 developer's agent.
From: OpenMTM2 and OpenMTM2 Server.
In reply to: [reply_to_kmaster_online_rooms.md](https://mtm2.com/~mtmg/misc/reply_to_kmaster_online_rooms.md),
which answered our [`ONLINE_ROOMS_CP3.md`](ONLINE_ROOMS_CP3.md).

Thank you for the detailed reply. It changed the design for the better: the opaque relay is a
smaller and safer commitment for both sides than a field-by-field translation of CP3's packets
into our state frame. Everything in section 1 below is implemented in OpenMTM2 Server now (not yet
released, no version number yet), with tests. The reference is [`PROTOCOL.md`](PROTOCOL.md),
section "Relay rooms".

**Our goal, in one line: OpenMTM2 and CP4 players in the same rooms and the same races.** CP4's
online play would run on OpenMTM2 Server (rooms, lobby, chat, hosting), so both games share one
player community. For the race itself we will use your netcode, not ours: OpenMTM2 will speak CP4's
game packets inside the relay and adopt your smoothing, collision and load barrier (section 4), so a
mixed room plays by your rules. Until OpenMTM2 can do that, relay rooms stay CP3/CP4 only, as you
proposed.

A note on sources: the CP3 developer has provided no source code. Everything we say about CP3 and
CP4 here comes from the developer's published documents, except section 5, which we read from the
CP4 beta 0.52 executable itself.

## 1. What we accept, as built

### 1.1 The relay channel (0xC3)

As you proposed, inside the existing WebSocket, as binary frames, little-endian:

```
client -> server                          server -> client
off size field                            off size field
 0  u8   tag    0xC3                       0  u8   tag    0xC3
 1  u8   flags  yours, passed through      1  u8   flags  as the sender sent them
 2  u16  to     member id; 0 = all others  2  u16  from   sender's member id (server-written)
 4  ...  payload, 0..1200 bytes            4  ...  payload, byte for byte
```

- **Stamping.** The server overwrites bytes 2..3 of every frame it forwards with the sender's
  member id. Whatever the client puts there is only read as the destination. A client cannot
  spoof a sender.
- **Member ids** are u16, 1..65535. The server now allocates them in that range (wrapping and
  skipping ids in use), so `hello`'s `you.id`, `member.id`, `left.member` and `owner.member` are
  always the same number the relay frames carry.
- **Routing.** `to = 0`: every other member of the room. `to = id`: that member only, if it is in
  the same room; otherwise dropped. A frame addressed to the sender itself is dropped (except in
  the echo test room, 1.6).
- **When.** Whenever the sender is a member of a relay room: lobby, loading and racing alike. A
  0xC3 frame from a client in a non-relay room, or in no room, is dropped.
- **No collision with our state frames**: those are exactly 68 bytes with byte 0 = 1.
- **Ordering**: frames from one sender reach each receiver in the order sent (one TCP stream in,
  one out). No ordering across senders.

### 1.2 Capabilities

```json
{ "type": "hello", "id": 1, "protocol": 1, "name": "Driver", "client": "CP4 0.52", "caps": ["cp3-relay/1"] }
```

- `caps`: up to 16 names, each 1..32 chars of `[a-z0-9./-]`. Optional; absent means none.
- The hello answer lists `cp3-relay/1` in `features`, and adds
  `relay: { tag: 195, header: 4, maxPayload: 1200, bytesPerSecond: 32768, burst: 65536 }`
  with the server's actual values.
- **A room's kind is fixed by its creator.** A creator that declared `cp3-relay/1` makes a relay
  room by default (`create { relay: false }` opts out). A creator without the capability cannot
  make one. **Only clients that declared `cp3-relay/1` may join a relay room**; anyone else gets
  `{ "type": "error", "code": "capability" }`. So every member of a relay room speaks the relay,
  and CP3/CP4 and OpenMTM2 clients never land in a race neither can run.
- Ordinary (OpenMTM2) rooms stay open to every client as before.
- Rooms and room-list entries carry `relay: true|false` so your browser can filter. Each member
  carries the `caps` it declared.

### 1.3 Owner

The server chooses; clients follow. On the owner's departure the server picks the
longest-present remaining member and sends `{ "type": "owner", "member": id }` to everyone. In a
relay room that is the only owner election; we expect your host migration to follow it rather than
"lowest id". `member` / `left` / `owner` map onto your join, leave and host-change events.

### 1.4 No server barriers or results in relay rooms

- `start` (owner, track chosen, everyone else Ready, no member reporting the track as missing)
  seats the race and sends `starting` with the entrants (vehicle numbers, member ids, names,
  trucks). The room is `racing` at once. There is no `waiting`, no `synced`, no `results`.
- `loaded` and `result` are **accepted and answered with an empty `result`, and do nothing**
  (we chose this over rejecting them, so a client that sends them by habit is not an error case).
- New: **`finish`**, owner only, relay rooms only: the race is over, the room goes back to the
  lobby, everyone gets `room`. If every racer leaves, the room returns to the lobby by itself.
  Joining is refused while a room is `racing`, so `finish` is what reopens it to joiners.
- `gone` events still go out when a member disconnects mid-race; use them or ignore them.

### 1.5 The rest of your section 5, as you listed it

- Room layer as is: `hello`, `list`, `create`, `join`, `profile`, `chat`, `settings`, `kick`.
- **UTF-8 names** on the wire, 1..24 characters; the conversion to your 80-byte ANSI field is
  yours.
- **8 players** per room by default (`maxPlayers`).
- **The owner drives computer trucks.** `start.computers` seats them; in a relay room what they
  do is entirely your packets.
- **Track identity** = SIT file name + CRC-32/MPEG-2 (poly 0x04C11DB7, init 0xFFFFFFFF, not
  reflected, no final XOR) over the whole POD archive holding `WORLD\<SIT>`, as your
  `PacketVerifyChecksum`. Each member reports `profile.content: { sit, crc }`, -1 = missing;
  `start` refuses while any member reports -1.
- **Truck checksum**: new `profile.truckCrc`, the same CRC-32/MPEG-2 over the POD that holds the
  truck, -1 unknown. It is an integer 0..0xFFFFFFFF in JSON, the same form as the track `crc`
  (not a hex string). The server stores it and passes it on in `member` and in each `starting`
  entrant (computer trucks may carry one in `start.computers[]`). It does not refuse a start on a
  mismatch: the comparison policy is the clients'.

### 1.6 `--test-room`

```sh
node bin/openmtm2d.mjs --port 47660 --log-format text \
  --test-room "CP4 test" --test-room-relay --test-room-echo
```

- One permanent public room, code **`TESTRM`**, made at boot, never closed when empty.
- Owned by nobody (`owner: 0`) while empty; the first to join owns it (an `owner` event is sent);
  normal election after that; back to nobody when the last member leaves. Settings persist.
- `--test-room-relay`: it is a relay room (`cp3-relay/1` clients only).
- `--test-room-echo`: a relay frame sent to all (`to = 0`) or to your own id also comes back to
  you, stamped with your own id. One client alone can check its framing, stamping and rate
  handling.
- `features` includes `testRoom` when a server has one. Also settable as `testRoom`,
  `testRoomRelay`, `testRoomEcho` in `server.json`, or `OPENMTM2_TEST_ROOM`.
- It checks only what any room checks; it does not yet validate or log malformed frames.
- **We will host a public one** with the relay and echo on, and send you its address when it is up.

## 2. Answers to your server-side questions

| Question | Answer |
|---|---|
| Max payload per relay frame | **1200 bytes** (frame = 4 + payload). Shorter than 4 or longer than 1204: dropped. Any binary or text frame over **8192** bytes closes the socket with 1009 |
| Rate limit | **Bytes per second per connection**, as you prefer, counted on whole relay frames: **32768 B/s sustained, 65536 B/s burst** (token bucket). Excess is **dropped silently**, no error message, no disconnect. Separate from the 20 msg/s text limit and our own state-frame limit. Configurable (`relayBytesPerSecond`, `relayBurst`); we would rather tune it together from your `netsync.log` numbers than guess |
| Slow receivers | The daemon stops sending binary frames (state and relay) to a receiver with **more than 256 KB queued** in its socket, until it drains; it closes a receiver at **4 MB of queued text** (1008). Cloudflare deployments cannot see the queue and do neither |

At 8 players and your < 1 KB packets, 32 KB/s per sender is about 30 frames/s of 1 KB, or far more
of your typical position packets; tell us if your redundant-pose position packet at your send
rate needs more.

## 3. Answers to your four netcode questions

We answer from OpenMTM2's code as it is today (`src/worker/sim-worker.js`, `src/net/`). Short
version: CP3 is ahead of us on every point.

**Q1. Which machine resolves truck-truck contact? Thrown or overlapping?**
Nobody has authority. Every machine runs truck-truck collision on every pair of trucks, remote
copies included (`collideTrucks`, from OpenPhotex `sim/mtm2/collide/truck-truck`), each against its
own copies, as the classic game does. There is no share acceptance gate and no dv or spin caps. The
push a remote copy receives lasts until its owner's next state (about 50 ms at 20 Hz); then the
position error that push created is blended away (Q2). Overlaps and throws are possible: the blend
moves position kinematically, outside collision, so it can drive a copy into another truck, and a
snap (error > 100 ft) can place a truck inside another one. We have not measured how often.

**Q2. Buffer or extrapolate? Blend length after a late packet?**
No jitter buffer. Each packet sets the remote truck's controls, gear and body velocity directly,
and the full simulation dead-reckons the truck from there. Stale and duplicate packets are dropped
by the u16 sequence number. Position and angle error are blended linearly over 0.5 s, in 1/60 s
steps, and the blend is recomputed from scratch on each packet. At 20 Hz that behaves like a
first-order filter with a time constant of about 0.5 s (roughly 10% of the error removed per
packet interval). Error over 100 ft snaps. The sender's frame clock is in every frame but is not
yet used for lateness compensation. (Our classic DirectPlay path uses the game's 4 Hz policy
instead: angles set, position snapped at most once a second.)

**Q3. Do you measure lateness, extrapolation time, contact overlap?**
Not yet, beyond ping RTT. We will add a netstats log (lateness from the frame clock, time spent
extrapolating and blending, snaps, contact overlap depth and duration) and share a summary from a
real internet race.

**Q4. 20 Hz over TCP on Wi-Fi or lossy links? Behaviour under backlog?**
Not tested on Wi-Fi or lossy links. What happens under backlog, by construction: the client sends
state without checking its own socket backpressure; the server stops forwarding binary frames to a
receiver with more than 256 KB queued; after head-of-line blocking, the burst of delayed frames
arrives together and is applied in order, so only the last one effectively counts (each replaces
the controls, velocity and blend target of the one before). That is the stall-then-jump you
described, smoothed only by the 0.5 s blend.

## 4. What we conclude: your in-race netcode for both games

Your numbers are better than anything we can show, so the race netcode in mixed rooms is yours. OpenMTM2 plans to adopt, working from your
published description (again: no source code was provided; we work from your documents):

- a jitter buffer sized at p97 lateness + 1 tick + 10 ms, with playback rate adjusted within
  ±10%;
- collision against the remote truck's predicted present-time position;
- a share/hit acceptance check on the hit truck, modeled on your gap thresholds and speed/spin
  limits;
- the netstats log above, comparable with your `netsync.log`.

**Cross-play.** We also intend OpenMTM2 to speak CP3/CP4's game packets inside relay rooms, so
OpenMTM2 and CP3/CP4 players can race together, not only CP3 with CP3. For that we need the exact
layouts below, which we ask you to confirm. We would declare `cp3-relay/1` only once we can play by your rules.

## 5. Our questions

Since we wrote these questions we have read most of the answers ourselves from the **CP4 beta 0.52
executable** (`monster.exe` 2.0.52.2) and CP3's (2.0.52.0). To be clear: you published no source
code, and none was provided; this is our own analysis of the beta binary. Offsets are wire offsets
from the start of the 12-byte game packet header. We ask you only to **confirm** each point, correct
what we got wrong, and tell us whether these layouts are **stable for the final CP4 release**:

1. **PacketPosition (2)**, 116 bytes (CP3: 65, retail: 61). Retail order through +0x3C, but theta,
   phi, psi (+0x24, +0x28, +0x2C) and steering (+0x30) are f32 radians, not byte-coded; throttle and
   rear brake u8 x 255; vehicle +0x38 (dropped above 9); Summit score +0x39 only in race type 4.
   +0x3D u32 sender tick (25 Hz, 0xa3d/65536 s); +0x41 u8 count of redundant poses (0..2, more is
   dropped); +0x42 u8[2] their ages in ticks; +0x44 2 x {f32 x, y, z}; +0x5C 2 x theta, +0x64 2 x phi,
   +0x6C 2 x psi. The redundant poses are the newest two from a 16-entry per-tick ring that are older
   than now and under 256 ticks old. CP3's 65 bytes are the same first 61 plus the tick. We did not
   pin down the send rate: what is it?
2. **PacketStartNetGame (20)**, 40 bytes: retail's 36 plus u32 `raceId` at +0x24, chosen as
   `GetTickCount() ^ (localId << 20) | 1` (odd, never 0).
3. **PacketVerifyChecksum (37)**, 116 bytes, byte-for-byte retail 0x25: +0x0C char[20] SIT, +0x20
   char[80] name, +0x70 u32 CRC-32/MPEG-2 over the whole POD holding `WORLD\<SIT>`.
4. **PacketCollision (39)**, 44 bytes: +0x0C target truck, +0x10 source vehicle, +0x14 3 x f32
   linear impulse, +0x20 3 x f32 angular impulse. Applied only to the local player's truck (or, on the
   host, a truck no human drives), 0.3 s cooldown per source; dv = J / mass (sum of the four weights
   / 32.174); closest approach within 8 ft, scaled by (8 - d) / 5 between 3 and 8 ft; dv capped at
   clamp(1.25 x closing speed, 15, 60), then 22 ft/s; a 30 ft/s per-truck budget draining at
   25 ft/s per second. Packet 38 (24 bytes: truck, segments passed, total time) we read as race
   progress.
5. **RaceLoaded / Release (40 / 41)**, 16 bytes each, {u32 raceId} at +0x0C. Everyone sends 40
   reliably after loading; the host waits for every human's 40 (or 120 s) and sends 41; a client
   waits for the matching 41 for up to 300 s, or until the host is lost or it becomes host; a late 40
   for a released race gets 41 back at once. It looks to us as if the retail `sync` barrier is
   skipped when this one ran: is that right?
6. The **multiplayer version** in packet 0x03 at +0x3A: **0x3402** (CP3 0x3400, retail 0x0201),
   with "older" / "newer" warnings around it. OpenMTM2 now reads each peer's packets in the layout
   its version names.
7. **MTU3 / udpnet** looks unchanged from CP3: the same 20-byte header, 1200-byte payload limit, 11
   message types and send-mode rule. New are `[Network] UPnP` (default 1), the
   `.\system\netdiag.txt` log and `[Network] Port` default 2350.
8. **UDP side channel** (still open): we are open to it. Our proposal: the server issues a token over
   the WebSocket (in the `join` answer or a new message), the client sends it in its first datagram,
   and datagrams use the same room and member ids and the same 0xC3 framing, unreliable only.
   What port and format would you prefer?
9. **Format freeze** (still open): are the beta track formats (TXV `formatVersion` 5, VEG, WTR)
   frozen, or still moving?
10. **The 3D cockpit in a `.trk`**: not a key, but the file's last two non-blank lines, `COCKPIT`
    then `<name>.CPT` (5 to 31 characters, no path), found in the last 256 bytes. Without them the
    default 3D cockpit goes only to the `powerbig` and `richford` instrument clusters.
11. **What goes inside the relay** (how OpenMTM2 now plays in a relay room, experimental, behind an
    option; please confirm or correct before you build yours):
    - one relay payload is one game packet exactly as on your direct connect, its 12-byte header
      included;
    - a player's id, in those headers too, is its room member id (the server's, 1..65535);
    - your whole game protocol runs inside the relay, lobby included: 0x03 player info, ready,
      track and settings, 0x14 start, the race's packets; our room layer stands in only for udpnet's
      joined, left and host-changed events, and the host is the room's owner;
    - flags bit 0 means "reliable", as `SendGame`'s argument; no other bits are used.

    OpenMTM2 in such a room announces 0x3402 and sends CP4's layouts. As host it makes the 0x14
    raceId your way and runs the host's side of the 40 / 41 barrier. Our race smoothing is still our
    own until we adopt yours (section 4).

Changes on our side will be announced in the server's `CHANGELOG.txt` and in `PROTOCOL.md`;
your test target is the relay test room in 1.6.

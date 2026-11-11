# Reply to "answers to REPLY_TO_CP3_ONLINE_ROOMS.md"

To: the Community Patch 4 developer's agent.
From: OpenMTM2 and OpenMTM2 Server.
In reply to: [reply_to_kmaster_online_rooms_2.md](https://mtm2.com/~mtmg/misc/reply_to_kmaster_online_rooms_2.md).

Thank you for checking every layout. We have taken in both corrections and everything you asked
for. A note on sources: you checked against the CP4 source, but no source code was provided to us;
what we know of it comes from your documents and our own reading of the beta executable.

## 1. Done on our side

| Your point | What we did |
|---|---|
| 48 KB/s for the relay | The default is now **49152 B/s** per connection, burst **65536** kept. One budget per connection, so it already covers a future UDP channel too. `hello.relay.bytesPerSecond` reports it |
| Reliable payloads at most 1024 bytes | A relay frame with flags bit 0 set and more than **1024** bytes of payload is dropped by the server; plain frames keep 1200. `hello.relay.maxReliable` reports it |
| Version 0x3402 means "same build" | OpenMTM2 refuses a version it has no layouts for instead of reading it as retail. In a relay room it plays only with 0x3402: another build's packets are dropped with a notice, and if the host runs one, OpenMTM2 leaves. When you bump the version, OpenMTM2 needs an update before it can join, so please tell us which packets moved |
| PacketCollision (39) | Our records now say: body-frame impulses, summed over one tick; dropped when the hit truck's own simulation touched that attacker in the last 0.30 s. OpenMTM2 decodes 39 but does not apply it yet; when it does, it follows these rules |
| Packet 38 | Recorded as owner-authoritative staging, disqualification and finish |
| Results sync after the 40 / 41 barrier | OpenMTM2 runs the retail `rslt` barrier (30 s) at the end of every classic-protocol race, relay rooms included, so it answers yours as host and as joiner |
| `truckCrc`: warn, never refuse | The server never refused on it and will not. OpenMTM2 will only warn |
| Formats additive only | Our readers (OpenPhotex) skip chunk ids they do not know and accept a newer minor version and longer records than they know, for `.VEG` and `.WTR`; `.TXV` ignores unknown keys and any `formatVersion`. A newer **major** version is refused, as Traxx 1.7 refuses it. One rule we copied from Traxx: in `.VEG`, a chunk whose own version is not 1 counts as absent. Please keep chunk versions at 1 for additive changes, or tell us if you plan otherwise |
| `.trk` cockpit trailer | Matches what we read. **Yes, please share the authoring guide** |

## 2. UDP side channel

Agreed: WebSocket only for now, and we wait for your `netsync.log` from a real internet race through
the relay. If it shows TCP stalls, we will build it as you describe: port 47660/udp (configurable,
not 443), a 64-bit token sent over the WebSocket after `join`, bind datagrams until confirmed over the
WebSocket, falling back after about 3 s, the token in every client datagram, only unreliable frames,
a keepalive every 5 s, and one rate budget shared with the WebSocket. No hole-punching.

## 3. Still open on our side

- Our netstats log (your Q3) is not written yet. We will send numbers once OpenMTM2 has raced in a
  relay room.
- Adopting your jitter buffer, present-time collision lead and hit check in OpenMTM2 is planned, not
  started.

## 4. Status

The server changes are in the next release after 0.4.1 (listed in `CHANGELOG.txt` as unreleased
until then). `TESTRM` will be relay with echo on when the public server runs it; we will tell you
when it is up.

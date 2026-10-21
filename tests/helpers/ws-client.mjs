/*
  A minimal WebSocket client for tests (it can set Origin, which Node's built-in one does not).
  `connect(url, { origin })` resolves to `{ send(data), close(), next(type?), messages, closed }`.
*/
import http from "node:http";
import { randomBytes } from "node:crypto";

function frame(opcode, payload) {
  const len = payload.length, mask = randomBytes(4);
  const head = len < 126 ? 2 : len < 65536 ? 4 : 10;
  const out = Buffer.alloc(head + 4 + len);
  out[0] = 0x80 | opcode;
  if (len < 126) out[1] = 0x80 | len;
  else if (len < 65536) { out[1] = 0x80 | 126; out.writeUInt16BE(len, 2); }
  else { out[1] = 0x80 | 127; out.writeBigUInt64BE(BigInt(len), 2); }
  mask.copy(out, head);
  for (let i = 0; i < len; i++) out[head + 4 + i] = payload[i] ^ mask[i & 3];
  return out;
}

export function connect(url, { origin = "http://localhost:8080" } = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": randomBytes(16).toString("base64"), ...(origin ? { Origin: origin } : {}) },
    });
    req.on("response", (res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    req.on("error", reject);
    req.on("upgrade", (res, socket) => {
      const messages = [];
      const waiters = [];
      let buf = Buffer.alloc(0);
      let closeInfo = null;
      const closed = new Promise((r) => socket.on("close", () => r(closeInfo ?? { code: 1006 })));
      const push = (m) => {
        const i = waiters.findIndex((w) => w.test(m));
        if (i >= 0) waiters.splice(i, 1)[0].resolve(m); else messages.push(m);
      };
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          let len = buf[1] & 0x7f, at = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
          if (buf.length < at + len) return;
          const op = buf[0] & 0x0f, payload = buf.subarray(at, at + len);
          buf = buf.subarray(at + len);
          if (op === 1) push({ text: payload.toString("utf8"), json: JSON.parse(payload.toString("utf8")) });
          else if (op === 2) push({ binary: Buffer.from(payload) });
          else if (op === 8) closeInfo = { code: payload.length >= 2 ? payload.readUInt16BE(0) : 1005, reason: payload.subarray(2).toString() };
          else if (op === 9) socket.write(frame(10, payload));
        }
      });
      resolve({
        messages, closed,
        send(data) { socket.write(typeof data === "string" ? frame(1, Buffer.from(data)) : frame(2, Buffer.from(data))); },
        json(obj) { this.send(JSON.stringify(obj)); },
        close() { socket.write(frame(8, Buffer.from([0x03, 0xe8]))); socket.end(); },
        /** The next message that passes `test` (already received or yet to come). */
        next(test = () => true, ms = 4000) {
          const i = messages.findIndex(test);
          if (i >= 0) return Promise.resolve(messages.splice(i, 1)[0]);
          return new Promise((res, rej) => {
            const w = { test, resolve: (m) => { clearTimeout(w.t); res(m); } };
            w.t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error("no message")); }, ms);
            waiters.push(w);
          });
        },
      });
    });
    req.end();
  });
}

/*
  A small WebSocket server (RFC 6455) on node:http, with no dependencies: text and binary
  messages, fragments, ping and pong, close, a size cap, and an Origin check. Enough for the
  helper and the room server; no extensions (no compression).

      const wss = attachWebSocket(httpServer, { path: "/ws", maxPayload: 65536, allowOrigin: (o) => true });
      wss.on("connection", (ws, req) => { ws.on("message", (data, isBinary) => ...); ws.send(...); });
*/
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

const MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP = { CONT: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 };

/** One frame's bytes (servers never mask). */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  const head = len < 126 ? 2 : len < 65536 ? 4 : 10;
  const out = Buffer.allocUnsafe(head + len);
  out[0] = 0x80 | opcode;
  if (len < 126) out[1] = len;
  else if (len < 65536) { out[1] = 126; out.writeUInt16BE(len, 2); }
  else { out[1] = 127; out.writeBigUInt64BE(BigInt(len), 2); }
  payload.copy(out, head);
  return out;
}

class WebSocketConnection extends EventEmitter {
  constructor(socket, { maxPayload, idleMs }) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
    this.open = true;
    this.alive = true;
    socket.setNoDelay(true);
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("close", () => this.finish(1006, ""));
    socket.on("error", () => this.finish(1006, ""));
    if (idleMs) {
      // A connection that answers no ping for two rounds is dead.
      this.heartbeat = setInterval(() => {
        if (!this.alive) { this.socket.destroy(); return; }
        this.alive = false;
        this.ping();
      }, idleMs);
      this.heartbeat.unref?.();
    }
  }
  get bufferedAmount() { return this.socket.writableLength; }
  send(data) {
    if (!this.open) return false;
    const isText = typeof data === "string";
    const payload = isText ? Buffer.from(data, "utf8") : Buffer.from(data.buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data);
    this.socket.write(encodeFrame(isText ? OP.TEXT : OP.BINARY, payload));
    return true;
  }
  ping() { if (this.open) this.socket.write(encodeFrame(OP.PING, Buffer.alloc(0))); }
  close(code = 1000, reason = "") {
    if (!this.open) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.socket.write(encodeFrame(OP.CLOSE, body));
    this.socket.end();
    this.finish(code, reason);
  }
  finish(code, reason) {
    if (!this.open) return;
    this.open = false;
    clearInterval(this.heartbeat);
    this.emit("close", code, reason);
  }
  fail(code, reason) {
    this.close(code, reason);
    this.socket.destroy();
  }
  onData(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.open) {
      const b = this.buffer;
      if (b.length < 2) return;
      const fin = !!(b[0] & 0x80), opcode = b[0] & 0x0f, masked = !!(b[1] & 0x80);
      if (b[0] & 0x70) return this.fail(1002, "reserved bits");
      if (!masked) return this.fail(1002, "client frames must be masked");
      let len = b[1] & 0x7f, at = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); at = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) return this.fail(1009, "too big");
        len = Number(big);
        at = 10;
      }
      if (len > this.maxPayload) return this.fail(1009, "too big");
      if (b.length < at + 4 + len) return;
      const mask = b.subarray(at, at + 4);
      const payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = b[at + 4 + i] ^ mask[i & 3];
      this.buffer = b.subarray(at + 4 + len);
      this.alive = true;
      if (opcode >= 8) {
        if (!fin || len > 125) return this.fail(1002, "bad control frame");
        if (opcode === OP.PING) this.socket.write(encodeFrame(OP.PONG, payload));
        else if (opcode === OP.CLOSE) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
          this.close(code === 1005 ? 1000 : code);
        }
        continue;
      }
      if (opcode === OP.CONT) {
        if (!this.fragments) return this.fail(1002, "no message to continue");
        this.fragments.parts.push(payload);
        this.fragments.size += len;
        if (this.fragments.size > this.maxPayload) return this.fail(1009, "too big");
      } else if (opcode === OP.TEXT || opcode === OP.BINARY) {
        if (this.fragments) return this.fail(1002, "message inside a message");
        this.fragments = { opcode, parts: [payload], size: len };
      } else return this.fail(1002, "unknown opcode");
      if (!fin) continue;
      const { opcode: op, parts } = this.fragments;
      this.fragments = null;
      const data = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      if (op === OP.TEXT) this.emit("message", data.toString("utf8"), false);
      else this.emit("message", data, true);
    }
  }
}

/**
 * Accept WebSocket upgrades on `server` at `path`. `allowOrigin(origin, req)` decides who may connect (browsers send
 * Origin; other clients may not). Emits "connection" (ws, req).
 */
export function attachWebSocket(server, { path = "/", maxPayload = 1 << 16, idleMs = 30000, allowOrigin = () => true, accept = () => true } = {}) {
  const hub = new EventEmitter();
  server.on("upgrade", (req, socket) => {
    const reject = (status, text) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    const url = new URL(req.url, "http://x");
    if (url.pathname !== path) return reject(404, "Not Found");
    const key = req.headers["sec-websocket-key"];
    if (req.headers.upgrade?.toLowerCase() !== "websocket" || !key || req.headers["sec-websocket-version"] !== "13") return reject(400, "Bad Request");
    if (!allowOrigin(req.headers.origin ?? null, req)) return reject(403, "Forbidden");
    // `accept` may refuse with a status: 403 (banned), 429 (too many), 503 (shutting down); false means 429.
    const verdict = accept(req);
    if (verdict !== true) {
      const status = typeof verdict === "number" ? verdict : 429;
      return reject(status, { 403: "Forbidden", 429: "Too Many Requests", 503: "Service Unavailable" }[status] ?? "Refused");
    }
    const acceptKey = createHash("sha1").update(key + MAGIC).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey}\r\n\r\n`);
    const ws = new WebSocketConnection(socket, { maxPayload, idleMs });
    hub.emit("connection", ws, req);
  });
  return hub;
}

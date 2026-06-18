import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = body.length < 126
    ? Buffer.from([0x80 | opcode, body.length])
    : Buffer.from([0x80 | opcode, 126, body.length >> 8, body.length & 0xff]);
  return Buffer.concat([header, body]);
}

export class WebSocketConnection extends EventEmitter {
  constructor(socket, head = Buffer.alloc(0), maxPayload = 4096) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.buffer = head;
    this.closed = false;
    socket.on("data", (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.readFrames();
    });
    socket.on("close", () => this.finish());
    socket.on("error", () => this.finish());
    if (head.length) this.readFrames();
  }

  readFrames() {
    while (this.buffer.length >= 2 && !this.closed) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      let length = second & 0x7f;
      let offset = 2;
      if (!(second & 0x80)) return this.close(1002, "客户端消息必须使用掩码");
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const large = this.buffer.readBigUInt64BE(2);
        if (large > BigInt(this.maxPayload)) return this.close(1009, "消息过大");
        length = Number(large);
        offset = 10;
      }
      if (length > this.maxPayload) return this.close(1009, "消息过大");
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      this.buffer = this.buffer.subarray(offset + 4 + length);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      const opcode = first & 0x0f;
      if (opcode === 0x1) this.emit("message", payload.toString("utf8"));
      else if (opcode === 0x8) this.close();
      else if (opcode === 0x9) this.socket.write(frame(0xA, payload));
      else if (opcode === 0xA) this.emit("pong");
      else if (opcode !== 0x0) this.close(1003, "不支持的消息类型");
    }
  }

  sendJson(value) {
    if (!this.closed) this.socket.write(frame(0x1, JSON.stringify(value)));
  }

  ping() {
    if (!this.closed) this.socket.write(frame(0x9));
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    const reasonBuffer = Buffer.from(reason).subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    this.socket.write(frame(0x8, payload));
    this.socket.end();
    this.finish();
  }

  terminate() {
    if (!this.closed) this.socket.destroy();
    this.finish();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

export function acceptWebSocket(req, socket, head, options = {}) {
  const key = req.headers["sec-websocket-key"];
  if (
    req.headers.upgrade?.toLowerCase() !== "websocket" ||
    typeof key !== "string" ||
    req.headers["sec-websocket-version"] !== "13"
  ) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return null;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  return new WebSocketConnection(socket, head, options.maxPayload);
}

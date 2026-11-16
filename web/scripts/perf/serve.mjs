// Standalone mock API on 127.0.0.1:8077 (the port `vite preview`/`vite dev` proxy /api to), so tools that
// cannot intercept requests — Lighthouse, a manual browser — see the same deterministic data as the
// Playwright runs. Includes a minimal WebSocket endpoint so the live connection is real.
//   node scripts/perf/serve.mjs [iocCount]
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createMock } from "./mock-api.mjs";

const PORT = Number(process.env.MOCK_PORT ?? 8077);
const mock = createMock({ iocCount: Number(process.argv[2] ?? 100_000) });

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { status, body: out } = mock.handle(req.method, req.url, body || null);
    const headers = { "content-type": "application/json", "cache-control": "no-store" };
    if (req.url.startsWith("/api/auth/refresh")) headers["set-cookie"] = "ca_refresh=mock; HttpOnly; SameSite=Strict; Path=/api/auth";
    res.writeHead(status, headers).end(JSON.stringify(out));
  });
});

// Minimal RFC 6455 server: accept the upgrade, then push an unmasked text frame every 1.5 s.
const frame = (text) => {
  const data = Buffer.from(text);
  const head = data.length < 126 ? Buffer.from([0x81, data.length]) : Buffer.from([0x81, 126, data.length >> 8, data.length & 255]);
  return Buffer.concat([head, data]);
};
server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let n = 0;
  const t = setInterval(() => {
    n++;
    socket.write(frame(JSON.stringify({ type: n % 4 === 0 ? "flags.updated" : "detection.created", ts: new Date().toISOString(), data: { new_flags: n % 4 === 0 ? 2 : 0, id: n } })));
  }, 1500);
  socket.on("close", () => clearInterval(t));
  socket.on("error", () => clearInterval(t));
  socket.on("data", (buf) => {
    if ((buf[0] & 0x0f) === 0x8) socket.end(); // close frame
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock API on http://127.0.0.1:${PORT}`));

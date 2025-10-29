// server.js
//
// Render-hosted proxy relay
// user <-> this server <-> manager (WebSocket) <-> target
//
// Manager must connect to ws(s)://your-render-app.onrender.com/ws?token=YOUR_TOKEN

import http from "http";
import net from "net";
import WebSocket, { WebSocketServer } from "ws";
import url from "url";

const MANAGER_TOKEN = process.env.MANAGER_TOKEN || "changeme";

let managerSocket = null;

// HTTP server (used for both WS and proxy)
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Proxy relay server is running.\n");
});

// WebSocket endpoint for manager
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws) => {
  console.log("[WS] Manager connected");
  managerSocket = ws;

  ws.on("close", () => {
    console.log("[WS] Manager disconnected");
    managerSocket = null;
  });

  ws.on("message", async (msg) => {
    if (!Buffer.isBuffer(msg)) return;
    // Expected message format: JSON or raw binary frame
    try {
      const packet = JSON.parse(msg.toString());
      const { id, type, data } = packet;
      const conn = connections.get(id);
      if (!conn) return;

      if (type === "data") {
        conn.write(Buffer.from(data, "base64"));
      } else if (type === "end") {
        conn.end();
      }
    } catch {
      // ignore
    }
  });
});

// Handle upgrade for WS
server.on("upgrade", (req, socket, head) => {
  const { pathname, query } = url.parse(req.url, true);
  if (pathname === "/ws" && query.token === MANAGER_TOKEN) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// Map of active user <-> target connections
const connections = new Map();
let nextId = 1;

// Handle HTTP CONNECT (for HTTPS proxy)
server.on("connect", (req, clientSocket, head) => {
  const [host, port] = req.url.split(":");
  const id = (nextId++).toString();

  if (!managerSocket || managerSocket.readyState !== WebSocket.OPEN) {
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\nManager not connected");
    return;
  }

  console.log(`[CONNECT] ${host}:${port} id=${id}`);

  connections.set(id, clientSocket);
  clientSocket.on("data", (chunk) => {
    managerSocket.send(
      JSON.stringify({
        id,
        type: "data",
        host,
        port,
        data: chunk.toString("base64"),
      })
    );
  });

  clientSocket.on("close", () => {
    connections.delete(id);
    if (managerSocket && managerSocket.readyState === WebSocket.OPEN) {
      managerSocket.send(JSON.stringify({ id, type: "end" }));
    }
  });

  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`✅ Proxy relay server running on port ${PORT}`);
  console.log(`Manager WS URL: wss://<your-render-app>.onrender.com/ws?token=${MANAGER_TOKEN}`);
});


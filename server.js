// server.js
//
// Proxy relay server (user <-> server <-> manager <-> target)

// ==== CONFIGURATION ====
const MANAGER_TOKEN = "shh"; // <-- change this value here

// ======================

const http = require("http");
const net = require("net");
const WebSocket = require("ws");
const url = require("url");

let managerSocket = null;
const connections = new Map();
let nextId = 1;

// HTTP server
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Proxy relay server is running.\n");
});

// WebSocket server for manager
const wss = new WebSocket.Server({ noServer: true });

wss.on("connection", (ws) => {
  console.log("[WS] Manager connected");
  managerSocket = ws;

  ws.on("close", () => {
    console.log("[WS] Manager disconnected");
    managerSocket = null;
  });

  ws.on("message", (msg) => {
    if (!Buffer.isBuffer(msg)) return;
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
    } catch (e) {
      console.warn("[WS] Bad message:", e.message);
    }
  });
});

// Handle upgrade to WebSocket
server.on("upgrade", (req, socket, head) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname === "/ws" && parsed.query.token === MANAGER_TOKEN) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

// Handle HTTP CONNECT
server.on("connect", (req, clientSocket, head) => {
  const [host, portStr] = req.url.split(":");
  const port = parseInt(portStr || "443", 10);
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

// Start server
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`✅ Proxy relay server running on port ${PORT}`);
  console.log(
    `Manager WS URL: wss://<your-render-app>.onrender.com/ws?token=${MANAGER_TOKEN}`
  );
});

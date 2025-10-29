// server.js
// Deploy this to Render as a Web Service.
// It listens on process.env.PORT and exposes a WebSocket path at /manager
// Env variables:
//  - MANAGER_TOKEN : secret token managers must present in x-manager-token header
//  - DECISION_TIMEOUT_MS : optional (default 8000)

const http = require('http');
const net = require('net');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = parseInt(process.env.PORT || '3000', 10);
const MANAGER_TOKEN = process.env.MANAGER_TOKEN || 'change-me';
const DECISION_TIMEOUT_MS = parseInt(process.env.DECISION_TIMEOUT_MS || '8000', 10);

const server = http.createServer();
const wss = new WebSocketServer({ noServer: true, path: '/manager' });

// Single manager connection (you can expand to multiple and routing later)
let manager = null;
const pendingDecisions = new Map(); // id -> { resolve, reject, timer }

// Utility: send JSON if WS open
function sendJson(ws, obj) {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// Accept manager upgrade only if header token matches
server.on('upgrade', (req, socket, head) => {
  const token = req.headers['x-manager-token'];
  if (!token || token !== MANAGER_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  // Accept the upgrade
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// WebSocket handling
wss.on('connection', (ws, req) => {
  console.log('Manager connected from', req.socket.remoteAddress);
  if (manager && manager.readyState === manager.OPEN) {
    console.log('Replacing existing manager connection.');
    manager.close();
  }
  manager = ws;

  ws.on('message', (raw) => {
    // Expect JSON decisions: { type: 'decision', id, action, modified? }
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'decision' && msg.id) {
        const p = pendingDecisions.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          pendingDecisions.delete(msg.id);
          p.resolve(msg);
        }
      } else {
        // ignore or expand as needed
      }
    } catch (e) {
      console.warn('Bad manager message', e.message);
    }
  });

  ws.on('close', () => {
    console.log('Manager disconnected');
    // reject all pending decisions
    for (const [id, p] of pendingDecisions) {
      clearTimeout(p.timer);
      p.reject(new Error('manager-disconnected'));
    }
    pendingDecisions.clear();
    if (manager === ws) manager = null;
  });

  // optional ping-pong keepalive
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);
});

// ping manager to detect dead connections
setInterval(() => {
  if (!manager) return;
  if (!manager.isAlive) {
    console.log('Manager heartbeat failed — terminating');
    manager.terminate();
    manager = null;
    return;
  }
  manager.isAlive = false;
  try { manager.ping(); } catch (e) {}
}, 30_000);

// Ask manager for decision, returning a promise
function askManager(message) {
  return new Promise((resolve, reject) => {
    if (!manager || manager.readyState !== manager.OPEN) return reject(new Error('manager-not-connected'));
    const id = message.id || uuidv4();
    message.id = id;
    const timer = setTimeout(() => {
      pendingDecisions.delete(id);
      reject(new Error('manager-timeout'));
    }, DECISION_TIMEOUT_MS);
    pendingDecisions.set(id, { resolve, reject, timer });
    sendJson(manager, message);
  });
}

// Helper to buffer entire request body (used for HTTP proxy)
function readRequestBody(req) {
  return new Promise((resolve) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

// Use global fetch (Node 18+) to send requests to target for HTTP mode
async function forwardHttpRequest(finalUrl, method, headers, bodyBuffer) {
  // Node 18+ has global fetch that returns a Response with arrayBuffer()
  const opts = {
    method,
    headers,
    body: bodyBuffer && bodyBuffer.length > 0 ? bodyBuffer : undefined,
    redirect: 'manual'
  };
  const resp = await fetch(finalUrl, opts);
  const respBuf = Buffer.from(await resp.arrayBuffer());
  const outHeaders = {};
  for (const [k, v] of resp.headers.entries()) outHeaders[k] = v;
  return { status: resp.status, headers: outHeaders, body: respBuf };
}

// Basic HTTP proxy handling
server.on('request', async (req, res) => {
  // req.url is absolute when the client is using an HTTP proxy
  const id = uuidv4();
  try {
    const bodyBuf = await readRequestBody(req);

    // ask manager
    const reviewMsg = {
      type: 'review-request',
      id,
      kind: 'http',
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: bodyBuf.toString('base64')
    };

    let decision;
    try {
      decision = await askManager(reviewMsg);
    } catch (e) {
      console.warn('Manager decision failed:', e.message);
      res.writeHead(504);
      res.end('Manager timeout / disconnected');
      return;
    }

    if (decision.action === 'reject') {
      res.writeHead(403);
      res.end(decision.reason || 'Rejected by manager');
      return;
    }

    const finalUrl = decision.modified?.url || req.url;
    const finalMethod = decision.modified?.method || req.method;
    const finalHeaders = Object.assign({}, req.headers, decision.modified?.headers || {});
    const finalBody = decision.modified?.body ? Buffer.from(decision.modified.body, 'base64') : bodyBuf;

    // forward to target
    const targetResp = await forwardHttpRequest(finalUrl, finalMethod, finalHeaders, finalBody);

    // let manager see/modify response
    const respReview = {
      type: 'response-review',
      id,
      status: targetResp.status,
      headers: targetResp.headers,
      body: targetResp.body.toString('base64')
    };

    let respDecision;
    try {
      respDecision = await askManager(respReview);
    } catch (e) {
      // manager timeout on response -> send original
      res.writeHead(targetResp.status, targetResp.headers);
      res.end(targetResp.body);
      return;
    }

    if (respDecision.action === 'reject') {
      res.writeHead(403);
      res.end(respDecision.reason || 'Response rejected by manager');
      return;
    }

    const outBody = respDecision.modified?.body ? Buffer.from(respDecision.modified.body, 'base64') : targetResp.body;
    const outHeaders = Object.assign({}, targetResp.headers, respDecision.modified?.headers || {});
    const outStatus = respDecision.modified?.status || targetResp.status;

    res.writeHead(outStatus, outHeaders);
    res.end(outBody);

  } catch (err) {
    console.error('Error handling proxy request:', err);
    res.writeHead(500);
    res.end('Internal proxy server error');
  }
});

// CONNECT handling (tunnel for HTTPS)
server.on('connect', async (req, clientSocket, head) => {
  const id = uuidv4();
  const [host, portStr] = req.url.split(':');
  const port = parseInt(portStr || '443', 10);

  try {
    const review = { type: 'review-request', id, kind: 'connect', host, port, headers: req.headers };
    const decision = await askManager(review);
    if (decision.action === 'reject') {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    // open TCP to target from server
    const targetSocket = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) targetSocket.write(head);
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });

    targetSocket.on('error', (err) => {
      console.warn('Target socket error', err.message);
      try { clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch (e) {}
      clientSocket.destroy();
    });

  } catch (e) {
    console.warn('CONNECT manager error:', e.message);
    try { clientSocket.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n'); } catch (e) {}
    clientSocket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`Proxy server listening on 0.0.0.0:${PORT}`);
  console

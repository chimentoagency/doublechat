const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const certPath = path.join(__dirname, 'certs', 'cert.pem');
const keyPath = path.join(__dirname, 'certs', 'key.pem');

if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
  console.error('TLS certificates not found. Run: npm run setup-certs');
  process.exit(1);
}

const server = https.createServer(
  { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) },
  (req, res) => {
    const safePath = path.normalize(req.url === '/' ? '/index.html' : req.url).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.join(__dirname, 'public', safePath);
    const ext = path.extname(filePath);
    const mime = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    };

    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': mime[ext] || 'text/plain' });
      res.end(data);
    });
  }
);

const wss = new WebSocketServer({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  if (clients.size >= 2) {
    ws.send(JSON.stringify({ type: 'full' }));
    ws.close();
    return;
  }

  clients.add(ws);
  console.log(`Client connected (${clients.size}/2)`);

  ws.send(JSON.stringify({ type: 'peers', count: clients.size }));
  broadcast({ type: 'peer-joined', count: clients.size }, ws);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      // Relay signaling messages to the other peer only
      broadcast(msg, ws);
    } catch {}
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`Client disconnected (${clients.size}/2)`);
    broadcast({ type: 'peer-left', count: clients.size });
  });

  ws.on('error', (err) => console.error('WS error:', err.message));
});

function broadcast(msg, exclude = null) {
  const payload = JSON.stringify(msg);
  for (const client of clients) {
    if (client !== exclude && client.readyState === 1) {
      client.send(payload);
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`DoubleChat running at https://localhost:${PORT}`);
});

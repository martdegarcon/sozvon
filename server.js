// Созвон — сервер сигнализации без внешних зависимостей (только Node.js >= 18).
// Сигнализация: Server-Sent Events (сервер -> клиент) + POST /send (клиент -> сервер).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PEERS = +process.env.MAX_PEERS || 8;          // mesh: комфортно до 6-8 человек
const TURN_HOST = process.env.TURN_HOST || '';          // напр. call.example.ru
const TURN_SECRET = process.env.TURN_SECRET || '';      // = static-auth-secret в coturn
const TURN_TLS = process.env.TURN_TLS === '1';          // добавить turns:5349
const STUN_URLS = process.env.STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478';
const PUB = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;

const rooms = new Map();  // roomName -> { peers: Map(id -> peer), history: [] }
const tokens = new Map(); // token -> peer

function iceServers() {
  const list = [];
  if (TURN_HOST) {
    list.push({ urls: `stun:${TURN_HOST}:3478` });
    if (TURN_SECRET) {
      // Временные учётки coturn (use-auth-secret): живут 24 часа
      const username = `${Math.floor(Date.now() / 1000) + 86400}:sozvon`;
      const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
      const urls = [`turn:${TURN_HOST}:3478?transport=udp`, `turn:${TURN_HOST}:3478?transport=tcp`];
      if (TURN_TLS) urls.push(`turns:${TURN_HOST}:5349?transport=tcp`);
      list.push({ urls, username, credential });
    }
  }
  if (STUN_URLS) list.push({ urls: STUN_URLS.split(',').map(s => s.trim()).filter(Boolean) });
  return list;
}

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
function broadcast(room, event, data, exceptId) {
  for (const p of room.peers.values()) if (p.id !== exceptId) sse(p.res, event, data);
}
const cleanRoom = s => String(s || '').trim().slice(0, 64).replace(/[^\p{L}\p{N}_\-.]/gu, '');

function handleEvents(req, res, u) {
  const roomName = cleanRoom(u.searchParams.get('room'));
  const name = String(u.searchParams.get('name') || 'Гость').trim().slice(0, 40) || 'Гость';
  if (!roomName) { res.writeHead(400); return res.end('room required'); }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  let room = rooms.get(roomName);
  if (!room) { room = { peers: new Map(), history: [], timer: null }; rooms.set(roomName, room); }
  clearTimeout(room.timer);
  if (room.peers.size >= MAX_PEERS) { sse(res, 'full', { max: MAX_PEERS }); return res.end(); }

  const peer = {
    id: crypto.randomBytes(6).toString('hex'),
    token: crypto.randomBytes(24).toString('hex'),
    name, state: { mic: true, cam: true, screen: false }, res, roomName,
  };
  broadcast(room, 'join', { id: peer.id, name, state: peer.state });
  sse(res, 'hello', {
    id: peer.id, token: peer.token, room: roomName,
    peers: [...room.peers.values()].map(p => ({ id: p.id, name: p.name, state: p.state })),
    history: room.history, iceServers: iceServers(),
  });
  room.peers.set(peer.id, peer);
  tokens.set(peer.token, peer);

  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(ping);
    room.peers.delete(peer.id);
    tokens.delete(peer.token);
    broadcast(room, 'leave', { id: peer.id });
    if (!room.peers.size) room.timer = setTimeout(() => { if (!room.peers.size) rooms.delete(roomName); }, 10 * 60 * 1000);
  });
}

function handleSend(req, res) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 512 * 1024) req.destroy(); });
  req.on('end', () => {
    let msg; try { msg = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
    const p = tokens.get(msg.token);
    if (!p) { res.writeHead(403); return res.end(); }
    const room = rooms.get(p.roomName);
    if (msg.type === 'signal') {
      const target = room.peers.get(msg.to);
      if (target) sse(target.res, 'signal', { from: p.id, data: msg.data });
    } else if (msg.type === 'chat') {
      const text = String(msg.data?.text || '').slice(0, 4000).trim();
      if (text) {
        const m = { id: p.id, name: p.name, text, ts: Date.now() };
        room.history.push(m); if (room.history.length > 300) room.history.shift();
        broadcast(room, 'chat', m);
      }
    } else if (msg.type === 'state') {
      const d = msg.data || {};
      p.state = { mic: !!d.mic, cam: !!d.cam, screen: !!d.screen, hand: !!d.hand };
      broadcast(room, 'state', { id: p.id, state: p.state }, p.id);
    }
    res.writeHead(204); res.end();
  });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, u) {
  let p = decodeURIComponent(u.pathname);
  if (p === '/' || !path.extname(p)) p = '/index.html';
  const file = path.join(PUB, path.normalize(p));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://local');
  if (req.method === 'GET' && u.pathname === '/events') return handleEvents(req, res, u);
  if (req.method === 'POST' && u.pathname === '/send') return handleSend(req, res);
  if (req.method === 'GET' && u.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  if (req.method === 'GET') return serveStatic(req, res, u);
  res.writeHead(405); res.end();
}).listen(PORT, HOST, () => console.log(`Созвон запущен: http://${HOST}:${PORT}  (TURN: ${TURN_HOST || 'не настроен'})`));

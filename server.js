'use strict';
// Созвон — сервер сигнализации, чата и мини-игр. Без внешних зависимостей (Node.js >= 18).
// Сервер -> клиент: Server-Sent Events (/events). Клиент -> сервер: POST /send (пачкой, с сохранением порядка).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const G = require('./games');

const PUB = fs.existsSync(path.join(__dirname, 'public', 'index.html')) ? path.join(__dirname, 'public') : __dirname;
// Отдаём наружу только фронтенд (никаких .js/.yaml с сервера)
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function iceServers(env) {
  const list = [];
  const host = env.TURN_HOST, secret = env.TURN_SECRET;
  if (host) {
    list.push({ urls: `stun:${host}:3478` });
    if (secret) {
      const username = `${Math.floor(Date.now() / 1000) + 86400}:sozvon`;
      const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
      const urls = [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`];
      // TLS на 443 выглядит для провайдера как обычный HTTPS — так звонок труднее заблокировать
      if (env.TURN_TLS === '1') urls.push(`turns:${host}:${env.TURN_TLS_PORT || 443}?transport=tcp`);
      list.push({ urls, username, credential });
    }
  }
  const stun = env.STUN_URLS ?? 'stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478';
  if (stun) list.push({ urls: stun.split(',').map(s => s.trim()).filter(Boolean) });
  return list;
}

const cleanRoom = s => String(s || '').trim().slice(0, 64).replace(/[^\p{L}\p{N}_\-.]/gu, '');

function createServer(opts = {}) {
  const cfg = {
    maxPeers: +process.env.MAX_PEERS || 8,
    graceMs: 20000,        // сколько ждём переподключения, прежде чем выкинуть из игры
    pingMs: 15000,         // пульс SSE — клиент по нему понимает, что связь жива
    rate: 200, burst: 600, // лимит сообщений от одного участника (в секунду / запас)
    roomTtlMs: 5 * 60 * 1000, // пустая комната живёт 5 минут, потом удаляется целиком
    maxRooms: +process.env.MAX_ROOMS || 2000, // защита от «бесконечного» создания комнат
    sweepMs: 60 * 1000,       // фоновая уборка — страховка на случай, если таймер не сработал
    env: process.env,
    ...opts,
  };
  const rooms = new Map();    // name -> { peers, history, game, gameTimer, timer }
  const tokens = new Map();   // token -> peer
  const departed = new Map(); // id -> { token, roomName, timer } — для восстановления после обрыва
  // Статистика соединений (без IP и имён): как люди соединяются и сколько не может
  const net = { since: new Date().toISOString(), connected: { lan: 0, p2p: 0, relay: 0, unknown: 0 }, failed: 0, resets: 0, gaveUp: 0, noStun: 0, byDevice: {}, recent: [] };

  function sse(res, event, data) {
    if (res.destroyed) return;
    // Клиент не успевает читать (мёртвая сеть) — не копим память, а рвём соединение
    if (res.writableLength > 2 * 1024 * 1024) { res.destroy(); return; }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
  const broadcast = (room, event, data, exceptId) => { for (const p of room.peers.values()) if (p.id !== exceptId) sse(p.res, event, data); };

  function gameBroadcast(room) {
    for (const p of room.peers.values()) sse(p.res, 'game', room.game ? G.view(room.game, p.id) : null);
    scheduleGameTimer(room);
  }
  function scheduleGameTimer(room) {
    clearTimeout(room.gameTimer);
    const dl = room.game ? G.deadline(room.game) : 0;
    if (!dl) return;
    room.gameTimer = setTimeout(() => {
      if (room.game && G.tick(room.game, Date.now())) gameBroadcast(room);
      else scheduleGameTimer(room);
    }, Math.max(0, dl - Date.now()) + 30);
    room.gameTimer.unref?.();
  }
  function gameLeave(room, id) {
    if (!room.game || !G.onLeave(room.game, id)) return;
    if (!room.game.players.length) room.game = null;
    gameBroadcast(room);
  }

  function getRoom(name) {
    let room = rooms.get(name);
    if (!room) {
      if (rooms.size >= cfg.maxRooms) return null;
      room = { name, peers: new Map(), history: [], game: null, gameTimer: null, timer: null, emptySince: 0 };
      rooms.set(name, room);
    }
    clearTimeout(room.timer);
    room.emptySince = 0;
    return room;
  }
  function dropRoom(room) {
    clearTimeout(room.timer); clearTimeout(room.gameTimer);
    room.game = null; room.history = [];
    if (rooms.get(room.name) === room) rooms.delete(room.name);
  }
  function maybeDropRoom(room) {
    if (room.peers.size) return;
    clearTimeout(room.timer);
    room.emptySince = Date.now();
    room.timer = setTimeout(() => { if (!room.peers.size) dropRoom(room); }, cfg.roomTtlMs);
    room.timer.unref?.();
  }
  // Страховочная уборка: всё, что пустует дольше TTL, удаляется (вместе с играми и историей чата)
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) if (!room.peers.size && room.emptySince && now - room.emptySince >= cfg.roomTtlMs) dropRoom(room);
  }, cfg.sweepMs);
  sweeper.unref?.();

  function detach(room, peer) {
    clearInterval(peer.ping);
    room.peers.delete(peer.id);
    tokens.delete(peer.token);
    broadcast(room, 'leave', { id: peer.id });
  }

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
    req.socket.setNoDelay(true);
    req.socket.setKeepAlive(true, 10000);

    const room = getRoom(roomName);
    if (!room) { sse(res, 'busy', {}); return res.end(); }
    let id = crypto.randomBytes(6).toString('hex');
    let token = crypto.randomBytes(24).toString('hex');

    // Переподключение: тот же участник (по секретному токену) получает свой старый id — партия не прерывается
    const rid = u.searchParams.get('rid'), rkey = u.searchParams.get('rkey');
    if (rid && rkey) {
      const dep = departed.get(rid);
      const live = room.peers.get(rid);
      if (dep && dep.token === rkey && dep.roomName === roomName) {
        clearTimeout(dep.timer); departed.delete(rid); id = rid; token = rkey;
      } else if (live && live.token === rkey) {
        live.replaced = true; detach(room, live); live.res.destroy(); id = rid; token = rkey;
      }
    }
    if (room.peers.size >= cfg.maxPeers) { sse(res, 'full', { max: cfg.maxPeers }); return res.end(); }

    const peer = { id, token, name, state: { mic: true, cam: true, screen: false, hand: false }, res, roomName, bucket: cfg.burst, bt: Date.now() };
    broadcast(room, 'join', { id, name, state: peer.state });
    sse(res, 'hello', {
      id, token, room: roomName,
      peers: [...room.peers.values()].map(p => ({ id: p.id, name: p.name, state: p.state })),
      history: room.history, iceServers: iceServers(cfg.env),
      game: room.game ? G.view(room.game, id) : null,
    });
    room.peers.set(id, peer);
    tokens.set(token, peer);
    peer.ping = setInterval(() => sse(res, 'ping', Date.now()), cfg.pingMs);
    peer.ping.unref?.();

    req.on('close', () => {
      if (peer.replaced) return;
      detach(room, peer);
      const timer = setTimeout(() => { departed.delete(id); gameLeave(room, id); }, cfg.graceMs);
      timer.unref?.();
      departed.set(id, { token, roomName, timer });
      maybeDropRoom(room);
    });
  }

  function processMessage(p, room, msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'signal': {
        const target = room.peers.get(msg.to);
        if (target) sse(target.res, 'signal', { from: p.id, data: msg.data });
        break;
      }
      case 'chat': {
        const text = String((msg.data && msg.data.text) || '').slice(0, 4000).trim();
        if (!text) break;
        const m = { id: p.id, name: p.name, text, ts: Date.now() };
        room.history.push(m); if (room.history.length > 300) room.history.shift();
        broadcast(room, 'chat', m);
        break;
      }
      case 'state': {
        const d = msg.data || {};
        p.state = { mic: !!d.mic, cam: !!d.cam, screen: !!d.screen, hand: !!d.hand };
        broadcast(room, 'state', { id: p.id, state: p.state }, p.id);
        break;
      }
      case 'diag': {
        const d = msg.data || {};
        if (!['connected', 'failed', 'reset', 'gave-up'].includes(d.state)) break;
        const route = ['lan', 'p2p', 'relay'].includes(d.route) ? d.route : null;
        const ua = ['ios', 'android', 'desktop'].includes(d.ua) ? d.ua : 'other';
        const c = d.cands || {};
        if (d.state === 'connected') net.connected[route || 'unknown']++;
        else if (d.state === 'failed') net.failed++;
        else if (d.state === 'reset') net.resets++;
        else net.gaveUp++;
        if (d.state !== 'connected' && !(+c.srflx)) net.noStun++;
        const dev = (net.byDevice[ua] ||= { ok: 0, bad: 0 });
        dev[d.state === 'connected' ? 'ok' : 'bad']++;
        const ev = { t: new Date().toISOString().slice(5, 19), state: d.state, route, proto: String(d.proto || '').slice(0, 4), rtt: Number.isFinite(d.rtt) ? d.rtt : null,
          host: +c.host || 0, srflx: +c.srflx || 0, relay: +c.relay || 0, attempts: +d.attempts || 0, ua };
        net.recent.push(ev); if (net.recent.length > 60) net.recent.shift();
        if (d.state !== 'connected') console.log('[net]', JSON.stringify(ev));
        break;
      }
      case 'game': {
        const d = msg.data || {};
        try {
          if (d.op === 'create') {
            if (room.game && room.game.status === 'playing') throw new G.GameError('Уже идёт партия');
            room.game = G.create(d.game, p);
          } else if (!room.game) {
            throw new G.GameError('Игра не найдена');
          } else if (d.op === 'close') {
            if (room.game.status === 'playing' && room.game.host !== p.id) throw new G.GameError('Закончить партию может только тот, кто её создал');
            room.game = null;
          } else {
            G.handle(room.game, p, d.op, d, Date.now(), Math.random, cfg.gameTimeoutMs);
            if (!room.game.players.length) room.game = null;
          }
          gameBroadcast(room);
        } catch (e) {
          if (!(e instanceof G.GameError)) console.error('game error', e);
          sse(p.res, 'game-error', { message: e instanceof G.GameError ? e.message : 'Ошибка игры' });
        }
        break;
      }
    }
  }

  function handleSend(req, res) {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', c => { body += c; if (body.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      let msg; try { msg = JSON.parse(body); } catch { res.writeHead(400); return res.end(); }
      const p = tokens.get(msg && msg.token);
      if (!p) { res.writeHead(403); return res.end(); }
      const list = Array.isArray(msg.batch) ? msg.batch : [msg];
      if (list.length > 200) { res.writeHead(413); return res.end(); }
      // Защита от флуда: «ведро» сообщений
      const t = Date.now();
      p.bucket = Math.min(cfg.burst, p.bucket + (t - p.bt) / 1000 * cfg.rate); p.bt = t;
      if (p.bucket < list.length) { res.writeHead(429, { 'Retry-After': '1' }); return res.end(); }
      p.bucket -= list.length;
      const room = rooms.get(p.roomName);
      for (const m of list) processMessage(p, room, m);
      res.writeHead(204); res.end();
    });
  }

  function serveStatic(req, res, u) {
    let p;
    try { p = decodeURIComponent(u.pathname); } catch { res.writeHead(400); return res.end(); }
    if (p === '/' || !path.extname(p)) p = '/index.html';
    const ext = path.extname(p);
    const file = path.join(PUB, path.normalize(p));
    if (!TYPES[ext] || !file.startsWith(PUB)) { res.writeHead(404); return res.end('not found'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': TYPES[ext], 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://local');
    if (req.method === 'GET' && u.pathname === '/events') return handleEvents(req, res, u);
    if (req.method === 'POST' && u.pathname === '/send') return handleSend(req, res);
    if (req.method === 'GET' && u.pathname === '/health') {
      let peers = 0; for (const r of rooms.values()) peers += r.peers.size;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, rooms: rooms.size, peers, uptime: Math.round(process.uptime()), turn: !!(cfg.env.TURN_HOST && cfg.env.TURN_SECRET), net }));
    }
    if (req.method === 'GET') return serveStatic(req, res, u);
    res.writeHead(405); res.end();
  });
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 0; // SSE-соединения живут долго
  server.rooms = rooms;
  server.on('close', () => {
    clearInterval(sweeper);
    for (const r of rooms.values()) { clearTimeout(r.timer); clearTimeout(r.gameTimer); for (const p of r.peers.values()) clearInterval(p.ping); }
    for (const d of departed.values()) clearTimeout(d.timer);
  });
  return server;
}

module.exports = { createServer };

if (require.main === module) {
  const PORT = +process.env.PORT || 3000, HOST = process.env.HOST || '0.0.0.0';
  createServer().listen(PORT, HOST, () => console.log(`Созвон запущен: http://${HOST}:${PORT}  (TURN: ${process.env.TURN_HOST || 'не настроен'})`));
}

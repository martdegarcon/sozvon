'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createServer } = require('../server');

/* ---------------- Хелперы: настоящий сервер на случайном порту + SSE-клиенты ---------------- */
async function startServer(opts = {}) {
  const srv = createServer({ env: {}, pingMs: 200, ...opts });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  return { srv, port, close: () => new Promise(r => { srv.closeAllConnections(); srv.close(r); }) };
}

function connect(port, room, name, extra = '') {
  return new Promise((resolve, reject) => {
    const c = { events: [], waiters: [], closed: false };
    c.req = http.get({ host: '127.0.0.1', port, path: `/events?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}${extra}`, agent: false }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', d => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          let ev = 'message', data = '';
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event: ')) ev = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (!data) continue;
          const e = { ev, data: JSON.parse(data), t: performance.now(), used: false };
          c.events.push(e);
          if (ev === 'hello') { c.id = e.data.id; c.token = e.data.token; resolve(c); }
          if (ev === 'full') resolve(c);
          for (const w of [...c.waiters]) if (!e.used && w.pred(e)) { e.used = true; c.waiters.splice(c.waiters.indexOf(w), 1); w.resolve(e); }
        }
      });
      res.on('close', () => { c.closed = true; });
    });
    c.req.on('error', reject);
  });
}
// Ждём событие (уже пришедшее или будущее), каждое событие выдаётся один раз
function wait(c, ev, filter = () => true, ms = 3000) {
  const pred = e => e.ev === ev && filter(e.data);
  const got = c.events.find(e => !e.used && pred(e));
  if (got) { got.used = true; return Promise.resolve(got); }
  return new Promise((resolve, reject) => {
    const w = { pred, resolve };
    c.waiters.push(w);
    setTimeout(() => { const k = c.waiters.indexOf(w); if (k >= 0) { c.waiters.splice(k, 1); reject(new Error(`не дождались события «${ev}» за ${ms} мс`)); } }, ms);
  });
}
async function send(port, c, batch) {
  const r = await fetch(`http://127.0.0.1:${port}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: c.token, batch }) });
  return r.status;
}
const game = (port, c, data) => send(port, c, [{ type: 'game', data }]);
const lastGame = c => [...c.events].reverse().find(e => e.ev === 'game');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- Тесты ---------------- */
test('статика: отдаётся только фронтенд, исходники сервера закрыты', async () => {
  const s = await startServer();
  try {
    const ok = await fetch(`http://127.0.0.1:${s.port}/`);
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /Созвон/);
    for (const p of ['/server.js', '/games.js', '/package.json', '/../server.js', '/%2e%2e/server.js']) {
      assert.equal((await fetch(`http://127.0.0.1:${s.port}${p}`)).status, 404, p);
    }
  } finally { await s.close(); }
});

test('вход в комнату, join/leave, лимит участников', async () => {
  const s = await startServer({ maxPeers: 2 });
  try {
    const a = await connect(s.port, 'r1', 'Аня');
    const b = await connect(s.port, 'r1', 'Борис');
    assert.equal((await wait(a, 'join')).data.name, 'Борис');
    assert.deepEqual(b.events[0].data.peers.map(p => p.name), ['Аня']);
    const c = await connect(s.port, 'r1', 'Лишний');
    assert.ok(c.events.some(e => e.ev === 'full'));
    b.req.destroy();
    assert.equal((await wait(a, 'leave')).data.id, b.id);
  } finally { await s.close(); }
});

test('сигналы доходят строго по порядку (2000 сообщений пачками)', async () => {
  const s = await startServer({ rate: 1e6, burst: 1e6 });
  try {
    const a = await connect(s.port, 'order', 'A');
    const b = await connect(s.port, 'order', 'B');
    for (let k = 0; k < 2000; k += 50) {
      await send(s.port, a, Array.from({ length: 50 }, (_, j) => ({ type: 'signal', to: b.id, data: { n: k + j } })));
    }
    await wait(b, 'signal', d => d.data.n === 1999);
    const ns = b.events.filter(e => e.ev === 'signal').map(e => e.data.data.n);
    assert.deepEqual(ns, Array.from({ length: 2000 }, (_, i) => i));
  } finally { await s.close(); }
});

test('чат и история для опоздавших', async () => {
  const s = await startServer();
  try {
    const a = await connect(s.port, 'chat', 'Аня');
    await send(s.port, a, [{ type: 'chat', data: { text: 'привет' } }, { type: 'chat', data: { text: '   ' } }]);
    await wait(a, 'chat');
    const b = await connect(s.port, 'chat', 'Борис');
    assert.deepEqual(b.events[0].data.history.map(m => m.text), ['привет']);
  } finally { await s.close(); }
});

test('чужой/поддельный токен не принимается', async () => {
  const s = await startServer();
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/send`, { method: 'POST', body: JSON.stringify({ token: 'xxx', type: 'chat', data: { text: 'hack' } }) });
    assert.equal(r.status, 403);
    const bad = await fetch(`http://127.0.0.1:${s.port}/send`, { method: 'POST', body: '{не json' });
    assert.equal(bad.status, 400);
  } finally { await s.close(); }
});

test('флуд режется (429), а сервер продолжает отвечать', async () => {
  const s = await startServer({ rate: 100, burst: 300 });
  try {
    const a = await connect(s.port, 'flood', 'A');
    const statuses = await Promise.all(Array.from({ length: 20 }, () => send(s.port, a, Array.from({ length: 100 }, () => ({ type: 'state', data: {} })))));
    assert.ok(statuses.includes(429), 'лимит сработал');
    assert.ok(statuses.includes(204));
    const b = await connect(s.port, 'flood', 'B');
    assert.ok(b.id, 'новые подключения работают');
  } finally { await s.close(); }
});

test('Дурак по сети: каждый видит только свои карты, ходы проходят, партия доигрывается', async () => {
  const s = await startServer();
  try {
    const a = await connect(s.port, 'durak', 'Аня');
    const b = await connect(s.port, 'durak', 'Борис');
    const c = await connect(s.port, 'durak', 'Зритель');
    await game(s.port, a, { op: 'create', game: 'durak' });
    await wait(b, 'game', g => g && g.status === 'lobby');
    await game(s.port, b, { op: 'join' });
    await wait(a, 'game', g => g && g.players.length === 2);
    await game(s.port, b, { op: 'start' });
    assert.match((await wait(b, 'game-error')).data.message, /только тот/);
    await game(s.port, a, { op: 'start' });
    const ga = (await wait(a, 'game', g => g && g.status === 'playing')).data.state;
    const gb = (await wait(b, 'game', g => g && g.status === 'playing')).data.state;
    const gc = (await wait(c, 'game', g => g && g.status === 'playing')).data.state;
    assert.equal(ga.hand.length, 6);
    assert.equal(gc.hand, null, 'зритель не видит карт');
    for (const card of gb.hand) assert.ok(!JSON.stringify(ga).includes(`"${card}"`) || ga.table.some(t => t.a === card) || ga.trumpCard === card, 'карты Бориса не видны Ане');

    // Доигрываем партию: каждый ходит по своему списку разрешённых ходов
    const clients = [a, b];
    for (let step = 0; step < 600; step++) {
      const views = clients.map(cl => lastGame(cl).data);
      if (views[0].status !== 'playing') break;
      let moved = false;
      for (const [k, cl] of clients.entries()) {
        const L = views[k].state.legal;
        if (!L) continue;
        let m = null;
        const def = Object.entries(L.defend)[0];
        if (def) m = { t: 'defend', card: def[0], idx: def[1][0] };
        else if (L.attack.length && !L.pass) m = { t: 'attack', card: L.attack[0] };
        else if (L.pass) m = { t: 'pass' };
        else if (L.take) m = { t: 'take' };
        if (!m) continue;
        const before = clients.map(x => x.events.length);
        await game(s.port, cl, { op: 'move', move: m });
        const got = () => clients.every((x, j) => x.events.slice(before[j]).some(e => e.ev === 'game' || e.ev === 'game-error'));
        const t = Date.now();
        while (!got() && Date.now() - t < 2000) await sleep(2);
        assert.ok(got(), 'ход дошёл до всех');
        assert.ok(!cl.events.slice(before[k]).some(e => e.ev === 'game-error'), 'ход принят');
        moved = true; break;
      }
      assert.ok(moved, 'кто-то всегда может сходить');
    }
    const end = lastGame(a).data;
    assert.equal(end.status, 'over');
    assert.ok(end.state.over);
  } finally { await s.close(); }
});

test('обрыв связи: переподключение в течение паузы сохраняет место в партии', async () => {
  const s = await startServer({ graceMs: 1500 });
  try {
    const a = await connect(s.port, 'resume', 'Аня');
    const b = await connect(s.port, 'resume', 'Борис');
    await game(s.port, a, { op: 'create', game: 'ttt' });
    await game(s.port, b, { op: 'join' });
    await game(s.port, a, { op: 'start' });
    await wait(a, 'game', g => g && g.status === 'playing');
    const oldId = b.id, oldToken = b.token;
    b.req.destroy();
    await wait(a, 'leave');
    await sleep(300);
    const b2 = await connect(s.port, 'resume', 'Борис', `&rid=${oldId}&rkey=${oldToken}`);
    assert.equal(b2.id, oldId, 'тот же участник');
    const g = b2.events[0].data.game;
    assert.equal(g.status, 'playing', 'партия продолжается');
    assert.ok(g.state.legal, 'ходы снова доступны');
    // Чужой не может «украсть» место без токена
    const thief = await connect(s.port, 'resume', 'Вор', `&rid=${oldId}&rkey=bad`);
    assert.notEqual(thief.id, oldId);
  } finally { await s.close(); }
});

test('обрыв связи: если не вернулся за паузу — партия завершается, а не висит', async () => {
  const s = await startServer({ graceMs: 300 });
  try {
    const a = await connect(s.port, 'gone', 'Аня');
    const b = await connect(s.port, 'gone', 'Борис');
    await game(s.port, a, { op: 'create', game: 'durak' });
    await game(s.port, b, { op: 'join' });
    await game(s.port, a, { op: 'start' });
    await wait(a, 'game', g => g && g.status === 'playing');
    b.req.destroy();
    const g = (await wait(a, 'game', g => g && g.status === 'over')).data;
    assert.equal(g.aborted, 'Борис');
  } finally { await s.close(); }
});

test('таймер хода на сервере: молчащий игрок не вешает партию', async () => {
  const s = await startServer({ gameTimeoutMs: 300 });
  try {
    const a = await connect(s.port, 'timer', 'Аня');
    const b = await connect(s.port, 'timer', 'Борис');
    await game(s.port, a, { op: 'create', game: 'ttt' });
    await game(s.port, b, { op: 'join' });
    await game(s.port, a, { op: 'start' });
    const st = (await wait(a, 'game', g => g && g.status === 'playing')).data.state;
    // ход длится 300 мс (в бою — 45–60 с); никто не ходит
    const end = (await wait(a, 'game', g => g && g.status === 'over', 3000)).data.state;
    assert.ok(end.forfeit);
    assert.notEqual(end.winner, st.turn);
  } finally { await s.close(); }
});

test('нагрузка: 8 участников, 4000 сигналов — всё доставлено быстро', async () => {
  const s = await startServer({ rate: 1e6, burst: 1e6 });
  try {
    const N = 8, PER = 500;
    const cs = [];
    for (let i = 0; i < N; i++) cs.push(await connect(s.port, 'load', 'P' + i));
    const t0 = performance.now();
    await Promise.all(cs.map(async (c, i) => {
      for (let k = 0; k < PER; k += 25) {
        await send(s.port, c, Array.from({ length: 25 }, (_, j) => ({ type: 'signal', to: cs[(i + 1 + ((k + j) % (N - 1))) % N].id, data: { t: performance.now() } })));
      }
    }));
    const deadline = Date.now() + 5000;
    const total = () => cs.reduce((n, c) => n + c.events.filter(e => e.ev === 'signal').length, 0);
    while (total() < N * PER && Date.now() < deadline) await sleep(20);
    const elapsed = performance.now() - t0;
    assert.equal(total(), N * PER, 'все сигналы доставлены');
    const lat = cs.flatMap(c => c.events.filter(e => e.ev === 'signal').map(e => e.t - e.data.data.t)).sort((x, y) => x - y);
    const p95 = lat[Math.floor(lat.length * 0.95)];
    console.log(`  нагрузка: ${N * PER} сообщений за ${elapsed.toFixed(0)} мс, p95 задержка ${p95.toFixed(1)} мс`);
    assert.ok(p95 < 250, `p95 задержка ${p95.toFixed(1)} мс`);
  } finally { await s.close(); }
});

test('пустая комната удаляется, память не течёт', async () => {
  const s = await startServer({ roomTtlMs: 100, graceMs: 50 });
  try {
    for (let i = 0; i < 30; i++) { const c = await connect(s.port, 'tmp' + i, 'X'); c.req.destroy(); }
    await sleep(400);
    assert.equal(s.srv.rooms.size, 0);
  } finally { await s.close(); }
});

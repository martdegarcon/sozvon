'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../games');
const { Durak, TicTacToe, beats, fullDeck, rank } = G;

// Детерминированный генератор случайных чисел для воспроизводимых тестов
function rng(seed = 1) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const P = n => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'Игрок' + i }));
const allCards = s => [...s.players.flatMap(p => p.hand), ...s.deck, ...s.discard, ...s.table.flatMap(t => t.d ? [t.a, t.d] : [t.a])];

/* ---------------- Дурак: базовые правила ---------------- */
test('колода: 36 уникальных карт', () => {
  const d = fullDeck();
  assert.equal(d.length, 36);
  assert.equal(new Set(d).size, 36);
});

test('кто чем бьётся', () => {
  assert.ok(beats('H10', 'H9', 'S'));          // старшая той же масти
  assert.ok(!beats('H9', 'H10', 'S'));         // младшая — нет
  assert.ok(!beats('D14', 'H6', 'S'));         // другая масть, не козырь — нет
  assert.ok(beats('S6', 'H14', 'S'));          // любой козырь бьёт некозырную
  assert.ok(!beats('S6', 'S7', 'S'));          // козырь младше козыря — нет
  assert.ok(beats('S14', 'S13', 'S'));
});

test('раздача: по 6 карт, козырь = последняя карта колоды, все 36 на месте', () => {
  for (let n = 2; n <= 6; n++) {
    const s = Durak.init(P(n), { rng: rng(n) });
    s.players.forEach(p => assert.equal(p.hand.length, 6));
    assert.equal(s.deck.length, 36 - 6 * n);
    assert.equal(s.trump, s.trumpCard[0]);
    assert.equal(new Set(allCards(s)).size, 36);
    assert.notEqual(s.attacker, s.defender);
  }
});

test('первым ходит обладатель младшего козыря', () => {
  for (let seed = 1; seed < 50; seed++) {
    const s = Durak.init(P(4), { rng: rng(seed) });
    const lows = s.players.map(p => Math.min(99, ...p.hand.filter(c => c[0] === s.trump).map(rank)));
    const min = Math.min(...lows);
    if (min < 99) assert.equal(s.attacker, lows.indexOf(min));
  }
});

function fixed(hands, { trump = 'S', deck = [], attacker = 0 } = {}) {
  const s = Durak.init(P(hands.length), { rng: rng(7) });
  s.players.forEach((p, i) => { p.hand = [...hands[i]]; });
  s.deck = [...deck]; s.discard = []; s.trump = trump; s.trumpCard = trump + '6';
  s.attacker = attacker; s.defender = (attacker + 1) % hands.length;
  s.limit = Math.min(6, s.players[s.defender].hand.length);
  return s;
}

test('атака: на пустой стол ходит только главный атакующий, защитник не атакует', () => {
  const s = fixed([['H6', 'H7'], ['D6', 'D7'], ['C6', 'C7']]);
  assert.throws(() => Durak.move(s, 'p2', { t: 'attack', card: 'C6' }), G.GameError);
  assert.throws(() => Durak.move(s, 'p1', { t: 'attack', card: 'D6' }), G.GameError);
  Durak.move(s, 'p0', { t: 'attack', card: 'H6' });
  assert.deepEqual(s.table, [{ a: 'H6', d: null }]);
});

test('подкидывать можно только карты тех достоинств, что на столе', () => {
  const s = fixed([['H6', 'H7'], ['D9', 'D10', 'S14'], ['C6', 'C8']]);
  Durak.move(s, 'p0', { t: 'attack', card: 'H6' });
  assert.throws(() => Durak.move(s, 'p2', { t: 'attack', card: 'C8' }), /нельзя/);
  Durak.move(s, 'p2', { t: 'attack', card: 'C6' });
  assert.equal(s.table.length, 2);
});

test('нельзя подкинуть больше, чем карт у защитника', () => {
  const s = fixed([['H6', 'D6', 'C6', 'S6'], ['H14', 'D14']], { trump: 'S' });
  Durak.move(s, 'p0', { t: 'attack', card: 'H6' });
  Durak.move(s, 'p0', { t: 'attack', card: 'D6' });
  assert.throws(() => Durak.move(s, 'p0', { t: 'attack', card: 'C6' }), /Больше подкидывать нельзя/);
});

test('защита: бить можно только подходящей картой и в нужное место', () => {
  const s = fixed([['H9', 'C6'], ['H8', 'H14', 'S6']], { trump: 'S' });
  Durak.move(s, 'p0', { t: 'attack', card: 'H9' });
  assert.throws(() => Durak.move(s, 'p1', { t: 'defend', card: 'H8', idx: 0 }), /не побить/);
  assert.throws(() => Durak.move(s, 'p1', { t: 'defend', card: 'H14', idx: 5 }), /не побить/);
  Durak.move(s, 'p1', { t: 'defend', card: 'S6', idx: 0 });
  assert.equal(s.table[0].d, 'S6');
});

test('бито: карты уходят в отбой, защитник становится атакующим, добор до 6 (атакующий первым)', () => {
  const deck = ['C11', 'C12', 'C13', 'C14', 'D11', 'D12', 'D13', 'D14', 'H11', 'H12'];
  const s = fixed([['H9', 'C6', 'C7', 'C8', 'C9', 'C10'], ['H10', 'D6', 'D7', 'D8', 'D9', 'D10']], { trump: 'S', deck });
  Durak.move(s, 'p0', { t: 'attack', card: 'H9' });
  Durak.move(s, 'p1', { t: 'defend', card: 'H10', idx: 0 });
  // у p0 нет карт достоинства 9/10 кроме C9,C10 — он может подкинуть, значит кон не закрылся
  assert.equal(s.table.length, 1);
  Durak.move(s, 'p0', { t: 'pass' });
  assert.equal(s.table.length, 0);
  assert.deepEqual(s.discard.sort(), ['H10', 'H9']);
  assert.equal(s.players[0].hand.length, 6);
  assert.equal(s.players[1].hand.length, 6);
  assert.ok(s.players[0].hand.includes('H12'), 'атакующий добирает первым — с верха колоды');
  assert.equal(s.attacker, 1);
  assert.equal(s.defender, 0);
});

test('взял: защитник забирает всё, подкидывать вдогонку можно, ходит следующий после защитника', () => {
  const s = fixed([['H9', 'D9'], ['C6', 'C7', 'C8'], ['S9', 'C10']], { trump: 'S' });
  Durak.move(s, 'p0', { t: 'attack', card: 'H9' });
  Durak.move(s, 'p1', { t: 'take' });
  Durak.move(s, 'p2', { t: 'attack', card: 'S9' });    // подкинул вдогонку
  assert.equal(s.table.length, 2);
  Durak.move(s, 'p2', { t: 'pass' });
  Durak.move(s, 'p0', { t: 'pass' });
  assert.equal(s.table.length, 0);
  assert.ok(s.players[1].hand.includes('H9') && s.players[1].hand.includes('S9'));
  assert.equal(s.attacker, 2);
});

test('кон закрывается сам, если подкинуть больше никто не может', () => {
  const s = fixed([['H9', 'C6'], ['H10', 'D7']], { trump: 'S', deck: ['D8', 'D9'] });
  Durak.move(s, 'p0', { t: 'attack', card: 'H9' });
  Durak.move(s, 'p1', { t: 'defend', card: 'H10', idx: 0 });
  assert.equal(s.table.length, 0, 'без лишних нажатий «Бито»');
});

test('конец игры: кто остался с картами — дурак; одновременный выход — ничья', () => {
  const s = fixed([['H9'], ['H10', 'D7']], { trump: 'S' });
  Durak.move(s, 'p0', { t: 'attack', card: 'H9' });
  Durak.move(s, 'p1', { t: 'defend', card: 'H10', idx: 0 });
  assert.ok(s.over);
  assert.equal(s.loser, 'p1');
  assert.deepEqual(s.winners, ['p0']);

  const d = fixed([['H9'], ['H10']], { trump: 'S' });
  Durak.move(d, 'p0', { t: 'attack', card: 'H9' });
  Durak.move(d, 'p1', { t: 'defend', card: 'H10', idx: 0 });
  assert.ok(d.over);
  assert.equal(d.loser, null);
});

test('таймаут: защитник берёт, молчащий атакующий ходит сам — партия не зависает', () => {
  const s = fixed([['H9', 'S14', 'C7'], ['D6', 'D7', 'D8']], { trump: 'S' });
  const t0 = Date.now();
  assert.equal(Durak.tick(s, t0), false, 'до дедлайна ничего не происходит');
  assert.ok(Durak.tick(s, s.deadline + 1));
  assert.equal(s.table.length, 1);
  assert.equal(s.table[0].a, 'C7', 'автоход младшей некозырной картой');
  assert.ok(Durak.tick(s, s.deadline + 1));
  assert.equal(s.table.length, 0);
  assert.equal(s.players[1].hand.length, 4, 'защитник взял');
});

test('view: чужие карты не видны, свои отсортированы, козыри в конце', () => {
  const s = Durak.init(P(3), { rng: rng(3) });
  const v = Durak.view(s, 'p0');
  const json = JSON.stringify(v);
  for (const c of s.players[1].hand.concat(s.players[2].hand, s.deck.slice(1))) {
    assert.ok(!json.includes(`"${c}"`), `чужая карта ${c} утекла`);
  }
  assert.equal(v.hand.length, 6);
  const tr = v.hand.map(c => c[0] === s.trump);
  assert.deepEqual(tr, [...tr].sort((a, b) => a - b), 'козыри в конце руки');
  assert.equal(Durak.view(s, 'зритель').hand, null);
  assert.equal(Durak.view(s, 'зритель').legal, null);
});

/* ---------------- Фаззинг: тысячи случайных партий ---------------- */
function randomGame(n, seed, { timeouts = false } = {}) {
  const r = rng(seed);
  let now = 1e12;
  const s = Durak.init(P(n), { rng: r, now });
  for (let step = 0; step < 5000; step++) {
    if (s.over) return { s, step };
    // инварианты на каждом шаге
    const cards = allCards(s);
    assert.equal(cards.length, 36, 'карты не теряются и не дублируются');
    assert.equal(new Set(cards).size, 36);
    assert.notEqual(s.attacker, s.defender);
    assert.ok(!s.players[s.attacker].out && !s.players[s.defender].out);
    assert.ok(s.table.length <= s.limit && s.limit <= 6);

    if (timeouts && r() < 0.05) { now = s.deadline + 1; Durak.tick(s, now); continue; }
    const moves = [];
    for (const p of s.players) {
      const L = Durak.legal(s, p.id);
      if (!L) continue;
      L.attack.forEach(card => moves.push([p.id, { t: 'attack', card }]));
      Object.entries(L.defend).forEach(([card, idxs]) => idxs.forEach(idx => moves.push([p.id, { t: 'defend', card, idx }])));
      if (L.take && r() < 0.3) moves.push([p.id, { t: 'take' }]);
      if (L.pass) moves.push([p.id, { t: 'pass' }], [p.id, { t: 'pass' }]);
    }
    if (!moves.length) { // ждать некого — может только таймаут (защитник без вариантов)
      const def = s.players[s.defender];
      const L = Durak.legal(s, def.id);
      assert.ok(L && L.take, `тупик без выхода на шаге ${step}`);
      Durak.move(s, def.id, { t: 'take' }, ++now);
      continue;
    }
    const [pid, m] = moves[Math.floor(r() * moves.length)];
    Durak.move(s, pid, m, ++now);
  }
  assert.fail(`партия ${n} игроков (seed ${seed}) не закончилась за 5000 ходов`);
}

test('фаззинг: 3000 случайных партий 2–6 игроков без потерь карт и зависаний', () => {
  let steps = 0, draws = 0;
  for (let seed = 1; seed <= 3000; seed++) {
    const n = 2 + (seed % 5);
    const { s, step } = randomGame(n, seed, { timeouts: seed % 3 === 0 });
    steps += step;
    const active = s.players.filter(p => !p.out);
    assert.ok(active.length <= 1);
    if (s.loser) assert.equal(active[0].id, s.loser); else draws++;
    assert.equal(s.winners.length + (s.loser ? 1 : 0), n);
  }
  assert.ok(steps > 0);
});

test('скорость: ход обрабатывается за доли миллисекунды', () => {
  const t = performance.now();
  let moves = 0;
  for (let seed = 1; seed <= 300; seed++) moves += randomGame(4, seed).step;
  const per = (performance.now() - t) / moves;
  assert.ok(per < 0.5, `слишком медленно: ${per.toFixed(3)} мс/ход`);
});

/* ---------------- Крестики-нолики ---------------- */
test('крестики-нолики: победа, ничья, очерёдность, занятая клетка', () => {
  const s = TicTacToe.init(P(2), { rng: () => 0 });
  const [x, o] = s.players.map(p => p.id);
  assert.throws(() => TicTacToe.move(s, o, { t: 'place', i: 0 }), /соперника/);
  TicTacToe.move(s, x, { t: 'place', i: 0 });
  assert.throws(() => TicTacToe.move(s, o, { t: 'place', i: 0 }), /занята/);
  TicTacToe.move(s, o, { t: 'place', i: 3 });
  TicTacToe.move(s, x, { t: 'place', i: 1 });
  TicTacToe.move(s, o, { t: 'place', i: 4 });
  TicTacToe.move(s, x, { t: 'place', i: 2 });
  assert.ok(s.over); assert.equal(s.winner, x); assert.deepEqual(s.line, [0, 1, 2]);

  const d = TicTacToe.init(P(2), { rng: () => 0 });
  const ids = d.players.map(p => p.id);
  [0, 1, 2, 4, 3, 5, 7, 6, 8].forEach((i, k) => TicTacToe.move(d, ids[k % 2], { t: 'place', i }));
  assert.ok(d.over); assert.ok(d.draw); assert.equal(d.winner, null);
});

test('крестики-нолики: таймаут = поражение того, чей ход', () => {
  const s = TicTacToe.init(P(2), { rng: () => 0 });
  assert.ok(TicTacToe.tick(s, s.deadline + 1));
  assert.ok(s.over && s.forfeit);
  assert.equal(s.winner, s.players[1].id);
});

/* ---------------- Лобби ---------------- */
test('лобби: создать, войти, лимит мест, старт только хозяином, выход посреди партии', () => {
  const [a, b, c] = P(3);
  const g = G.create('ttt', a);
  assert.throws(() => G.handle(g, a, 'start'), /минимум 2/);
  G.handle(g, b, 'join');
  assert.throws(() => G.handle(g, c, 'join'), /Мест нет/);
  assert.throws(() => G.handle(g, b, 'start'), /только тот/);
  G.handle(g, a, 'start', {}, 1000, () => 0);
  assert.equal(g.status, 'playing');
  assert.throws(() => G.handle(g, a, 'leave'), /посреди/);
  assert.ok(G.onLeave(g, b.id));
  assert.equal(g.status, 'over');
  assert.equal(g.aborted, b.name);
  assert.throws(() => G.create('шахматы', a), /Неизвестная/);
});

/* ---------------- Шпион ---------------- */
const { Spy, SPY_LOCATIONS } = G;
const spyOf = s => s.players.find(p => p.spy);
const civ = s => s.players.filter(p => !p.spy);

test('шпион: ровно один шпион, остальные знают одну локацию и разные роли', () => {
  for (let n = 3; n <= 8; n++) for (let seed = 1; seed < 30; seed++) {
    const s = Spy.init(P(n), { rng: rng(seed * 10 + n) });
    assert.equal(s.players.filter(p => p.spy).length, 1);
    assert.ok(SPY_LOCATIONS[s.location]);
    for (const p of civ(s)) assert.ok(SPY_LOCATIONS[s.location].includes(p.role));
    if (n <= 6) assert.equal(new Set(civ(s).map(p => p.role)).size, n - 1, 'роли не повторяются, пока хватает');
  }
  assert.ok(Object.keys(SPY_LOCATIONS).length >= 25);
});

test('шпион: шпион не видит локацию, остальные не знают, кто шпион', () => {
  const s = Spy.init(P(5), { rng: rng(5) });
  const sv = Spy.view(s, spyOf(s).id);
  assert.deepEqual(sv.me, { spy: true });
  assert.equal(sv.location, null);
  assert.ok(!JSON.stringify(sv).includes(`"${s.location}",`) || sv.locations.includes(s.location), 'локация видна шпиону только в общем списке');
  assert.ok(!JSON.stringify({ ...sv, locations: [] }).includes(s.location), 'локация шпиону не утекла');
  const cv = Spy.view(s, civ(s)[0].id);
  assert.equal(cv.me.location, s.location);
  assert.ok(cv.players.every(p => !('spy' in p)), 'кто шпион — не видно');
  const watcher = Spy.view(s, 'зритель');
  assert.equal(watcher.me, null);
  assert.ok(!JSON.stringify({ ...watcher, locations: [] }).includes(s.location));
});

test('шпион: угадал локацию — победа шпиона, ошибся — победа мирных; мирный угадывать не может', () => {
  const s = Spy.init(P(4), { rng: rng(1) });
  assert.throws(() => Spy.move(s, civ(s)[0].id, { t: 'guess', location: s.location }), /только шпион/);
  Spy.move(s, spyOf(s).id, { t: 'guess', location: s.location });
  assert.ok(s.over); assert.equal(s.winner, 'spy');

  const w = Spy.init(P(4), { rng: rng(2) });
  const wrong = Object.keys(SPY_LOCATIONS).find(l => l !== w.location);
  Spy.move(w, spyOf(w).id, { t: 'guess', location: wrong });
  assert.equal(w.winner, 'civil');
  const v = Spy.view(w, civ(w)[0].id);
  assert.equal(v.location, w.location, 'в конце всё раскрывается');
  assert.ok(v.players.some(p => p.spy));
});

test('шпион: единогласное обвинение шпиона — победа мирных', () => {
  const s = Spy.init(P(4), { rng: rng(3) });
  const [a, b, c] = civ(s), spy = spyOf(s);
  Spy.move(s, a.id, { t: 'accuse', target: spy.id });
  assert.ok(s.accusation);
  assert.throws(() => Spy.move(s, spy.id, { t: 'vote', yes: false }), /не нужно/, 'обвиняемый не голосует');
  Spy.move(s, b.id, { t: 'vote', yes: true });
  assert.ok(!s.over);
  Spy.move(s, c.id, { t: 'vote', yes: true });
  assert.ok(s.over); assert.equal(s.winner, 'civil');
});

test('шпион: обвинили мирного — побеждает шпион; одно «нет» — обвинение отменяется', () => {
  const s = Spy.init(P(4), { rng: rng(4) });
  const [a, b, c] = civ(s);
  Spy.move(s, a.id, { t: 'accuse', target: b.id });
  Spy.move(s, c.id, { t: 'vote', yes: false });
  assert.equal(s.accusation, null, 'не прошло');
  assert.ok(!s.over);
  assert.throws(() => Spy.move(s, a.id, { t: 'accuse', target: c.id }), /уже обвиняли/, 'одно обвинение на игру');
  Spy.move(s, c.id, { t: 'accuse', target: b.id });
  for (const p of s.players) if (p.id !== b.id && p.id !== c.id) Spy.move(s, p.id, { t: 'vote', yes: true });
  assert.ok(s.over); assert.equal(s.winner, 'spy');
});

test('шпион: не проголосовал за 30 с — считается «против», игра не висит', () => {
  const s = Spy.init(P(3), { rng: rng(6), now: 0, timeout: 30000 });
  const [a, b] = civ(s);
  Spy.move(s, a.id, { t: 'accuse', target: b.id }, 1000);
  assert.equal(s.deadline, 31000);
  assert.ok(Spy.tick(s, 31001));
  assert.equal(s.accusation, null);
  assert.ok(!s.over);
});

test('шпион: время раунда вышло → общее голосование → большинство решает, ничья в пользу шпиона', () => {
  const s = Spy.init(P(4), { rng: rng(7), now: 0, roundMs: 1000 });
  assert.ok(Spy.tick(s, 1001));
  assert.equal(s.phase, 'final');
  const spy = spyOf(s), [a, b, c] = civ(s);
  Spy.move(s, a.id, { t: 'final', target: spy.id }, 1100);
  Spy.move(s, b.id, { t: 'final', target: spy.id }, 1100);
  Spy.move(s, c.id, { t: 'final', target: a.id }, 1100);
  assert.throws(() => Spy.move(s, a.id, { t: 'final', target: b.id }), /нельзя/);
  Spy.move(s, spy.id, { t: 'final', target: a.id }, 1100);
  assert.ok(s.over);
  assert.equal(s.winner, 'spy', '2:2 — ничья, шпион ускользнул');

  const t = Spy.init(P(4), { rng: rng(7), now: 0, roundMs: 1000 });
  Spy.tick(t, 1001);
  const ts = spyOf(t);
  civ(t).forEach(p => Spy.move(t, p.id, { t: 'final', target: ts.id }, 1100));
  assert.ok(!t.over, 'ждём голос шпиона или таймер');
  assert.ok(Spy.tick(t, t.finalEnds + 1));
  assert.equal(t.winner, 'civil');
});

test('шпион: фаззинг 2000 случайных партий — всегда заканчиваются, победитель определён', () => {
  const locs = Object.keys(SPY_LOCATIONS);
  for (let seed = 1; seed <= 2000; seed++) {
    const r = rng(seed), n = 3 + (seed % 6);
    let now = 0;
    const s = Spy.init(P(n), { rng: r, now, roundMs: 5000, timeout: 1000 });
    for (let step = 0; step < 500 && !s.over; step++) {
      const moves = [];
      for (const p of s.players) {
        const L = Spy.legal(s, p.id); if (!L) continue;
        if (r() < 0.05) L.accuse.forEach(t => moves.push([p.id, { t: 'accuse', target: t }]));
        if (L.vote) moves.push([p.id, { t: 'vote', yes: r() < 0.7 }]);
        if (L.guess && r() < 0.02) moves.push([p.id, { t: 'guess', location: locs[Math.floor(r() * locs.length)] }]);
        L.final.forEach(t => moves.push([p.id, { t: 'final', target: t }]));
      }
      now += Math.floor(r() * 400);
      if (!moves.length || r() < 0.3) { Spy.tick(s, now); continue; }
      const [pid, m] = moves[Math.floor(r() * moves.length)];
      Spy.move(s, pid, m, now);
    }
    if (!s.over) { Spy.tick(s, 1e12); Spy.tick(s, 2e12); Spy.tick(s, 3e12); }
    assert.ok(s.over, `партия seed=${seed} не закончилась`);
    assert.ok(s.winner === 'spy' || s.winner === 'civil');
    assert.ok(s.reason);
  }
});

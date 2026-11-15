'use strict';
// Мини-игры для созвона. Вся логика — на сервере: клиент видит только свои карты
// и список разрешённых ему ходов (legal), поэтому сжульничать нельзя.

class GameError extends Error {}
const fail = msg => { throw new GameError(msg); };

function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/* ============================== ДУРАК (подкидной) ============================== */
// Карта — строка: масть (S♠ C♣ D♦ H♥) + достоинство 6..14 (11 В, 12 Д, 13 К, 14 Т). Пример: 'H14' — туз червей.
const SUITS = ['S', 'C', 'D', 'H'];
const RANKS = [6, 7, 8, 9, 10, 11, 12, 13, 14];
const suit = c => c[0];
const rank = c => +c.slice(1);
const fullDeck = () => SUITS.flatMap(s => RANKS.map(r => s + r));
const beats = (d, a, trump) => suit(d) === suit(a) ? rank(d) > rank(a) : suit(d) === trump && suit(a) !== trump;

const Durak = {
  title: 'Дурак', min: 2, max: 6,

  init(players, { rng = Math.random, now = Date.now(), timeout = 45000 } = {}) {
    if (players.length < 2 || players.length > 6) fail('Нужно от 2 до 6 игроков');
    const deck = shuffle(fullDeck(), rng);              // берём с конца массива, козырь — deck[0] (последняя карта)
    const trumpCard = deck[0], trump = suit(trumpCard);
    const ps = players.map(p => ({ id: p.id, name: p.name, hand: [], out: false }));
    for (let k = 0; k < 6; k++) for (const p of ps) p.hand.push(deck.pop());
    let attacker = 0, low = 99;                          // первым ходит тот, у кого младший козырь
    ps.forEach((p, i) => p.hand.forEach(c => { if (suit(c) === trump && rank(c) < low) { low = rank(c); attacker = i; } }));
    const s = {
      players: ps, deck, trump, trumpCard, table: [], discard: [],
      attacker, defender: 0, limit: 6, taking: false, passed: [],
      over: false, winners: [], loser: null, round: 1, timeout, deadline: now + timeout, log: [],
    };
    s.defender = nextActive(s, attacker);
    s.limit = Math.min(6, ps[s.defender].hand.length);
    return s;
  },

  // Что может сделать игрок прямо сейчас
  legal(s, pid) {
    const i = s.players.findIndex(p => p.id === pid);
    if (i < 0 || s.over || s.players[i].out) return null;
    const p = s.players[i], L = { attack: [], defend: {}, take: false, pass: false };
    if (i === s.defender) {
      if (!s.taking) {
        const open = s.table.map((t, k) => t.d ? -1 : k).filter(k => k >= 0);
        for (const c of p.hand) {
          const ok = open.filter(k => beats(c, s.table[k].a, s.trump));
          if (ok.length) L.defend[c] = ok;
        }
        L.take = open.length > 0;
      }
    } else if (s.table.length === 0) {
      if (i === s.attacker) L.attack = [...p.hand];
    } else {
      if (s.table.length < s.limit) { const r = tableRanks(s); L.attack = p.hand.filter(c => r.has(rank(c))); }
      L.pass = !s.passed.includes(pid);
    }
    return L;
  },

  move(s, pid, m, now = Date.now()) {
    const L = Durak.legal(s, pid);
    if (!L) fail(s.over ? 'Игра окончена' : 'Вы не участвуете в партии');
    const p = s.players.find(x => x.id === pid);
    switch (m && m.t) {
      case 'attack':
        if (!L.attack.includes(m.card)) fail(s.table.length >= s.limit ? 'Больше подкидывать нельзя' : 'Этой картой сейчас нельзя ходить');
        p.hand.splice(p.hand.indexOf(m.card), 1);
        s.table.push({ a: m.card, d: null });
        s.passed = [];
        break;
      case 'defend': {
        const opts = L.defend[m.card];
        if (!opts || !opts.includes(m.idx)) fail('Этой картой не побить');
        p.hand.splice(p.hand.indexOf(m.card), 1);
        s.table[m.idx].d = m.card;
        s.passed = [];
        break;
      }
      case 'take':
        if (!L.take) fail('Сейчас нечего брать');
        s.taking = true; s.passed = [];
        break;
      case 'pass':
        if (!L.pass) fail('Сейчас нельзя пасовать');
        s.passed.push(pid);
        break;
      default: fail('Неизвестный ход');
    }
    s.deadline = now + s.timeout;
    resolve(s, now);
  },

  // Таймаут хода: молчащий атакующий ходит младшей картой, защитник берёт, подкидывающие пасуют
  tick(s, now = Date.now()) {
    if (s.over || now < s.deadline) return false;
    if (s.table.length === 0) {
      const p = s.players[s.attacker];
      const c = [...p.hand].sort((a, b) => sortKey(a, s.trump) - sortKey(b, s.trump))[0];
      p.hand.splice(p.hand.indexOf(c), 1);
      s.table.push({ a: c, d: null });
      s.log.push(`${p.name} долго думал — сходил автоматически`);
    } else {
      if (s.table.some(t => !t.d) && !s.taking) { s.taking = true; s.log.push(`${s.players[s.defender].name} не успел отбиться — берёт`); }
      s.players.forEach((p, i) => { if (i !== s.defender && !p.out && !s.passed.includes(p.id)) s.passed.push(p.id); });
    }
    s.deadline = now + s.timeout;
    resolve(s, now);
    return true;
  },

  view(s, viewer) {
    const me = s.players.find(p => p.id === viewer);
    return {
      trump: s.trump, trumpCard: s.trumpCard, deck: s.deck.length, table: s.table, discard: s.discard.length,
      attacker: s.players[s.attacker].id, defender: s.players[s.defender].id,
      taking: s.taking, passed: s.passed, limit: s.limit, round: s.round,
      over: s.over, winners: s.winners, loser: s.loser, deadline: s.deadline, log: s.log.slice(-3),
      players: s.players.map(p => ({ id: p.id, name: p.name, count: p.hand.length, out: p.out })),
      hand: me ? [...me.hand].sort((a, b) => sortKey(a, s.trump) - sortKey(b, s.trump)) : null,
      legal: Durak.legal(s, viewer),
    };
  },
};

function nextActive(s, i) {
  const n = s.players.length;
  for (let k = 1; k <= n; k++) { const j = (i + k) % n; if (!s.players[j].out) return j; }
  return i;
}
function tableRanks(s) {
  const r = new Set();
  for (const t of s.table) { r.add(rank(t.a)); if (t.d) r.add(rank(t.d)); }
  return r;
}
function canThrow(s, i) {
  const p = s.players[i];
  if (i === s.defender || p.out || !p.hand.length || !s.table.length || s.table.length >= s.limit) return false;
  const r = tableRanks(s);
  return p.hand.some(c => r.has(rank(c)));
}
function sortKey(c, trump) { return (suit(c) === trump ? 1000 : SUITS.indexOf(suit(c)) * 100) + rank(c); }

// Заканчиваем кон, когда защитник отбил всё (или берёт), а подкинуть больше никто не хочет/не может
function resolve(s, now) {
  if (!s.table.length) return;
  if (s.table.some(t => !t.d) && !s.taking) return;
  const waiting = s.players.some((p, i) => i !== s.defender && !p.out && !s.passed.includes(p.id) && canThrow(s, i));
  if (!waiting) endBout(s, now);
}

function endBout(s, now) {
  const n = s.players.length, def = s.players[s.defender];
  const cards = s.table.flatMap(t => t.d ? [t.a, t.d] : [t.a]);
  let next;
  if (s.taking) { def.hand.push(...cards); next = nextActive(s, s.defender); s.log.push(`${def.name} берёт`); }
  else { s.discard.push(...cards); next = s.defender; s.log.push('Бито'); }
  s.table = []; s.taking = false; s.passed = [];
  // Добор: сначала главный атакующий, потом остальные по кругу, защитник последним
  const order = [];
  for (let k = 0; k < n; k++) { const j = (s.attacker + k) % n; if (j !== s.defender) order.push(j); }
  order.push(s.defender);
  for (const j of order) { const p = s.players[j]; if (p.out) continue; while (p.hand.length < 6 && s.deck.length) p.hand.push(s.deck.pop()); }
  for (const p of s.players) if (!p.out && !p.hand.length && !s.deck.length) { p.out = true; s.winners.push(p.id); }
  const active = s.players.filter(p => !p.out);
  if (active.length <= 1) {
    s.over = true; s.loser = active[0] ? active[0].id : null;
    s.log.push(s.loser ? `${active[0].name} — дурак!` : 'Ничья');
    return;
  }
  if (s.players[next].out) next = nextActive(s, next);
  s.attacker = next;
  s.defender = nextActive(s, next);
  s.limit = Math.min(6, s.players[s.defender].hand.length);
  s.round++;
  s.deadline = now + s.timeout;
}

/* ============================== КРЕСТИКИ-НОЛИКИ ============================== */
const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const TicTacToe = {
  title: 'Крестики-нолики', min: 2, max: 2,
  init(players, { rng = Math.random, now = Date.now(), timeout = 60000 } = {}) {
    if (players.length !== 2) fail('Нужно ровно 2 игрока');
    const f = rng() < 0.5 ? 0 : 1;
    const ps = [players[f], players[1 - f]].map((p, i) => ({ id: p.id, name: p.name, mark: i ? 'O' : 'X' }));
    return { players: ps, board: Array(9).fill(null), turn: 0, winner: null, line: null, over: false, draw: false, forfeit: false, timeout, deadline: now + timeout };
  },
  legal(s, pid) {
    const i = s.players.findIndex(p => p.id === pid);
    if (i < 0 || s.over) return null;
    return { place: i === s.turn ? s.board.flatMap((v, k) => v ? [] : [k]) : [] };
  },
  move(s, pid, m, now = Date.now()) {
    const i = s.players.findIndex(p => p.id === pid);
    if (i < 0) fail('Вы не участвуете в партии');
    if (s.over) fail('Игра окончена');
    if (i !== s.turn) fail('Сейчас ход соперника');
    if (!m || m.t !== 'place' || !Number.isInteger(m.i) || m.i < 0 || m.i > 8) fail('Неверный ход');
    if (s.board[m.i]) fail('Клетка занята');
    s.board[m.i] = s.players[i].mark;
    const line = LINES.find(l => l.every(k => s.board[k] === s.players[i].mark));
    if (line) { s.over = true; s.winner = pid; s.line = line; }
    else if (s.board.every(Boolean)) { s.over = true; s.draw = true; }
    else s.turn = 1 - s.turn;
    s.deadline = now + s.timeout;
  },
  tick(s, now = Date.now()) {
    if (s.over || now < s.deadline) return false;
    s.over = true; s.forfeit = true; s.winner = s.players[1 - s.turn].id;
    return true;
  },
  view(s, viewer) {
    return { players: s.players, board: s.board, turn: s.players[s.turn].id, winner: s.winner, line: s.line,
      over: s.over, draw: s.draw, forfeit: s.forfeit, deadline: s.deadline, legal: TicTacToe.legal(s, viewer) };
  },
};

/* ============================== ШПИОН ============================== */
// Все, кроме шпиона, знают локацию (и свою роль в ней). Задают друг другу вопросы голосом в звонке.
// Любой может один раз за игру обвинить — нужно единогласие остальных. Шпион может в любой момент назвать локацию.
// Когда время раунда вышло — общее голосование.
const SPY_LOCATIONS = {
  'Самолёт': ['Пилот', 'Стюардесса', 'Пассажир эконом-класса', 'Пассажир бизнес-класса', 'Бортмеханик'],
  'Банк': ['Кассир', 'Охранник', 'Управляющий', 'Клиент', 'Грабитель'],
  'Пляж': ['Спасатель', 'Отдыхающий', 'Продавец кукурузы', 'Фотограф', 'Сёрфер'],
  'Казино': ['Крупье', 'Охранник', 'Шулер', 'Хайроллер', 'Бармен'],
  'Цирк': ['Клоун', 'Дрессировщик', 'Акробат', 'Зритель', 'Фокусник'],
  'Школа': ['Учитель', 'Ученик', 'Директор', 'Охранник', 'Уборщица'],
  'Больница': ['Хирург', 'Медсестра', 'Пациент', 'Терапевт', 'Санитар'],
  'Ресторан': ['Шеф-повар', 'Официант', 'Посетитель', 'Музыкант', 'Ресторанный критик'],
  'Театр': ['Актёр', 'Режиссёр', 'Суфлёр', 'Зритель', 'Гардеробщица'],
  'Отель': ['Портье', 'Горничная', 'Постоялец', 'Швейцар', 'Управляющий'],
  'Военная база': ['Генерал', 'Солдат', 'Повар', 'Часовой', 'Военврач'],
  'Подводная лодка': ['Капитан', 'Акустик', 'Кок', 'Штурман', 'Матрос'],
  'Космическая станция': ['Командир', 'Инженер', 'Учёный', 'Космический турист', 'Пилот'],
  'Пиратский корабль': ['Капитан', 'Кок', 'Юнга', 'Пленник', 'Боцман'],
  'Поезд дальнего следования': ['Машинист', 'Проводник', 'Пассажир', 'Контролёр', 'Продавец пирожков'],
  'Полицейский участок': ['Следователь', 'Дежурный', 'Задержанный', 'Адвокат', 'Журналист'],
  'Супермаркет': ['Кассир', 'Покупатель', 'Охранник', 'Грузчик', 'Мерчендайзер'],
  'Университет': ['Профессор', 'Студент', 'Ректор', 'Аспирант', 'Лаборант'],
  'Посольство': ['Посол', 'Охранник', 'Переводчик', 'Турист', 'Дипломат'],
  'Кинотеатр': ['Киномеханик', 'Зритель', 'Кассир', 'Продавец попкорна', 'Уборщик'],
  'Спа-салон': ['Массажист', 'Клиент', 'Косметолог', 'Администратор', 'Мастер маникюра'],
  'Зоопарк': ['Смотритель', 'Ветеринар', 'Посетитель', 'Фотограф', 'Экскурсовод'],
  'Стройка': ['Прораб', 'Каменщик', 'Крановщик', 'Архитектор', 'Инспектор'],
  'Ночной клуб': ['Диджей', 'Бармен', 'Охранник', 'Танцор', 'Тусовщик'],
  'Полярная станция': ['Начальник станции', 'Метеоролог', 'Повар', 'Радист', 'Исследователь'],
  'Баня': ['Банщик', 'Завсегдатай', 'Новичок', 'Продавец веников', 'Администратор'],
  'Дача': ['Хозяин', 'Сосед', 'Гость', 'Ребёнок', 'Бабушка'],
  'Метро': ['Машинист', 'Пассажир', 'Дежурная у эскалатора', 'Уличный музыкант', 'Полицейский'],
  'Аэропорт': ['Пограничник', 'Пассажир', 'Диспетчер', 'Таможенник', 'Грузчик'],
  'Свадьба': ['Жених', 'Невеста', 'Тамада', 'Гость', 'Фотограф'],
};
const SPY_LIST = Object.keys(SPY_LOCATIONS);

const Spy = {
  title: 'Шпион', min: 3, max: 8,

  init(players, { rng = Math.random, now = Date.now(), timeout = 30000, roundMs } = {}) {
    if (players.length < 3 || players.length > 8) fail('Нужно от 3 до 8 игроков');
    const location = SPY_LIST[Math.floor(rng() * SPY_LIST.length)];
    const spyIdx = Math.floor(rng() * players.length);
    const roles = shuffle([...SPY_LOCATIONS[location]], rng);
    let k = 0;
    const ps = players.map((p, i) => ({ id: p.id, name: p.name, spy: i === spyIdx, role: i === spyIdx ? null : roles[k++ % roles.length] }));
    const round = roundMs || (players.length <= 4 ? 6 : players.length <= 6 ? 8 : 10) * 60000;
    const s = {
      players: ps, location, phase: 'play', first: ps[Math.floor(rng() * ps.length)].id,
      endsAt: now + round, voteMs: timeout, accusation: null, accused: [], finalVotes: {}, finalEnds: 0,
      over: false, winner: null, reason: '', deadline: 0, log: [],
    };
    s.deadline = s.endsAt;
    return s;
  },

  legal(s, pid) {
    const me = s.players.find(p => p.id === pid);
    if (!me || s.over) return null;
    const others = s.players.filter(p => p.id !== pid).map(p => p.id);
    const L = { accuse: [], vote: false, guess: false, final: [] };
    if (s.phase === 'play' && !s.accusation) {
      if (!s.accused.includes(pid)) L.accuse = others;
      L.guess = me.spy;
    }
    if (s.accusation && s.accusation.target !== pid && !(pid in s.accusation.votes)) L.vote = true;
    if (s.phase === 'final' && !(pid in s.finalVotes)) L.final = others;
    return L;
  },

  move(s, pid, m, now = Date.now()) {
    const L = Spy.legal(s, pid);
    if (!L) fail(s.over ? 'Игра окончена' : 'Вы не участвуете в партии');
    const me = s.players.find(p => p.id === pid);
    switch (m && m.t) {
      case 'accuse':
        if (!L.accuse.includes(m.target)) fail(s.accused.includes(pid) ? 'Вы уже обвиняли в этой игре' : 'Сейчас нельзя обвинять');
        s.accused.push(pid);
        s.accusation = { by: pid, target: m.target, votes: { [pid]: true }, deadline: now + s.voteMs };
        s.log.push(`${me.name} обвиняет ${nameOf(s, m.target)}`);
        spyResolveVote(s, now);
        break;
      case 'vote':
        if (!L.vote) fail('Сейчас не нужно голосовать');
        s.accusation.votes[pid] = !!m.yes;
        spyResolveVote(s, now);
        break;
      case 'guess':
        if (!L.guess) fail('Назвать локацию может только шпион');
        if (!SPY_LOCATIONS[m.location]) fail('Нет такой локации');
        if (m.location === s.location) spyEnd(s, 'spy', `Шпион угадал локацию: ${s.location}`);
        else spyEnd(s, 'civil', `Шпион ошибся: назвал «${m.location}», а это ${s.location}`);
        break;
      case 'final':
        if (!L.final.includes(m.target)) fail('Сейчас нельзя голосовать за этого игрока');
        s.finalVotes[pid] = m.target;
        if (Object.keys(s.finalVotes).length === s.players.length) spyResolveFinal(s);
        break;
      default: fail('Неизвестный ход');
    }
    spyDeadline(s);
  },

  tick(s, now = Date.now()) {
    if (s.over || now < s.deadline) return false;
    if (s.accusation && now >= s.accusation.deadline) {
      // кто не успел проголосовать — «против»
      for (const p of s.players) if (p.id !== s.accusation.target && !(p.id in s.accusation.votes)) s.accusation.votes[p.id] = false;
      spyResolveVote(s, now);
    }
    if (!s.over && s.phase === 'play' && !s.accusation && now >= s.endsAt) {
      s.phase = 'final'; s.finalEnds = now + 60000; s.log.push('Время вышло — общее голосование');
    } else if (!s.over && s.phase === 'final' && now >= s.finalEnds) {
      spyResolveFinal(s);
    }
    spyDeadline(s);
    return true;
  },

  view(s, viewer) {
    const me = s.players.find(p => p.id === viewer);
    const acc = s.accusation;
    return {
      phase: s.phase, over: s.over, winner: s.winner, reason: s.reason, first: s.first,
      endsAt: s.endsAt, finalEnds: s.finalEnds, deadline: s.deadline, log: s.log.slice(-3),
      locations: SPY_LIST,
      me: me ? (me.spy ? { spy: true } : { spy: false, location: s.location, role: me.role }) : null,
      players: s.players.map(p => ({ id: p.id, name: p.name, accused: s.accused.includes(p.id), votedFinal: p.id in s.finalVotes,
        ...(s.over ? { spy: p.spy, role: p.role } : {}) })),
      accusation: acc ? { by: acc.by, target: acc.target, yes: Object.values(acc.votes).filter(Boolean).length,
        need: s.players.length - 1, voted: Object.keys(acc.votes), deadline: acc.deadline } : null,
      finalVotes: s.over ? s.finalVotes : null,
      location: s.over ? s.location : null,
      legal: Spy.legal(s, viewer),
    };
  },
};
const nameOf = (s, id) => (s.players.find(p => p.id === id) || {}).name || '?';
function spyEnd(s, winner, reason) {
  s.over = true; s.winner = winner; s.reason = reason; s.accusation = null; s.phase = 'over'; s.log.push(reason);
}
function spyResolveVote(s, now) {
  const a = s.accusation, voters = s.players.filter(p => p.id !== a.target);
  const no = voters.some(p => a.votes[p.id] === false);
  const allYes = voters.every(p => a.votes[p.id] === true);
  const target = s.players.find(p => p.id === a.target);
  if (allYes) {
    if (target.spy) spyEnd(s, 'civil', `Шпиона вычислили: это ${target.name}`);
    else spyEnd(s, 'spy', `${target.name} — не шпион! Шпион побеждает`);
  } else if (no) {
    s.log.push(`Обвинение против ${target.name} не прошло`);
    s.accusation = null;
    if (s.phase === 'play' && now >= s.endsAt) { s.phase = 'final'; s.finalEnds = now + 60000; }
  }
}
function spyResolveFinal(s) {
  const count = {};
  for (const t of Object.values(s.finalVotes)) count[t] = (count[t] || 0) + 1;
  const sorted = Object.entries(count).sort((a, b) => b[1] - a[1]);
  if (!sorted.length || (sorted[1] && sorted[1][1] === sorted[0][1])) return spyEnd(s, 'spy', 'Голоса разделились — шпион ускользнул');
  const target = s.players.find(p => p.id === sorted[0][0]);
  if (target.spy) spyEnd(s, 'civil', `Шпиона вычислили: это ${target.name}`);
  else spyEnd(s, 'spy', `Выбрали ${target.name}, но это не шпион`);
}
function spyDeadline(s) {
  if (s.over) { s.deadline = 0; return; }
  // пока идёт обвинение, таймер раунда «ждёт» — сначала решаем судьбу обвинения
  s.deadline = s.accusation ? s.accusation.deadline : s.phase === 'final' ? s.finalEnds : s.endsAt;
}

/* ============================== Общая обвязка комнаты ============================== */
const ENGINES = { durak: Durak, ttt: TicTacToe, spy: Spy };

function create(type, host) {
  if (!ENGINES[type]) fail('Неизвестная игра');
  return { type, host: host.id, status: 'lobby', players: [{ id: host.id, name: host.name }], s: null, aborted: null };
}

function handle(g, peer, op, d = {}, now = Date.now(), rng = Math.random, timeout) {
  const E = ENGINES[g.type], inGame = g.players.some(p => p.id === peer.id);
  switch (op) {
    case 'join':
      if (g.status === 'playing') fail('Партия уже идёт');
      if (inGame) return;
      if (g.players.length >= E.max) fail('Мест нет');
      g.players.push({ id: peer.id, name: peer.name });
      if (g.status === 'over') { g.status = 'lobby'; g.s = null; }
      return;
    case 'leave':
      if (g.status === 'playing') fail('Нельзя выйти посреди партии');
      g.players = g.players.filter(p => p.id !== peer.id);
      if (g.host === peer.id) g.host = g.players[0] ? g.players[0].id : null;
      return;
    case 'start':
      if (g.host !== peer.id) fail('Начать может только тот, кто создал игру');
      if (g.status === 'playing') fail('Партия уже идёт');
      if (g.players.length < E.min) fail(`Нужно минимум ${E.min} игрока`);
      g.s = E.init(g.players, timeout ? { rng, now, timeout } : { rng, now });
      g.status = 'playing'; g.aborted = null;
      return;
    case 'move':
      if (g.status !== 'playing') fail('Партия не идёт');
      E.move(g.s, peer.id, d.move || {}, now);
      if (g.s.over) g.status = 'over';
      return;
    default: fail('Неизвестное действие');
  }
}

// Игрок ушёл из комнаты (после паузы на переподключение)
function onLeave(g, id) {
  const i = g.players.findIndex(p => p.id === id);
  if (i < 0) return false;
  if (g.status === 'playing') { g.status = 'over'; g.s.over = true; g.aborted = g.players[i].name; }
  g.players.splice(i, 1);
  if (g.host === id) g.host = g.players[0] ? g.players[0].id : null;
  return true;
}

function tick(g, now = Date.now()) {
  if (g.status !== 'playing') return false;
  const changed = ENGINES[g.type].tick(g.s, now);
  if (g.s.over) g.status = 'over';
  return changed;
}
const deadline = g => g.status === 'playing' ? g.s.deadline : 0;

function view(g, viewer) {
  const E = ENGINES[g.type];
  return { type: g.type, title: E.title, min: E.min, max: E.max, host: g.host, status: g.status,
    players: g.players, aborted: g.aborted, state: g.s ? E.view(g.s, viewer) : null };
}

module.exports = { GameError, Durak, TicTacToe, Spy, SPY_LOCATIONS, ENGINES, create, handle, onLeave, tick, deadline, view, beats, fullDeck, suit, rank };

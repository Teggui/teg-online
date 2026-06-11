'use strict';
/*
 * TEG online — servidor autoritativo.
 * Todo el estado, los dados y las validaciones viven acá; el cliente solo
 * dibuja y pide acciones. Reglas según el reglamento oficial de TEG.
 */
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const webpush = require('web-push');
const DATA = require('./public/teg-data.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 30000, pingInterval: 10000 });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---- Web Push (avisos de turno con el teléfono bloqueado) ----
// En producción las claves van en variables de entorno; sin ellas se generan
// efímeras (las suscripciones mueren con cada reinicio).
let vapidPublic = process.env.VAPID_PUBLIC_KEY;
let vapidPrivate = process.env.VAPID_PRIVATE_KEY;
if (!vapidPublic || !vapidPrivate) {
  const keys = webpush.generateVAPIDKeys();
  vapidPublic = keys.publicKey;
  vapidPrivate = keys.privateKey;
  console.log('AVISO: VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY no configuradas; usando claves efímeras.');
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:teg@silicaro.com', vapidPublic, vapidPrivate);
app.get('/vapid-public-key', (_req, res) => res.json({ key: vapidPublic }));

function sendPush(p, title, body, code) {
  if (!p || !p.pushSub) return;
  const payload = JSON.stringify({ title, body, code });
  webpush.sendNotification(p.pushSub, payload, { TTL: 600 }).catch((err) => {
    // 404/410: la suscripción ya no existe
    if (err.statusCode === 404 || err.statusCode === 410) p.pushSub = null;
  });
}

function sendTurnPush(g) {
  if (g.status !== 'playing') return;
  const p = currentPlayer(g);
  if (!p) return;
  const phase = (g.phase === 'inicial5' || g.phase === 'inicial3')
    ? `Te toca colocar ${g.placeLeft} ejércitos`
    : 'Te toca jugar';
  sendPush(p, '🎲 ¡Es tu turno!', `${phase} en la partida ${g.code}.`, g.code);
}

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------- utilidades

const COUNTRY_IDS = Object.keys(DATA.COUNTRIES);
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function token() { return crypto.randomBytes(12).toString('hex'); }
function die() { return crypto.randomInt(1, 7); }
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const games = new Map(); // code -> game

function newRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  } while (games.has(code));
  return code;
}

function tradeValue(n) { // 1º:4, 2º:7, 3º:10, luego +5
  if (n === 1) return 4;
  if (n === 2) return 7;
  return 10 + 5 * (n - 3);
}

// ------------------------------------------------------------- estado básico

function createGame(code) {
  return {
    code,
    status: 'lobby',          // lobby | playing | finished
    hostId: null,
    players: [],              // orden = orden de turnos una vez iniciada
    countries: {},            // id -> { o: playerId, a: ejércitos }
    deck: [], discard: [],
    phase: null,              // inicial5 | inicial3 | reinforce | attack | regroup
    turn: 0, round: 0,
    placeLeft: 0,
    reinforce: null,          // { free, conts: {cont: n} }
    conqueredThisTurn: 0,
    pendingExtra: null,       // { from, to, max }
    regroupLocks: {},         // countryId -> ejércitos que ya se movieron
    chat: [],
    winner: null,
    lastActivity: Date.now()
  };
}

function newPlayer(name) {
  return {
    id: token(), name, color: null,
    socketId: null, connected: true,
    cards: [], trades: 0,
    objective: null, effTargetId: null, objImpossible: false,
    eliminated: false, pushSub: null
  };
}

function currentPlayer(g) { return g.players[g.turn]; }
function playerById(g, id) { return g.players.find(p => p.id === id); }
function alivePlayers(g) { return g.players.filter(p => !p.eliminated); }
function countriesOf(g, pid) { return COUNTRY_IDS.filter(c => g.countries[c].o === pid); }
function armiesOf(g, pid) { return countriesOf(g, pid).reduce((s, c) => s + g.countries[c].a, 0); }
function ownsContinent(g, pid, cont) {
  return COUNTRY_IDS.every(c => DATA.COUNTRIES[c].cont !== cont || g.countries[c].o === pid);
}
function countByContinent(g, pid) {
  const r = {};
  for (const c of countriesOf(g, pid)) {
    const k = DATA.COUNTRIES[c].cont;
    r[k] = (r[k] || 0) + 1;
  }
  return r;
}

// --------------------------------------------------------------- objetivos

function hasTriangle(g, pid) {
  // 3 países propios limítrofes entre sí
  for (const c of countriesOf(g, pid)) {
    const ownNbrs = DATA.ADJ[c].filter(n => g.countries[n].o === pid);
    for (let i = 0; i < ownNbrs.length; i++)
      for (let j = i + 1; j < ownNbrs.length; j++)
        if (DATA.isAdjacent(ownNbrs[i], ownNbrs[j])) return true;
  }
  return false;
}

function occupationSatisfied(g, pid, obj) {
  for (const cont of obj.continents || []) {
    if (!ownsContinent(g, pid, cont)) return false;
  }
  const byCont = countByContinent(g, pid);
  for (const [cont, n] of Object.entries(obj.counts || {})) {
    if ((byCont[cont] || 0) < n) return false;
  }
  if (obj.triangle && !hasTriangle(g, pid)) return false;
  return true;
}

function playerToRight(g, p) {
  // El turno avanza hacia la izquierda; el de la derecha es el anterior en la ronda.
  const idx = g.players.indexOf(p);
  const n = g.players.length;
  return g.players[(idx - 1 + n) % n];
}

function assignObjectives(g) {
  // Con 2 jugadores se reparten solo objetivos de ocupación: destruir al
  // único rival equivale a ganar igual, y así hay metas más cortas que 30 países.
  const pool = g.players.length === 2
    ? DATA.OBJECTIVES.filter(o => o.type === 'occupy')
    : DATA.OBJECTIVES;
  const deck = shuffle(pool.map(o => ({ ...o })));
  for (const p of g.players) {
    // Si un objetivo de ocupación ya está cumplido con el reparto inicial
    // (posible con pocos jugadores), se devuelve al mazo y se toma otro.
    let guard = deck.length;
    while (guard-- > 0) {
      const o = deck.shift();
      if (o.type === 'occupy' && occupationSatisfied(g, p.id, o)) { deck.push(o); continue; }
      p.objective = o;
      break;
    }
    if (!p.objective) p.objective = { type: 'common', text: 'Ocupar 30 países.' };
    if (p.objective.type === 'destroy') {
      const target = g.players.find(q => q.color === p.objective.color);
      // Color propio o ausente: el objetivo pasa al jugador de la derecha.
      p.effTargetId = (!target || target.id === p.id) ? playerToRight(g, p).id : target.id;
    }
  }
}

// ---------------------------------------------------------------- mensajes

function toast(g, text, type) {
  io.to(g.code).emit('toast', { text, type: type || 'info' });
}

function buildCardDeck(g) {
  g.deck = shuffle(COUNTRY_IDS.slice());
  g.discard = [];
}

function drawCard(g, p) {
  if (g.deck.length === 0) {
    if (g.discard.length === 0) return null;
    g.deck = shuffle(g.discard);
    g.discard = [];
  }
  const c = g.deck.pop();
  const card = { c, sym: DATA.COUNTRIES[c].sym, used: false };
  p.cards.push(card);
  applyCardBonus(g, p, card);
  return card;
}

// 2 ejércitos de premio cuando se posee el país y su tarjeta (una sola vez)
function applyCardBonus(g, p, card) {
  if (!card.used && g.countries[card.c].o === p.id) {
    card.used = true;
    g.countries[card.c].a += 2;
    toast(g, `${p.name} colocó 2 ejércitos de premio en ${DATA.COUNTRIES[card.c].name} (tenía la tarjeta del país).`, 'bonus');
  }
}

// ------------------------------------------------------------ flujo de juego

function startGame(g) {
  shuffle(g.players); // orden de turnos al azar (equivale al tiro de dados)
  // Reparto de países, 1 ejército en cada uno
  const ids = shuffle(COUNTRY_IDS.slice());
  ids.forEach((c, i) => {
    g.countries[c] = { o: g.players[i % g.players.length].id, a: 1 };
  });
  buildCardDeck(g);
  assignObjectives(g);
  g.status = 'playing';
  g.phase = 'inicial5';
  g.turn = 0;
  g.round = 0;
  g.placeLeft = 5;
  g.winner = null;
  toast(g, `¡Arranca la partida! Primera ronda: cada jugador coloca 5 ejércitos.`, 'big');
  sendTurnPush(g);
}

function advancePlacement(g) {
  if (g.turn < g.players.length - 1) {
    g.turn++;
    g.placeLeft = g.phase === 'inicial5' ? 5 : 3;
    sendTurnPush(g);
    return;
  }
  if (g.phase === 'inicial5') {
    g.phase = 'inicial3';
    g.turn = 0;
    g.placeLeft = 3;
    toast(g, 'Segunda ronda de refuerzos: cada jugador coloca 3 ejércitos.', 'big');
    sendTurnPush(g);
    return;
  }
  // Empiezan las hostilidades (ronda 1: sin incorporación de ejércitos)
  g.phase = 'attack';
  g.turn = 0;
  g.round = 1;
  g.conqueredThisTurn = 0;
  toast(g, `¡Comienzan las hostilidades! Turno de ${currentPlayer(g).name}.`, 'big');
  sendTurnPush(g);
}

function computeReinforcements(g, p) {
  const n = countriesOf(g, p.id).length;
  const free = Math.max(3, Math.floor(n / 2));
  const conts = {};
  for (const cont of Object.keys(DATA.CONTINENTS)) {
    if (ownsContinent(g, p.id, cont)) conts[cont] = DATA.CONTINENTS[cont].bonus;
  }
  return { free, conts };
}

function beginTurn(g) {
  const p = currentPlayer(g);
  g.conqueredThisTurn = 0;
  g.pendingExtra = null;
  g.regroupLocks = {};
  if (g.round === 1) {
    g.phase = 'attack';
  } else {
    g.phase = 'reinforce';
    g.reinforce = computeReinforcements(g, p);
    const bonusTxt = Object.keys(g.reinforce.conts).map(c => `${DATA.CONTINENTS[c].name} +${g.reinforce.conts[c]}`).join(', ');
    toast(g, `Turno de ${p.name}: incorpora ${g.reinforce.free} ejércitos${bonusTxt ? ' (' + bonusTxt + ')' : ''}.`);
  }
}

function endTurn(g) {
  const p = currentPlayer(g);
  // Tarjeta de país: 1 conquista (o 2 a partir del 3º canje)
  const required = p.trades >= 3 ? 2 : 1;
  if (g.conqueredThisTurn >= required) {
    const card = drawCard(g, p);
    if (card) toast(g, `${p.name} recibió una tarjeta de país.`);
  }
  g.pendingExtra = null;
  g.regroupLocks = {};
  // Siguiente jugador vivo
  const n = g.players.length;
  let i = g.turn;
  do { i = (i + 1) % n; } while (g.players[i].eliminated);
  if (i <= g.turn) g.round++;
  g.turn = i;
  beginTurn(g);
  sendTurnPush(g);
}

function win(g, p, how) {
  g.status = 'finished';
  g.phase = null;
  g.winner = {
    id: p.id, name: p.name, color: p.color, how,
    objectiveText: p.objective ? p.objective.text : 'Ocupar 30 países.',
    reveal: g.players.map(q => ({
      name: q.name, color: q.color,
      text: q.objective ? q.objective.text : '—',
      impossible: q.objImpossible
    }))
  };
  toast(g, `🏆 ¡${p.name} ganó la partida!`, 'big');
}

function checkVictory(g, p) {
  if (g.status !== 'playing') return;
  if (countriesOf(g, p.id).length >= 30) return win(g, p, 'Cumplió el objetivo común: ocupar 30 países');
  const o = p.objective;
  if (o && o.type === 'occupy' && !p.objImpossible && occupationSatisfied(g, p.id, o)) {
    return win(g, p, 'Cumplió su objetivo secreto');
  }
}

function handleElimination(g, victim, killer) {
  victim.eliminated = true;
  if (victim.cards.length) {
    killer.cards.push(...victim.cards);
    victim.cards = [];
    toast(g, `${killer.name} hereda las tarjetas de ${victim.name}.`);
  }
  toast(g, `💀 ¡${killer.name} destruyó al ejército ${DATA.COLORS[victim.color].name.toLowerCase()} de ${victim.name}!`, 'big');

  // Objetivos de destrucción que apuntaban a la víctima
  for (const q of g.players) {
    if (q.eliminated || !q.objective || q.objective.type !== 'destroy' || q.objImpossible) continue;
    if (q.effTargetId === victim.id) {
      if (q.id === killer.id) return win(g, q, 'Cumplió su objetivo secreto: destruir a ' + victim.name);
      // Otro jugador lo destruyó: el objetivo se vuelve imposible,
      // queda solo el objetivo común (ocupar 30 países).
      q.objImpossible = true;
    }
  }
  const alive = alivePlayers(g);
  if (alive.length === 1) return win(g, alive[0], 'Último ejército en pie');
}

function doAttack(g, p, from, to) {
  const A = g.countries[from], D = g.countries[to];
  const defender = playerById(g, D.o);
  const aN = Math.min(3, A.a - 1);
  const dN = Math.min(3, D.a);
  const aDice = Array.from({ length: aN }, die).sort((x, y) => y - x);
  const dDice = Array.from({ length: dN }, die).sort((x, y) => y - x);
  let aLoss = 0, dLoss = 0;
  for (let i = 0; i < Math.min(aN, dN); i++) {
    if (aDice[i] > dDice[i]) dLoss++; else aLoss++; // empate gana el defensor
  }
  A.a -= aLoss;
  D.a -= dLoss;

  let conquered = false;
  if (D.a === 0) {
    conquered = true;
    D.o = p.id;
    A.a -= 1; D.a = 1; // ocupación obligatoria de 1 ejército
    g.conqueredThisTurn++;
    const extraMax = Math.min(2, A.a - 1);
    g.pendingExtra = extraMax > 0 ? { from, to, max: extraMax } : null;
    toast(g, `⚔️ ${p.name} conquistó ${DATA.COUNTRIES[to].name}.`, 'conquest');
    // Premio si tiene la tarjeta del país conquistado
    for (const card of p.cards) if (card.c === to) applyCardBonus(g, p, card);
  }

  io.to(g.code).emit('combat', {
    from, to,
    fromName: DATA.COUNTRIES[from].name, toName: DATA.COUNTRIES[to].name,
    attacker: { name: p.name, color: p.color, dice: aDice, loss: aLoss },
    defender: { name: defender.name, color: defender.color, dice: dDice, loss: dLoss },
    conquered
  });

  if (conquered) {
    if (countriesOf(g, defender.id).length === 0) handleElimination(g, defender, p);
    checkVictory(g, p);
  }
}

// Colocación automática para saltear el turno de un desconectado
function autoResolveTurn(g) {
  const p = currentPlayer(g);
  const own = countriesOf(g, p.id);
  if (g.phase === 'inicial5' || g.phase === 'inicial3') {
    let i = 0;
    while (g.placeLeft > 0) { g.countries[own[i % own.length]].a++; g.placeLeft--; i++; }
    advancePlacement(g);
    return;
  }
  if (g.phase === 'reinforce') {
    for (const [cont, n] of Object.entries(g.reinforce.conts)) {
      const target = own.find(c => DATA.COUNTRIES[c].cont === cont);
      if (target) g.countries[target].a += n;
      g.reinforce.conts[cont] = 0;
    }
    let i = 0;
    while (g.reinforce.free > 0) { g.countries[own[i % own.length]].a++; g.reinforce.free--; i++; }
    g.phase = 'attack';
  }
  endTurn(g);
}

// --------------------------------------------------------------- snapshots

function stateFor(g, viewer) {
  const st = {
    code: g.code,
    status: g.status,
    phase: g.phase,
    round: g.round,
    hostId: g.hostId,
    currentPlayerId: g.status === 'playing' ? currentPlayer(g).id : null,
    placeLeft: g.placeLeft,
    reinforce: g.phase === 'reinforce' ? g.reinforce : null,
    pendingExtra: g.pendingExtra,
    deckCount: g.deck.length,
    winner: g.winner,
    chat: g.chat.slice(-60),
    players: g.players.map(p => ({
      id: p.id, name: p.name, color: p.color,
      connected: p.connected, eliminated: p.eliminated,
      countryCount: g.status === 'lobby' ? 0 : countriesOf(g, p.id).length,
      armyCount: g.status === 'lobby' ? 0 : armiesOf(g, p.id),
      cardCount: p.cards.length,
      trades: p.trades
    })),
    countries: g.status === 'lobby' ? null : g.countries
  };
  if (viewer) {
    const mustTrade = g.status === 'playing' && g.phase === 'reinforce'
      && currentPlayer(g).id === viewer.id && viewer.cards.length >= 5;
    st.you = {
      id: viewer.id, name: viewer.name, color: viewer.color,
      cards: viewer.cards, trades: viewer.trades, mustTrade,
      objective: viewer.objective ? {
        type: viewer.objective.type,
        text: viewer.objective.text,
        impossible: viewer.objImpossible,
        targetName: viewer.effTargetId ? (playerById(g, viewer.effTargetId) || {}).name : null
      } : null
    };
  }
  return st;
}

function broadcast(g) {
  g.lastActivity = Date.now();
  for (const p of g.players) {
    if (p.socketId) {
      const s = io.sockets.sockets.get(p.socketId);
      if (s) s.emit('state', stateFor(g, p));
    }
  }
}

// ----------------------------------------------------------------- sockets

io.on('connection', (socket) => {
  let game = null;   // partida a la que está unido este socket
  let me = null;     // jugador de este socket

  function fail(cb, msg) { if (typeof cb === 'function') cb({ error: msg }); }
  function ok(cb, extra) { if (typeof cb === 'function') cb({ ok: true, ...(extra || {}) }); }

  function attach(g, p) {
    game = g; me = p;
    p.socketId = socket.id;
    p.connected = true;
    socket.join(g.code);
  }

  function requireTurn(cb, phases) {
    if (!game || !me) { fail(cb, 'No estás en una partida.'); return null; }
    if (game.status !== 'playing') { fail(cb, 'La partida no está en curso.'); return null; }
    if (currentPlayer(game).id !== me.id) { fail(cb, 'No es tu turno.'); return null; }
    if (phases && phases.indexOf(game.phase) === -1) { fail(cb, 'No corresponde en esta fase.'); return null; }
    return me;
  }

  socket.on('createRoom', ({ name } = {}, cb) => {
    name = String(name || '').trim().slice(0, 18);
    if (!name) return fail(cb, 'Poné tu nombre.');
    const g = createGame(newRoomCode());
    const p = newPlayer(name);
    p.color = Object.keys(DATA.COLORS)[0];
    g.players.push(p);
    g.hostId = p.id;
    games.set(g.code, g);
    attach(g, p);
    ok(cb, { code: g.code, token: p.id });
    broadcast(g);
  });

  socket.on('joinRoom', ({ code, name } = {}, cb) => {
    code = String(code || '').trim().toUpperCase();
    name = String(name || '').trim().slice(0, 18);
    const g = games.get(code);
    if (!g) return fail(cb, 'No existe una partida con ese código.');
    if (!name) return fail(cb, 'Poné tu nombre.');

    // Reincorporación por nombre (mismo nombre, jugador desconectado)
    const existing = g.players.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (existing.connected) return fail(cb, 'Ya hay un jugador conectado con ese nombre.');
      attach(g, existing);
      ok(cb, { code: g.code, token: existing.id, rejoined: true });
      toast(g, `${existing.name} volvió a la partida.`);
      broadcast(g);
      return;
    }
    if (g.status !== 'lobby') return fail(cb, 'La partida ya empezó (podés volver a entrar con tu mismo nombre).');
    if (g.players.length >= 6) return fail(cb, 'La sala está llena (máximo 6).');
    const p = newPlayer(name);
    const used = g.players.map(q => q.color);
    p.color = Object.keys(DATA.COLORS).find(c => used.indexOf(c) === -1);
    g.players.push(p);
    attach(g, p);
    ok(cb, { code: g.code, token: p.id });
    toast(g, `${p.name} se unió a la sala.`);
    broadcast(g);
  });

  socket.on('rejoin', ({ code, token: tk } = {}, cb) => {
    const g = games.get(String(code || '').toUpperCase());
    if (!g) return fail(cb, 'La partida ya no existe.');
    const p = g.players.find(q => q.id === tk);
    if (!p) return fail(cb, 'No encontramos tu lugar en esa partida.');
    if (p.connected && p.socketId !== socket.id) {
      const old = io.sockets.sockets.get(p.socketId);
      if (old) old.disconnect(true);
    }
    attach(g, p);
    ok(cb, { code: g.code, token: p.id });
    broadcast(g);
  });

  socket.on('pickColor', ({ color } = {}, cb) => {
    if (!game || !me) return fail(cb, 'No estás en una partida.');
    if (game.status !== 'lobby') return fail(cb, 'La partida ya empezó.');
    if (!DATA.COLORS[color]) return fail(cb, 'Color inválido.');
    if (game.players.some(p => p.color === color && p.id !== me.id)) return fail(cb, 'Ese color ya está tomado.');
    me.color = color;
    ok(cb);
    broadcast(game);
  });

  socket.on('startGame', (_payload, cb) => {
    if (!game || !me) return fail(cb, 'No estás en una partida.');
    if (game.hostId !== me.id) return fail(cb, 'Solo el anfitrión puede iniciar.');
    if (game.status !== 'lobby') return fail(cb, 'La partida ya empezó.');
    if (game.players.length < 2) return fail(cb, 'Hacen falta al menos 2 jugadores.');
    startGame(game);
    ok(cb);
    broadcast(game);
  });

  socket.on('placeArmies', ({ country, n } = {}, cb) => {
    const p = requireTurn(cb, ['inicial5', 'inicial3', 'reinforce']);
    if (!p) return;
    n = Math.max(1, Math.min(50, parseInt(n, 10) || 1));
    const ct = game.countries[country];
    if (!ct || ct.o !== p.id) return fail(cb, 'Ese país no es tuyo.');

    if (game.phase === 'reinforce') {
      if (p.cards.length >= 5) return fail(cb, 'Tenés 5 o más tarjetas: estás obligado a canjear antes de colocar.');
      const cont = DATA.COUNTRIES[country].cont;
      let placed = 0;
      // Primero la cuota del continente (si corresponde), después el pozo libre
      while (n > 0 && (game.reinforce.conts[cont] || 0) > 0) {
        game.reinforce.conts[cont]--; ct.a++; n--; placed++;
      }
      while (n > 0 && game.reinforce.free > 0) {
        game.reinforce.free--; ct.a++; n--; placed++;
      }
      if (placed === 0) return fail(cb, 'No te quedan ejércitos para colocar ahí.');
      const contLeft = Object.values(game.reinforce.conts).reduce((s, v) => s + v, 0);
      if (game.reinforce.free === 0 && contLeft === 0) {
        game.phase = 'attack';
      }
      ok(cb);
      broadcast(game);
      return;
    }

    // Fases iniciales
    const put = Math.min(n, game.placeLeft);
    ct.a += put;
    game.placeLeft -= put;
    if (game.placeLeft === 0) advancePlacement(game);
    ok(cb);
    broadcast(game);
  });

  socket.on('canje', ({ cards } = {}, cb) => {
    const p = requireTurn(cb, ['reinforce']);
    if (!p) return;
    if (!Array.isArray(cards) || cards.length !== 3) return fail(cb, 'Elegí exactamente 3 tarjetas.');
    const idx = [...new Set(cards.map(i => parseInt(i, 10)))];
    if (idx.length !== 3 || idx.some(i => isNaN(i) || i < 0 || i >= p.cards.length)) {
      return fail(cb, 'Selección de tarjetas inválida.');
    }
    const sel = idx.map(i => p.cards[i]);
    const syms = sel.map(c => c.sym).filter(s => s !== 'comodin');
    const uniq = [...new Set(syms)];
    const valid = syms.length < 3 // con comodín siempre vale
      || uniq.length === 1        // tres iguales
      || uniq.length === 3;       // tres distintas
    if (!valid) return fail(cb, 'El canje debe ser con 3 símbolos iguales o 3 distintos (el comodín vale por cualquiera).');
    p.trades++;
    const value = tradeValue(p.trades);
    game.reinforce.free += value;
    idx.sort((a, b) => b - a).forEach(i => {
      game.discard.push(p.cards[i].c);
      p.cards.splice(i, 1);
    });
    toast(game, `🎴 ${p.name} canjeó 3 tarjetas por ${value} ejércitos (${p.trades}º canje).`);
    ok(cb);
    broadcast(game);
  });

  socket.on('attack', ({ from, to } = {}, cb) => {
    const p = requireTurn(cb, ['attack']);
    if (!p) return;
    const A = game.countries[from], D = game.countries[to];
    if (!A || !D) return fail(cb, 'País inválido.');
    if (A.o !== p.id) return fail(cb, 'Ese país no es tuyo.');
    if (D.o === p.id) return fail(cb, 'No podés atacarte a vos mismo.');
    if (!DATA.isAdjacent(from, to)) return fail(cb, 'Esos países no son limítrofes.');
    if (A.a < 2) return fail(cb, 'Necesitás al menos 2 ejércitos para atacar.');
    game.pendingExtra = null; // si dejó pasar el refuerzo extra, se pierde
    doAttack(game, p, from, to);
    ok(cb);
    broadcast(game);
  });

  socket.on('occupyExtra', ({ n } = {}, cb) => {
    const p = requireTurn(cb, ['attack']);
    if (!p) return;
    const pe = game.pendingExtra;
    if (!pe) return fail(cb, 'No hay ocupación pendiente.');
    n = parseInt(n, 10) || 0;
    if (n < 0 || n > pe.max) return fail(cb, 'Cantidad inválida.');
    game.countries[pe.from].a -= n;
    game.countries[pe.to].a += n;
    game.pendingExtra = null;
    ok(cb);
    broadcast(game);
  });

  socket.on('toRegroup', (_payload, cb) => {
    const p = requireTurn(cb, ['attack']);
    if (!p) return;
    game.pendingExtra = null;
    game.phase = 'regroup';
    game.regroupLocks = {};
    ok(cb);
    broadcast(game);
  });

  socket.on('move', ({ from, to, n } = {}, cb) => {
    const p = requireTurn(cb, ['regroup']);
    if (!p) return;
    const A = game.countries[from], D = game.countries[to];
    if (!A || !D || A.o !== p.id || D.o !== p.id) return fail(cb, 'Movimiento inválido.');
    if (!DATA.isAdjacent(from, to)) return fail(cb, 'Esos países no son limítrofes.');
    n = parseInt(n, 10) || 0;
    const movable = A.a - 1 - (game.regroupLocks[from] || 0);
    if (n < 1 || n > movable) return fail(cb, `Podés mover entre 1 y ${movable} ejércitos.`);
    A.a -= n;
    D.a += n;
    // Los ejércitos recién movidos no pueden volver a moverse en este turno
    game.regroupLocks[to] = (game.regroupLocks[to] || 0) + n;
    ok(cb);
    broadcast(game);
  });

  socket.on('endTurn', (_payload, cb) => {
    const p = requireTurn(cb, ['attack', 'regroup']);
    if (!p) return;
    endTurn(game);
    ok(cb);
    broadcast(game);
  });

  socket.on('skipTurn', (_payload, cb) => {
    if (!game || !me) return fail(cb, 'No estás en una partida.');
    if (game.hostId !== me.id) return fail(cb, 'Solo el anfitrión puede saltear turnos.');
    if (game.status !== 'playing') return fail(cb, 'La partida no está en curso.');
    const cur = currentPlayer(game);
    if (cur.connected) return fail(cb, 'El jugador está conectado.');
    toast(game, `⏭ El anfitrión salteó el turno de ${cur.name} (desconectado).`);
    autoResolveTurn(game);
    ok(cb);
    broadcast(game);
  });

  socket.on('playAgain', (_payload, cb) => {
    if (!game || !me) return fail(cb, 'No estás en una partida.');
    if (game.hostId !== me.id) return fail(cb, 'Solo el anfitrión puede reiniciar.');
    if (game.status !== 'finished') return fail(cb, 'La partida no terminó.');
    game.players = game.players.filter(p => p.connected);
    for (const p of game.players) {
      p.cards = []; p.trades = 0; p.objective = null;
      p.effTargetId = null; p.objImpossible = false; p.eliminated = false;
    }
    if (!game.players.some(p => p.id === game.hostId) && game.players.length) {
      game.hostId = game.players[0].id;
    }
    game.status = 'lobby';
    game.phase = null;
    game.countries = {};
    game.winner = null;
    toast(game, 'Nueva partida: esperando que el anfitrión la inicie.');
    ok(cb);
    broadcast(game);
  });

  socket.on('pushSubscribe', ({ sub } = {}, cb) => {
    if (!game || !me) return fail(cb, 'No estás en una partida.');
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint)) {
      return fail(cb, 'Suscripción inválida.');
    }
    me.pushSub = sub;
    ok(cb);
  });

  socket.on('pushUnsubscribe', (_payload, cb) => {
    if (me) me.pushSub = null;
    ok(cb);
  });

  socket.on('chat', ({ text } = {}) => {
    if (!game || !me) return;
    text = String(text || '').trim().slice(0, 240);
    if (!text) return;
    const msg = { name: me.name, color: me.color, text, ts: Date.now() };
    game.chat.push(msg);
    if (game.chat.length > 100) game.chat.shift();
    io.to(game.code).emit('chat', msg);
  });

  socket.on('disconnect', () => {
    if (!game || !me) return;
    // Si el jugador ya se reconectó desde otro socket, no tocar nada.
    if (me.socketId !== socket.id) return;
    me.connected = false;
    me.socketId = null;
    if (game.status === 'lobby') {
      // En el lobby el jugador se va de verdad y libera el color
      game.players = game.players.filter(p => p.id !== me.id);
      if (game.players.length === 0) {
        games.delete(game.code);
        return;
      }
      if (game.hostId === me.id) game.hostId = game.players[0].id;
      toast(game, `${me.name} salió de la sala.`);
    } else {
      toast(game, `${me.name} se desconectó. Puede volver a entrar con el código ${game.code} y su nombre.`);
    }
    broadcast(game);
  });
});

// Limpieza de partidas abandonadas (sin actividad por 3 horas)
setInterval(() => {
  const now = Date.now();
  for (const [code, g] of games) {
    const anyConnected = g.players.some(p => p.connected);
    if (!anyConnected && now - g.lastActivity > 3 * 60 * 60 * 1000) games.delete(code);
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`TEG online escuchando en puerto ${PORT}`);
});

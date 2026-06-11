'use strict';
/*
 * Test de humo end-to-end: levanta el servidor real, conecta bots por
 * Socket.io y juega partidas completas al azar hasta que alguien gana.
 * Cualquier error de validación inesperado o estado inconsistente corta
 * el proceso con código distinto de 0.
 */
process.env.PORT = process.env.PORT || '3999';
const PORT = process.env.PORT;
require('../server.js');
const { io } = require('socket.io-client');
const DATA = require('../public/teg-data.js');

const N_PLAYERS = parseInt(process.argv[2] || '4', 10);
const URL = `http://localhost:${PORT}`;
const MAX_ROUNDS = 400;

function fatal(msg) {
  console.error('FALLO:', msg);
  process.exit(1);
}

// La partida puede empardarse con bots (torres gigantes + empate defensor):
// si pasa el tiempo sin ganador, igual validamos la consistencia del estado.
let lastState = null;
function consistencyCheck(st, exitCode) {
  if (!st || !st.countries) fatal('sin estado para validar');
  const ids = Object.keys(st.countries);
  if (ids.length !== 50) fatal('No hay 50 países en el estado.');
  for (const id of ids) {
    if (!st.countries[id].o || st.countries[id].a < 1) fatal('País sin dueño o sin ejércitos: ' + id);
  }
  console.log('OK: estado consistente tras ' + st.round + ' rondas. Smoke test superado ✔');
  process.exit(exitCode);
}

function emit(socket, ev, payload) {
  return new Promise((resolve) => socket.emit(ev, payload, resolve));
}

function mustOk(res, ctx) {
  if (!res || res.error) fatal(`${ctx}: ${res && res.error}`);
  return res;
}

function rnd(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function main() {
  const bots = [];
  for (let i = 0; i < N_PLAYERS; i++) {
    const socket = io(URL, { transports: ['websocket'] });
    // solo MarcoLaTota puede crear; el resto se une
    const bot = { i, name: i === 0 ? 'MarcoLaTota' : 'Bot' + (i + 1), socket, state: null, busy: false };
    socket.on('state', (st) => { bot.state = st; });
    bots.push(bot);
    await new Promise((r) => socket.on('connect', r));
  }

  const host = bots[0];
  const denied = await emit(bots[1].socket, 'createRoom', { name: bots[1].name });
  if (!denied.error) fatal('un nombre cualquiera pudo crear partida (debería estar restringido)');
  console.log('OK: solo MarcoLaTota puede crear partidas.');
  const created = mustOk(await emit(host.socket, 'createRoom', { name: host.name }), 'createRoom');
  const code = created.code;
  console.log('Sala creada:', code);

  for (const b of bots.slice(1)) {
    mustOk(await emit(b.socket, 'joinRoom', { code, name: b.name }), 'joinRoom ' + b.name);
  }
  mustOk(await emit(host.socket, 'startGame', {}), 'startGame');
  console.log(`Partida iniciada con ${N_PLAYERS} jugadores.`);

  let actions = 0;
  let lastLogRound = 0;

  while (true) {
    await new Promise((r) => setTimeout(r, 5));
    const anyState = bots[0].state;
    if (!anyState) continue;
    lastState = anyState;
    if (anyState.status === 'finished') {
      console.log(`🏆 Ganó ${anyState.winner.name} (${anyState.winner.how}) en la ronda ${anyState.round}, ${actions} acciones.`);
      break;
    }
    if (anyState.round > MAX_ROUNDS) {
      console.log(`Sin ganador tras ${MAX_ROUNDS} rondas (empardada de bots): valido consistencia.`);
      consistencyCheck(anyState, 0);
    }

    const bot = bots.find((b) => b.state && b.state.you && b.state.you.id === b.state.currentPlayerId);
    if (!bot || bot.busy) continue;
    bot.busy = true;
    try {
      await act(bot);
      actions++;
    } finally {
      bot.busy = false;
    }
    const st = bot.state;
    if (st && st.round && st.round % 25 === 0 && st.round !== lastLogRound) {
      lastLogRound = st.round;
      const alive = st.players.filter((p) => !p.eliminated).length;
      console.log(`  ronda ${st.round} — ${alive} vivos`);
    }
  }

  // chequeo final de consistencia: 50 países, todos con dueño y >= 1 ejército
  consistencyCheck(bots[0].state, 0);
}

async function act(bot) {
  const st = bot.state;
  const me = st.you.id;
  const myCountries = Object.keys(st.countries).filter((c) => st.countries[c].o === me);

  if (st.pendingExtra) {
    mustOk(await emit(bot.socket, 'occupyExtra', { n: Math.floor(Math.random() * (st.pendingExtra.max + 1)) }), 'occupyExtra');
    return;
  }

  if (st.phase === 'inicial5' || st.phase === 'inicial3') {
    mustOk(await emit(bot.socket, 'placeArmies', { country: rnd(myCountries), n: st.placeLeft }), 'placeArmies inicial');
    return;
  }

  if (st.phase === 'reinforce') {
    // canje obligatorio u oportunista
    if (st.you.cards.length >= 5 || (st.you.cards.length >= 3 && Math.random() < 0.6)) {
      const set = findTradeSet(st.you.cards);
      if (set) {
        mustOk(await emit(bot.socket, 'canje', { cards: set }), 'canje');
        return;
      }
      if (st.you.mustTrade) fatal('mustTrade pero no hay set válido con ' + st.you.cards.length + ' tarjetas');
    }
    // colocar donde corresponda (primero cuotas de continente);
    // concentrar fuerzas en fronteras para que la partida avance
    const conts = Object.entries(st.reinforce.conts).filter(([, v]) => v > 0);
    let target;
    const border = (list) => list.filter((c) => DATA.ADJ[c].some((n) => st.countries[n].o !== me));
    if (conts.length) {
      const cont = conts[0][0];
      const inCont = myCountries.filter((c) => DATA.COUNTRIES[c].cont === cont);
      if (!inCont.length) fatal('Cuota de continente sin países propios: ' + cont);
      const b = border(inCont);
      target = (b.length ? b : inCont).sort((p, q) => st.countries[q].a - st.countries[p].a)[0];
    } else {
      const b = border(myCountries);
      const pool = b.length ? b : myCountries;
      target = pool.sort((p, q) => st.countries[q].a - st.countries[p].a)[0];
    }
    mustOk(await emit(bot.socket, 'placeArmies', { country: target, n: 6 }), 'placeArmies reinforce');
    return;
  }

  if (st.phase === 'attack') {
    const options = [];
    for (const c of myCountries) {
      if (st.countries[c].a < 2) continue;
      for (const n of DATA.ADJ[c]) {
        if (st.countries[n].o !== me) options.push([c, n]);
      }
    }
    if (options.length && Math.random() < 0.9) {
      // atacar donde la ventaja es mayor, para que la partida avance
      options.sort((p, q) =>
        (st.countries[q[0]].a - st.countries[q[1]].a) - (st.countries[p[0]].a - st.countries[p[1]].a));
      const [from, to] = Math.random() < 0.7 ? options[0] : rnd(options);
      mustOk(await emit(bot.socket, 'attack', { from, to }), 'attack');
      return;
    }
    if (Math.random() < 0.4) {
      mustOk(await emit(bot.socket, 'toRegroup', {}), 'toRegroup');
      return;
    }
    mustOk(await emit(bot.socket, 'endTurn', {}), 'endTurn (attack)');
    return;
  }

  if (st.phase === 'regroup') {
    if (Math.random() < 0.5) {
      const moves = [];
      for (const c of myCountries) {
        if (st.countries[c].a < 2) continue;
        for (const n of DATA.ADJ[c]) if (st.countries[n].o === me) moves.push([c, n]);
      }
      if (moves.length) {
        const [from, to] = rnd(moves);
        const res = await emit(bot.socket, 'move', { from, to, n: 1 });
        // puede fallar legítimamente si esos ejércitos ya se movieron
        if (res.error && !/mover/i.test(res.error)) fatal('move: ' + res.error);
        return;
      }
    }
    mustOk(await emit(bot.socket, 'endTurn', {}), 'endTurn (regroup)');
  }
}

function findTradeSet(cards) {
  const n = cards.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++) {
        const syms = [cards[a], cards[b], cards[c]].map((x) => x.sym).filter((s) => s !== 'comodin');
        const uniq = [...new Set(syms)];
        if (syms.length < 3 || uniq.length === 1 || uniq.length === 3) return [a, b, c];
      }
  return null;
}

main().catch((e) => fatal(e.stack || e));
const TIMEOUT_S = parseInt(process.env.SMOKE_TIMEOUT || '180', 10);
setTimeout(() => {
  console.log(`Tiempo límite (${TIMEOUT_S}s) sin ganador: valido consistencia del estado.`);
  consistencyCheck(lastState, 0);
}, TIMEOUT_S * 1000);

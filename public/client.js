/* TEG online — cliente. Todo el estado real vive en el servidor;
 * acá solo se dibuja y se piden acciones. */
(function () {
  'use strict';
  const D = window.TEG_DATA;
  const socket = io();
  const $ = (id) => document.getElementById(id);
  // Enlace tolerante: si el elemento no existe (HTML viejo en caché),
  // no rompe el resto del script.
  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  const SVGNS = 'http://www.w3.org/2000/svg';

  // ------------------------------------------------------------ estado local
  let S = null;            // último snapshot del servidor
  let selected = null;     // país seleccionado (origen)
  let moveCtx = null;      // { from, to, max } para el modal de reagrupe
  let placeMult = 1;       // multiplicador de colocación (×1 / ×5)
  let objVisible = true;   // el objetivo se muestra claro; se puede ocultar
  let lastTurnPid = null;  // para detectar cambios de turno (notificaciones)
  let selCards = new Set();
  let unreadChat = 0;
  let diceQueue = [];       // ataques pendientes de mostrar
  let diceTimer = null;     // temporizador del dado en pantalla
  const DICE_MIN = 1900;    // mínimo de pantalla por dado
  const DICE_MAX = 3000;    // duración del último dado si no hay más en cola

  const session = {
    load() { try { return JSON.parse(localStorage.getItem('teg-session')) || null; } catch (e) { return null; } },
    save(code, token, name) {
      localStorage.setItem('teg-session', JSON.stringify({ code, token, name }));
      this.claim(token);
    },
    clear() { localStorage.removeItem('teg-session'); sessionStorage.removeItem('teg-own'); },
    // Cada pestaña "posee" un asiento: evita que una segunda pestaña del mismo
    // navegador le robe el lugar a la primera al auto-reconectar.
    claim(token) { sessionStorage.setItem('teg-own', token); },
    owns(ss) { return !!ss && sessionStorage.getItem('teg-own') === ss.token; }
  };

  function colorHex(key) { return (D.COLORS[key] || {}).hex || '#888'; }
  function colorText(key) { return (D.COLORS[key] || {}).text || '#fff'; }
  function colorName(key) { return (D.COLORS[key] || {}).name || key; }
  function player(id) { return (S && S.players.find(p => p.id === id)) || null; }
  function myTurn() { return S && S.you && S.currentPlayerId === S.you.id; }
  function isHost() { return S && S.you && S.hostId === S.you.id; }

  // ------------------------------------------------------------ pantallas
  function showScreen(name) {
    for (const sc of document.querySelectorAll('.screen')) sc.classList.remove('active');
    $('screen-' + name).classList.add('active');
  }

  // ============================================================ INICIO
  const savedSession = session.load();
  if (savedSession) {
    $('btn-resume').classList.remove('hidden');
    $('btn-resume').textContent = `↩ Volver a la partida ${savedSession.code}`;
    $('home-name').value = savedSession.name || '';
  }
  // ¿Código en la URL? (ej: /?sala=ABC123)
  const urlCode = new URLSearchParams(location.search).get('sala');
  if (urlCode) $('home-code').value = urlCode.toUpperCase();

  $('btn-create').addEventListener('click', () => {
    const name = $('home-name').value.trim();
    socket.emit('createRoom', { name }, (res) => {
      if (res.error) return ($('home-error').textContent = res.error);
      session.save(res.code, res.token, name);
    });
  });

  $('btn-join').addEventListener('click', joinFromHome);
  $('home-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFromHome(); });
  function joinFromHome() {
    const name = $('home-name').value.trim();
    const code = $('home-code').value.trim().toUpperCase();
    socket.emit('joinRoom', { code, name }, (res) => {
      if (res.error) return ($('home-error').textContent = res.error);
      session.save(res.code, res.token, name);
    });
  }

  $('btn-resume').addEventListener('click', () => {
    const ss = session.load();
    if (!ss) return;
    socket.emit('rejoin', { code: ss.code, token: ss.token }, (res) => {
      if (res.error) { $('home-error').textContent = res.error; session.clear(); $('btn-resume').classList.add('hidden'); }
      else session.claim(ss.token);
    });
  });

  // Reconexión automática: solo si esta pestaña es la dueña del asiento.
  // Una segunda pestaña queda en la pantalla de inicio (puede entrar como
  // otro jugador, o retomar el asiento a mano con el botón "Volver").
  socket.on('connect', () => {
    const ss = session.load();
    if (session.owns(ss)) socket.emit('rejoin', { code: ss.code, token: ss.token }, () => {});
  });

  // ------------------------------------------- índice de partidas activas
  function refreshGamesIndex() {
    if (!$('screen-home').classList.contains('active')) return;
    socket.emit('listGames', { name: $('home-name').value.trim() }, (res) => {
      if (!res || !res.games || !$('screen-home').classList.contains('active')) return;
      const wrap = $('games-index'), ul = $('games-list');
      if (!wrap) return;
      wrap.classList.toggle('hidden', res.games.length === 0);
      ul.innerHTML = '';
      for (const game of res.games) {
        const li = document.createElement('li');
        const info = document.createElement('div');
        info.className = 'g-info';
        const statusTxt = game.status === 'lobby'
          ? `En sala de espera · ${game.players.length} jugador${game.players.length !== 1 ? 'es' : ''}`
          : game.status === 'finished'
            ? `Terminada · ganó ${game.winnerName || '?'}`
            : `Ronda ${Math.max(1, game.round)} · turno de ${game.currentName}`;
        info.innerHTML = `<span class="g-code">${esc(game.code)}</span>` +
          `<div class="g-status">${esc(statusTxt)}</div>`;
        const row = document.createElement('div');
        row.className = 'g-players';
        for (const p of game.players) {
          const d = document.createElement('span');
          d.className = 'dot';
          d.style.background = colorHex(p.color);
          d.title = p.name + (p.connected ? '' : ' (desconectado)');
          if (p.eliminated || !p.connected) d.style.opacity = '.35';
          row.appendChild(d);
        }
        info.appendChild(row);
        li.appendChild(info);
        if (game.status !== 'finished') {
          const b = document.createElement('button');
          b.className = 'btn tiny';
          b.textContent = game.status === 'lobby' ? 'Unirse' : 'Entrar';
          b.addEventListener('click', () => {
            $('home-code').value = game.code;
            joinFromHome();
          });
          li.appendChild(b);
        }
        if (res.isAdmin) {
          const del = document.createElement('button');
          del.className = 'btn tiny warn';
          del.textContent = 'Borrar';
          del.addEventListener('click', () => {
            if (!confirm(`¿Borrar la partida ${game.code}?`)) return;
            socket.emit('deleteGame', { code: game.code, name: $('home-name').value.trim() }, (r) => {
              if (r && r.error) showToast(r.error);
              refreshGamesIndex();
            });
          });
          li.appendChild(del);
        }
        ul.appendChild(li);
      }
    });
  }
  setInterval(refreshGamesIndex, 8000);
  socket.on('connect', refreshGamesIndex);

  // ============================================================ LOBBY
  function renderLobby() {
    $('lobby-code').textContent = S.code;
    const ul = $('lobby-players');
    ul.innerHTML = '';
    for (const p of S.players) {
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = colorHex(p.color);
      if (!p.connected) dot.style.opacity = '.35';
      li.appendChild(dot);
      const nm = document.createElement('span');
      nm.textContent = p.name;
      li.appendChild(nm);
      if (!p.connected) {
        const off = document.createElement('span');
        off.className = 'offline';
        off.textContent = '⚡ off';
        li.appendChild(off);
      }
      const tag = document.createElement('span');
      tag.className = 'tagbadge';
      tag.textContent = (p.id === S.hostId ? '👑 anfitrión ' : '') + (p.id === S.you.id ? '(vos)' : '');
      li.appendChild(tag);
      if (S.you.isAdmin && p.id !== S.you.id) {
        const kick = document.createElement('button');
        kick.className = 'btn tiny warn';
        kick.textContent = '✕';
        kick.title = 'Echar de la sala';
        kick.addEventListener('click', () => {
          if (!confirm(`¿Echar a ${p.name} de la sala?`)) return;
          socket.emit('kickPlayer', { playerId: p.id }, (res) => {
            if (res && res.error) $('lobby-error').textContent = res.error;
          });
        });
        li.appendChild(kick);
      }
      ul.appendChild(li);
    }
    const sw = $('color-swatches');
    sw.innerHTML = '';
    for (const key of Object.keys(D.COLORS)) {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = colorHex(key);
      b.title = colorName(key);
      const taken = S.players.some(p => p.color === key && p.id !== S.you.id);
      if (taken) b.classList.add('taken');
      if (S.you.color === key) b.classList.add('mine');
      b.addEventListener('click', () => socket.emit('pickColor', { color: key }, (res) => {
        if (res.error) $('lobby-error').textContent = res.error;
      }));
      sw.appendChild(b);
    }
    const canStart = isHost() && S.players.length >= 2;
    $('btn-start').classList.toggle('hidden', !isHost());
    $('btn-start').disabled = !canStart;
    $('lobby-wait').textContent = isHost()
      ? (S.players.length < 2 ? 'Esperando al menos un jugador más…' : `${S.players.length} jugadores listos.`)
      : 'Esperando que el anfitrión inicie la partida…';
  }

  $('btn-copy').addEventListener('click', async () => {
    const url = `${location.origin}/?sala=${S.code}`;
    try { await navigator.clipboard.writeText(`Jugamos al TEG 🎲 Entrá acá: ${url} (código ${S.code})`); $('btn-copy').textContent = '¡Copiado!'; }
    catch (e) { $('btn-copy').textContent = S.code; }
    setTimeout(() => ($('btn-copy').textContent = 'Copiar'), 1600);
  });

  $('btn-start').addEventListener('click', () => {
    socket.emit('startGame', {}, (res) => { if (res.error) $('lobby-error').textContent = res.error; });
  });

  // ============================================================ MAPA SVG
  const VB = { w: 858, h: 613 }; // dimensiones de board.jpg
  let view = { x: 0, y: 0, w: VB.w, h: VB.h };
  const map = $('map');
  const countryEls = {};

  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVGNS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  function buildMap() {
    map.setAttribute('viewBox', `0 0 ${VB.w} ${VB.h}`);
    map.innerHTML = '';

    // Fondo: el tablero clásico (las fronteras y puentes ya están dibujados)
    map.appendChild(svgEl('image', {
      href: 'board.jpg', x: 0, y: 0, width: VB.w, height: VB.h,
      preserveAspectRatio: 'none'
    }));

    const gCountries = svgEl('g', {});
    map.appendChild(gCountries);

    // Fichas sobre cada país
    for (const c of Object.values(D.COUNTRIES)) {
      const g = svgEl('g', { class: 'country', 'data-id': c.id });
      g.appendChild(svgEl('circle', { cx: c.x, cy: c.y, r: 24, fill: 'transparent' })); // zona táctil
      g.appendChild(svgEl('circle', { class: 'ring', cx: c.x, cy: c.y, r: 21 }));
      g.appendChild(svgEl('circle', { class: 'body', cx: c.x, cy: c.y, r: 15, fill: '#39414f' }));
      const troops = svgEl('text', { class: 'troops', x: c.x, y: c.y, fill: '#fff' });
      troops.textContent = '';
      g.appendChild(troops);
      const title = svgEl('title', {});
      title.textContent = c.name;
      g.appendChild(title);
      gCountries.appendChild(g);
      countryEls[c.id] = g;
    }
    applyView();
  }

  function applyView() {
    map.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  }

  function fitView() {
    view = { x: 0, y: 0, w: VB.w, h: VB.h };
    applyView();
  }

  function zoomAt(cx, cy, factor) {
    const nw = Math.min(VB.w * 1.15, Math.max(VB.w / 6, view.w * factor));
    const k = nw / view.w;
    view.x = cx - (cx - view.x) * k;
    view.y = cy - (cy - view.y) * k;
    view.w = nw;
    view.h = view.h * k;
    clampView();
    applyView();
  }

  function clampView() {
    const mX = VB.w * 0.25, mY = VB.h * 0.25;
    view.x = Math.max(-mX, Math.min(VB.w + mX - view.w, view.x));
    view.y = Math.max(-mY, Math.min(VB.h + mY - view.h, view.y));
  }

  function clientToSvg(px, py) {
    const r = map.getBoundingClientRect();
    return {
      x: view.x + ((px - r.left) / r.width) * view.w,
      y: view.y + ((py - r.top) / r.height) * view.h
    };
  }

  // Pan + pinch con pointer events
  const pointers = new Map();
  let panStart = null, pinchStart = null, movedFar = false;

  map.addEventListener('pointerdown', (e) => {
    map.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    movedFar = false;
    if (pointers.size === 1) {
      panStart = { px: e.clientX, py: e.clientY, vx: view.x, vy: view.y };
    } else if (pointers.size === 2) {
      const [p1, p2] = [...pointers.values()];
      pinchStart = { d: Math.hypot(p1.x - p2.x, p1.y - p2.y), view: { ...view }, cx: (p1.x + p2.x) / 2, cy: (p1.y + p2.y) / 2 };
      panStart = null;
    }
  });
  map.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinchStart) {
      const [p1, p2] = [...pointers.values()];
      const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      if (Math.abs(d - pinchStart.d) > 4) movedFar = true;
      const factor = pinchStart.d / Math.max(20, d);
      const c = clientToSvg(pinchStart.cx, pinchStart.cy);
      view = { ...pinchStart.view };
      zoomAt(c.x, c.y, factor);
    } else if (panStart) {
      const r = map.getBoundingClientRect();
      const dx = (e.clientX - panStart.px) * (view.w / r.width);
      const dy = (e.clientY - panStart.py) * (view.h / r.height);
      if (Math.hypot(e.clientX - panStart.px, e.clientY - panStart.py) > 8) movedFar = true;
      view.x = panStart.vx - dx;
      view.y = panStart.vy - dy;
      clampView();
      applyView();
    }
  });
  function endPointer(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (pointers.size === 1) {
      const [p] = [...pointers.values()];
      panStart = { px: p.x, py: p.y, vx: view.x, vy: view.y };
    } else if (pointers.size === 0) panStart = null;
  }
  map.addEventListener('pointerup', endPointer);
  map.addEventListener('pointercancel', endPointer);
  // Tap para seleccionar/colocar: se detecta con elementFromPoint en pointerup.
  // (El setPointerCapture del arrastre desvía el 'click' hacia el mapa, así
  // que no se puede confiar en el listener de 'click' de cada país.)
  map.addEventListener('pointerup', (e) => {
    if (movedFar || pointers.size !== 0) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const g = el && el.closest && el.closest('.country');
    if (g && g.dataset.id) onCountryTap(g.dataset.id);
  });
  map.addEventListener('wheel', (e) => {
    e.preventDefault();
    const c = clientToSvg(e.clientX, e.clientY);
    zoomAt(c.x, c.y, e.deltaY > 0 ? 1.15 : 0.87);
  }, { passive: false });

  $('zoom-in').addEventListener('click', () => zoomAt(view.x + view.w / 2, view.y + view.h / 2, 0.8));
  $('zoom-out').addEventListener('click', () => zoomAt(view.x + view.w / 2, view.y + view.h / 2, 1.25));
  $('zoom-fit').addEventListener('click', fitView);

  // ------------------------------------------------------------ interacción
  function onCountryTap(id) {
    if (movedFar || !S || S.status !== 'playing' || !myTurn()) return;
    const me = S.you.id;
    const ct = S.countries[id];
    const phase = S.phase;

    if (phase === 'inicial5' || phase === 'inicial3' || phase === 'reinforce') {
      if (ct.o !== me) return flash('Ese país no es tuyo.');
      socket.emit('placeArmies', { country: id, n: placeMult }, (res) => {
        if (res.error) flash(res.error);
      });
      return;
    }

    if (phase === 'attack') {
      if (ct.o === me) {
        selected = (selected === id) ? null : (ct.a > 1 ? id : selected);
        if (ct.a <= 1 && selected !== id) flash('Necesitás al menos 2 ejércitos para atacar desde ahí.');
        renderMap();
        return;
      }
      if (selected && D.isAdjacent(selected, id)) {
        socket.emit('attack', { from: selected, to: id }, (res) => { if (res.error) flash(res.error); });
      }
      return;
    }

    if (phase === 'regroup') {
      if (ct.o === me) {
        if (!selected) { selected = id; renderMap(); return; }
        if (selected === id) { selected = null; renderMap(); return; }
        if (D.isAdjacent(selected, id)) {
          const from = S.countries[selected];
          const max = from.a - 1; // el servidor valida los "bloqueados" igual
          if (max < 1) { flash('No quedan ejércitos para mover ahí.'); return; }
          openMoveModal(selected, id, max);
        } else {
          selected = id;
          renderMap();
        }
      }
    }
  }

  // ------------------------------------------------------------ render mapa
  function renderMap() {
    if (!S || !S.countries) return;
    const me = S.you ? S.you.id : null;
    const phase = S.phase;
    const mine = myTurn();
    for (const id of Object.keys(D.COUNTRIES)) {
      const g = countryEls[id];
      const ct = S.countries[id];
      const owner = player(ct.o);
      const body = g.querySelector('.body');
      const troops = g.querySelector('.troops');
      body.setAttribute('fill', owner ? colorHex(owner.color) : '#39414f');
      troops.textContent = ct.a;
      troops.setAttribute('fill', owner ? colorText(owner.color) : '#fff');
      g.classList.remove('selectable', 'selected', 'target', 'friendly-target');

      if (!mine || S.winner) continue;
      if (phase === 'inicial5' || phase === 'inicial3') {
        if (ct.o === me) g.classList.add('selectable');
      } else if (phase === 'reinforce') {
        if (ct.o === me && canPlaceAt(id)) g.classList.add('selectable');
      } else if (phase === 'attack') {
        if (selected === id) g.classList.add('selected');
        else if (selected && ct.o !== me && D.isAdjacent(selected, id)) g.classList.add('target');
        else if (!selected && ct.o === me && ct.a > 1) g.classList.add('selectable');
      } else if (phase === 'regroup') {
        if (selected === id) g.classList.add('selected');
        else if (selected && ct.o === me && D.isAdjacent(selected, id)) g.classList.add('friendly-target');
        else if (!selected && ct.o === me && ct.a > 1) g.classList.add('selectable');
      }
    }
  }

  function canPlaceAt(id) {
    if (!S.reinforce) return false;
    if (S.you.mustTrade) return false;
    if (S.reinforce.free > 0) return true;
    const cont = D.COUNTRIES[id].cont;
    return (S.reinforce.conts[cont] || 0) > 0;
  }

  // ------------------------------------------------------------ barra de acción
  function renderActionBar() {
    const info = $('action-info');
    const btns = $('action-buttons');
    btns.innerHTML = '';
    if (!S || S.status !== 'playing') { info.textContent = ''; return; }

    const cur = player(S.currentPlayerId);
    const mine = myTurn();

    if (!mine) {
      info.innerHTML = `Turno de <b>${esc(cur.name)}</b> · ${phaseName(S.phase)}`;
      return;
    }

    const mkBtn = (label, cls, fn) => {
      const b = document.createElement('button');
      b.className = 'btn ' + cls;
      b.textContent = label;
      b.addEventListener('click', fn);
      btns.appendChild(b);
      return b;
    };
    const multBtn = () => mkBtn('×' + placeMult, '', () => {
      placeMult = placeMult === 1 ? 5 : 1;
      renderActionBar();
    });

    if (S.phase === 'inicial5' || S.phase === 'inicial3') {
      info.innerHTML = `Tocá tus países para colocar <b>${S.placeLeft}</b> ejércitos`;
      multBtn();
    } else if (S.phase === 'reinforce') {
      const conts = Object.entries(S.reinforce.conts).filter(([, v]) => v > 0)
        .map(([k, v]) => `${D.CONTINENTS[k].name}: <b>${v}</b>`).join(' · ');
      if (S.you.mustTrade) {
        info.innerHTML = '⚠️ Tenés 5+ tarjetas: canjeá antes de colocar (abrí el panel ☰).';
        mkBtn('Abrir tarjetas', 'primary', () => openPanel('sidebar'));
      } else {
        info.innerHTML = `Colocá ejércitos — libres: <b>${S.reinforce.free}</b>${conts ? ' · ' + conts : ''}`;
        multBtn();
        if (S.you.cards.length >= 3) mkBtn('🎴 Canjear', '', () => openPanel('sidebar'));
      }
    } else if (S.phase === 'attack') {
      info.innerHTML = selected
        ? `Atacando desde <b>${D.COUNTRIES[selected].name}</b>: tocá un país enemigo limítrofe`
        : 'Tocá un país tuyo (con 2+ ejércitos) para atacar';
      mkBtn('Reagrupar ➜', '', () => {
        selected = null;
        socket.emit('toRegroup', {}, (res) => { if (res.error) flash(res.error); });
      });
      mkBtn('Terminar turno', 'primary', endTurn);
    } else if (S.phase === 'regroup') {
      info.innerHTML = selected
        ? `Moviendo desde <b>${D.COUNTRIES[selected].name}</b>: tocá un país tuyo limítrofe`
        : 'Reagrupá: tocá origen y destino (opcional)';
      mkBtn('Terminar turno', 'primary', endTurn);
    }
  }

  function endTurn() {
    selected = null;
    socket.emit('endTurn', {}, (res) => { if (res.error) flash(res.error); });
  }

  function phaseName(ph) {
    return {
      inicial5: 'colocando 5 ejércitos', inicial3: 'colocando 3 ejércitos',
      reinforce: 'incorporando ejércitos', attack: 'atacando', regroup: 'reagrupando'
    }[ph] || '';
  }

  // ------------------------------------------------------------ header
  function renderHeader() {
    const cur = player(S.currentPlayerId);
    const banner = $('turn-banner');
    const txt = $('turn-text');
    if (S.status === 'finished') {
      banner.classList.remove('my-turn');
      txt.textContent = '🏁 Partida terminada';
      return;
    }
    if (!cur) { txt.textContent = '—'; return; }
    if (myTurn()) {
      banner.classList.add('my-turn');
      txt.textContent = `▶ ¡Tu turno! (${phaseName(S.phase)}) · Ronda ${Math.max(1, S.round)}`;
      document.title = '🎲 ¡Tu turno! — TEG';
    } else {
      banner.classList.remove('my-turn');
      txt.textContent = `Turno de ${cur.name} · ${phaseName(S.phase)}`;
      document.title = 'TEG · Plan Táctico y Estratégico de la Guerra';
    }
  }

  // ------------------------------------------------------------ sidebar
  function renderSidebar() {
    $('side-code').textContent = S.code;
    const ul = $('side-players');
    ul.innerHTML = '';
    for (const p of S.players) {
      const li = document.createElement('li');
      if (p.id === S.currentPlayerId) li.classList.add('current');
      if (p.eliminated) li.classList.add('dead');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = colorHex(p.color);
      li.appendChild(dot);
      const nm = document.createElement('span');
      nm.textContent = p.name + (p.id === S.you.id ? ' (vos)' : '');
      li.appendChild(nm);
      if (!p.connected && !p.eliminated) {
        const off = document.createElement('span');
        off.className = 'offline';
        off.textContent = '⚡ off';
        li.appendChild(off);
      }
      const st = document.createElement('span');
      st.className = 'stats';
      st.textContent = `${p.countryCount}🏳 ${p.armyCount}⚔ ${p.cardCount}🎴`;
      li.appendChild(st);
      ul.appendChild(li);
    }

    // objetivo
    const obj = $('side-objective');
    if (S.you.objective) {
      let extra = '';
      if (S.you.objective.type === 'destroy' && S.you.objective.targetName && !S.you.objective.impossible) {
        extra = `<span class="obj-extra">→ Tu blanco actual: ${esc(S.you.objective.targetName)}</span>`;
      }
      if (S.you.objective.impossible) {
        extra = '<span class="obj-extra">⚠️ Tu blanco fue destruido por otro: ahora vale solo el objetivo común (30 países).</span>';
      }
      obj.innerHTML = esc(S.you.objective.text) +
        '<span class="obj-extra">Objetivo común: ocupar 30 países.</span>' + extra;
    } else {
      obj.textContent = 'Ocupar 30 países.';
    }
    obj.classList.toggle('hidden-obj', !objVisible);

    // tarjetas
    $('side-cards-count').textContent = `(${S.you.cards.length})`;
    const wrap = $('side-cards');
    wrap.innerHTML = '';
    selCards = new Set([...selCards].filter(i => i < S.you.cards.length));
    S.you.cards.forEach((card, i) => {
      const div = document.createElement('div');
      div.className = 'card' + (selCards.has(i) ? ' sel' : '') + (card.used ? ' used' : '');
      div.title = card.used ? 'Premio de 2 ejércitos ya usado' : '';
      div.innerHTML = `<span class="sym">${D.SYMBOLS[card.sym].icon}</span>` +
        `<span class="cn">${esc(D.COUNTRIES[card.c].name)}<br><small>${D.SYMBOLS[card.sym].name}</small></span>`;
      div.addEventListener('click', () => {
        if (selCards.has(i)) selCards.delete(i);
        else if (selCards.size < 3) selCards.add(i);
        renderSidebar();
      });
      wrap.appendChild(div);
    });
    const canjeOk = myTurn() && S.phase === 'reinforce' && selCards.size === 3;
    $('btn-canje').classList.toggle('hidden', S.you.cards.length < 3);
    $('btn-canje').disabled = !canjeOk;
    $('canje-hint').textContent =
      S.you.cards.length >= 3
        ? (myTurn() && S.phase === 'reinforce'
            ? 'Elegí 3 tarjetas: 3 símbolos iguales o 3 distintos (🃏 vale por cualquiera).'
            : 'Podés canjear en tu fase de incorporación de ejércitos.')
        : '';

    // saltear turno (host) / salir
    const cur = player(S.currentPlayerId);
    $('btn-skip').classList.toggle('hidden',
      !(isHost() && S.status === 'playing' && cur && !cur.connected && cur.id !== S.you.id));
  }

  // ------------------------------------------------------- notificaciones
  // Dos niveles: notificación en la página (pestaña abierta en 2º plano) y
  // Web Push vía service worker (sirve con el teléfono bloqueado).
  const notifSupported = 'Notification' in window;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  function notifOn() {
    return notifSupported && localStorage.getItem('teg-notif') === '1' && Notification.permission === 'granted';
  }
  function pushOn() { return notifOn() && localStorage.getItem('teg-push') === '1'; }

  function renderNotifBtn() {
    if (!$('btn-notif')) return;
    $('btn-notif').classList.remove('hidden');
    $('btn-notif').textContent = notifOn() ? '🔔' : '🔕';
  }
  renderNotifBtn();

  function urlB64ToU8(base64) {
    const padding = '='.repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map((ch) => ch.charCodeAt(0)));
  }

  async function subscribePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
    try {
      const reg = await navigator.serviceWorker.ready;
      const res = await fetch('/vapid-public-key');
      const { key } = await res.json();
      if (!key) return false;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToU8(key)
      });
      socket.emit('pushSubscribe', { sub: sub.toJSON() }, () => {});
      localStorage.setItem('teg-push', '1');
      return true;
    } catch (e) {
      localStorage.setItem('teg-push', '0');
      return false;
    }
  }

  async function unsubscribePush() {
    localStorage.setItem('teg-push', '0');
    socket.emit('pushUnsubscribe', {}, () => {});
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    } catch (e) { /* sin drama */ }
  }

  on('btn-notif', 'click', async () => {
    if (!notifSupported) {
      // iPhone/iPad en Safari "de pestaña": hay que instalar el juego primero
      if (isIOS) { $('modal-ios').classList.remove('hidden'); showOverlay(true); }
      else showToast('Este navegador no soporta notificaciones.');
      return;
    }
    if (notifOn()) {
      localStorage.setItem('teg-notif', '0');
      await unsubscribePush();
      showToast('🔕 Avisos de turno desactivados.');
    } else {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        localStorage.setItem('teg-notif', '1');
        const push = await subscribePush();
        showToast(push
          ? '🔔 Listo: te avisamos cuando sea tu turno, incluso con el teléfono bloqueado.'
          : '🔔 Avisos activados (con esta pestaña abierta).', 'big');
      } else {
        showToast('El navegador bloqueó las notificaciones (revisá los permisos del sitio).');
      }
    }
    renderNotifBtn();
  });
  on('btn-ios-ok', 'click', () => { $('modal-ios').classList.add('hidden'); syncOverlay(); });

  // Si ya teníamos push activado, re-enviar la suscripción al (re)entrar
  // a la partida (el servidor pudo haberse reiniciado).
  let pushSynced = false;
  function syncPushSubscription() {
    if (pushSynced || !pushOn()) return;
    pushSynced = true;
    subscribePush();
  }

  function notify(title, body) {
    if (!notifOn()) return;
    if (pushOn()) return; // el service worker ya se encarga (evita duplicados)
    if (!document.hidden && document.hasFocus()) return; // ya estás mirando
    try {
      const n = new Notification(title, { body, tag: 'teg-turno', renotify: true });
      n.onclick = () => { window.focus(); n.close(); };
    } catch (e) { /* algunos navegadores piden service worker; lo ignoramos */ }
  }
  function nextAlivePlayer(st) {
    // el orden de st.players ES el orden de turnos
    const idx = st.players.findIndex(p => p.id === st.currentPlayerId);
    if (idx < 0) return null;
    for (let k = 1; k <= st.players.length; k++) {
      const p = st.players[(idx + k) % st.players.length];
      if (!p.eliminated) return p;
    }
    return null;
  }
  function checkTurnNotify(st) {
    if (st.status !== 'playing' || !st.you || st.currentPlayerId === lastTurnPid) return;
    const prev = lastTurnPid;
    lastTurnPid = st.currentPlayerId;
    if (prev === null) return; // primer estado tras cargar: no avisar
    if (st.currentPlayerId === st.you.id) {
      notify('🎲 ¡Es tu turno!', `Te toca jugar en la partida ${st.code}.`);
    } else {
      const nx = nextAlivePlayer(st);
      const cur = st.players.find(p => p.id === st.currentPlayerId);
      if (nx && nx.id === st.you.id) {
        notify('⏳ Sos el próximo', `Está jugando ${cur ? cur.name : 'otro'} y después venís vos.`);
      }
    }
  }

  $('btn-obj-toggle').addEventListener('click', () => {
    objVisible = !objVisible;
    $('btn-obj-toggle').textContent = objVisible ? '🙈 Ocultar' : '👁 Mostrar';
    $('side-objective').classList.toggle('hidden-obj', !objVisible);
  });

  $('btn-canje').addEventListener('click', () => {
    socket.emit('canje', { cards: [...selCards] }, (res) => {
      if (res.error) flash(res.error);
      else selCards.clear();
    });
  });

  $('btn-skip').addEventListener('click', () => {
    socket.emit('skipTurn', {}, (res) => { if (res.error) flash(res.error); });
  });

  $('btn-leave').addEventListener('click', () => {
    if (!confirm('¿Salir de la partida? Podés volver después con el código y tu nombre.')) return;
    session.clear();
    location.reload();
  });

  // ------------------------------------------------------------ paneles
  function openPanel(id) {
    $(id).classList.add('open');
    if (id === 'chatpanel') {
      unreadChat = 0;
      renderChatBadge();
      const m = $('chat-msgs');
      m.scrollTop = m.scrollHeight;
    }
  }
  function closePanel(id) { $(id).classList.remove('open'); }
  $('btn-sidebar').addEventListener('click', () => { closePanel('chatpanel'); openPanel('sidebar'); });
  $('btn-chat').addEventListener('click', () => { closePanel('sidebar'); openPanel('chatpanel'); });
  for (const b of document.querySelectorAll('.panel-close')) {
    b.addEventListener('click', () => closePanel(b.dataset.close));
  }
  $('map-wrap').addEventListener('pointerdown', () => { closePanel('sidebar'); closePanel('chatpanel'); });

  // ------------------------------------------------- pestañas chat/historial
  function showTab(which) {
    $('tab-chat').classList.toggle('active', which === 'chat');
    $('tab-hist').classList.toggle('active', which === 'hist');
    $('chat-msgs').classList.toggle('hidden', which !== 'chat');
    $('chat-form').classList.toggle('hidden', which !== 'chat');
    $('hist-list').classList.toggle('hidden', which !== 'hist');
    if (which === 'chat') {
      const m = $('chat-msgs');
      m.scrollTop = m.scrollHeight;
    }
  }
  on('tab-chat', 'click', () => showTab('chat'));
  on('tab-hist', 'click', () => showTab('hist'));

  // Historial por turno (lo más nuevo arriba)
  function renderHistory() {
    const list = $('hist-list');
    if (!list || !S || !S.history) return;
    list.innerHTML = '';
    const entries = [...S.history].reverse();
    if (!entries.length) {
      list.innerHTML = '<p class="hint">Todavía no pasó nada. ¡Que empiece la guerra!</p>';
      return;
    }
    for (const e of entries) {
      const div = document.createElement('div');
      div.className = 'hist-turn';
      const head = document.createElement('div');
      head.className = 'h-head';
      head.innerHTML = `<span class="dot" style="background:${colorHex(e.color)}"></span>` +
        `<span>${esc(e.name)}</span>` +
        `<span class="h-round">${e.initial ? 'Colocación inicial' : 'Ronda ' + e.round}</span>`;
      div.appendChild(head);
      if (e.lines.length) {
        const ul = document.createElement('ul');
        for (const line of e.lines) {
          const li = document.createElement('li');
          li.textContent = line;
          ul.appendChild(li);
        }
        div.appendChild(ul);
      } else {
        const em = document.createElement('div');
        em.className = 'h-empty';
        em.textContent = entries.indexOf(e) === 0 ? 'jugando…' : 'pasó sin novedades';
        div.appendChild(em);
      }
      list.appendChild(div);
    }
  }

  // ------------------------------------------------------------ chat
  function addChatMsg(msg, scroll) {
    const div = document.createElement('div');
    div.className = 'msg';
    div.innerHTML = `<b style="color:${colorHex(msg.color)}">${esc(msg.name)}:</b>${esc(msg.text)}`;
    const box = $('chat-msgs');
    box.appendChild(div);
    while (box.children.length > 120) box.removeChild(box.firstChild);
    if (scroll) box.scrollTop = box.scrollHeight;
  }
  $('chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('chat-input').value.trim();
    if (!text) return;
    socket.emit('chat', { text });
    $('chat-input').value = '';
  });
  let lastChatTs = 0;
  function syncChat(list, scroll, notify) {
    for (const msg of list) {
      if (!msg.ts || msg.ts <= lastChatTs) continue;
      lastChatTs = msg.ts;
      addChatMsg(msg, scroll);
      if (notify && !$('chatpanel').classList.contains('open')) {
        unreadChat++;
        renderChatBadge();
      }
    }
  }
  socket.on('chat', (msg) => syncChat([msg], true, true));
  function renderChatBadge() {
    const b = $('chat-badge');
    b.classList.toggle('hidden', unreadChat === 0);
    b.textContent = unreadChat > 9 ? '9+' : unreadChat;
  }

  // ------------------------------------------------------------ toasts
  socket.on('toast', ({ text, type }) => showToast(text, type));
  socket.on('gameDeleted', ({ code }) => {
    session.clear();
    showToast(`La partida ${code} fue eliminada por el administrador.`, '');
    setTimeout(() => location.reload(), 1200);
  });
  socket.on('kicked', ({ code }) => {
    session.clear();
    showToast(`Te sacaron de la partida ${code}.`, '');
    setTimeout(() => location.reload(), 1200);
  });
  function showToast(text, type) {
    const t = document.createElement('div');
    t.className = 'toast ' + (type || '');
    t.textContent = text;
    $('toasts').appendChild(t);
    while ($('toasts').children.length > 4) $('toasts').removeChild($('toasts').firstChild);
    setTimeout(() => t.classList.add('fade'), 3500);
    setTimeout(() => t.remove(), 4100);
  }
  function flash(msg) { showToast(msg, ''); }

  // ------------------------------------------------------------ dados
  socket.on('combat', (c) => {
    diceQueue.push(c);
    if (!diceTimer) showNextDice();
  });
  function showNextDice() {
    const c = diceQueue.shift();
    if (!c) {
      diceTimer = null;
      $('dice-modal').classList.add('hidden');
      return;
    }
    $('dice-title').textContent = `${c.fromName} ⚔ ${c.toName}`;
    $('dice-att-name').textContent = c.attacker.name;
    $('dice-def-name').textContent = c.defender.name;
    renderDice($('dice-att'), c.attacker);
    renderDice($('dice-def'), c.defender);
    $('dice-result').textContent = c.conquered
      ? `🎉 ¡${c.attacker.name} conquistó ${c.toName}!`
      : `Bajas — ${c.attacker.name}: ${c.attacker.loss} · ${c.defender.name}: ${c.defender.loss}`;
    $('dice-result').style.color = c.conquered ? '#7ee2a0' : '#aeb6c4';
    $('dice-modal').classList.remove('hidden');
    // Si hay más ataques en cola, dar el mínimo; si no, dejar el último más tiempo.
    diceTimer = setTimeout(showNextDice, diceQueue.length ? DICE_MIN : DICE_MAX);
  }
  function renderDice(el, side) {
    el.innerHTML = '';
    side.dice.forEach((v) => {
      const d = document.createElement('div');
      d.className = 'die';
      d.style.borderColor = colorHex(side.color);
      d.textContent = v;
      el.appendChild(d);
    });
  }

  // ------------------------------------------------------------ modales
  function showOverlay(show) { $('overlay').classList.toggle('hidden', !show); }

  function renderExtraModal() {
    const pe = S && S.pendingExtra;
    const show = !!pe && myTurn() && S.phase === 'attack' && !S.winner;
    $('modal-extra').classList.toggle('hidden', !show);
    if (!show) { syncOverlay(); return; }
    showOverlay(true);
    $('extra-text').textContent =
      `Ya pasó 1 ejército a ${D.COUNTRIES[pe.to].name}. ¿Querés pasar más desde ${D.COUNTRIES[pe.from].name}?`;
    const wrap = $('extra-buttons');
    wrap.innerHTML = '';
    for (let n = 0; n <= pe.max; n++) {
      const b = document.createElement('button');
      b.className = 'btn ' + (n === pe.max ? 'primary' : '');
      b.textContent = n === 0 ? 'No, así está bien' : `+${n} ejército${n > 1 ? 's' : ''}`;
      b.addEventListener('click', () => {
        socket.emit('occupyExtra', { n }, (res) => { if (res.error) flash(res.error); });
      });
      wrap.appendChild(b);
    }
  }

  function openMoveModal(from, to, max) {
    moveCtx = { from, to, max, n: 1 };
    $('move-text').textContent = `${D.COUNTRIES[from].name} ➜ ${D.COUNTRIES[to].name} (máx. ${max})`;
    $('move-n').textContent = '1';
    $('modal-move').classList.remove('hidden');
    showOverlay(true);
  }
  function closeMoveModal() {
    moveCtx = null;
    $('modal-move').classList.add('hidden');
    syncOverlay();
  }
  $('move-minus').addEventListener('click', () => { if (moveCtx && moveCtx.n > 1) $('move-n').textContent = --moveCtx.n; });
  $('move-plus').addEventListener('click', () => { if (moveCtx && moveCtx.n < moveCtx.max) $('move-n').textContent = ++moveCtx.n; });
  $('move-max').addEventListener('click', () => { if (moveCtx) $('move-n').textContent = (moveCtx.n = moveCtx.max); });
  $('move-cancel').addEventListener('click', closeMoveModal);
  $('move-ok').addEventListener('click', () => {
    if (!moveCtx) return;
    socket.emit('move', { from: moveCtx.from, to: moveCtx.to, n: moveCtx.n }, (res) => {
      if (res.error) flash(res.error);
      else { selected = null; }
      closeMoveModal();
    });
  });

  // Al empezar la partida (países ya repartidos), el objetivo se muestra claro;
  // el botón 🎯 del encabezado lo vuelve a mostrar cuando quieras.
  function objectiveHtml() {
    const o = S.you.objective;
    let html = esc(o.text);
    if (o.type === 'destroy' && o.targetName && !o.impossible) {
      html += `<span class="obj-extra">→ En esta partida tu blanco es: <b>${esc(o.targetName)}</b></span>`;
    }
    if (o.impossible) {
      html += '<span class="obj-extra">⚠️ Otro destruyó a tu blanco: ahora tu meta es el objetivo común (30 países).</span>';
    }
    return html;
  }
  function showObjectiveModal() {
    if (!S || S.status !== 'playing' || !S.you || !S.you.objective) return;
    $('obj-modal-text').innerHTML = objectiveHtml();
    $('modal-objective').classList.remove('hidden');
    showOverlay(true);
  }
  function renderObjectiveModal() {
    if (!S || S.status !== 'playing' || !S.you || !S.you.objective) return;
    const marker = S.code + '|' + S.you.objective.text;
    if (localStorage.getItem('teg-obj-seen') === marker) return;
    showObjectiveModal();
  }
  on('btn-objective', 'click', showObjectiveModal);
  on('btn-obj-ok', 'click', () => {
    if (S && S.you && S.you.objective) {
      localStorage.setItem('teg-obj-seen', S.code + '|' + S.you.objective.text);
    }
    $('modal-objective').classList.add('hidden');
    syncOverlay();
  });

  function renderGameOver() {
    const show = S && S.status === 'finished' && S.winner;
    $('modal-gameover').classList.toggle('hidden', !show);
    if (!show) { syncOverlay(); return; }
    showOverlay(true);
    const w = S.winner;
    $('go-title').textContent = `🏆 ¡Ganó ${w.name}!`;
    $('go-sub').textContent = w.how + '.';
    const rev = $('go-reveal');
    rev.innerHTML = '';
    for (const r of w.reveal || []) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span class="dot" style="background:${colorHex(r.color)}"></span>` +
        `<span><b>${esc(r.name)}:</b> ${esc(r.text)}${r.impossible ? ' (anulado → 30 países)' : ''}</span>`;
      rev.appendChild(row);
    }
    $('btn-again').classList.toggle('hidden', !isHost());
  }
  $('btn-again').addEventListener('click', () => {
    socket.emit('playAgain', {}, (res) => { if (res.error) flash(res.error); });
  });
  $('btn-exit').addEventListener('click', () => { session.clear(); location.reload(); });

  function syncOverlay() {
    const any = ['modal-extra', 'modal-move', 'modal-gameover', 'modal-objective', 'modal-ios']
      .some(id => $(id) && !$(id).classList.contains('hidden'));
    showOverlay(any);
  }

  // ------------------------------------------------------------ snapshot
  let mapBuilt = false;
  socket.on('state', (st) => {
    const prevPhase = S && S.phase;
    const prevStatus = S && S.status;
    S = st;
    if (st.status === 'lobby') {
      showScreen('lobby');
      renderLobby();
      return;
    }
    showScreen('game');
    if (!mapBuilt) { buildMap(); mapBuilt = true; }
    if (st.chat) syncChat(st.chat, false, prevStatus === 'playing');
    if (prevPhase !== st.phase) selected = null;
    if (!myTurn()) selected = null;
    if (moveCtx && (!myTurn() || st.phase !== 'regroup')) closeMoveModal();
    renderHeader();
    renderMap();
    renderActionBar();
    renderSidebar();
    renderExtraModal();
    renderGameOver();
    renderObjectiveModal();
    renderHistory();
    checkTurnNotify(st);
    syncPushSubscription();
  });

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }
})();

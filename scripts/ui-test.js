'use strict';
/*
 * Test de UI end-to-end con el navegador real (Edge headless):
 * crea una partida con 2 jugadores, arranca, y verifica que el modal de
 * objetivo, el menú lateral, el chat y el botón de objetivo funcionen.
 */
process.env.PORT = process.env.PORT || '3991';
const PORT = process.env.PORT;
require('../server.js');
const puppeteer = require('puppeteer-core');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const URL = `http://localhost:${PORT}`;
let failures = 0;

function check(cond, label) {
  console.log((cond ? 'OK ' : 'FALLO ') + label);
  if (!cond) failures++;
}

async function newPage(browser, name) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 }); // celular
  page.on('pageerror', (e) => { console.log(`[${name}] ERROR JS:`, e.message); failures++; });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${name}] console.error:`, m.text()); });
  await page.goto(URL, { waitUntil: 'networkidle0' });
  return page;
}

async function visible(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 0;
  }, sel);
}

async function main() {
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: 'new' });

  const A = await newPage(browser, 'A');
  const B = await newPage(browser, 'B');

  // A crea la sala
  await A.type('#home-name', 'Ana');
  await A.click('#btn-create');
  await A.waitForSelector('#screen-lobby.active', { timeout: 5000 });
  const code = await A.$eval('#lobby-code', (el) => el.textContent.trim());
  check(/^[A-Z2-9]{6}$/.test(code), `código de sala (${code})`);

  // B se une
  await B.type('#home-name', 'Beto');
  await B.type('#home-code', code);
  await B.click('#btn-join');
  await B.waitForSelector('#screen-lobby.active', { timeout: 5000 });

  // A inicia
  await A.waitForFunction(() => !document.getElementById('btn-start').disabled, { timeout: 5000 });
  await A.click('#btn-start');
  await A.waitForSelector('#screen-game.active', { timeout: 5000 });
  await B.waitForSelector('#screen-game.active', { timeout: 5000 });
  check(true, 'la partida arranca y muestra el mapa');

  // Modal de objetivo al empezar
  await A.waitForFunction(() => !document.getElementById('modal-objective').classList.contains('hidden'), { timeout: 5000 });
  const objText = await A.$eval('#obj-modal-text', (el) => el.textContent.trim());
  check(objText.length > 10, `modal de objetivo visible ("${objText.slice(0, 60)}...")`);
  check(!/ocupar 30 países/i.test(objText) || objText.length > 40,
    'el objetivo de 2 jugadores no es solo "30 países"');
  await A.click('#btn-obj-ok');
  await B.waitForFunction(() => !document.getElementById('modal-objective').classList.contains('hidden'), { timeout: 5000 });
  await B.click('#btn-obj-ok');
  check(!(await visible(A, '#overlay')), 'overlay se cierra al confirmar objetivo');

  // Menú lateral
  await A.click('#btn-sidebar');
  await new Promise((r) => setTimeout(r, 400));
  const sideOpen = await A.evaluate(() => {
    const el = document.getElementById('sidebar');
    return el.classList.contains('open') && el.getBoundingClientRect().x >= -5;
  });
  check(sideOpen, 'el menú ☰ abre');
  const objSidebar = await A.$eval('#side-objective', (el) => el.textContent.trim());
  check(objSidebar.length > 10, 'objetivo visible en el menú');
  const objBlurred = await A.$eval('#side-objective', (el) => el.classList.contains('hidden-obj'));
  check(!objBlurred, 'objetivo NO borroso por defecto');
  await A.click('#sidebar .panel-close');
  await new Promise((r) => setTimeout(r, 350));

  // Botón 🎯 re-abre el objetivo
  await A.click('#btn-objective');
  const objAgain = await A.waitForFunction(
    () => !document.getElementById('modal-objective').classList.contains('hidden'), { timeout: 3000 }).catch(() => null);
  check(!!objAgain, 'el botón 🎯 vuelve a mostrar el objetivo');
  await A.click('#btn-obj-ok');

  // Chat
  await A.click('#btn-chat');
  await new Promise((r) => setTimeout(r, 400));
  const chatOpen = await A.evaluate(() => document.getElementById('chatpanel').classList.contains('open'));
  check(chatOpen, 'el chat 💬 abre');
  await A.type('#chat-input', 'hola beto');
  await A.click('#chat-form button');
  await B.waitForFunction(
    () => document.getElementById('chat-msgs').textContent.includes('hola beto'), { timeout: 4000 });
  check(true, 'el mensaje de chat llega al otro jugador');

  // El jugador en turno puede colocar ejércitos tocando el mapa
  const turnPage = (await A.evaluate(() => document.getElementById('turn-banner').classList.contains('my-turn'))) ? A : B;
  await turnPage.evaluate(() => {
    const own = document.querySelector('.country.selectable');
    own.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 400));
  const placed = await turnPage.evaluate(() =>
    document.getElementById('action-info').textContent.includes('4'));
  check(placed, 'tocar un país propio coloca un ejército (5→4)');

  await browser.close();
  console.log(failures === 0 ? '\nUI TEST SUPERADO ✔' : `\n${failures} FALLOS ✘`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
setTimeout(() => { console.error('FALLO: timeout UI test'); process.exit(1); }, 90000);

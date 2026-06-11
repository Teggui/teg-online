# TEG online 🎲

Versión web multijugador en tiempo real del **TEG (Plan Táctico y Estratégico de la Guerra)**, el clásico juego de mesa argentino. Servidor autoritativo (nadie puede hacer trampa), pensado para jugar desde el celular.

## Cómo jugar

1. Uno crea la partida y comparte el **código de 6 letras** (o el link directo).
2. Los demás entran con el código, eligen color, y el anfitrión inicia (2 a 6 jugadores).
3. Si alguien se desconecta, vuelve a entrar con **el mismo código y el mismo nombre** y retoma su lugar. El anfitrión puede saltear el turno de un desconectado.

## Reglas implementadas (reglamento oficial)

- Tablero oficial: **50 países, 6 continentes**, con las 89 fronteras clásicas (Chile–Australia, Brasil–Sahara, Polonia–Egipto, Sumatra–India, Alaska–Kamtchatka…).
- Reparto inicial de países + dos vueltas de refuerzos (5 y 3 ejércitos).
- **15 objetivos secretos oficiales** (9 de ocupación + 6 de destrucción) más el objetivo común de 30 países. Si tu color objetivo no juega o es el tuyo, pasa al jugador de la derecha; si otro destruye a tu blanco, te queda solo el objetivo común.
- Turnos: incorporación (50% de países, mínimo 3, + bonus de continente), ataques con dados (hasta 3 vs 3, empates para el defensor), reagrupamiento (los ejércitos movidos no pueden volver a moverse) y tarjeta de país al conquistar (2 conquistas si ya hiciste 3 canjes).
- Tarjetas con símbolos oficiales (galeón, globo, cañón; Argentina y Taimir son comodines), **premio de 2 ejércitos** si tenés país y tarjeta, y canjes por 4, 7, 10, 15, 20… ejércitos. Canje obligatorio con 5 tarjetas.
- Al conquistar se pasa 1 ejército obligatorio y hasta 2 más (máx. 3).
- Al destruir un jugador se heredan sus tarjetas.

Simplificaciones deliberadas: con 2 jugadores se juega solo con el objetivo común; el orden de turnos y el reparto son al azar (reemplaza el tiro de dados inicial); no hay pactos formales (para eso está el chat 😉).

## Correr localmente

```bash
npm install
npm start
# abrí http://localhost:3000
```

Test de humo (simula partidas completas con bots): `npm run smoke` (con el servidor parado; levanta uno propio).

## Deploy en Railway

1. Subí este repo a GitHub.
2. En [railway.app](https://railway.app): **New Project → Deploy from GitHub repo** y elegí el repo. Railway detecta `npm start` solo; no hay que configurar nada (usa `process.env.PORT`).
3. En el servicio: **Settings → Networking → Generate Domain**.
4. Compartí esa URL con tus amigos. Listo, a jugar. 🫡

## Estructura

```
server.js          # Servidor Express + Socket.io con toda la lógica del juego
public/
  index.html       # UI (una sola página)
  style.css        # Tema oscuro mobile-first
  client.js        # Cliente: mapa SVG interactivo, paneles, chat
  teg-data.js      # Datos del tablero (países, fronteras, objetivos) compartidos
scripts/smoke.js   # Test de humo end-to-end con bots
```

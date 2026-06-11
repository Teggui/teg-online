/*
 * Datos del tablero oficial de TEG: 50 países, 6 continentes, 89 fronteras.
 * Adyacencias y símbolos de tarjetas según el tablero clásico (incluye los
 * puentes Chile–Australia, Brasil–Sahara, Polonia–Egipto, Sumatra–India y
 * Alaska–Kamtchatka). Compartido entre servidor y cliente (UMD).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TEG_DATA = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const CONTINENTS = {
    samerica: { name: 'América del Sur', bonus: 3, hue: '#f4a261' },
    namerica: { name: 'América del Norte', bonus: 5, hue: '#b08bea' },
    europa:   { name: 'Europa',           bonus: 5, hue: '#5fa8f5' },
    asia:     { name: 'Asia',             bonus: 7, hue: '#ef6f6c' },
    africa:   { name: 'África',           bonus: 3, hue: '#e9c46a' },
    oceania:  { name: 'Oceanía',          bonus: 2, hue: '#43c6ac' }
  };

  const COLORS = {
    rojo:     { name: 'Rojo',     hex: '#e63946', text: '#fff' },
    azul:     { name: 'Azul',     hex: '#3a86ff', text: '#fff' },
    verde:    { name: 'Verde',    hex: '#2dc653', text: '#fff' },
    amarillo: { name: 'Amarillo', hex: '#ffbe0b', text: '#1a1a1a' },
    negro:    { name: 'Negro',    hex: '#555c64', text: '#fff' },
    magenta:  { name: 'Magenta',  hex: '#ff5d8f', text: '#fff' }
  };

  // id: [nombre, continente, símbolo de tarjeta, x, y]  (símbolos oficiales;
  // coordenadas = centro del país sobre la foto del tablero board.jpg 858x613)
  const C = {
    // América del Sur
    argentina:   ['Argentina', 'samerica', 'comodin', 290, 432],
    brasil:      ['Brasil', 'samerica', 'galeon', 312, 367],
    chile:       ['Chile', 'samerica', 'globo', 248, 452],
    colombia:    ['Colombia', 'samerica', 'globo', 268, 350],
    peru:        ['Perú', 'samerica', 'galeon', 268, 384],
    uruguay:     ['Uruguay', 'samerica', 'globo', 320, 408],
    // América del Norte
    mexico:      ['México', 'namerica', 'canion', 198, 298],
    california:  ['California', 'namerica', 'canion', 158, 277],
    oregon:      ['Oregon', 'namerica', 'canion', 105, 242],
    nuevayork:   ['Nueva York', 'namerica', 'galeon', 172, 240],
    alaska:      ['Alaska', 'namerica', 'galeon', 30, 244],
    yukon:       ['Yukón', 'namerica', 'globo', 118, 210],
    canada:      ['Canadá', 'namerica', 'canion', 124, 166],
    terranova:   ['Terranova', 'namerica', 'canion', 206, 215],
    labrador:    ['Labrador', 'namerica', 'canion', 220, 191],
    groenlandia: ['Groenlandia', 'namerica', 'galeon', 303, 141],
    // África
    sahara:      ['Sahara', 'africa', 'canion', 518, 408],
    zaire:       ['Zaire', 'africa', 'galeon', 548, 443],
    etiopia:     ['Etiopía', 'africa', 'globo', 591, 421],
    egipto:      ['Egipto', 'africa', 'globo', 597, 394],
    madagascar:  ['Madagascar', 'africa', 'galeon', 651, 470],
    sudafrica:   ['Sudáfrica', 'africa', 'canion', 592, 459],
    // Oceanía
    australia:   ['Australia', 'oceania', 'canion', 790, 446],
    borneo:      ['Borneo', 'oceania', 'galeon', 782, 357],
    java:        ['Java', 'oceania', 'canion', 824, 363],
    sumatra:     ['Sumatra', 'oceania', 'globo', 722, 381],
    // Europa
    espana:      ['España', 'europa', 'globo', 462, 340],
    francia:     ['Francia', 'europa', 'globo', 508, 322],
    alemania:    ['Alemania', 'europa', 'galeon', 558, 296],
    italia:      ['Italia', 'europa', 'globo', 548, 352],
    polonia:     ['Polonia', 'europa', 'canion', 600, 284],
    rusia:       ['Rusia', 'europa', 'globo', 595, 198],
    suecia:      ['Suecia', 'europa', 'galeon', 525, 174],
    granbretana: ['Gran Bretaña', 'europa', 'galeon', 465, 240],
    islandia:    ['Islandia', 'europa', 'galeon', 387, 241],
    // Asia
    arabia:      ['Arabia', 'asia', 'canion', 672, 335],
    israel:      ['Israel', 'asia', 'galeon', 648, 318],
    turquia:     ['Turquía', 'asia', 'galeon', 638, 289],
    india:       ['India', 'asia', 'globo', 756, 311],
    malasia:     ['Malasia', 'asia', 'canion', 800, 291],
    iran:        ['Irán', 'asia', 'globo', 650, 230],
    gobi:        ['Gobi', 'asia', 'globo', 724, 230],
    china:       ['China', 'asia', 'galeon', 777, 230],
    mongolia:    ['Mongolia', 'asia', 'galeon', 685, 191],
    siberia:     ['Siberia', 'asia', 'galeon', 692, 164],
    aral:        ['Aral', 'asia', 'canion', 630, 128],
    tartaria:    ['Tartaria', 'asia', 'canion', 663, 115],
    taimir:      ['Taimir', 'asia', 'comodin', 698, 122],
    kamtchatka:  ['Kamtchatka', 'asia', 'globo', 757, 113],
    japon:       ['Japón', 'asia', 'canion', 820, 141]
  };

  const COUNTRIES = {};
  for (const id of Object.keys(C)) {
    COUNTRIES[id] = { id, name: C[id][0], cont: C[id][1], sym: C[id][2], x: C[id][3], y: C[id][4] };
  }

  // 89 fronteras oficiales (cada par una sola vez; se simetriza abajo)
  const EDGES = [
    // América del Sur
    ['argentina', 'brasil'], ['argentina', 'chile'], ['argentina', 'peru'], ['argentina', 'uruguay'],
    ['brasil', 'colombia'], ['brasil', 'peru'], ['brasil', 'uruguay'], ['brasil', 'sahara'],
    ['chile', 'peru'], ['chile', 'australia'],
    ['colombia', 'peru'], ['colombia', 'mexico'],
    // América del Norte
    ['mexico', 'california'],
    ['california', 'oregon'], ['california', 'nuevayork'],
    ['oregon', 'nuevayork'], ['oregon', 'alaska'], ['oregon', 'yukon'], ['oregon', 'canada'],
    ['nuevayork', 'canada'], ['nuevayork', 'terranova'], ['nuevayork', 'groenlandia'],
    ['alaska', 'yukon'], ['alaska', 'kamtchatka'],
    ['yukon', 'canada'],
    ['canada', 'terranova'],
    ['terranova', 'labrador'],
    ['labrador', 'groenlandia'],
    ['groenlandia', 'islandia'],
    // África
    ['sahara', 'zaire'], ['sahara', 'etiopia'], ['sahara', 'egipto'], ['sahara', 'espana'],
    ['zaire', 'etiopia'], ['zaire', 'madagascar'], ['zaire', 'sudafrica'],
    ['etiopia', 'egipto'], ['etiopia', 'sudafrica'],
    ['egipto', 'madagascar'], ['egipto', 'polonia'], ['egipto', 'israel'], ['egipto', 'turquia'],
    // Oceanía
    ['australia', 'borneo'], ['australia', 'java'], ['australia', 'sumatra'],
    ['borneo', 'malasia'],
    ['sumatra', 'india'],
    // Europa
    ['espana', 'francia'], ['espana', 'granbretana'],
    ['francia', 'alemania'], ['francia', 'italia'],
    ['alemania', 'italia'], ['alemania', 'polonia'], ['alemania', 'granbretana'],
    ['polonia', 'rusia'], ['polonia', 'turquia'],
    ['rusia', 'suecia'], ['rusia', 'turquia'], ['rusia', 'iran'], ['rusia', 'aral'],
    ['suecia', 'islandia'],
    ['granbretana', 'islandia'],
    // Asia
    ['arabia', 'israel'], ['arabia', 'turquia'],
    ['israel', 'turquia'],
    ['turquia', 'iran'],
    ['india', 'malasia'], ['india', 'iran'], ['india', 'china'],
    ['malasia', 'china'],
    ['iran', 'gobi'], ['iran', 'china'], ['iran', 'mongolia'], ['iran', 'aral'],
    ['gobi', 'china'], ['gobi', 'mongolia'],
    ['china', 'mongolia'], ['china', 'siberia'], ['china', 'kamtchatka'], ['china', 'japon'],
    ['mongolia', 'siberia'], ['mongolia', 'aral'],
    ['siberia', 'aral'], ['siberia', 'tartaria'], ['siberia', 'taimir'], ['siberia', 'kamtchatka'],
    ['aral', 'tartaria'],
    ['tartaria', 'taimir'],
    ['kamtchatka', 'japon']
  ];

  const ADJ = {};
  for (const id of Object.keys(COUNTRIES)) ADJ[id] = [];
  for (const [a, b] of EDGES) { ADJ[a].push(b); ADJ[b].push(a); }

  function isAdjacent(a, b) { return ADJ[a] && ADJ[a].indexOf(b) !== -1; }

  // Los 15 objetivos secretos oficiales
  const OBJECTIVES = [
    { id: 1, type: 'occupy', text: 'Ocupar África, 5 países de América del Norte y 4 países de Europa.',
      continents: ['africa'], counts: { namerica: 5, europa: 4 } },
    { id: 2, type: 'occupy', text: 'Ocupar América del Sur, 7 países de Europa y 3 países limítrofes entre sí en cualquier lugar del mapa.',
      continents: ['samerica'], counts: { europa: 7 }, triangle: true },
    { id: 3, type: 'occupy', text: 'Ocupar Asia y 2 países de América del Sur.',
      continents: ['asia'], counts: { samerica: 2 } },
    { id: 4, type: 'occupy', text: 'Ocupar Europa, 4 países de Asia y 2 países de América del Sur.',
      continents: ['europa'], counts: { asia: 4, samerica: 2 } },
    { id: 5, type: 'occupy', text: 'Ocupar América del Norte, 2 países de Oceanía y 4 de Asia.',
      continents: ['namerica'], counts: { oceania: 2, asia: 4 } },
    { id: 6, type: 'occupy', text: 'Ocupar 2 países de Oceanía, 2 países de África, 2 países de América del Sur, 3 países de Europa, 4 de América del Norte y 3 de Asia.',
      continents: [], counts: { oceania: 2, africa: 2, samerica: 2, europa: 3, namerica: 4, asia: 3 } },
    { id: 7, type: 'occupy', text: 'Ocupar Oceanía, América del Norte y 2 países de Europa.',
      continents: ['oceania', 'namerica'], counts: { europa: 2 } },
    { id: 8, type: 'occupy', text: 'Ocupar América del Sur, África y 4 países de Asia.',
      continents: ['samerica', 'africa'], counts: { asia: 4 } },
    { id: 9, type: 'occupy', text: 'Ocupar Oceanía, África y 5 países de América del Norte.',
      continents: ['oceania', 'africa'], counts: { namerica: 5 } },
    { id: 10, type: 'destroy', color: 'azul',     text: 'Destruir el ejército azul; de ser imposible, al jugador de la derecha.' },
    { id: 11, type: 'destroy', color: 'rojo',     text: 'Destruir el ejército rojo; de ser imposible, al jugador de la derecha.' },
    { id: 12, type: 'destroy', color: 'negro',    text: 'Destruir el ejército negro; de ser imposible, al jugador de la derecha.' },
    { id: 13, type: 'destroy', color: 'amarillo', text: 'Destruir el ejército amarillo; de ser imposible, al jugador de la derecha.' },
    { id: 14, type: 'destroy', color: 'verde',    text: 'Destruir el ejército verde; de ser imposible, al jugador de la derecha.' },
    { id: 15, type: 'destroy', color: 'magenta',  text: 'Destruir el ejército magenta; de ser imposible, al jugador de la derecha.' }
  ];

  const SYMBOLS = {
    galeon:  { name: 'Galeón',  icon: '⛵' },
    globo:   { name: 'Globo',   icon: '🎈' },
    canion:  { name: 'Cañón',   icon: '💣' },
    comodin: { name: 'Comodín', icon: '🃏' }
  };

  return { CONTINENTS, COLORS, COUNTRIES, EDGES, ADJ, OBJECTIVES, SYMBOLS, isAdjacent };
});

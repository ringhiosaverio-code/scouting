// Costanti e tabelle di codifica (convenzioni DataVolley).
// Le tabelle combinazioni d'attacco / chiamate alzatore / compound sono
// riprese da ovscout2 (MIT, (c) the ovscout2 package authors).

export const SKILLS = {
  S: 'Battuta',
  R: 'Ricezione',
  E: 'Alzata',
  A: 'Attacco',
  B: 'Muro',
  D: 'Difesa',
  F: 'Free ball',
};
export const SKILL_ORDER = ['S', 'R', 'E', 'A', 'B', 'D', 'F'];

export const EVALS = ['#', '+', '!', '-', '/', '='];

// Significato delle valutazioni per fondamentale (standard DataVolley)
export const EVAL_TEXT = {
  S: { '#': 'Ace', '+': 'Positiva (ric. scarsa)', '!': 'Ric. OK', '-': 'Negativa (ric. perfetta)', '/': 'Ritorno diretto', '=': 'Errore' },
  R: { '#': 'Perfetta', '+': 'Positiva', '!': 'OK, no primo tempo', '-': 'Negativa', '/': 'Scarsa, ritorno', '=': 'Errore' },
  E: { '#': 'Perfetta', '+': 'Positiva', '!': 'OK', '-': 'Scarsa', '/': 'Scarsa', '=': 'Errore' },
  A: { '#': 'Punto', '+': 'Positivo', '!': 'Murato, ricoperto', '-': 'Negativo (difeso facile)', '/': 'Murato', '=': 'Errore' },
  B: { '#': 'Punto', '+': 'Positivo', '!': 'Ricoperto', '-': 'Negativo (tocco)', '/': 'Invasione', '=': 'Errore' },
  D: { '#': 'Perfetta', '+': 'Positiva', '!': 'OK, no primo tempo', '-': 'Negativa', '/': 'Ritorno diretto', '=': 'Errore' },
  F: { '#': 'Perfetta', '+': 'Positiva', '!': 'OK', '-': 'Negativa', '/': 'Scarsa', '=': 'Errore' },
};

// Tipo (tempo) per fondamentale
export const TYPES = ['H', 'M', 'Q', 'T', 'U', 'N', 'O'];
export const TYPE_TEXT = {
  S: { H: 'Flot', M: 'Salto flot', Q: 'Salto spin', T: 'Spin', N: 'Ibrida', O: 'Altro' },
  R: { H: 'Su flot', M: 'Su salto flot', Q: 'Su salto spin', T: 'Su spin', N: 'Su ibrida', O: 'Altro' },
  default: { H: 'Alta', M: 'Mezza', Q: 'Veloce', T: 'Tesa', U: 'Super', N: 'Slide', O: 'Altro' },
};
export const SERVE_TYPES = ['Q', 'M', 'H', 'T', 'N'];

export const SKILL_SUBTYPES = {
  A: { H: 'Schiacciata', P: 'Colpo piazzato', T: 'Pallonetto' },
  B: { A: 'Muro a uomo/opzione', T: 'Muro a zona' },
  R: { L: 'Bagher sx', R: 'Bagher dx', W: 'Bagher basso', O: 'Palleggio', M: 'Bagher centrale' },
  E: { 1: 'Mano 1', 2: 'Mani 2', 3: 'Bagher', 4: 'Salto', 5: 'Altro' },
  D: { S: 'Su attacco', C: 'Ricopertura', B: 'Dopo muro', E: 'Recupero' },
};

export const SPECIAL = {
  A: {
    '#': { S: 'Mani-out laterale', O: 'Mani-out fondo', F: 'A terra dopo muro', X: 'Diretto a terra', N: 'Nastro' },
    '=': { O: 'Out lungo', S: 'Out laterale', N: 'Rete', A: 'Antenna', I: 'Invasione', Z: 'Fallo arbitrale' },
  },
  S: { '=': { O: 'Out lungo', L: 'Out sinistro', R: 'Out destro', N: 'Rete' }, '#': { N: 'Nastro' } },
  R: { '=': { U: 'Non controllata', X: 'Fuori corpo', P: 'Errore posizione', E: 'Mancata' } },
  B: { '=': { S: 'Fuori lat.', O: 'Fuori fondo', F: 'A terra', X: 'Fra mani e rete', N: 'Rete', I: 'Invasione', A: 'Antenna', P: 'Posizione', T: 'Troppi tocchi', Z: 'Fallo arbitrale' } },
  E: { '=': { U: 'Non controllata', I: 'Doppia', Z: 'Fallo arbitrale' } },
  D: { '=': { U: 'Non controllata', X: 'Fuori corpo', P: 'Diretto fuori', Z: 'Fallo arbitrale' } },
};

// Ruoli: codice interno -> descrizione, codice ruolo DVW
export const ROLES = {
  S: { name: 'Palleggiatore', dv: 5 },
  O: { name: 'Opposto', dv: 3 },
  H: { name: 'Schiacciatore', dv: 2 },
  M: { name: 'Centrale', dv: 4 },
  L: { name: 'Libero', dv: 1 },
  U: { name: 'N.D.', dv: 6 },
};
export const DV_ROLE_TO_ROLE = { 1: 'L', 2: 'H', 3: 'O', 4: 'M', 5: 'S', 6: 'U' };

// Combinazioni d'attacco: code, attacker_position (zona partenza), side, type (tempo), description, colour, start_coordinate, set_type
export const ATTACK_TABLE = [
  ['CB', 2, 'L', 'N', 'Slide vicino al palleggiatore', 16711680, 4976, 'C'],
  ['CD', 2, 'L', 'N', 'Slide lontano dal palleggiatore', 16711680, 4970, 'C'],
  ['CF', 2, 'L', 'N', 'Slide stretto', 16711680, 4986, 'C'],
  ['C0', 7, 'C', 'U', 'Mezza seconda linea D', 0, 4114, 'F'],
  ['C5', 4, 'R', 'U', 'Super in 4', 0, 4912, 'F'],
  ['C6', 2, 'L', 'U', 'Super in 2', 0, 4988, 'B'],
  ['C8', 9, 'C', 'U', 'Mezza seconda linea A', 0, 4186, 'B'],
  ['II', 4, 'R', 'M', 'Attacco in 4 (AW)', 0, 4912, 'F'],
  ['JJ', 2, 'L', 'M', 'Dietro (AW)', 0, 4988, 'B'],
  ['PP', 3, 'L', 'O', 'Seconda palleggiatore', 16711680, 4964, 'S'],
  ['PR', 3, 'C', 'O', 'Attacco su palla di ritorno', 255, 4949, '-'],
  ['P2', 3, 'C', 'O', 'Attacco di seconda', 255, 4949, '-'],
  ['VB', 8, 'C', 'H', 'Pipe alta B', 255, 4163, 'P'],
  ['VI', 2, 'L', 'H', 'Palla alta dietro (AW)', 255, 4988, 'B'],
  ['VJ', 4, 'R', 'H', 'Palla alta in 4 (AW)', 255, 4912, 'F'],
  ['VO', 9, 'C', 'H', 'Pipe alta opposto', 255, 4163, 'B'],
  ['VP', 8, 'C', 'H', 'Pipe alta', 255, 4150, 'P'],
  ['VR', 8, 'C', 'H', 'Pipe alta C', 255, 4137, 'P'],
  ['VV', 7, 'R', 'H', 'Palla alta emergenza in 4', 0, 4912, 'F'],
  ['V0', 7, 'C', 'H', 'Palla alta seconda linea D', 255, 4114, 'F'],
  ['V3', 3, 'C', 'O', 'Palla alta in 3', 255, 4950, '-'],
  ['V4', 2, 'L', 'H', 'Palla alta dietro corta', 255, 4868, 'B'],
  ['V5', 4, 'R', 'H', 'Palla alta in 4', 255, 4912, 'F'],
  ['V6', 2, 'L', 'H', 'Palla alta in 2', 255, 4988, 'B'],
  ['V8', 9, 'C', 'H', 'Palla alta seconda linea A', 255, 4186, 'B'],
  ['XB', 8, 'C', 'M', 'Pipe B', 16711680, 4163, 'P'],
  ['XC', 3, 'R', 'Q', 'Primo tempo E', 65280, 4947, 'C'],
  ['XD', 3, 'R', 'Q', 'Primo tempo B fluttuante', 65280, 4941, 'C'],
  ['XF', 2, 'L', 'N', 'Slide dell\'opposto', 65280, 4976, 'B'],
  ['XG', 3, 'R', 'Q', 'Primo tempo "soup"', 65280, 4946, 'C'],
  ['XL', 2, 'C', 'Q', 'Primo tempo A in 2', 65280, 4868, 'C'],
  ['XM', 3, 'C', 'Q', 'Primo tempo B in 3', 65280, 4949, 'C'],
  ['XO', 2, 'L', 'Q', 'Primo tempo C dell\'opposto', 65280, 4973, 'B'],
  ['XP', 8, 'C', 'M', 'Pipe', 16711680, 4150, 'P'],
  ['XQ', 2, 'L', 'M', 'Mezza dietro', 16711680, 4976, 'B'],
  ['XR', 8, 'C', 'M', 'Pipe C', 16711680, 4138, 'P'],
  ['XS', 2, 'L', 'Q', 'Primo tempo D', 65280, 4981, 'C'],
  ['XT', 3, 'R', 'M', 'Fast in 3 dello schiacciatore', 16711680, 4950, 'F'],
  ['XZ', 4, 'R', 'Q', 'Primo tempo B corto', 65280, 4941, 'C'],
  ['X0', 7, 'C', 'T', 'Seconda linea D', 16711680, 4114, 'F'],
  ['X1', 3, 'R', 'Q', 'Primo tempo avanti', 65280, 4956, 'C'],
  ['X2', 2, 'L', 'Q', 'Primo tempo dietro', 65280, 4868, 'C'],
  ['X3', 3, 'L', 'M', 'Fast in 3 dell\'opposto', 16711680, 4950, 'B'],
  ['X4', 2, 'L', 'M', 'Mezza in 2', 16711680, 4976, 'B'],
  ['X5', 4, 'R', 'T', 'Tesa in 4', 16711680, 4912, 'F'],
  ['X6', 2, 'L', 'T', 'Tesa in 2', 16711680, 4988, 'B'],
  ['X7', 4, 'R', 'Q', 'Primo tempo staccato (7)', 65280, 4932, 'C'],
  ['X8', 9, 'C', 'T', 'Seconda linea A', 16711680, 4186, 'B'],
  ['X9', 4, 'R', 'M', 'Mezza in 4', 16711680, 4924, 'F'],
  ['ZP', 8, 'C', 'M', 'Pipe mezza', 0, 4150, 'P'],
  ['Z5', 4, 'R', 'M', 'Mezza in 4', 0, 4912, 'F'],
  ['Z6', 2, 'L', 'M', 'Mezza in 2', 0, 4988, 'B'],
  ['Z8', 9, 'C', 'M', 'Mezza seconda linea A', 0, 4186, 'B'],
].map(([code, zone, side, type, description, colour, startCoord, setType]) => ({ code, zone, side, type, description, colour, startCoord, setType }));

export const SIMPLIFIED_ATTACKS = ['X1', 'X2', 'X7', 'XD', 'CF', 'CD', 'PP', 'PR', 'P2', 'VP', 'V0', 'V3', 'V4', 'V5', 'V6', 'V8', 'XP', 'X0', 'X5', 'X6', 'X8'];

export const SETTER_CALLS = [
  { code: 'K1', description: 'Primo tempo avanti', colour: 16711680, start: 3949, mid: 4454, end: 4958, path: '', pathColour: '' },
  { code: 'K2', description: 'Primo tempo dietro', colour: 16711680, start: 3864, mid: 4278, end: 4974, path: '', pathColour: '' },
  { code: 'K7', description: 'Primo tempo staccato (7)', colour: 16711680, start: 3923, mid: 4426, end: 4930, path: '', pathColour: '' },
  { code: 'KC', description: 'Primo tempo in 3', colour: 16711680, start: 3849, mid: 4449, end: 5049, path: '', pathColour: '' },
  { code: 'KE', description: 'Nessun primo tempo', colour: 0, start: 0, mid: 0, end: 0, path: '5858,5826,6426,6458,6458', pathColour: 12632256 },
];

// Target alzata
export const SET_TARGETS = { F: 'Avanti (4)', C: 'Centro (3)', B: 'Dietro (2)', P: 'Pipe', S: 'Palleggiatore' };

// compound: skill -> skill complementare e mappa valutazioni
export const COMPOUND = {
  S: { skill: 'R', map: { '/': '/', '-': '#', '+': '-', '!': '!', '#': '=', '=': null } },
  A: { skill: 'B', map: { '/': '#', '-': '+', '!': '!', '+': '-', '#': '=', '=': null } },
  // Attacco -> difesa (non compound di default, usato dal flusso guidato)
  AD: { skill: 'D', map: { '-': '#', '+': '-', '#': '=' } },
  F: { skill: 'F', map: { '+': '-', '!': '!', '-': '#' } },
};

// Valutazione di attacco ricavata dalla qualità della difesa avversaria
export const ATTACK_EVAL_FROM_DIG = { '#': '-', '+': '-', '!': '-', '-': '+', '/': '+', '=': '#' };
// Valutazione battuta dalla ricezione
export const SERVE_EVAL_FROM_RECEPTION = { '#': '-', '+': '-', '!': '!', '-': '+', '/': '/', '=': '#' };

// Simboli vincenti/perdenti per fondamentale: chi vince il punto se la riga ha quella valutazione
export const WINNING = {
  S: { W: ['#'], L: ['='] },
  R: { W: [], L: ['='] },
  E: { W: [], L: ['='] },
  A: { W: ['#'], L: ['=', '/'] },
  B: { W: ['#'], L: ['=', '/'] },
  D: { W: [], L: ['='] },
  F: { W: [], L: ['='] },
};
export const DV_WINNING_SYMBOLS = '=~~~#~~~=~~~~~~~=/~~#~~~=/~~#~~~=~~~~~~~=~~~~~~~=~~~~~~~';

export const TEAM_CHARS = { home: '*', visiting: 'a' };
export const other = (t) => (t === '*' ? 'a' : '*');

export const DEFAULT_SETTINGS = {
  format: { setsToWin: 3, points: 25, tiebreakPoints: 15 },
  scoutSets: true, // registra le alzate con clic
  scoutSecondContactLocation: true,
  pauseOnPopup: true,
  resumeAfterPopup: true,
  rewindAfterPopup: 0,
  clipPre: 4,
  clipPost: 4,
  attackSet: 'full', // 'full' | 'simplified'
  defaultEval: { S: '+', R: '+', E: '+', A: '+', B: '+', D: '+', F: '+' },
  defaultType: 'H',
  clickSurface: 'video', // 'video' | 'court'
  autoEndSet: true,
  zoneDisplay: true,
  language: 'it',
};

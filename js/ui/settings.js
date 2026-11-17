// Impostazioni di scouting, guida rapida ai tasti e alla sintassi dei codici.
import { h, clear, toast } from './dom.js';
import { ATTACK_TABLE, SIMPLIFIED_ATTACKS, EVALS, SKILLS, TYPES } from '../lib/constants.js';

export function createSettings(app) {
  const root = h('div', { class: 'settings' });

  function render() {
    clear(root);
    const st = app.match.settings;
    const chk = (key, label, help) => h('label', { class: 'toggle block' },
      h('input', { type: 'checkbox', checked: !!st[key], onchange: (e) => { st[key] = e.target.checked; app.save(); } }), ' ', h('b', {}, label), help ? h('span', { class: 'muted' }, ` — ${help}`) : null);
    const num = (key, label, step = 0.5) => h('label', { class: 'field inline' }, h('span', {}, label), h('input', { type: 'number', step, min: 0, value: st[key], onchange: (e) => { st[key] = +e.target.value; app.save(); } }));
    root.append(
      h('div', { class: 'grid2' },
        h('div', { class: 'card' },
          h('h2', {}, 'Scouting'),
          chk('scoutSets', 'Registra le alzate con un clic', 'se disattivato l\'alzata viene inserita in automatico (scouting più veloce)'),
          chk('pauseOnPopup', 'Pausa del video durante le scelte'),
          chk('resumeAfterPopup', 'Riprendi il video dopo la conferma'),
          chk('autoEndSet', 'Proponi la fine del set automaticamente'),
          chk('zoneDisplay', 'Mostra le linee del campo sul video'),
          num('rewindAfterPopup', 'Riavvolgi dopo la conferma (s)'),
          h('label', { class: 'field inline' }, h('span', {}, 'Combinazioni d\'attacco'), h('select', { onchange: (e) => { st.attackSet = e.target.value; app.save(); } },
            h('option', { value: 'full', selected: st.attackSet === 'full' }, `Complete (${ATTACK_TABLE.length})`),
            h('option', { value: 'simplified', selected: st.attackSet === 'simplified' }, `Semplificate (${SIMPLIFIED_ATTACKS.length})`))),
          h('label', { class: 'field inline' }, h('span', {}, 'Tempo predefinito'), h('select', { onchange: (e) => { st.defaultType = e.target.value; app.save(); } },
            TYPES.map((t) => h('option', { value: t, selected: st.defaultType === t }, t)))),
          h('h3', {}, 'Valutazione predefinita (codici digitati)'),
          h('div', { class: 'row gap wrap' }, Object.keys(SKILLS).map((k) => h('label', { class: 'field inline' }, h('span', {}, SKILLS[k]),
            h('select', { onchange: (e) => { st.defaultEval[k] = e.target.value; app.save(); } }, EVALS.map((ev) => h('option', { value: ev, selected: st.defaultEval[k] === ev }, ev))))))),
        h('div', { class: 'card' },
          h('h2', {}, 'Video'),
          h('div', { class: 'row gap wrap' },
            h('button', { class: 'btn', onclick: () => app.openVideo() }, '📂 Carica file video'),
            h('button', { class: 'btn', onclick: () => { const u = prompt('URL del video (MP4/WebM accessibile dal browser):', app.match.video.url || ''); if (u) { app.openVideoUrl(u); toast('Video da URL impostato'); } } }, '🔗 Video da URL'),
            h('button', { class: 'btn', onclick: () => { app.match.calibration.points = {}; app.save(); toast('Calibrazione azzerata'); } }, 'Azzera calibrazione')),
          h('p', { class: 'muted' }, `File: ${app.match.video.name || '—'}`),
          h('h2', {}, 'Clip'),
          num('clipPre', 'Secondi prima del tocco'),
          num('clipPost', 'Secondi dopo il tocco'))),
      h('div', { class: 'card help' },
        h('h2', {}, 'Guida rapida'),
        h('div', { class: 'grid2' },
          h('div', {},
            h('h3', {}, 'Scouting a clic (guidato)'),
            h('ol', {},
              h('li', {}, 'Calibra il campo (📐): clicca i 4 angoli, poi facoltativamente linee dei 3 m e centrale. I punti si possono trascinare.'),
              h('li', {}, 'Battuta: clic sul punto di battuta, poi dove arriva la palla. Scegli ricevitore e valutazione della ricezione (oppure Ace / Errore).'),
              h('li', {}, 'Secondo tocco: clic dove viene alzata la palla e conferma (Invio).'),
              h('li', {}, 'Attacco: clic sul punto d\'attacco, scegli attaccante e combinazione, clic dove finisce la palla e indica l\'esito (punto, errore, murato, difesa con valutazione).'),
              h('li', {}, 'Il punto, la rotazione e il servizio si aggiornano da soli. Il sistema propone il giocatore più probabile e impara dalle scelte precedenti.')),
            h('h3', {}, 'Tasti'),
            h('table', { class: 'tbl keys' }, h('tbody', {},
              [['Spazio', 'Play / pausa'], ['← / →', '−2 s / +2 s (Shift: 10 s)'], [', / .', 'Fotogramma indietro / avanti'], ['[ / ]', 'Velocità − / +'],
                ['q w e r t y u i o', 'Scelta giocatore (nell\'ordine mostrato)'], ['a s d f g h j k', 'Scelta combinazione d\'attacco'],
                ['1-6 oppure # + ! - / =', 'Valutazione'], ['Invio', 'Conferma la scelta proposta'], ['Esc', 'Annulla l\'azione in corso'],
                ['c', 'Vai alla riga codici'], ['u / Ctrl+Z', 'Annulla'], ['Ctrl+Y', 'Ripeti'], ['Ctrl+S', 'Salva file .vsj'],
                ['Nella riga codici: Ctrl+←/→, Alt+←/→, Tab', 'Video −/+2 s, −/+10 s, play/pausa']].map(([k, v]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, v)))))),
          h('div', {},
            h('h3', {}, 'Codici digitati (compatibili DataVolley)'),
            h('p', {}, 'Struttura: ', h('code', {}, '[squadra][numero][fondamentale][tipo][valutazione][combinazione][zone]…'), '. ', h('code', {}, '*'), ' = casa (predefinita), ', h('code', {}, 'a'), ' = ospiti.'),
            h('p', {}, 'Se la squadra non è indicata viene dedotta dal contesto (chi batte, chi riceve, chi ha la palla). Se manca il numero, battitore e palleggiatore sono presi dalla rotazione, gli altri dalla predizione.'),
            h('table', { class: 'tbl' }, h('tbody', {},
              [['7SQ-', 'Battuta salto spin del n.7, negativa'], ['7SQ-.12', 'Battuta + ricezione di 12 avversario (valutazione complementare #)'],
                ['a12R#', 'Ricezione perfetta del 12 ospite'], ['E', 'Alzata del palleggiatore in campo'], ['9X5#', 'Attacco tesa in 4 del 9, punto (zona di partenza dalla combinazione)'],
                ['9X5-57', 'Attacco X5 in zona 5→7… (cifre = zone)'], ['10V6/.5', 'Attacco murato + muro punto del 5 avversario'], ['4D+', 'Difesa positiva del 4'],
                ['*p / ap', 'Punto casa / ospiti'], ['*T', 'Time-out casa'], ['*c5:12', 'Cambio casa: esce 5, entra 12'], ['*P7', 'Il palleggiatore di casa è il 7'], ['*z3', 'Imposta rotazione: palleggiatore in P3']]
                .map(([c, d]) => h('tr', {}, h('td', {}, h('code', {}, c)), h('td', {}, d))))),
            h('p', { class: 'muted' }, 'Valutazioni: # perfetto/punto, + positivo, ! ok, - negativo, / scarso (attacco: murato), = errore.')))),
    );
  }
  return { el: root, render };
}

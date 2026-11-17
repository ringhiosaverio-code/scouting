// Impostazione partita: dati gara, squadre, rose, libreria squadre.
import { h, clear, toast, modal, confirmDialog } from './dom.js';
import { ROLES } from '../lib/constants.js';
import { newPlayer } from '../lib/engine.js';
import { listTeams, saveTeam, deleteTeam } from '../lib/store.js';
import { fromDVW, decodeBytes } from '../lib/dvw.js';

export function createSetup(app) {
  const root = h('div', { class: 'setup' });

  function field(obj, key, label, opts = {}) {
    const inp = h(opts.multiline ? 'textarea' : 'input', {
      type: opts.type || 'text', value: obj[key] ?? '', placeholder: opts.placeholder || '',
      oninput: (e) => { obj[key] = e.target.value; app.touch(); },
    });
    if (opts.multiline) inp.value = obj[key] ?? '';
    return h('label', { class: 'field' }, h('span', {}, label), inp);
  }

  function teamCard(t) {
    const T = app.match.teams[t];
    const tbody = h('tbody');
    const drawRows = () => {
      clear(tbody);
      T.players.sort((a, b) => (Number(a.number) || 999) - (Number(b.number) || 999));
      T.players.forEach((p) => {
        tbody.append(h('tr', {},
          h('td', {}, h('input', { class: 'num', type: 'number', min: 0, max: 99, value: p.number ?? '', 'aria-label': 'Numero', onchange: (e) => { p.number = e.target.value === '' ? null : +e.target.value; app.touch(); } })),
          h('td', {}, h('input', { value: p.lastName, placeholder: 'Cognome', 'aria-label': 'Cognome', oninput: (e) => { p.lastName = e.target.value; app.touch(); } })),
          h('td', {}, h('input', { value: p.firstName, placeholder: 'Nome', 'aria-label': 'Nome', oninput: (e) => { p.firstName = e.target.value; app.touch(); } })),
          h('td', {}, h('select', { 'aria-label': 'Ruolo', onchange: (e) => { p.role = e.target.value; app.touch(); } },
            Object.entries(ROLES).map(([k, v]) => h('option', { value: k, selected: p.role === k }, v.name)))),
          h('td', { class: 'center' }, h('input', { type: 'checkbox', checked: !!p.captain, 'aria-label': 'Capitano', onchange: (e) => { p.captain = e.target.checked; app.touch(); } })),
          h('td', {}, h('button', { class: 'icon-btn danger', title: 'Rimuovi', onclick: () => { T.players.splice(T.players.indexOf(p), 1); app.touch(); drawRows(); } }, '✕'))));
      });
    };
    drawRows();
    const lib = listTeams();
    return h('div', { class: 'card team-card', style: { borderTopColor: T.colour } },
      h('div', { class: 'row gap center-v' },
        h('h2', {}, t === '*' ? 'Squadra di casa' : 'Squadra ospite'),
        h('span', { class: 'spacer' }),
        lib.length ? h('select', {
          'aria-label': 'Carica dalla libreria',
          onchange: (e) => {
            const x = lib.find((l) => l.name === e.target.value);
            if (x) { Object.assign(T, structuredClone(x)); T.players = T.players.map((p) => newPlayer({ ...p })); app.touch(); render(); toast(`Squadra ${x.name} caricata`); }
          },
        }, h('option', { value: '' }, '📚 Libreria…'), lib.map((l) => h('option', { value: l.name }, l.name))) : null,
        h('button', { class: 'btn small', onclick: () => { saveTeam(T); toast('Squadra salvata in libreria'); render(); } }, '💾 In libreria')),
      h('div', { class: 'grid3' },
        field(T, 'name', 'Nome'),
        field(T, 'code', 'Sigla (3 lettere)'),
        h('label', { class: 'field' }, h('span', {}, 'Colore'), h('input', { type: 'color', value: T.colour, onchange: (e) => { T.colour = e.target.value; app.touch(); render(); } })),
        field(T, 'coach', 'Allenatore'),
        field(T, 'assistant', 'Vice allenatore')),
      h('table', { class: 'roster' },
        h('thead', {}, h('tr', {}, h('th', {}, 'N°'), h('th', {}, 'Cognome'), h('th', {}, 'Nome'), h('th', {}, 'Ruolo'), h('th', {}, 'Cap.'), h('th', {}, ''))),
        tbody),
      h('div', { class: 'row gap wrap' },
        h('button', { class: 'btn', onclick: () => { T.players.push(newPlayer({ number: nextNum(T) })); app.touch(); drawRows(); } }, '+ Giocatore'),
        h('button', { class: 'btn', onclick: () => pasteRoster(T, drawRows) }, '📋 Incolla rosa'),
        h('button', { class: 'btn', onclick: () => importFromDvw(t) }, '⬆ Da file DVW')));
  }
  const nextNum = (T) => { const used = new Set(T.players.map((p) => Number(p.number))); for (let n = 1; n < 100; n++) if (!used.has(n)) return n; return null; };

  function pasteRoster(T, redraw) {
    const ta = h('textarea', { rows: 12, placeholder: 'Una riga per giocatore:\n7;Rossi;Mario;S\n10 Bianchi Luca H\n...\nRuoli: S palleggiatore, O opposto, H schiacciatore, M centrale, L libero', style: { width: '100%' } });
    modal('Incolla rosa', h('div', {}, ta, h('p', { class: 'muted' }, 'Separatori ammessi: ; , tab o spazio. Il ruolo è facoltativo.')), {
      actions: [{ label: 'Annulla' }, {
        label: 'Aggiungi', primary: true, onClick: () => {
          let n = 0;
          for (const line of ta.value.split(/\r?\n/)) {
            const c = line.trim().split(/\s*[;,\t]\s*|\s+/).filter(Boolean);
            if (!c.length || !/^\d+$/.test(c[0])) continue;
            let role = 'U';
            if (c.length > 1 && /^[SOHMLU]$/i.test(c[c.length - 1])) role = c.pop().toUpperCase();
            const num = +c[0];
            const existing = T.players.find((p) => Number(p.number) === num);
            const data = { number: num, lastName: c[1] || '', firstName: c.slice(2).join(' '), role };
            if (existing) Object.assign(existing, data); else T.players.push(newPlayer(data));
            n++;
          }
          app.touch(); redraw(); toast(`${n} giocatori inseriti`);
        },
      }],
    });
  }

  function importFromDvw(t) {
    const inp = h('input', { type: 'file', accept: '.dvw,.vsj,.json' });
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      const buf = await f.arrayBuffer();
      const txt = decodeBytes(buf);
      let m;
      try { m = /\.dvw$/i.test(f.name) ? fromDVW(txt) : JSON.parse(txt); } catch (e) { toast('File non valido: ' + e.message, 'error'); return; }
      const teams = m.teams;
      const choice = h('div', { class: 'row gap' }, ['*', 'a'].map((k) => h('button', {
        class: 'btn big', onclick: () => {
          const src = teams[k];
          Object.assign(app.match.teams[t], { name: src.name, code: src.code, coach: src.coach, assistant: src.assistant, players: src.players.map((p) => newPlayer({ ...p })) });
          if (src.colour) app.match.teams[t].colour = src.colour;
          app.touch(); dlg.close(); render(); toast(`Rosa di ${src.name} importata`);
        },
      }, `${src.name} (${src.players.length})`)));
      const dlg = modal('Quale squadra importare?', choice);
    };
    inp.click();
  }

  function render() {
    clear(root);
    const m = app.match.meta;
    const lib = listTeams();
    root.append(
      h('div', { class: 'card' },
        h('h2', {}, 'Dati della partita'),
        h('div', { class: 'grid4' },
          field(m, 'date', 'Data', { type: 'date' }), field(m, 'time', 'Ora inizio', { type: 'time' }),
          field(m, 'season', 'Stagione'), field(m, 'league', 'Campionato'),
          field(m, 'phase', 'Fase'), field(m, 'matchNumber', 'N° gara'),
          field(m, 'venue', 'Palazzetto'), field(m, 'city', 'Città'),
          field(m, 'referees', 'Arbitri'), field(m, 'scout', 'Scoutman')),
        h('div', { class: 'grid4' },
          h('label', { class: 'field' }, h('span', {}, 'Formato'), h('select', {
            onchange: (e) => {
              const [s, p, tb] = e.target.value.split('/').map(Number);
              app.match.settings.format = { setsToWin: s, points: p, tiebreakPoints: tb }; app.touch();
            },
          }, [['3/25/15', 'Al meglio dei 5 set (25/15)'], ['2/25/15', 'Al meglio dei 3 set (25/15)'], ['2/21/15', 'Beach (21/15)'], ['3/15/15', 'Giovanili 5 set da 15']].map(([v, l]) => {
            const f = app.match.settings.format;
            return h('option', { value: v, selected: `${f.setsToWin}/${f.points}/${f.tiebreakPoints}` === v }, l);
          })))),
        field(m, 'comments', 'Note', { multiline: true })),
      h('div', { class: 'grid2' }, teamCard('*'), teamCard('a')),
      lib.length ? h('div', { class: 'card' }, h('h3', {}, 'Libreria squadre'),
        h('div', { class: 'chips' }, lib.map((l) => h('span', { class: 'chip static' }, `${l.name} (${l.players.length})`,
          h('button', { class: 'icon-btn danger', title: 'Elimina dalla libreria', onclick: async () => { if (await confirmDialog('Elimina', `Eliminare ${l.name} dalla libreria?`)) { deleteTeam(l.name); render(); } } }, '✕'))))) : null,
      h('div', { class: 'row gap' },
        h('button', { class: 'btn primary big', onclick: () => { app.showTab('scout'); if (!app.rp.current) app.openLineup(); } }, 'Vai allo scouting →')),
    );
  }

  return { el: root, render };
}

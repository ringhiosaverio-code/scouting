// Piccole utilità DOM senza dipendenze.
export function h(tag, attrs = {}, ...children) {
  const el = tag === 'svg' || attrs.svg ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false || k === 'svg') continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && !(el instanceof SVGElement) && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const SVGNS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

export function toast(msg, kind = 'info', ms = 2600) {
  let box = $('#toasts');
  if (!box) document.body.appendChild((box = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' })));
  const t = h('div', { class: `toast ${kind}` }, msg);
  box.appendChild(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

// Finestra modale; restituisce { el, close }
export function modal(title, body, { actions = [], wide = false, onClose } = {}) {
  const back = h('div', { class: 'modal-back' });
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); onClose?.(); };
  const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  const foot = h('div', { class: 'modal-foot' }, actions.map((a) => h('button', {
    class: `btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}`,
    onclick: () => { if (a.onClick?.() !== false) close(); },
  }, a.label)));
  const box = h('div', { class: `modal ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', 'aria-label': 'Chiudi', onclick: close }, '✕')),
    h('div', { class: 'modal-body' }, body),
    actions.length ? foot : null);
  back.appendChild(box);
  back.addEventListener('mousedown', (ev) => { if (ev.target === back) close(); });
  document.body.appendChild(back);
  const first = box.querySelector('input, select, textarea, button.primary');
  first?.focus();
  return { el: box, close };
}

export function confirmDialog(title, text, okLabel = 'Conferma') {
  return new Promise((res) => {
    let done = false;
    modal(title, h('p', {}, text), {
      actions: [
        { label: 'Annulla', onClick: () => { done = true; res(false); } },
        { label: okLabel, primary: true, onClick: () => { done = true; res(true); } },
      ],
      onClose: () => { if (!done) res(false); },
    });
  });
}

export const fmtTime = (t) => {
  if (t == null || Number.isNaN(t)) return '--:--';
  const sgn = t < 0 ? '-' : '';
  t = Math.abs(t);
  const hh = Math.floor(t / 3600), mm = Math.floor(t / 60) % 60, ss = Math.floor(t % 60), ds = Math.floor((t * 10) % 10);
  return sgn + (hh ? `${hh}:${String(mm).padStart(2, '0')}` : `${mm}`) + `:${String(ss).padStart(2, '0')}.${ds}`;
};

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

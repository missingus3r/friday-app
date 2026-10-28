// Utilidades de interfaz compartidas por todas las vistas.
// Todo el texto que viene del gateway entra por textContent o por md(), que escapa antes de formatear.

// append/replaceChildren nativos convierten null en el texto "null"; acá se ignoran, igual que en h().
// (WebViews viejos de Android no traen replaceChildren: se arma con append.)
for (const fn of ['append', 'replaceChildren']) {
  const orig = Element.prototype[fn] || function (...kids) { this.textContent = ''; this.append(...kids); };
  Element.prototype[fn] = function (...kids) {
    return orig.apply(this, kids.filter((k) => k !== null && k !== undefined && k !== false));
  };
}

// En el celular la app se activa con un link (ngrok + token) en vez de un token suelto.
const MOBILE = !!(window.friday && window.friday.platform === 'mobile');

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  chat: '<path d="M4 5h16v11H8l-4 4z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  micOff: '<path d="M9 9v2a3 3 0 0 0 5 2.2M15 11V6a3 3 0 0 0-5.8-1M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18"/>',
  home: '<path d="M3 11l9-7 9 7v9h-6v-6H9v6H3z"/>',
  tasks: '<path d="M4 6h3M4 12h3M4 18h3M10 6h10M10 12h10M10 18h10"/>',
  memory: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  conv: '<path d="M3 6h12v8H7l-4 3zM9 17h8l4 3v-9h-3"/>',
  agents: '<rect x="5" y="7" width="14" height="11" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01"/>',
  api: '<path d="M8 6l-5 6 5 6M16 6l5 6-5 6M14 4l-4 16"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  send: '<path d="M4 12l16-8-6 16-3-7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
};

function icon(name, size = 18) {
  const span = document.createElement('span');
  span.className = 'ico';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Markdown mínimo: bloques de código, títulos, listas, negrita, cursiva, código y links http(s).
function md(src) {
  const blocks = [];
  let s = esc(src || '').replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  const inline = (t) => t
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank">$2</a>');
  const out = [];
  let list = null;
  const flush = () => { if (list) { out.push(`<${list.tag}>${list.items.join('')}</${list.tag}>`); list = null; } };
  for (const line of s.split('\n')) {
    let m;
    if ((m = line.match(/^\u0000(\d+)\u0000$/))) { flush(); out.push(blocks[+m[1]]); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flush(); out.push(`<h${m[1].length + 2}>${inline(m[2])}</h${m[1].length + 2}>`); continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      if (!list || list.tag !== 'ul') { flush(); list = { tag: 'ul', items: [] }; }
      list.items.push(`<li>${inline(m[1])}</li>`); continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (!list || list.tag !== 'ol') { flush(); list = { tag: 'ol', items: [] }; }
      list.items.push(`<li>${inline(m[1])}</li>`); continue;
    }
    flush();
    out.push(line.trim() === '' ? '' : `<p>${inline(line).replace(/\u0000(\d+)\u0000/g, (_x, i) => blocks[+i])}</p>`);
  }
  flush();
  return out.filter(Boolean).join('');
}

function parseDate(v) {
  if (!v) return null;
  // El gateway mezcla "2026-10-28T13:25:20-0300" con ISO normal: normalizo el offset sin dos puntos.
  const d = new Date(String(v).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
  return isNaN(d) ? null : d;
}

function fmtDate(v, withYear = false) {
  const d = parseDate(v);
  if (!d) return v ? String(v) : '—';
  return d.toLocaleString('es-UY', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    ...(withYear ? { year: 'numeric' } : {}),
  });
}

function ago(v) {
  const d = parseDate(v);
  if (!d) return '';
  const s = Math.round((Date.now() - d) / 1000);
  const abs = Math.abs(s);
  const unit = abs < 60 ? [abs, 's'] : abs < 3600 ? [Math.round(abs / 60), 'min'] : abs < 86400 ? [Math.round(abs / 3600), 'h'] : [Math.round(abs / 86400), 'd'];
  return s >= 0 ? `hace ${unit[0]} ${unit[1]}` : `en ${unit[0]} ${unit[1]}`;
}

// Convierte el valor de <input type="datetime-local"> a ISO con el offset local (ej. 2026-10-30T10:00-03:00).
function localIso(v) {
  if (!v) return null;
  const d = new Date(v);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return `${v.slice(0, 16)}${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

function toast(msg, kind = 'info', ms = 3800) {
  const t = h('div', { class: `toast ${kind}` }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

function errText(r) {
  if (r.error) return `No se pudo conectar: ${r.error}`;
  const d = r.data;
  if (d && d.detail) {
    if (Array.isArray(d.detail)) return d.detail.map((x) => `${(x.loc || []).slice(1).join('.')}: ${x.msg}`).join(' · ');
    return `${r.status}: ${d.detail}`;
  }
  return `Error ${r.status}`;
}

// Llamada al gateway; si falla muestra el error y devuelve null (salvo quiet).
// auth: 'master' (token del gateway) o 'node' (token de este equipo para el chat).
async function api(method, path, { query, body, quiet, timeoutMs, auth } = {}) {
  const r = await window.friday.api({ method, path, query, body, timeoutMs, auth });
  if (!r.ok) {
    if (!quiet) toast(errText(r), 'err', 6000);
    if (r.status === 401 && auth !== 'node') setConn('token inválido', 'bad');
    return null;
  }
  return r.data;
}

// Botón que pide un segundo click para confirmar (acciones sin vuelta atrás).
function confirmButton(label, onConfirm, { cls = '', iconName } = {}) {
  let armed = false, timer;
  const b = h('button', { class: `btn ${cls}` }, iconName ? icon(iconName, 15) : null, h('span', {}, label));
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!armed) {
      armed = true;
      b.classList.add('armed');
      b.querySelector('span').textContent = '¿Seguro?';
      timer = setTimeout(() => { armed = false; b.classList.remove('armed'); b.querySelector('span').textContent = label; }, 3000);
      return;
    }
    clearTimeout(timer);
    b.disabled = true;
    await onConfirm();
    b.disabled = false;
  });
  return b;
}

function spinner() { return h('span', { class: 'spin' }); }

function empty(text) { return h('div', { class: 'empty' }, text); }

function pageHead(title, sub, ...actions) {
  return h('header', { class: 'page-head' },
    h('div', {}, h('h1', {}, title), sub ? h('p', { class: 'sub' }, sub) : null),
    h('div', { class: 'actions' }, ...actions));
}

function refreshBtn(fn) {
  const b = h('button', { class: 'btn ghost icon-only', title: 'Actualizar (F5)' }, icon('refresh', 16));
  b.addEventListener('click', async () => { b.classList.add('rot'); await fn(); setTimeout(() => b.classList.remove('rot'), 400); });
  return b;
}

// Muestra cualquier JSON de forma legible (para formas que el gateway agregue en el futuro).
function jsonView(data) {
  return h('pre', { class: 'json' }, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

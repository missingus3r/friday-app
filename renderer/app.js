// Arranque: navegación lateral, indicador de conexión y atajos de teclado.

function setConn(text, kind) {
  document.getElementById('conn').textContent = text;
  document.getElementById('orb').className = `orb ${kind || ''}`;
  const top = document.getElementById('topOrb');
  if (top) top.className = `orb ${kind || ''}`;
}

const sections = [];
let current = null;

function go(id) {
  const next = sections.find((s) => s.id === id);
  if (!next || next === current) return;
  if (current) { current.view.el.hidden = true; current.btn.classList.remove('on'); current.view.onHide && current.view.onHide(); }
  current = next;
  next.view.el.hidden = false;
  next.btn.classList.add('on');
  // Pantallas angostas (celular): barra superior con el nombre de la sección y menú desplegable.
  const title = document.getElementById('topTitle');
  if (title) title.textContent = next.btn.textContent;
  document.body.classList.remove('nav-open');
  try { localStorage.setItem('section', id); } catch { /* opcional */ }
  next.view.onShow && next.view.onShow();
}

async function heartbeat() {
  const r = await window.friday.api({ method: 'GET', path: '/ping', timeoutMs: 6000 });
  if (!r.ok) { setConn(r.error ? 'sin conexión' : `error ${r.status}`, 'bad'); return; }
  const c = await window.friday.getConfig();
  if (!c.activated) { setConn('sin activar', 'warn'); return; }
  setConn(`en línea · ${r.ms} ms`, 'ok');
  document.getElementById('sideFoot').textContent = `${r.data.service || 'gateway'} ${r.data.version || ''}`;
}

(async function init() {
  const cfg = await window.friday.getConfig();

  // Sin token: solo la bienvenida, que pide el token que Friday da por Telegram.
  if (!cfg.activated) {
    document.body.classList.add('bare');
    document.getElementById('main').append(Onboarding(() => location.reload()));
    heartbeat();
    return;
  }

  // need: qué tiene que habilitar el token para mostrar la sección.
  const chat = ChatView(cfg.caps);
  const defs = [
    ['chat', 'Chat', 'chat', chat, null],
    ['voice', 'Voz', 'mic', VoiceView(), 'node'],
    ['home', 'Estado', 'home', HomeView((id) => go(id)), 'master'],
    ['tasks', 'Tareas', 'tasks', TasksView(), 'master'],
    ['memory', 'Memoria', 'memory', MemoryView(), 'master'],
    ['conv', 'Conversaciones', 'conv', ConversationsView(cfg.caps), null],
    ['agents', 'Agentes', 'agents', AgentsView(), 'master'],
    ['api', 'API', 'api', ApiView(), null],
    ['settings', 'Ajustes', 'settings', SettingsView(() => { heartbeat(); }), null],
  ].filter((d) => !d[4] || cfg.caps[d[4]]);
  const nav = document.getElementById('nav');
  const main = document.getElementById('main');
  const menuBtn = h('button', { class: 'btn ghost icon-only', title: 'Menú' }, icon('tasks', 18));
  menuBtn.addEventListener('click', () => document.body.classList.toggle('nav-open'));
  const scrim = h('div', { class: 'scrim' });
  scrim.addEventListener('click', () => document.body.classList.remove('nav-open'));
  document.body.prepend(h('header', { class: 'topbar' }, menuBtn, h('span', { id: 'topTitle' }), h('div', { class: 'orb', id: 'topOrb' })), scrim);
  // Botón "atrás" del celular: si no está en el chat, vuelve al chat.
  window.fridayBack = () => { if (current && current.id !== 'chat') { go('chat'); return true; } return false; };
  defs.forEach(([id, label, ico, view], i) => {
    const btn = h('button', { class: 'nav-btn', title: `${label} (Ctrl+${i + 1})` }, icon(ico, 19), h('span', {}, label));
    btn.addEventListener('click', () => go(id));
    if (id === 'settings') nav.append(h('div', { class: 'nav-gap' }));
    nav.append(btn);
    view.el.hidden = true;
    main.append(view.el);
    sections.push({ id, view, btn });
  });

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && /^[1-9]$/.test(e.key)) { e.preventDefault(); const s = sections[+e.key - 1]; if (s) go(s.id); }
    if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); go('chat'); }
    if (e.key === 'F5') { e.preventDefault(); current && current.view.onShow && current.view.onShow(); }
  });

  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();

  let start = 'chat';
  try { start = localStorage.getItem('section') || 'chat'; } catch { /* opcional */ }
  if (!sections.some((s) => s.id === start)) start = 'chat';
  go(start);
  // El chat sondea aunque no esté a la vista, para avisar cuando llega una respuesta.
  if (start !== 'chat') chat.start();
  heartbeat();
  setInterval(heartbeat, 15000);
})();

// Una función por sección. Cada vista devuelve { el, onShow, onHide } y queda viva entre cambios de sección.

const MODELS = [
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-haiku-5-5', 'Haiku 5.5'],
];
const modelName = (id) => (MODELS.find((m) => m[0] === id) || [id, id || '—'])[1];
const isActive = (a) => /run|queu|start|pend|curso|wait|lanz/i.test(a.status || '');
const money = (v) => (typeof v === 'number' ? `US$ ${v < 0.01 ? v.toFixed(4) : v.toFixed(3)}` : '');

function statusChip(status) {
  const s = String(status || '?');
  const kind = /done|ok|complet/i.test(s) ? 'ok' : /run|queu|start|pend|curso|wait|lanz/i.test(s) ? 'run' : /kill|cancel|cort|stop/i.test(s) ? 'mute' : 'bad';
  return h('span', { class: `chip ${kind}` }, kind === 'run' ? spinner() : null, s);
}

// Detalle de agentes terminados: no cambia, así que se cachea para no pedirlo de nuevo.
const agentDetail = new Map();
async function loadAgentDetails(list) {
  const missing = list.filter((a) => !isActive(a) && !agentDetail.has(a.id));
  const queue = missing.slice();
  const worker = async () => {
    while (queue.length) {
      const a = queue.shift();
      const d = await api('GET', `/agents/${encodeURIComponent(a.id)}`, { quiet: true });
      if (d) agentDetail.set(a.id, d);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
  return missing.length;
}

function notifyDone(a) {
  const d = agentDetail.get(a.id) || a;
  const text = (d.result || d.status || '').toString().slice(0, 140);
  toast(`Friday respondió: ${text}`, 'ok', 5000);
  if (!document.hasFocus() && 'Notification' in window) {
    try { new Notification('Friday', { body: text }); } catch { /* sin permisos de notificación */ }
  }
}

/* ------------------------------------------------------------------ Chat */
// Dos modos: "En vivo" habla con la sesión real de Friday por el canal de este nodo;
// "Agente" lanza un claude -p aparte en segundo plano.
function ChatView(caps = { node: true, master: true }) {
  const live = LiveChat();
  const agent = AgentChat();
  let mode = 'live';
  // Cada modo depende de lo que habilite el token: en vivo = nodo, agente = maestro.
  const modes = [['live', 'En vivo', live, caps.node], ['agent', 'Agente', agent, caps.master]].filter((m) => m[3]);
  if (!modes.some((m) => m[0] === mode)) mode = modes[0][0];
  const seg = h('div', { class: 'seg', hidden: modes.length < 2 });
  const sub = h('p', { class: 'sub' });
  const head = h('header', { class: 'page-head' },
    h('div', {}, h('h1', {}, 'Chat'), sub), seg, refreshBtn(() => current().onShow()));
  const current = () => (mode === 'live' ? live : agent);
  function setMode(m) {
    mode = m;
    [...seg.children].forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    live.el.hidden = m !== 'live';
    agent.el.hidden = m !== 'agent';
    sub.textContent = m === 'live'
      ? 'Charlá con Friday de verdad: la misma sesión que en Telegram, en un canal propio de este equipo.'
      : 'Cada mensaje lanza un agente aparte en segundo plano; útil para encargos largos.';
    current().onShow();
  }
  for (const [m, l] of modes) {
    const b = h('button', { class: 'seg-btn', 'data-m': m }, l);
    b.addEventListener('click', () => setMode(m));
    seg.append(b);
  }
  const el = h('section', { class: 'view chat' }, head, live.el, agent.el);
  return {
    el,
    onShow() { setMode(mode); },
    start() { if (caps.node) live.start(); if (caps.master) agent.start(); },
  };
}

// Campos del ledger de chat: tolera nombres alternativos porque el gateway es joven.
const pick = (...vals) => vals.find((v) => v !== undefined && v !== null);
const msgText = (m) => pick(m.text, m.content, m.message, '');
const msgTime = (m) => m.ts || m.timestamp || m.created_at || m.time;
function msgIsMine(m, node) {
  const who = String(m.role || m.direction || m.from || m.sender || m.author || '').toLowerCase();
  if (/assistant|friday|session|sesi|out|reply|bot/.test(who)) return false;
  if (/user|in\b|node|app|human/.test(who)) return true;
  if (node && (m.node === node || m.from === node)) return !m.reply_to;
  return !m.reply_to;
}

function LiveChat() {
  let cfg = null;
  let cursor = 0;
  let msgs = [];
  let timer = null;
  let waiting = false; // mandé y todavía no hay respuesta
  const thread = h('div', { class: 'thread' });
  const scroller = h('div', { class: 'thread-scroll' }, thread);
  const input = h('textarea', { class: 'composer-input', rows: 1, placeholder: MOBILE ? 'Escribile a Friday…' : 'Escribile a Friday…  (Enter envía · Shift+Enter nueva línea)' });
  const sendBtn = h('button', { class: 'btn primary send', title: 'Enviar' }, icon('send', 17));
  const status = h('span', { class: 'hint' });
  const composer = h('div', { class: 'composer' },
    h('div', { class: 'composer-box' }, input, sendBtn),
    h('div', { class: 'composer-opts' }, h('span', { class: 'live-dot' }), h('span', { class: 'node-name' }), status));
  const setup = h('div', { class: 'node-setup' });
  const el = h('div', { class: 'chat-pane' }, setup, scroller, composer);

  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 220) + 'px'; };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !MOBILE) { e.preventDefault(); send(); } });
  sendBtn.addEventListener('click', send);
  const nearBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;

  function bubble(m) {
    const mine = msgIsMine(m, cfg && cfg.nodeName);
    const text = msgText(m);
    const meta = h('div', { class: 'meta' }, h('span', { title: msgTime(m) }, fmtDate(msgTime(m))), m.channel && !mine ? h('span', {}, m.channel) : null);
    if (mine) return h('div', { class: 'msg me' }, h('div', { class: 'bubble' }, h('div', { class: 'md', html: md(text) }), h('div', { class: 'bubble-foot end' }, meta)));
    const copy = h('button', { class: 'btn ghost small' }, 'Copiar');
    copy.addEventListener('click', () => { navigator.clipboard.writeText(text); toast('Copiado'); });
    return h('div', { class: 'msg friday' }, h('div', { class: 'avatar' }),
      h('div', { class: 'bubble' }, h('div', { class: 'md', html: md(text) }), h('div', { class: 'bubble-foot' }, meta, h('div', { class: 'bubble-actions' }, copy))));
  }

  function render() {
    const stick = nearBottom();
    thread.replaceChildren();
    if (!msgs.length) {
      thread.append(h('div', { class: 'hello' }, h('div', { class: 'orb big' }), h('h2', {}, 'Hola, soy Friday'),
        h('p', {}, 'Esto llega a mi sesión real, igual que Telegram. Te contesto acá.')));
    }
    let day = '';
    for (const m of msgs) {
      const d = parseDate(msgTime(m));
      const key = d ? d.toLocaleDateString('es-UY', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
      if (key && key !== day) { day = key; thread.append(h('div', { class: 'day' }, key)); }
      thread.append(bubble(m));
    }
    if (waiting) thread.append(h('div', { class: 'msg friday' }, h('div', { class: 'avatar' }), h('div', { class: 'bubble' }, h('div', { class: 'typing' }, h('i'), h('i'), h('i')))));
    if (stick) scroller.scrollTop = scroller.scrollHeight;
  }

  async function refreshCfg() {
    cfg = await window.friday.getConfig();
    const ready = cfg.hasNode;
    setup.hidden = ready;
    scroller.hidden = composer.hidden = !ready;
    el.querySelector('.node-name').textContent = ready && cfg.nodeName ? `canal app:${cfg.nodeName}` : '';
    return ready;
  }

  async function load(full) {
    clearTimeout(timer);
    if (!cfg || !cfg.hasNode) { if (!(await refreshCfg())) return; }
    if (full) { cursor = 0; msgs = []; }
    const r = await window.friday.api({ path: '/chat/messages', query: { since: cursor, limit: 200 }, auth: 'node' });
    if (!r.ok) {
      status.textContent = r.status === 401 ? 'Friday rechazó el token de la app: pedile uno nuevo por Telegram y cambialo en Ajustes' : `sin conexión (${r.error || r.status})`;
      el.querySelector('.live-dot').className = 'live-dot bad';
    } else {
      el.querySelector('.live-dot').className = 'live-dot ok';
      status.textContent = '';
      const list = Array.isArray(r.data) ? r.data : r.data.messages || r.data.results || [];
      const seen = new Set(msgs.map((m) => m.id));
      const fresh = list.filter((m) => m.id === undefined || !seen.has(m.id));
      if (fresh.length || full) {
        msgs = msgs.concat(fresh).sort((a, b) => (a.id || 0) - (b.id || 0));
        for (const m of fresh) if (typeof m.id === 'number') cursor = Math.max(cursor, m.id);
        const replies = fresh.filter((m) => !msgIsMine(m, cfg.nodeName));
        if (replies.length && !full) {
          waiting = false;
          const last = msgText(replies[replies.length - 1]);
          if (!el.offsetParent || !document.hasFocus()) {
            toast(`Friday: ${last.slice(0, 140)}`, 'ok', 5000);
            if (!document.hasFocus() && 'Notification' in window) { try { new Notification('Friday', { body: last.slice(0, 200) }); } catch { /* sin permiso */ } }
          }
        }
        if (msgs.length && !msgIsMine(msgs[msgs.length - 1], cfg.nodeName)) waiting = false;
        render();
        if (full) scroller.scrollTop = scroller.scrollHeight;
      }
    }
    timer = setTimeout(() => load(false), waiting ? 1500 : el.offsetParent ? 3000 : 8000);
  }

  async function send() {
    const text = input.value.trim();
    if (!text || sendBtn.disabled) return;
    sendBtn.disabled = true;
    const r = await api('POST', '/chat', { body: { text }, auth: 'node' });
    sendBtn.disabled = false;
    if (!r) return;
    input.value = ''; autosize();
    waiting = true;
    await load(false);
    render();
    scroller.scrollTop = scroller.scrollHeight;
  }

  return {
    el,
    async onShow() { await refreshCfg(); load(true); setTimeout(() => input.focus(), 50); },
    start() { refreshCfg().then((ok) => ok && load(true)); },
  };
}

function AgentChat() {
  let agents = [];
  let timer = null;
  let pending = null;
  const known = new Map(); // id -> último status visto, para avisar cuando termina

  const thread = h('div', { class: 'thread' });
  const scroller = h('div', { class: 'thread-scroll' }, thread);
  const input = h('textarea', { class: 'composer-input', rows: 1, placeholder: MOBILE ? 'Escribile a Friday…' : 'Escribile a Friday…  (Enter envía · Shift+Enter nueva línea)' });
  const model = h('select', { class: 'mini' }, MODELS.map(([v, l]) => h('option', { value: v }, l)));
  const web = h('input', { type: 'checkbox', checked: true });
  const timeout = h('select', { class: 'mini' }, [[300, '5 min'], [900, '15 min'], [1800, '30 min'], [3600, '60 min']].map(([v, l]) => h('option', { value: v, selected: v === 900 }, l)));
  const sendBtn = h('button', { class: 'btn primary send', title: 'Enviar' }, icon('send', 17));

  try {
    const saved = JSON.parse(localStorage.getItem('chatPrefs') || '{}');
    if (saved.model) model.value = saved.model;
    if (saved.web !== undefined) web.checked = saved.web;
    if (saved.timeout) timeout.value = saved.timeout;
  } catch { /* preferencias opcionales */ }
  const savePrefs = () => { try { localStorage.setItem('chatPrefs', JSON.stringify({ model: model.value, web: web.checked, timeout: timeout.value })); } catch { /* idem */ } };
  [model, web, timeout].forEach((x) => x.addEventListener('change', savePrefs));

  const autosize = () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 220) + 'px'; };
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !MOBILE) { e.preventDefault(); send(); }
  });
  sendBtn.addEventListener('click', send);

  const el = h('div', { class: 'chat-pane' },
    scroller,
    h('div', { class: 'composer' },
      h('div', { class: 'composer-box' }, input, sendBtn),
      h('div', { class: 'composer-opts' },
        h('label', {}, 'Modelo ', model),
        h('label', { class: 'check' }, web, ' Web'),
        h('label', {}, 'Límite ', timeout),
        h('span', { class: 'hint cost-hint' }))));

  function nearBottom() { return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120; }

  function bubbleFor(a) {
    const d = agentDetail.get(a.id) || a;
    const active = isActive(a);
    const replyBody = active
      ? h('div', { class: 'typing' }, h('i'), h('i'), h('i'))
      : d.result
        ? h('div', { class: 'md', html: md(d.result) })
        : h('div', { class: 'md muted' }, d.error || (agentDetail.has(a.id) ? 'Sin respuesta.' : 'Cargando…'));
    const meta = h('div', { class: 'meta' },
      statusChip(a.status), h('span', {}, modelName(a.model)), a.web ? h('span', {}, 'web') : null,
      money(d.cost_usd) ? h('span', {}, money(d.cost_usd)) : null,
      h('span', { title: a.started }, fmtDate(a.started)));
    const denials = (d.denials || []).length
      ? h('details', { class: 'denials' }, h('summary', {}, `${d.denials.length} permiso(s) denegado(s)`), jsonView(d.denials))
      : null;
    const actions = h('div', { class: 'bubble-actions' });
    if (active) actions.append(confirmButton('Cortar', async () => { await kill(a.id); }, { cls: 'ghost danger small', iconName: 'stop' }));
    else if (d.result) {
      const copy = h('button', { class: 'btn ghost small' }, 'Copiar');
      copy.addEventListener('click', () => { navigator.clipboard.writeText(d.result); toast('Copiado'); });
      const reuse = h('button', { class: 'btn ghost small' }, 'Reusar pregunta');
      reuse.addEventListener('click', () => { input.value = a.prompt || ''; autosize(); input.focus(); });
      actions.append(copy, reuse);
    }
    return h('div', { class: 'turn', 'data-id': a.id },
      h('div', { class: 'msg me' }, h('div', { class: 'bubble' }, h('div', { class: 'md', html: md(a.prompt || '') }))),
      h('div', { class: 'msg friday' },
        h('div', { class: 'avatar' }),
        h('div', { class: 'bubble' }, replyBody, denials, h('div', { class: 'bubble-foot' }, meta, actions))));
  }

  function render() {
    const stick = nearBottom();
    thread.replaceChildren();
    if (!agents.length && !pending) {
      thread.append(h('div', { class: 'hello' },
        h('div', { class: 'orb big' }),
        h('h2', {}, 'Encargale algo a un agente'),
        h('p', {}, 'Friday arranca un claude -p aparte con sus herramientas y la respuesta aparece acá cuando termina.')));
    }
    for (const a of agents) thread.append(bubbleFor(a));
    if (pending) thread.append(bubbleFor(pending));
    const total = agents.reduce((s, a) => s + ((agentDetail.get(a.id) || a).cost_usd || 0), 0);
    const cost = el.querySelector('.cost-hint');
    if (cost) cost.textContent = total ? `Gasto visible: ${money(total)}` : '';
    if (stick) scroller.scrollTop = scroller.scrollHeight;
  }

  async function load(scroll) {
    const list = await api('GET', '/agents', { query: { limit: 60 }, quiet: !scroll });
    if (!list) return;
    const sorted = list.slice().sort((x, y) => (parseDate(x.started) || 0) - (parseDate(y.started) || 0));
    const finished = [];
    for (const a of sorted) {
      const prev = known.get(a.id);
      if (prev && isActive({ status: prev }) && !isActive(a)) { agentDetail.delete(a.id); finished.push(a); }
      known.set(a.id, a.status);
    }
    agents = sorted;
    if (pending && agents.some((a) => a.id === pending.id)) pending = null;
    await loadAgentDetails(agents);
    finished.forEach(notifyDone);
    render();
    if (scroll) scroller.scrollTop = scroller.scrollHeight;
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    const busy = pending || agents.some(isActive);
    timer = setTimeout(() => load(false), busy ? 2500 : 20000);
  }

  async function send() {
    const prompt = input.value.trim();
    if (!prompt || sendBtn.disabled) return;
    sendBtn.disabled = true;
    const body = { prompt, model: model.value, web: web.checked, timeout_s: +timeout.value };
    pending = { id: '_pending', prompt, model: model.value, web: web.checked, status: 'lanzando', started: new Date().toISOString() };
    input.value = ''; autosize();
    render(); scroller.scrollTop = scroller.scrollHeight;
    const r = await api('POST', '/agents', { body });
    sendBtn.disabled = false;
    if (!r) { pending = null; input.value = prompt; autosize(); render(); return; }
    if (r.id) { pending = { ...pending, ...r, status: r.status || 'running' }; known.set(r.id, pending.status); }
    await load(true);
  }

  async function kill(id) {
    const r = await api('DELETE', `/agents/${encodeURIComponent(id)}`);
    if (r) toast('Agente cortado', 'ok');
    await load(false);
  }

  return {
    el,
    onShow() { load(true); setTimeout(() => input.focus(), 50); },
    start() { load(false); },
  };
}

/* ------------------------------------------------------------------ Inicio */
function HomeView(go) {
  const body = h('div', { class: 'grid' });
  const el = h('section', { class: 'view' }, pageHead('Estado', 'Salud de Friday, bandeja de los recolectores y crons.', refreshBtn(load)), body);

  const card = (title, iconName, ...content) => h('div', { class: 'card' }, h('div', { class: 'card-title' }, icon(iconName, 16), title), ...content);

  async function load() {
    body.replaceChildren(h('div', { class: 'card wide' }, spinner(), ' Consultando a Friday…'));
    const t0 = performance.now();
    const [ping, bandeja, crons, tareas, agents] = await Promise.all([
      window.friday.api({ method: 'GET', path: '/ping', timeoutMs: 8000 }),
      api('GET', '/bandeja', { quiet: true }),
      api('GET', '/crons', { quiet: true }),
      api('GET', '/tareas', { quiet: true }),
      api('GET', '/agents', { query: { limit: 60 }, quiet: true }),
    ]);
    const lat = Math.round(performance.now() - t0);
    body.replaceChildren();

    const open = (tareas || []).filter((t) => t.estado !== 'cerrada' && !t.cierre);
    const late = open.filter((t) => { const v = parseDate(t.vence || t.para); return v && v < new Date(); });
    const running = (agents || []).filter(isActive);
    const stat = (n, label, kind, target) => {
      const s = h('button', { class: `stat ${kind || ''}` }, h('b', {}, String(n)), h('span', {}, label));
      if (target) s.addEventListener('click', () => go(target));
      return s;
    };
    body.append(h('div', { class: 'stats wide' },
      stat(ping.ok ? 'en línea' : 'caído', ping.ok ? `gateway ${ping.data.version || ''} · ${ping.ms} ms` : (ping.error || `HTTP ${ping.status}`), ping.ok ? 'ok' : 'bad', 'settings'),
      stat(open.length, 'tareas abiertas', '', 'tasks'),
      stat(late.length, 'tareas vencidas', late.length ? 'warn' : '', 'tasks'),
      stat(running.length, 'agentes trabajando', running.length ? 'run' : '', 'agents'),
      stat(bandeja ? (bandeja.pending || []).length : '—', 'en la bandeja', bandeja && (bandeja.pending || []).length ? 'warn' : '')));

    const healthBox = h('div', { class: 'health-lines' }, spinner(), ' corriendo chequeo…');
    body.append(card('Chequeo de salud', 'home', healthBox));
    api('GET', '/health', { quiet: true, timeoutMs: 120000 }).then((hl) => {
      healthBox.replaceChildren();
      if (!hl) { healthBox.append(empty('No se pudo correr el chequeo.')); return; }
      healthBox.append(h('div', { class: `chip ${hl.ok ? 'ok' : 'bad'}` }, hl.ok ? 'todo bien' : `exit ${hl.exit}`));
      for (const line of hl.lines || []) healthBox.append(h('div', { class: 'line' }, line));
    });

    const bandejaBox = [];
    if (!bandeja) bandejaBox.push(empty('Sin datos.'));
    else {
      bandejaBox.push(h('div', { class: `chip ${bandeja.health_ok ? 'ok' : 'bad'}` }, bandeja.health || (bandeja.health_ok ? 'OK' : 'con problemas')));
      const pend = bandeja.pending || [];
      if (!pend.length) bandejaBox.push(h('p', { class: 'muted' }, 'Nada pendiente de los recolectores.'));
      for (const p of pend) bandejaBox.push(h('div', { class: 'item' }, typeof p === 'string' ? p : jsonView(p)));
    }
    body.append(card('Bandeja', 'memory', ...bandejaBox));

    if (crons) {
      const collectors = (crons.collectors || []).map((line) => {
        const name = (line.match(/friday-collector:(\S+)/) || [])[1] || (line.match(/\/([\w.-]+)\.(py|sh)\b/) || [])[1] || '¿?';
        const expr = line.trim().split(/\s+/).slice(0, 5).join(' ');
        return h('div', { class: 'row', title: line }, h('code', {}, expr), h('span', {}, name));
      });
      body.append(card(`Recolectores (${collectors.length})`, 'agents', ...(collectors.length ? collectors : [empty('Ninguno.')])));
      const snap = new Map((crons.snapshot || []).map((s) => [s.job_id, s]));
      const sess = Object.entries(crons.session_crons || {}).map(([label, val]) => {
        const [jobId, when] = String(val).split('|');
        const s = snap.get(jobId) || {};
        return h('div', { class: 'row', title: s.prompt_preview || '' },
          h('code', {}, label), h('span', { class: 'muted' }, s.cron_expr || jobId), h('span', {}, when ? fmtDate(when) : ''));
      });
      body.append(card(`Crons de la sesión (${sess.length})`, 'tasks', ...(sess.length ? sess : [empty('Ninguno.')])));
    }
    body.append(h('p', { class: 'muted small wide' }, `Actualizado ${new Date().toLocaleTimeString('es-UY')} · ${lat} ms`));
  }

  return { el, onShow: load };
}

/* ------------------------------------------------------------------ Tareas */
function TasksView() {
  let showClosed = false;
  const list = h('div', { class: 'list' });
  const texto = h('input', { type: 'text', placeholder: 'Nueva tarea…', class: 'grow' });
  const para = h('input', { type: 'datetime-local', title: 'Recordarme el…' });
  const vence = h('input', { type: 'datetime-local', title: 'Vence el…' });
  const add = h('button', { class: 'btn primary' }, icon('plus', 15), 'Agregar');
  const toggle = h('button', { class: 'btn ghost' }, 'Ver cerradas');
  toggle.addEventListener('click', () => { showClosed = !showClosed; toggle.textContent = showClosed ? 'Solo abiertas' : 'Ver cerradas'; load(); });

  const form = h('form', { class: 'add-form' }, texto,
    h('label', { class: 'field' }, h('span', {}, 'Avisar'), para),
    h('label', { class: 'field' }, h('span', {}, 'Vence'), vence), add);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!texto.value.trim()) { texto.focus(); return; }
    add.disabled = true;
    const r = await api('POST', '/tareas', { body: { texto: texto.value.trim(), para: localIso(para.value), vence: localIso(vence.value) } });
    add.disabled = false;
    if (r) { toast('Tarea agregada', 'ok'); texto.value = ''; para.value = ''; vence.value = ''; load(); }
  });

  const el = h('section', { class: 'view' }, pageHead('Tareas', 'Lo que Friday te recuerda.', toggle, refreshBtn(load)), form, list);

  async function load() {
    const data = await api('GET', '/tareas');
    list.replaceChildren();
    if (!data) { list.append(empty('No se pudieron cargar las tareas.')); return; }
    const now = new Date();
    const rows = data.filter((t) => showClosed || (t.estado !== 'cerrada' && !t.cierre))
      .sort((a, b) => (parseDate(a.vence || a.para) || 8e15) - (parseDate(b.vence || b.para) || 8e15));
    if (!rows.length) list.append(empty(showClosed ? 'No hay tareas.' : 'No hay tareas abiertas. 🎉'));
    for (const t of rows) {
      const closed = t.estado === 'cerrada' || !!t.cierre;
      const due = parseDate(t.vence);
      const late = !closed && due && due < now;
      const remind = parseDate(t.para);
      const row = h('div', { class: `task ${closed ? 'closed' : ''} ${late ? 'late' : ''}` },
        h('div', { class: 'task-main' },
          h('div', { class: 'task-text' }, h('span', { class: 'muted' }, `#${t.id} `), t.texto),
          h('div', { class: 'task-meta' },
            remind ? h('span', {}, `avisar ${fmtDate(t.para)}`) : null,
            due ? h('span', { class: late ? 'warn' : '' }, `vence ${fmtDate(t.vence)} (${ago(t.vence)})`) : null,
            t.avisos ? h('span', {}, `${t.avisos} aviso(s)`) : null,
            closed ? h('span', {}, `cerrada ${fmtDate(t.cierre)}`) : null,
            h('span', {}, `alta ${fmtDate(t.alta)}`))),
        closed ? statusChip('cerrada') : confirmButton('Hecha', async () => {
          const r = await api('POST', `/tareas/${t.id}/done`);
          if (r !== null) { toast(`Tarea #${t.id} cerrada`, 'ok'); load(); }
        }, { cls: 'ghost', iconName: 'check' }));
      list.append(row);
    }
  }

  return { el, onShow: load };
}

/* ------------------------------------------------------------------ Memoria */
const MEM_TYPES = ['project', 'user', 'feedback', 'reference'];

function memoryCard(m) {
  if (m.role && m.content !== undefined) return messageRow(m);
  const content = m.content || m.text || '';
  const cardEl = h('div', { class: 'mem' },
    h('div', { class: 'mem-head' },
      m.type ? h('span', { class: `chip t-${m.type}` }, m.type) : null,
      h('b', {}, m.name || m.title || (m.id ? `#${m.id}` : 'memoria')),
      m.score !== undefined ? h('span', { class: 'muted small' }, `score ${Number(m.score).toFixed(2)}`) : null,
      h('span', { class: 'muted small push' }, fmtDate(m.updated_at || m.created_at || m.timestamp, true))),
    m.description ? h('div', { class: 'mem-desc' }, m.description) : null);
  if (content) {
    const body = h('div', { class: 'md mem-body', html: md(content) });
    if (content.length > 400) {
      body.classList.add('clamp');
      const more = h('button', { class: 'btn ghost small' }, 'Ver todo');
      more.addEventListener('click', () => { body.classList.toggle('clamp'); more.textContent = body.classList.contains('clamp') ? 'Ver todo' : 'Ver menos'; });
      cardEl.append(body, more);
    } else cardEl.append(body);
  }
  return cardEl;
}

function messageRow(m) {
  return h('div', { class: `logmsg ${m.role === 'user' ? 'user' : 'bot'}` },
    h('div', { class: 'logmeta' },
      h('b', {}, m.role === 'user' ? 'Vos' : m.role === 'assistant' ? 'Friday' : m.role),
      m.channel ? h('span', { class: 'chip mute' }, m.channel) : null,
      h('span', { class: 'muted small', title: m.timestamp }, fmtDate(m.timestamp, true))),
    h('div', { class: 'md', html: md(m.content) }));
}

function renderAny(data, into) {
  if (Array.isArray(data)) {
    if (!data.length) into.append(empty('Sin resultados.'));
    data.forEach((x) => into.append(x && typeof x === 'object' ? memoryCard(x) : h('div', { class: 'item' }, String(x))));
    return;
  }
  if (data && typeof data === 'object') {
    if (Array.isArray(data.results)) {
      into.append(h('p', { class: 'muted small' }, `${pick(data.count, data.results.length)} resultado(s)`));
      return renderAny(data.results, into);
    }
    let any = false;
    for (const [k, v] of Object.entries(data)) {
      if (Array.isArray(v)) {
        any = true;
        into.append(h('h3', { class: 'section-title' }, `${k} (${v.length})`));
        renderAny(v, into);
      }
    }
    if (!any) into.append(jsonView(data));
    return;
  }
  into.append(jsonView(data));
}

function MemoryView() {
  let mode = 'search';
  const out = h('div', { class: 'list' });
  const q = h('input', { type: 'search', class: 'grow', placeholder: 'Buscar en la memoria de Friday…' });
  const limit = h('select', { class: 'mini' }, [25, 50, 100, 200, 500].map((n) => h('option', { value: n, selected: n === 50 }, `${n}`)));
  const tabs = h('div', { class: 'seg' });
  const MODES = [['search', 'Buscar'], ['recall', 'Recordar tema'], ['list', 'Recientes'], ['save', 'Guardar nueva']];
  const bar = h('form', { class: 'search-bar' }, icon('search', 16), q, limit, h('button', { class: 'btn primary' }, 'Ir'));
  bar.addEventListener('submit', (e) => { e.preventDefault(); run(); });

  const fName = h('input', { type: 'text', placeholder: 'nombre_corto_sin_espacios', required: true });
  const fType = h('select', {}, MEM_TYPES.map((t) => h('option', { value: t }, t)));
  const fDesc = h('input', { type: 'text', placeholder: 'Una línea que la describa' });
  const fContent = h('textarea', { rows: 8, placeholder: 'Contenido de la memoria', required: true });
  const saveForm = h('form', { class: 'stack-form' },
    h('div', { class: 'row2' }, h('label', { class: 'field grow' }, h('span', {}, 'Nombre'), fName), h('label', { class: 'field' }, h('span', {}, 'Tipo'), fType)),
    h('label', { class: 'field' }, h('span', {}, 'Descripción'), fDesc),
    h('label', { class: 'field' }, h('span', {}, 'Contenido'), fContent),
    h('div', {}, h('button', { class: 'btn primary' }, 'Guardar memoria')));
  saveForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const r = await api('POST', '/memory', { body: { name: fName.value.trim(), type: fType.value, description: fDesc.value.trim(), content: fContent.value } });
    if (r) {
      toast('Memoria guardada', 'ok');
      fName.value = fDesc.value = fContent.value = '';
      out.replaceChildren(h('p', { class: 'muted small' }, 'Respuesta del gateway:'), jsonView(r));
    }
  });

  function setMode(m) {
    mode = m;
    [...tabs.children].forEach((b) => b.classList.toggle('on', b.dataset.m === m));
    bar.style.display = m === 'save' ? 'none' : '';
    saveForm.style.display = m === 'save' ? '' : 'none';
    q.style.display = m === 'list' ? 'none' : '';
    limit.style.display = m === 'list' ? '' : 'none';
    q.placeholder = m === 'recall' ? 'Tema a recordar (trae memorias y conversaciones)…' : 'Buscar en la memoria de Friday…';
    out.replaceChildren();
    if (m === 'list') run();
    else if (m !== 'save') q.focus();
  }
  for (const [m, l] of MODES) {
    const b = h('button', { class: 'seg-btn', 'data-m': m }, l);
    b.addEventListener('click', () => setMode(m));
    tabs.append(b);
  }

  async function run() {
    const term = q.value.trim();
    if (mode !== 'list' && !term) { q.focus(); return; }
    out.replaceChildren(h('div', { class: 'muted' }, spinner(), ' buscando…'));
    const data = mode === 'search' ? await api('GET', '/memory/search', { query: { q: term } })
      : mode === 'recall' ? await api('GET', '/memory/recall', { query: { topic: term } })
        : await api('GET', '/memory/list', { query: { limit: limit.value } });
    out.replaceChildren();
    if (data === null) { out.append(empty('La consulta falló.')); return; }
    renderAny(data, out);
  }
  limit.addEventListener('change', run);

  const el = h('section', { class: 'view' }, pageHead('Memoria', 'Lo que Friday sabe y recuerda.'), tabs, bar, saveForm, out);
  setMode('search');
  return { el, onShow() { if (mode !== 'save') q.focus(); } };
}

/* ------------------------------------------------------------------ Conversaciones */
function ConversationsView(caps = { node: true, master: true }) {
  const hours = h('select', { class: 'mini' }, [[6, '6 h'], [24, '24 h'], [72, '3 días'], [168, '7 días'], [720, '30 días']].map(([v, l]) => h('option', { value: v, selected: v === 24 }, l)));
  const limit = h('select', { class: 'mini' }, [50, 100, 200, 500].map((n) => h('option', { value: n, selected: n === 100 }, `${n} msgs`)));
  const channel = h('select', { class: 'mini' }, h('option', { value: '' }, 'Todos los canales'));
  const out = h('div', { class: 'log' });
  [hours, limit, channel].forEach((s) => s.addEventListener('change', load));
  const channels = new Set();
  // ledger: historial unificado Telegram + nodos de la app (token de nodo). memoria: conversaciones guardadas.
  const sources = [['ledger', 'Ledger unificado', caps.node], ['memory', 'Memoria', caps.master]].filter((x) => x[2]);
  let source = sources[0][0];
  const seg = h('div', { class: 'seg', hidden: sources.length < 2 });
  for (const [s, l] of sources) {
    const b = h('button', { class: `seg-btn ${s === source ? 'on' : ''}`, 'data-s': s }, l);
    b.addEventListener('click', () => {
      source = s;
      [...seg.children].forEach((x) => x.classList.toggle('on', x.dataset.s === s));
      hours.hidden = s === 'ledger';
      sync.hidden = s !== 'ledger' || !caps.master;
      channels.clear();
      channel.replaceChildren(h('option', { value: '' }, 'Todos los canales'));
      load();
    });
    seg.append(b);
  }
  hours.hidden = source === 'ledger';
  const sync = h('button', { hidden: source !== 'ledger' || !caps.master, class: 'btn ghost', title: 'Copia ya los mensajes de Telegram (corre sola cada 15 s)' }, 'Sincronizar Telegram');
  sync.addEventListener('click', async () => {
    sync.disabled = true;
    const r = await api('POST', '/chat/sync-telegram');
    sync.disabled = false;
    if (r !== null) { toast('Telegram sincronizado', 'ok'); load(); }
  });

  const el = h('section', { class: 'view' },
    pageHead('Conversaciones', 'Todo lo hablado con Friday: Telegram y cada equipo con la app, marcado por canal.', sync, hours, limit, channel, refreshBtn(load)),
    seg, out);

  async function load() {
    out.replaceChildren(h('div', { class: 'muted' }, spinner(), ' cargando…'));
    let data;
    if (source === 'ledger') {
      const cfg = await window.friday.getConfig();
      if (!cfg.hasNode) {
        out.replaceChildren(empty('El token activo no habilita el ledger del chat. Pedile a Friday un token nuevo por Telegram y cambialo en Ajustes.'));
        return;
      }
      // /chat/history avanza desde el id más viejo con next_since: se recorre hasta el final y se quedan los últimos.
      let list = [], since = 0, ok = true;
      for (let page = 0; page < 50; page++) {
        const raw = await api('GET', '/chat/history', { query: { since, limit: 1000, channel: channel.value || undefined } });
        if (!raw) { ok = false; break; }
        const msgs = Array.isArray(raw) ? raw : raw.messages || raw.results || [];
        list = list.concat(msgs);
        const next = pick(raw.next_since, msgs.length ? msgs[msgs.length - 1].id : since);
        if (msgs.length < 1000 || next === since) break;
        since = next;
      }
      list = ok ? list.slice(-limit.value) : null;
      data = list && { results: list.map((m) => ({ ...m, role: m.role || (msgIsMine(m) ? 'user' : 'assistant'), content: msgText(m), timestamp: msgTime(m) })) };
    } else {
      data = await api('GET', '/conversation/recent', { query: { hours: hours.value, limit: limit.value, channel: channel.value || undefined } });
    }
    out.replaceChildren();
    if (!data) { out.append(empty('No se pudo cargar el historial.')); return; }
    const rows = (data.results || []).slice().sort((a, b) => (parseDate(a.timestamp) || 0) - (parseDate(b.timestamp) || 0));
    let added = false;
    for (const r of rows) if (r.channel && !channels.has(r.channel)) { channels.add(r.channel); added = true; }
    if (added) {
      const cur = channel.value;
      channel.replaceChildren(h('option', { value: '' }, 'Todos los canales'), ...[...channels].sort().map((c) => h('option', { value: c }, c)));
      channel.value = cur;
    }
    if (!rows.length) { out.append(empty('No hay mensajes en ese rango.')); return; }
    let day = '';
    for (const r of rows) {
      const d = parseDate(r.timestamp);
      const key = d ? d.toLocaleDateString('es-UY', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
      if (key !== day) { day = key; out.append(h('div', { class: 'day' }, key)); }
      out.append(messageRow(r));
    }
    out.scrollTop = out.scrollHeight;
    el.scrollTop = el.scrollHeight;
  }

  return { el, onShow: load };
}

/* ------------------------------------------------------------------ Agentes */
function AgentsView() {
  let selected = null;
  let timer = null;
  const table = h('div', { class: 'agent-list' });
  const detail = h('div', { class: 'agent-detail' }, empty('Elegí un agente para ver el detalle.'));
  const limit = h('select', { class: 'mini' }, [20, 50, 100, 200].map((n) => h('option', { value: n, selected: n === 50 }, `${n}`)));
  limit.addEventListener('change', load);

  const el = h('section', { class: 'view' },
    pageHead('Agentes', 'Agentes en segundo plano: estado, costo y resultado.', limit, refreshBtn(load)),
    h('div', { class: 'split' }, table, detail));

  async function showDetail(id) {
    selected = id;
    [...table.children].forEach((r) => r.classList.toggle('sel', r.dataset.id === id));
    const d = await api('GET', `/agents/${encodeURIComponent(id)}`);
    if (!d || selected !== id) return;
    if (!isActive(d)) agentDetail.set(id, d);
    const prompt = h('div', { class: 'md', html: md(d.prompt || '') });
    detail.replaceChildren(
      h('div', { class: 'detail-head' }, statusChip(d.status), h('code', {}, d.id),
        isActive(d) ? confirmButton('Cortar', async () => { const r = await api('DELETE', `/agents/${encodeURIComponent(id)}`); if (r) toast('Agente cortado', 'ok'); load(); }, { cls: 'ghost danger small', iconName: 'stop' }) : null),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Modelo'), h('dd', {}, modelName(d.model)),
        h('dt', {}, 'Web'), h('dd', {}, d.web ? 'sí' : 'no'),
        h('dt', {}, 'Inicio'), h('dd', {}, `${fmtDate(d.started, true)} (${ago(d.started)})`),
        h('dt', {}, 'Costo'), h('dd', {}, money(d.cost_usd) || '—'),
        h('dt', {}, 'PID'), h('dd', {}, pick(d.pid, '—'))),
      h('h3', { class: 'section-title' }, 'Pedido'), prompt,
      h('h3', { class: 'section-title' }, 'Resultado'),
      d.result ? h('div', { class: 'md result', html: md(d.result) }) : h('p', { class: 'muted' }, isActive(d) ? 'Todavía trabajando…' : 'Sin resultado.'),
      (d.denials || []).length ? h('details', { class: 'denials', open: true }, h('summary', {}, 'Permisos denegados'), jsonView(d.denials)) : null,
      h('details', {}, h('summary', {}, 'JSON completo'), jsonView(d)));
  }

  async function load() {
    clearTimeout(timer);
    const data = await api('GET', '/agents', { query: { limit: limit.value } });
    table.replaceChildren();
    if (!data) { table.append(empty('No se pudo cargar la lista.')); return; }
    if (!data.length) table.append(empty('Todavía no se lanzó ningún agente.'));
    for (const a of data) {
      const row = h('button', { class: `agent-row ${a.id === selected ? 'sel' : ''}`, 'data-id': a.id },
        h('div', { class: 'agent-top' }, statusChip(a.status), h('span', { class: 'muted small' }, modelName(a.model)), h('span', { class: 'muted small push' }, ago(a.started))),
        h('div', { class: 'agent-prompt' }, (a.prompt || '').slice(0, 160)),
        money(a.cost_usd) ? h('div', { class: 'muted small' }, money(a.cost_usd)) : null);
      row.addEventListener('click', () => showDetail(a.id));
      table.append(row);
    }
    if (selected) showDetail(selected);
    if (data.some(isActive) && el.isConnected && el.offsetParent) timer = setTimeout(load, 3000);
  }

  return { el, onShow: load, onHide() { clearTimeout(timer); } };
}

/* ------------------------------------------------------------------ API explorer */
function ApiView() {
  let spec = null;
  const listEl = h('div', { class: 'ep-list' });
  const panel = h('div', { class: 'ep-panel' }, empty('Elegí un endpoint.'));
  const el = h('section', { class: 'view' },
    pageHead('API', 'Todos los endpoints del gateway, leídos en vivo de /openapi.json. Si Friday suma rutas nuevas, aparecen acá solas.', refreshBtn(loadSpec)),
    h('div', { class: 'split api' }, listEl, panel));

  const deref = (s) => {
    if (s && s.$ref) return deref(s.$ref.split('/').slice(1).reduce((o, k) => o && o[k], spec));
    return s || {};
  };
  const sample = (schema) => {
    const s = deref(schema);
    if (s.default !== undefined) return s.default;
    if (s.enum) return s.enum[0];
    if (s.anyOf) return sample(s.anyOf.find((x) => x.type !== 'null') || s.anyOf[0]);
    if (s.type === 'object' || s.properties) {
      const o = {};
      for (const [k, v] of Object.entries(s.properties || {})) o[k] = sample(v);
      return o;
    }
    if (s.type === 'array') return [];
    if (s.type === 'integer' || s.type === 'number') return pick(s.minimum, 0);
    if (s.type === 'boolean') return false;
    return '';
  };

  function open(path, method, op) {
    [...listEl.querySelectorAll('.ep')].forEach((b) => b.classList.toggle('sel', b.dataset.k === `${method} ${path}`));
    const params = op.parameters || [];
    const inputs = {};
    const paramRows = params.map((p) => {
      const s = deref(p.schema);
      const inp = h('input', { type: 'text', placeholder: [s.type || (s.anyOf ? 'opcional' : ''), s.default !== undefined ? `= ${s.default}` : '', s.minimum !== undefined ? `${s.minimum}–${pick(s.maximum, '')}` : ''].filter(Boolean).join(' · ') });
      inputs[p.name] = { p, inp };
      return h('label', { class: 'field' }, h('span', {}, `${p.name} `, h('em', { class: 'muted' }, `${p.in}${p.required ? ' · requerido' : ''}`)), inp);
    });
    const bodySchema = op.requestBody && op.requestBody.content && op.requestBody.content['application/json'] && op.requestBody.content['application/json'].schema;
    const bodyArea = bodySchema ? h('textarea', { rows: 10, class: 'code', spellcheck: 'false' }, JSON.stringify(sample(bodySchema), null, 2)) : null;
    const resp = h('div', { class: 'ep-resp' });
    const sendB = h('button', { class: 'btn primary' }, icon('send', 15), 'Enviar');
    const destructive = method !== 'get';

    async function fire() {
      let p = path;
      const query = {};
      for (const [name, { p: par, inp }] of Object.entries(inputs)) {
        const v = inp.value.trim();
        if (par.in === 'path') {
          if (!v) { toast(`Falta ${name}`, 'err'); inp.focus(); return; }
          p = p.replace(`{${name}}`, encodeURIComponent(v));
        } else if (par.in === 'query' && v) query[name] = v;
      }
      let body;
      if (bodyArea) {
        try { body = JSON.parse(bodyArea.value); } catch (err) { toast(`JSON inválido: ${err.message}`, 'err'); return; }
      }
      sendB.disabled = true;
      resp.replaceChildren(h('div', { class: 'muted' }, spinner(), ' enviando…'));
      const r = await window.friday.api({ method: method.toUpperCase(), path: p, query, body, timeoutMs: 180000 });
      sendB.disabled = false;
      resp.replaceChildren(
        h('div', { class: 'resp-head' }, h('span', { class: `chip ${r.ok ? 'ok' : 'bad'}` }, r.status || 'sin conexión'), h('span', { class: 'muted small' }, `${r.ms} ms`), h('code', { class: 'muted small' }, decodeURI(r.url))),
        jsonView(r.error ? r.error : r.data));
    }
    // Los métodos que cambian datos usan el botón de doble click.
    const trigger = destructive ? confirmButton('Enviar', fire, { cls: 'primary', iconName: 'send' }) : sendB;
    if (!destructive) sendB.addEventListener('click', fire);

    panel.replaceChildren(
      h('div', { class: 'ep-title' }, h('span', { class: `verb v-${method}` }, method.toUpperCase()), h('code', {}, path)),
      h('p', {}, op.summary || ''), op.description ? h('div', { class: 'md muted', html: md(op.description) }) : null,
      paramRows.length ? h('h3', { class: 'section-title' }, 'Parámetros') : null, ...paramRows,
      bodyArea ? h('h3', { class: 'section-title' }, 'Cuerpo (JSON)') : null, bodyArea,
      bodySchema ? h('details', {}, h('summary', {}, 'Esquema'), jsonView(deref(bodySchema))) : null,
      h('div', { class: 'ep-send' }, trigger, destructive ? h('span', { class: 'muted small' }, 'Este método cambia datos en Friday: pide confirmación.') : null),
      resp);
  }

  async function loadSpec() {
    listEl.replaceChildren(h('div', { class: 'muted' }, spinner(), ' leyendo openapi.json…'));
    spec = await api('GET', '/openapi.json');
    listEl.replaceChildren();
    if (!spec || !spec.paths) { listEl.append(empty('No se pudo leer la especificación.')); return; }
    const byTag = new Map();
    for (const [path, ms] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(ms)) {
        const tag = (op.tags && op.tags[0]) || 'otros';
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag).push([path, method, op]);
      }
    }
    listEl.append(h('div', { class: 'muted small' }, `${(spec.info || {}).title || ''} ${(spec.info || {}).version || ''}`));
    for (const [tag, eps] of byTag) {
      listEl.append(h('div', { class: 'ep-tag' }, tag));
      for (const [path, method, op] of eps) {
        const b = h('button', { class: 'ep', 'data-k': `${method} ${path}`, title: op.summary || '' }, h('span', { class: `verb v-${method}` }, method.toUpperCase()), h('span', { class: 'ep-path' }, path));
        b.addEventListener('click', () => open(path, method, op));
        listEl.append(b);
      }
    }
  }

  return { el, onShow() { if (!spec) loadSpec(); } };
}

/* ------------------------------------------------------------------ Ajustes */
// Formulario de activación con un único token: lo usan la bienvenida y Ajustes.
function ActivationForm(onDone, { submitLabel = 'Activar' } = {}) {
  const token = h('input', { type: 'password', placeholder: MOBILE ? 'Pegá acá el link que te dio Friday' : 'Pegá acá el token que te dio Friday', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off' });
  const show = h('button', { type: 'button', class: 'btn ghost small' }, 'Mostrar');
  show.addEventListener('click', () => { token.type = token.type === 'password' ? 'text' : 'password'; show.textContent = token.type === 'password' ? 'Mostrar' : 'Ocultar'; });
  const base = h('input', { type: 'url', placeholder: 'http://friday.local:8800' });
  window.friday.getConfig().then((c) => { base.value = c.base; });
  const btn = h('button', { class: 'btn primary' }, submitLabel);
  const result = h('div', { class: 'test-result' });
  const form = h('form', { class: 'stack-form narrow activation' },
    h('div', { class: 'row2' }, token, show),
    h('details', { class: 'adv', hidden: MOBILE }, h('summary', {}, 'Avanzado'),
      h('label', { class: 'field' }, h('span', {}, 'Dirección del gateway'), base)),
    h('div', {}, btn),
    result);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!token.value.trim()) { token.focus(); return; }
    btn.disabled = true;
    result.replaceChildren(h('div', { class: 'muted' }, spinner(), ' probando el token con Friday…'));
    const r = await window.friday.activate(token.value.trim(), base.value.trim() || undefined);
    btn.disabled = false;
    if (!r.ok) { result.replaceChildren(h('div', { class: 'warn' }, r.error)); return; }
    token.value = '';
    result.replaceChildren(h('span', { class: 'chip ok' }, '✓ Token activado'), r.nodeName ? h('span', { class: 'muted small' }, ` canal app:${r.nodeName}`) : null);
    onDone(r);
  });
  return { el: form, focus: () => token.focus() };
}

function SettingsView(onSaved) {
  const status = h('div', { class: 'card narrow' });
  const activation = ActivationForm(() => { toast('Token activado', 'ok'); onSaved(); refresh(); }, { submitLabel: MOBILE ? 'Cambiar link' : 'Cambiar token' });

  async function refresh() {
    const c = await window.friday.getConfig();
    const ping = await window.friday.api({ method: 'GET', path: '/ping', timeoutMs: 8000 });
    const off = confirmButton('Desactivar este equipo', async () => { await window.friday.deactivate(); location.reload(); }, { cls: 'ghost danger small' });
    status.replaceChildren(
      h('div', { class: 'card-title' }, icon('settings', 16), 'Conexión'),
      h('div', {}, h('span', { class: `chip ${ping.ok ? 'ok' : 'bad'}` }, ping.ok ? 'gateway responde' : 'sin conexión'), ' ',
        h('span', { class: 'muted small' }, ping.ok ? `${c.base} · ${ping.data.version || ''} · ${ping.ms} ms` : `${c.base} · ${ping.error || 'HTTP ' + ping.status}`)),
      c.nodeName ? h('div', { class: 'muted small' }, `Este equipo habla por el canal app:${c.nodeName}.`) : null,
      h('p', { class: 'muted small' }, MOBILE ? `Token guardado …${c.tokenTail} en el almacenamiento privado de la app.` : `Token guardado …${c.tokenTail}, cifrado con el almacén de Windows (DPAPI) para tu usuario.`),
      h('div', {}, off));
  }

  const el = h('section', { class: 'view' }, pageHead('Ajustes', 'Conexión con Friday Gateway.'), status,
    h('div', { class: 'card narrow' }, h('div', { class: 'card-title' }, MOBILE ? 'Cambiar de link' : 'Cambiar de token'),
      h('p', { class: 'muted small' }, MOBILE ? 'Pedile a Friday el link de la app por Telegram y pegalo acá.' : 'Pedile a Friday un token nuevo por Telegram y pegalo acá.'), activation.el),
    h('div', { class: 'card narrow about' },
      h('div', { class: 'card-title' }, 'Atajos'),
      h('div', { class: 'row' }, h('code', {}, 'Ctrl+1…9'), h('span', {}, 'cambiar de sección')),
      h('div', { class: 'row' }, h('code', {}, 'F5'), h('span', {}, 'actualizar la sección')),
      h('div', { class: 'row' }, h('code', {}, 'Ctrl+N'), h('span', {}, 'ir al chat'))));

  return {
    el,
    onShow: refresh,
  };
}

// Pantalla de bienvenida: la app no tiene token todavía.
function Onboarding(onActivated) {
  const form = ActivationForm(() => setTimeout(onActivated, 1200));
  const el = h('div', { class: 'onboarding' },
    h('div', { class: 'card setup-card' },
      h('div', { class: 'orb big' }),
      h('h2', {}, 'Hola, soy Friday'),
      h('p', { class: 'muted' }, MOBILE ? 'Para activar el celular, pedime el link de la app por Telegram y pegalo acá. Con eso queda todo andando.' : 'Para activar este equipo, pedime un token por Telegram y pegalo acá. Con eso queda todo andando.'),
      form.el));
  setTimeout(form.focus, 50);
  return el;
}

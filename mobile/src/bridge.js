// Puente del celular: implementa window.friday igual que preload.js + main.js en la app de escritorio,
// pero corriendo dentro del WebView. Las llamadas HTTP salen por CapacitorHttp (fetch nativo, sin CORS)
// y la configuración se guarda en Preferences (almacenamiento privado de la app).
(function () {
  const KEY = 'friday.cfg';
  const Prefs = () => window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences;
  let cfg = { base: '', token: '', nodeName: '' };
  let loaded = null;

  async function load() {
    try {
      const p = Prefs();
      const raw = p ? (await p.get({ key: KEY })).value : localStorage.getItem(KEY);
      if (raw) cfg = Object.assign(cfg, JSON.parse(raw));
    } catch (e) { /* config vacía */ }
  }
  async function save(patch) {
    cfg = Object.assign({}, cfg, patch);
    const raw = JSON.stringify(cfg);
    const p = Prefs();
    if (p) await p.set({ key: KEY, value: raw });
    else localStorage.setItem(KEY, raw);
  }
  const ready = () => loaded || (loaded = load());

  function publicCfg() {
    const on = !!(cfg.token && cfg.base);
    return {
      base: cfg.base, activated: on, hasToken: on, hasNode: on, tokenTail: (cfg.token || '').slice(-4),
      nodeName: cfg.nodeName, caps: { node: on, master: on },
    };
  }

  // Acepta el link que da Friday (ngrok con el token adentro) o un token suelto.
  // Formatos: ?token= / ?t= / ?key= / #token= / #<token> / https://<token>@host / último tramo del path.
  function parseLink(input, fallbackBase) {
    const s = String(input || '').trim();
    if (!/^(https?|wss?):\/\//i.test(s)) return { base: fallbackBase || '', token: s };
    const u = new URL(s.replace(/^ws/i, 'http'));
    const q = u.searchParams;
    let token = q.get('token') || q.get('t') || q.get('key') || q.get('access_token') || '';
    if (!token && u.hash.length > 1) {
      const frag = u.hash.slice(1);
      const hp = new URLSearchParams(frag);
      token = hp.get('token') || hp.get('t') || (frag.indexOf('=') < 0 ? decodeURIComponent(frag) : '');
    }
    if (!token && (u.username || u.password)) token = decodeURIComponent(u.password || u.username);
    if (!token) {
      const seg = u.pathname.split('/').filter(Boolean);
      if (seg.length && seg[seg.length - 1].length >= 20) token = seg[seg.length - 1];
    }
    return { base: u.origin, token };
  }

  async function api(req) {
    await ready();
    if (!cfg.base) return { ok: false, status: 0, error: 'sin activar', ms: 0, url: req.path };
    const method = req.method || 'GET';
    const url = new URL(req.path, cfg.base + '/');
    const query = req.query || {};
    Object.keys(query).forEach((k) => {
      const v = query[k];
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    });
    // ngrok gratis muestra una página de aviso a los navegadores si falta este header.
    const headers = { Accept: 'application/json', 'ngrok-skip-browser-warning': '1' };
    if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token;
    if (req.body !== undefined) headers['Content-Type'] = 'application/json';
    const t0 = Date.now();
    const timeoutMs = req.timeoutMs || 90000;
    let timer;
    try {
      const r = await Promise.race([
        fetch(url.toString(), { method, headers, body: req.body !== undefined ? JSON.stringify(req.body) : undefined }),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('sin respuesta (timeout)')), timeoutMs); }),
      ]);
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch (e) { data = text; }
      return { ok: r.ok, status: r.status, data, ms: Date.now() - t0, url: url.toString() };
    } catch (err) {
      return { ok: false, status: 0, error: String((err && err.message) || err), ms: Date.now() - t0, url: url.toString() };
    } finally {
      clearTimeout(timer);
    }
  }

  async function activate(input, base) {
    await ready();
    const parsed = parseLink(input, base || cfg.base);
    if (!parsed.base) return { ok: false, error: 'Pegá el link completo que te dio Friday (empieza con https://).' };
    if (!parsed.token) return { ok: false, error: 'Ese link no trae el token. Pedile a Friday el link de la app de nuevo.' };
    const prev = cfg;
    cfg = Object.assign({}, cfg, { base: parsed.base.replace(/\/+$/, ''), token: parsed.token, nodeName: '' });
    const fail = (error) => { cfg = prev; return { ok: false, error }; };
    const ping = await api({ path: '/ping', timeoutMs: 15000 });
    if (!ping.ok) return fail('No llego a Friday en ' + cfg.base + ' (' + (ping.error || 'HTTP ' + ping.status) + '). ¿El túnel de ngrok está activo?');
    const chat = await api({ path: '/chat/messages', query: { limit: 1 }, timeoutMs: 20000 });
    if (!chat.ok) return fail('Friday no reconoce ese token como token de la app. Pedile uno nuevo por Telegram.');
    const hist = await api({ path: '/chat/history', query: { limit: 1 }, timeoutMs: 20000 });
    const nodeName = (hist.ok && hist.data && hist.data.node) || '';
    await save({ base: cfg.base, token: cfg.token, nodeName });
    return { ok: true, caps: publicCfg().caps, nodeName };
  }

  window.friday = {
    platform: 'mobile',
    api,
    getConfig: async () => { await ready(); return publicCfg(); },
    activate,
    deactivate: async () => { await save({ token: '', nodeName: '' }); return publicCfg(); },
    liveUrl: async () => {
      await ready();
      if (!cfg.token) return null;
      const u = new URL('/live', cfg.base + '/');
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      u.searchParams.set('token', cfg.token);
      return u.toString();
    },
  };

  // Botón "atrás" de Android: cierra el menú, vuelve al chat o sale.
  document.addEventListener('DOMContentLoaded', () => {
    const App = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (!App) return;
    App.addListener('backButton', () => {
      if (document.body.classList.contains('nav-open')) { document.body.classList.remove('nav-open'); return; }
      if (window.fridayBack && window.fridayBack()) return;
      App.exitApp();
    });
  });
})();

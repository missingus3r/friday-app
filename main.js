// Proceso principal: ventana, configuración (token cifrado con safeStorage)
// y todas las llamadas HTTP al gateway, así el renderer no choca con CORS.
// La app funciona con un único token: el "token de app" que Friday entrega por Telegram.
const { app, BrowserWindow, ipcMain, safeStorage, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');

const DEFAULT_BASE = 'http://friday.local:8800';
const cfgPath = () => path.join(app.getPath('userData'), 'config.json');

let cfg = { base: DEFAULT_BASE, token: '', nodeName: '' };

const enc = (s) => (safeStorage.isEncryptionAvailable() ? { enc: safeStorage.encryptString(s).toString('base64') } : { plain: s });
const dec = (v) => (!v ? '' : v.enc ? safeStorage.decryptString(Buffer.from(v.enc, 'base64')) : v.plain || '');

function loadCfg() {
  try {
    const raw = JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));
    cfg = { base: raw.base || DEFAULT_BASE, token: dec(raw.appToken), nodeName: raw.nodeName || '' };
  } catch {
    cfg = { base: DEFAULT_BASE, token: '', nodeName: '' };
  }
}

function saveCfg(patch) {
  cfg = { ...cfg, ...patch };
  cfg.base = (cfg.base || DEFAULT_BASE).replace(/\/+$/, '');
  const out = { base: cfg.base, appToken: enc(cfg.token), nodeName: cfg.nodeName };
  fs.mkdirSync(path.dirname(cfgPath()), { recursive: true });
  fs.writeFileSync(cfgPath(), JSON.stringify(out, null, 2));
}

function publicCfg() {
  const on = !!cfg.token;
  return {
    base: cfg.base, activated: on, hasToken: on, hasNode: on, tokenTail: cfg.token.slice(-4), nodeName: cfg.nodeName,
    caps: { node: on, master: on },
  };
}

// Valida el token de app contra el gateway. El canal del nodo (app:<nombre>) solo acepta tokens de app,
// así que el token maestro no sirve para activar.
async function activate(token, base) {
  const prev = cfg;
  cfg = { ...cfg, base: (base || cfg.base || DEFAULT_BASE).replace(/\/+$/, ''), token, nodeName: '' };
  const fail = (error) => { cfg = prev; return { ok: false, error }; };
  const ping = await callApi({ path: '/ping', timeoutMs: 8000 });
  if (!ping.ok) return fail(`No llego al gateway en ${cfg.base} (${ping.error || 'HTTP ' + ping.status}).`);
  const chat = await callApi({ path: '/chat/messages', query: { limit: 50 }, timeoutMs: 15000 });
  if (!chat.ok) return fail('Friday no reconoce ese token como token de la app. Pedile uno por Telegram ("token para la app").');
  // El nombre del nodo viene en /chat/history ({ node, next_since, messages }).
  const hist = await callApi({ path: '/chat/history', query: { limit: 1 }, timeoutMs: 15000 });
  const nodeName = (hist.ok && hist.data && hist.data.node) || '';
  saveCfg({ token, nodeName });
  return { ok: true, caps: publicCfg().caps, nodeName };
}

async function callApi({ method = 'GET', path: p, query, body, timeoutMs = 90000 }) {
  const url = new URL(p, cfg.base + '/');
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const headers = { Accept: 'application/json' };
  if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { ok: r.ok, status: r.status, data, ms: Date.now() - t0, url: url.toString() };
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'sin respuesta (timeout)' : (err.cause && err.cause.code) || err.message;
    return { ok: false, status: 0, error: String(reason), ms: Date.now() - t0, url: url.toString() };
  } finally {
    clearTimeout(timer);
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Friday',
    backgroundColor: '#07090c',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  // Los links del contenido (memorias, respuestas) se abren en el navegador, nunca dentro de la app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// FRIDAY_PROFILE permite correr otra instancia con su propia configuración (otro token de app).
if (process.env.FRIDAY_PROFILE) app.setPath('userData', path.join(app.getPath('appData'), `Friday-${process.env.FRIDAY_PROFILE}`));

app.whenReady().then(() => {
  loadCfg();
  ipcMain.handle('cfg:get', () => publicCfg());
  ipcMain.handle('activate', (_e, { token, base }) => activate(String(token || '').trim(), base));
  ipcMain.handle('deactivate', () => { saveCfg({ token: '', nodeName: '' }); return publicCfg(); });
  // URL del WebSocket del modo voz. El gateway autentica el nodo por query string.
  ipcMain.handle('live:url', () => {
    if (!cfg.token) return null;
    const u = new URL('/live', cfg.base + '/');
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('token', cfg.token);
    return u.toString();
  });
  // Solo micrófono (modo voz), notificaciones y portapapeles.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'notifications', 'clipboard-sanitized-write'].includes(perm)));
  ipcMain.handle('api', (_e, req) => callApi(req));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Modo en vivo por voz: micrófono → PCM16 mono 24 kHz → WebSocket /live del gateway (puente con OpenAI Realtime).
// El servidor devuelve { type: 'audio' | 'interrupt' | 'transcript' | 'tool' | 'error' }.

const RATE = 24000;

function b64FromInt16(i16) {
  const u8 = new Uint8Array(i16.buffer);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function int16FromB64(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return new Int16Array(u8.buffer);
}

function VoiceView() {
  let ws = null, ctx = null, stream = null, src = null, proc = null, outGain = null, analyser = null;
  let playAt = 0, sources = [], muted = false, raf = 0, micLevel = 0, startedAt = 0, clock = 0;
  let info = null;

  const orb = h('div', { class: 'voice-orb' }, h('div', { class: 'voice-ring' }), h('div', { class: 'voice-core' }));
  const state = h('div', { class: 'voice-state' }, 'Tocá para hablar con Friday');
  const talk = h('button', { class: 'btn primary voice-btn' }, icon('mic', 20), h('span', {}, 'Hablar'));
  const muteB = h('button', { class: 'btn ghost', disabled: true, title: 'Silenciar el micrófono' }, icon('micOff', 17), h('span', {}, 'Silenciar'));
  const micSel = h('select', { class: 'mini', title: 'Micrófono' }, h('option', { value: '' }, 'Micrófono predeterminado'));
  const timer = h('span', { class: 'muted small' });
  const log = h('div', { class: 'voice-log' });
  const side = h('div', { class: 'voice-side' });
  const needNode = h('div', { class: 'empty' }, 'El token activo no habilita la voz. Pedile a Friday un token nuevo por Telegram y cambialo en Ajustes.');

  const el = h('section', { class: 'view' },
    pageHead('Voz', 'Hablá con Friday en tiempo real. Tiene sus herramientas (memoria, tareas, agentes…) y puede pedirle cosas a la sesión principal.'),
    needNode,
    h('div', { class: 'voice' },
      h('div', { class: 'voice-stage' }, orb, state, h('div', { class: 'voice-ctrls' }, talk, muteB), h('div', { class: 'voice-ctrls' }, micSel, timer)),
      h('div', { class: 'voice-right' }, h('h3', { class: 'section-title' }, 'Transcripción'), log, side)));

  try { micSel.dataset.want = localStorage.getItem('micId') || ''; } catch { /* opcional */ }
  micSel.addEventListener('change', () => { try { localStorage.setItem('micId', micSel.value); } catch { /* opcional */ } });

  function line(cls, text) {
    const last = log.lastElementChild;
    // Las transcripciones llegan por turno; si el mismo rol sigue hablando, se agrega al mismo globo.
    if (cls !== 'sys' && last && last.dataset.role === cls && Date.now() - +last.dataset.t < 1500) {
      last.querySelector('.t').textContent += ' ' + text;
      last.dataset.t = Date.now();
    } else {
      log.append(h('div', { class: `vl ${cls}`, 'data-role': cls, 'data-t': Date.now() },
        cls === 'sys' ? null : h('b', {}, cls === 'user' ? 'Vos' : 'Friday'), h('span', { class: 't' }, text)));
    }
    log.scrollTop = log.scrollHeight;
  }

  function setState(text, kind) {
    state.textContent = text;
    orb.dataset.kind = kind || '';
  }

  function play(b64) {
    const i16 = int16FromB64(b64);
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    const buf = ctx.createBuffer(1, f32.length, RATE);
    buf.copyToChannel(f32, 0);
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(outGain);
    playAt = Math.max(playAt, ctx.currentTime);
    s.start(playAt);
    playAt += buf.duration;
    sources.push(s);
    s.onended = () => { sources = sources.filter((x) => x !== s); };
  }
  function stopPlayback() {
    sources.forEach((s) => { try { s.stop(); } catch { /* ya terminó */ } });
    sources = [];
    playAt = 0;
  }

  // Anima el orbe con el nivel del micrófono o de la voz de Friday.
  function animate() {
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += ((v - 128) / 128) ** 2;
    const out = Math.sqrt(sum / data.length);
    const speaking = sources.length > 0;
    const lvl = speaking ? out * 4 : micLevel * 6;
    orb.style.setProperty('--lvl', Math.min(1, lvl).toFixed(3));
    if (ws && ws.readyState === 1) {
      if (speaking) setState('Friday está hablando…', 'speak');
      else if (state.dataset.busy) { /* mantiene el texto de la tool */ }
      else setState(muted ? 'Micrófono silenciado' : 'Te escucho…', muted ? 'mute' : 'listen');
      const s = Math.floor((Date.now() - startedAt) / 1000);
      timer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }
    raf = requestAnimationFrame(animate);
  }

  async function listMics() {
    try {
      const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
      const want = micSel.value || micSel.dataset.want;
      micSel.replaceChildren(h('option', { value: '' }, 'Micrófono predeterminado'),
        ...devs.map((d, i) => h('option', { value: d.deviceId }, d.label || `Micrófono ${i + 1}`)));
      if (devs.some((d) => d.deviceId === want)) micSel.value = want;
    } catch { /* sin permiso todavía */ }
  }

  async function start() {
    const url = await window.friday.liveUrl();
    if (!url) { toast('Este equipo no está registrado como nodo', 'err'); return; }
    talk.disabled = true;
    setState('Conectando…', 'connect');
    try {
      ctx = new AudioContext({ sampleRate: RATE });
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(micSel.value ? { deviceId: { exact: micSel.value } } : {}) },
      });
    } catch (e) {
      toast(`No pude abrir el micrófono: ${e.message}`, 'err', 6000);
      teardown();
      return;
    }
    listMics();
    outGain = ctx.createGain();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    outGain.connect(analyser);
    analyser.connect(ctx.destination);

    ws = new WebSocket(url);
    ws.onopen = () => {
      startedAt = Date.now();
      line('sys', 'Conectada. Hablá cuando quieras.');
      talk.disabled = false;
      talk.querySelector('span').textContent = 'Cortar';
      talk.classList.add('on');
      muteB.disabled = false;
    };
    ws.onclose = (e) => {
      const why = e.code === 1008 || e.code === 4401 ? ' (token de nodo rechazado)' : e.code === 1000 ? '' : ` (código ${e.code}${e.reason ? ': ' + e.reason : ''})`;
      line('sys', `Desconectada${why}.`);
      teardown();
    };
    ws.onerror = () => setState('Error de conexión', 'bad');
    ws.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'audio') play(m.data);
      else if (m.type === 'interrupt') stopPlayback();
      else if (m.type === 'transcript') line(m.role === 'user' ? 'user' : 'assistant', m.text);
      else if (m.type === 'tool') {
        if (m.status === 'start') { state.dataset.busy = '1'; setState(`Usando ${m.name}…`, 'tool'); line('sys', `⚙ usando ${m.name}`); }
        else { delete state.dataset.busy; line('sys', `✓ ${m.name}`); }
      } else if (m.type === 'error') line('sys', `Error: ${typeof m.error === 'string' ? m.error : JSON.stringify(m.error)}`);
    };

    src = ctx.createMediaStreamSource(stream);
    proc = ctx.createScriptProcessor(2048, 1, 1);
    proc.onaudioprocess = (ev) => {
      const f = ev.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
      micLevel = muted ? 0 : Math.sqrt(sum / f.length);
      if (!ws || ws.readyState !== 1 || muted) return;
      const i16 = new Int16Array(f.length);
      for (let i = 0; i < f.length; i++) i16[i] = Math.max(-1, Math.min(1, f[i])) * 0x7fff;
      ws.send(JSON.stringify({ type: 'audio', data: b64FromInt16(i16) }));
    };
    // El procesador va a una ganancia en 0 para que corra sin devolver el micrófono a los parlantes.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    src.connect(proc);
    proc.connect(sink);
    sink.connect(ctx.destination);
    cancelAnimationFrame(raf);
    animate();
  }

  function teardown() {
    try { proc && proc.disconnect(); src && src.disconnect(); } catch { /* ya desconectado */ }
    try { stream && stream.getTracks().forEach((t) => t.stop()); } catch { /* idem */ }
    try { ws && ws.readyState <= 1 && ws.close(1000); } catch { /* idem */ }
    stopPlayback();
    try { ctx && ctx.close(); } catch { /* idem */ }
    ws = ctx = stream = src = proc = null;
    cancelAnimationFrame(raf);
    muted = false;
    muteB.disabled = true;
    muteB.querySelector('span').textContent = 'Silenciar';
    talk.disabled = false;
    talk.querySelector('span').textContent = 'Hablar';
    talk.classList.remove('on');
    orb.style.setProperty('--lvl', 0);
    delete state.dataset.busy;
    setState('Tocá para hablar con Friday', '');
  }

  talk.addEventListener('click', () => (ws ? teardown() : start()));
  muteB.addEventListener('click', () => {
    muted = !muted;
    muteB.querySelector('span').textContent = muted ? 'Activar micrófono' : 'Silenciar';
    muteB.classList.toggle('armed', muted);
  });

  async function loadInfo() {
    info = await api('GET', '/live/tools', { quiet: true });
    side.replaceChildren();
    if (!info) return;
    const p = info.precio_usd_por_millon || {};
    side.append(
      h('h3', { class: 'section-title' }, 'Motor'),
      h('div', { class: 'muted small' }, `${info.model || '?'} · voz ${info.voice || '?'}`),
      p.audio_in !== undefined ? h('div', { class: 'muted small', title: p.fuente || '' },
        `US$ por millón de tokens: audio entrada ${p.audio_in} · salida ${p.audio_out}${p.audio_in_cache !== undefined ? ` · entrada en caché ${p.audio_in_cache}` : ''}`) : null,
      h('h3', { class: 'section-title' }, `Herramientas (${(info.tools || []).length})`),
      h('div', { class: 'tool-chips' }, (info.tools || []).map((t) => h('span', { class: 'chip' }, t.replace(/_/g, ' ')))));
  }

  return {
    el,
    async onShow() {
      const c = await window.friday.getConfig();
      needNode.hidden = c.hasNode;
      el.querySelector('.voice').hidden = !c.hasNode;
      if (!info) loadInfo();
      listMics();
    },
  };
}

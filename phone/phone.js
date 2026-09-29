// Dreamspace phone companion: talk to the world's guide from an iPhone (AirPods, hands-free).
// Owner: phone builder. Contract: docs/CONTRACT.md (the phone/ row, "Client modules", "HTTP API", "SSE events").
//
//   ../src/net/client.js   connect({...}) → { send, vibe, setBrain, health, world, setToken, ... }
//   ../src/voice/index.js  createVoice({ onFinal, onInterim, onState }) → { start, stop, speak, supported, mode }
//                          (+ setHandsFree, stopSpeaking, unlock, onError, onLevel: used when present)
//
// Both modules load with import() when the page loads (not on a tap, so start() still runs inside the tap on iOS).
// If one of them fails to load, the page degrades instead of going blank: text chat keeps working through a small
// built-in connection (logged loudly, with a "backup link" chip), and replies are still spoken through speechSynthesis.
//
// iOS Safari 15+ syntax only: no top-level await, no regex lookbehind, no Array#at, no structuredClone, no ??= / ||=.

const TOKEN_KEY = 'dreamspace.token'; // shared with client.js
const PREFS_KEY = 'dreamspace.phone.prefs';
const LOG_KEY = 'dreamspace.phone.log';
const LOG_KEEP = 60;
const FROM = 'phone';

const BRAIN_SHORT = { auto: 'Auto', claude: 'Claude', ollama: 'Local', scripted: 'Scripted' };
const BRAIN_LONG = { claude: 'Claude', ollama: 'Local model', scripted: 'Scripted' };
const BRAIN_PHRASE = { claude: 'Claude', ollama: 'the local model', scripted: 'simple scripts' };
const MOODS = { twilight: 'twilight', aurora: 'aurora', starfall: 'starfall', deepsea: 'deep sea', dawn: 'dawn' };
const FROM_LABEL = { xr: 'From the headset', desktop: 'From the Mac', 'claude.ai': 'From the Claude app' };

const CHAT_WAIT_MS = 75000;   // the claude brain times out at 60 s; after this, hands-free listens again anyway
const VIBE_WAIT_MS = 20000;   // vibe builds take minutes: keep listening meanwhile, speak the result when it lands
const DEAF_AFTER_MS = 9000;   // no snapshot by then: say so (quick tunnels can block the live stream)

const $ = (id) => document.getElementById(id);
const ui = {
  app: $('app'), status: $('status'), statusText: $('status-text'),
  brainPill: $('brain-pill'), brainName: $('brain-name'), brain: $('brain'),
  worldToggle: $('world-toggle'), world: $('world'), worldFrame: $('world-frame'),
  menuBtn: $('menu-btn'), log: $('log'), empty: $('empty'),
  transcript: $('transcript'), orb: $('orb'), hint: $('hint'), handsfree: $('handsfree'), vibe: $('vibe'),
  compose: $('compose'), text: $('text'), send: $('send'),
  pair: $('pair'), pairForm: $('pair-form'), pairInput: $('pair-input'), pairMsg: $('pair-msg'),
  sheet: $('sheet'), optSpeak: $('opt-speak'), voiceInfo: $('voice-info'), installRow: $('install-row'),
  copyLink: $('copy-link'), clearLog: $('clear-log'), forget: $('forget'), toast: $('toast'),
};

// ---------------------------------------------------------------------------------------------------------------
// Small helpers

function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function lsSet(key, val) { try { localStorage.setItem(key, val); return true; } catch (e) { return false; } }
function lsDel(key) { try { localStorage.removeItem(key); } catch (e) { /* storage blocked */ } }
function lsJSON(key, fallback) { try { const v = JSON.parse(lsGet(key) || 'null'); return v == null ? fallback : v; } catch (e) { return fallback; } }

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const words = (name) => String(name || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const article = (w) => (/^[aeiou]/i.test(w) ? 'An ' : 'A ') + w;
const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const isStandalone = () => navigator.standalone === true || !!(window.matchMedia && matchMedia('(display-mode: standalone)').matches);
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function withTimeout(p, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    Promise.resolve(p).then(() => { clearTimeout(t); resolve(); }, () => { clearTimeout(t); resolve(); });
  });
}

// JSON request that resolves (never rejects) to {ok, status, ...body, error?}. Used for the token check and by the
// fallback connection; everything else goes through client.js.
function api(method, path, body, auth) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => { if (ctl) ctl.abort(); }, 15000);
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (auth !== false && token) headers['x-world-token'] = token;
  return fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store', signal: ctl ? ctl.signal : undefined })
    .then((r) => r.json().catch(() => null).then((data) => {
      const out = Object.assign({}, data && typeof data === 'object' && !Array.isArray(data) ? data : {}, { ok: r.ok, status: r.status });
      if (!r.ok) out.error = (data && data.error) || ('HTTP ' + r.status);
      return out;
    }))
    .catch((err) => ({ ok: false, status: 0, error: ctl && ctl.signal.aborted ? 'timeout' : (err && err.message) || 'network error' }))
    .then((r) => { clearTimeout(timer); return r; });
}

// ---------------------------------------------------------------------------------------------------------------
// State

const prefs = Object.assign({ speak: true, world: false }, lsJSON(PREFS_KEY, {}));
const savePrefs = () => lsSet(PREFS_KEY, JSON.stringify({ speak: prefs.speak, world: prefs.world }));

let token = null;
let net = null;       // the loaded client.js module (or null)
let client = null;    // connect() result
let voice = null;     // createVoice() result

const S = {
  conn: 'connecting', everOpen: false, fallback: false, healthFails: 0,
  world: null, health: null, serverBrain: null,
  mic: 'off',            // off | listening | hearing | transcribing | paused  (what the recogniser is doing)
  needsGesture: false,   // iOS stopped the mic (page hidden, audio interruption): a tap brings it back
  phase: 'idle',         // idle | waiting | speaking        (where the conversation is)
  thinking: false, thinkingDetail: '', thinkingVibe: false,
  handsFree: false, armed: false, vibe: false,
  canListen: false, voiceLoaded: false, unlocked: false,
  pending: [],           // my sent messages awaiting their echo: {text, id, line, t, vibe}
  awaiting: null,        // the request id whose reply ends the 'waiting' phase
  seen: new Set(),
  lastGuideBrain: null,
  speakQueue: 0, speakGen: 0,
  pinned: true,
  worldOpen: false,
  wakeLock: null,
  timers: {},
};
const logData = [];     // persisted conversation (last LOG_KEEP lines)

function later(name, fn, ms) { clearTimeout(S.timers[name]); S.timers[name] = setTimeout(fn, ms); }
function cancel(name) { clearTimeout(S.timers[name]); }

// ---------------------------------------------------------------------------------------------------------------
// Boot

boot();

function boot() {
  ui.log.classList.add('is-empty');
  bindUI();
  fitViewport();
  restoreLog();
  ui.optSpeak.checked = prefs.speak;
  renderBrain();
  renderStatus();
  updateOrb();

  const netP = import('../src/net/client.js').catch((err) => { console.warn('[phone] src/net/client.js failed to load:', err); return null; });
  const voiceP = import('../src/voice/index.js').catch((err) => { console.warn('[phone] src/voice/index.js failed to load:', err); return null; });

  netP.then((mod) => {
    net = mod && typeof mod.connect === 'function' ? mod : null;
    token = net && typeof net.captureToken === 'function' ? net.captureToken() : captureTokenLocally();
    refreshHealth();
    setInterval(refreshHealth, 20000);
    if (!token) { showPair(); return; }
    api('GET', '/api/world').then((r) => {
      if (r.status === 401) { showPair('That phone link has expired. Paste the new one from your Mac.'); return; }
      if (r.ok && r.version !== undefined) { S.world = r; renderStatus(); }
      startClient();
    });
  });
  voiceP.then(setupVoice);
}

// Without client.js: read ?t= / #t=, keep it, and take it out of the address bar.
function captureTokenLocally() {
  let t = null;
  try {
    const q = new URLSearchParams(location.search);
    const h = new URLSearchParams((location.hash || '').replace(/^#/, ''));
    t = q.get('t') || h.get('t');
    if (t) {
      const saved = lsSet(TOKEN_KEY, t);
      q.delete('t'); h.delete('t');
      const qs = q.toString(), hs = h.toString();
      if (saved) history.replaceState(history.state, '', location.pathname + (qs ? '?' + qs : '') + (hs ? '#' + hs : ''));
    }
  } catch (e) { /* old browser: fall through to storage */ }
  return t || lsGet(TOKEN_KEY);
}

function startClient() {
  if (client) return;
  const handlers = {
    onSnapshot, onOp, onChat, onStatus, onCreation,
    onError: onClientError,
    onConnection,
    from: FROM,
  };
  if (net) {
    try { client = net.connect(handlers); } catch (err) { console.warn('[phone] client.js connect() threw; using the backup connection', err); }
  }
  if (!client) {
    console.warn('[phone] Using the phone\'s minimal backup connection instead of src/net/client.js. Text chat works; check client.js.');
    S.fallback = true;
    client = fallbackConnect(handlers);
  }
  later('deaf', () => { if (!S.everOpen && S.conn !== 'down' && S.conn !== 'unauthorized') setConn('deaf'); }, DEAF_AFTER_MS);
  if (prefs.world) setWorldOpen(true);
}

// ---------------------------------------------------------------------------------------------------------------
// Connection + world

function onConnection(state) {
  if (state === 'open') { S.everOpen = true; cancel('deaf'); setConn('live'); }
  else if (state === 'unauthorized') { setConn('unauthorized'); showPair('This phone isn’t connected to your world. Paste the phone link from your Mac.'); }
  else if (state === 'reconnecting' || state === 'connecting') { if (S.conn !== 'down' && S.conn !== 'deaf') setConn('connecting'); }
}

function onSnapshot(world) {
  if (!world || typeof world !== 'object') return;
  S.world = world;
  S.everOpen = true;
  cancel('deaf');
  if (S.conn !== 'live') setConn('live'); else renderStatus();
}

function onOp(evt) {
  const op = evt && (evt.op || evt);
  if (!op || !op.type) return;
  const text = describeOp(op, S.world);
  const now = Date.now();
  if (text && !(S.lastWorldLine && S.lastWorldLine.text === text && now - S.lastWorldLine.t < 4000)) {
    S.lastWorldLine = { text, t: now };
    addLine({ k: 'world', text });
  }
  // client.js keeps its own world current; read it back for the header summary.
  later('world-refresh', () => {
    const w = client && typeof client.world === 'function' ? client.world() : null;
    if (w) S.world = w;
    else if (S.world && op.type === 'mood') S.world.mood = Object.assign({}, S.world.mood, op);
    renderStatus();
  }, 250);
}

function describeOp(op, world) {
  const find = (id) => (world && world.objects ? world.objects.filter((o) => o.id === id)[0] : null);
  const nameOf = (id) => { const o = find(id); return o ? 'The ' + words(o.name) : 'Something'; };
  switch (op.type) {
    case 'add': return op.name ? article(words(op.name)) + ' appeared' : 'Something new appeared';
    case 'remove': return nameOf(op.id) + ' faded away';
    case 'move': return nameOf(op.id) + ' moved';
    case 'clear': return 'The world was cleared';
    case 'mood': return op.preset ? 'The sky turned to ' + (MOODS[op.preset] || words(op.preset)) : 'The light shifted';
    default: return '';
  }
}

function onCreation(evt) {
  if (!evt || !evt.slug) return;
  addLine({ k: 'world', creation: true, text: evt.action === 'remove' ? cap(words(evt.slug)) + ' was taken away' : cap(words(evt.slug)) + ' is in the world' });
}

function onClientError(e) {
  const msg = e && (e.message || e.error);
  if (!msg) return;
  if (e.source === 'auth') return;                            // onConnection('unauthorized') shows the pairing screen
  if (e.source === 'network') { toast(msg); return; }        // connection trouble: the status line carries it
  if (/^(Sending|Vibe request|Switching brain) failed/.test(msg)) return; // shown on the message / as a toast
  addLine({ k: 'error', text: msg.replace(/^vibe: /, 'Vibe: ') });
  if (S.phase === 'waiting') replyArrived();
}

function setConn(c) { S.conn = c; if (c === 'live') S.deafNoted = false; ui.status.setAttribute('data-conn', c); renderStatus(); }

function renderStatus() {
  let t;
  switch (S.conn) {
    case 'live': t = worldSummary(); break;
    case 'deaf': t = 'Replies aren’t arriving'; break;
    case 'down': t = 'Can’t reach your Mac'; break;
    case 'unauthorized': t = 'Not connected'; break;
    default: t = S.everOpen ? 'Reconnecting' : 'Finding your world';
  }
  ui.statusText.textContent = t;
  let chip = ui.status.querySelector('.backup');
  if (S.fallback && !chip) {
    chip = document.createElement('span');
    chip.className = 'backup';
    chip.textContent = 'backup link';
    ui.status.appendChild(chip);
  }
}

function worldSummary() {
  const w = S.world;
  if (!w) return 'Connected';
  const n = Array.isArray(w.objects) ? w.objects.length : 0;
  const preset = w.mood && w.mood.preset;
  const sky = preset ? cap(MOODS[preset] || words(preset)) + ' sky' : 'Connected';
  return sky + ', ' + (n === 0 ? 'still empty' : n === 1 ? '1 thing' : n + ' things');
}

function refreshHealth() {
  const p = client && typeof client.health === 'function' ? client.health() : api('GET', '/api/health', null, false);
  Promise.resolve(p).then((h) => {
    if (!h || h.ok === false) { healthFailed(); return; }
    S.healthFails = 0;
    S.health = h;
    if (typeof h.brain === 'string') S.serverBrain = h.brain;
    if (S.conn === 'down') setConn(S.everOpen ? 'live' : 'connecting');
    renderBrain();
    renderVoiceInfo();
    renderVibe();
  }, healthFailed);
}
function healthFailed() {
  S.healthFails++;
  if (S.healthFails >= 2) setConn('down');
}

// ---------------------------------------------------------------------------------------------------------------
// Chat

function onChat(m) {
  if (!m || typeof m.text !== 'string' || !m.text.trim()) return;
  const key = (m.role === 'user' ? 'u:' : 'g:') + (m.id || norm(m.text));
  if (S.seen.has(key)) return;
  if (S.seen.size > 400) S.seen.clear();
  S.seen.add(key);

  if (m.role === 'user') {
    if (reconcile(m)) return;
    addLine({ k: 'user', text: m.text, from: m.from, vibe: m.mode === 'vibe' });
    return;
  }

  // The guide. Is this the reply to what I just said? (chat replies carry replyTo; vibe replies reuse the id)
  const mine = S.awaiting && (m.replyTo === S.awaiting || (m.mode === 'vibe' && m.id === S.awaiting));
  const line = addLine({ k: 'guide', text: m.text, brain: m.brain, vibe: m.mode === 'vibe' });
  if (prefs.speak) speakReply(m.text, line);
  if (mine) replyArrived();
}

function reconcile(m) {
  const now = Date.now();
  for (let i = 0; i < S.pending.length; i++) {
    const p = S.pending[i];
    const byId = m.id && p.id && m.id === p.id;
    const byText = (!m.from || m.from === FROM) && now - p.t < 60000 && norm(p.text) === norm(m.text);
    if (byId || byText) {
      S.pending.splice(i, 1);
      p.line.classList.remove('pending');
      if (!p.id && m.id) { p.id = m.id; if (S.awaiting === p) S.awaiting = m.id; }
      return true;
    }
  }
  return false;
}

function submit(raw) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 1500);
  if (!text) return;
  if (!client) { toast('Not connected to your world yet.'); return; }
  const p = { text, id: null, line: null, t: Date.now(), vibe: S.vibe };
  p.line = addLine({ k: 'user', text, vibe: p.vibe, pending: true });
  S.pending.push(p);
  S.awaiting = p;  // placeholder until the server gives the id
  setPhase('waiting');
  later('wait', replyArrived, p.vibe ? VIBE_WAIT_MS : CHAT_WAIT_MS);
  deliver(p);
}

function deliver(p) {
  p.line.classList.remove('failed');
  p.line.classList.add('pending');
  const old = p.line.querySelector('.retry');
  if (old) old.remove();
  let req;
  try {
    if (p.vibe) req = typeof client.vibe === 'function' ? client.vibe(p.text) : api('POST', '/api/vibe', { text: p.text, from: FROM });
    else req = client.send(p.text);
  } catch (err) { req = Promise.resolve({ ok: false, error: err && err.message }); }
  Promise.resolve(req).then((r) => {
    if (r && r.ok !== false) {
      if (r.id) { p.id = r.id; if (S.awaiting === p) S.awaiting = r.id; }
      if (S.conn === 'deaf' || S.conn === 'down') {
        // It arrived, but the live stream that carries replies is blocked: don't pretend to wait for one.
        p.line.classList.remove('pending');
        if (!S.deafNoted) { S.deafNoted = true; addLine({ k: 'error', text: 'Sent. Replies can’t reach this phone right now, but the world still changes.' }); }
        if (S.awaiting === p || (r.id && S.awaiting === r.id)) replyArrived();
        return;
      }
      // The server echoes the message over SSE; if the stream is down that never comes, so settle it here too.
      later('settle-' + p.t, () => p.line.classList.remove('pending'), 1500);
      return;
    }
    failed(p, r);
  }, (err) => failed(p, { error: err && err.message }));
}

function failed(p, r) {
  const i = S.pending.indexOf(p);
  if (i >= 0) S.pending.splice(i, 1);
  p.line.classList.remove('pending');
  p.line.classList.add('failed');
  let why = (r && r.error) || 'network error';
  if (r && r.status === 503 && p.vibe) why = 'Vibe mode isn’t running on your Mac';
  else if (r && r.status === 429) why = p.vibe ? 'Claude is still building the last thing' : 'The guide is busy';
  else if (r && r.status === 0) why = 'Couldn’t reach your Mac';
  const retry = document.createElement('span');
  retry.className = 'retry';
  retry.textContent = why + '. Tap to try again.';
  p.line.appendChild(retry);
  p.line.onclick = () => { p.line.onclick = null; p.t = Date.now(); S.pending.push(p); S.awaiting = p; setPhase('waiting'); later('wait', replyArrived, CHAT_WAIT_MS); deliver(p); };
  if (S.awaiting === p) replyArrived();
}

// The turn is over (reply arrived, failed, or timed out): hands-free listens again once the speech has finished.
function replyArrived() {
  cancel('wait');
  S.awaiting = null;
  if (S.phase === 'waiting') setPhase('idle');
  resumeHandsFree();
}

function onStatus(st) {
  if (!st) return;
  if (!st.thinking && st.detail === 'brain changed' && st.brain) { S.serverBrain = st.brain; renderBrain(); }
  S.thinking = !!st.thinking;
  S.thinkingVibe = st.mode === 'vibe';
  S.thinkingDetail = thinkingText(st);
  renderThinking();
  updateOrb();
}

function thinkingText(st) {
  const d = String(st.detail || '').replace(/^vibe:\s*/, '');
  if (!d || d === 'thinking') return (BRAIN_LONG[st.brain] || 'The guide') + ' is thinking';
  return cap(d);
}

// ---------------------------------------------------------------------------------------------------------------
// The conversation log

function addLine(entry, restoring) {
  const el = document.createElement('div');
  el.className = 'line ' + (entry.k === 'world' ? 'note' : entry.k) + (entry.vibe ? ' vibe' : '') + (entry.creation ? ' creation' : '') + (restoring ? ' earlier' : '');
  if (entry.k === 'user' && entry.from && entry.from !== FROM && FROM_LABEL[entry.from]) {
    const from = document.createElement('span');
    from.className = 'from';
    from.textContent = FROM_LABEL[entry.from];
    el.appendChild(from);
  }
  el.appendChild(document.createTextNode(entry.text));
  if (entry.k === 'user' && entry.pending) el.classList.add('pending');
  if (entry.k === 'guide') {
    if (entry.brain && entry.brain !== S.lastGuideBrain && BRAIN_LONG[entry.brain]) {
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = BRAIN_LONG[entry.brain];
      el.appendChild(meta);
    }
    if (entry.brain) S.lastGuideBrain = entry.brain;
    el.addEventListener('click', () => { if (window.getSelection && String(window.getSelection())) return; unlockAudio(); stopSpeaking(); speakReply(entry.text, el); });
  }
  ui.empty.hidden = true;
  ui.log.classList.remove('is-empty');
  const stick = S.pinned;
  ui.log.insertBefore(el, S.thinkingEl && S.thinkingEl.parentNode === ui.log ? S.thinkingEl : null);
  if (stick) pinLog();
  if (!restoring) {
    const saved = { k: entry.k, text: entry.text };
    if (entry.brain) saved.brain = entry.brain;
    if (entry.from) saved.from = entry.from;
    if (entry.vibe) saved.vibe = true;
    if (entry.creation) saved.creation = true;
    logData.push(saved);
    if (logData.length > LOG_KEEP) logData.splice(0, logData.length - LOG_KEEP);
    later('save-log', () => lsSet(LOG_KEY, JSON.stringify(logData)), 400);
  }
  return el;
}

function restoreLog() {
  const saved = lsJSON(LOG_KEY, []);
  if (!Array.isArray(saved)) return;
  for (const e of saved.slice(-LOG_KEEP)) {
    if (!e || typeof e.text !== 'string' || !/^(user|guide|world|error)$/.test(e.k)) continue;
    addLine(e, true);
    logData.push(e);
  }
  S.lastGuideBrain = null;
}

function clearLog() {
  logData.length = 0;
  lsDel(LOG_KEY);
  const keep = [ui.empty];
  Array.prototype.slice.call(ui.log.children).forEach((c) => { if (keep.indexOf(c) < 0 && c !== S.thinkingEl) c.remove(); });
  ui.empty.hidden = false;
  ui.log.classList.add('is-empty');
  S.lastGuideBrain = null;
}

function renderThinking() {
  const show = S.thinking || (S.phase === 'waiting' && S.awaiting);
  if (!show) { if (S.thinkingEl) { S.thinkingEl.remove(); S.thinkingEl = null; } return; }
  if (!S.thinkingEl) {
    S.thinkingEl = document.createElement('div');
    S.thinkingEl.className = 'thinking';
    S.thinkingEl.innerHTML = '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="thinking-text"></span>';
  }
  S.thinkingEl.querySelector('.thinking-text').textContent = S.thinking ? S.thinkingDetail : (S.vibe ? 'Sending it to Claude' : 'Sending');
  if (S.thinkingEl.parentNode !== ui.log || S.thinkingEl !== ui.log.lastElementChild) {
    ui.log.appendChild(S.thinkingEl);
    if (S.pinned) pinLog();
  }
}

function pinLog() {
  ui.log.scrollTop = ui.log.scrollHeight;
  requestAnimationFrame(() => { ui.log.scrollTop = ui.log.scrollHeight; });
}

// ---------------------------------------------------------------------------------------------------------------
// Voice: listening

function setupVoice(mod) {
  S.voiceLoaded = true;
  if (mod && typeof mod.createVoice === 'function') {
    try {
      voice = mod.createVoice({
        onFinal: onVoiceFinal,
        onInterim: onVoiceInterim,
        onState: onVoiceState,
        onError: onVoiceError,
        onLevel: onVoiceLevel,
        handsFree: false,
      });
    } catch (err) {
      console.warn('[phone] createVoice() threw; voice input is off, replies are still spoken', err);
      voice = null;
    }
  }
  S.canListen = !!(voice && voice.supported && voice.supported.stt);
  renderVoiceInfo();
  updateOrb();
}

function moduleHandsFree() { return !!(voice && typeof voice.setHandsFree === 'function'); }

// voice states: 'idle' | 'listening' | 'hearing' | 'transcribing' | 'speaking' | 'paused' | 'error'
function normMic(s) {
  s = String(s || '').toLowerCase();
  if (s === 'hearing') return 'hearing';
  if (/speak/.test(s)) return 'speaking';
  if (/paus/.test(s)) return 'paused';
  if (/transcrib|process|upload|decod/.test(s)) return 'transcribing';
  if (/listen|record|captur|start/.test(s)) return 'listening';
  if (/err|fail|unavailable|denied|blocked/.test(s)) return 'error';
  return 'off';
}

function onVoiceState(state, detail) {
  const raw = state && typeof state === 'object' ? (state.state || state.name || state.type) : state;
  const info = (state && typeof state === 'object' ? state : detail) || {};
  const m = normMic(raw);
  S.needsGesture = m === 'paused' && !!info.needsGesture;
  if (m === 'speaking') { updateOrb(); return; } // our own speech phase drives the orb
  if (m === 'error') {
    setMic('off');
    if (info.error === 'not-allowed') micBlocked();
    resumeHandsFree(900, true);
    return;
  }
  setMic(m);
  if (m === 'off') resumeHandsFree();
}

// {error, message, recovered?}: recovered ones are notes (e.g. "switching to the server"), the rest need her.
function onVoiceError(e) {
  if (!e) return;
  if (e.error === 'not-allowed') { micBlocked(); return; }
  if (e.error === 'no-speech' || e.error === 'aborted') return;
  if (e.message) toast(e.message, !e.recovered);
  renderVoiceInfo();
}

// Whisper reports the mic level: let the orb swell with her voice (one CSS variable, at most once per frame).
function onVoiceLevel(v) {
  S.level = v;
  if (S.levelRaf) return;
  S.levelRaf = requestAnimationFrame(() => {
    S.levelRaf = 0;
    const lvl = S.mic === 'listening' || S.mic === 'hearing' ? Math.min(1, Math.sqrt(Math.max(0, S.level || 0)) * 2) : 0;
    ui.orb.style.setProperty('--level', lvl.toFixed(3));
  });
}

function onVoiceInterim(t) {
  const text = t && typeof t === 'object' ? t.text : t;
  if (S.mic !== 'listening' && S.mic !== 'transcribing') setMic('listening');
  if (text) S.lastInterimAt = Date.now();
  showTranscript(text, true);
}

function onVoiceFinal(t) {
  const text = String((t && typeof t === 'object' ? t.text : t) || '').trim();
  if (!text || /^\[.*\]$/.test(text)) { showTranscript(''); if (!moduleHandsFree()) resumeHandsFree(); return; }
  showTranscript(text, false);
  // One utterance per turn: stop now (harmless for one-shot recognisers). Hands-free listens again after the reply.
  if (!moduleHandsFree()) setTimeout(() => stopListening(true), 0);
  submit(text);
}

function setMic(m) { S.mic = m; updateOrb(); }

function startListening() {
  if (!S.canListen) {
    toast(S.voiceLoaded ? 'Voice input isn’t available in this browser. Type below instead.' : 'Voice is still loading.');
    return false;
  }
  if (S.mic === 'listening' || S.mic === 'hearing') return true;
  cancel('restart');
  if (S.phase === 'speaking') stopSpeaking();
  setMic('listening');
  try {
    const r = voice.start();
    if (r === false) { setMic('off'); return false; } // the module reports why through onState/onError
    if (r && typeof r.then === 'function') r.then(null, startFailed);
  } catch (err) { startFailed(err); return false; }
  return true;
}

function stopListening(quiet) {
  cancel('restart');
  try { if (voice) voice.stop(); } catch (e) { /* already stopped */ }
  if (S.mic === 'listening' || S.mic === 'paused') setMic('off');
  if (!quiet) showTranscript('');
}

function startFailed(err) {
  setMic('off');
  const name = err && (err.name || err.error || '');
  if (/NotAllowed|Security|denied|not-allowed/i.test(String(name) + ' ' + String(err && err.message))) { micBlocked(); return; }
  toast('Couldn’t start listening' + (err && err.message ? ': ' + err.message : '.'), true);
}

function micBlocked() {
  if (S.handsFree) setHandsFree(false);
  toast('The microphone is blocked. Allow it for this site in Settings (Safari, Microphone), then reload.', true);
}

// Hands-free: listen (again) when the conversation is ready for it. With the voice module's own hands-free loop the
// mic never goes 'off' between turns, so this only fires when nothing is listening yet, e.g. hands-free was switched
// on while the guide was talking. After a module error it waits for a tap instead of retrying in a loop.
function resumeHandsFree(delay, afterError) {
  if (!S.handsFree || !S.armed) return;
  if (afterError && moduleHandsFree()) return;
  if (S.phase !== 'idle' || S.speakQueue > 0 || S.mic !== 'off' || document.hidden) return;
  later('restart', () => {
    if (S.handsFree && S.armed && S.phase === 'idle' && S.speakQueue === 0 && S.mic === 'off' && !document.hidden) startListening();
  }, delay || 350);
}

function setHandsFree(on) {
  S.handsFree = on;
  S.armed = on;
  ui.handsfree.setAttribute('aria-pressed', on ? 'true' : 'false');
  if (moduleHandsFree()) { try { voice.setHandsFree(on); } catch (e) { /* keep going */ } }
  if (on) requestWakeLock(); else releaseWakeLock();
  updateOrb();
}

function showTranscript(text, interim) {
  cancel('transcript');
  let t = String(text || '');
  if (t.length > 120) t = '…' + t.slice(-118);
  ui.transcript.textContent = t;
  ui.transcript.classList.toggle('interim', !!interim);
  if (t && !interim) later('transcript', () => { ui.transcript.textContent = ''; }, 3000);
}

// ---------------------------------------------------------------------------------------------------------------
// Voice: speaking (the guide's replies, through the phone speaker or AirPods)

// iOS only lets a page speak after speechSynthesis.speak() ran inside a tap. Do that once, on the first tap.
function unlockAudio() {
  if (voice && typeof voice.unlock === 'function') {
    try { voice.unlock(); S.unlocked = true; return; } catch (e) { /* fall through */ }
  }
  if (S.unlocked) return;
  S.unlocked = true;
  try {
    if (window.speechSynthesis && window.SpeechSynthesisUtterance) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      window.speechSynthesis.speak(u);
    }
  } catch (e) { /* no speech */ }
}

function speakable(t) {
  return String(t || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/\b([a-z0-9]+(?:-[a-z0-9]+)+)\.js\b/gi, (m, slug) => slug.replace(/-/g, ' '))
    .replace(/[*_#`>~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
}

function speakReply(text, line) {
  const said = speakable(text);
  if (!said || !canSpeak()) return;
  const gen = S.speakGen;
  S.speakQueue++;
  S.speakChain = (S.speakChain || Promise.resolve()).then(micClear).then(() => {
    if (gen !== S.speakGen) return null;
    setPhase('speaking');
    if (line) line.classList.add('speaking');
    const ms = Math.min(60000, 4000 + said.length * 90); // iOS sometimes never fires 'end'
    return withTimeout(ttsSpeak(said), ms).then(() => { if (line) line.classList.remove('speaking'); });
  }).then(() => {
    if (gen !== S.speakGen) return;
    S.speakQueue = Math.max(0, S.speakQueue - 1);
    if (S.speakQueue === 0) {
      setPhase(S.awaiting ? 'waiting' : 'idle');
      resumeHandsFree(250);
    }
  });
}

// Our recogniser must not hear the reply, and a reply must not cut her off mid-sentence: if she's talking, wait
// for the utterance to finish; if hands-free is only waiting in silence, stop listening and speak now.
// (When the voice module runs hands-free itself, voice.speak() pauses its own recognition.)
function micClear() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    (function check() {
      if ((S.mic !== 'listening' && S.mic !== 'hearing') || moduleHandsFree()) { resolve(); return; }
      const talking = Date.now() - (S.lastInterimAt || 0) < 1500;
      if ((S.handsFree && !talking) || Date.now() - t0 > 20000) { stopListening(true); resolve(); return; }
      setTimeout(check, 200);
    })();
  });
}

function stopSpeaking() {
  S.speakGen++;
  S.speakQueue = 0;
  S.speakChain = Promise.resolve();
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) { /* nothing speaking */ }
  if (voice && typeof voice.stopSpeaking === 'function') { try { voice.stopSpeaking(); } catch (e) { /* optional */ } }
  Array.prototype.forEach.call(ui.log.querySelectorAll('.speaking'), (el) => el.classList.remove('speaking'));
  if (S.phase === 'speaking') setPhase(S.awaiting ? 'waiting' : 'idle');
}

function canSpeak() {
  return !!((voice && voice.supported && voice.supported.tts) || window.speechSynthesis);
}

function ttsSpeak(text) {
  if (voice && voice.supported && voice.supported.tts && typeof voice.speak === 'function') {
    try { return voice.speak(text); } catch (e) { /* fall back below */ }
  }
  return fallbackSpeak(text);
}

function pickVoice() {
  const all = (window.speechSynthesis && window.speechSynthesis.getVoices()) || [];
  const en = all.filter((v) => /^en([-_]|$)/i.test(v.lang));
  const prefer = [/premium/i, /enhanced/i, /samantha/i, /\bava\b/i, /\bzoe\b/i, /\bevan\b/i];
  for (let i = 0; i < prefer.length; i++) {
    const us = en.filter((v) => prefer[i].test(v.name) && /en[-_]US/i.test(v.lang))[0];
    const any = en.filter((v) => prefer[i].test(v.name))[0];
    if (us || any) return us || any;
  }
  return en.filter((v) => v.default)[0] || en[0] || null;
}

function fallbackSpeak(text) {
  return new Promise((resolve) => {
    const synth = window.speechSynthesis;
    if (!synth || !window.SpeechSynthesisUtterance) { resolve(); return; }
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
    u.rate = 0.95;
    u.pitch = 1;
    S.utterance = u; // keep a reference: iOS can drop 'end' for a garbage-collected utterance
    u.onend = u.onerror = () => resolve();
    try { synth.resume(); } catch (e) { /* not paused */ }
    synth.speak(u);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Orb, phases, hints

function setPhase(p) { S.phase = p; renderThinking(); updateOrb(); }

function updateOrb() {
  let orb = 'idle';
  let hint = '';
  let label = 'Tap to talk';
  const busy = S.phase === 'waiting' || S.thinking;
  if (S.phase === 'speaking') { orb = 'speaking'; hint = 'Speaking. Tap to interrupt'; label = 'Stop speaking and listen'; }
  else if (S.mic === 'hearing') { orb = 'hearing'; hint = S.handsFree ? 'Listening' : 'Listening. Tap when you’re done'; label = 'Stop listening'; }
  else if (S.mic === 'transcribing') { orb = 'transcribing'; hint = 'Catching your words'; }
  else if (busy) {
    orb = 'thinking';
    hint = (S.thinkingVibe || S.vibe ? 'Building' : 'Thinking') + (S.mic === 'listening' ? '. You can keep talking' : '');
  }
  else if (S.mic === 'listening') { orb = 'listening'; hint = S.handsFree ? 'Listening. Just talk' : 'Listening. Tap when you’re done'; label = 'Stop listening'; }
  else if (S.mic === 'paused' || S.needsGesture) { hint = 'Tap the light to keep listening'; }
  else if (!S.voiceLoaded) { hint = ''; }
  else if (!S.canListen) { orb = 'off'; hint = 'Voice input isn’t available here. Type below.'; label = 'Voice input unavailable'; }
  else if (S.handsFree) { hint = S.armed ? 'Hands-free is on' : 'Hands-free paused. Tap to resume'; }
  else { hint = S.vibe ? 'Tap and describe something to build' : 'Tap to talk'; }
  document.body.setAttribute('data-orb', orb);
  ui.hint.textContent = hint;
  ui.orb.setAttribute('aria-label', label);
}

function onOrbTap() {
  unlockAudio();
  if (S.phase === 'speaking') {
    stopSpeaking();
    if (S.handsFree) S.armed = true;
    startListening();
    return;
  }
  if (S.mic === 'listening' || S.mic === 'hearing') {
    stopListening(true); // finishes the utterance: the recogniser delivers what it heard
    if (S.handsFree) S.armed = false;
    updateOrb();
    return;
  }
  if (!S.canListen) { startListening(); ui.text.focus(); return; }
  if (S.handsFree) S.armed = true;
  startListening();
}

// ---------------------------------------------------------------------------------------------------------------
// Brain, vibe, world window

function renderBrain() {
  const cur = S.serverBrain || 'auto';
  const avail = S.health && S.health.brains;
  Array.prototype.forEach.call(ui.brain.options, (opt) => {
    if (opt.value === 'auto') return;
    const ok = !avail || avail[opt.value] !== false;
    opt.textContent = BRAIN_LONG[opt.value] + (ok ? '' : ' (not running)');
    opt.disabled = !ok && opt.value !== cur;
  });
  ui.brain.value = cur;
  ui.brainName.textContent = BRAIN_SHORT[cur] || cur;
  ui.brainPill.setAttribute('data-ok', cur === 'auto' || !avail || avail[cur] !== false ? 'true' : 'false');
}

function onBrainChange() {
  const b = ui.brain.value;
  const prev = S.serverBrain;
  S.serverBrain = b;
  renderBrain();
  if (!client || typeof client.setBrain !== 'function') return;
  Promise.resolve(client.setBrain(b)).then((r) => {
    if (r && r.ok === false) { S.serverBrain = prev; renderBrain(); toast('Couldn’t switch: ' + (r.error || 'server error'), true); return; }
    toast(b === 'auto' ? 'The guide will use the best brain available.' : 'The guide now thinks with ' + BRAIN_PHRASE[b] + '.');
  });
}

function vibeAvailable() { return !(S.health && S.health.vibe === false); }
function renderVibe() {
  ui.vibe.setAttribute('aria-pressed', S.vibe ? 'true' : 'false');
  document.body.classList.toggle('vibe', S.vibe);
  ui.text.placeholder = S.vibe ? 'Describe something to build' : 'Type to the guide';
  updateOrb();
}
function toggleVibe() {
  if (!S.vibe && !vibeAvailable()) { toast('Vibe mode isn’t running on your Mac.', true); return; }
  S.vibe = !S.vibe;
  renderVibe();
  toast(S.vibe ? 'Vibe mode: describe something and Claude builds it into the world.' : 'Back to talking with the guide.');
}

function worldUrl() {
  // ?embed=1: the viewer hides its overlay. ?noemu: never load the desktop XR emulator on a phone.
  return '/?embed=1&noemu' + (token ? '&t=' + encodeURIComponent(token) : '');
}
function setWorldOpen(open) {
  S.worldOpen = open;
  prefs.world = open;
  savePrefs();
  ui.world.hidden = !open;
  ui.world.classList.remove('ready');
  ui.worldToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  ui.worldToggle.setAttribute('aria-label', open ? 'Hide the world' : 'Show the world');
  // Unload when hidden: a three.js scene rendering out of sight would drain the battery.
  ui.worldFrame.src = open ? worldUrl() : 'about:blank';
  if (S.pinned) pinLog();
}

// ---------------------------------------------------------------------------------------------------------------
// Pairing (no token, or a refused one). A Home Screen app has its own storage, so it may need the link once.

function showPair(msg) {
  if (msg) ui.pairMsg.textContent = msg;
  ui.pair.hidden = false;
  ui.app.setAttribute('aria-hidden', 'true');
}
function hidePair() {
  ui.pair.hidden = true;
  ui.app.removeAttribute('aria-hidden');
}

function parsePairing(v) {
  let url = null;
  try { url = new URL(v); } catch (e) { /* not a URL */ }
  if (url) {
    const t = url.searchParams.get('t') || new URLSearchParams((url.hash || '').replace(/^#/, '')).get('t');
    return { url, token: t };
  }
  const m = /[?&#]t=([^&#\s]+)/.exec(v);
  if (m) return { token: decodeURIComponent(m[1]) };
  if (/^[A-Za-z0-9_-]{16,}$/.test(v)) return { token: v };
  return {};
}

function onPairSubmit(e) {
  e.preventDefault();
  const v = ui.pairInput.value.trim();
  if (!v) { ui.pairInput.focus(); return; }
  const p = parsePairing(v);
  if (p.url && p.url.origin !== location.origin) {
    if (!isStandalone()) { location.href = p.url.href; return; }
    ui.pairMsg.textContent = 'That link is for a different address (the tunnel changed). Open it in Safari and add that page to your Home Screen.';
    return;
  }
  if (!p.token) { ui.pairMsg.textContent = 'That doesn’t look like a phone link. It ends in ?t= followed by a long code.'; return; }
  const prev = token;
  token = p.token;
  api('GET', '/api/world').then((r) => {
    if (r.status === 401) { token = prev; ui.pairMsg.textContent = 'That code was refused. Copy the phone link again from your Mac.'; return; }
    if (net && typeof net.setToken === 'function') net.setToken(token); else lsSet(TOKEN_KEY, token);
    ui.pairInput.value = '';
    hidePair();
    if (client && typeof client.setToken === 'function') client.setToken(token);
    else startClient();
    if (!r.ok) setConn('down');
    toast('Connected. Say hello to the guide.');
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Settings sheet

function openSheet() {
  ui.optSpeak.checked = prefs.speak;
  ui.installRow.hidden = isStandalone();
  renderVoiceInfo();
  if (typeof ui.sheet.showModal === 'function') { try { ui.sheet.showModal(); return; } catch (e) { /* already open */ } }
  ui.sheet.setAttribute('open', '');
}
function closeSheet() {
  if (typeof ui.sheet.close === 'function') { try { ui.sheet.close(); return; } catch (e) { /* not open */ } }
  ui.sheet.removeAttribute('open');
}

function renderVoiceInfo() {
  let t;
  const whisperUp = S.health && S.health.stt ? !!S.health.stt.whisper : null;
  if (!S.voiceLoaded) t = 'Loading';
  else if (!voice) t = 'The voice module didn’t load, so voice input is off. Typing works, and replies are still spoken.';
  else if (!S.canListen) t = 'This browser can’t listen. Typing works, and replies are still spoken.';
  else if (voice.mode === 'whisper') t = whisperUp === false ? 'Whisper on your Mac, but it isn’t running. Start it with npm run up.' : 'Recorded here, transcribed by Whisper on your Mac.';
  else if (voice.mode === 'web-speech') t = 'Safari speech recognition' + (isIOS() ? ' (needs Siri turned on)' : '') + '.';
  else t = voice.mode ? String(voice.mode) : 'Ready';
  ui.voiceInfo.textContent = t;
}

function copyPhoneLink() {
  if (!token) { toast('Not connected yet.'); return; }
  const link = location.origin + '/phone/?t=' + encodeURIComponent(token);
  const done = () => toast('Phone link copied. Paste it into the Home Screen app if it asks.');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(done, () => legacyCopy(link) ? done() : toast('Couldn’t copy the link.', true));
  } else if (legacyCopy(link)) done();
  else toast('Couldn’t copy the link.', true);
}
function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  ta.remove();
  return ok;
}

function forgetPhone() {
  if (!window.confirm('Disconnect this phone? You’ll need the phone link from your Mac to connect again.')) return;
  lsDel(TOKEN_KEY);
  if (net && typeof net.setToken === 'function') net.setToken(null);
  if (client && typeof client.close === 'function') client.close();
  location.replace(location.pathname);
}

// ---------------------------------------------------------------------------------------------------------------
// Toast, wake lock, keyboard, lifecycle

function toast(text, isError) {
  ui.toast.textContent = text;
  ui.toast.classList.toggle('error', !!isError);
  ui.toast.classList.add('show');
  later('toast', () => ui.toast.classList.remove('show'), isError ? 5200 : 3200);
}

// Hands-free keeps the screen awake: a locked iPhone stops the microphone.
function requestWakeLock() {
  if (!navigator.wakeLock || document.hidden || S.wakeLock) return;
  navigator.wakeLock.request('screen').then((lock) => {
    S.wakeLock = lock;
    lock.addEventListener('release', () => { if (S.wakeLock === lock) S.wakeLock = null; });
    if (!S.handsFree) releaseWakeLock();
  }, () => { /* not allowed here (older iOS): the hint tells her to tap if it pauses */ });
}
function releaseWakeLock() {
  const lock = S.wakeLock;
  S.wakeLock = null;
  if (lock) lock.release().catch(() => {});
}

// iOS keeps the layout viewport full height when the keyboard opens; pin the app to the visible part instead.
function fitViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const apply = () => {
    const kb = vv.scale < 1.05 && window.innerHeight - vv.height > 120;
    document.body.classList.toggle('kb', kb);
    if (kb) {
      ui.app.style.top = vv.offsetTop + 'px';
      ui.app.style.height = vv.height + 'px';
      ui.app.style.bottom = 'auto';
    } else {
      ui.app.style.top = '';
      ui.app.style.height = '';
      ui.app.style.bottom = '';
    }
    if (S.pinned) pinLog();
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
}

function onVisibility() {
  if (document.hidden) {
    // iOS ends recognition in the background. The voice module pauses itself and resumes on return (or reports
    // 'paused' + needsGesture, and the hint asks for a tap); without it there is nothing to stop.
    if (!moduleHandsFree() && S.mic !== 'off') { stopListening(true); if (S.handsFree) S.armed = false; }
  } else {
    if (S.handsFree) requestWakeLock();
    refreshHealth();
  }
  updateOrb();
}

function bindUI() {
  // The first tap anywhere unlocks speech, so replies can be spoken even if she only types.
  const firstTap = () => { unlockAudio(); document.removeEventListener('touchend', firstTap, true); document.removeEventListener('click', firstTap, true); };
  document.addEventListener('touchend', firstTap, true);
  document.addEventListener('click', firstTap, true);

  ui.orb.addEventListener('click', onOrbTap);
  ui.orb.addEventListener('contextmenu', (e) => e.preventDefault());

  ui.handsfree.addEventListener('click', () => {
    unlockAudio();
    const on = !S.handsFree;
    if (on && !S.canListen) { toast('Hands-free needs voice input, which isn’t available here.', true); return; }
    setHandsFree(on);
    if (on) {
      if (S.phase !== 'speaking' && (S.mic === 'off' || S.mic === 'paused')) startListening(); // inside the tap, as iOS requires
      toast('Hands-free on. Talk whenever you like; the guide answers out loud.');
    } else if (S.mic !== 'off' && S.mic !== 'transcribing') stopListening();
  });

  ui.vibe.addEventListener('click', () => { unlockAudio(); toggleVibe(); });

  ui.compose.addEventListener('submit', (e) => {
    e.preventDefault();
    unlockAudio();
    const v = ui.text.value;
    ui.text.value = '';
    ui.send.disabled = true;
    submit(v);
  });
  ui.text.addEventListener('input', () => { ui.send.disabled = !ui.text.value.trim(); });
  ui.text.addEventListener('focus', () => { document.body.classList.add('typing'); if (S.pinned) setTimeout(pinLog, 300); });
  ui.text.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== ui.text) document.body.classList.remove('typing'); }, 120); });

  ui.brain.addEventListener('change', onBrainChange);
  ui.worldToggle.addEventListener('click', () => setWorldOpen(!S.worldOpen));
  ui.worldFrame.addEventListener('load', () => { if (S.worldOpen && ui.worldFrame.src.indexOf('about:') !== 0) ui.world.classList.add('ready'); });

  ui.log.addEventListener('scroll', () => { S.pinned = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 60; }, { passive: true });

  ui.menuBtn.addEventListener('click', openSheet);
  ui.sheet.addEventListener('click', (e) => { if (e.target === ui.sheet) closeSheet(); });
  ui.sheet.querySelector('.sheet-done').addEventListener('click', (e) => { e.preventDefault(); closeSheet(); });
  ui.optSpeak.addEventListener('change', () => { prefs.speak = ui.optSpeak.checked; savePrefs(); if (!prefs.speak) stopSpeaking(); });
  ui.copyLink.addEventListener('click', copyPhoneLink);
  ui.clearLog.addEventListener('click', () => { clearLog(); closeSheet(); });
  ui.forget.addEventListener('click', forgetPhone);

  ui.pairForm.addEventListener('submit', onPairSubmit);

  document.addEventListener('visibilitychange', onVisibility);
}

// ---------------------------------------------------------------------------------------------------------------
// Backup connection, only if src/net/client.js fails to load. The same HTTP contract, EventSource only, no frills.

function fallbackConnect(h) {
  let es = null;
  let world = null;
  let retry = 1000;
  let closed = false;
  const say = (state) => { if (h.onConnection) h.onConnection(state); };
  function open() {
    if (closed) return;
    if (!token) { say('unauthorized'); return; }
    say('connecting');
    es = new EventSource('/api/events?t=' + encodeURIComponent(token));
    ['snapshot', 'op', 'chat', 'status', 'creation'].forEach((name) => {
      es.addEventListener(name, (e) => {
        let d;
        try { d = JSON.parse(e.data); } catch (err) { return; }
        if (name === 'snapshot') { world = d; retry = 1000; say('open'); h.onSnapshot(d); }
        else if (name === 'op') h.onOp(Object.assign({}, d, d.op, { op: d.op }));
        else if (name === 'chat') h.onChat(d);
        else if (name === 'status') h.onStatus(d);
        else h.onCreation(d);
      });
    });
    es.addEventListener('error', (e) => {
      if (typeof e.data === 'string') {
        let d; try { d = JSON.parse(e.data); } catch (err) { d = { message: e.data }; }
        h.onError(Object.assign({ source: 'server' }, d));
        return;
      }
      es.close();
      say('reconnecting');
      setTimeout(open, retry);
      retry = Math.min(retry * 2, 30000);
    });
  }
  open();
  return {
    send: (text) => api('POST', '/api/chat', { text, from: FROM }),
    vibe: (text) => api('POST', '/api/vibe', { text, from: FROM }),
    op: (op) => api('POST', '/api/op', op),
    setBrain: (brain) => api('POST', '/api/brain', { brain }),
    health: () => api('GET', '/api/health', null, false),
    world: () => world,
    setToken: (t) => { token = t; lsSet(TOKEN_KEY, t); if (es) es.close(); open(); },
    close: () => { closed = true; if (es) es.close(); },
  };
}

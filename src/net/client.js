// src/net/client.js — Dreamspace client: live world events (SSE) + JSON API, with the token and reconnects handled.
// Owner: client-io. Contract: docs/CONTRACT.md ("Client modules", "HTTP API", "SSE events", "Auth").
//
//   import { connect } from './net/client.js';
//   const net = connect({
//     onSnapshot: (world) => objects.sync(world),          // full World; the first event of every (re)connection
//     onOp:       (op)    => objects.apply(op),            // the Op itself (also carries op.op and op.world_version)
//     onChat:     (m)     => panel.add(m),                 // {id, role:'user'|'guide', from, text, brain?}
//     onStatus:   (s)     => guide.setThinking(s.thinking),// {thinking, brain, detail?}
//     onError:    (e)     => console.warn(e.message),      // {message, source:'server'|'auth'|'network'|'http', status?}
//     onCreation: (c)     => creations.load(c),            // optional: vibe mode {slug, url, action}
//     onConnection: (state) => {},                         // optional: 'connecting'|'open'|'reconnecting'|'unauthorized'|'closed'
//     from: () => renderer.xr.isPresenting ? 'xr' : 'desktop', // optional; default 'phone' under /phone/, else 'desktop'
//   });
//   net.send('make it dawn');   net.op({type:'move', id, position});   net.setBrain('ollama');   net.world();
//
// Every request helper resolves (never rejects) to {ok:true, ...body} or {ok:false, status, error}, so fire-and-forget
// calls can't leave red "unhandled rejection" errors in the console. Failures are also reported through onError.
//
// Transport: the live stream is read with fetch() + a streaming body (sends the token as a header AND as ?t=, sees
// HTTP status codes, and notices the server's 15 s ": ping" comments, so a dead tunnel is detected). It falls back
// to EventSource where streaming fetch is missing, and switches transport by itself if one of them stalls.
// No top-level window/document access, so the module also imports in Node for tests.

const TOKEN_KEY = 'dreamspace.token';
const EVENTS = ['snapshot', 'op', 'chat', 'status', 'creation'];

// ---------------------------------------------------------------------------------------------------------------
// Token: ?t=<token> (or #t=<token>) on first load → localStorage['dreamspace.token'] → stripped from the address bar.

let memToken = null;
let captured = false;

function store() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

// Remove key `t` from a "a=1&t=x&b" string without re-encoding the other parameters (keeps ?noemu, ?embed=1 as-is).
function dropParam(qs, key) {
  let found = null;
  const kept = [];
  for (const part of qs.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    let k = eq < 0 ? part : part.slice(0, eq);
    try { k = decodeURIComponent(k.replace(/\+/g, ' ')); } catch { /* keep raw */ }
    if (k === key) {
      if (found === null) {
        const v = eq < 0 ? '' : part.slice(eq + 1);
        try { found = decodeURIComponent(v.replace(/\+/g, ' ')); } catch { found = v; }
      }
    } else kept.push(part);
  }
  return { value: found, rest: kept.join('&') };
}

/** Reads ?t= / #t= once, saves it, and strips it from the URL. Returns the token (or null). Safe to call repeatedly. */
export function captureToken() {
  if (captured) return getToken();
  captured = true;
  let fromUrl = null;
  try {
    const loc = globalThis.location;
    if (loc && typeof loc.search === 'string') {
      const q = dropParam(loc.search.replace(/^\?/, ''), 't');
      const h = dropParam((loc.hash || '').replace(/^#/, ''), 't');
      fromUrl = q.value || h.value || null;
      if (q.value !== null || h.value !== null) {
        const clean = loc.pathname + (q.rest ? '?' + q.rest : '') + (h.rest ? '#' + h.rest : '');
        try { globalThis.history?.replaceState(globalThis.history.state, '', clean); } catch { /* sandboxed iframe */ }
      }
    }
  } catch { /* no location (Node) */ }
  if (fromUrl) setToken(fromUrl);
  return getToken();
}

/** The current token: in memory, else localStorage. */
export function getToken() {
  if (!captured) return captureToken();
  if (memToken) return memToken;
  try { memToken = store()?.getItem(TOKEN_KEY) || null; } catch { /* storage blocked */ }
  return memToken;
}

/** Saves a token (for a "paste your token" UI). Live clients made by connect() pick it up via client.setToken(). */
export function setToken(token) {
  memToken = token ? String(token).trim() : null;
  try {
    const s = store();
    if (s) memToken ? s.setItem(TOKEN_KEY, memToken) : s.removeItem(TOKEN_KEY);
  } catch { /* private mode: memory only */ }
  return memToken;
}

/** Headers for an authenticated request. */
export function authHeaders(extra = {}) {
  const t = getToken();
  return t ? { ...extra, 'x-world-token': t } : { ...extra };
}

// ---------------------------------------------------------------------------------------------------------------
// Small request helper, shared with src/voice/index.js (whisper upload). Resolves, never rejects.

const RETRYABLE = new Set([502, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]); // proxy/tunnel: origin not reached
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * apiRequest('POST', '/api/chat', {json:{text}}) → {ok, status, data, error}
 * opts: {json, body, headers, base='', timeout=15000, retries (default: 1 for GET, 1 for tunnel 5xx on POST), signal, auth=true}
 */
export async function apiRequest(method, path, opts = {}) {
  const { json, body, headers = {}, base = '', timeout = 15000, signal, auth = true } = opts;
  const isGet = method === 'GET' || method === 'HEAD';
  const retries = opts.retries ?? 1;
  const h = auth ? authHeaders(headers) : { ...headers };
  let payload = body;
  if (json !== undefined) { payload = JSON.stringify(json); h['content-type'] = 'application/json'; }

  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(base + path, { method, headers: h, body: payload, cache: 'no-store', signal: ctrl.signal });
      const ct = res.headers.get('content-type') || '';
      let data = null;
      try { data = ct.includes('json') ? await res.json() : await res.text(); } catch { data = null; }
      if (!res.ok && RETRYABLE.has(res.status) && attempt < retries) { await sleep(600 + attempt * 600); continue; }
      const error = res.ok ? null
        : (data && typeof data === 'object' && data.error) || (typeof data === 'string' && data.trim().slice(0, 200)) || `HTTP ${res.status}`;
      return { ok: res.ok, status: res.status, data, error };
    } catch (err) {
      const aborted = ctrl.signal.aborted;
      if (signal?.aborted) return { ok: false, status: 0, data: null, error: 'aborted' };
      // A GET is safe to repeat. A POST that failed at the network level may or may not have arrived: don't repeat it.
      if (isGet && attempt < retries) { await sleep(500); continue; }
      return { ok: false, status: 0, data: null, error: aborted ? 'timeout' : (err?.message || 'network error') };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// SSE parsing (per the HTML spec's event-stream format), fed with decoded text chunks.

function createSseParser(onEvent, onComment) {
  let buf = '';
  let event = '';
  let data = '';
  let hasData = false;
  let pendingCR = false;
  function line(l) {
    if (l === '') {
      if (hasData) onEvent(event || 'message', data.endsWith('\n') ? data.slice(0, -1) : data);
      event = ''; data = ''; hasData = false;
      return;
    }
    if (l[0] === ':') { onComment(l.slice(1).trim()); return; }
    const i = l.indexOf(':');
    const field = i < 0 ? l : l.slice(0, i);
    let value = i < 0 ? '' : l.slice(i + 1);
    if (value[0] === ' ') value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') { data += value + '\n'; hasData = true; }
    // 'id' and 'retry' are not used by this app.
  }
  return function feed(chunk) {
    if (pendingCR && chunk[0] === '\n') chunk = chunk.slice(1);
    pendingCR = false;
    buf += chunk;
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      if (c === '\n' || c === '\r') {
        line(buf.slice(start, i));
        if (c === '\r') {
          if (i + 1 < buf.length) { if (buf[i + 1] === '\n') i++; } else pendingCR = true;
        }
        start = i + 1;
      }
    }
    buf = buf.slice(start);
  };
}

// ---------------------------------------------------------------------------------------------------------------
// connect()

function defaultFrom() {
  try { return /^\/phone(\/|$)/.test(globalThis.location?.pathname || '') ? 'phone' : 'desktop'; } catch { return 'desktop'; }
}

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * connect(callbacks & options) → client
 * Options (all optional): base (URL prefix, default same origin), from ('phone'|'xr'|'desktop' or a function returning one),
 * transport ('auto'|'fetch'|'eventsource'), maxBackoffMs (30000), stallMs (20000: no snapshot after connecting → retry),
 * livenessMs (45000: armed once a ": ping" has been seen), autoConnect (true).
 */
export function connect(opts = {}) {
  const cb = opts;
  const base = opts.base || '';
  const maxBackoff = opts.maxBackoffMs ?? 30000;
  const stallMs = opts.stallMs ?? 20000;
  const livenessMs = opts.livenessMs ?? 45000;
  let transport = opts.transport || 'auto';
  let from = opts.from || defaultFrom;

  let token = getToken();
  let world = null;
  let state = 'idle';
  let closed = false;
  let gen = 0;            // connection generation: callbacks from older connections are ignored
  let attempt = 0;        // consecutive failed attempts (reset by a snapshot)
  let stalls = 0;
  let reconnectTimer = null;
  let stallTimer = null;
  let liveTimer = null;
  let lastActivity = 0;
  let pingSeen = false;
  let hiddenAt = 0;
  let current = null;     // {abort()}
  let failuresReported = false;
  let resyncTimer = null;
  let resyncBusy = false;
  let resyncAgain = false;

  const now = () => Date.now();

  function safe(fn, ...args) {
    if (typeof fn !== 'function') return;
    try { fn(...args); } catch (err) { console.error('[net] callback error', err); }
  }
  function setState(s, info) {
    if (s === state) return;
    state = s;
    safe(cb.onConnection, s, { attempt, transport: usedTransport(), ...info });
  }
  function reportError(e) { safe(cb.onError, e); }
  function fromValue() {
    try { const f = typeof from === 'function' ? from() : from; return f || 'desktop'; } catch { return 'desktop'; }
  }

  function canStreamFetch() {
    return typeof fetch === 'function' && typeof TextDecoder === 'function' && typeof ReadableStream === 'function'
      && typeof Response === 'function' && 'body' in Response.prototype;
  }
  function usedTransport() {
    if (transport === 'eventsource') return 'eventsource';
    if (transport === 'fetch') return 'fetch';
    if (transport === 'auto-eventsource') return typeof EventSource === 'function' ? 'eventsource' : 'fetch';
    return canStreamFetch() ? 'fetch' : 'eventsource';
  }

  // ---- world cache -------------------------------------------------------------------------------------------
  // `world` is this client's private copy (callbacks get their own parsed objects, so nothing they hold is mutated).
  // `seenVersion` is the newest world_version seen anywhere; a refetch older than that is stale and is retried.
  let seenVersion = -Infinity;
  function clone(v) {
    try { return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)); }
    catch { return JSON.parse(JSON.stringify(v)); }
  }
  function setWorld(w) {
    if (!isObj(w)) return false;
    world = clone(w);
    if (typeof w.version === 'number') seenVersion = w.version;
    return true;
  }

  // Apply an op to the cached world where that's exact; return false when only a refetch can be right.
  function applyLocal(w, op, evt) {
    if (!w || !isObj(op)) return false;
    const objs = Array.isArray(w.objects) ? w.objects : (w.objects = []);
    switch (op.type) {
      case 'add': {
        // server/world.mjs sends the resolved object as op.object (and spread into the op); older shapes: evt.obj/evt.object.
        let obj = isObj(op.object) ? op.object : isObj(evt.obj) ? evt.obj : isObj(evt.object) ? evt.object : null;
        if (!obj && op.id && op.asset) { const { type, object, replaces, ...rest } = op; obj = rest; }
        if (!obj || !obj.id) return false; // unresolved add (no id/asset): refetch
        const i = objs.findIndex((o) => o.id === obj.id);
        if (i >= 0) objs[i] = { ...objs[i], ...obj }; else objs.push({ ...obj });
        return true;
      }
      case 'move': {
        const o = objs.find((x) => x.id === op.id);
        if (!o) return false;
        if (Array.isArray(op.position)) o.position = op.position.slice(0, 3);
        if (typeof op.rotationY === 'number') o.rotationY = op.rotationY;
        return true;
      }
      case 'remove': w.objects = objs.filter((x) => x.id !== op.id); return true;
      case 'clear': w.objects = []; return true;
      case 'mood': {
        w.mood = { ...(w.mood || {}) };
        for (const k of ['preset', 'fog', 'glow']) if (op[k] !== undefined) w.mood[k] = op[k];
        return true;
      }
      case 'guide': {
        w.guide = { ...(w.guide || {}) };
        for (const k of ['position', 'mood']) if (op[k] !== undefined) w.guide[k] = op[k];
        return true;
      }
      default: return false;
    }
  }

  // Refetch GET /api/world and deliver it as a snapshot (debounced, one at a time, never older than what we've seen).
  let staleRetries = 0;
  function scheduleResync(delay = 120) {
    if (closed) return;
    if (resyncBusy) { resyncAgain = true; return; }
    clearTimeout(resyncTimer);
    resyncTimer = setTimeout(async () => {
      resyncBusy = true;
      const r = await apiRequest('GET', '/api/world', { base, timeout: 10000 });
      resyncBusy = false;
      if (closed) return;
      if (r.ok && isObj(r.data)) {
        const v = r.data.version;
        if (typeof v === 'number' && v < seenVersion && staleRetries < 5) {
          staleRetries++; resyncAgain = true;         // served before an op we already saw: ask again
        } else {
          staleRetries = 0;
          setWorld(r.data);
          safe(cb.onSnapshot, r.data);
        }
      } else if (r.status === 401) authFailed();
      if (resyncAgain) { resyncAgain = false; scheduleResync(250); }
    }, delay);
  }

  function handleOp(data) {
    if (!isObj(data) || !isObj(data.op)) return;
    const op = data.op;
    const v = typeof data.world_version === 'number' ? data.world_version : null;
    // The payload is the Op itself (so onOp: op => objects.apply(op) works), plus .op and .world_version.
    const payload = { ...data, ...op, op, world_version: data.world_version };
    let resync = false;
    if (!world) {
      resync = true; // an op before any snapshot (shouldn't happen): fetch the truth
    } else {
      const cur = typeof world.version === 'number' ? world.version : null;
      const gap = cur !== null && v !== null && v > cur + 1;          // we missed something
      const fresh = cur === null || v === null || v > cur;            // not a replay of something we already have
      if (gap) resync = true;
      else if (fresh && !applyLocal(world, op, data)) resync = true;  // e.g. an add without id/asset
      if (v !== null && (cur === null || v > cur)) world.version = v;
    }
    if (v !== null && v > seenVersion) seenVersion = v;
    safe(cb.onOp, payload, data);
    if (resync) scheduleResync();
  }

  function dispatch(name, raw, myGen) {
    if (myGen !== gen || closed) return;
    lastActivity = now();
    let data = raw;
    if (typeof raw === 'string' && raw !== '') { try { data = JSON.parse(raw); } catch { data = raw; } }
    switch (name) {
      case 'snapshot':
        if (!setWorld(data)) return;
        clearTimeout(stallTimer);
        attempt = 0; stalls = 0; failuresReported = false;
        setState('open');
        safe(cb.onSnapshot, data);
        break;
      case 'op': handleOp(data); break;
      case 'chat': safe(cb.onChat, data); break;
      case 'status': safe(cb.onStatus, data); break;
      case 'creation': safe(cb.onCreation, data); break;
      case 'error':
        reportError(isObj(data) ? { ...data, message: data.message || 'server error', source: 'server' }
          : { message: String(data || 'server error'), source: 'server' });
        break;
      default: safe(cb.onEvent, name, data);
    }
  }

  // ---- connection lifecycle ----------------------------------------------------------------------------------
  function teardown() {
    clearTimeout(stallTimer); stallTimer = null;
    clearInterval(liveTimer); liveTimer = null;
    const c = current; current = null;
    if (c) { try { c.abort(); } catch { /* already closed */ } }
  }

  function open() {
    if (closed) return;
    clearTimeout(reconnectTimer); reconnectTimer = null;
    teardown();
    const myGen = ++gen;
    token = getToken();
    if (!token) { authFailed(true); return; }
    setState(attempt === 0 && state !== 'reconnecting' ? 'connecting' : 'reconnecting');
    pingSeen = false;
    lastActivity = now();
    stallTimer = setTimeout(() => stalled(myGen), stallMs);
    liveTimer = setInterval(() => {
      if (myGen === gen && pingSeen && now() - lastActivity > livenessMs) failed(myGen, 'no data from server (tunnel dropped?)');
    }, Math.max(1000, Math.min(5000, livenessMs / 3)));
    if (usedTransport() === 'fetch') openFetch(myGen); else openEventSource(myGen);
  }

  function eventsUrl() { return `${base}/api/events?t=${encodeURIComponent(token)}&from=${encodeURIComponent(fromValue())}`; }

  function openFetch(myGen) {
    const ctrl = new AbortController();
    current = { abort: () => ctrl.abort() };
    const url = eventsUrl();
    (async () => {
      let res;
      try {
        res = await fetch(url, {
          headers: { accept: 'text/event-stream', 'x-world-token': token },
          cache: 'no-store', signal: ctrl.signal,
        });
      } catch (err) {
        if (myGen === gen) failed(myGen, err?.message || 'network error');
        return;
      }
      if (myGen !== gen) { try { ctrl.abort(); } catch { /* */ } return; }
      if (res.status === 401 || res.status === 403) { authFailed(); try { ctrl.abort(); } catch { /* */ } return; }
      const ct = res.headers.get('content-type') || '';
      if (!res.ok || !res.body || !ct.includes('text/event-stream')) {
        try { ctrl.abort(); } catch { /* */ }
        failed(myGen, `HTTP ${res.status}${res.ok ? ' (not an event stream)' : ''}`);
        return;
      }
      const feed = createSseParser((name, data) => dispatch(name, data, myGen), (text) => {
        if (myGen !== gen) return;
        lastActivity = now();
        if (/^ping\b/i.test(text)) pingSeen = true; // the server keeps pinging: silence now means a dead link
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (myGen !== gen) { try { reader.cancel(); } catch { /* */ } return; }
          if (done) break;
          lastActivity = now();
          feed(dec.decode(value, { stream: true }));
        }
        feed(dec.decode());
      } catch (err) {
        if (myGen === gen) failed(myGen, err?.message || 'stream error');
        return;
      }
      if (myGen === gen) failed(myGen, 'stream closed');
    })();
  }

  function openEventSource(myGen) {
    if (typeof EventSource !== 'function') { failed(myGen, 'EventSource unavailable'); return; }
    let es;
    try { es = new EventSource(eventsUrl()); } catch (err) {
      failed(myGen, err?.message || 'EventSource failed'); return;
    }
    current = { abort: () => es.close() };
    for (const name of EVENTS) es.addEventListener(name, (e) => dispatch(name, e.data, myGen));
    es.onmessage = (e) => dispatch('message', e.data, myGen);
    // The server's own "event: error" and EventSource's connection error share one name: data tells them apart.
    es.addEventListener('error', (e) => {
      if (myGen !== gen) return;
      if (typeof e?.data === 'string') { dispatch('error', e.data, myGen); return; }
      es.close();
      probeAuthThen(myGen, 'connection lost');
    });
  }

  // EventSource can't see status codes: ask /api/world whether the token is the problem.
  async function probeAuthThen(myGen, reason) {
    const r = await apiRequest('GET', '/api/world', { base, timeout: 8000, retries: 0 });
    if (myGen !== gen || closed) return;
    if (r.status === 401 || r.status === 403) authFailed(); else failed(myGen, reason);
  }

  function stalled(myGen) {
    if (myGen !== gen || closed || state === 'open') return;
    stalls++;
    // Something between us and the server is buffering the stream. Try the other transport next time.
    if ((transport === 'auto' || transport === 'auto-eventsource') && stalls >= 2) {
      transport = usedTransport() === 'fetch' ? 'auto-eventsource' : 'auto';
    }
    if (stalls === 2) reportError({ message: 'Live updates are being held up by the network or tunnel; still trying.', source: 'network' });
    failed(myGen, 'no snapshot (stream buffered?)');
  }

  function failed(myGen, reason) {
    if (myGen !== gen || closed) return;
    teardown();
    gen++; // invalidate the dead connection's late callbacks
    attempt++;
    const delay = Math.min(maxBackoff, 500 * 2 ** Math.min(attempt - 1, 10)) * (0.75 + Math.random() * 0.5);
    setState('reconnecting', { reason, delay: Math.round(delay) });
    if (attempt >= 5 && !failuresReported) {
      failuresReported = true;
      reportError({ message: `Can't reach the world server (${reason}); retrying.`, source: 'network' });
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(open, delay);
  }

  function authFailed(noToken = false) {
    if (closed) return;
    teardown();
    gen++;
    const was = state;
    setState('unauthorized');
    if (was !== 'unauthorized') {
      reportError({
        message: noToken ? 'No world token: open the link with ?t=<token> (printed by npm run up).' : 'The world token was refused.',
        source: 'auth', status: 401,
      });
    }
    // Retry slowly in case the token gets fixed elsewhere (another tab, setToken()).
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(open, maxBackoff);
  }

  function reconnectNow() {
    if (closed) return;
    attempt = 0;
    open();
  }

  // ---- page lifecycle (phones kill streams in the background; tunnels drop quietly) ---------------------------
  const doc = globalThis.document;
  const win = globalThis.window || null;
  function onVisibility() {
    if (!doc) return;
    if (doc.visibilityState === 'hidden') { hiddenAt = now(); return; }
    const away = hiddenAt ? now() - hiddenAt : 0;
    hiddenAt = 0;
    if (state !== 'open' || away > 20000) reconnectNow();
  }
  function onOnline() { if (state !== 'open') reconnectNow(); }
  function onPageShow(e) { if (e && e.persisted) reconnectNow(); }
  doc?.addEventListener?.('visibilitychange', onVisibility);
  win?.addEventListener?.('online', onOnline);
  win?.addEventListener?.('pageshow', onPageShow);

  // ---- public API ---------------------------------------------------------------------------------------------
  async function post(path, json, what) {
    const r = await apiRequest('POST', path, { base, json });
    if (r.ok) return { ok: true, status: r.status, ...(isObj(r.data) ? r.data : { data: r.data }) };
    if (r.status === 401) authFailed();
    else reportError({ message: `${what} failed: ${r.error}`, source: r.status ? 'http' : 'network', status: r.status });
    return { ok: false, status: r.status, error: r.error, ...(isObj(r.data) ? { data: r.data } : {}) };
  }

  const client = {
    /** Say something to the guide. The reply arrives as a `chat` event. → {ok, id} */
    send(text, brain) {
      const t = String(text ?? '').trim();
      if (!t) return Promise.resolve({ ok: false, status: 0, error: 'empty message' });
      const body = { text: t, from: fromValue() };
      if (brain) body.brain = brain;
      return post('/api/chat', body, 'Sending');
    },
    /** Direct manipulation (the user moved something). → {ok, world} */
    async op(op) {
      const r = await post('/api/op', op, 'Change');
      if (r.ok && isObj(r.world) && !(r.world.version < seenVersion)) setWorld(r.world);
      return r;
    },
    /** Set the server's default brain: 'ollama' | 'claude' | 'scripted'. → {ok, brain} */
    setBrain(brain) { return post('/api/brain', { brain }, 'Switching brain'); },
    /** Vibe mode: ask Claude Code to write/modify a creation. → {ok, id} */
    vibe(text) {
      const t = String(text ?? '').trim();
      if (!t) return Promise.resolve({ ok: false, status: 0, error: 'empty message' });
      return post('/api/vibe', { text: t, from: fromValue() }, 'Vibe request');
    },
    /** GET /api/creations → {ok, ...body} (an array body comes back as {ok, data:[...]}) */
    async creations() {
      const r = await apiRequest('GET', '/api/creations', { base });
      return r.ok ? { ok: true, ...(isObj(r.data) ? r.data : { data: r.data }) } : { ok: false, status: r.status, error: r.error };
    },
    /** Speech-to-text through the server's whisper proxy. blob: audio/webm or audio/mp4. → {ok, text} */
    async stt(blob, { signal, timeout = 30000 } = {}) {
      const type = (blob?.type || 'audio/webm').split(';')[0];
      const r = await apiRequest('POST', '/api/stt', { base, body: blob, headers: { 'content-type': type }, timeout, signal, retries: 0 });
      return r.ok ? { ok: true, text: (isObj(r.data) && typeof r.data.text === 'string') ? r.data.text : '' }
        : { ok: false, status: r.status, error: r.error };
    },
    /** GET /api/health (no token needed). → {ok, ...health} */
    async health() {
      const r = await apiRequest('GET', '/api/health', { base, auth: false, timeout: 6000 });
      return r.ok && isObj(r.data) ? { ...r.data, ok: r.data.ok !== false } : { ok: false, status: r.status, error: r.error };
    },
    /** The latest World this client knows (kept current from snapshots and ops), or null before the first snapshot. */
    world() { return world; },
    /** Refetch GET /api/world now; calls onSnapshot and resolves to the World (or null). */
    async refresh() {
      const r = await apiRequest('GET', '/api/world', { base });
      if (r.ok && setWorld(r.data)) { safe(cb.onSnapshot, r.data); return r.data; }
      if (r.status === 401) authFailed();
      return null;
    },
    /** Replace the token (e.g. pasted by the user) and reconnect. */
    setToken(t) { setToken(t); token = getToken(); reconnectNow(); },
    token() { return getToken(); },
    /** Who is talking: 'phone' | 'xr' | 'desktop' (or a function returning one). */
    setFrom(f) { from = f || defaultFrom; },
    reconnect: reconnectNow,
    get state() { return state; },
    get connected() { return state === 'open'; },
    get transport() { return usedTransport(); },
    close() {
      closed = true;
      clearTimeout(reconnectTimer);
      clearTimeout(resyncTimer);
      teardown();
      gen++;
      doc?.removeEventListener?.('visibilitychange', onVisibility);
      win?.removeEventListener?.('online', onOnline);
      win?.removeEventListener?.('pageshow', onPageShow);
      setState('closed');
    },
  };

  if (opts.autoConnect !== false) open();
  return client;
}

export default connect;

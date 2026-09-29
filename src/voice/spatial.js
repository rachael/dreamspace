// src/voice/spatial.js: Lumen's spatial voice. Server TTS (POST /api/tts, macOS `say`) played through WebAudio with a
// soft echo + shimmer, into an HRTF PannerNode that sits where the guide is, so in AirPods the voice comes from Lumen.
// Owner: client-voice. Contract: docs/CONTRACT.md, "Hackathon surface" → "Spatial voice (a)".
//
//   import { createSpatialVoice } from './voice/spatial.js';
//   const spatial = createSpatialVoice({ listenerFrom: camera, sourceFrom: guide.object3d }); // desktop / XR
//   const spatial = createSpatialVoice({ listenerFrom: null });                                // phone: no camera
//   spatial.unlock();                       // inside the first tap/click (iOS needs the AudioContext resumed there)
//   await spatial.speak('Over here!', { emotion: 'excited' });   // true when it played to the end
//   loop: spatial.update();                 // every frame: listener follows the camera, the panner follows the guide
//   phone: spatial.setSourcePosition(x, y, z) each frame (createGuideChoreo() below makes the orbit)
//   guide light: spatial.level()            // 0..1 loudness of what is playing right now (the analyser, smoothed)
//
// API: createSpatialVoice(opts) → {
//   supported            WebAudio + fetch exist here
//   enabled / setEnabled(on)   the "Spatial voice" toggle (remembered in localStorage). OFF by default (opt-in); Lumen's original browser voice is the default.
//   ready()              enabled, supported, and the server's /api/tts isn't known to be down → speak() will try it
//   speak(text, opts)    → Promise<boolean>: true = played to the end. false = didn't (fall back to speechSynthesis)
//   play(text|prepared, opts) → Promise<{ok, started, reason}>: reason 'played'|'cancelled'|'unavailable'|'error'|…
//   prepare(text, opts)  start fetching now (while something else is still talking); play(prepared) later
//   stop()               silence now, cancel pending fetches
//   setEmotion(e)        'calm'|'curious'|'excited'|'whisper' (+ aliases): echo, wet mix, brightness, shimmer
//   update()             per frame: listener pose from `listenerFrom` (a camera), source from `sourceFrom`
//   setSourcePosition(x,y,z), setListenerPose(pos, fwd, up)   manual positioning (phone)
//   level()              0..1, analyser amplitude (smoothed; 0 when silent)
//   analyser             the AnalyserNode (null until the first unlock/speak)
//   context(create)      the shared AudioContext (src/voice/index.js reuses it for the whisper mic meter)
//   setServerAvailable(bool|null)   from /api/health `tts` (null = unknown: just try)
//   onChange(fn)         fn({enabled, speaking, available, emotion, needsTap}) on any change; returns an unsubscribe
//   needsTap / unlocked  the audio is suspended (play() resolved 'locked': the browser voice spoke instead) / running
//   speaking, emotion, position ([x,y,z] of the source, listener-relative on the phone)
//   destroy()
// }
// Fallback is the caller's job: when speak() resolves false, say it with speechSynthesis (src/voice/index.js does).
// No top-level window/document access, so it imports in Node for tests.

import { authHeaders } from '../net/client.js';

const G = globalThis;
const PREF_KEY = 'dreamspace.spatial.v2'; // v2: opt-in; old 'on' prefs ignored so Lumen's original browser voice is back
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------------------------------------------
// Emotion → voice colour. wet: echo level, feedback: echo tail, delay: echo spacing (s), tone: echo lowpass (Hz),
// shimmer: a chorus on the airy top end (the "vocoder-ish" sheen), air: high-shelf dB, room: unpanned wash,
// dry: direct level. Tasteful on purpose: the echo is felt more than heard.
export const EMOTIONS = {
  calm:    { wet: 0.19, feedback: 0.30, delay: 0.19, tone: 3400, shimmer: 0.10, air: 0.0, room: 0.10, dry: 1.00 },
  curious: { wet: 0.23, feedback: 0.34, delay: 0.23, tone: 4600, shimmer: 0.16, air: 1.8, room: 0.12, dry: 1.00 },
  excited: { wet: 0.28, feedback: 0.40, delay: 0.14, tone: 7200, shimmer: 0.24, air: 4.5, room: 0.15, dry: 1.00 },
  whisper: { wet: 0.04, feedback: 0.08, delay: 0.08, tone: 2300, shimmer: 0.00, air: -1.5, room: 0.02, dry: 1.12 },
};
const ALIASES = {
  happy: 'excited', joy: 'excited', joyful: 'excited', playful: 'excited', thrilled: 'excited', delighted: 'excited', proud: 'excited',
  wonder: 'curious', wondering: 'curious', intrigued: 'curious', question: 'curious', mysterious: 'curious', thoughtful: 'curious',
  soft: 'whisper', quiet: 'whisper', hushed: 'whisper', secret: 'whisper', whispering: 'whisper', gentle: 'whisper', sleepy: 'whisper',
  neutral: 'calm', warm: 'calm', serene: 'calm', peaceful: 'calm',
};
export function normEmotion(e) {
  const k = String(e || '').toLowerCase().trim();
  if (EMOTIONS[k]) return k;
  return ALIASES[k] || 'calm';
}

// ---------------------------------------------------------------------------------------------------------------
// Text

export function cleanForVoice(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/\b([a-z0-9]+(?:-[a-z0-9]+)+)\.js\b/gi, (m, slug) => slug.replace(/-/g, ' '))
    .replace(/[*_`#>~|]+/g, ' ')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:…])/g, '$1')
    .trim()
    .slice(0, 900);
}

/** Sentence chunks: the first one short so the voice starts fast, the rest ≤ max, tiny fragments merged. */
export function splitSentences(text, max = 220) {
  const parts = String(text).match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [String(text)];
  const out = [];
  let cur = '';
  for (let s of parts) {
    s = s.trim();
    if (!s) continue;
    while (s.length > max) { // a run-on sentence: break at a comma or space
      let cut = Math.max(s.lastIndexOf(', ', max), s.lastIndexOf('; ', max));
      if (cut < max * 0.4) cut = s.lastIndexOf(' ', max);
      if (cut < max * 0.4) cut = max;
      if (cur) { out.push(cur); cur = ''; }
      out.push(s.slice(0, cut + 1).trim());
      s = s.slice(cut + 1).trim();
    }
    const limit = out.length ? max : 120;          // the first chunk stays short: the voice starts sooner
    if (!cur) cur = s;
    else if (cur.length < 25 || (cur + ' ' + s).length <= limit) cur += ' ' + s;
    else { out.push(cur); cur = s; }
  }
  if (cur) out.push(cur);
  return out.filter(Boolean);
}

function b64ToArrayBuffer(s) {
  const b64 = String(s).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (typeof G.atob === 'function') {
    const bin = G.atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  const buf = G.Buffer.from(b64, 'base64'); // Node (tests)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

// Endpoint missing or switched off: stop trying for a while and let speechSynthesis talk.
const DOWN_LONG = new Set([404, 405, 410, 501]);
const DOWN_SHORT = new Set([0, 502, 503, 504, 520, 521, 522, 523, 524, 530]);

// ---------------------------------------------------------------------------------------------------------------
// createSpatialVoice

export function createSpatialVoice(opts = {}) {
  const cfg = {
    listenerFrom: null, sourceFrom: null, audioContext: null,
    base: '', ttsUrl: '/api/tts', voice: null,
    enabled: undefined, persist: true,
    fetchTimeoutMs: 15000, downMs: 60000, downLongMs: 5 * 60000,
    refDistance: 1, rolloff: 0.7, masterGain: 1.3,
    ...opts,
  };
  const AC = G.AudioContext || G.webkitAudioContext;
  const supported = typeof AC === 'function' && typeof G.fetch === 'function';

  let enabled = supported && (cfg.enabled !== undefined ? !!cfg.enabled : readPref() === true); // off by default: Lumen's original browser speechSynthesis voice is the default
  let ctx = null;
  let graph = null;
  let emotion = 'calm';
  let serverKnown = null;     // from /api/health: true/false/null (unknown)
  let downUntil = 0;
  let job = null;             // the line playing now: {gen, sources:Set, abort(), resolve, started}
  let gen = 0;
  let destroyed = false;
  let speaking = false;
  let needsTap = false;       // a line hit a suspended context: a tap (unlock) is needed for the spatial voice
  const prepared = new Set();
  const listeners = new Set();
  const srcPos = [0, 1.5, -1.2];
  const lisPos = [0, 1.6, 0], lisFwd = [0, 0, -1], lisUp = [0, 1, 0];
  let lvl = 0, lvlAt = 0, lvlBuf = null;
  let lastError = null;

  function readPref() {
    try { const v = G.localStorage?.getItem(PREF_KEY); return v == null ? null : v === '1'; } catch { return null; }
  }
  function writePref(v) {
    if (!cfg.persist) return;
    try { G.localStorage?.setItem(PREF_KEY, v ? '1' : '0'); } catch { /* private mode */ }
  }
  function emit() {
    const s = { enabled, speaking, available: ready(), emotion, needsTap };
    for (const fn of listeners) { try { fn(s); } catch (err) { console.error('[spatial] listener error', err); } }
  }

  // ---- context + graph ----
  function context(create) {
    if (typeof cfg.audioContext === 'function') {
      try { const c = cfg.audioContext(create); if (c) return c; } catch { /* fall back to our own */ }
    }
    if (ctx && ctx.state !== 'closed') return ctx;
    if (!create || !supported) return null;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch { try { ctx = new AC(); } catch { ctx = null; } }
    return ctx;
  }

  function node(c, kind, props) {
    const n = c[kind]();
    for (const k in props || {}) {
      if (n[k] && typeof n[k] === 'object' && 'value' in n[k]) n[k].value = props[k];
      else n[k] = props[k];
    }
    return n;
  }

  function ensureGraph() {
    const c = context(true);
    if (!c) return null;
    if (graph && graph.ctx === c) return graph;
    const g = { ctx: c };
    const e = EMOTIONS[emotion];
    // voice in → analyser (for the guide's light) and a gentle clean-up (rumble off, a little air on top)
    g.input = node(c, 'createGain', { gain: 1 });
    g.analyser = node(c, 'createAnalyser', { fftSize: 512, smoothingTimeConstant: 0.15 });
    g.hp = node(c, 'createBiquadFilter', { type: 'highpass', frequency: 90, Q: 0.7 });
    g.air = node(c, 'createBiquadFilter', { type: 'highshelf', frequency: 3600, gain: e.air });
    g.input.connect(g.analyser);
    g.input.connect(g.hp);
    g.hp.connect(g.air);

    // where Lumen is
    g.panner = c.createPanner();
    g.panner.panningModel = 'HRTF';
    g.panner.distanceModel = 'inverse';
    g.panner.refDistance = cfg.refDistance;
    g.panner.rolloffFactor = cfg.rolloff;
    g.panner.maxDistance = 60;
    g.panner.coneInnerAngle = 360; g.panner.coneOuterAngle = 360; g.panner.coneOuterGain = 1;

    // direct voice
    g.dry = node(c, 'createGain', { gain: e.dry });
    g.air.connect(g.dry); g.dry.connect(g.panner);

    // shimmer: the airy top end through a slowly wobbling short delay (a chorus), mixed low
    g.shimHp = node(c, 'createBiquadFilter', { type: 'highpass', frequency: 1400, Q: 0.5 });
    g.chorus = c.createDelay(0.06); g.chorus.delayTime.value = 0.016;
    g.lfo = node(c, 'createOscillator', { type: 'sine', frequency: 0.7 });
    g.lfoDepth = node(c, 'createGain', { gain: 0.004 });
    g.shimmer = node(c, 'createGain', { gain: e.shimmer });
    g.lfo.connect(g.lfoDepth); g.lfoDepth.connect(g.chorus.delayTime);
    g.air.connect(g.shimHp); g.shimHp.connect(g.chorus); g.chorus.connect(g.shimmer); g.shimmer.connect(g.panner);
    try { g.lfo.start(); } catch { /* */ }

    // echo: a darkened feedback delay that travels with the voice, plus a faint unpanned wash around you
    g.delay = c.createDelay(1.2); g.delay.delayTime.value = e.delay;
    g.tone = node(c, 'createBiquadFilter', { type: 'lowpass', frequency: e.tone, Q: 0.4 });
    g.fb = node(c, 'createGain', { gain: e.feedback });
    g.wet = node(c, 'createGain', { gain: e.wet });
    g.room = node(c, 'createGain', { gain: e.room });
    g.air.connect(g.delay); g.delay.connect(g.tone); g.tone.connect(g.fb); g.fb.connect(g.delay);
    g.tone.connect(g.wet); g.wet.connect(g.panner);

    // out: a soft compressor keeps near/far and whisper/excited at a comfortable level
    g.master = node(c, 'createGain', { gain: cfg.masterGain });
    g.comp = c.createDynamicsCompressor();
    try {
      g.comp.threshold.value = -20; g.comp.knee.value = 14; g.comp.ratio.value = 3;
      g.comp.attack.value = 0.004; g.comp.release.value = 0.22;
    } catch { /* */ }
    g.panner.connect(g.master);
    g.tone.connect(g.room); g.room.connect(g.master);
    g.master.connect(g.comp); g.comp.connect(c.destination);

    lvlBuf = new Uint8Array(g.analyser.fftSize);
    graph = g;
    placeAll(true);
    return g;
  }

  // ---- positions ----
  function setP(param, v, now, snap) {
    if (!param) return false;
    if (snap || typeof param.setTargetAtTime !== 'function') param.value = v;
    else param.setTargetAtTime(v, now, 0.04);   // smooth: no zipper noise as Lumen moves
    return true;
  }
  const last = { s: [NaN, NaN, NaN], l: [NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN, NaN] };
  function changed(a, b, eps) {
    let d = false;
    for (let i = 0; i < b.length; i++) if (!(Math.abs(a[i] - b[i]) < eps)) { a[i] = b[i]; d = true; }
    return d;
  }
  const _l = new Array(9);
  function placeAll(snap = false) {
    const g = graph;
    if (!g) return;
    const c = g.ctx, now = c.currentTime;
    if (changed(last.s, srcPos, 5e-4) || snap) {
      const p = g.panner;
      if (!(setP(p.positionX, srcPos[0], now, snap) && setP(p.positionY, srcPos[1], now, snap) && setP(p.positionZ, srcPos[2], now, snap))) {
        try { p.setPosition(srcPos[0], srcPos[1], srcPos[2]); } catch { /* */ }
      }
    }
    _l[0] = lisPos[0]; _l[1] = lisPos[1]; _l[2] = lisPos[2];
    _l[3] = lisFwd[0]; _l[4] = lisFwd[1]; _l[5] = lisFwd[2];
    _l[6] = lisUp[0]; _l[7] = lisUp[1]; _l[8] = lisUp[2];
    if (changed(last.l, _l, 5e-4) || snap) {
      const L = c.listener;
      const okP = setP(L.positionX, lisPos[0], now, snap) && setP(L.positionY, lisPos[1], now, snap) && setP(L.positionZ, lisPos[2], now, snap);
      const okO = setP(L.forwardX, lisFwd[0], now, snap) && setP(L.forwardY, lisFwd[1], now, snap) && setP(L.forwardZ, lisFwd[2], now, snap)
        && setP(L.upX, lisUp[0], now, snap) && setP(L.upY, lisUp[1], now, snap) && setP(L.upZ, lisUp[2], now, snap);
      if (!okP) { try { L.setPosition(lisPos[0], lisPos[1], lisPos[2]); } catch { /* */ } }
      if (!okO) { try { L.setOrientation(lisFwd[0], lisFwd[1], lisFwd[2], lisUp[0], lisUp[1], lisUp[2]); } catch { /* */ } }
    }
  }

  function setSourcePosition(x, y, z) {
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) { srcPos[0] = x; srcPos[1] = y; srcPos[2] = z; }
  }
  function setListenerPose(pos, fwd, up) {
    if (pos && Number.isFinite(pos[0] + pos[1] + pos[2])) { lisPos[0] = pos[0]; lisPos[1] = pos[1]; lisPos[2] = pos[2]; }
    if (fwd && Number.isFinite(fwd[0] + fwd[1] + fwd[2])) { lisFwd[0] = fwd[0]; lisFwd[1] = fwd[1]; lisFwd[2] = fwd[2]; }
    if (up && Number.isFinite(up[0] + up[1] + up[2])) { lisUp[0] = up[0]; lisUp[1] = up[1]; lisUp[2] = up[2]; }
  }

  // Reads matrixWorld directly (no three import): position = column 3, forward = -column 2, up = column 1.
  function readListener(cam) {
    const e = cam?.matrixWorld?.elements;
    if (!e) return;
    const fx = -e[8], fy = -e[9], fz = -e[10];
    const fl = Math.hypot(fx, fy, fz), ul = Math.hypot(e[4], e[5], e[6]);
    if (!(fl > 1e-6 && ul > 1e-6)) return;
    setListenerPose([e[12], e[13], e[14]], [fx / fl, fy / fl, fz / fl], [e[4] / ul, e[5] / ul, e[6] / ul]);
  }
  const _tmp = [0, 0, 0];
  function readSource(src) {
    if (!src) return;
    if (typeof src === 'function') {
      const r = src(_tmp);
      const p = Array.isArray(r) ? r : (r && typeof r.x === 'number' ? [r.x, r.y, r.z] : _tmp);
      setSourcePosition(p[0], p[1], p[2]);
      return;
    }
    const e = src.matrixWorld?.elements;
    if (e) setSourcePosition(e[12], e[13], e[14]);
    else if (src.position) setSourcePosition(src.position.x, src.position.y, src.position.z);
  }

  function update() {
    if (destroyed) return;
    if (cfg.listenerFrom) readListener(cfg.listenerFrom);
    if (cfg.sourceFrom) readSource(cfg.sourceFrom);
    if (graph) placeAll(false);
  }

  // ---- emotion ----
  function setEmotion(e) {
    const k = normEmotion(e);
    if (k === emotion && graph) return emotion;
    emotion = k;
    const g = graph;
    if (g) {
      const p = EMOTIONS[k], now = g.ctx.currentTime;
      const to = (param, v, tau = 0.12) => { try { param.setTargetAtTime(v, now, tau); } catch { param.value = v; } };
      to(g.wet.gain, p.wet); to(g.fb.gain, p.feedback); to(g.delay.delayTime, p.delay, 0.25);
      to(g.tone.frequency, p.tone); to(g.shimmer.gain, p.shimmer); to(g.air.gain, p.air);
      to(g.room.gain, p.room); to(g.dry.gain, p.dry);
    }
    emit();
    return emotion;
  }

  // ---- level (for the guide's light) ----
  function level() {
    const g = graph;
    if (!g || !lvlBuf) return 0;
    const t = (G.performance?.now?.() ?? Date.now());
    if (t - lvlAt < 8) return lvl;
    const dt = Math.min(0.1, (t - lvlAt) / 1000 || 0.016);
    lvlAt = t;
    let target = 0;
    if (speaking) {
      g.analyser.getByteTimeDomainData(lvlBuf);
      let sum = 0;
      for (let i = 0; i < lvlBuf.length; i++) { const v = (lvlBuf[i] - 128) / 128; sum += v * v; }
      target = Math.min(1, Math.sqrt(sum / lvlBuf.length) * 4.2);
    }
    const tau = target > lvl ? 0.03 : 0.14;             // quick attack, soft release
    lvl += (target - lvl) * (1 - Math.exp(-dt / tau));
    if (lvl < 1e-3) lvl = 0;
    return lvl;
  }

  // ---- unlock (sync, inside the user's tap) ----
  function unlock() {
    if (!supported || destroyed) return;
    const c = context(true);
    if (!c) return;
    try { if (c.state !== 'running') { const p = c.resume(); if (p && p.catch) p.catch(() => {}); } } catch { /* */ }
    if (c.state === 'running' && needsTap) setNeedsTap(false);
    try { // iOS: a sound started inside the gesture unlocks output for good
      const b = c.createBuffer(1, 1, c.sampleRate || 44100);
      const s = c.createBufferSource(); s.buffer = b; s.connect(c.destination); s.start(0);
    } catch { /* */ }
    ensureGraph();
  }

  // ---- server TTS ----
  function ready() { return supported && enabled && !destroyed && serverKnown !== false && Date.now() >= downUntil; }

  function markDown(status) {
    const ms = DOWN_LONG.has(status) ? cfg.downLongMs : cfg.downMs;
    downUntil = Date.now() + ms;
    emit();
  }

  function decode(c, ab) {
    return new Promise((resolve, reject) => {
      let done = false;
      const ok = (b) => { if (!done) { done = true; resolve(b); } };
      const bad = (e) => { if (!done) { done = true; reject(e || new Error('decode failed')); } };
      try { const p = c.decodeAudioData(ab, ok, bad); if (p && typeof p.then === 'function') p.then(ok, bad); } catch (e) { bad(e); }
    });
  }

  async function fetchAudio(text, emo, signal) {
    const url = cfg.base + cfg.ttsUrl;
    const body = { text, emotion: emo };
    if (cfg.voice) body.voice = cfg.voice;
    let res;
    try {
      res = await G.fetch(url, {
        method: 'POST', cache: 'no-store', signal,
        headers: authHeaders({ 'content-type': 'application/json', accept: 'audio/*, application/json' }),
        body: JSON.stringify(body),
      });
    } catch (err) {
      const e = new Error(signal?.aborted ? 'aborted' : (err?.message || 'network error'));
      e.status = 0; e.aborted = !!signal?.aborted;
      throw e;
    }
    if (!res.ok) { const e = new Error(`tts HTTP ${res.status}`); e.status = res.status; throw e; }
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('json')) {
      const j = await res.json();
      const b64 = j && (j.audio || j.base64 || (typeof j.data === 'string' ? j.data : null));
      if (typeof b64 === 'string' && b64.length > 16) return b64ToArrayBuffer(b64);
      const u = j && (j.url || j.audioUrl || j.src);
      if (typeof u === 'string') {
        const ab = await fetchUrl(u, signal);
        if (typeof j.wav === 'string' && j.wav !== u) ab.alt = j.wav; // server's .wav twin, if AAC won't decode here
        return ab;
      }
      const e = new Error('tts: no audio in the reply'); e.status = 500; throw e;
    }
    return res.arrayBuffer();
  }

  async function fetchUrl(u, signal) {
    const abs = /^(https?:|blob:|data:)/.test(u) ? u : cfg.base + (u.startsWith('/') ? u : '/' + u);
    if (abs.startsWith('data:')) return b64ToArrayBuffer(abs);
    const r2 = await G.fetch(abs, { cache: 'no-store', signal, headers: authHeaders({}) });
    if (!r2.ok) { const e = new Error(`tts audio HTTP ${r2.status}`); e.status = r2.status === 404 ? 500 : r2.status; throw e; }
    return r2.arrayBuffer();
  }

  async function fetchAndDecode(c, text, emo, signal) {
    const ab = await fetchAudio(text, emo, signal);
    const alt = ab.alt;
    try { return await decode(c, ab); } catch (err) {
      if (!alt) throw err;
      return decode(c, await fetchUrl(alt, signal));
    }
  }

  /** Start fetching + decoding a line now. Returns a handle for play(). */
  function prepare(text, o = {}) {
    const clean = cleanForVoice(text);
    const emo = normEmotion(o.emotion || emotion);
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const h = { prepared: true, text: clean, emotion: emo, chunks: splitSentences(clean), ctl, clips: [], cancelled: false };
    const timer = setTimeout(() => { try { ctl?.abort(); } catch { /* */ } }, cfg.fetchTimeoutMs + 5000);
    h.cancel = () => { h.cancelled = true; clearTimeout(timer); try { ctl?.abort(); } catch { /* */ } prepared.delete(h); };
    if (!clean || !ready()) { h.clips = []; return h; }
    const c = context(true);
    if (!c) return h;
    // Fetch with a little concurrency (2 at a time), keep order; each clip resolves to an AudioBuffer or rejects.
    let chain = Promise.resolve();
    let chain2 = Promise.resolve();
    h.clips = h.chunks.map((chunk, i) => {
      const run = () => fetchAndDecode(c, chunk, emo, ctl?.signal);
      const p = (i % 2 === 0 ? chain : chain2).then(run, run);
      if (i % 2 === 0) chain = p.catch(() => {}); else chain2 = p.catch(() => {});
      p.catch(() => {}); // handled by play(); never an unhandled rejection
      return p;
    });
    Promise.allSettled(h.clips).then(() => { clearTimeout(timer); prepared.delete(h); });
    prepared.add(h);
    return h;
  }

  function stopJob(reason = 'cancelled') {
    const j = job;
    if (!j) return;
    job = null;
    for (const s of j.sources) { try { s.onended = null; s.stop(); } catch { /* */ } try { s.disconnect(); } catch { /* */ } }
    j.sources.clear();
    clearTimeout(j.safety);
    try { j.handle?.cancel(); } catch { /* */ }
    setSpeaking(false);
    j.resolve({ ok: false, started: j.started, reason });
  }

  function setSpeaking(on) {
    if (speaking === on) return;
    speaking = on;
    emit();
  }

  /** Play a line (text, or a handle from prepare()). Resolves {ok, started, reason}; never rejects. */
  function play(input, o = {}) {
    return new Promise((resolve) => {
      if (destroyed) { resolve({ ok: false, started: false, reason: 'destroyed' }); return; }
      if (!supported) { resolve({ ok: false, started: false, reason: 'unsupported' }); return; }
      if (!enabled) { if (input?.prepared) input.cancel(); resolve({ ok: false, started: false, reason: 'disabled' }); return; }
      if (!ready()) { if (input?.prepared) input.cancel(); resolve({ ok: false, started: false, reason: 'unavailable' }); return; }
      const h = input && input.prepared ? input : prepare(input, o);
      if (!h.text) { resolve({ ok: false, started: false, reason: 'empty' }); return; }
      if (h.cancelled || !h.clips.length) { resolve({ ok: false, started: false, reason: 'unavailable' }); return; }
      const g = ensureGraph();
      const c = g && g.ctx;
      if (!c) { h.cancel(); resolve({ ok: false, started: false, reason: 'unsupported' }); return; }
      // A suspended context (no tap yet, or iOS after another app took the audio) would "play" silence and never
      // end. Try to resume; if it won't run, say so ('locked') so the caller uses the browser voice instead.
      whenRunning(c, 300).then((running) => {
        if (destroyed) { h.cancel(); resolve({ ok: false, started: false, reason: 'destroyed' }); return; }
        if (h.cancelled) { resolve({ ok: false, started: false, reason: 'cancelled' }); return; }   // stop() meanwhile
        if (!running) { h.cancel(); setNeedsTap(true); resolve({ ok: false, started: false, reason: 'locked' }); return; }
        setNeedsTap(false);
        start(h, g, c, o, resolve);
      });
    });
  }

  function whenRunning(c, ms) {
    if (c.state === 'running') return Promise.resolve(true);
    try { const p = c.resume(); if (p && p.catch) p.catch(() => {}); } catch { /* */ }
    return new Promise((res) => {
      const t0 = Date.now();
      (function poll() {
        if (c.state === 'running') { res(true); return; }
        if (Date.now() - t0 >= ms) { res(false); return; }
        setTimeout(poll, 25);
      })();
    });
  }

  function setNeedsTap(v) { if (needsTap !== v) { needsTap = v; emit(); } }

  function start(h, g, c, o, resolve) {
    {
      stopJob('cancelled'); // one line at a time: callers queue
      const my = ++gen;
      const j = { gen: my, sources: new Set(), started: false, handle: h, resolve, safety: null, endAt: 0 };
      job = j;
      setEmotion(h.emotion);
      const lead = Math.max(0, Number(o.leadInMs) || 0) / 1000;
      let t = 0;
      let remaining = h.clips.length;
      let failedErr = null;
      const finish = (res) => {
        if (job !== j) return;
        job = null;
        clearTimeout(j.safety);
        setSpeaking(false);
        resolve(res);
      };
      const armSafety = () => {
        clearTimeout(j.safety);
        const left = Math.max(0, j.endAt - c.currentTime);
        // If 'ended' never fires (iOS interruption, context suspended), don't hang the conversation.
        j.safety = setTimeout(() => finish({ ok: j.started, started: j.started, reason: j.started ? 'played' : 'error' }), left * 1000 + 2500);
      };
      armSafety();
      // Each clip is scheduled the moment it's decoded, back to back, so sentences flow without gaps.
      let next = 0;
      const pump = () => {
        if (job !== j) return;
        if (next >= h.clips.length) return;
        const i = next++;
        h.clips[i].then((buf) => {
          if (job !== j) return;
          if (c.state === 'closed') throw new Error('audio closed');
          const s = c.createBufferSource();
          s.buffer = buf;
          s.connect(g.input);
          const now = c.currentTime;
          if (!t) t = now + lead + 0.03;
          const at = Math.max(t, now + 0.02);
          s.start(at);
          t = at + buf.duration + 0.04;
          j.endAt = t;
          j.sources.add(s);
          if (!j.started) { j.started = true; setSpeaking(true); }
          armSafety();
          remaining--;
          const isLast = remaining === 0;
          s.onended = () => {
            j.sources.delete(s);
            if (isLast && job === j) finish({ ok: !failedErr, started: true, reason: failedErr ? 'error' : 'played' });
          };
          pump();
        }).catch((err) => {
          if (job !== j) return;
          lastError = err;
          const status = typeof err?.status === 'number' ? err.status : 0;
          if (!err?.aborted && (DOWN_LONG.has(status) || DOWN_SHORT.has(status))) markDown(status);
          if (!err?.aborted) console.warn('[spatial] server voice failed:', err?.message || err);
          // Nothing played yet: let the caller fall back to the browser voice for the whole line.
          if (!j.started) { h.cancel(); finish({ ok: false, started: false, reason: DOWN_LONG.has(status) || DOWN_SHORT.has(status) ? 'unavailable' : 'error' }); return; }
          // Mid-line: end after what's already playing (the rest of the line is dropped rather than switching voices).
          failedErr = err;
          h.cancel();
          remaining = 0;
          if (!j.sources.size) finish({ ok: false, started: true, reason: 'error' });
          else { const lastSrc = [...j.sources].pop(); lastSrc.onended = () => { j.sources.delete(lastSrc); finish({ ok: false, started: true, reason: 'error' }); }; }
        });
      };
      pump();
    }
  }

  function speak(text, o = {}) { return play(text, o).then((r) => !!r.ok); }

  function stop() {
    for (const h of [...prepared]) h.cancel();
    stopJob('cancelled');
  }

  function setEnabled(on) {
    on = !!on && supported;
    if (on === enabled) return enabled;
    enabled = on;
    writePref(on);
    if (!on) stop();
    emit();
    return enabled;
  }

  function setServerAvailable(v) {
    const next = v === true ? true : v === false ? false : null;
    if (next === serverKnown) return;
    serverKnown = next;
    if (next === true) downUntil = 0;
    emit();
  }

  function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  function destroy() {
    stop();
    destroyed = true;
    listeners.clear();
    try { graph?.lfo?.stop(); } catch { /* */ }
    graph = null;
    if (ctx && typeof cfg.audioContext !== 'function') { try { ctx.close(); } catch { /* */ } }
  }

  return {
    supported,
    get enabled() { return enabled; },
    setEnabled, ready, speak, play, prepare, stop, setEmotion, update, level,
    setSourcePosition, setListenerPose, setServerAvailable, onChange, unlock, context, destroy,
    get analyser() { return graph ? graph.analyser : null; },
    get speaking() { return speaking; },
    get emotion() { return emotion; },
    /** true after a line couldn't play because the audio is suspended: a tap (unlock()) brings it back */
    get needsTap() { return needsTap; },
    /** true when the audio context is running (or doesn't exist yet and nothing has tried) */
    get unlocked() { const c = context(false); return !!c && c.state === 'running'; },
    get position() { return srcPos.slice(); },
    get lastError() { return lastError; },
    get serverDown() { return serverKnown === false || Date.now() < downUntil; },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Phone choreography: there's no camera on the phone, so the listener sits at the origin facing -Z (your nose) and
// Lumen moves around you. Default: a slow orbit (faster and closer while talking) so AirPods clearly hear it travel.
// Patterns from `move_guide` change the path; a target places Lumen on the bearing of a real world object.
// Angles: 0 = straight ahead, + = to your left (same convention as src/world/guide.js).

export const PHONE_PATTERNS = ['orbit', 'circle', 'circle-target', 'orbit-user', 'follow', 'wander', 'come-close', 'target'];

export function createGuideChoreo({ maxSpeed = 1.6 } = {}) {
  let mode = 'orbit';
  let t = 0, modeT = 0, until = Infinity;
  let ang = 0.7;                           // front-left to begin with
  let emotion = 'calm';
  let talk = 0;
  const target = [0, 0, -2];
  const pos = [-Math.sin(0.7) * 1.5, 0.1, -Math.cos(0.7) * 1.5];
  const vel = [0, 0, 0];
  const goal = [0, 0, 0];

  // Patterns persist until the next one (the server keeps the guide state). With a target, 'circle' loops around it
  // and anything else hovers on its bearing.
  function setPattern(p, o = {}) {
    const k = String(p || '').toLowerCase().trim();
    modeT = 0; until = o.holdSec ?? Infinity;
    const v = o.target;
    if (Array.isArray(v) && v.length >= 3 && v.every(Number.isFinite)) {
      // Keep it audible and meaningful: the object's bearing, at a comfortable 1–4 m.
      const d = Math.hypot(v[0], v[2]) || 1;
      const r = Math.min(4, Math.max(1.1, d));
      target[0] = (v[0] / d) * r; target[2] = (v[2] / d) * r;
      target[1] = Math.max(-0.4, Math.min(1.2, v[1] * 0.35));
      if (k === 'circle') { mode = 'circle-target'; ang = Math.atan2(-(pos[0] - target[0]), -(pos[2] - target[2])); }
      else mode = 'target';
      return mode;
    }
    if (k === 'target') return mode;                     // a target with no position: stay on the current path
    if (k === 'circle') mode = 'circle';
    else if (k === 'orbit-user') mode = 'orbit-user';
    else if (k === 'wander') mode = 'wander';
    else if (k === 'come-close' || k === 'close') mode = 'come-close';
    else if (k === 'follow') mode = 'follow';
    else mode = 'orbit';
    return mode;
  }

  function setEmotion(e) { emotion = normEmotion(e); }

  function computeGoal(dt, speaking) {
    const excited = emotion === 'excited', whisper = emotion === 'whisper';
    talk += ((speaking ? 1 : 0) - talk) * (1 - Math.exp(-dt / 0.6));
    const spin = excited ? 1.6 : whisper ? 0.55 : 1;
    const bob = 0.08 * Math.sin(t * 0.9);
    switch (mode) {
      case 'circle': {
        ang += dt * (TAU / 9) * spin;
        const r = 1.7;
        goal[0] = -Math.sin(ang) * r; goal[1] = 0.1 + bob; goal[2] = -Math.cos(ang) * r;
        break;
      }
      case 'orbit-user': {
        ang += dt * (TAU / 13) * spin;
        const r = 2.3 + 0.3 * Math.sin(t * 0.37);
        goal[0] = -Math.sin(ang) * r; goal[1] = 0.2 + 0.35 * Math.sin(t * 0.45); goal[2] = -Math.cos(ang) * r;
        break;
      }
      case 'wander': {
        const a = 0.6 + 1.4 * Math.sin(t * 0.13) + 0.8 * Math.sin(t * 0.29 + 1.3);
        const r = 2.2 + 1.0 * Math.sin(t * 0.17 + 0.4);
        ang = a;
        goal[0] = -Math.sin(a) * r; goal[1] = 0.15 + 0.2 * Math.sin(t * 0.31); goal[2] = -Math.cos(a) * r;
        break;
      }
      case 'come-close': {
        // right beside your left ear, swaying a little
        ang = 1.35 + 0.35 * Math.sin(t * 0.6);
        const r = 0.45;
        goal[0] = -Math.sin(ang) * r; goal[1] = 0.05 + 0.03 * Math.sin(t * 1.1); goal[2] = -Math.cos(ang) * r;
        break;
      }
      case 'follow': {
        ang = 0.6 + 0.25 * Math.sin(t * 0.4) * talk;
        const r = 1.1;
        goal[0] = -Math.sin(ang) * r; goal[1] = 0.05 + bob * 0.5; goal[2] = -Math.cos(ang) * r;
        break;
      }
      case 'circle-target': { // a slow loop around the thing it was sent to
        ang += dt * (TAU / 11) * spin;
        const r = 0.8;
        goal[0] = target[0] - Math.sin(ang) * r; goal[1] = target[1] + bob; goal[2] = target[2] - Math.cos(ang) * r;
        break;
      }
      case 'target': {
        goal[0] = target[0] + 0.15 * Math.sin(t * 0.7) * talk;
        goal[1] = target[1] + bob;
        goal[2] = target[2] + 0.15 * Math.cos(t * 0.53) * talk;
        ang = Math.atan2(-target[0], -target[2]);
        break;
      }
      default: { // 'orbit': drifting slowly when quiet, a clear slow orbit while talking
        const period = whisper ? 22 : excited ? 8 : 15;
        ang += dt * (TAU / period) * (0.25 + 0.75 * talk);
        const r = whisper ? 0.5 : 1.6 + 0.2 * Math.sin(t * 0.3);
        goal[0] = -Math.sin(ang) * r; goal[1] = 0.1 + bob; goal[2] = -Math.cos(ang) * r;
      }
    }
    if (whisper && mode !== 'come-close') { // whispering: come in close, whatever the path
      const d = Math.hypot(goal[0], goal[2]) || 1;
      const r = 0.55;
      goal[0] = (goal[0] / d) * r; goal[2] = (goal[2] / d) * r; goal[1] = 0.05;
    }
    if (ang > TAU * 4 || ang < -TAU * 4) ang %= TAU;
  }

  /** Advance dt seconds. speaking: Lumen's voice is playing. Returns [x,y,z] listener-relative (metres). */
  function step(dt, speaking = false) {
    dt = Number.isFinite(dt) ? Math.min(0.1, Math.max(0, dt)) : 0;
    t += dt; modeT += dt;
    if (modeT > until && mode !== 'orbit') { mode = 'orbit'; until = Infinity; modeT = 0; }
    computeGoal(dt, speaking);
    // Critically damped follow with a speed cap: smooth, never a jump, never faster than maxSpeed.
    const omega = 2 / 0.45, x = omega * dt, e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const nx = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const c = pos[i] - goal[i], tmp = (vel[i] + omega * c) * dt;
      vel[i] = (vel[i] - omega * tmp) * e;
      nx[i] = goal[i] + (c + tmp) * e;
    }
    const dx = nx[0] - pos[0], dy = nx[1] - pos[1], dz = nx[2] - pos[2];
    const dist = Math.hypot(dx, dy, dz), cap = maxSpeed * dt;
    const k = dist > cap && dist > 0 ? cap / dist : 1;
    pos[0] += dx * k; pos[1] += dy * k; pos[2] += dz * k;
    if (k < 1) for (let i = 0; i < 3; i++) vel[i] *= k;
    // never inside your head
    const hd = Math.hypot(pos[0], pos[2]);
    if (hd < 0.35) { const s = 0.35 / (hd || 1); pos[0] = (pos[0] || 0.35) * s; pos[2] *= s; }
    return pos;
  }

  return {
    setPattern, setEmotion, step,
    get mode() { return mode; },
    get position() { return pos; },
    /** Bearing of Lumen in radians (0 ahead, + left) and distance, for a radar. */
    get polar() { return { angle: Math.atan2(-pos[0], -pos[2]), dist: Math.hypot(pos[0], pos[2]), y: pos[1] }; },
  };
}

export default createSpatialVoice;

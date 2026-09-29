// src/voice/index.js — Dreamspace voice: speech-to-text (web-speech | whisper), text-to-speech, hands-free loop.
// Owner: client-io. Contract: docs/CONTRACT.md ("Client modules" → src/voice/index.js).
//
//   import { createVoice } from '../src/voice/index.js';
//   const voice = createVoice({
//     onFinal:   (text) => net.send(text),       // one finished utterance (already cleaned; echoes of the guide dropped)
//     onInterim: (text) => showLive(text),       // live partial transcript (web-speech only)
//     onState:   (state, detail) => paint(state),// 'idle'|'listening'|'hearing'|'transcribing'|'speaking'|'paused'|'error'
//     onLevel:   (v) => meter(v),                // optional, 0..1 mic level (whisper provider)
//     handsFree: true,                           // keep listening after each utterance (default false = one utterance per start)
//     onError:   (e) => toast(e.message),        // {error, message, recovered?}; 'echo-dropped' (recovered, with .text) = a
//                                                // transcript was discarded as the guide's own voice, so say so in the UI
//     ignoreHiddenWhile: () => renderer.xr.isPresenting, // optional: keep the mic when the page reports 'hidden' in VR
//   });
//   micButton.onclick = () => voice.start();     // MUST be called from a tap/click (iOS unlocks audio + mic here)
//   net → onChat: (m) => m.role === 'guide' && voice.speak(m.text);  // listening pauses while it talks
//
// Rules (from the voice-web research):
// - start() does the iOS unlock synchronously, before any await: a silent speechSynthesis.speak() and AudioContext resume.
// - Recognition/recording pauses while speaking (no self-hearing), resumes ~0.4 s after. A transcript is dropped as an
//   echo only if it is 4+ words, mostly one in-order stretch of the guide's last line, and (when known) began within
//   echoTailMs (1.5 s) of that line ending. Short replies ("a crystal", "yes please") always go through.
// - Providers: 'web-speech' (SpeechRecognition, continuous=false + restart: iOS Safari tab, desktop/Android Chrome) and
//   'whisper' (MediaRecorder → POST /api/stt, level-based voice detection: Quest, iOS home-screen app, Firefox).
//   A web-speech service error (Siri off, network) falls back to whisper, and a whisper 503 falls back to web-speech.
// - Timers use setInterval/setTimeout, never requestAnimationFrame (window rAF stops inside an immersive XR session).
// - Always keep a text fallback in the UI: check voice.supported.stt.
// No top-level window/document access, so the module also imports in Node for tests.

import { apiRequest } from '../net/client.js';

const G = globalThis;
const TICK = 40; // ms between voice-activity checks

// ---------------------------------------------------------------------------------------------------------------
// Environment + provider choice

export function detectVoiceEnv(g = G) {
  const nav = g.navigator || {};
  const ua = String(nav.userAgent || '');
  const isIOS = /iPhone|iPad|iPod/i.test(ua) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
  let standalone = nav.standalone === true;
  try { standalone = standalone || !!g.matchMedia?.('(display-mode: standalone)')?.matches; } catch { /* old browser */ }
  const isHeadset = /OculusBrowser|Quest|PicoBrowser|Pico\s?\d|PICO/i.test(ua);
  const SR = g.SpeechRecognition || g.webkitSpeechRecognition;
  const AC = g.AudioContext || g.webkitAudioContext;
  const hasMic = !!nav.mediaDevices?.getUserMedia;
  return {
    ua, isIOS, standalone, isHeadset,
    hasSR: typeof SR === 'function',
    hasRecorder: hasMic && typeof g.MediaRecorder === 'function' && typeof AC === 'function',
    hasTTS: !!g.speechSynthesis && typeof g.SpeechSynthesisUtterance === 'function',
  };
}

/** 'web-speech' | 'whisper' | 'none'. whisperUp: true/false from /api/health, or null if unknown. */
export function chooseProvider(env, { whisperUp = null } = {}) {
  // Quest/PICO expose SpeechRecognition but it has no backend; iOS home-screen apps break it.
  const srGood = env.hasSR && !env.isHeadset && !(env.isIOS && env.standalone);
  if (srGood) return 'web-speech';
  if (env.hasRecorder && whisperUp !== false) return 'whisper';
  if (env.hasSR && !env.isHeadset) return 'web-speech'; // unreliable here, but better than nothing
  if (env.hasRecorder) return 'whisper';
  return 'none';
}

export function pickRecorderMime(g = G) {
  const MR = g.MediaRecorder;
  if (!MR || typeof MR.isTypeSupported !== 'function') return '';
  for (const t of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus']) {
    try { if (MR.isTypeSupported(t)) return t; } catch { /* keep looking */ }
  }
  return '';
}

// ---------------------------------------------------------------------------------------------------------------
// Text helpers

/** Whisper/recognizer output → what the user said. '[BLANK_AUDIO]', '(wind)', '♪' and filler hallucinations → ''. */
export function cleanTranscript(text) {
  let s = String(text ?? '')
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^[\s.,!?;:'"…-]*$/.test(s)) return '';
  if (/^(you|thanks? (you )?for watching[.!]*|please subscribe[.!]*)\.?$/i.test(s)) return ''; // classic whisper-on-noise lines
  return s;
}

/** Guide reply → something pleasant to hear: no markdown, links, or emoji. */
export function cleanForSpeech(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/[*_`#>~|]+/g, ' ')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:…])/g, '$1')
    .trim();
}

/** Split into sentence-ish chunks ≤ max chars (Chrome cuts utterances off after ~15 s; short ones also start faster). */
export function splitForSpeech(text, max = 180) {
  const out = [];
  const sentences = String(text).match(/[^.!?…]+[.!?…]+["')\]]*\s*|[^.!?…]+$/g) || [String(text)];
  let cur = '';
  const push = (s) => { s = s.trim(); if (s) out.push(s); };
  for (const s of sentences) {
    if ((cur + s).length <= max) { cur += s; continue; }
    push(cur); cur = '';
    if (s.length <= max) { cur = s; continue; }
    let rest = s; // a very long sentence: break at commas, then spaces
    while (rest.length > max) {
      let cut = Math.max(rest.lastIndexOf(', ', max), rest.lastIndexOf('; ', max));
      if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
      if (cut < max * 0.4) cut = max;
      push(rest.slice(0, cut + 1)); rest = rest.slice(cut + 1);
    }
    cur = rest;
  }
  push(cur);
  return out;
}

function words(s) {
  return String(s).toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, ' ').split(/\s+/).filter(Boolean);
}
/** Share of the heard words that were in what the guide just said (1 = pure echo). */
export function echoScore(heard, spoken) {
  const h = words(heard);
  const sp = new Set(words(spoken));
  if (!h.length || !sp.size) return 0;
  let hit = 0;
  for (const w of h) if (sp.has(w)) hit++;
  return hit / h.length;
}

/** Longest run of consecutive heard words that appears, in the same order, inside the spoken line. */
function longestRun(hw, sw) {
  let best = 0;
  for (let i = 0; i < hw.length; i++) {
    for (let j = 0; j < sw.length; j++) {
      let k = 0;
      while (i + k < hw.length && j + k < sw.length && hw[i + k] === sw[j + k]) k++;
      if (k > best) best = k;
    }
  }
  return best;
}

/** Is `heard` the mic picking up the guide's own line `entry` ({text, endedAt})? Deliberately conservative:
 *  answers usually reuse the guide's words ("a crystal" after "a crystal or a portal?"), so short replies are never
 *  echoes, a long in-order stretch of the line must match, and when the speech onset time is known it must fall
 *  within `tailMs` of the line ending (capture is paused while the guide talks, so real echo can only be reverb). */
export function isEcho(heard, entry, { onsetAt = null, tailMs = 1500 } = {}) {
  const hw = words(heard);
  if (hw.length <= 3 || !entry?.text) return false;
  const run = longestRun(hw, words(entry.text));
  if (run < 4 || run < 0.8 * hw.length) return false;
  if (typeof onsetAt === 'number' && typeof entry.endedAt === 'number' && onsetAt > entry.endedAt + tailMs) return false;
  return true;
}

const PREFERRED_VOICES = [/samantha/i, /\bava\b/i, /\bzoe\b/i, /\bevan\b/i, /allison/i, /susan/i, /google us english/i, /\baria\b/i, /jenny/i, /natural/i];
const NOVELTY_VOICES = /albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|kathy|grandma|grandpa|rocko|shelley|\bflo\b|eddy|reed|sandy/i;

export function pickVoice(voices, { lang = 'en-US', prefer = null } = {}) {
  const list = Array.from(voices || []);
  if (!list.length) return null;
  if (prefer) {
    const p = String(prefer).toLowerCase();
    const v = list.find((x) => x.name.toLowerCase() === p) || list.find((x) => x.name.toLowerCase().includes(p));
    if (v) return v;
  }
  const want = lang.toLowerCase().replace('_', '-');
  const base = want.split('-')[0];
  let best = null;
  let bestScore = -Infinity;
  for (const v of list) {
    const vl = String(v.lang || '').toLowerCase().replace('_', '-');
    if (!vl.startsWith(base)) continue;
    let s = vl === want ? 20 : 0;
    if (/premium/i.test(v.name)) s += 40; else if (/enhanced/i.test(v.name)) s += 30;
    const i = PREFERRED_VOICES.findIndex((re) => re.test(v.name));
    if (i >= 0) s += 25 - i;
    if (NOVELTY_VOICES.test(v.name)) s -= 60;
    if (v.default) s += 2;
    if (s > bestScore) { best = v; bestScore = s; }
  }
  return best || list.find((v) => v.default) || null;
}

function levelOf(rms) { // -60 dBFS → 0, -10 dBFS → 1
  if (rms <= 0) return 0;
  return Math.max(0, Math.min(1, (20 * Math.log10(rms) + 60) / 50));
}

const MESSAGES = {
  'not-allowed': 'Microphone access was blocked. Allow it for this site, or type instead.',
  'service-not-allowed': 'On-device recognition is off (Siri & Dictation); switching to the server.',
  'audio-capture': "Couldn't open the microphone.",
  network: 'Speech recognition needs the network; switching to the server.',
  'language-not-supported': 'That language is not supported here; switching to the server.',
  'stt-unavailable': "The speech server isn't running. You can still type.",
  'stt-failed': "Couldn't transcribe that. Please say it again.",
  unauthorized: 'The world token was refused.',
  'needs-gesture': 'Tap to let me listen again.',
  'mic-silent': "The microphone isn't sending sound. Tap to retry, or type.",
  unsupported: 'Voice input is not available in this browser. You can type instead.',
  'echo-dropped': 'I think I heard my own voice there. Say that again?',
};
const SWITCH_TO_WHISPER = new Set(['service-not-allowed', 'network', 'language-not-supported']);

// ---------------------------------------------------------------------------------------------------------------
// createVoice

export function createVoice(opts = {}) {
  const cfg = {
    provider: 'auto', handsFree: false, lang: 'en-US',
    base: '', sttUrl: '/api/stt', stt: null, checkHealth: true,
    rate: 0.95, pitch: 1.0, volume: 1, voice: null,
    silenceMs: 800, startMs: 120, minSpeechMs: 250, maxUtteranceMs: 15000, noSpeechTimeoutMs: 8000,
    minRms: 0.008, startRatio: 3.0, endRatio: 2.0, recycleMs: 6000,
    restartDelayMs: 300, tailMs: 400, maxDeferMs: 5000, echoWindowMs: 8000, echoTailMs: 1500,
    ignoreHiddenWhile: null,
    releaseMicAfterMs: 30000, releaseMicWhileSpeaking: false,
    ...opts,
  };
  const env = detectVoiceEnv();
  const synth = env.hasTTS ? G.speechSynthesis : null;
  const Utterance = G.SpeechSynthesisUtterance;

  // ---- state ----
  let handsFree = !!cfg.handsFree;
  let want = false;          // the user asked to listen (start() … stop())
  let listening = false;     // a provider is capturing right now
  let hearing = false;       // speech detected in the current utterance
  let transcribing = 0;      // whisper uploads in flight
  let speaking = false;      // TTS queue active (capture paused)
  let paused = null;         // null | 'hidden' | 'needs-gesture'
  let failed = null;         // {error, message} after a fatal error, until the next start()
  let lastState = '';
  let listenTimer = null;
  let emptyStreak = 0;
  let autoSwitches = 0;
  let warmedUp = false;
  let retryPending = false;  // an iOS permission warm-up retry is on its way
  let whisperUp = null;
  let ac = null;             // AudioContext (whisper voice detection)
  let ttsUnlocked = false;
  let destroyed = false;
  const spoken = [];         // [{text, endedAt, until}] recent guide lines, for echo filtering

  let providerName = cfg.provider === 'auto' || !cfg.provider ? chooseProvider(env) : cfg.provider;
  if (providerName === 'web-speech' && !env.hasSR) providerName = chooseProvider(env);
  if (providerName === 'whisper' && !env.hasRecorder) providerName = chooseProvider(env);
  let provider = null;

  const supported = {
    get stt() { return providerName !== 'none'; },
    tts: env.hasTTS,
    webSpeech: env.hasSR && !env.isHeadset,
    whisper: env.hasRecorder,
  };

  function safe(fn, ...args) {
    if (typeof fn !== 'function') return;
    try { fn(...args); } catch (err) { console.error('[voice] callback error', err); }
  }

  function computeState() {
    if (speaking) return 'speaking';
    if (paused) return 'paused';
    if (hearing) return 'hearing';
    if (transcribing > 0) return 'transcribing';
    if (listening || (want && !failed)) return 'listening';
    if (failed) return 'error';
    return 'idle';
  }
  function refresh(force = false) {
    const s = computeState();
    const key = s + '|' + providerName + '|' + (paused || '') + '|' + (failed?.error || '') + '|' + handsFree;
    if (!force && key === lastState) return;
    lastState = key;
    safe(cfg.onState, s, {
      provider: providerName, handsFree, listening, speaking,
      needsGesture: paused === 'needs-gesture', error: failed?.error || null, message: failed?.message || null,
    });
  }

  // ---- audio unlock (sync, inside the user's tap) ----
  function audioContext(create) {
    if (ac && ac.state !== 'closed') return ac;
    if (!create) return null;
    const AC = G.AudioContext || G.webkitAudioContext;
    if (typeof AC !== 'function') return null;
    try { ac = new AC(); } catch { ac = null; }
    return ac;
  }
  function unlock() {
    if (synth && !ttsUnlocked && typeof Utterance === 'function') {
      try {
        const u = new Utterance(' ');
        u.volume = 0;
        synth.speak(u); // iOS: the first speak() must happen inside a tap, before any await
        ttsUnlocked = true;
      } catch { /* try again next tap */ }
    }
    if (env.hasRecorder) {
      const ctx = audioContext(true);
      if (ctx && ctx.state !== 'running') { try { ctx.resume().catch(() => {}); } catch { /* old Safari */ } }
    }
  }

  // ---- provider hooks ----
  // Each provider gets its own hooks; once it has been switched away from, it can still deliver a finished transcript
  // and settle its upload count, but it no longer drives listening state, restarts, or errors.
  function makeHooks() {
    const hk = {
      p: null,
      live() { return !destroyed && provider === hk.p; },
      listening() { if (hk.live()) { listening = true; refresh(); } },
      speech() { if (hk.live() && !hearing) { hearing = true; refresh(); } },
      interim(text) { if (hk.live()) safe(cfg.onInterim, text); },
      level(v) { if (hk.live()) safe(cfg.onLevel, v); },
      transcribing(d) { transcribing = Math.max(0, transcribing + d); refresh(); },
      audioContext,
      result(text, meta = {}) { if (!destroyed) deliverFinal(text, meta); },
      ended(meta = {}) { if (hk.live()) onUtteranceEnd(meta); },
      error(code, message, info = {}) { if (hk.live()) onProviderError(code, message, info); },
      get handsFree() { return handsFree; },
      get speaking() { return speaking; },
      cfg,
    };
    return hk;
  }

  function makeProvider(name) {
    const hk = makeHooks();
    const p = name === 'web-speech' ? createWebSpeechProvider(hk) : name === 'whisper' ? createWhisperProvider(hk) : null;
    hk.p = p;
    return p;
  }
  function getProvider() {
    if (!provider || provider.name !== providerName) provider = makeProvider(providerName);
    return provider;
  }

  function deliverFinal(raw, meta) {
    const text = cleanTranscript(raw);
    if (!text) return;
    // Compare by when the speech began, not when the text arrived (whisper text lands seconds later, after upload).
    const at = typeof meta.onsetAt === 'number' ? meta.onsetAt : Date.now();
    for (const s of spoken) {
      if (at > s.until) continue;
      if (isEcho(text, s, { onsetAt: meta.onsetAt, tailMs: cfg.echoTailMs })) {
        console.debug?.('[voice] dropped echo of the guide:', text);
        safe(cfg.onError, { error: 'echo-dropped', message: MESSAGES['echo-dropped'], recovered: true, text });
        return;
      }
    }
    emptyStreak = 0;
    safe(cfg.onFinal, text, { provider: meta.provider || providerName, ...meta });
  }

  function listenNow() {
    clearTimeout(listenTimer); listenTimer = null;
    if (destroyed || !want || speaking || paused || failed || listening) return;
    const p = getProvider();
    if (!p) return;
    p.listen();
  }
  function scheduleListen(ms) {
    clearTimeout(listenTimer);
    listenTimer = setTimeout(listenNow, Math.max(0, ms));
  }

  function onUtteranceEnd(meta) {
    listening = false;
    hearing = false;
    if (!want || failed || retryPending) { refresh(); return; }
    if (speaking || paused) { refresh(); return; }
    if (!handsFree) { want = false; provider?.idle?.(); refresh(); return; } // tap-to-talk: one utterance per start()
    // Hands-free: listen again. Back off if the recognizer keeps ending instantly with nothing (e.g. mic busy).
    const quickEmpty = !meta.spoke && (meta.duration ?? 0) < 1000;
    emptyStreak = quickEmpty ? emptyStreak + 1 : 0;
    const base = providerName === 'whisper' ? 0 : cfg.restartDelayMs;
    const delay = emptyStreak > 1 ? Math.min(5000, cfg.restartDelayMs * 2 ** (emptyStreak - 1)) : base;
    refresh();
    scheduleListen(delay);
  }

  function otherProvider() {
    if (providerName === 'web-speech' && env.hasRecorder) return 'whisper';
    if (providerName === 'whisper' && supported.webSpeech) return 'web-speech';
    return null;
  }

  function switchProvider(name) {
    if (name === providerName) return;
    try { provider?.abort(); provider?.release(); } catch { /* */ }
    provider = null;
    providerName = name;
    listening = false; hearing = false;
    refresh();
    if (want && !speaking && !paused && !failed) scheduleListen(0);
  }

  async function warmUpMicThenListen() {
    // iOS: the first recognition.start() often fails before the mic permission exists. Ask for it, then retry once.
    retryPending = true;
    try {
      const s = await G.navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      retryPending = false;
      scheduleListen(150);
    } catch {
      retryPending = false;
      fail('not-allowed');
    }
  }

  function fail(code, message) {
    failed = { error: code, message: message || MESSAGES[code] || code };
    want = false;
    clearTimeout(listenTimer);
    try { provider?.abort(); } catch { /* */ }
    listening = false; hearing = false;
    safe(cfg.onError, { ...failed });
    refresh();
  }

  function onProviderError(code, message, info) {
    if (destroyed) return;
    if (SWITCH_TO_WHISPER.has(code) && providerName === 'web-speech') {
      if (env.hasRecorder && autoSwitches < 1) { autoSwitches++; safe(cfg.onError, { error: code, message: MESSAGES[code], recovered: true }); switchProvider('whisper'); return; }
      fail(code, 'Speech recognition is unavailable here. You can type instead.');
      return;
    }
    if (code === 'stt-unavailable') {
      if (supported.webSpeech && autoSwitches < 1) {
        autoSwitches++;
        safe(cfg.onError, { error: code, message: "The speech server isn't running; using the browser's recognizer.", recovered: true });
        switchProvider('web-speech');
        return;
      }
      fail(code);
      return;
    }
    if ((code === 'not-allowed' || code === 'audio-capture') && providerName === 'web-speech' && !warmedUp && info.early) {
      warmedUp = true;
      warmUpMicThenListen();
      return;
    }
    if (code === 'needs-gesture') { paused = 'needs-gesture'; listening = false; hearing = false; try { provider?.abort(); } catch { /* */ } refresh(); return; }
    if (info.fatal) { fail(code, message); return; }
    safe(cfg.onError, { error: code, message: message || MESSAGES[code] || code, recovered: true });
  }

  // ---- speaking (TTS) ----
  const ttsQueue = [];       // [{chunks, text, resolve, ok}]
  const liveUtterances = new Set(); // keep references: Chrome drops onend for garbage-collected utterances
  let ttsBusy = false;
  let deferSince = 0;
  let deferTimer = null;
  let chosenVoice = null;
  let spokenItemsText = [];

  function voiceFor() {
    if (chosenVoice) return chosenVoice;
    try { chosenVoice = pickVoice(synth.getVoices(), { lang: cfg.lang, prefer: cfg.voice }); } catch { chosenVoice = null; }
    return chosenVoice;
  }
  if (synth) {
    try { synth.addEventListener?.('voiceschanged', () => { chosenVoice = null; }); } catch { /* */ }
  }

  function speak(text) {
    const clean = cleanForSpeech(text);
    if (!clean || !synth || destroyed) return Promise.resolve(false);
    return new Promise((resolve) => {
      ttsQueue.push({ chunks: splitForSpeech(clean), text: clean, resolve, ok: true });
      pumpTts();
    });
  }

  function pumpTts() {
    clearTimeout(deferTimer); deferTimer = null;
    if (ttsBusy || !ttsQueue.length || destroyed) return;
    if (!speaking && hearing) {
      // Don't talk over the user: let their sentence finish first (up to maxDeferMs), then close it and talk.
      if (!deferSince) deferSince = Date.now();
      if (Date.now() - deferSince < cfg.maxDeferMs) { deferTimer = setTimeout(pumpTts, 150); return; }
      try { provider?.finish(); } catch { /* */ }
    }
    deferSince = 0;
    ttsBusy = true;
    if (!speaking) {
      speaking = true;
      clearTimeout(listenTimer);
      // Pause capture. Nothing is being said right now (we waited), so discard what the mic has. Abort even if the
      // recognizer hasn't reported 'start' yet: it's already capturing in that gap.
      if (!hearing) { try { provider?.abort(); } catch { /* */ } listening = false; }
      if (cfg.releaseMicWhileSpeaking) { try { provider?.release(); } catch { /* */ } }
      refresh();
    }
    speakNextChunk();
  }

  function speakNextChunk() {
    const item = ttsQueue[0];
    if (!item) { endSpeaking(); return; }
    if (!item.started) { item.started = true; spokenItemsText.push(item.text); }
    const chunk = item.chunks.shift();
    if (chunk === undefined) {
      ttsQueue.shift();
      item.resolve(item.ok);
      speakNextChunk();
      return;
    }
    let u;
    try {
      u = new Utterance(chunk);
      u.lang = cfg.lang; u.rate = cfg.rate; u.pitch = cfg.pitch; u.volume = cfg.volume;
      const v = voiceFor();
      if (v) u.voice = v;
    } catch { item.ok = false; speakNextChunk(); return; }
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(safety);
      liveUtterances.delete(u);
      if (!ok) item.ok = false;
      if (ttsQueue[0] === item) speakNextChunk();
    };
    u.onend = () => finish(true);
    u.onerror = (e) => {
      if (e?.error === 'not-allowed') { ttsUnlocked = false; safe(cfg.onError, { error: 'tts-locked', message: 'Tap once so I can speak out loud.', recovered: true }); }
      finish(false);
    };
    // Safety net: some engines never fire onend (backgrounded page, iOS audio interruptions).
    const safety = setTimeout(() => { try { synth.cancel(); } catch { /* */ } finish(false); }, 4000 + (chunk.length * 95) / Math.max(0.5, cfg.rate));
    liveUtterances.add(u);
    try {
      if (synth.paused) synth.resume();
      synth.speak(u);
    } catch { finish(false); }
  }

  function endSpeaking() {
    ttsBusy = false;
    if (ttsQueue.length) { pumpTts(); return; }
    const endedAt = Date.now();
    const until = endedAt + cfg.echoWindowMs;
    for (const t of spokenItemsText) spoken.push({ text: t, endedAt, until });
    spokenItemsText = [];
    while (spoken.length > 8 || (spoken.length && spoken[0].until < Date.now())) spoken.shift();
    speaking = false;
    refresh();
    if (want && !paused && !failed) scheduleListen(cfg.tailMs); // let the room go quiet before listening again
  }

  function stopSpeaking() {
    const items = ttsQueue.splice(0);
    for (const it of items) { it.ok = false; it.resolve(false); }
    clearTimeout(deferTimer); deferTimer = null; deferSince = 0;
    try { synth?.cancel(); } catch { /* */ }
    if (ttsBusy || speaking) endSpeaking();
  }

  // ---- page lifecycle ----
  const doc = G.document;
  function onVisibility() {
    if (!doc || destroyed) return;
    if (doc.visibilityState === 'hidden') {
      // Some headset browsers report the 2D page as hidden during an immersive session: keep listening there.
      let keep = false;
      try { keep = typeof cfg.ignoreHiddenWhile === 'function' && !!cfg.ignoreHiddenWhile(); } catch { /* */ }
      if (keep) return;
      if (want || listening) {
        paused = 'hidden';
        clearTimeout(listenTimer);
        try { provider?.abort(); provider?.release(); } catch { /* */ }
        listening = false; hearing = false;
        refresh();
      }
      return;
    }
    if (paused === 'hidden') {
      paused = null;
      const ctx = audioContext(false);
      if (ctx && ctx.state !== 'running') { try { ctx.resume().catch(() => {}); } catch { /* */ } }
      refresh();
      if (want) scheduleListen(250); // on iOS this may need a tap: the provider reports 'needs-gesture'
    }
  }
  doc?.addEventListener?.('visibilitychange', onVisibility);

  // Find out whether the whisper server is up, so auto mode doesn't pick a dead provider.
  if (cfg.checkHealth && cfg.provider === 'auto' && env.hasRecorder && typeof fetch === 'function') {
    apiRequest('GET', '/api/health', { base: cfg.base, auth: false, timeout: 5000, retries: 0 }).then((r) => {
      if (!r.ok || !r.data || typeof r.data !== 'object') return;
      whisperUp = !!r.data.stt?.whisper;
      if (!want && !listening) {
        const next = chooseProvider(env, { whisperUp });
        if (next !== providerName) { providerName = next; provider = null; refresh(); }
      }
    }).catch(() => {});
  }

  // ---- public API ----
  const api = {
    /** Begin listening. Call from a tap/click. In hands-free mode it keeps listening until stop(). Tapping while the guide
     *  is talking interrupts it (barge-in). Returns false if voice input isn't available (use the text box). */
    start() {
      if (destroyed) return false;
      unlock(); // synchronous: must stay inside the user gesture
      failed = null;
      autoSwitches = 0;
      emptyStreak = 0;
      if (paused === 'needs-gesture') paused = null;
      if (providerName === 'none') { failed = { error: 'unsupported', message: MESSAGES.unsupported }; refresh(); return false; }
      if (speaking || ttsQueue.length) stopSpeaking();
      want = true;
      if (!listening) listenNow(); // web-speech: recognition.start() runs synchronously, still inside the gesture
      refresh();
      return true;
    },
    /** Stop listening. The utterance in progress is still transcribed and delivered, unless {discard:true}. */
    stop({ discard = false } = {}) {
      want = false;
      clearTimeout(listenTimer);
      if (paused === 'needs-gesture') paused = null;
      if (provider) {
        try { if (discard) provider.abort(); else provider.finish(); } catch { /* */ } // both are no-ops when idle
        try { provider.release(); } catch { /* */ }
      }
      if (discard) { listening = false; hearing = false; }
      refresh();
    },
    /** Speak text aloud; resolves true when finished, false if cancelled/unsupported. Never rejects. */
    speak,
    /** Cancel speech now and drop anything queued. */
    stopSpeaking,
    /** Unlock audio without listening (call from any tap, e.g. an "Enter" button), so replies can be spoken on iOS. */
    unlock,
    setHandsFree(on) {
      handsFree = !!on;
      if (handsFree && want && !listening && !speaking && !paused) scheduleListen(0);
      refresh();
    },
    /** 'auto' | 'web-speech' | 'whisper'. */
    setProvider(name) {
      const next = !name || name === 'auto' ? chooseProvider(env, { whisperUp }) : name;
      if (next === 'web-speech' && !env.hasSR) return false;
      if (next === 'whisper' && !env.hasRecorder) return false;
      switchProvider(next);
      return true;
    },
    destroy() {
      api.stop({ discard: true });
      stopSpeaking();
      destroyed = true;
      doc?.removeEventListener?.('visibilitychange', onVisibility);
      try { provider?.release(); } catch { /* */ }
      try { ac?.close?.(); } catch { /* */ }
    },
    supported,
    get mode() { return providerName; },
    get state() { return computeState(); },
    get handsFree() { return handsFree; },
    get listening() { return listening; },
    get speaking() { return speaking; },
    env,
  };
  refresh(true);
  return api;
}

// ---------------------------------------------------------------------------------------------------------------
// Provider: web-speech (SpeechRecognition). One recognizer, continuous=false, restarted per utterance.

function createWebSpeechProvider(h) {
  const SR = G.SpeechRecognition || G.webkitSpeechRecognition;
  const cfg = h.cfg;
  let rec = null;
  let active = false;
  let finalText = '';
  let interimText = '';
  let err = null;
  let discard = false;
  let heard = false;
  let finishing = false;
  let t0 = 0;
  let onsetAt = null;

  function build() {
    rec = new SR(); // one instance for the whole session: a new one per utterance replays the iOS start chime
    rec.continuous = false; // iOS continuous mode never finalises and stops by itself
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = cfg.lang;
    rec.onstart = () => h.listening();
    rec.onspeechstart = () => { heard = true; onsetAt ??= Date.now(); h.speech(); };
    rec.onresult = (e) => {
      let fin = '';
      let int = '';
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r?.[0]?.transcript || '';
        if (r.isFinal) fin += t; else int += t;
      }
      finalText = fin.trim();
      interimText = int.trim();
      const shown = (finalText + ' ' + interimText).trim();
      if (shown) {
        onsetAt ??= Date.now();
        if (!heard) { heard = true; h.speech(); }
        h.interim(shown);
      }
    };
    rec.onerror = (e) => { err = e?.error || 'error'; };
    rec.onend = () => {
      active = false;
      // iOS sometimes ends without ever marking a result final: use the last interim text.
      const text = discard ? '' : (finalText || interimText).trim();
      const e = err;
      const early = Date.now() - t0 < 1500;
      discard = false;
      if (text) h.result(text, { provider: 'web-speech', onsetAt });
      if (e && e !== 'no-speech' && e !== 'aborted') {
        h.error(e, MESSAGES[e], { fatal: e === 'not-allowed' || e === 'audio-capture', early });
      }
      h.ended({ spoke: heard || !!text, gotText: !!text, duration: Date.now() - t0, error: e });
    };
  }

  return {
    name: 'web-speech',
    listen() {
      if (active) return;
      if (!rec) build();
      finalText = ''; interimText = ''; err = null; discard = false; heard = false; finishing = false; onsetAt = null;
      t0 = Date.now();
      try {
        rec.start();
        active = true;
      } catch (e) {
        if (e?.name === 'InvalidStateError') { active = true; return; } // already running
        h.error('audio-capture', e?.message, { fatal: false, early: true });
        h.ended({ spoke: false, gotText: false, duration: 0 });
      }
    },
    finish() { if (active) { finishing = true; try { rec.stop(); } catch { /* */ } } },
    abort() { if (active) { discard = true; try { rec.abort(); } catch { /* */ } } },
    release() { if (active && !finishing) { discard = true; try { rec.abort(); } catch { /* */ } } },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Provider: whisper (getUserMedia → level-based voice detection → MediaRecorder blob → POST /api/stt).
// The recorder is armed before speech starts so the first word isn't clipped; while it's quiet it's swapped for a fresh
// one every few seconds so the upload stays short.

function createWhisperProvider(h) {
  const cfg = h.cfg;
  const mime = pickRecorderMime();
  let stream = null;
  let src = null;
  let analyser = null;
  let sink = null;
  let buf = null;
  let timer = null;
  let rec = null;
  let active = false;
  let phase = 'off'; // 'off' | 'armed' | 'speech'
  let session = 0;
  let t0 = 0;
  let voicedMs = 0;
  let silentMs = 0;
  let voicedTotal = 0;
  let speechAt = 0;
  let noise = 0;
  let calib = 0;
  let zeroTicks = 0;
  let rebuilt = false;
  let releaseTimer = null;
  let suspendedTicks = 0;
  let deliverChain = Promise.resolve();
  const pendingStops = new Set();

  function tracksLive() { return !!stream && stream.getAudioTracks().some((t) => t.readyState === 'live'); }

  async function ensureMic(my) {
    if (tracksLive()) { if (!analyser) buildGraph(); return; }
    const s = await G.navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    if (my !== session) { s.getTracks().forEach((t) => t.stop()); return; } // stopped while the permission prompt was up
    if (tracksLive()) { s.getTracks().forEach((t) => t.stop()); return; }   // a parallel listen() won the race
    stream = s;
    const track = stream.getAudioTracks()[0];
    track?.addEventListener?.('ended', () => {
      if (!active) return;
      stopCapture(); h.error('audio-capture', 'The microphone stopped.', { fatal: false });
      h.ended({ spoke: false, gotText: false, duration: 0 });
    });
    rebuilt = false;
    buildGraph();
  }

  function buildGraph() {
    // iOS lets a page create/resume audio while it's capturing, so this works even outside the original tap.
    const ctx = h.audioContext(true);
    if (!ctx || !stream) return;
    try { src?.disconnect(); } catch { /* */ }
    try { analyser?.disconnect(); } catch { /* */ }
    src = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    sink = ctx.createGain(); // a silent path to the destination keeps the graph pulling audio in every browser
    sink.gain.value = 0;
    src.connect(analyser);
    analyser.connect(sink);
    sink.connect(ctx.destination);
    buf = new Float32Array(analyser.fftSize);
    if (ctx.state !== 'running') { try { ctx.resume().catch(() => {}); } catch { /* */ } }
  }

  function startRecorder() {
    let mr;
    try { mr = mime ? new G.MediaRecorder(stream, { mimeType: mime }) : new G.MediaRecorder(stream); }
    catch { mr = new G.MediaRecorder(stream); }
    const r = { mr, chunks: [], startedAt: Date.now(), type: String(mr.mimeType || mime || 'audio/webm').split(';')[0] || 'audio/webm' };
    mr.ondataavailable = (e) => { if (e.data && e.data.size) r.chunks.push(e.data); };
    mr.start();
    return r;
  }
  function discardRecorder(r) {
    if (!r) return;
    r.mr.ondataavailable = null;
    r.mr.onstop = null;
    try { if (r.mr.state !== 'inactive') r.mr.stop(); } catch { /* */ }
  }
  function stopRecorder(r) {
    const p = new Promise((resolve) => {
      const blob = () => new Blob(r.chunks, { type: r.type });
      if (r.mr.state === 'inactive') { resolve(blob()); return; }
      const t = setTimeout(() => resolve(blob()), 2000);
      r.mr.onstop = () => { clearTimeout(t); resolve(blob()); };
      try { r.mr.stop(); } catch { clearTimeout(t); resolve(blob()); }
    });
    pendingStops.add(p);
    p.finally(() => pendingStops.delete(p));
    return p;
  }

  async function upload(blob) {
    if (typeof cfg.stt === 'function') return String((await cfg.stt(blob)) ?? '');
    const r = await apiRequest('POST', cfg.sttUrl, {
      base: cfg.base, body: blob, headers: { 'content-type': blob.type || 'audio/webm' }, timeout: 30000, retries: 0,
    });
    if (r.ok) return (r.data && typeof r.data === 'object' && typeof r.data.text === 'string') ? r.data.text : '';
    const e = new Error(r.error || 'stt failed');
    e.code = r.status === 503 ? 'stt-unavailable' : r.status === 401 ? 'unauthorized' : 'stt-failed';
    throw e;
  }

  function tick() {
    if (!active || !analyser) return;
    const ctx = h.audioContext(false);
    if (ctx && ctx.state !== 'running') {
      // A suspended AudioContext reads silence forever: ask for a tap instead of listening to nothing.
      if (++suspendedTicks === 25) { try { ctx.resume().catch(() => {}); } catch { /* */ } }
      if (suspendedTicks === 50) { h.error('needs-gesture', MESSAGES['needs-gesture'], { fatal: false }); }
      return;
    }
    suspendedTicks = 0;
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    if (rms === 0) {
      if (++zeroTicks === 50) { // 2 s of digital silence: the graph is dead (an iOS sample-rate quirk). Rebuild once.
        if (!rebuilt) { rebuilt = true; zeroTicks = 0; buildGraph(); }
        else h.error('mic-silent', MESSAGES['mic-silent'], { fatal: false });
      }
    } else zeroTicks = 0;
    h.level(levelOf(rms));
    const now = Date.now();
    if (phase === 'armed') {
      if (calib < 6) { noise = calib === 0 ? rms : noise + (rms - noise) / (calib + 1); calib++; return; }
      const thr = Math.max(cfg.minRms, noise * cfg.startRatio);
      if (rms > thr) voicedMs += TICK;
      else {
        voicedMs = Math.max(0, voicedMs - TICK / 2);
        noise += (rms - noise) * (rms < noise ? 0.1 : 0.01); // follow the room: fast down, slow up
      }
      if (voicedMs >= cfg.startMs) {
        phase = 'speech'; speechAt = now - voicedMs; silentMs = 0; voicedTotal = voicedMs;
        h.speech();
        return;
      }
      if (!h.handsFree && now - t0 > cfg.noSpeechTimeoutMs) { endUtterance('no-speech'); return; }
      if (rec && now - rec.startedAt > cfg.recycleMs && voicedMs === 0) {
        const old = rec;
        rec = startRecorder(); // new one first, so there's never a gap
        discardRecorder(old);
      }
    } else if (phase === 'speech') {
      const thr = Math.max(cfg.minRms * 0.8, noise * cfg.endRatio);
      if (rms < thr) silentMs += TICK; else { silentMs = 0; voicedTotal += TICK; }
      if (silentMs >= cfg.silenceMs) endUtterance('silence');
      else if (now - speechAt > cfg.maxUtteranceMs) endUtterance('max');
    }
  }

  function stopCapture() {
    clearInterval(timer); timer = null;
    active = false;
    phase = 'off';
  }

  function endUtterance(reason) {
    const r = rec; rec = null;
    const wasSpeech = phase === 'speech';
    const dur = Date.now() - t0;
    const heardEnough = wasSpeech && voicedTotal >= cfg.minSpeechMs;
    // Tap-to-talk released by hand: send it even if the level detector never fired (quiet voice, loud room).
    const manual = reason === 'finish' && !h.handsFree && dur > 400;
    const send = r && reason !== 'abort' && (heardEnough || manual);
    const meta = { provider: 'whisper', voicedMs: voicedTotal, reason, onsetAt: wasSpeech ? speechAt : null };
    stopCapture();
    if (send) {
      h.transcribing(+1);
      const text = stopRecorder(r).then((blob) => (blob.size > 0 ? upload(blob) : ''));
      deliverChain = deliverChain.then(() => text).then(
        (t) => { h.transcribing(-1); if (t) h.result(t, meta); },
        (e) => { h.transcribing(-1); h.error(e?.code || 'stt-failed', MESSAGES[e?.code] || e?.message, { fatal: e?.code === 'unauthorized' }); },
      );
    } else discardRecorder(r);
    h.ended({ spoke: wasSpeech, gotText: !!send, duration: dur, reason });
    scheduleRelease();
  }

  function scheduleRelease() {
    clearTimeout(releaseTimer);
    if (h.handsFree) return; // hands-free keeps the mic open between turns (no Bluetooth profile flapping)
    releaseTimer = setTimeout(() => { if (!active) release(); }, cfg.releaseMicAfterMs);
  }

  async function release() {
    clearTimeout(releaseTimer);
    stopCapture();
    discardRecorder(rec); rec = null;
    session++;
    if (pendingStops.size) await Promise.allSettled([...pendingStops]); // let finishing recorders flush first
    if (active) return; // listen() was called again meanwhile
    try { src?.disconnect(); } catch { /* */ }
    try { analyser?.disconnect(); sink?.disconnect(); } catch { /* */ }
    src = analyser = sink = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  return {
    name: 'whisper',
    listen() {
      if (active) return;
      active = true;
      const my = ++session;
      clearTimeout(releaseTimer);
      ensureMic(my).then(() => {
        if (my !== session || !active) return;
        phase = 'armed'; t0 = Date.now();
        voicedMs = 0; silentMs = 0; voicedTotal = 0; calib = 0; zeroTicks = 0; suspendedTicks = 0;
        rec = startRecorder();
        clearInterval(timer);
        timer = setInterval(tick, TICK);
        h.listening();
      }).catch((err) => {
        if (my !== session) return;
        active = false;
        const name = err?.name || '';
        const code = name === 'NotAllowedError' || name === 'SecurityError' ? 'not-allowed' : 'audio-capture';
        h.error(code, MESSAGES[code], { fatal: true });
        h.ended({ spoke: false, gotText: false, duration: 0 });
      });
    },
    finish() { if (active) { if (phase === 'off') { session++; stopCapture(); h.ended({ spoke: false, gotText: false, duration: 0 }); } else endUtterance('finish'); } },
    abort() {
      if (!active) return;
      if (phase === 'off') { session++; stopCapture(); h.ended({ spoke: false, gotText: false, duration: 0, reason: 'abort' }); return; }
      endUtterance('abort');
    },
    release,
    idle() { scheduleRelease(); },
  };
}

export default createVoice;

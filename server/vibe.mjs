// server/vibe.mjs: vibe mode. Voice → Claude Code (her subscription, never the API) writes sandboxed three.js
// creations in creations/ → the server validates them → clients hot-load them.
//
// Mounted by server/app.mjs (server-core):
//   POST /api/vibe   {text, from?, reset?}  → 202 {id}         handleVibe(req, res, ctx)
//   GET  /api/vibe                          → 200 {busy, ...}  handleVibe(req, res, ctx)  (status, for UIs and smoke tests)
//   GET  /api/creations                     → listCreations()   synchronous, returns an array:
//        [{ slug, url:'/creations/<slug>.js?v=<mtime>', mtime, bytes, title }]  (oldest first)
//
// ctx, as server-core passes it (only `broadcast` is required):
//   {
//     world,                      // createWorld() instance: get() → World, describe() → string. Optional.
//     broadcast(event, data),     // SSE fan-out to every client
//     token,                      // WORLD_TOKEN. server-core already checks auth; this is a second, defensive check.
//     root,                       // repo root. Defaults to the folder above this file.
//     dataDir?,                   // optional. Defaults to $DATA_DIR (resolved against root), else <root>/.data
//   }
//
// Events broadcast through ctx.broadcast:
//   chat     {id, role:'user', from, text, brain:'claude', mode:'vibe'} then {id:'<id>-r', role:'guide', ..., replyTo:id} (as app.mjs does)
//   status   {thinking, brain:'claude', mode:'vibe', detail?}       e.g. detail 'vibe: writing lantern-ring'
//   creation {slug, url:'/creations/<slug>.js?v=<mtime>', action:'upsert'|'remove'}
//   error    {message}
//
// Security model (verified empirically with claude 2.1.282 and re-verified on 2.1.285, see the vibe builder's report):
//   - `claude -p` long-lived stream-json session, cwd = creations/, --restricted (file tools confined to cwd, no Bash/web,
//     ignores user/project settings), --tools Read,Write,Edit,Glob, --permission-mode acceptEdits,
//     --permission-prompts none (anything that would prompt is denied), --strict-mcp-config with no servers (zero MCP;
//     the world is described in each prompt instead), --setting-sources "" (no CLAUDE.md, no hooks), README.md write-denied.
//     Never --dangerously-skip-permissions, never bypassPermissions, never ANTHROPIC_API_KEY (stripped from the child env).
//   - Every changed file is validated: kebab-case name, size, a banned-pattern lint (comments, strings and regex
//     literals ignored; a file the scanner can't read cleanly is rejected), `node --check`, then create() + 120 frames
//     of updates (plus a few at t = 10/60/600 s) run against three r186 inside a Node permission sandbox (no fs writes,
//     no network, no child processes, no eval). The sandbox's canvas/document stand-ins record any reach back into the
//     page (ownerDocument, defaultView, ...), however the name is spelled. The perf budget is counted by capacity over
//     every object, hidden ones included (InstancedMesh by instanceMatrix size, geometry ignoring drawRange), so a
//     creation can't pass small and grow later; src/world/creations.js re-audits live creations in the browser too.
//     Failures go back to Claude for one repair round; anything still failing is rolled back, so clients only ever
//     receive creations that passed.
//   - Limits of this model: the lint and the Node run are guardrails, not an in-browser sandbox. A creation runs as
//     same-origin page code; the page-level defences (a CSP without 'unsafe-eval' and with connect-src 'self', and not
//     keeping the token in localStorage) belong to the viewer/server owners.
//
// Env: VIBE_MODEL (default sonnet), VIBE_TURN_TIMEOUT_MS (180000), VIBE_JOB_TIMEOUT_MS (300000),
//      VIBE_REPAIR_ROUNDS (1), VIBE_RUNTIME_CHECK ('0' disables), VIBE_THREE_DIR (cache for the sandbox's three.js;
//      default <dataDir>/vibe/three-<ver>, downloaded once from the same jsDelivr URL as index.html's import map),
//      CLAUDE_BIN (default 'claude').

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  existsSync, mkdirSync, readdirSync, readFileSync, statSync, lstatSync, writeFileSync, renameSync, rmSync, utimesSync, rmdirSync,
} from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const env = process.env;
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
const CFG = {
  model: env.VIBE_MODEL || 'sonnet',
  turnTimeoutMs: num(env.VIBE_TURN_TIMEOUT_MS, 180_000),
  jobTimeoutMs: num(env.VIBE_JOB_TIMEOUT_MS, 300_000),
  repairRounds: num(env.VIBE_REPAIR_ROUNDS, 1),
  runtimeCheck: env.VIBE_RUNTIME_CHECK !== '0',
  claudeBin: env.CLAUDE_BIN || 'claude',
  maxQueue: 4,
  maxTextChars: 2000,
};

// ---------- names, limits ----------
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const FILE_RE = /^([a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?)\.js$/;
const TOMBSTONE_RE = /^\s*\/\/\s*@remove\s*$/;
const MAX_BYTES = 64 * 1024;
export const LIMITS = { drawCalls: 16, triangles: 50_000, points: 5_000, textureSize: 512, updates: 32, msPerFrame: 2 };
const IGNORED = new Set(['.DS_Store']);

const log = (...a) => console.log('[vibe]', ...a);

// =====================================================================================================
// Lint: a simple banned-pattern check on code with comments and string/template text blanked out.
// It is a guardrail against accidents, not a sandbox; the runtime check below is the real sandbox.
// =====================================================================================================

// After these keywords a `/` starts a regex literal, not a division.
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);
const COND_PAREN_WORD = new Set(['if', 'while', 'for', 'with']);

/**
 * Same-length copy of `src` with comments, string/template text and regex-literal bodies replaced by spaces (newlines kept).
 * Returns { code, error }: `error` is set when the scanner lost track (an unterminated string, regex, template or comment),
 * because a desynced scan could hide real code as "string"; the lint then rejects the file instead of trusting it.
 */
export function scanCode(src) {
  const out = [];
  const n = src.length;
  const tplStack = [];            // brace depth at each open `${`
  const parens = [];              // for each open `(`: was it the condition of if/while/for/with?
  let depth = 0, mode = 'code', quote = '', inClass = false, error = null;
  let prev = '', prev2 = '', prevWord = '', condParenClosed = false; // last significant code char / identifier, for regex detection
  const blank = (c) => (c === '\n' ? '\n' : ' ');
  const regexAllowed = () => {
    if (!prev) return true;
    if (/[\w$]/.test(prev)) return REGEX_AFTER_WORD.has(prevWord);
    if (prev === ')') return condParenClosed;       // `if (x) /re/.test(s)` vs `(a + b) / 2`
    if (prev === ']') return false;
    if ((prev === '+' || prev === '-') && prev2 === prev) return false; // a++ / 2
    return true;                                    // ( , = : [ ! & | ? { } ; + - * % < > ~ ^ =>
  };
  for (let i = 0; i < n; i++) {
    const c = src[i], d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; out.push('  '); i++; continue; }
      if (c === '/' && d === '*') { mode = 'block'; out.push('  '); i++; continue; }
      if (c === '/' && regexAllowed()) { mode = 'regex'; inClass = false; out.push(c); continue; }
      if (c === '"' || c === "'") { mode = 'str'; quote = c; out.push(c); continue; }
      if (c === '`') { mode = 'tpl'; out.push(c); continue; }
      if (/\s/.test(c)) { out.push(c); continue; }
      if (/[\w$]/.test(c)) {
        let j = i; while (j < n && /[\w$]/.test(src[j])) j++;
        const word = src.slice(i, j);
        out.push(word); i = j - 1; prev = word[word.length - 1]; prevWord = word; continue;
      }
      if (c === '(') { parens.push(COND_PAREN_WORD.has(prevWord) && /[\w$]/.test(prev)); }
      else if (c === ')') { condParenClosed = parens.length ? parens.pop() : false; }
      else if (c === '{') depth++;
      else if (c === '}') {
        if (tplStack.length && depth === tplStack[tplStack.length - 1]) { tplStack.pop(); mode = 'tpl'; out.push(c); continue; }
        depth--;
      }
      out.push(c); prev2 = prev; prev = c; prevWord = '';
    } else if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out.push('\n'); } else out.push(' ');
    } else if (mode === 'block') {
      if (c === '*' && d === '/') { mode = 'code'; out.push('  '); i++; } else out.push(blank(c));
    } else if (mode === 'str') {
      if (c === '\\') { out.push(' ', blank(d ?? '')); i++; continue; }
      if (c === quote) { mode = 'code'; out.push(c); prev = c; prevWord = ''; continue; }
      if (c === '\n') { error ??= `line ${lineAt(src, i)}: unterminated string`; mode = 'code'; out.push('\n'); continue; }
      out.push(' ');
    } else if (mode === 'regex') {
      if (c === '\\') { if (d === '\n') { error ??= `line ${lineAt(src, i)}: unterminated regular expression`; } out.push(' ', blank(d ?? '')); i++; continue; }
      if (c === '\n') { error ??= `line ${lineAt(src, i)}: unterminated regular expression`; mode = 'code'; out.push('\n'); continue; }
      if (inClass) { if (c === ']') inClass = false; out.push(' '); continue; }
      if (c === '[') { inClass = true; out.push(' '); continue; }
      if (c === '/') { mode = 'code'; out.push(c); prev = ')'; condParenClosed = false; prevWord = ''; continue; } // like a value: `/x/ / 2`
      out.push(' ');
    } else { // tpl
      if (c === '\\') { out.push(' ', blank(d ?? '')); i++; continue; }
      if (c === '`') { mode = 'code'; out.push(c); prev = c; prevWord = ''; continue; }
      if (c === '$' && d === '{') { tplStack.push(depth); mode = 'code'; out.push('${'); i++; prev = '{'; prevWord = ''; continue; }
      out.push(blank(c));
    }
  }
  if (!error && mode !== 'code' && mode !== 'line') error = `unterminated ${mode === 'block' ? 'comment' : mode === 'tpl' ? 'template string' : mode === 'regex' ? 'regular expression' : 'string'} at the end of the file`;
  if (!error && tplStack.length) error = 'unterminated ${...} in a template string';
  return { code: out.join(''), error };
}

/** Same-length copy of `src` with comments, strings and regex bodies blanked (see scanCode). */
export function stripCode(src) { return scanCode(src).code; }

// [regex (global), why, scope]. scope 'any': every use, including `.name` (property access); 'bare': only a bare
// identifier (not `obj.name`; `...name` spread still counts). Either way a property *definition* (`{ name: 1 }`,
// `, name: 2`) is fine, since it reads nothing. Shorthand `{ self }` is NOT a definition: it reads the global.
const BANNED = [
  [/\bimport\b/g, 'no imports: THREE is passed into create()', 'any'],
  [/\brequire\s*\(/g, 'no require()', 'any'],
  [/\b(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|RTCPeerConnection|importScripts|SharedWorker|Worker|FontFace|BroadcastChannel|WebTransport|addModule)\b/g, 'no network or workers', 'any'],
  [/\b\w*Loader\b|\bload(Async)?\s*\(/g, 'no loaders: build everything in code (loaders make network requests)', 'any'],
  [/\beval\b/g, 'no eval', 'any'],
  [/\bFunction\b/g, 'no Function', 'any'],
  [/\bconstructor\b|\b__proto__\b|\b(getPrototypeOf|setPrototypeOf|Reflect|Proxy)\b/g, 'no constructor, prototype or Reflect/Proxy tricks', 'any'],
  [/\b(setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|queueMicrotask)\b/g, 'no timers: animate with addUpdate((dt, t) => ...)', 'any'],
  [/\b(localStorage|sessionStorage|indexedDB|cookieStore|cookie|caches)\b/g, 'no storage or cookies', 'any'],
  [/\b(window|globalThis|navigator|clientInformation|process)\b/g, 'no browser or host globals', 'any'],
  [/\b(ownerDocument|defaultView|getRootNode|parentNode|parentElement|ownerElement|contentWindow|contentDocument|documentElement|baseURI)\b/g, 'no reaching into the page from a canvas', 'any'],
  [/\b(self|location|top|parent|opener|frames|Image|Audio)\b/g, 'no browser globals', 'bare'],
  [/\b(camera|Camera|isCamera|renderer)\b/g, 'never touch the camera or renderer: the headset owns the viewpoint', 'any'],
  [/\b(innerHTML|outerHTML|insertAdjacentHTML|postMessage|createObjectURL)\b/g, 'no DOM or messaging', 'any'],
  [/\b(alert|confirm|prompt|open)\s*\(/g, 'no dialogs or popups', 'bare'],
  [/\bBatchedMesh\b/g, 'no BatchedMesh: use InstancedMesh for repeats', 'any'],
  [/\bwhile\s*\(\s*(true|1|!0)\s*\)|\bfor\s*\(\s*;\s*;\s*\)/g, 'no infinite loops', 'any'],
];
// Words with no innocent use, checked in the raw source (strings and comments included), so a scanner slip can't hide them.
const RAW_BANNED = /\b(ownerDocument|defaultView|getRootNode|localStorage|sessionStorage|globalThis|XMLHttpRequest|sendBeacon)\b|dreamspace\.token/;

const lineAt = (s, idx) => s.slice(0, idx).split('\n').length;

const prevNonSpace = (s, i) => { let j = i - 1; while (j >= 0 && /\s/.test(s[j])) j--; return j; };
const nextNonSpace = (s, i) => { let j = i; while (j < s.length && /\s/.test(s[j])) j++; return j; };
/** `{ name: …` or `, name: …`: a property definition (not `a ? name : b`, not `case name:`). */
function isPropertyKey(code, start, end) {
  const p = prevNonSpace(code, start), q = nextNonSpace(code, end);
  return code[q] === ':' && (code[p] === '{' || code[p] === ',');
}
/** `obj.name` / `obj?.name`, but not the spread `...name`. */
function isMemberAccess(code, start) {
  const p = prevNonSpace(code, start);
  return code[p] === '.' && !(code[p - 1] === '.' && code[p - 2] === '.');
}

/** Returns a list of human-readable problems (empty = clean). */
export function lintCreation(src) {
  const errors = [];
  if (!src.trim()) return ['the file is empty'];
  const { code, error: scanError } = scanCode(src);
  if (scanError) errors.push(`${scanError} (the checker could not read the file safely; keep strings and regexes on one line)`);
  const raw = RAW_BANNED.exec(src);
  if (raw) errors.push(`line ${lineAt(src, raw.index)}: \`${raw[0]}\`: not allowed anywhere in a creation, not even in a string or comment`);
  // names the file declares itself (`const top = …`, `function open(…)`): those aren't the browser globals
  const declared = new Set([...code.matchAll(/\b(?:const|let|var|function|class)\s+([\w$]+)/g)].map((m) => m[1]));
  for (const [re, why, scope] of BANNED) {
    re.lastIndex = 0;
    for (const m of code.matchAll(re)) {
      const word = /^[\w$]+/.exec(m[0])?.[0] || m[0];
      if (scope === 'bare' && (declared.has(word) || isMemberAccess(code, m.index) || isPropertyKey(code, m.index, m.index + word.length))) continue;
      errors.push(`line ${lineAt(code, m.index)}: \`${m[0].trim()}\`: ${why}`);
      break;
    }
  }
  for (const m of code.matchAll(/\bdocument\b/g)) {
    if (!/^document\s*\.\s*createElement\s*\(\s*(['"`])canvas\1\s*\)/.test(src.slice(m.index))) {
      errors.push(`line ${lineAt(code, m.index)}: \`document\` is only allowed as document.createElement('canvas')`);
      break;
    }
  }
  const exports = [...code.matchAll(/\bexport\b/g)];
  if (!exports.length) errors.push('missing `export default function create({ THREE, scene, room, world, addUpdate })`');
  else if (exports.length > 1 || !/^export\s+default\b/.test(code.slice(exports[0].index))) {
    errors.push('the only export must be `export default function create(...)`');
  }
  return errors;
}

// =====================================================================================================
// listCreations(): synchronous so server-core can `json(res, 200, listCreations())` with or without await.
// =====================================================================================================

function titleOf(src) {
  const m = /^\s*\/\/\s*[a-z0-9-]+\.js\s*[:\-–—]\s*(.{1,120})/.exec(src) || /^\s*\/\/\s*(.{1,120})/.exec(src);
  return m ? m[1].trim() : '';
}

export function listCreations(opts) {
  const root = typeof opts?.root === 'string' ? resolve(opts.root) : ROOT;
  const dir = join(root, 'creations');
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  // While a vibe job is running, files it touched are not validated yet: hide new ones (they arrive over SSE once they
  // pass) and list changed ones at their pre-job version, so a page loading mid-job never imports an unvalidated file.
  const before = [...states.values()].find((s) => s.root === root && s.running?.before)?.running.before;
  const out = [];
  for (const e of entries) {
    const m = FILE_RE.exec(e.name);
    if (!m || !e.isFile()) continue;
    try {
      const file = join(dir, e.name);
      let { size, mtimeMs } = statSync(file);
      let src;
      if (before) {
        const b = before.get(e.name);
        if (!b?.content) continue;
        if (b.mtimeMs !== mtimeMs || b.size !== size) { ({ size, mtimeMs } = b); src = b.content.toString('utf8'); }
      }
      if (size > MAX_BYTES) continue;
      src ??= readFileSync(file, 'utf8');
      if (TOMBSTONE_RE.test(src) || lintCreation(src).length) continue;
      out.push({ slug: m[1], url: `/creations/${e.name}?v=${Math.round(mtimeMs)}`, mtime: Math.round(mtimeMs), bytes: size, title: titleOf(src) });
    } catch { /* unreadable: skip */ }
  }
  return out.sort((a, b) => a.mtime - b.mtime || a.slug.localeCompare(b.slug));
}

// =====================================================================================================
// Validation: node --check, then the sandboxed runtime check.
// =====================================================================================================

function run(cmd, args, { timeoutMs = 8000, cwd, envVars = {} } = {}) {
  return new Promise((resolveRun) => {
    let out = '', err = '', done = false;
    let cp;
    try { cp = spawn(cmd, args, { cwd, env: envVars, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolveRun({ code: -1, out, err: String(e), timedOut: false }); return; }
    const cap = (s, d) => (s.length < 200_000 ? s + d : s);
    cp.stdout.on('data', (d) => { out = cap(out, d); });
    cp.stderr.on('data', (d) => { err = cap(err, d); });
    const timer = setTimeout(() => { if (!done) { cp.kill('SIGKILL'); } }, timeoutMs);
    const finish = (code, timedOut) => { if (done) return; done = true; clearTimeout(timer); resolveRun({ code, out, err, timedOut }); };
    cp.on('error', (e) => { err += String(e); finish(-1, false); });
    cp.on('exit', (code, signal) => finish(code, signal === 'SIGKILL'));
  });
}

// `node --check` on an ambiguous .js (no package.json "type") exits 0 even on a syntax error (node 25 module detection),
// so check an .mjs copy: always parsed as an ES module, whatever package.json says.
async function syntaxCheck(file, name, st) {
  const tmp = join(st ? join(st.dataDir, 'vibe', 'sandbox') : dirname(file), `syn-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}.mjs`);
  mkdirSync(dirname(tmp), { recursive: true });
  writeFileSync(tmp, readFileSync(file));
  const r = await run(process.execPath, ['--check', tmp], { timeoutMs: 8000, envVars: { PATH: env.PATH || '' } });
  rmSync(tmp, { force: true });
  if (r.code === 0) return null;
  const lines = r.err.split('\n');
  const msg = lines.find((l) => /^\w*Error:/.test(l)) || lines.find((l) => l.trim()) || 'syntax error';
  const at = /:(\d+)\s*$/.exec(lines[0] || '');
  return `${name}${at ? ` line ${at[1]}` : ''}: ${msg.trim()}`;
}

// ---- the sandbox runner (written to <dataDir>/vibe/sandbox/runner.mjs) ----
const RUNNER = String.raw`// Generated by server/vibe.mjs: runs one creation against three.js inside a Node permission sandbox.
const [threeUrl, fileUrl, worldFile, slug, limitsJson, marker] = process.argv.slice(2);
const LIMITS = JSON.parse(limitsJson);
const report = { ok: true, errors: [], warnings: [], stats: {} };
// The report goes out with a per-run random marker the creation never sees, through a write captured before the
// creation loads, and console.* is silenced: a creation can't print a forged "ok" report.
const out = process.stdout.write.bind(process.stdout);
const exit = process.exit.bind(process);
const emit = () => out('\n' + marker + JSON.stringify(report) + '\n');
const where = (e) => { const m = new RegExp(slug.replace(/[-]/g, '\\-') + '\\.mjs:(\\d+)').exec(String(e && e.stack)); return m ? ' (line ' + m[1] + ')' : ''; };
const msg = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 300);
const fail = (s) => { report.ok = false; report.errors.push(s); emit(); exit(0); };
process.on('uncaughtException', (e) => fail('uncaught error: ' + msg(e) + where(e)));
process.on('unhandledRejection', (e) => fail('unhandled rejection: ' + msg(e) + where(e)));
const noop = () => {};
for (const k of ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'table']) console[k] = noop;

// Anything that reaches from a canvas or document back into the page (and so to storage, the token or the network)
// is recorded, however the property name was spelled (c['owner' + 'Document'] included). Recorded, not thrown,
// so a try/catch in the creation can't swallow it.
const ESCAPES = new Set(['ownerDocument', 'defaultView', 'getRootNode', 'parentNode', 'parentElement', 'ownerElement', 'baseURI',
  'contentWindow', 'contentDocument', 'documentElement', 'body', 'head', 'cookie', 'location', 'domain', 'URL', 'documentURI',
  'referrer', 'defaultView', 'querySelector', 'querySelectorAll', 'getElementById', 'getElementsByTagName', 'forms', 'scripts',
  'images', 'links', 'open', 'write', 'writeln', 'implementation', 'fonts', 'currentScript', 'constructor', '__proto__']);
const escaped = new Set();
const trap = (what, k) => {
  const key = String(k);
  if (!ESCAPES.has(key) || escaped.has(what + '.' + key)) return;
  escaped.add(what + '.' + key);
  report.ok = false;
  report.errors.push('reads ' + what + '.' + key + ': a creation may only draw on its canvas, never reach the page, storage or the network');
};
const guard = (what, target) => new Proxy(target, {
  get(t, k, r) { trap(what, k); return Reflect.get(t, k, r); },
  getOwnPropertyDescriptor(t, k) { trap(what, k); return Reflect.getOwnPropertyDescriptor(t, k); },
  getPrototypeOf(t) { trap(what, '__proto__'); return Reflect.getPrototypeOf(t); },
});

// Canvas stand-ins, so CanvasTexture recipes work without a DOM.
const grad = { addColorStop: noop };
function makeCanvas(w = 300, h = 150) {
  const c = { width: w, height: h, style: {}, addEventListener: noop, removeEventListener: noop, toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=' };
  const pc = guard('canvas', c);
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k === 'canvas') return pc;
      if (k in t) return t[k];
      trap('context', k);
      if (k === 'createRadialGradient' || k === 'createLinearGradient' || k === 'createConicGradient' || k === 'createPattern') return () => grad;
      if (k === 'measureText') return (s) => ({ width: String(s).length * 8, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 });
      if (k === 'getImageData' || k === 'createImageData') return (a, b, cw, ch) => { const W = cw || a || 1, H = ch || b || 1; return { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) }; };
      if (k === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      if (k === 'isPointInPath' || k === 'isPointInStroke') return () => false;
      if (k === 'getLineDash') return () => [];
      return noop;
    },
    set(t, k, v) { t[k] = v; return true; },
    getPrototypeOf() { trap('context', '__proto__'); return Object.prototype; },
  });
  c.getContext = () => ctx;
  return pc;
}
globalThis.document = guard('document', { createElement: (tag) => (String(tag).toLowerCase() === 'canvas' ? makeCanvas() : { style: {}, appendChild: noop }), createElementNS: (ns, tag) => makeCanvas() });
globalThis.OffscreenCanvas = class { constructor(w, h) { return makeCanvas(w, h); } };

const THREE = await import(threeUrl);
// Reaching the Function constructor through any function (fn['const' + 'ructor'], async/generator ones too) is recorded,
// even when the creation catches the EvalError that --disallow-code-generation-from-strings raises here.
for (const p of [Function.prototype, Object.getPrototypeOf(async function () {}), Object.getPrototypeOf(function* () {}), Object.getPrototypeOf(async function* () {})]) {
  const real = p.constructor;
  Object.defineProperty(p, 'constructor', { configurable: true, get() { trap('function', 'constructor'); return real; } });
}
// Drain promise jobs, so work a creation defers with .then / await runs here too, as it would in the browser.
const settle = () => new Promise((r) => setImmediate(r));
let mod;
try { mod = await import(fileUrl); } catch (e) { fail('could not load: ' + msg(e) + where(e)); }
if (typeof mod.default !== 'function') fail('the default export must be a function create({ THREE, scene, room, world, addUpdate })');

let world = null;
try { world = JSON.parse((await import('node:fs')).readFileSync(worldFile, 'utf8')); } catch {}
const scene = new THREE.Scene();
const room = new THREE.Group();
scene.add(room);
const updates = [];
const addUpdate = (fn) => { if (typeof fn === 'function') updates.push(fn); };
let root;
try { root = mod.default({ THREE, scene, room, world, addUpdate }); } catch (e) { fail('create() threw: ' + msg(e) + where(e)); }
await settle();
if (root && typeof root.then === 'function') fail('create() must return an Object3D synchronously (not a Promise)');
if (!root || !root.isObject3D) fail('create() must return one THREE.Object3D (for example a Group) holding everything it made');
if (root.parent !== scene && root.parent !== room) scene.add(root);
if (scene.children.length > 2) report.warnings.push('create() added objects to scene/room directly; return them inside the root instead');
if (updates.length > LIMITS.updates) fail('registered ' + updates.length + ' updates; use one addUpdate for the whole creation');

// Budget, counted by CAPACITY over EVERY object (hidden ones too): an InstancedMesh counts all the instances it
// was built for, whatever .count says now; a geometry counts its whole index/position buffer, whatever its drawRange
// says now. So a creation can't pass small and grow (count, drawRange, visible) later. Measured at several points.
const peak = { drawCalls: 0, triangles: 0, points: 0, meshes: 0, instances: 0, lights: 0, shadows: 0, transmission: 0, maxTex: 0, batched: 0 };
function measure() {
  scene.updateMatrixWorld(true);
  const s = { drawCalls: 0, triangles: 0, points: 0, meshes: 0, instances: 0, lights: 0, shadows: 0, transmission: 0, maxTex: 0, batched: 0 };
  scene.traverse((o) => {
    if (o.isLight) s.lights++;
    if (o.castShadow || o.receiveShadow) s.shadows++;
    if (o.isBatchedMesh) s.batched++;
    const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
    for (const m of mats) {
      if (m.transmission > 0) s.transmission++;
      for (const k of Object.keys(m)) { const v = m[k]; if (v && v.isTexture && v.image && v.image.width) s.maxTex = Math.max(s.maxTex, v.image.width, v.image.height); }
    }
    const g = o.geometry;
    if (!g || !g.attributes) { if (o.isSprite) { s.drawCalls++; s.triangles += 2; } return; }
    const pos = g.attributes.position ? g.attributes.position.count : 0;
    const base = g.index ? g.index.count : pos;
    let inst = 1;
    if (o.isInstancedMesh) inst = Math.max(o.count || 0, o.instanceMatrix ? o.instanceMatrix.count : 0);
    if (g.isInstancedBufferGeometry) {
      let cap = 0;
      for (const k of Object.keys(g.attributes)) { const a = g.attributes[k]; if (a && a.isInstancedBufferAttribute) cap = Math.max(cap, a.count); }
      const ic = Number.isFinite(g.instanceCount) ? g.instanceCount : 0;
      inst *= Math.max(1, cap, ic);
    }
    if (o.isMesh) {
      s.meshes++;
      if (o.isInstancedMesh) s.instances += inst;
      s.drawCalls += Array.isArray(o.material) ? Math.max(1, g.groups.length) : 1;
      s.triangles += Math.floor(base / 3) * inst;
    } else if (o.isPoints) { s.drawCalls++; s.points += pos * inst; }
    else if (o.isLine) s.drawCalls++;
    else if (o.isSprite) { s.drawCalls++; s.triangles += 2; }
  });
  for (const k of Object.keys(peak)) peak[k] = Math.max(peak[k], s[k]);
}

const dt = 1 / 72;
let t = 0, measured = 0, t0 = 0;
const step = (i) => {
  for (const fn of updates) {
    try { fn(dt, t); } catch (e) { fail('an update threw at frame ' + i + ': ' + msg(e) + where(e)); }
  }
};
measure();
for (let i = 0; i < 120; i++) {
  t += dt;
  if (i === 60) { t0 = performance.now(); }
  step(i);
  if (i === 59) measure();
}
measured = (performance.now() - t0) / 60;
await settle();
measure();
// A few frames far in the future, so "after a while" behaviour is seen too.
for (const later of [10, 60, 600]) { t = later; for (let j = 0; j < 3; j++) { t += dt; step('t=' + later); } }
await settle();
measure();

const box = new THREE.Box3().setFromObject(root);
const r = (v) => Math.round(v * 100) / 100;
const { drawCalls, triangles, points, meshes, instances, lights, shadows, transmission, maxTex, batched } = peak;
report.stats = { drawCalls, triangles, points, meshes, instances, updates: updates.length, msPerFrame: r(measured), maxTexture: maxTex,
  bbox: box.isEmpty() ? null : { min: box.min.toArray().map(r), max: box.max.toArray().map(r) } };
const E = (s) => { report.ok = false; report.errors.push(s); };
if (lights) E('adds ' + lights + ' light(s) (hidden ones count too): no lights allowed; fake glow with MeshBasicMaterial, emissive and additive sprites');
if (shadows) E('uses castShadow/receiveShadow: no shadows allowed');
if (transmission) E('uses material.transmission: not allowed (too expensive in the headset)');
if (batched) E('uses BatchedMesh: use InstancedMesh for repeats');
if (drawCalls === 0) E('nothing visible was created');
if (drawCalls > LIMITS.drawCalls) E(drawCalls + ' draw calls, hidden objects included (limit ' + LIMITS.drawCalls + '): merge parts or use InstancedMesh for repeats');
if (triangles > LIMITS.triangles) E(triangles + ' triangles at full capacity, hidden objects included (limit ' + LIMITS.triangles + '): lower the segment counts or the instance count');
if (points > LIMITS.points) E(points + ' points at full capacity (limit ' + LIMITS.points + ')');
if (maxTex > LIMITS.textureSize) E('a ' + maxTex + ' px texture (limit ' + LIMITS.textureSize + ')');
if (measured > LIMITS.msPerFrame) E('updates take ' + r(measured) + ' ms per frame (limit ' + LIMITS.msPerFrame + '): allocate nothing per frame, do less work');
else if (measured > 0.6) report.warnings.push('updates are heavy (' + r(measured) + ' ms per frame)');
if (report.stats.bbox && report.stats.bbox.min.concat(report.stats.bbox.max).some((v) => !Number.isFinite(v))) E('positions became NaN or infinite during the updates');
emit();
exit(0);
`;

async function ensureThree(st) {
  if (st.threeP) return st.threeP;
  st.threeP = (async () => {
    let ver = '0.186.1';
    try { ver = /three@(\d+\.\d+\.\d+)\/build\/three\.module\.js/.exec(readFileSync(join(st.root, 'index.html'), 'utf8'))?.[1] || ver; } catch {}
    const dir = env.VIBE_THREE_DIR ? resolve(env.VIBE_THREE_DIR) : join(st.dataDir, 'vibe', `three-${ver}`);
    const files = ['three.core.js', 'three.module.js'];
    const have = (f) => { try { return statSync(join(dir, f)).size > 100_000; } catch { return false; } };
    mkdirSync(dir, { recursive: true });
    for (const f of files) {
      if (have(f)) continue;
      const url = `https://cdn.jsdelivr.net/npm/three@${ver}/build/${f}`;
      const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`${url} answered ${r.status}`);
      const body = Buffer.from(await r.arrayBuffer());
      if (body.length < 100_000) throw new Error(`${url} looks truncated`);
      const tmp = join(dir, `${f}.${process.pid}.tmp`);
      writeFileSync(tmp, body);
      renameSync(tmp, join(dir, f));
      log(`cached three@${ver}/${f} for the sandbox check`);
    }
    if (!existsSync(join(dir, 'package.json'))) { try { writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n'); } catch {} }
    return { dir, url: pathToFileURL(join(dir, 'three.module.js')).href, ver };
  })().catch((e) => {
    log(`three.js for the sandbox check is unavailable (${e.message}); runtime check skipped for now`);
    setTimeout(() => { st.threeP = null; }, 5 * 60_000).unref();
    return null;
  });
  return st.threeP;
}

async function runtimeCheck(st, three, file, slug, world) {
  const sandbox = join(st.dataDir, 'vibe', 'sandbox');
  mkdirSync(sandbox, { recursive: true });
  const runner = join(sandbox, 'runner.mjs');
  let current = '';
  try { current = readFileSync(runner, 'utf8'); } catch {}
  if (current !== RUNNER) writeFileSync(runner, RUNNER);
  const chk = join(sandbox, `chk-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`);
  mkdirSync(chk);
  const marker = `@@VIBE-${randomBytes(12).toString('hex')}@@`;
  try {
    const copy = join(chk, `${slug}.mjs`);
    writeFileSync(copy, readFileSync(file));
    writeFileSync(join(chk, 'world.json'), JSON.stringify(world ?? null));
    const r = await run(process.execPath, [
      '--permission', `--allow-fs-read=${three.dir}`, `--allow-fs-read=${runner}`, `--allow-fs-read=${chk}`,
      '--disallow-code-generation-from-strings', '--max-old-space-size=256', '--no-warnings',
      runner, three.url, pathToFileURL(copy).href, join(chk, 'world.json'), slug, JSON.stringify(LIMITS), marker,
    ], { timeoutMs: 8000, envVars: {} });
    // Trust the report only from a clean exit, and only under this run's secret marker.
    const i = r.out.lastIndexOf(marker);
    if (i >= 0 && r.code === 0 && !r.timedOut) {
      try { return JSON.parse(r.out.slice(i + marker.length).split('\n')[0]); } catch {}
    }
    if (r.timedOut) return { ok: false, errors: ['create() or an update never finished (an endless loop?)'], warnings: [], stats: {} };
    const why = (r.err.split('\n').find((l) => /Error|error/.test(l)) || r.err.trim().split('\n')[0] || `exit ${r.code}`)
      .replaceAll(chk + sep, '').replaceAll(pathToFileURL(chk).href + '/', '').slice(0, 300);
    if (/heap out of memory|Allocation failed/i.test(r.err)) return { ok: false, errors: ['ran out of memory'], warnings: [], stats: {} };
    return { ok: false, errors: [`crashed: ${why}`], warnings: [], stats: {} };
  } finally {
    rmSync(chk, { recursive: true, force: true });
  }
}

/** Full validation of one creation file. Exported for tests and the smoke script. */
export async function validateCreationFile(file, { st, ctx, world } = {}) {
  if (!st && ctx) st = getState(ctx);
  const name = file.split(sep).pop();
  const m = FILE_RE.exec(name);
  if (!m) return { ok: false, errors: [`bad file name "${name}": use short kebab-case like lantern-ring.js`], warnings: [], stats: {} };
  const slug = m[1];
  let info;
  try { info = lstatSync(file); } catch { return { ok: false, errors: [`${name} is missing`], warnings: [], stats: {} }; }
  if (!info.isFile()) return { ok: false, errors: [`${name} is not a regular file`], warnings: [], stats: {} };
  if (info.size > MAX_BYTES) return { ok: false, errors: [`${name} is ${Math.round(info.size / 1024)} KB (limit 64 KB)`], warnings: [], stats: {} };
  const src = readFileSync(file, 'utf8');
  const lint = lintCreation(src);
  if (lint.length) return { ok: false, errors: lint, warnings: [], stats: {} };
  const syntax = await syntaxCheck(file, name, st);
  if (syntax) return { ok: false, errors: [syntax], warnings: [], stats: {} };
  const three = st && CFG.runtimeCheck ? await ensureThree(st) : null;
  if (!three) return { ok: true, errors: [], warnings: ['runtime check skipped (three.js not cached)'], stats: {}, runtime: false };
  const r = await runtimeCheck(st, three, file, slug, world);
  return { ...r, runtime: true };
}

// =====================================================================================================
// The Claude Code session: one long-lived `claude -p` stream-json process, resumable across restarts.
// =====================================================================================================

const alive = (cp) => cp.exitCode === null && cp.signalCode === null;
/** Resolves when `cp` has exited (at most ~4.5 s: kill() escalates to SIGKILL after 3 s). */
function waitExit(cp) {
  if (!cp || !alive(cp)) return Promise.resolve();
  return new Promise((r) => { cp.once('exit', () => r()); setTimeout(r, 4500).unref(); });
}

// Exported as VibeClaudeSession for the sandbox probe test (same argv as production; only the appended prompt differs).
export class VibeClaudeSession {
  constructor({ cwd, stateFile, model, systemAppend }) {
    Object.assign(this, { cwd, stateFile, model, systemAppend });
    this.cp = null; this.waiter = null; this.sid = null; this.stderr = ''; this.sawOutput = false; this.startedWithResume = false;
    try { this.sid = JSON.parse(readFileSync(stateFile, 'utf8')).sid || null; } catch {}
  }

  saveSid() {
    try { mkdirSync(dirname(this.stateFile), { recursive: true }); writeFileSync(this.stateFile, JSON.stringify({ sid: this.sid, model: this.model, at: new Date().toISOString() }) + '\n'); } catch {}
  }

  args() {
    const a = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--restricted', '--tools', 'Read,Write,Edit,Glob', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
      '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands',
      '--disallowedTools', 'Edit(./README.md)', 'Write(./README.md)',
      '--model', this.model, '--append-system-prompt', this.systemAppend];
    if (this.sid) a.push('--resume', this.sid);
    return a;
  }

  start() {
    const childEnv = { ...process.env };
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'WORLD_TOKEN']) delete childEnv[k];
    this.stderr = ''; this.sawOutput = false; this.startedWithResume = Boolean(this.sid);
    const cp = spawn(CFG.claudeBin, this.args(), { cwd: this.cwd, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    this.cp = cp;
    cp.stdin.on('error', () => {});
    cp.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-4000); });
    createInterface({ input: cp.stdout }).on('line', (line) => {
      if (cp !== this.cp) return;
      let m; try { m = JSON.parse(line); } catch { return; }
      this.sawOutput = true;
      if (m.session_id && m.session_id !== this.sid) { this.sid = m.session_id; this.saveSid(); }
      this.waiter?.onMessage(m);
    });
    cp.on('error', (err) => { if (cp === this.cp) { this.cp = null; this.waiter?.onExit(-1, String(err)); } });
    cp.on('exit', (code) => { if (cp === this.cp) { this.cp = null; this.waiter?.onExit(code, this.stderr); } });
  }

  async turn(text, opts) {
    let r = await this.turnOnce(text, opts);
    if (r.kind === 'exited' && r.resumed && !r.sawOutput && r.code !== -1) {
      log('resume failed; starting a fresh Claude session');
      this.sid = null; this.saveSid();
      r = await this.turnOnce(text, opts);
    }
    return r;
  }

  turnOnce(text, { onEvent = () => {}, timeoutMs = CFG.turnTimeoutMs } = {}) {
    if (!this.cp) this.start();
    const cp = this.cp, resumed = this.startedWithResume;
    return new Promise((resolveTurn) => {
      let done = false;
      const tools = [];
      const finish = (r) => {
        if (done) return; done = true;
        clearTimeout(timer); this.waiter = null;
        resolveTurn({ resumed, sawOutput: this.sawOutput, tools, denials: [], ...r });
      };
      // On a timeout, resolve only once the child has really exited (SIGTERM, SIGKILL after 3 s): a Write landing in
      // the shutdown window must be in the post-turn snapshot, so it gets validated (or rolled back) like any other.
      const timer = setTimeout(() => { waitExit(this.kill()).then(() => finish({ kind: 'timeout' })); }, Math.max(5000, timeoutMs));
      this.waiter = {
        onMessage: (m) => {
          if (m.type === 'assistant') {
            for (const c of m.message?.content || []) {
              if (c.type !== 'tool_use') continue;
              const file = String(c.input?.file_path || '').split(/[\\/]/).pop();
              tools.push({ name: c.name, file });
              try { onEvent({ tool: c.name, file }); } catch {}
            }
          } else if (m.type === 'result') {
            finish({ kind: 'result', text: typeof m.result === 'string' ? m.result : '', isError: Boolean(m.is_error), subtype: m.subtype,
              denials: Array.isArray(m.permission_denials) ? m.permission_denials : [], ms: m.duration_ms });
          }
        },
        onExit: (code, stderr) => finish({ kind: 'exited', code, stderr: String(stderr || '').slice(-1500) }),
      };
      try {
        cp.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n');
      } catch (e) { finish({ kind: 'exited', code: -1, stderr: String(e) }); }
    });
  }

  kill() {
    const cp = this.cp;
    this.cp = null;
    if (cp && alive(cp)) {
      cp.kill('SIGTERM');
      setTimeout(() => { if (alive(cp)) cp.kill('SIGKILL'); }, 3000).unref();
    }
    return cp;
  }

  close() { return waitExit(this.kill()); }

  reset() { this.kill(); this.sid = null; this.saveSid(); }
}

// =====================================================================================================
// Per-root state, the job queue, snapshots.
// =====================================================================================================

const states = new Map();
let exitHooked = false;

function getState(ctx = {}) {
  const root = resolve(ctx.root || ROOT);
  const dataDir = resolve(root, ctx.dataDir || env.DATA_DIR || '.data');
  const key = `${root}\0${dataDir}`;
  let st = states.get(key);
  if (st) return st;
  const creationsDir = join(root, 'creations');
  mkdirSync(creationsDir, { recursive: true });
  let readme = '';
  try { readme = readFileSync(join(creationsDir, 'README.md'), 'utf8'); } catch {}
  const systemAppend = [
    'You are running in Dreamspace vibe mode. Your working directory is the creations folder of a WebXR world.',
    'The README of that folder follows; its rules are binding. It is also on disk as README.md if you want to re-read it.',
    '', readme || '(README.md is missing: write one small three.js module per creation, export default function create({ THREE, scene, room, world, addUpdate }) returning an Object3D, no imports, no lights, calm style.)',
  ].join('\n');
  st = {
    root, dataDir, creationsDir,
    session: new VibeClaudeSession({ cwd: creationsDir, stateFile: join(dataDir, 'vibe', 'session.json'), model: CFG.model, systemAppend }),
    queue: [], running: null, jobs: new Map(), notes: [], idleWaiters: [], threeP: null, lastJob: null,
  };
  states.set(key, st);
  if (!exitHooked) {
    exitHooked = true;
    process.once('exit', () => { for (const s of states.values()) s.session.kill(); });
  }
  return st;
}

function snapshotDir(dir) {
  const files = new Map();
  const walk = (abs, rel, depth) => {
    let entries = [];
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (IGNORED.has(e.name) || files.size > 400) continue;
      const a = join(abs, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { files.set(r + '/', { dir: true }); if (depth < 4) walk(a, r, depth + 1); continue; }
      try {
        const s = lstatSync(a);
        files.set(r, { mtimeMs: s.mtimeMs, size: s.size, atimeMs: s.atimeMs, link: s.isSymbolicLink(), content: s.size <= 512 * 1024 && s.isFile() ? readFileSync(a) : null });
      } catch {}
    }
  };
  walk(dir, '', 0);
  return files;
}

function diffSnapshots(before, after) {
  const changed = [];
  for (const [rel, a] of after) {
    const b = before.get(rel);
    if (a.dir) { if (!b) changed.push({ rel, kind: 'added-dir' }); continue; }
    if (!b) changed.push({ rel, kind: 'added' });
    else if (b.size !== a.size || b.mtimeMs !== a.mtimeMs || (a.content && b.content && !a.content.equals(b.content))) changed.push({ rel, kind: 'modified' });
  }
  for (const [rel, b] of before) if (!after.has(rel) && !b.dir) changed.push({ rel, kind: 'deleted' });
  return changed;
}

function restoreFile(dir, rel, prev) {
  const abs = join(dir, rel);
  if (prev?.content) {
    writeFileSync(abs, prev.content);
    try { utimesSync(abs, prev.atimeMs / 1000, prev.mtimeMs / 1000); } catch {}   // numbers keep sub-ms precision; Dates don't
  } else rmSync(abs, { force: true, recursive: true });
}

// =====================================================================================================
// One job: prompt → Claude → validate → (repair) → apply → broadcast.
// =====================================================================================================

function worldSummary(ctx) {
  try {
    const w = ctx.world?.get?.();
    if (w && Array.isArray(w.objects)) {
      const f = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0);
      const objs = w.objects.slice(0, 30).map((o) => `${o.name} at (${(o.position || []).map(f).join(', ')})`);
      const mood = w.mood ? `mood ${w.mood.preset}` : '';
      return [mood, objs.length ? `objects: ${objs.join('; ')}` : 'no objects yet'].filter(Boolean).join('; ').slice(0, 1800);
    }
    const d = ctx.world?.describe?.();
    if (d) return String(d).slice(0, 1800);
  } catch {}
  return 'unknown';
}

function worldSnapshot(ctx) {
  try {
    const w = ctx.world?.get?.();
    if (!w) return null;
    return { mood: w.mood ?? null, objects: (w.objects || []).slice(0, 40).map((o) => ({ id: o.id, name: o.name, position: o.position, scale: o.scale, rotationY: o.rotationY })) };
  } catch { return null; }
}

const creationNames = (snap) => [...snap.keys()].filter((r) => FILE_RE.test(r) && !(snap.get(r).content && TOMBSTONE_RE.test(snap.get(r).content.toString('utf8')))).sort();

function composePrompt(st, job, snap) {
  const lines = [];
  if (st.notes.length) { lines.push('(Server note: ' + st.notes.join(' ') + ')', ''); st.notes = []; }
  lines.push(`Spoken request from the ${job.from}: ${job.text}`, '',
    '(Context from the server, not the user.)',
    `World now: ${worldSummary(job.ctx)}`,
    `Creations in this folder: ${creationNames(snap).join(', ') || 'none yet'}`);
  return lines.join('\n');
}

function repairPrompt(bad) {
  const lines = ['The validator rejected some of your changes, so they are not in the world yet:'];
  for (const b of bad) lines.push(`- ${b.rel}: ${b.errors.slice(0, 4).join('; ')}`);
  lines.push('', 'Fix them now, in the same files (Read, then Edit or Write), following the README rules.',
    'Then answer again in one or two short spoken sentences.');
  return lines.join('\n');
}

async function validateChanges(st, changes, after, world) {
  const out = [];
  for (const c of changes) {
    const m = FILE_RE.exec(c.rel);
    if (c.rel === 'README.md') { out.push({ ...c, type: 'readme' }); continue; }
    if (c.kind === 'added-dir') { out.push({ ...c, type: 'stray' }); continue; }
    if (!m) {
      const looksLikeCreation = /\.m?js$/.test(c.rel) && !c.rel.includes('/');
      out.push({ ...c, type: looksLikeCreation ? 'creation' : 'stray', ok: false, slug: null,
        errors: [`bad file name "${c.rel}": creations are top-level <slug>.js files, short kebab-case like lantern-ring.js`] });
      continue;
    }
    const slug = m[1];
    if (c.kind === 'deleted') { out.push({ ...c, type: 'creation', slug, ok: true, action: 'remove' }); continue; }
    const snap = after.get(c.rel);
    if (snap?.content && TOMBSTONE_RE.test(snap.content.toString('utf8'))) { out.push({ ...c, type: 'creation', slug, ok: true, action: 'tombstone' }); continue; }
    const v = await validateCreationFile(join(st.creationsDir, c.rel), { st, world });
    out.push({ ...c, type: 'creation', slug, action: 'upsert', ...v });
  }
  return out;
}

function applyVerdicts(st, before, verdicts) {
  const events = [], accepted = [], removed = [], rejected = [];
  const dir = st.creationsDir;
  const existedBefore = (rel) => {
    const b = before.get(rel);
    return Boolean(b && !(b.content && TOMBSTONE_RE.test(b.content.toString('utf8'))));
  };
  // files first, then directories Claude may have created (deepest first)
  const ordered = [...verdicts].sort((a, b) => (a.kind === 'added-dir') - (b.kind === 'added-dir') || b.rel.length - a.rel.length);
  for (const v of ordered) {
    try {
      if (v.type === 'readme') { restoreFile(dir, v.rel, before.get(v.rel)); log('README.md was changed; restored'); continue; }
      if (v.type === 'stray') {
        if (v.kind === 'added-dir') { try { rmdirSync(join(dir, v.rel)); } catch {} } else restoreFile(dir, v.rel, before.get(v.rel));
        continue;
      }
      if (!v.ok) {
        restoreFile(dir, v.rel, before.get(v.rel));
        rejected.push({ rel: v.rel, slug: v.slug, errors: v.errors || [] });
        continue;
      }
      if (v.action === 'upsert') {
        const s = statSync(join(dir, v.rel));
        events.push({ slug: v.slug, url: `/creations/${v.rel}?v=${Math.round(s.mtimeMs)}`, action: 'upsert' });
        accepted.push({ slug: v.slug, existed: existedBefore(v.rel), stats: v.stats, warnings: v.warnings });
      } else {
        if (v.action === 'tombstone') rmSync(join(dir, v.rel), { force: true });
        if (existedBefore(v.rel)) { events.push({ slug: v.slug, url: null, action: 'remove' }); removed.push(v.slug); }
      }
    } catch (e) { log('apply failed for', v.rel, e.message); }
  }
  return { events, accepted, removed, rejected };
}

const words = (slug) => slug.replace(/-/g, ' ');

export function sanitizeReply(text) {
  let s = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*|__|~~/g, '')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\b([a-z0-9]+(?:-[a-z0-9]+)*)\.m?js\b/g, (_, s1) => words(s1))
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > 320) {
    const cut = s.slice(0, 320);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    s = end > 60 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
  }
  return s;
}

function composeReply(text, outcome, failure) {
  const { accepted, removed, rejected } = outcome;
  const changedSomething = accepted.length || removed.length;
  const failText = String(failure?.text || failure?.stderr || '');
  if (failure && /usage limit|rate limit|limit reached|out of credits|overloaded/i.test(failText)) {
    return 'I have hit my Claude usage limit for now, so vibe mode needs a little rest. Chat with the guide still works.';
  }
  if (failure?.kind === 'exited' && /ENOENT/.test(failText)) {
    return 'Vibe mode needs the Claude command line on the host computer, and I could not start it.';
  }
  if (failure?.kind === 'timeout') {
    return changedSomething ? 'That took a while, so I stopped partway; what I finished is in the world now.' : 'That one took too long to build, so I stopped. Try asking for something a little simpler.';
  }
  if (failure && !changedSomething) return 'Something went wrong while I was building that, so the world is unchanged. Try again in a moment.';
  if (rejected.length && !changedSomething) {
    const n = rejected.map((r) => (r.slug ? words(r.slug) : 'piece')).slice(0, 2).join(' and ');
    return `I tried, but the ${n} didn't pass the safety check, so the world is unchanged. Try describing it a little differently.`;
  }
  let reply = sanitizeReply(text);
  if (!reply) {
    if (accepted.length) reply = `Your ${accepted.map((a) => words(a.slug)).slice(0, 3).join(' and ')} ${accepted.length > 1 ? 'are' : 'is'} ready.`;
    else if (removed.length) reply = `The ${removed.map(words).slice(0, 3).join(' and ')} ${removed.length > 1 ? 'are' : 'is'} gone.`;
    else reply = 'Done.';
  }
  if (rejected.length) reply += ' One piece did not pass the safety check, so I left it out.';
  return reply;
}

async function runJob(st, job) {
  const ctx = job.ctx;
  const bc = (event, data) => { try { ctx.broadcast?.(event, data); } catch (e) { log('broadcast failed:', e.message); } };
  const status = (thinking, detail) => bc('status', { thinking, brain: 'claude', mode: 'vibe', ...(detail ? { detail } : {}) });
  const t0 = Date.now();
  job.state = 'running';
  status(true, 'vibe: dreaming it up');
  const before = snapshotDir(st.creationsDir);
  job.before = before;                 // listCreations() hides this job's unvalidated writes until it finishes
  if (CFG.runtimeCheck) ensureThree(st); // warm the sandbox's three.js in parallel with Claude
  const world = worldSnapshot(ctx);
  const deadline = t0 + CFG.jobTimeoutMs;
  let prompt = composePrompt(st, job, before);
  let text = '', failure = null, verdicts = [], after = before;
  const onEvent = ({ tool, file }) => {
    const slug = FILE_RE.exec(file || '')?.[1];
    const what = slug ? words(slug) : file;
    const detail = tool === 'Write' ? `vibe: writing ${what}` : tool === 'Edit' ? `vibe: shaping ${what}` : tool === 'Read' ? `vibe: reading ${what || 'the rules'}` : 'vibe: looking around';
    status(true, detail);
  };
  for (let round = 0; ; round++) {
    const r = await st.session.turn(prompt, { onEvent, timeoutMs: Math.min(CFG.turnTimeoutMs, deadline - Date.now()) });
    job.rounds = round + 1;
    job.denials.push(...(r.denials || []).map((d) => ({ tool: d.tool_name, input: d.tool_input?.file_path || d.tool_input?.path || d.tool_input?.pattern || '' })));
    job.tools.push(...(r.tools || []));
    if (r.kind !== 'result' || r.isError) failure = r;
    if (r.kind === 'result') text = r.text || text;
    after = snapshotDir(st.creationsDir);
    const changes = diffSnapshots(before, after);
    if (changes.some((c) => FILE_RE.test(c.rel))) status(true, 'vibe: checking it');
    verdicts = await validateChanges(st, changes, after, world);
    const bad = verdicts.filter((v) => v.type === 'creation' && !v.ok);
    if (!bad.length || failure || round >= CFG.repairRounds || Date.now() > deadline - 30_000) break;
    log(`repair round ${round + 1}:`, bad.map((b) => `${b.rel}: ${b.errors.join('; ')}`).join(' | '));
    status(true, `vibe: polishing ${bad.map((b) => (b.slug ? words(b.slug) : b.rel)).join(', ')}`);
    prompt = repairPrompt(bad);
  }
  const outcome = applyVerdicts(st, before, verdicts);
  if (outcome.rejected.length) {
    st.notes.push(`Rolled back (failed validation): ${outcome.rejected.map((r) => `${r.rel} (${r.errors.slice(0, 2).join('; ')})`).join(', ')}. Those files are back to their previous state.`);
  }
  for (const e of outcome.events) bc('creation', e);
  const reply = composeReply(text, outcome, failure);
  bc('chat', { id: `${job.id}-r`, role: 'guide', from: job.from, text: reply, brain: 'claude', mode: 'vibe', replyTo: job.id });
  if (failure) bc('error', { message: `vibe: ${failure.kind === 'timeout' ? 'timed out' : failure.kind === 'result' ? (failure.subtype || 'error') : 'claude exited'}` });
  status(false);
  job.state = 'done';
  job.before = null;
  job.ms = Date.now() - t0;
  job.reply = reply;
  job.outcome = { events: outcome.events, accepted: outcome.accepted, removed: outcome.removed, rejected: outcome.rejected };
  job.failure = failure ? { kind: failure.kind, subtype: failure.subtype, code: failure.code, stderr: failure.stderr, text: failure.text } : null;
  log(`job ${job.id} done in ${job.ms} ms: +${outcome.accepted.map((a) => a.slug).join(',') || '-'} -${outcome.removed.join(',') || '-'} rejected ${outcome.rejected.length}, denials ${job.denials.length}`);
}

async function pump(st) {
  if (st.running) return;
  while (st.queue.length) {
    const job = st.queue.shift();
    st.running = job;
    if (st.resetPending) { st.session.reset(); st.resetPending = false; }
    try { await runJob(st, job); } catch (e) {
      log('job crashed:', e.stack || e);
      job.state = 'error';
      try { job.ctx.broadcast?.('chat', { id: `${job.id}-r`, role: 'guide', from: job.from, text: 'Something went wrong while I was building that. Try again in a moment.', brain: 'claude', mode: 'vibe', replyTo: job.id }); } catch {}
      try { job.ctx.broadcast?.('status', { thinking: false, brain: 'claude', mode: 'vibe' }); } catch {}
    }
    st.lastJob = job;
    st.running = null;
    if (st.jobs.size > 50) st.jobs.delete(st.jobs.keys().next().value);
  }
  for (const w of st.idleWaiters.splice(0)) w();
}

// =====================================================================================================
// HTTP
// =====================================================================================================

function sendJson(res, code, body) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function tokenOk(req, token) {
  if (!token) return true;
  let given = req.headers?.['x-world-token'];
  if (!given) { try { given = new URL(req.url || '/', 'http://x').searchParams.get('t'); } catch {} }
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given), b = Buffer.from(String(token));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body) || typeof req.body === 'string') return JSON.parse(String(req.body) || '{}');
    return req.body;
  }
  if (req.readableEnded) return {};
  const chunks = [];
  let size = 0;
  await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('body timeout')), 10_000);
    req.on('data', (c) => { size += c.length; if (size > 64 * 1024) { clearTimeout(timer); fail(new Error('body too large')); req.destroy?.(); } else chunks.push(c); });
    req.on('end', () => { clearTimeout(timer); ok(); });
    req.on('error', (e) => { clearTimeout(timer); fail(e); });
  });
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function statusBody(st) {
  const j = st.lastJob;
  return {
    ok: true, busy: Boolean(st.running), queued: st.queue.length, model: CFG.model, session: Boolean(st.session.sid),
    runtimeCheck: CFG.runtimeCheck,
    lastJob: j ? { id: j.id, state: j.state, ms: j.ms, reply: j.reply, accepted: j.outcome?.accepted?.map((a) => a.slug) ?? [], rejected: j.outcome?.rejected ?? [], denials: j.denials.length } : null,
  };
}

/** POST /api/vibe {text, from?, reset?} → 202 {id}. GET /api/vibe → status. */
export async function handleVibe(req, res, ctx = {}) {
  try {
    if (!tokenOk(req, ctx.token)) return sendJson(res, 401, { error: 'unauthorized' });
    const st = getState(ctx);
    if (req.method === 'GET' || req.method === 'HEAD') return sendJson(res, 200, statusBody(st));
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    let body;
    try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: `bad body: ${e.message}` }); }
    if (!body || typeof body !== 'object') return sendJson(res, 400, { error: 'expected a JSON object' });
    const text = typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
    const from = typeof body.from === 'string' && /^[a-z]{1,16}$/.test(body.from) ? body.from : 'desktop';
    if (body.reset === true) {
      st.resetPending = true;             // applied before the next job starts (or right now when idle)
      if (!st.running) { st.session.reset(); st.resetPending = false; }
      if (!text) return sendJson(res, 200, { ok: true, reset: true });
    }
    if (!text) return sendJson(res, 400, { error: 'text is required' });
    if (text.length > CFG.maxTextChars) return sendJson(res, 400, { error: `text is longer than ${CFG.maxTextChars} characters` });
    if (st.queue.length >= CFG.maxQueue) return sendJson(res, 429, { error: 'vibe mode is busy; try again in a moment' });
    const id = `v${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
    const job = { id, text, from, ctx, state: 'queued', denials: [], tools: [], rounds: 0, at: Date.now() };
    st.jobs.set(id, job);
    st.queue.push(job);
    sendJson(res, 202, { id });
    try { ctx.broadcast?.('chat', { id, role: 'user', from, text, brain: 'claude', mode: 'vibe' }); } catch {}
    pump(st);
  } catch (e) {
    log('handleVibe error:', e.stack || e);
    sendJson(res, 500, { error: 'vibe failed' });
  }
}

// ---------- lifecycle helpers (tests, server-core shutdown) ----------

/** Resolves when no vibe job is queued or running. */
export function whenIdle(ctx) {
  const st = getState(ctx);
  if (!st.running && !st.queue.length) return Promise.resolve();
  return new Promise((r) => st.idleWaiters.push(r));
}

/** A finished or queued job by id (for tests and debugging). */
export function getVibeJob(id, ctx) { return getState(ctx).jobs.get(id) || null; }

/** Stops the Claude child(ren). Queued jobs are dropped. */
export async function closeVibe() {
  await Promise.all([...states.values()].map((st) => { st.queue.length = 0; return st.session.close(); }));
}

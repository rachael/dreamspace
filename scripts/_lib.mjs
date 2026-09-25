// Shared plumbing for the headset helpers in this folder.
//
// Every helper prints the exact command it runs, prefixed with `$`, so you can
// copy it and run it yourself. PICO CLI is preferred when it is installed; raw
// adb is the fallback, and the fallback says so out loud.
//
// Force the raw-adb path with --raw (or PICO_VIBE_RAW=1) to learn the adb side.

import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const IS_WIN = process.platform === 'win32';
export const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const color = !process.env.NO_COLOR && process.stdout.isTTY;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = { cyan: paint(36), green: paint(32), yellow: paint(33), red: paint(31), dim: paint(2), bold: paint(1) };

export const info = (msg) => console.log(msg);
export const ok = (msg) => console.log(c.green('ok   ') + msg);
export const warn = (msg) => console.log(c.yellow('warn ') + msg);
export function die(msg, code = 1) {
  console.error(c.red('fail ') + msg);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

// Tiny parser: positionals, `--flag`, `--key value`, `-d value`.
export function parseArgs(argv = process.argv.slice(2), valued = []) {
  const takes = new Set(['--device', '-d', ...valued]);
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      const [k, inline] = a.split(/=(.*)/s, 2);
      if (inline !== undefined) out.flags[k] = inline;
      else if (takes.has(k)) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

export const wantsRaw = (args) => Boolean(args.flags['--raw'] || process.env.PICO_VIBE_RAW === '1');

// ---------------------------------------------------------------------------
// finding the tools
// ---------------------------------------------------------------------------

const exe = (name) => (IS_WIN ? `${name}.exe` : name);

function onPath(names) {
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    for (const n of names) {
      const p = join(dir, n);
      if (dir && existsSync(p)) return p;
    }
  }
  return null;
}

// Same search order pico-cli 0.5.0 uses (dist/index.js, adb resolver), so the
// helpers and pico-cli always talk to the same adb server.
export function findAdb() {
  const env = process.env.ADB_PATH;
  if (env && existsSync(env)) return env;
  const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  if (sdk && existsSync(join(sdk, 'platform-tools', exe('adb')))) return join(sdk, 'platform-tools', exe('adb'));
  const found = onPath([exe('adb')]);
  if (found) return found;
  const guesses = IS_WIN
    ? [join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Android', 'Sdk', 'platform-tools', 'adb.exe')]
    : [join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'), join(homedir(), 'Android', 'Sdk', 'platform-tools', 'adb')];
  return guesses.find((p) => existsSync(p)) || null;
}

// Returns { cmd, pre, shell } or null. Where possible we run pico-cli's own
// entry point with node directly: on Windows the npm `.cmd` shim needs a shell,
// and cmd.exe mangles URLs containing `&`.
export function findPicoCli() {
  const shim = onPath(IS_WIN ? ['pico-cli.cmd', 'pico-cli'] : ['pico-cli']);
  if (!shim) return null;
  const entry = join(dirname(shim), 'node_modules', '@picoxr', 'pico-cli', 'dist', 'index.js');
  if (existsSync(entry)) return { cmd: process.execPath, pre: [entry], shell: false };
  return { cmd: shim, pre: [], shell: IS_WIN && shim.endsWith('.cmd') };
}

export function requireAdb() {
  const adb = findAdb();
  if (!adb) {
    die(
      'adb not found. Install Android platform-tools:\n' +
        '       Windows: winget install Google.PlatformTools\n' +
        '       macOS:   brew install --cask android-platform-tools\n' +
        '       then open a new terminal. (pico-cli also needs adb; it does not ship one.)',
    );
  }
  return adb;
}

// ---------------------------------------------------------------------------
// running things, loudly
// ---------------------------------------------------------------------------

const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : IS_WIN ? `"${a.replace(/"/g, '\\"')}"` : `'${a.replace(/'/g, `'\\''`)}'`);
export const show = (name, args) => info(c.cyan(`$ ${[name, ...args].map(quote).join(' ')}`));

// tool: 'adb' | 'pico-cli'. Prints the command, then runs it.
// opts.capture=true returns { status, stdout, stderr } instead of streaming.
export function run(tool, args, opts = {}) {
  show(tool, args);
  let cmd, full, shell = false;
  if (tool === 'pico-cli') {
    const p = findPicoCli();
    if (!p) die('pico-cli not found on PATH (npm install -g @picoxr/pico-cli)');
    cmd = p.cmd;
    full = [...p.pre, ...args];
    shell = p.shell;
    if (shell) full = full.map((a) => `"${a}"`);
  } else {
    cmd = tool === 'adb' ? requireAdb() : tool;
    full = args;
  }
  const r = spawnSync(cmd, full, {
    shell,
    encoding: opts.binary ? 'buffer' : 'utf8',
    stdio: opts.capture || opts.binary ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    timeout: opts.timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (r.error) return { status: 1, stdout: '', stderr: String(r.error.message) };
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// Long-running stream (logcat, perf). Resolves with the exit code.
export function stream(tool, args) {
  show(tool, args);
  const p = tool === 'pico-cli' ? findPicoCli() : { cmd: requireAdb(), pre: [], shell: false };
  const full = [...p.pre, ...args].map((a) => (p.shell ? `"${a}"` : a));
  return spawn(p.cmd, full, { shell: p.shell, stdio: ['ignore', 'pipe', 'inherit'] });
}

// Quiet adb for probes where printing every getprop would drown the lesson.
export function adbQuiet(serial, args, timeoutMs = 20000) {
  const r = spawnSync(requireAdb(), ['-s', serial, ...args], { encoding: 'utf8', timeout: timeoutMs });
  return { status: r.status ?? 1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

// ---------------------------------------------------------------------------
// which headset
// ---------------------------------------------------------------------------

export function listDevices() {
  const r = spawnSync(requireAdb(), ['devices', '-l'], { encoding: 'utf8', timeout: 20000 });
  return (r.stdout || '')
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [serial, state, ...rest] = l.split(/\s+/);
      return { serial, state, detail: rest.join(' ') };
    });
}

const HOW_TO_CONNECT = `
  1. USB-C cable from the headset to this laptop (a data cable, not charge-only).
  2. In the headset: Settings > About > tap "Software Version" 8 to 12 times
     until developer mode unlocks, then Developer > USB debugging ON.
  3. Put the headset on and ACCEPT the "Allow USB debugging?" prompt.
     (The prompt only appears inside the headset. Tick "always allow".)
  4. Re-run this command.`;

// Resolves --device / PICO_CLI_DEVICE / ANDROID_SERIAL, else the one attached unit.
export function pickDevice(args) {
  const asked = args.flags['--device'] || args.flags['-d'] || process.env.PICO_CLI_DEVICE || process.env.ANDROID_SERIAL || process.env.ADB_SERIAL;
  const all = listDevices();
  if (asked) {
    const d = all.find((x) => x.serial === asked);
    if (!d) die(`device ${asked} is not attached. adb sees: ${all.map((x) => x.serial).join(', ') || 'nothing'}`);
    if (d.state !== 'device') die(`device ${asked} is "${d.state}".${d.state === 'unauthorized' ? HOW_TO_CONNECT : ''}`);
    return asked;
  }
  if (!all.length) die(`no headset attached (adb devices is empty).${HOW_TO_CONNECT}`);
  const ready = all.filter((x) => x.state === 'device');
  if (!ready.length) die(`headset ${all[0].serial} is "${all[0].state}".${HOW_TO_CONNECT}`);
  if (ready.length > 1) {
    die(`${ready.length} devices attached (${ready.map((x) => x.serial).join(', ')}). Pick one with --device <serial>.`);
  }
  return ready[0].serial;
}

// The browser package is NOT the same on every PICO 4 Ultra (verified on IC4 vs
// IC5, projects/pico-dev/kb/gotchas/same-model-string-different-headset.md):
//   com.pico.browser.overseas   consumer A92U0 (IC4)
//   com.pico.browser            Enterprise A9210 (IC5)
//   com.picoxr.browser          PICO OS 6 (emulator); what `pico-cli web launch` targets
// Resolve it on the device, never hardcode it.
export function browserPackage(serial) {
  const r = adbQuiet(serial, ['shell', 'pm', 'list', 'packages']);
  const pkgs = r.stdout.split(/\r?\n/).map((l) => l.replace(/^package:/, '').trim());
  for (const want of ['com.pico.browser.overseas', 'com.pico.browser', 'com.picoxr.browser']) {
    if (pkgs.includes(want)) return want;
  }
  return pkgs.find((p) => /^com\.pico(xr)?\.browser/.test(p)) || null;
}

export function identify(serial) {
  const get = (p) => adbQuiet(serial, ['shell', 'getprop', p]).stdout;
  const code = get('pxr.vendorhw.product.name');
  return {
    serial,
    code, // A92U0 consumer, A9210 Enterprise. ro.product.model says A9210 on BOTH
    name: get('sys.pxr.product.name'),
    os: get('ro.build.display.id'),
    android: get('ro.build.version.release'),
  };
}

export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function capturesDir() {
  const dir = join(process.cwd(), 'captures');
  mkdirSync(dir, { recursive: true });
  return dir;
}

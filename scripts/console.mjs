#!/usr/bin/env node
// Stream the PICO browser's console.log / errors to your laptop terminal.
// Inside the headset there is no DevTools, so this is how you see why a scene is black.
//
//   node scripts/console.mjs              auto: DevTools first, logcat if that is unavailable
//   node scripts/console.mjs --cdp        DevTools protocol only (the page's own console)
//   node scripts/console.mjs --logcat     Android logcat, tag "chromium"
//   node scripts/console.mjs --match ts.net   only pages whose URL contains this
//   [--device <serial>] [--port 9559] [--raw]
//
// --cdp forwards the browser's DevTools socket (adb forward) and listens. The
// socket only exists while the PICO browser is running, and its name changes
// every browser restart, so it is looked up fresh each time. It is the same
// socket chrome://inspect uses; open that in desktop Chrome for the full inspector.
//
// Ctrl+C to stop.

import { spawnSync } from 'node:child_process';
import { adbQuiet, c, die, findAdb, findPicoCli, info, ok, parseArgs, pickDevice, run, stream, wantsRaw, warn } from './_lib.mjs';

const args = parseArgs(undefined, ['--port', '--match']);
const serial = pickDevice(args);
const port = Number(args.flags['--port'] || 9559);
const match = args.flags['--match'] || '';
const mode = args.flags['--cdp'] ? 'cdp' : args.flags['--logcat'] ? 'logcat' : 'auto';

if (mode !== 'logcat') {
  const started = await tryCdp();
  if (started) process.exitCode = 0;
  else if (mode === 'cdp') die('DevTools not reachable (see above). Try --logcat.');
  else logcat();
} else logcat();

// ---------------------------------------------------------------------------

async function tryCdp() {
  if (typeof WebSocket !== 'function') {
    warn(`Node ${process.version} has no built-in WebSocket (needs Node 22+). Falling back.`);
    return false;
  }
  const unix = adbQuiet(serial, ['shell', 'cat', '/proc/net/unix']).stdout;
  const sock = (unix.match(/(\w*devtools_remote(?:_\d+)?)/) || [])[1];
  if (!sock) {
    warn('no DevTools socket on the headset. Is the PICO browser open? (Remote debugging can also be off on this unit.)');
    return false;
  }
  const f = run('adb', ['-s', serial, 'forward', `tcp:${port}`, `localabstract:${sock}`], { capture: true });
  if (f.status !== 0) {
    warn(`adb forward failed: ${f.stderr.trim()}`);
    return false;
  }
  const cleanup = () => spawnSync(findAdb(), ['-s', serial, 'forward', '--remove', `tcp:${port}`]);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });

  let targets;
  try {
    targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  } catch (e) {
    warn(`DevTools did not answer on :${port}: ${e.message}`);
    cleanup();
    return false;
  }
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes(match));
  if (!pages.length) {
    warn(`no open tab${match ? ` matching "${match}"` : ''}. Tabs: ${targets.map((t) => t.url).join(', ') || 'none'}`);
    cleanup();
    return false;
  }
  ok(`listening to ${pages.length} tab(s) over DevTools. Reload the page in the headset to see startup errors.`);
  for (const p of pages) attach(p);
  return true;
}

function attach(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const tag = c.dim(`[${new URL(page.url).host || page.url}]`);
  let id = 0;
  ws.onopen = () => {
    ws.send(JSON.stringify({ id: ++id, method: 'Runtime.enable' })); // replays earlier console calls too
    ws.send(JSON.stringify({ id: ++id, method: 'Log.enable' }));
  };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
      print(m.params.type, text, tag);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      print('error', `${d.exception?.description || d.text} (${d.url || ''}:${d.lineNumber + 1})`, tag);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      print(e.level, `${e.text}${e.url ? ` (${e.url})` : ''}`, tag);
    }
  };
  ws.onclose = () => info(c.dim(`${tag} DevTools connection closed (tab navigated or browser closed)`));
}

function print(level, text, tag) {
  const paint = level === 'error' ? c.red : level === 'warning' || level === 'warn' ? c.yellow : (s) => s;
  console.log(`${tag} ${paint(`${level.padEnd(5)} ${text}`)}`);
}

function logcat() {
  // Chromium on Android writes to logcat under the "chromium" tag. Whether the
  // PICO browser routes page console.log there is not verified on our units;
  // if this stays quiet while the page logs, use --cdp.
  const child = findPicoCli() && !wantsRaw(args)
    ? stream('pico-cli', ['log', '--device', serial, '--follow', '--tag', 'chromium', '--lines', '50'])
    : stream('adb', ['-s', serial, 'logcat', '-T', '50', '-s', 'chromium']);
  child.stdout.on('data', (buf) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (!line) continue;
      const paint = /CONSOLE|Uncaught|Error/.test(line) ? (/Uncaught|Error/.test(line) ? c.red : c.bold) : c.dim;
      console.log(paint(line));
    }
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

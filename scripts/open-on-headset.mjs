#!/usr/bin/env node
// Open a URL in the PICO browser on the attached headset. No typing on a VR keyboard.
//
//   node scripts/open-on-headset.mjs http://localhost:5173
//   node scripts/open-on-headset.mjs https://my-laptop.tail1234.ts.net/
//   node scripts/open-on-headset.mjs <url> --device PA92U0XXXXXXXX  [--raw] [--no-check]
//
// For http://localhost:<port> it sets up `adb reverse` first, because localhost
// is the only plain-http origin the browser treats as secure. Any other http://
// origin loads fine and silently has NO navigator.xr, so no Enter VR button.
//
// Deliberately NOT `pico-cli web launch --url`: on 0.5.0 that command installs a
// 336 MB PicoBrowser.apk (com.picoxr.browser, the OS 6 browser) onto the device
// first, and rewrites localhost to 10.0.2.2, the emulator's alias for the host.
// See docs/PICO-CLI.md.

import { browserPackage, c, die, findPicoCli, info, ok, parseArgs, pickDevice, run, wantsRaw, warn } from './_lib.mjs';

const args = parseArgs();
const raw = args._[0];
if (!raw) die('usage: node scripts/open-on-headset.mjs <url> [--device <serial>] [--raw] [--no-check]');

let url;
try {
  url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`);
} catch {
  die(`not a URL: ${raw}`);
}

const serial = pickDevice(args);
const local = ['localhost', '127.0.0.1'].includes(url.hostname);
const port = url.port || (url.protocol === 'https:' ? '443' : '80');

if (url.protocol === 'http:' && !local) {
  warn(`${url.origin} is plain http on a non-localhost host, so the PICO browser will hide navigator.xr.`);
  warn('The page loads but "Enter VR" never appears. Use http://localhost:<port> (this script reverses it)');
  warn('or an https:// tailnet URL from `tailscale serve`.');
}

if (local) {
  // Headset's localhost:<port> -> this laptop's localhost:<port>. Dies with the USB cable.
  const r = run('adb', ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
  if (r.status !== 0) die('adb reverse failed. Is the cable still in?');
  ok(`headset localhost:${port} now reaches this laptop`);
}

// Ask the HEADSET, not the laptop, whether the page answers. A 200 on the laptop
// proves nothing about what the headset can reach.
if (!args.flags['--no-check']) {
  const probe = run('adb', ['-s', serial, 'shell', `curl -s -o /dev/null -w '%{http_code}' '${url.href}'`], { capture: true, timeoutMs: 20000 });
  const code = probe.stdout.trim();
  if (/^[23]\d\d$/.test(code)) ok(`headset fetched it: HTTP ${code}`);
  else if (/not found/i.test(probe.stdout + probe.stderr)) warn('no curl on this headset, skipping the reachability check');
  else warn(`headset could not fetch it (got "${code || probe.stderr.trim() || 'nothing'}"). Is your server running? Opening anyway.`);
}

// Implicit VIEW intent, the form verified on IC4 (kb/gotchas/webxr-needs-secure-context-use-adb-reverse.md).
// Single quotes keep `&` and `?` intact through the headset's shell.
const intent = `am start -a android.intent.action.VIEW -d '${url.href.replace(/'/g, '%27')}'`;
const usePico = findPicoCli() && !wantsRaw(args);
if (!usePico && !wantsRaw(args)) info(c.dim('pico-cli not found, using raw adb (same result).'));
const r = usePico
  ? run('pico-cli', ['device', 'shell', intent, '--device', serial], { capture: true })
  : run('adb', ['-s', serial, 'shell', intent], { capture: true });
const out = `${r.stdout}\n${r.stderr}`.trim();
if (out) info(c.dim(out));

if (r.status !== 0 || /Error|Exception|unable to resolve/i.test(out)) {
  // Fall back to naming the browser explicitly. Its package differs per unit, so ask the device.
  const pkg = browserPackage(serial);
  if (!pkg) die('the default VIEW intent failed and no PICO browser package was found on this device');
  warn(`default intent failed, retrying pinned to ${pkg}`);
  const again = run('adb', ['-s', serial, 'shell', `${intent} -p ${pkg}`], { capture: true });
  const out2 = `${again.stdout}\n${again.stderr}`.trim();
  if (out2) info(c.dim(out2));
  if (again.status !== 0 || /Error|Exception/i.test(out2)) die('could not open the URL on the headset');
}

ok(`sent ${url.href} to ${serial}. Put the headset on: the page is in the browser window.`);
info(c.dim('A resolved intent means the browser was asked, not that the page rendered. `node scripts/snap.mjs` shows what the headset sees.'));

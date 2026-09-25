#!/usr/bin/env node
// Make the headset's localhost:<port> reach this laptop's localhost:<port> over USB.
//
//   node scripts/usb-reverse.mjs          (port 5173)
//   node scripts/usb-reverse.mjs 8080     [--device <serial>] [--remove]
//
// Why: WebXR only runs in a secure context. http://localhost counts as one;
// http://192.168.x.x does not, and the browser hides navigator.xr without an
// error. adb reverse is device -> laptop; adb forward is the other direction and
// will not help. It dies with the cable, so re-run after any replug.
//
// pico-cli has no documented reverse command (only a hidden `pico-cli adb
// reverse` passthrough), so this one is raw adb on purpose.

import { die, info, ok, parseArgs, pickDevice, run, warn } from './_lib.mjs';

const args = parseArgs();
const port = String(args._[0] || process.env.PORT || 5173);
if (!/^\d+$/.test(port)) die('usage: node scripts/usb-reverse.mjs [port]');
const serial = pickDevice(args);

if (args.flags['--remove']) {
  run('adb', ['-s', serial, 'reverse', '--remove', `tcp:${port}`]);
  process.exit(0);
}

const r = run('adb', ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`]);
if (r.status !== 0) die('adb reverse failed');
run('adb', ['-s', serial, 'reverse', '--list']);

// Confirm from the HEADSET's side, not the laptop's.
const probe = run('adb', ['-s', serial, 'shell', `curl -s -o /dev/null -w '%{http_code}' http://localhost:${port}/`], { capture: true, timeoutMs: 15000 });
const code = probe.stdout.trim();
if (/^[23]\d\d$/.test(code)) ok(`headset sees your server: http://localhost:${port}/ -> HTTP ${code}`);
else warn(`tunnel is up but nothing answered on the laptop's port ${port} yet (got "${code || 'no response'}"). Start your server (npm run dev).`);

info(`\nNext: node scripts/open-on-headset.mjs http://localhost:${port}`);

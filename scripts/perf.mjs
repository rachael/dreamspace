#!/usr/bin/env node
// Live performance numbers for the PICO browser while your scene runs.
//
//   node scripts/perf.mjs 30              [--device <serial>]
//
// Wraps `pico-cli perf live run`, scoped to the browser package (resolved on the
// device, since it differs per unit). There is no raw-adb equivalent worth
// teaching; without pico-cli, watch your own frame time in the page instead.
// First run may ask you to run `pico-cli perf doctor` to install the profiler.

import { browserPackage, die, findPicoCli, info, parseArgs, pickDevice, run } from './_lib.mjs';

const args = parseArgs();
const secs = String(Math.max(1, Math.round(Number(args._[0] || 30))));
if (!findPicoCli()) die('perf needs pico-cli (npm install -g @picoxr/pico-cli). No raw adb fallback for this one.');
const serial = pickDevice(args);
const pkg = browserPackage(serial);
if (!pkg) die('no PICO browser package on this device');

info(`Put the headset on and Enter VR first; the numbers only mean something while the scene is presenting.`);
const r = run('pico-cli', ['perf', 'live', 'run', '--device', serial, '--package', pkg, '--duration', secs]);
if (r.status !== 0) {
  info('\nIf that complained about dependencies: pico-cli perf doctor   (then retry)');
  process.exit(r.status);
}

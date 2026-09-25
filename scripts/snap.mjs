#!/usr/bin/env node
// Screenshot what the headset is showing -> ./captures/<timestamp>.png
//
//   node scripts/snap.mjs                 [--device <serial>] [--raw] [--out file.png]
//
// On a PICO 4 Ultra this is the STEREO eye buffer: both eyes side by side
// (4320x2160 on IC4), with live passthrough. 2D panels may not composite into
// it, so a plain-looking room does not mean your page failed to load.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { c, capturesDir, die, findPicoCli, info, ok, parseArgs, pickDevice, run, stamp, wantsRaw } from './_lib.mjs';

const args = parseArgs(undefined, ['--out', '-o']);
const serial = pickDevice(args);
const out = args.flags['--out'] || args.flags['-o'] || join(capturesDir(), `${stamp()}.png`);

if (findPicoCli() && !wantsRaw(args)) {
  const r = run('pico-cli', ['capture', 'screenshot', '--device', serial, '--out', out]);
  if (r.status !== 0) die('pico-cli capture screenshot failed. Retry with --raw to use adb directly.');
} else {
  if (!wantsRaw(args)) info(c.dim('pico-cli not found, using raw adb.'));
  // exec-out, not shell: shell mangles binary on some hosts.
  const r = run('adb', ['-s', serial, 'exec-out', 'screencap', '-p'], { binary: true, timeoutMs: 90000 });
  if (r.status !== 0 || r.stdout.subarray(0, 4).toString('latin1') !== '\x89PNG') die(`screencap returned no PNG ${String(r.stderr).trim()}`);
  writeFileSync(out, r.stdout);
  info(c.dim(`(adb writes the PNG to stdout; this script saved it to ${out})`));
}

// Width/height live in the PNG header at bytes 16..24.
const head = readFileSync(out).subarray(0, 24);
const w = head.readUInt32BE(16), h = head.readUInt32BE(20);
ok(`${out}  (${w}x${h}${w === 2 * h ? ', left eye | right eye' : ''})`);

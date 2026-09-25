#!/usr/bin/env node
// Record the headset view -> ./captures/<timestamp>.mp4
//
//   node scripts/record.mjs 15            [--device <serial>] [--raw] [--out file.mp4]
//
// Seconds default to 15. pico-cli accepts 1-1800; raw adb screenrecord stops at
// 180 on stock Android, so the --raw path caps there.

import { join } from 'node:path';
import { c, capturesDir, die, findPicoCli, info, ok, parseArgs, pickDevice, run, stamp, wantsRaw } from './_lib.mjs';

const args = parseArgs(undefined, ['--out', '-o']);
const secs = Math.max(1, Math.round(Number(args._[0] || 15)));
if (!Number.isFinite(secs)) die('usage: node scripts/record.mjs <seconds>');
const serial = pickDevice(args);
const out = args.flags['--out'] || args.flags['-o'] || join(capturesDir(), `${stamp()}.mp4`);

info(`recording ${secs}s from ${serial}. Whoever is wearing it: go.`);

if (findPicoCli() && !wantsRaw(args)) {
  const r = run('pico-cli', ['capture', 'record', '--device', serial, '--time', String(secs), '--out', out]);
  if (r.status !== 0) die('pico-cli capture record failed. Retry with --raw to use adb directly.');
} else {
  if (!wantsRaw(args)) info(c.dim('pico-cli not found, using raw adb: record on the headset, pull, delete.'));
  const capped = Math.min(secs, 180);
  const remote = `/sdcard/pico-vibe-${stamp()}.mp4`;
  const rec = run('adb', ['-s', serial, 'shell', 'screenrecord', '--time-limit', String(capped), remote], { timeoutMs: (capped + 30) * 1000 });
  if (rec.status !== 0) die('screenrecord failed on the headset');
  const pull = run('adb', ['-s', serial, 'pull', remote, out]);
  run('adb', ['-s', serial, 'shell', 'rm', '-f', remote]); // our own temp file, nothing else
  if (pull.status !== 0) die('could not pull the recording off the headset');
}

ok(out);

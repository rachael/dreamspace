#!/usr/bin/env node
// Is this laptop + headset ready for the Vibe XR loop? One command, one checklist.
//
//   node scripts/doctor.mjs               [--device <serial>] [--quick]
//
// --quick skips `pico-cli doctor`, which fetches its plugin repo and takes a while.
// Read-only on the headset: getprop, pm list, dumpsys battery, reverse --list.

import { spawnSync } from 'node:child_process';
import { adbQuiet, browserPackage, c, findAdb, findPicoCli, identify, info, listDevices, parseArgs, run } from './_lib.mjs';

const args = parseArgs();
const checks = [];
const check = (level, what, fix = '') => checks.push({ level, what, fix });

info(c.bold('\n== laptop'));
const major = Number(process.versions.node.split('.')[0]);
check(major >= 20 ? 'ok' : 'fail', `node ${process.version}`, major >= 20 ? '' : 'install Node 20+ (22 for scripts/console.mjs --cdp)');

const pico = findPicoCli();
if (pico) {
  const v = run('pico-cli', ['--version'], { capture: true });
  check('ok', `pico-cli ${(v.stdout.match(/pico-cli\/[\d.]+/) || ['?'])[0]}`);
} else {
  check('warn', 'pico-cli not installed; helpers will use raw adb', 'npm install -g @picoxr/pico-cli');
}

const adb = findAdb();
if (adb) {
  const v = spawnSync(adb, ['version'], { encoding: 'utf8' });
  check('ok', `adb ${(v.stdout.match(/version ([\d.]+)/) || [, '?'])[1]} at ${adb}`);
} else {
  check('fail', 'adb not found', 'Windows: winget install Google.PlatformTools  |  macOS: brew install --cask android-platform-tools');
}

const ts = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['tailscale'], { encoding: 'utf8' });
check(ts.status === 0 ? 'ok' : 'warn', ts.status === 0 ? 'tailscale CLI present (wireless path: npm run serve)' : 'no tailscale CLI; use the USB path (npm run usb)');

if (pico && !args.flags['--quick']) {
  info(c.bold('\n== pico-cli doctor'));
  info(c.dim('It checks the PICO Spatial SDK toolchain. "blocking issues" about Spatial SDK, Editor, plugin or project'));
  info(c.dim('context do NOT matter for WebXR: tonight is a web page in the PICO browser, not a Spatial app.'));
  run('pico-cli', ['doctor']);
}

info(c.bold('\n== headset'));
if (adb) {
  if (pico) run('pico-cli', ['device', 'list']);
  else run('adb', ['devices', '-l']);
  const all = listDevices();
  const want = args.flags['--device'] || args.flags['-d'];
  const pool = want ? all.filter((d) => d.serial === want) : all;
  if (!pool.length) check('fail', 'no headset on USB', 'cable in, USB debugging on, accept the prompt INSIDE the headset');
  if (!want && all.filter((d) => d.state === 'device').length > 1) check('warn', `${all.length} devices attached`, 'pass --device <serial> to every script');
  for (const d of pool) {
    if (d.state !== 'device') {
      check('fail', `${d.serial} is "${d.state}"`, d.state === 'unauthorized' ? 'put the headset on and accept "Allow USB debugging"' : 'replug the cable');
      continue;
    }
    const id = identify(d.serial);
    const sku = id.code === 'A92U0' ? 'consumer' : id.code === 'A9210' ? 'Enterprise' : 'unknown SKU';
    check('ok', `${d.serial}: ${id.name || 'PICO'} (${id.code || '?'}, ${sku}), OS ${id.os || '?'}, Android ${id.android || '?'}`);
    const pkg = browserPackage(d.serial);
    check(pkg ? 'ok' : 'fail', pkg ? `browser package ${pkg}` : 'no PICO browser package found');
    if (pkg === 'com.picoxr.browser') check('warn', 'this looks like PICO OS 6 (emulator or Swan unit), not the lending fleet');
    const batt = (adbQuiet(d.serial, ['shell', 'dumpsys', 'battery']).stdout.match(/level: (\d+)/) || [])[1];
    if (batt) check(Number(batt) >= 30 ? 'ok' : 'warn', `battery ${batt}%`, Number(batt) >= 30 ? '' : 'swap for a charged unit before your turn');
    const rev = adbQuiet(d.serial, ['reverse', '--list']).stdout;
    check(rev.includes('tcp:5173') ? 'ok' : 'warn', rev.includes('tcp:5173') ? 'adb reverse tcp:5173 active' : 'no adb reverse for :5173 yet', 'node scripts/usb-reverse.mjs');
  }
}

info(c.bold('\n== checklist'));
const mark = { ok: c.green('[ok]  '), warn: c.yellow('[warn]'), fail: c.red('[FAIL]') };
for (const k of checks) info(`${mark[k.level]} ${k.what}${k.fix ? c.dim(`\n       -> ${k.fix}`) : ''}`);
const fails = checks.filter((k) => k.level === 'fail').length;
info(fails ? c.red(`\n${fails} blocking. Fix the [FAIL] lines above.`) : c.green('\nReady. Next: npm run dev, then node scripts/open-on-headset.mjs http://localhost:5173'));
process.exit(fails ? 1 : 0);

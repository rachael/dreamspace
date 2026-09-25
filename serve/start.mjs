// Start the static server and publish it to a PICO headset.
//   node serve/start.mjs            -> tailnet HTTPS via `tailscale serve` (no cable)
//   node serve/start.mjs --usb      -> `adb reverse` over a USB cable (localhost is a secure context)
//   node serve/start.mjs --https-port 8443   -> pick the tailnet HTTPS port yourself
//   node serve/start.mjs --dry-run  -> print the tailscale command instead of running it
// WebXR only runs in a secure context, so http://<LAN IP>:5173 will NOT offer Enter VR/AR.
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const USB = args.includes('--usb');
const DRY = args.includes('--dry-run');
const PORT = Number(process.env.PORT || 5173);
const portArg = args.indexOf('--https-port');
const WANT_HTTPS = portArg >= 0 ? Number(args[portArg + 1]) : null;
const CANDIDATES = WANT_HTTPS ? [WANT_HTTPS] : [443, 5443, 10443, 9443];

const run = (cmd, a) => spawnSync(cmd, a, { encoding: 'utf8', shell: false });
const has = (cmd) => !run(cmd, ['version']).error;

// 1. the static server, in this process group so Ctrl+C stops both
const server = spawn(process.execPath, [fileURLToPath(new URL('./serve.mjs', import.meta.url))], {
  stdio: 'inherit', env: { ...process.env, PORT: String(PORT) },
});
server.on('exit', (code) => process.exit(code ?? 0));

let cleanup = () => {};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); server.kill(); process.exit(0); });

setTimeout(USB ? usb : tailnet, 400);

function usb() {
  const line = `adb reverse tcp:${PORT} tcp:${PORT}`;
  if (!has('adb')) {
    console.log(`\nUSB mode: adb is not on PATH. Install platform-tools, plug in the headset, then run:\n  ${line}`);
  } else {
    const devices = run('adb', ['devices']).stdout.split('\n').filter((l) => /\tdevice$/.test(l));
    if (!devices.length) console.log('\nUSB mode: no headset in `adb devices`. Plug it in, accept the USB debugging prompt in the headset, then re-run.');
    const r = run('adb', ['reverse', `tcp:${PORT}`, `tcp:${PORT}`]);
    console.log(r.status === 0 ? `\nUSB mode: ran \`${line}\`.` : `\nUSB mode: \`${line}\` failed: ${(r.stderr || '').trim()}`);
    cleanup = () => run('adb', ['reverse', '--remove', `tcp:${PORT}`]);
  }
  console.log(`In the PICO browser open:  http://localhost:${PORT}\n(localhost over adb reverse counts as a secure context, so Enter VR / Enter AR work.)`);
}

function tailnet() {
  if (!has('tailscale')) {
    console.log('\nTailscale CLI not found. Install Tailscale and log in (https://tailscale.com/download), or use `npm run usb` with a cable.');
    return;
  }
  const st = run('tailscale', ['status', '--json']);
  let self;
  try { self = JSON.parse(st.stdout).Self; } catch { /* fall through */ }
  const host = (self?.DNSName || '').replace(/\.$/, '');
  if (!host) {
    console.log('\nTailscale is not logged in or MagicDNS is off. Run `tailscale up`, enable MagicDNS + HTTPS certificates in the admin console, then re-run.');
    return;
  }

  // Never clobber a port this machine already serves (or funnels to the internet).
  let cfg = {};
  try { cfg = JSON.parse(run('tailscale', ['serve', 'status', '--json']).stdout || '{}'); } catch { /* empty config */ }
  const busy = (p) => Boolean(cfg.TCP?.[p] || cfg.Web?.[`${host}:${p}`] || cfg.AllowFunnel?.[`${host}:${p}`]);
  const mine = (p) => cfg.Web?.[`${host}:${p}`]?.Handlers?.['/']?.Proxy?.endsWith(`:${PORT}`);
  const httpsPort = CANDIDATES.find((p) => mine(p)) ?? CANDIDATES.find((p) => !busy(p));
  if (!httpsPort) {
    console.log(`\nEvery candidate HTTPS port (${CANDIDATES.join(', ')}) is already served on this machine. Pick a free one: npm run serve -- --https-port 12443`);
    return;
  }
  const cmd = ['serve', '--bg', `--https=${httpsPort}`, `http://localhost:${PORT}`];
  if (DRY) {
    console.log(`
[dry run] would run: tailscale ${cmd.join(' ')}
[dry run] URL: https://${host}${httpsPort === 443 ? '' : `:${httpsPort}`}/`);
    return;
  }
  if (!mine(httpsPort)) {
    const r = spawnSync('tailscale', cmd, { stdio: 'inherit' });
    if (r.status !== 0) {
      console.log('\n`tailscale serve` failed. Common fixes:\n'
        + '  - Linux: sudo tailscale set --operator=$USER   (then re-run)\n'
        + '  - "Serve is not enabled": open the link it printed and enable HTTPS for your tailnet\n'
        + '  - Or skip the tailnet: npm run usb');
      return;
    }
  }
  cleanup = () => run('tailscale', ['serve', `--https=${httpsPort}`, 'off']);
  const url = `https://${host}${httpsPort === 443 ? '' : `:${httpsPort}`}/`;
  console.log(`\nOpen this in the PICO browser (headset must be on the same tailnet):\n\n  ${url}\n`
    + '\nThe first load can take ~10s while Tailscale fetches the HTTPS certificate.'
    + '\nCtrl+C stops the server and removes the tailnet mapping.');
}

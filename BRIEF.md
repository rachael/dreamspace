# Project brief: WebXR spatial app

What the owner has said, collected in one place. The agent team reads this first, then `CLAUDE.md`.
Started 2026-09-24, at the PICO "Claude for Spatial Computing" workshop (Homebrew Club SF).

## The goal
- Build a **WebXR spatial app** (three.js, runs in a headset browser). This was always the goal.
- Reference: https://pico-workshops.vercel.app/. It's cloned locally at `../pico-workshops/` (same content).
  Use it as **reference only**: don't tour it or copy it in wholesale (that burns context).
- The owner will give a **metaprompt** describing the app. Paste it under "The metaprompt" below.
  Then fan out **a team of agents, as many as useful, all out**. Not a minimal, one-agent pass.

## Hardware
- The owner has a **Meta Quest 3**. There is **no PICO**, and there never was one. PICO 4 Ultras are loaners to try at the event.
- So: build and test on Quest 3 (Meta Quest Browser), and stay within PICO browser limits so it also runs on the loaners.
- Mac: 16 GB RAM, lots already running. Don't ask her to close apps. ~60 GB disk free.

## What's set up (verified 2026-09-24)
- `webxr-app/` is a lean copy of the workshop's Vibe XR starter (three.js 0.186.1 via import map, no build step).
- `npm run dev` serves http://localhost:5173.
- `src/emulator.js`: when no real headset is present, it loads Meta's IWER + DevUI (emulated Quest 3). **Enter VR / Start AR work on the Mac.**
  It does nothing on a real headset. `?noemu` turns it off. First load takes a few seconds (esm.sh).
- `adb` is installed. Quest hookup: developer mode on (Meta Horizon app), USB-C, accept "Allow USB debugging",
  then `npm run usb` and open `http://localhost:5173` in the Quest Browser. **Not connected yet.**
- PICO emulator chain: parked, and not needed for WebXR. `pico-cli` 0.5.x and Android Studio 2025.1 are installed; the SDK, emulator and AVD are not.
- The WebSpatial Academy labs (`../pico-workshops/webspatial-academy`) have their dependencies installed. WebSpatial is PICO/visionOS-only, so on a Quest those pages are flat.

## How she wants to work
- Start from what she gives (URL, starter prompt, metaprompt). Don't invent an app or scaffold on your own.
- Don't waste time or context. Act, keep updates short, and ask one question early if something is truly unclear.
- Go big when she asks for it: parallel agents, full effort.
- End substantial work with a short **Lessons** section.

## Her ideas (credit where due)
- **Reference site + starter prompt as the entry point.** Hand the agent a working reference and one prompt instead of re-explaining.
- **A lean project folder to save context.** Keep the big workshop outside; agents read it only on demand.
- **A metaprompt, then a fanned-out team.** One description of the app, many agents building it in parallel.
- **Save everything in one brief** (this file), so no session has to re-learn it.

## Playbook: how the team builds it
1. **Metaprompt → spec.** One agent turns the metaprompt into a short feature list, each feature a self-contained module.
2. **Fan out.** One agent per feature, each writing its own `src/features/<name>.js` that exports `init({ scene, room, renderer, camera, grabbables })`
   and an optional `update(dt, t)`. `main.js` just imports and calls them. Keep them in separate files so agents don't collide.
3. **Verify each feature on the Mac.** Load http://localhost:5173 in Chrome, check for zero console errors, press Enter VR in the emulator, take a screenshot.
4. **Adversarial review.** A separate agent checks each feature against `CLAUDE.md`'s hard constraints (perf budget, `optionalFeatures` only, no camera moves in VR).
5. **Integrate + headset pass.** One agent merges everything. Then plug in the Quest, `npm run usb`, and test for real.
6. **Lessons** appended below.

## The metaprompt
_(paste here when given)_

## Lessons so far
- Start from the site's own starter prompt / the owner's metaprompt. Don't explore the whole workshop first.
- Ask about the device up front (Quest 3, not PICO). That decides WebXR vs WebSpatial and whether any emulator is needed.
- Chrome on a Mac exposes `navigator.xr` with no device: IWER needs `installRuntime({ forceInstall: true })`.
  The jsDelivr `+esm` build of `@iwer/devui` loads two copies of React and crashes, so load it from esm.sh with `?deps=iwer@<ver>`.

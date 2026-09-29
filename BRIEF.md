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

## Claude's suggestions (take or leave)
- **Build for WebXR, not WebSpatial.** WebXR runs fully on the Quest 3; WebSpatial pages are flat outside PICO/visionOS.
- **Emulated Quest 3 on the Mac (IWER).** Already wired in, so the whole team can press Enter VR without the headset.
  Alternative: Meta's "Immersive Web Emulator" Chrome extension.
- **Target Quest first and stay within the PICO limits.** One app that runs on both her headset and the event loaners.
- **One file per feature** (see the playbook), so parallel agents never edit the same lines.
- **Quest over USB now, over Wi-Fi later.** `npm run usb` needs no setup beyond developer mode. For cable-free testing, install Tailscale on
  the Mac + Quest and use `npm run serve` (HTTPS URL).
- **Quest-only extras as optional add-ons:** the Quest Browser also offers depth sensing, mesh detection and anchors that PICO refuses.
  Use them in `optionalFeatures` behind a feature check, never as a requirement.
- **Commit after each feature** (git is initialised), so a bad agent edit is a one-line revert.

## Playbook: how the team builds it
1. **Metaprompt → spec.** One agent turns the metaprompt into a short feature list, each feature a self-contained module.
2. **Fan out.** One agent per feature, each writing its own `src/features/<name>.js` that exports `init({ scene, room, renderer, camera, grabbables })`
   and an optional `update(dt, t)`. `main.js` just imports and calls them. Keep them in separate files so agents don't collide.
3. **Verify each feature on the Mac.** Load http://localhost:5173 in Chrome, check for zero console errors, press Enter VR in the emulator, take a screenshot.
4. **Adversarial review.** A separate agent checks each feature against `CLAUDE.md`'s hard constraints (perf budget, `optionalFeatures` only, no camera moves in VR).
5. **Integrate + headset pass.** One agent merges everything. Then plug in the Quest, `npm run usb`, and test for real.
6. **Lessons** appended below.

## The metaprompt
Workshop template (from the site):
```
Build a new web spatial app using pico cli in the emalutor that does: {enter idea here}. use the vercel link as context on how to build things in Web Spatial.

  we are going to dynamically create team agents, assign roles to each for research, mapping codebase, understanding various independent workflows and build the app. verify each feature
  before declaring it complete.
```

Her instructions (2026-09-24, verbatim):
```
fan out as many agents as possible do it in webxr get it all working do it as well as you possibly can

lets make a spatial app where you can bridge from voice mode in the app on mobile (ios/android, either works tbh but ios preferred) hands-free chat and we can explore a spatial experience together, eventually we're going to use meshy for asset generation, for now just do it in a modular way where we can sub in different tools later

for now the quest has no battery so in webxr yeah

I'm not sure what you can do in terms of asset generation, probably not that amazing. mvp is also to just use whatever local model and free voice as well or literally if claude code has a hands free mode, I'm not really sure, if CLI does have hands free or you can bridge yourself there... just dont use the API, lets stick to the claude subscription or use free local tools for voice

anyway super cool to be able to just explore a spatial world either with you or with a local voice agent, then eventually bridge you there or bridge the claude from the mobile app (for now I have my airpods and would have to be ios, maybe more difficult)

if you cant do voice text is ok too

also private github repo and run this in the cloud if you can (ideal) just call it whatever i dont have any other webxr demo app repo on gh so there wont be a name collision

afaik i dont have any local modal such as qwen/ollama so just gfi and get one if i dont and you need it

lets go, dude
```

## Style direction (her words, 2026-09-24)
"for environment lets make it kind of soothing, cool and with a general scifi + fantasy vibe ... whatever you can do and do well, yk"
→ Calm twilight palette (deep teal → violet), bioluminescent crystals, floating islands, fireflies, a ringed planet or moons, a soft aurora. Slow motion, nothing jarring. Do fewer things, and do them beautifully, within the headset perf budget.

## Vision, next layer (her idea, 2026-09-24)
"maybe we can build a vibe coding app where I can literally vibe build a webxr app with you with meshy using voice coding to just vibe modify things or add assets"
→ Vibe mode (see docs/CONTRACT.md): voice → Claude Code writes sandboxed three.js creations → they hot-load in the world.
Meshy: she's getting a free Pro month **when Meshy reaches out, not before**. Don't sign up; the `meshy` asset provider waits for `MESHY_API_KEY`.

## Voice-swappable looks + hackathon (her words, 2026-09-29)
"the looks can be swapped depending on what I say to the voice agent running the experience :) we will go through the environment together. The voice agent can narrate and be the one taking the ideas. Orchestrate with the other claude code agent who is building an app for a hackathon right now! It's going to use this as one of the frontend surfaces."
→ Themes + a narrated guide tour (CONTRACT "Themes"). Keep the HTTP/SSE/MCP API stable for the hackathon app.
Repo: github.com/rachael/dreamspace (private, SSH).

## Lessons so far
- Start from the site's own starter prompt / the owner's metaprompt. Don't explore the whole workshop first.
- Ask about the device up front (Quest 3, not PICO). That decides WebXR vs WebSpatial and whether any emulator is needed.
- Chrome on a Mac exposes `navigator.xr` with no device: IWER needs `installRuntime({ forceInstall: true })`.
  The jsDelivr `+esm` build of `@iwer/devui` loads two copies of React and crashes, so load it from esm.sh with `?deps=iwer@<ver>`.

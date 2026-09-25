# theme/

`pico.css` holds CSS custom properties and the classes `.pico-btn` `.pico-btn--ghost` `.pico-btn--danger` `.pico-panel` `.pico-chip` `.pico-kbd` `.pico-display`.
`pico-theme.js` holds the `PICO` hex map, `applyPicoFog(scene, THREE, {ar})` and `picoMaterial(THREE, 'glass'|'glow'|'matte')`.

On 2026-09-24 these values were re-themed to the real PICO brand from https://www.picoxr.com/global. I fetched the HTML and its 7 stylesheets and read the computed styles in headless Chrome. This kit uses the site's **dark** register (hero video, game-art cards, footer). The full extraction lives in `projects/pico-webspatial-academy/theme/README.md`. It covers both registers, has a screenshot comparison, and lists every selector.

Tags: **SOURCE** means seen in PICO's CSS. **DERIVED** means our choice, with the reason given. **PICO-SDK** means a number from the Spatial SDK docs.

| Token | Value | Source | Use |
|---|---|---|---|
| `--pico-bg` / `PICO.bg` | `#000000` | SOURCE (site black, footer) | page + scene background, fog |
| `--pico-surface` / `PICO.surface` | `rgba(35,37,38,.72)` / `#232526` | SOURCE `.media-modal-container` | glass panel |
| `--pico-surface-2` | `rgba(58,60,62,.80)` | DERIVED (one step up) | raised card, chips |
| `--pico-ink` / `PICO.ink` | `#ffffff` | SOURCE hero text | text |
| `--pico-ink-dim` | `#b3b3b3` | SOURCE card desc (white at 70% alpha, flattened) | secondary text, 9.7:1 |
| `--pico-accent` | `#7458ff` | DERIVED from `#4200ff` | accent **text** and outlines. It is 4.6:1 on black, and raw `#4200ff` is only 2.6:1 |
| `--pico-accent-fill` (new) / `PICO.accent` | `#4200ff` | SOURCE `.button-container` | button fills and 3D matte. White on it is 7.9:1 |
| `--pico-accent-2` / `PICO.accent2` | `#3d8bff` | SOURCE `.switch-button:checked` | second series, code |
| `--pico-glow` / `PICO.glow` | `#a393ff` | DERIVED violet tint | hover rims, emissive 3D |
| `--pico-danger` / `PICO.danger` | `#ff4d4f` | SOURCE `.field-error` | errors |
| `--pico-ok` | `#b8f000` | DERIVED (Motion Tracker lime) | success |
| `--pico-warn` | `#ffb020` | DERIVED | warning |
| `--pico-rule` | `rgba(255,255,255,.20)` | SOURCE `.side-line` | dividers |
| `--pico-radius` | `16px` | SOURCE `.wrapper` | cards |
| `--pico-radius-lg` | `32px` | PICO-SDK | panels (the window radius is 32 dp) |
| `--pico-radius-pill` (new) | `100px` | SOURCE `.button-container` | buttons |
| `--pico-target` | `56px` | PICO-SDK | minimum tap target |
| fonts | Figtree / Inter / JetBrains Mono | DERIVED / SOURCE / DERIVED | PICO Sans (`PICO-Sans-VFS.ttf`) is PICO's licensed face, so do not embed it. Figtree is the closest Google Font. Inter is the site's own UI face. |

Buttons are PICO's pill. `.pico-btn` is the violet fill, and on hover it gets a 12% black overlay (the site's own hover). `.pico-btn--ghost` is the 1px violet outline pill from the site's cookie sheet.

In `immersive-ar`, call `applyPicoFog(scene, THREE, { ar: true })`. It clears the background and fog so the room shows through.

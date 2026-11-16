# Royal Glass — CyberAnchorage UI system

The frontend's visual and motion system. The direction is **Royal Midnight Glass**: a deep midnight canvas, frosted panels with a fine specular edge, teal for energy, royal violet for depth and gold as the crown, used sparingly. It should feel calm, expensive and dense, at Wazuh/CrowdStrike density with native-app polish. Every effect has to earn its frame budget.

- Tokens: `src/styles/globals.css`, the single source, consumed by Tailwind through `tailwind.config.ts`.
- Kit: `src/components/ui/`. This follows the repo convention (DECISIONS #24), not a new `src/ui/`. It is shown on the dev-only route `/dev/ui-kit`.
- Runtime: `src/lib/perf.ts` (perf tier and Visual effects) and `src/lib/motion.ts` (counters, settle, stagger, view transitions, batching, spotlight).
- Checks: `npm run check:contrast` (WCAG on composited glass plus colour-vision simulation) and `scripts/perf/` (mock API, screenshots and the perf run).
- Published design-system reference: the "Royal Glass" artifact. That document is the canonical spec, and this file is how the spec is implemented here.

## 1. Colour

Values are space-separated RGB (`--x: r g b`) so Tailwind can apply alpha (`bg-primary/15`). The two themes are **Royal Midnight** (`data-theme="dark"`, the default) and **Ivory Pearl** (`light`).

| Role | Token (Tailwind) | Dark | Light | Use |
| --- | --- | --- | --- | --- |
| Canvas | `--bg` (`bg-bg`) | #060914 | #F6F3EC | Behind the ambient orbs |
| Raised canvas | `--bg-1`, `--bg-2` | #0B1026 / #121A3A | #EFEAE0 / #E6E0D3 | Gutters, deepest tint; contrast is measured over `bg-2` + orbs |
| Text | `--fg` / `--fg-muted` / `--fg-subtle` | #EEF2FF / #A9B4D6 / #8390B8 | #0B1026 / #3B4468 / #565F82 | Values and headings / cells and descriptions / captions and timestamps |
| Teal (energy) | `--primary` (+ `-text`, `-fg`) | #34A99D, text #5FE0CF | #156B63 | Live, active, positive; teal **text** always uses `text-primary-text` |
| Violet (depth) | `--violet` (+ `-text`) | #7C6CF2, text #A99BFF | #5B4BD6 | Rule operators, groups, selection |
| Gold (crown) | `--highlight` (+ `-soft`, `warning-ink`) | #E5CB90 | #B8943F (decorative only) | Gradient end, focus ring, AND/OR pills, demo badge |
| Steel | `--secondary` (+ `-text`) | #458393 | #357080 | Type badges, attribution bars |
| Brand gradient | `.bg-brand` (`--grad-1..3`, `--on-brand`) | teal → violet → gold | #156B63 → #5B4BD6 → #8A6A1E | **Only** logo tile, primary CTA, active-nav bar, hero chart series |
| Verdict marks | `--ver-*` (`bg-ver-*`) | malicious #FF4D6D · suspicious #FFB020 · abnormal #B58CFF | #C8173F · #B86E00 · #7E4BD1 | Icons, dots, bars |
| Verdict labels | `--ver-*-text` | #FF7A90 · #FFB020 · #C3A2FF | #A8102F · #7F4A00 · #6A35C0 | Badge label on its 12% tint |
| Severity | `--sev-*` | critical = malicious, high = suspicious, medium = abnormal, low = teal | same mapping | Bars glyph + word |
| Focus | `--ring` | gold #E5CB90 | #7A5C14 | 2px solid outline, offset 2px |
| Control | `--control`, `--control-border` | #121A3A / #6B78A8 | #FCFAF6 / #757B91 | Inputs, table header, secondary buttons (border 3:1+) |
| Charts | `--chart-1..6`, `--chart-ord-1..4` | teal, violet, gold, sapphire, amber, pearl | darker set | Categorical series (CVD-checked), plus a single-hue violet ordinal ramp for severity/verdict (DECISIONS #31) |

Verdicts and severities never rely on colour alone: they always pair an icon and a word, and severity adds a 4-step bar glyph.

## 2. Glass tiers

| Tier | Class | Fill | Blur | Use for |
| --- | --- | --- | --- | --- |
| **G0 · solid** | `.glass-solid` | `--glass-solid` @ 0.92 / 0.94 | none | Tables, rule trees, logs, live feeds, chart panels |
| **G1 · panel** | `.glass` | `--glass` @ 0.55 / 0.62 + 2% grain | `--blur-g1` 14px · saturate 1.2 | Sidebar, header, KPI band, hero cards, toasts, filter bar |
| **G2 · floating** | `.glass-strong` | `--glass-strong` @ 0.78 / 0.80 | `--blur-g2` 22px | Drawers, the palette, menus, tooltips. **One on screen**, above a scrim |

Rules:

1. **At most 6 blurred surfaces per viewport and at most 1 G2.** `?perf=1` counts them live.
2. **Never nest blur** (no `.glass` inside `.glass`). Never blur rows, list items, chips or anything rendered per data item.
3. **Blur never moves.** Glass in motion paints its solid fallback (`.settling`, via `settle()` in `lib/motion.ts`) and picks up the blur when it settles.
4. **Orbs drift only while the user is idle** (`components/Ambient.tsx`). Any input pauses them, and they resume after 2 s.
5. **The edge is cheap:** a 1px `--glass-border` plus an inset 1px specular highlight top-left, with no pseudo-element. The spotlight edge (`.spot`) is opt-in, and one rAF loop writes `--mx/--my` on the hovered card only.
6. **Nothing inside a G1 surface repaints on hover or per frame.** Charts, live text and hover tints belong on G0. Measured at 4× CPU: a chart inside a G1 card cost about 10 fps on hover, and KPI hover tints cost another 15 fps.
7. **Page scroll counts as motion.** While the document scrolls, G1 panels inside `<main>` paint their fallback. Blur returns 150 ms after scrolling stops. The sticky header and sidebar keep theirs.
8. **Fallbacks keep the look.** Without `backdrop-filter`, at Effects Off, under `prefers-reduced-transparency` and while settling, glass paints `--glass-fallback-top → --glass-fallback-bottom` with the same edge and shadow. `forced-colors` turns glass into `Canvas` with a `CanvasText` border.

### Visual effects (Settings › Visual effects; `html[data-effects]`)

| Effects | Chosen by Auto when | Blur | Orbs | Spotlight and conic edges | Animation |
| --- | --- | --- | --- | --- | --- |
| **Full** | high tier | 14 / 22px | drift when idle | on | all |
| **Reduced** | medium tier | 8px everywhere | static | off | all except loops |
| **Off** | low tier, or `prefers-reduced-transparency` | none (fallback gradient) | static | off | none (instant) |

`usePerfTier`-equivalent logic lives in `lib/perf.ts` and `store/ui.ts`. The tier starts from `hardwareConcurrency`/`deviceMemory` and is refined by measuring 60 frames after `load`: a median over 18.5 ms or a p90 over 26 ms means medium, and a median over 26 ms or a p90 over 40 ms means low. The lower of the hint and the measurement wins. The preference is persisted as `ca-effects` (`auto | full | reduced | off`). Switching changes paint only, never layout.

## 3. Type

- **Instrument Sans Variable** (UI, 400–700) and **JetBrains Mono Variable** (IOC values), self-hosted with `@fontsource-variable`. Only the `wght` axis files are imported, and each loads its subsets lazily via `unicode-range`.
- Scale: page title 22–24/30 semibold · card title 15–17/24 semibold · `text-kpi` 28/32 tabular · body 14/20 · compact cells 13/18 · `text-label` 11/16, uppercase, 0.08em · mono 12.5/18 with ligatures off.
- Write numbers with grouping and tabular numerals. IOC values appear exactly as stored (defanged) in mono.
- IOC table rows are **32px compact** (the default) or **42px comfortable**, persisted as `ca-density`. Compact is 2px over the design system's 30px so that the 24×24 row actions (the WCAG 2.2 minimum target size) and their focus ring fit.

## 4. Motion

| Token | Value | Use |
| --- | --- | --- |
| `--dur-1` / `duration-1` | 120ms | Press, hover tint, tooltip, badge morph, route exit |
| `--dur-2` | 200ms | Route enter, menus, palette, toasts |
| `--dur-3` | 320ms | Drawer open (from its row), sidebar collapse |
| `--dur-4` | 500ms | KPI counters, chart draw-in |
| `ease-standard` | cubic-bezier(.2,0,0,1) | Default |
| `ease-emphasized` | cubic-bezier(.3,0,0,1) | Entrances |
| `ease-exit` | cubic-bezier(.4,0,1,1) | Exits |
| `ease-snappy` / `ease-gentle` | `linear()` spring stand-ins (520/38, 220/28) | Press release, collapse / rule-builder layout |

- Animate **only transform and opacity**. Tiny elements may also change colour or filter. Never animate size, position, blur radius or shadow.
- **Route changes** animate with the CSS `.route-enter` on the keyed route outlet (fade + 8px rise + .995 scale, 200ms, `backwards` fill). The **theme switch** uses the View Transitions API through `withViewTransition()`.
  - *Deliberate deviation:* true View Transitions for routes need React Router's data router (`createBrowserRouter` plus `viewTransition` on links). `BrowserRouter` with `v7_startTransition` commits navigation as a transition, so `flushSync` inside `startViewTransition` cannot capture the new state. Converting the router is outside this UI pass.
- Entrance animations fill `backwards`, never `both`. A filling transform animation keeps its element a containing block for `position: fixed` descendants after it ends.
- **Charts** draw in once per mount. Live updates and hover states apply without animation: ECharts' state transitions interpolate the brand-gradient series and threw errors.
- **Stagger:** `enterStyle(i)` animates the first 12 items 32ms apart, and the rest render instantly.
- **Counters:** `useCounter()` writes `textContent` from rAF, so React never re-renders per frame.
- **Live data:** WebSocket events go through `createBatcher(flush, 250)` before touching React Query.
- **Libraries:** CSS handles everything simple. `motion` (LazyMotion + domAnimation, `m.*` only) is loaded **only** by the rule editor for drag-and-drop layout animation with dnd-kit. No Lenis, GSAP, Lottie, Three.js or whole icon packs.
- `prefers-reduced-motion` collapses durations to ~0 and stops loops. Effects Off removes every non-essential animation.

## 5. Performance contract (hard gates)

| Gate | Budget |
| --- | --- |
| Frame rate during interaction | 60 fps (p95 frame ≤ 16.8 ms) |
| INP p75 | < 200 ms |
| LCP | < 2.0 s |
| CLS | < 0.05 |
| Initial JS | ≤ 180 KB gzip |
| Blurred surfaces | ≤ 6 per viewport, ≤ 1 G2 |

### Audit baseline (before this migration, commit `dbba844`)

- `tsc`, `eslint` and Vitest (7/7) green.
- **Initial JS 131.3 KB gzip** (app 77.4 + vendor 53.9) and CSS 23.1 KB gzip.
- **The Overview route chunk was 177.6 KB gzip because ECharts loaded with the default route**, which delays LCP on `/`.
- Glass: a single tier with an 18px blur, plus a blurred sticky header containing a second `.glass` (nested blur). The Overview showed 15 blurred surfaces in a 1440×900 viewport (measured by `perf:run` on `dbba844`).
- Inter variable and static JetBrains Mono 400/500 (all subsets bundled as woff and woff2).
- React Router v7 future-flag warnings in the console on every page.

Measured results after the migration are recorded in §7.

## 6. Accessibility

- `npm run check:contrast` parses `globals.css` for both themes and composites each ground as painted: `bg-2` plus the orb peaks, with each tier's fill on top. It then checks text at 4.5:1 and marks, focus ring and control borders at 3:1. It also simulates protan, deutan and tritan vision on `chart-1..6` and requires CIEDE2000 ≥ 8. It exits 1 on failure.
- Focus is always visible as a 2px gold `--ring`. The full keyboard flows (table rows, drawer, palette, rule builder) are listed in §7.
- Animated live regions (live dot, toasts, result counts) are `aria-live="polite"`. KPI counters animate an `aria-hidden` copy and expose the final value once.

## 7. Results

All numbers come from this repo at the final commit, measured in a cloud container: headless Chromium with **software rasterisation (no GPU)**, 4 cores. That is harsher than real hardware for `backdrop-filter`, because every blur runs on the CPU. The API is the deterministic mock in `scripts/perf/`, with 100,000 IOCs and a live WebSocket. The backend (Postgres, Redis, CTI) does not run here.

Reproduce:

```bash
npm run build
```

```bash
npx vite preview --port 4173
```

```bash
npm run perf:serve
```

```bash
npm run perf:run
```

```bash
npm run perf:screens
```

The first two commands serve the build. `perf:serve` starts the mock API on :8077 for Lighthouse and manual runs. `perf:run` writes Chrome traces and `results.json` to `perf-results/`, and `perf:screens` captures 72 screenshots. Lighthouse 12.2.1 ran with `--preset=desktop`, the default mobile profile, and mobile with `--throttling-method=devtools`.

### Gates

| Gate | Result | Status |
| --- | --- | --- |
| Initial JS ≤ 180 KB gzip | **129.2 KB** (app 75.3 + vendor 53.9). Baseline was 131.3 KB | ✅ |
| CLS < 0.05 | Lighthouse desktop 0.001–0.005. Mobile 0.001–0.032. Applied 4G + 4× CPU: 0.032 (was 0.108: the demo banner pushed the page) | ✅ |
| LCP < 2.0 s, desktop | Lighthouse desktop **0.5–0.6 s** on Overview, IOC Explorer and Rules | ✅ |
| LCP < 2.0 s, mobile | Applied throttling (4× CPU, 150 ms RTT, 1.6 Mbps): Overview **1.82–1.86 s** over 5 runs. **Lighthouse mobile: 2.5–3.4 s** (simulated) and 2.6–3.1 s (DevTools) | ⚠️ misses in Lighthouse's mobile profile, see below |
| INP p75 < 200 ms | Worst single interaction at 4× CPU, across navigation, drawer, keyboard row nav, column resize, density, palette, rule DnD and sidebar collapse: **184 ms (Full)**, 176 ms (Reduced), 144 ms (Off). Was 376 ms mid-migration | ✅ |
| 60 fps during interaction (4× CPU) | Off: Overview 59.3, shell 53.9, rules 51.2, IOC flick 50.8. Reduced: Overview 57.5. **Full: 29.5–51.1** (software-rasterised blur) | ⚠️ Full misses on this rig; Auto picks Off here (below) |
| ≤ 6 blurred surfaces, ≤ 1 G2 | Peak per scenario: 3–5 blurred, 1 G2 (drawer). Baseline Overview had **15** | ✅ |
| Effects Off: no backdrop-filter, no non-essential animation, no layout change | `/`, `/iocs`, `/rules/2`, `/sync`: **0 layout diffs** (295–600 boxes compared), 0 backdrop-filters, 0 running animations | ✅ |
| WCAG AA on real glass | `check:contrast` 216/216. Lighthouse accessibility **100** on every audited page and profile | ✅ |
| Console | 72 screenshots (12 pages × 3 breakpoints × 2 themes): no errors, warnings or horizontal overflow | ✅ |
| tsc · eslint · Vitest | clean · clean · 7/7 | ✅ |

### Interaction run (`npm run perf:run`, 4× CPU, 1440×900)

| Scenario | Full fps / p95 | Reduced fps / p95 | Off fps / p95 | Long tasks (Full) | Worst interaction (Full) |
| --- | --- | --- | --- | --- | --- |
| Overview hover + scroll | 51.1 / 33 ms | 57.5 / 17 ms | 59.3 / 17 ms | 1 | — |
| IOC 100k, fast flick (12.5k px/s) | 29.5 / 67 ms | 31.3 / 67 ms | 50.8 / 33 ms | 1 | — |
| IOC 100k, extreme wheel (56k px/s) | 17.9 / 133 ms | 18.9 / 117 ms | 23.0 / 117 ms | 33 | — |
| IOC drawer from row, ↑↓ ×20, resize, density, ⌘K | 28.2 / 83 ms | 31.1 / 83 ms | 40.4 / 100 ms | 21 | 144 ms |
| Rules → editor, keyboard DnD, add condition | 37.4 / 50 ms | 44.2 / 50 ms | 51.2 / 33 ms | 5 | 128 ms |
| Shell: 4 routes, collapse, expand | 42.9 / 50 ms | 46.4 / 33 ms | 53.9 / 17 ms | 5 | 184 ms |

Same harness on the pre-migration app (`dbba844`, Full): Overview **22.5 fps** with 15 blurred surfaces, and IOC flick **12.1 fps** with **159 long tasks**.

**Auto on this machine:** the probe picks **Reduced** unthrottled (4 cores, so the medium tier). With 4× throttling applied before load it measures the frames and picks **Off**. A device this slow therefore gets the Off column automatically, and Full is an explicit choice. Full still needs confirming on GPU hardware: in Chrome with GPU raster, backdrop blur is a compositor pass rather than CPU work.

### Lighthouse 12.2.1

| Page | Desktop: perf · a11y · BP · LCP · CLS | Mobile (simulated): perf · LCP · TBT | Mobile (DevTools): perf · LCP · TBT |
| --- | --- | --- | --- |
| Overview | 100 · 100 · 100 · 0.5 s · 0.005 | 91 · 3.4 s · 50 ms | 80 · 3.0 s · 400 ms |
| IOC Explorer | 100 · 100 · 100 · 0.6 s · 0.001 | 92 · 3.2 s · 10 ms | 86 · 3.1 s · 150 ms |
| Rules | 100 · 100 · 100 · 0.6 s · 0.001 | 96 · 2.5 s · 10 ms | 92 · 2.6 s · 80 ms |

The only remaining best-practices finding is `font-size` on IOC Explorer mobile: badges use 11.5px text.

### Why mobile LCP misses in Lighthouse, and what would fix it

This is an auth-gated SPA. Before anything can paint, the browser needs the HTML, the bundle, the route chunk and the session refresh. Lighthouse's mobile model costs each round trip 150–560 ms and delivers the 129 KB bundle at 1.6 Mbps. Its FCP alone, the "Loading" splash, is 1.8–2.4 s. This pass removed three serial steps:
- The session refresh starts from `index.html` while the bundle downloads.
- The current route's chunk is modulepreloaded from an inline route map.
- The palette and ECharts left the critical path.

Getting under 2.0 s in that profile would take one of:
- server-rendering the shell and skeleton,
- `103 Early Hints` from nginx for the bundle and route chunk,
- a much smaller critical bundle (for example, deferring React Query and Radix behind the first paint).

All three are architecture changes beyond a UI system pass.

### What was measured and changed along the way

- **ECharts** moved out of the default route (Overview chunk 177.6 → 5.4 KB gzip) and initialises on idle (mobile TBT about 730 → 400 ms).
- **IOC table:**
  - The virtualised body is its own component.
  - Scroll offsets coalesce to one update per frame (TanStack Virtual `flushSync`ed per scroll event, and each `scrollTop` read forced a layout).
  - Rows reuse DOM through slot keys.
  - Row cells use native titles instead of three Radix tooltip roots per row.
  - Result: long tasks during a flick went from 159 to 1.
- **Overview:** blur budget restored (15 → 4) and nothing repaints inside G1 (rule 6 above).
- **Demo-data banner** became a header chip with a tooltip (CLS).
- **Command palette** (cmdk) is lazy, preloaded on hover or focus of the search box.
- **Bugs fixed:**
  - ECharts state/update interpolation errors.
  - Sparklines invisible at Effects Off.
  - Pulse rings showing at full size when motion is off.
  - Opacity modifiers (`/12`, `/8`) that Tailwind silently dropped.
  - `aria-selected` on table rows.
  - Labelled spans without a role.
  - 22px row action targets.
  - Account menu name not containing its visible text.
  - React Router future-flag warnings.

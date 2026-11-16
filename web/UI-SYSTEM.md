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
6. **Fallbacks keep the look.** Without `backdrop-filter`, at Effects Off, under `prefers-reduced-transparency` and while settling, glass paints `--glass-fallback-top → --glass-fallback-bottom` with the same edge and shadow. `forced-colors` turns glass into `Canvas` with a `CanvasText` border.

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
- **Route changes** use the View Transitions API through `withViewTransition()`. The fallback is the CSS `.route-enter` on the keyed route container (fade + 8px rise + .995 scale, 200ms).
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
- Glass: a single tier with an 18px blur, plus a blurred sticky header containing a second `.glass` (nested blur). Overview showed 14 blurred surfaces in a 1440×900 viewport.
- Inter variable and static JetBrains Mono 400/500 (all subsets bundled as woff and woff2).
- React Router v7 future-flag warnings in the console on every page.

Measured results after the migration are recorded in §7.

## 6. Accessibility

- `npm run check:contrast` parses `globals.css` for both themes and composites each ground as painted: `bg-2` plus the orb peaks, with each tier's fill on top. It then checks text at 4.5:1 and marks, focus ring and control borders at 3:1. It also simulates protan, deutan and tritan vision on `chart-1..6` and requires CIEDE2000 ≥ 8. It exits 1 on failure.
- Focus is always visible as a 2px gold `--ring`. The full keyboard flows (table rows, drawer, palette, rule builder) are listed in §7.
- Animated live regions (live dot, toasts, result counts) are `aria-live="polite"`. KPI counters animate an `aria-hidden` copy and expose the final value once.

## 7. Results

To be filled in by the measurement step.

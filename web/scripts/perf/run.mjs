// Interaction perf run under 4× CPU throttle against the mock API (100 000 IOCs).
// Needs a running build: `npm run build && npx vite preview --port 4173`, then
//   node scripts/perf/run.mjs [outDir]
// Per scenario it records fps / p95 frame / worst frame, long tasks, worst interaction latency
// (Event Timing — an INP proxy), the peak number of blurred and G2 surfaces, and a Chrome trace.
// It then checks Effects: Off — no backdrop-filter, no running animations, identical layout.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { installMockApi } from "./mock-api.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:4173";
const OUT = process.argv[2] ?? "perf-results";
const CPU = Number(process.env.CPU ?? 4);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

async function open(path, effects = "full", viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push((e.stack ?? e.message).split("\n").slice(0, 4).join(" | ")));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript((fx) => {
    localStorage.setItem("ca-effects", fx);
    localStorage.setItem("ca-theme", "dark");
    window.__perf = { frames: [], longs: [], events: [], blur: 0, g2: 0 };
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__perf.longs.push(e.duration))).observe({ type: "longtask", buffered: false });
    new PerformanceObserver((l) => l.getEntries().forEach((e) => e.interactionId && window.__perf.events.push([e.name, Math.round(e.duration)]))).observe({ type: "event", durationThreshold: 16 });
  }, effects);
  await installMockApi(page, { iocCount: 100_000, liveEveryMs: 1500 });
  await page.goto(BASE + path);
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1200);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });
  return { ctx, page, errors };
}

/** Start sampling frames + blurred-surface counts; returns a stop() that yields the metrics. */
async function sample(page) {
  await page.evaluate(() => {
    const P = window.__perf;
    P.frames = []; P.longs = []; P.events = []; P.blur = 0; P.g2 = 0; P.on = true;
    let last = performance.now();
    const loop = (t) => { if (!P.on) return; P.frames.push(t - last); last = t; requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    P.iv = setInterval(() => {
      let n = 0, g2 = 0;
      document.querySelectorAll(".glass,.glass-strong").forEach((el) => {
        const bf = getComputedStyle(el).backdropFilter;
        if (!bf || bf === "none") return;
        const r = el.getBoundingClientRect();
        if (!r.width || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return;
        n++; if (el.classList.contains("glass-strong")) g2++;
      });
      P.blur = Math.max(P.blur, n); P.g2 = Math.max(P.g2, g2);
    }, 250);
  });
  return async () => page.evaluate(() => {
    const P = window.__perf; P.on = false; clearInterval(P.iv);
    const f = P.frames.slice(1).sort((a, b) => a - b);
    const sum = f.reduce((a, b) => a + b, 0);
    return {
      fps: +(1000 * f.length / sum).toFixed(1), p95: +f[Math.floor(f.length * 0.95)].toFixed(1), worst: +f[f.length - 1].toFixed(1), frames: f.length,
      longTasks: P.longs.length, longestTask: Math.round(Math.max(0, ...P.longs)), worstInteraction: Math.max(0, ...P.events.map((e) => e[1])),
      slowest: P.events.sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e.join(":")).join(" "),
      maxBlurred: P.blur, maxG2: P.g2, tableRowsInDom: document.querySelectorAll('[role="table"] [role="row"][data-index]').length,
    };
  });
}

const results = [];
const ONLY = process.env.ONLY; // run a single scenario by name substring
async function scenario(name, path, steps, effects = "full") {
  if (ONLY && !name.includes(ONLY)) return;
  const { ctx, page, errors } = await open(path, effects);
  await browser.startTracing(page, { path: `${OUT}/trace-${name}-${effects}.json`, screenshots: false, categories: ["devtools.timeline", "disabled-by-default-devtools.timeline.frame"] });
  const stop = await sample(page);
  await steps(page);
  const m = await stop();
  await browser.stopTracing();
  results.push({ scenario: name, effects, ...m, errors: errors.length });
  console.log(name.padEnd(30), effects.padEnd(5), JSON.stringify(m), errors.length ? errors.slice(0, 2) : "");
  await ctx.close();
}

const wheel = async (page, x, y, step, n) => { await page.mouse.move(x, y); for (let i = 0; i < n; i++) { await page.mouse.wheel(0, step); await page.waitForTimeout(16); } };

const overview = async (page) => {
  for (let i = 0; i < 60; i++) { await page.mouse.move(300 + i * 18, 260 + (i % 6) * 12); await page.waitForTimeout(16); } // KPI band spotlight + hover
  await wheel(page, 800, 600, 120, 30); await wheel(page, 800, 600, -120, 30);
};
const iocScroll = (step) => async (page) => { await wheel(page, 800, 600, step, 150); };
const iocInteract = async (page) => {
  await page.locator('[role="row"][data-index="3"]').click(); await page.waitForTimeout(700);   // drawer from row
  await page.keyboard.press("Escape"); await page.waitForTimeout(500);
  await page.locator('[role="row"][data-index="2"]').focus();
  for (let i = 0; i < 20; i++) { await page.keyboard.press("ArrowDown"); await page.waitForTimeout(30); }   // keyboard row nav
  await page.keyboard.press("Enter"); await page.waitForTimeout(700); await page.keyboard.press("Escape"); await page.waitForTimeout(400);
  const h = await page.locator('[role="separator"]').first().boundingBox();                         // column resize
  await page.mouse.move(h.x + 4, h.y + 6); await page.mouse.down(); await page.mouse.move(h.x + 80, h.y + 6, { steps: 20 }); await page.mouse.up();
  await page.getByRole("radio", { name: "Comfortable" }).click(); await page.waitForTimeout(300);     // density
  await page.keyboard.press("Control+k"); await page.waitForTimeout(500); await page.keyboard.type("tor", { delay: 40 }); await page.waitForTimeout(300); await page.keyboard.press("Escape");
};
const rules = async (page) => {
  await page.getByText("Known C2 on non-standard ports").click(); await page.waitForTimeout(900);    // route transition
  const grip = page.getByRole("button", { name: "Reorder type" });
  await grip.focus(); await page.keyboard.press("Space"); await page.waitForTimeout(150); await page.keyboard.press("ArrowDown"); await page.waitForTimeout(200); await page.keyboard.press("Space"); await page.waitForTimeout(400);
  await page.getByRole("button", { name: /Condition$/ }).first().click(); await page.waitForTimeout(400);  // add (motion enter)
  await page.getByRole("link", { name: "Overview" }).click(); await page.waitForTimeout(900);
};
const shell = async (page) => {
  for (const name of ["IOC Explorer", "Rules", "Sync & Sources", "Overview"]) { await page.getByRole("link", { name }).click(); await page.waitForTimeout(700); }
  await page.getByRole("button", { name: "Collapse sidebar" }).click(); await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Expand sidebar" }).click(); await page.waitForTimeout(500);
};

for (const fx of (process.env.EFFECTS ?? "full,reduced,off").split(",")) {
  await scenario("overview-hover-scroll", "/", overview, fx);
  await scenario("iocs-100k-flick-12.5k-px-s", "/iocs", iocScroll(200), fx);
  await scenario("iocs-100k-extreme-56k-px-s", "/iocs", iocScroll(900), fx);
  await scenario("iocs-drawer-keys-resize-palette", "/iocs", iocInteract, fx);
  await scenario("rules-editor-dnd", "/rules", rules, fx);
  await scenario("shell-routes-collapse", "/", shell, fx);
}

// Effects: Off removes every backdrop-filter and non-essential animation with no layout change.
const offCheck = [];
for (const path of ONLY ? [] : ["/", "/iocs", "/rules/2", "/sync"]) {
  const snap = async (fx) => {
    const { ctx, page } = await open(path, fx);
    await page.waitForTimeout(1500);
    const s = await page.evaluate(() => ({
      // HTML layout boxes only: skip chart SVG internals (ECharts places its own text) and elements whose
      // box includes a running transform animation (e.g. the live pulse ring) — those are paint, not layout.
      rects: [...document.querySelectorAll("#root *")]
        .filter((e) => !e.closest(".ambient") && !(e instanceof SVGElement))
        .slice(0, 600)
        .map((e) => {
          if (e.getAnimations().some((a) => a.playState === "running")) return "animating";
          const r = e.getBoundingClientRect();
          return [r.x, r.y, r.width, r.height].map(Math.round).join(",");
        }),
      blurred: [...document.querySelectorAll("*")].filter((e) => { const b = getComputedStyle(e).backdropFilter; return b && b !== "none"; }).length,
      animations: document.getAnimations().filter((a) => a.playState === "running").length,
    }));
    await ctx.close();
    return s;
  };
  const full = await snap("full");
  const off = await snap("off");
  const moved = full.rects.filter((r, i) => r !== "animating" && r !== off.rects[i]).length;
  offCheck.push({ path, compared: full.rects.length, layoutDiffs: moved, blurredFull: full.blurred, blurredOff: off.blurred, runningAnimFull: full.animations, runningAnimOff: off.animations });
}
console.table(offCheck);

writeFileSync(`${OUT}/results.json`, JSON.stringify({ cpuThrottle: CPU, viewport: "1440x900", results, effectsOff: offCheck }, null, 2));
console.table(results.map(({ scenario, effects, fps, p95, worst, longTasks, worstInteraction, maxBlurred, maxG2, tableRowsInDom }) => ({ scenario, effects, fps, p95, worst, longTasks, worstInteraction, maxBlurred, maxG2, tableRowsInDom })));
await browser.close();

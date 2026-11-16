// Screenshots of every page at 3 breakpoints × 2 themes against the mock API, collecting console
// errors/warnings. Needs a running build: `npm run build && npx vite preview --port 4173`, then
//   node scripts/perf/screens.mjs [outDir] [pageFilter]
// Requires Playwright (`playwright` package with a Chromium build) on the machine.
import { createRequire } from "node:module";
// CommonJS resolution so a globally installed Playwright (NODE_PATH) works too
const { chromium } = createRequire(import.meta.url)("playwright");
import { mkdirSync } from "node:fs";
import { installMockApi } from "./mock-api.mjs";

const BASE = process.env.BASE ?? "http://127.0.0.1:4173";
const OUT = process.argv[2] ?? "perf-results/screens";
const FILTER = process.argv[3];
mkdirSync(OUT, { recursive: true });

const PAGES = [
  ["overview", "/"],
  ["iocs", "/iocs"],
  ["ioc-drawer", "/iocs?open=7"],
  ["rules", "/rules"],
  ["rule-editor", "/rules/2"],
  ["sync", "/sync"],
  ["flags", "/flags"],
  ["detections", "/detections"],
  ["allowlist", "/allowlist"],
  ["settings", "/settings"],
  ["login", "/login"],
  ["ui-kit", "/dev/ui-kit"],
];
const SIZES = [
  ["desktop", { width: 1440, height: 900 }],
  ["tablet", { width: 834, height: 1112 }],
  ["phone", { width: 390, height: 844 }],
];

const browser = await chromium.launch();
const problems = [];
for (const theme of ["dark", "light"]) {
  for (const [sizeName, viewport] of SIZES) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion: "reduce" });
    for (const [name, path] of PAGES) {
      if (FILTER && !name.includes(FILTER)) continue;
      const page = await ctx.newPage();
      page.on("console", (m) => {
        if (m.type() !== "error" && m.type() !== "warning") return;
        // the login page probes the refresh cookie first; its 401 is the expected "no session" answer
        if (name === "login" && /status of 401/.test(m.text())) return;
        problems.push(`${theme}/${sizeName}/${name}: ${m.type()}: ${m.text()}`);
      });
      page.on("pageerror", (e) => problems.push(`${theme}/${sizeName}/${name}: pageerror: ${e.message}`));
      await page.addInitScript((t) => { localStorage.setItem("ca-theme", t); localStorage.setItem("ca-effects", "full"); }, theme);
      await installMockApi(page, { iocCount: 100_000, liveEveryMs: 600_000 });
      if (name === "login") await page.route("**/api/auth/refresh", (r) => r.fulfill({ status: 401, contentType: "application/json", body: "{}" }));
      await page.goto(BASE + path);
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(900);
      // overflow check: nothing may push the page wider than the viewport
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) problems.push(`${theme}/${sizeName}/${name}: horizontal overflow ${overflow}px`);
      await page.screenshot({ path: `${OUT}/${name}-${sizeName}-${theme}.png` });
      await page.close();
    }
    await ctx.close();
  }
}
await browser.close();
console.log(problems.length ? problems.join("\n") : "no console errors, warnings or overflow");
process.exit(problems.length ? 1 : 0);

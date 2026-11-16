// Royal Glass — WCAG contrast + colour-vision check, measured on the REAL glass.
// Reads the theme blocks straight from src/styles/globals.css (single source of truth) and composites
// each ground the way the browser paints it: bg-2 + the ambient orbs at peak alpha (worst case for
// the theme), then the tier fill. A backdrop blur only averages that ground, so this is the floor.
// Usage: npm run check:contrast   (exit 1 on any failure)
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/styles/globals.css", import.meta.url), "utf8");
function block(selectorStart) {
  const i = css.indexOf(selectorStart);
  const open = css.indexOf("{", i);
  const close = css.indexOf("\n}", open);
  const vars = {};
  for (const m of css.slice(open + 1, close).matchAll(/--([\w-]+):\s*([^;]+);/g)) vars[m[1]] = m[2].replace(/\/\*.*?\*\//g, "").trim();
  return vars;
}
const dark = block(":root,\n:root[data-theme=\"dark\"]");
const THEMES = { dark, light: { ...dark, ...block(':root[data-theme="light"] {') } };

const rgbOf = (v) => {
  if (v.startsWith("#")) return [0, 2, 4].map((i) => parseInt(v.slice(1 + i, 3 + i), 16) / 255);
  return v.split(/\s+/).slice(0, 3).map((n) => Number(n) / 255);
};
const over = (fg, a, bg) => fg.map((c, i) => c * a + bg[i] * (1 - a));
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (rgb) => { const [r, g, b] = rgb.map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

function grounds(T, name) {
  const c = (k) => rgbOf(T[k]);
  const a = (k) => Number(T[k]);
  const orbs = name === "light" ? [["orb-2", "orb-2-a"], ["orb-1", "orb-1-a"]] : [["orb-1", "orb-1-a"], ["orb-3", "orb-3-a"]];
  const worst = orbs.reduce((bg, [k, ka]) => over(c(k), a(ka), bg), c("bg-2"));
  return {
    canvas: over(c("orb-1"), a("orb-1-a"), c("bg")),
    "canvas+orbs": worst,
    G0: over(c("glass-solid"), a("glass-solid-a"), worst),
    G1: over(c("glass"), a("glass-a"), worst),
    G2: over(c("glass-strong"), a("glass-strong-a"), worst),
    fallback: c("glass-fallback-top"),
    control: c("control"),
  };
}

const TIERS = ["G0", "G1", "G2", "fallback", "control"];
const rules = [
  ...["fg", "fg-muted", "fg-subtle", "primary-text", "violet-text", "secondary-text", "danger-text", "warning-ink"].map((fg) => ({ fg, on: TIERS, min: 4.5 })),
  { fg: "fg", on: ["canvas", "canvas+orbs"], min: 4.5 },
  { fg: "fg-muted", on: ["canvas", "canvas+orbs"], min: 4.5 },
  ...["malicious", "suspicious", "abnormal"].map((v) => ({ fg: `ver-${v}-text`, tint: `ver-${v}`, tintA: 0.12, on: ["G0", "G1", "G2"], min: 4.5 })),
  ...["ver-malicious", "ver-suspicious", "ver-abnormal", "sev-critical", "sev-high", "sev-medium", "sev-low"].map((fg) => ({ fg, on: ["G0", "G1", "G2"], min: 3 })),
  { fg: "ring", on: ["canvas", "canvas+orbs", ...TIERS], min: 3 },
  { fg: "control-border", on: TIERS, min: 3 },
  ...[1, 2, 3, 4, 5, 6].map((i) => ({ fg: `chart-${i}`, on: ["G0", "G1"], min: 3 })),
  ...[2, 3, 4].map((i) => ({ fg: `chart-ord-${i}`, on: ["G0", "G1"], min: 3 })),
  { fg: "primary-fg", solid: "primary", min: 4.5 },
  ...["grad-1", "grad-2", "grad-3"].map((g) => ({ fg: "on-brand", solid: g, min: 4.5 })),
];

let fails = 0;
const rows = [];
for (const [name, T] of Object.entries(THEMES)) {
  const G = grounds(T, name);
  for (const r of rules) {
    const fg = rgbOf(T[r.fg]);
    const list = r.solid ? [[r.solid, rgbOf(T[r.solid])]] : r.on.map((g) => [g, G[g]]);
    for (const [gname, g0] of list) {
      const g = r.tint ? over(rgbOf(T[r.tint]), r.tintA, g0) : g0;
      const c = ratio(fg, g);
      const ok = c >= r.min;
      if (!ok) fails++;
      rows.push({ theme: name, fg: r.fg, ground: r.tint ? `${r.tint} ${r.tintA * 100}% on ${gname}` : gname, ratio: +c.toFixed(2), min: r.min, ok });
    }
  }
}

// CVD: categorical chart colours stay distinguishable (Machado 2009 + CIEDE2000 ≥ 8).
const M = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
const gam = (c) => { c = Math.min(1, Math.max(0, c)); return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; };
const sim = (rgb, m) => { const l = rgb.map(lin); return m.map((r) => gam(r[0] * l[0] + r[1] * l[1] + r[2] * l[2])); };
const lab = (rgb) => {
  const [r, g, b] = rgb.map(lin), f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const X = f((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047), Y = f(r * 0.2126 + g * 0.7152 + b * 0.0722), Z = f((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
};
function de00([L1, a1, b1], [L2, a2, b2]) {
  const rad = Math.PI / 180, C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2), Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const p1 = (1 + G) * a1, p2 = (1 + G) * a2, Cp1 = Math.hypot(p1, b1), Cp2 = Math.hypot(p2, b2);
  const hh = (x, y) => { const v = Math.atan2(y, x) / rad; return v < 0 ? v + 360 : v; };
  const h1 = hh(p1, b1), h2 = hh(p2, b2);
  let dh = h2 - h1; if (Cp1 * Cp2 === 0) dh = 0; else if (dh > 180) dh -= 360; else if (dh < -180) dh += 360;
  const dL = L2 - L1, dC = Cp2 - Cp1, dH = 2 * Math.sqrt(Cp1 * Cp2) * Math.sin((dh / 2) * rad);
  const Lb = (L1 + L2) / 2, Cbp = (Cp1 + Cp2) / 2;
  let hb = h1 + h2; if (Cp1 * Cp2 !== 0) { hb = Math.abs(h1 - h2) > 180 ? (h1 + h2 + 360) / 2 : (h1 + h2) / 2; if (hb >= 360) hb -= 360; }
  const Tt = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
  const dt = 30 * Math.exp(-(((hb - 275) / 25) ** 2)), RC = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2), SC = 1 + 0.045 * Cbp, SH = 1 + 0.015 * Cbp * Tt;
  const RT = -Math.sin(2 * dt * rad) * RC;
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}
const cvd = [];
for (const [name, T] of Object.entries(THEMES)) {
  const pal = [1, 2, 3, 4, 5, 6].map((i) => [`chart-${i}`, rgbOf(T[`chart-${i}`])]);
  for (const [kind, m] of Object.entries(M)) {
    let min = Infinity, pair = "";
    for (let i = 0; i < pal.length; i++) for (let j = i + 1; j < pal.length; j++) {
      const d = de00(lab(sim(pal[i][1], m)), lab(sim(pal[j][1], m)));
      if (d < min) { min = d; pair = `${pal[i][0]}/${pal[j][0]}`; }
    }
    const ok = min >= 8; if (!ok) fails++;
    cvd.push({ theme: name, vision: kind, minDeltaE00: +min.toFixed(1), closest: pair, ok });
  }
}

const bad = rows.filter((r) => !r.ok);
console.log(`Contrast: ${rows.length - bad.length}/${rows.length} pairs pass on composited glass.`);
const worst = {};
for (const r of rows) { const k = `${r.theme} ${r.fg}`; if (!worst[k] || r.ratio < worst[k].ratio) worst[k] = r; }
if (process.argv.includes("--table")) console.table(Object.values(worst));
console.table(cvd);
if (bad.length) console.table(bad);
process.exit(fails ? 1 : 0);

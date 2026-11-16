import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

/** Every colour is a CSS variable (src/styles/globals.css) so both themes share one Tailwind build. */
const rgb = (v: string) => `rgb(var(--${v}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: { DEFAULT: rgb("bg"), 1: rgb("bg-1"), 2: rgb("bg-2") },
        fg: { DEFAULT: rgb("fg"), muted: rgb("fg-muted"), subtle: rgb("fg-subtle") },
        line: "rgb(var(--line) / var(--line-a))",
        control: { DEFAULT: rgb("control"), border: rgb("control-border") },
        primary: { DEFAULT: rgb("primary"), fg: rgb("primary-fg"), text: rgb("primary-text") },
        secondary: { DEFAULT: rgb("secondary"), text: rgb("secondary-text") },
        violet: { DEFAULT: rgb("violet"), text: rgb("violet-text") },
        highlight: { DEFAULT: rgb("highlight"), soft: rgb("highlight-soft"), ink: rgb("warning-ink") },
        danger: { DEFAULT: rgb("danger"), text: rgb("danger-text") },
        ring: rgb("ring"),
        "on-brand": rgb("on-brand"),
        sev: { low: rgb("sev-low"), medium: rgb("sev-medium"), high: rgb("sev-high"), critical: rgb("sev-critical") },
        ver: {
          abnormal: rgb("ver-abnormal"),
          suspicious: rgb("ver-suspicious"),
          malicious: rgb("ver-malicious"),
          "abnormal-text": rgb("ver-abnormal-text"),
          "suspicious-text": rgb("ver-suspicious-text"),
          "malicious-text": rgb("ver-malicious-text"),
        },
      },
      fontFamily: {
        sans: ['"Instrument Sans Variable"', '"Instrument Sans"', "ui-sans-serif", "system-ui", "-apple-system", '"Segoe UI"', "sans-serif"],
        mono: ['"JetBrains Mono Variable"', '"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      fontSize: {
        label: ["11px", { lineHeight: "16px", letterSpacing: "0.08em", fontWeight: "600" }],
        kpi: ["28px", { lineHeight: "32px", letterSpacing: "-0.02em", fontWeight: "600" }],
      },
      borderRadius: { xl: "16px", "2xl": "16px", "3xl": "22px" },
      transitionDuration: { 1: "120ms", 2: "200ms", 3: "320ms", 4: "500ms" },
      transitionTimingFunction: {
        standard: "cubic-bezier(0.2, 0, 0, 1)",
        emphasized: "cubic-bezier(0.3, 0, 0, 1)",
        exit: "cubic-bezier(0.4, 0, 1, 1)",
        snappy: "var(--ease-spring-snappy)",
        gentle: "var(--ease-spring-gentle)",
      },
      zIndex: { sticky: "10", shell: "20", overlay: "50", toast: "70", perf: "90" },
      keyframes: {
        shimmer: { "100%": { transform: "translateX(100%)" } },
        pulseRing: { "0%": { opacity: "0.45", transform: "scale(.5)" }, "70%,100%": { opacity: "0", transform: "scale(1.4)" } },
        pulseDot: { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.35" } },
        morph: { from: { opacity: "0", transform: "scale(.86)" }, to: { opacity: "1", transform: "none" } },
        slideIn: { from: { opacity: "0", transform: "translateY(-10px)" } },
      },
      animation: {
        shimmer: "shimmer 1.4s cubic-bezier(0.2,0,0,1) infinite",
        "pulse-dot": "pulseDot 1.8s ease-in-out infinite",
        "pulse-ring": "pulseRing 1.8s cubic-bezier(0.2,0,0,1) infinite",
        morph: "morph 200ms cubic-bezier(0.3,0,0,1)",
        "slide-in": "slideIn 320ms cubic-bezier(0.3,0,0,1) both",
      },
    },
  },
  plugins: [animate],
} satisfies Config;

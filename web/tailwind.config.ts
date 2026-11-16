import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

const rgb = (v: string) => `rgb(var(--${v}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: rgb("bg"),
        fg: { DEFAULT: rgb("fg"), muted: rgb("fg-muted"), subtle: rgb("fg-subtle") },
        line: "rgb(var(--line) / var(--line-a))",
        primary: { DEFAULT: rgb("primary"), fg: rgb("primary-fg"), text: rgb("primary-text") },
        secondary: { DEFAULT: rgb("secondary"), text: rgb("secondary-text") },
        highlight: { DEFAULT: rgb("highlight"), soft: rgb("highlight-soft"), ink: rgb("warning-ink") },
        danger: { DEFAULT: rgb("danger"), text: rgb("danger-text") },
        ring: rgb("ring"),
        sev: { low: rgb("sev-low"), medium: rgb("sev-medium"), high: rgb("sev-high"), critical: rgb("sev-critical") },
        ver: { abnormal: rgb("ver-abnormal"), suspicious: rgb("ver-suspicious"), malicious: rgb("ver-malicious") },
      },
      fontFamily: {
        sans: ['"Inter Variable"', "Inter", "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "SFMono-Regular", "monospace"],
      },
      borderRadius: { xl: "14px", "2xl": "18px" },
      keyframes: {
        shimmer: { "100%": { transform: "translateX(100%)" } },
        pulseDot: { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.35" } },
      },
      animation: { shimmer: "shimmer 1.6s infinite", "pulse-dot": "pulseDot 1.8s ease-in-out infinite" },
    },
  },
  plugins: [animate],
} satisfies Config;

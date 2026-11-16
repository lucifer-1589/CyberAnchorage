/// <reference types="vitest" />
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const api = process.env.VITE_API_PROXY ?? "http://127.0.0.1:8077";

/** Preload the latin UI font: it is referenced from CSS, so the browser would otherwise discover it only after
 *  the stylesheet is parsed. Mono is not preloaded — first paint barely uses it and on slow links it would
 *  compete with the JS for bandwidth (measured: FCP +300 ms on simulated 4G). */
function preloadFonts(): Plugin {
  const wanted = [/instrument-sans-latin-wght-normal-.*\.woff2$/];
  return {
    name: "preload-fonts",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const files = Object.keys(ctx.bundle ?? {}).filter((f) => wanted.some((re) => re.test(f)));
        return files.map((f) => ({ tag: "link", attrs: { rel: "preload", as: "font", type: "font/woff2", href: `/${f}`, crossorigin: "" }, injectTo: "head" as const }));
      },
    },
  };
}

/** Inline route → chunk map: the current page's chunk is modulepreloaded while the main bundle downloads,
 *  instead of after it executes (one round trip less to first content on every route). */
function preloadRouteChunk(): Plugin {
  const ROUTES: [string, string][] = [
    ["^/$", "pages/Overview.tsx"],
    ["^/iocs", "pages/IocExplorer.tsx"],
    ["^/rules/.+", "pages/RuleEditor.tsx"],
    ["^/rules$", "pages/Rules.tsx"],
    ["^/sync", "pages/Sync.tsx"],
    ["^/flags", "pages/Flags.tsx"],
    ["^/allowlist", "pages/Allowlist.tsx"],
    ["^/detections", "pages/Detections.tsx"],
    ["^/audit", "pages/Audit.tsx"],
    ["^/users", "pages/Users.tsx"],
    ["^/settings", "pages/Settings.tsx"],
  ];
  return {
    name: "preload-route-chunk",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const chunks = Object.values(ctx.bundle ?? {}).filter((c) => c.type === "chunk") as { fileName: string; facadeModuleId: string | null }[];
        const map = ROUTES.flatMap(([re, mod]) => {
          const c = chunks.find((x) => x.facadeModuleId?.endsWith(mod));
          return c ? [[re, `/${c.fileName}`]] : [];
        });
        const js = `(function(){var m=${JSON.stringify(map)},p=location.pathname;for(var i=0;i<m.length;i++)if(new RegExp(m[i][0]).test(p)){var l=document.createElement("link");l.rel="modulepreload";l.href=m[i][1];document.head.appendChild(l);break}})();`;
        return [{ tag: "script", children: js, injectTo: "head" as const }];
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), preloadFonts(), preloadRouteChunk()],
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": { target: api, changeOrigin: false, ws: true } },
  },
  build: {
    sourcemap: false,
    // Overview lazily loads ECharts core (bar+line+SVG, ~180 KB gzip); everything else stays small.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: { manualChunks: { vendor: ["react", "react-dom", "react-router-dom"] } },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});

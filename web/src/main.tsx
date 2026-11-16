import React, { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { App, preloadRoute } from "@/App";
import { ApiError } from "@/lib/api";
import { TooltipProvider } from "@/components/ui/overlays";
import { startPerfProbe, useUi } from "@/store/ui";
import { Ambient } from "@/components/Ambient";
import "@/styles/globals.css";

document.documentElement.dataset.theme = useUi.getState().theme;
startPerfProbe();
preloadRoute(location.pathname);

/** Dev-only perf overlay (`?perf=1`): tree-shaken out of production builds. */
const PerfOverlay = import.meta.env.DEV ? lazy(() => import("@/components/PerfOverlay").then((m) => ({ default: m.PerfOverlay }))) : null;
const showPerf = PerfOverlay !== null && new URLSearchParams(location.search).get("perf") === "1";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

function ThemedToaster() {
  const theme = useUi((s) => s.theme);
  return (
    <Toaster
      theme={theme}
      position="bottom-right"
      duration={3000}
      closeButton
      toastOptions={{ classNames: { toast: "glass !rounded-xl !text-fg !border-[rgb(var(--glass-border)/0.12)] !font-sans" } }}
    />
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Ambient />
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />
        </BrowserRouter>
        <ThemedToaster />
        {showPerf && PerfOverlay && (
          <Suspense fallback={null}>
            <PerfOverlay />
          </Suspense>
        )}
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);

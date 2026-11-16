import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { App } from "@/App";
import { ApiError } from "@/lib/api";
import { TooltipProvider } from "@/components/ui/overlays";
import { useUi } from "@/store/ui";
import "@/styles/globals.css";

document.documentElement.dataset.theme = useUi.getState().theme;

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
      toastOptions={{ classNames: { toast: "glass-strong !rounded-xl !text-fg !border-[rgb(var(--glass-border)/0.12)]" } }}
    />
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
        <ThemedToaster />
      </TooltipProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);

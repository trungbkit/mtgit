import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app/App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { applyPlatform } from "./stores/settings";
import "./theme.css";

// Before the first paint, not in an effect: the tab strip is the titlebar on
// macOS and reserves the traffic lights' gutter by this attribute. Setting it
// a frame later draws one frame of tabs underneath them.
applyPlatform();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);

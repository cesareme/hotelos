// Inter Variable — the brand UI typeface. Loaded as a real webfont (the CSS
// stacks named "Inter" but it was never bundled → faux-bold on non-Apple OSes,
// and reception runs on Windows). Variable axis 100–900 = true weights, no synth.
import "@fontsource-variable/inter";
import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";
import { App } from "./App";
import { initTheme } from "./theme";

// Apply the persisted light/dark preference before first paint to avoid a flash.
initTheme();

// ───────────────────────────────────────────────────────────────── Sentry init
// PILOT-D2: captura de errores cliente. PII-safe (no body, no auth headers).
// DSN se inyecta via VITE_SENTRY_DSN al build. Si no hay DSN, Sentry queda inactivo.
const sentryDsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
const sentryEnv = (import.meta.env.MODE as string | undefined) ?? "development";

if (sentryDsn && sentryDsn !== "change-me" && sentryDsn !== "") {
  Sentry.init({
    dsn: sentryDsn,
    environment: sentryEnv,
    tracesSampleRate: sentryEnv === "production" ? 0.1 : 1.0,
    sendDefaultPii: false,
    // Redacta payloads y cabeceras sensibles antes de enviar.
    beforeSend(event) {
      if (event.request?.headers) {
        delete (event.request.headers as Record<string, unknown>)["authorization"];
        delete (event.request.headers as Record<string, unknown>)["cookie"];
      }
      if (event.request?.data) {
        event.request.data = "[redacted]";
      }
      // Limpia query strings que puedan llevar tokens.
      if (event.request?.query_string) {
        event.request.query_string = "[redacted]";
      }
      return event;
    },
    // Filtra ruidos previsibles del navegador.
    ignoreErrors: [
      "ResizeObserver loop limit exceeded",
      "ResizeObserver loop completed with undelivered notifications",
      "Non-Error promise rejection captured"
    ]
  });
  // eslint-disable-next-line no-console
  console.log(`[sentry] initialized · env=${sentryEnv}`);
} else {
  // eslint-disable-next-line no-console
  console.log("[sentry] disabled (VITE_SENTRY_DSN no configurado)");
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element was not found.");
}

createRoot(root).render(
  <Sentry.ErrorBoundary
    fallback={({ error, resetError }) => (
      <div
        style={{
          padding: "32px",
          fontFamily: "system-ui, -apple-system, sans-serif",
          maxWidth: "560px",
          margin: "64px auto",
          color: "#1a1a1a"
        }}
      >
        <h1 style={{ fontSize: "20px", marginBottom: "12px" }}>
          Algo ha fallado en la interfaz
        </h1>
        <p style={{ fontSize: "14px", color: "#555", marginBottom: "16px" }}>
          El error ya ha sido reportado al equipo. Puedes intentarlo de nuevo.
        </p>
        <pre
          style={{
            fontSize: "12px",
            background: "#f5f5f5",
            padding: "8px",
            borderRadius: "4px",
            overflow: "auto",
            maxHeight: "180px",
            marginBottom: "16px"
          }}
        >
          {error instanceof Error ? error.message : String(error)}
        </pre>
        <button
          type="button"
          onClick={resetError}
          style={{
            padding: "8px 16px",
            background: "#1a1a1a",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer"
          }}
        >
          Reintentar
        </button>
      </div>
    )}
  >
    <App />
  </Sentry.ErrorBoundary>
);

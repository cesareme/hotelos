// CocoaNotFoundScreen — the 404 of the shell (App.tsx renders it inside the
// layout when no screen matches the pathname).
//
// Cocoa 22 (COCOA-22.md §3.10 / §4 «otro»): a CocoaPage with the eyebrow and
// the H1 of the page and `state="error"`, which paints a full-page CocoaState
// (illustration, title, message) with the two actions: back to the landing
// screen and the command palette. No raw heading element, no local styles.
//
// Navigation goes through the typed helper `navigateTo` (lib/navigate.ts)
// over the global `hotelos-nav` event; the command palette opens by
// dispatching the Cmd/Ctrl+K shortcut that `useCocoaCommandPaletteHotkey`
// listens for in the layout, so this screen is not coupled to any context.

import { CocoaPage } from "../../components/cocoa";
import { navigateTo } from "../../lib/navigate";
import { BRAND } from "../../config/brand";

function openCommandPalette(): void {
  const event = new KeyboardEvent("keydown", {
    key: "k",
    code: "KeyK",
    metaKey: true,
    ctrlKey: true,
    bubbles: true,
    cancelable: true
  });
  document.dispatchEvent(event);
}

export function CocoaNotFoundScreen() {
  return (
    <CocoaPage
      eyebrow={`${BRAND.name} · Error 404`}
      title="Página no encontrada"
      aria-label="Página no encontrada"
      state="error"
      error={{
        title: "Esta pantalla no existe o fue movida",
        message: "Verifica el enlace o vuelve al inicio.",
        illustration: "search",
        primaryAction: { label: "Volver al inicio", onClick: () => navigateTo("FrontDeskDashboard") },
        secondaryAction: { label: "Buscar…", onClick: openCommandPalette }
      }}
    >
      {null}
    </CocoaPage>
  );
}

export default CocoaNotFoundScreen;

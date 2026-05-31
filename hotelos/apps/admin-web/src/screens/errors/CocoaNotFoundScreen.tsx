// CocoaNotFoundScreen
//
// Pantalla 404 con layout centrado verticalmente, max-width 480px. Muestra la
// ilustración EmptyStateBox (paquete cocoa-illustrations), un título, una
// descripción y dos acciones: volver al inicio y abrir la command palette.
//
// La navegación se hace mediante el evento global `hotelos-nav` (igual que en
// BackOfficeDashboard.tsx) y la apertura de la command palette se simula
// despachando el atajo Cmd+K (Meta+K), que es escuchado por
// useCocoaCommandPaletteHotkey en la capa de layout.

import type { CSSProperties } from "react";

import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { EmptyStateBox } from "../../components/cocoa-illustrations";

function navigate(screen: string): void {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}

// Simula la pulsación de Cmd+K para abrir la command palette global. El hook
// `useCocoaCommandPaletteHotkey` escucha este atajo en `document` y abre la
// palette, así no acoplamos esta pantalla a ningún context concreto.
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

const wrapperStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  minHeight: "100%",
  width: "100%",
  padding: "var(--cocoa-space-6)",
  boxSizing: "border-box"
};

const contentStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  textAlign: "center",
  gap: "var(--cocoa-space-4)",
  width: "100%",
  maxWidth: 480
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontFamily: "var(--cocoa-font)",
  fontSize: "var(--cocoa-fs-title-1)",
  fontWeight: "var(--cocoa-fw-semibold)" as unknown as number,
  letterSpacing: "var(--cocoa-tracking-tight)",
  color: "var(--cocoa-label)"
};

const descriptionStyle: CSSProperties = {
  margin: 0,
  fontFamily: "var(--cocoa-font)",
  fontSize: "var(--cocoa-fs-body)",
  color: "var(--cocoa-label-secondary)",
  lineHeight: 1.5
};

const actionsStyle: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--cocoa-space-3)",
  flexWrap: "wrap"
};

export function CocoaNotFoundScreen() {
  return (
    <div style={wrapperStyle}>
      <div style={contentStyle}>
        <EmptyStateBox size={240} tone="accent" />
        <h1 style={titleStyle}>404 · Pagina no encontrada</h1>
        <p style={descriptionStyle}>
          Esta pantalla no existe o fue movida. Verifica el enlace o vuelve al
          inicio.
        </p>
        <div style={actionsStyle}>
          <CocoaButton
            variant="filled"
            tone="accent"
            onClick={() => navigate("HomeDashboard")}
          >
            Volver al inicio
          </CocoaButton>
          <CocoaButton
            variant="bordered"
            tone="neutral"
            onClick={openCommandPalette}
          >
            Buscar...
          </CocoaButton>
        </div>
      </div>
    </div>
  );
}

export default CocoaNotFoundScreen;

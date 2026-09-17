// keyboard-shortcuts — the ONLY catalog of keyboard shortcuts admin-web ships.
//
// Tanda 5 (chrome): the previous article and `GET /developer/keyboard-shortcuts`
// announced 15+ combinations that no screen implemented (⌘1…⌘5, ⌘N, ⌘F, ⌘E,
// ⌘D, ⌘R, ⌘⇧C, ⌘⇧O, ⌘⌫, J/K…). Everything listed here is wired in code:
//   - ⌘K / Ctrl+K        → BackOfficeLayout (shell command palette)
//   - ⌘/ / Ctrl+/         → CocoaGlobalProvider (this catalog, as a sheet)
//   - ⌘, / Ctrl+,         → CocoaGlobalProvider (preferences sheet)
//   - Esc                 → every overlay (palette, help, notifications, dialogs, tour)
//   - ↑ ↓ Enter           → CommandPalette / CocoaCommandPalette
//   - ← →                 → GuidedTour (previous / next step)
//   - ← → Inicio Fin      → CocoaRouteTabs (tab strips)
// Adding a shortcut here without wiring it is a regression of plan §2.3
// («sin jerga … 0 atajos anunciados que no existen»).

import type { CocoaHelpArticle } from "../../components/cocoa-guidance/CocoaSearchableHelpModal";
import { BRAND } from "../../config/brand";

export interface KeyboardShortcut {
  /** Mac notation; Windows/Linux readers swap ⌘ for Ctrl. */
  readonly keys: string;
  readonly action: string;
}

export interface KeyboardShortcutCategory {
  readonly category: string;
  readonly shortcuts: readonly KeyboardShortcut[];
}

export const KEYBOARD_SHORTCUTS: readonly KeyboardShortcutCategory[] = [
  {
    category: "Global",
    shortcuts: [
      { keys: "⌘K", action: "Buscar reservas, huéspedes, facturas y pantallas (paleta de comandos)" },
      { keys: "⌘/", action: "Ver esta lista de atajos" },
      { keys: "⌘,", action: "Abrir las preferencias de apariencia" },
      { keys: "Esc", action: "Cerrar el panel, diálogo o menú abierto" }
    ]
  },
  {
    category: "Paleta de comandos",
    shortcuts: [
      { keys: "↑ ↓", action: "Moverse por los resultados" },
      { keys: "Intro", action: "Abrir el resultado seleccionado" },
      { keys: "Esc", action: "Cerrar la paleta" }
    ]
  },
  {
    category: "Pestañas de una pantalla",
    shortcuts: [
      { keys: "← →", action: "Moverse entre pestañas" },
      { keys: "Inicio / Fin", action: "Primera / última pestaña" },
      { keys: "Intro / Espacio", action: "Abrir la pestaña seleccionada" }
    ]
  },
  {
    category: "Recorrido guiado",
    shortcuts: [
      { keys: "→", action: "Paso siguiente" },
      { keys: "←", action: "Paso anterior" },
      { keys: "Esc", action: "Salir del recorrido" }
    ]
  }
];

function shortcutsTable(category: KeyboardShortcutCategory): string[] {
  return [
    `## ${category.category}`,
    "",
    "| Atajo | Acción |",
    "| --- | --- |",
    ...category.shortcuts.map((shortcut) => `| \`${shortcut.keys}\` | ${shortcut.action} |`),
    ""
  ];
}

export const KEYBOARD_SHORTCUTS_ARTICLE: CocoaHelpArticle = {
  id: "keyboard-shortcuts",
  title: "Atajos de teclado",
  category: "Atajos de teclado",
  tags: ["atajos", "teclado", "productividad", "paleta", "buscar", "ayuda"],
  bodyMd: [
    `Combinaciones de teclado disponibles en ${BRAND.name}. En Windows y Linux sustituye \`⌘\` por \`Ctrl\`.`,
    "",
    ...KEYBOARD_SHORTCUTS.flatMap(shortcutsTable),
    "Consejo: los atajos globales no actúan mientras escribes en un campo de texto, para no interferir con lo que estás tecleando."
  ].join("\n")
};

export default KEYBOARD_SHORTCUTS_ARTICLE;

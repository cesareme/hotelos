// keyboard-shortcuts — el ÚNICO catálogo de atajos de teclado que admin-web publica.
//
// GENERADO por scripts/gen-shortcuts.mjs desde apps/admin-web/src/content/shortcuts-registry.ts — NO EDITAR A MANO:
//   node scripts/gen-shortcuts.mjs            # regenera este fichero
//   node scripts/gen-shortcuts.mjs --check    # exit 1 si está desfasado
//
// Tanda 5 (chrome): el artículo anterior y `GET /developer/keyboard-shortcuts`
// anunciaban 15+ combinaciones que ninguna pantalla implementaba. Desde la Tanda
// UX-1 (lote U5) cada atajo vive en el registro con el fichero que lo cablea y
// el contrato tests/shortcuts-catalog-contract.test.mjs exige igualdad catálogo ↔
// registro: anunciar un atajo sin cablearlo sigue siendo una regresión del plan
// §2.3 («sin jerga … 0 atajos anunciados que no existen»).

import type { CocoaHelpArticle } from "../../components/cocoa-guidance/CocoaSearchableHelpModal";
import { BRAND } from "../../config/brand";

export interface KeyboardShortcut {
  /** Notación Mac; en Windows y Linux ⌘ es Ctrl y ⌥ es Alt. */
  readonly keys: string;
  readonly action: string;
}

export interface KeyboardShortcutCategory {
  readonly category: string;
  readonly shortcuts: readonly KeyboardShortcut[];
}

// shortcuts-catalog:start
export const KEYBOARD_SHORTCUTS: readonly KeyboardShortcutCategory[] = [
  {
    "category": "Global",
    "shortcuts": [
      {
        "keys": "⌘K",
        "action": "Buscar reservas, huéspedes, habitaciones, facturas y pantallas, y ejecutar los comandos de la pantalla (paleta de comandos)"
      },
      {
        "keys": "⌘/",
        "action": "Ver esta lista de atajos"
      },
      {
        "keys": "⌘,",
        "action": "Abrir las preferencias de apariencia"
      },
      {
        "keys": "Intro",
        "action": "En un campo de una línea de un diálogo o panel, confirmar la acción principal"
      },
      {
        "keys": "Esc",
        "action": "Cerrar el panel, diálogo o menú abierto"
      }
    ]
  },
  {
    "category": "Navegación con ⌥",
    "shortcuts": [
      {
        "keys": "⌥H",
        "action": "Ir a Mi día"
      },
      {
        "keys": "⌥R",
        "action": "Ir a Reservas"
      },
      {
        "keys": "⌥N",
        "action": "Abrir Nueva reserva"
      },
      {
        "keys": "⌥T",
        "action": "Abrir el Live Timeline"
      },
      {
        "keys": "⌥B",
        "action": "Abrir el tablero de habitaciones"
      },
      {
        "keys": "⌥F",
        "action": "Ir al buscador de la pantalla (si no tiene, abre la paleta)"
      },
      {
        "keys": "⌥W",
        "action": "Alta de walk-in (llegada sin reserva)"
      }
    ]
  },
  {
    "category": "Teclas de acceso",
    "shortcuts": [
      {
        "keys": "⌥ (mantener)",
        "action": "Mostrar la letra de cada acción visible; ⌥ + esa letra la ejecuta"
      }
    ]
  },
  {
    "category": "Cobro",
    "shortcuts": [
      {
        "keys": "⌥1",
        "action": "Método efectivo en el cobro"
      },
      {
        "keys": "⌥2",
        "action": "Método tarjeta (datáfono) en el cobro"
      },
      {
        "keys": "⌥3",
        "action": "Método transferencia en el cobro"
      },
      {
        "keys": "Intro",
        "action": "Cobrar (con el foco en el importe o la referencia)"
      }
    ]
  },
  {
    "category": "Paleta de comandos",
    "shortcuts": [
      {
        "keys": "↑ ↓",
        "action": "Moverse por los resultados"
      },
      {
        "keys": "Intro",
        "action": "Abrir el resultado o ejecutar el comando seleccionado"
      },
      {
        "keys": "Esc",
        "action": "Cerrar la paleta"
      }
    ]
  },
  {
    "category": "Pestañas de una pantalla",
    "shortcuts": [
      {
        "keys": "← →",
        "action": "Moverse entre pestañas"
      },
      {
        "keys": "Inicio / Fin",
        "action": "Primera / última pestaña"
      },
      {
        "keys": "Intro / Espacio",
        "action": "Abrir la pestaña seleccionada"
      }
    ]
  },
  {
    "category": "Recorrido guiado",
    "shortcuts": [
      {
        "keys": "→",
        "action": "Paso siguiente"
      },
      {
        "keys": "←",
        "action": "Paso anterior"
      },
      {
        "keys": "Esc",
        "action": "Salir del recorrido"
      }
    ]
  },
  {
    "category": "Modo prueba",
    "shortcuts": [
      {
        "keys": "⌘⇧T",
        "action": "Pasar a la tarea siguiente de la sesión de prueba (solo con el modo prueba activo)"
      },
      {
        "keys": "⌘⇧E",
        "action": "Exportar la sesión de prueba (solo con el modo prueba activo)"
      }
    ]
  }
];
// shortcuts-catalog:end

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
  tags: ["atajos", "teclado", "productividad", "paleta", "buscar", "ayuda", "navegación", "teclas de acceso"],
  bodyMd: [
    `Combinaciones de teclado disponibles en ${BRAND.name}. En Windows y Linux sustituye \`⌘\` por \`Ctrl\` y \`⌥\` por \`Alt\`.`,
    "",
    ...KEYBOARD_SHORTCUTS.flatMap(shortcutsTable),
    "Consejo: los atajos con ⌥ no actúan mientras escribes en un campo de texto, para no interferir con lo que estás tecleando; mantén ⌥ pulsado para ver la letra de cada acción de la pantalla."
  ].join("\n")
};

export default KEYBOARD_SHORTCUTS_ARTICLE;

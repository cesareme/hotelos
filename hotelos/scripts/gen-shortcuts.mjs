#!/usr/bin/env node
/**
 * gen-shortcuts.mjs — Tanda UX-1 · lote U5 (docs/design/UX-RECEPCION-FEEL.md
 * §1.1 P2, §4 «Atajos por pantalla y teclas de acceso», §10 D7).
 *
 * Genera apps/admin-web/src/content/help-articles/keyboard-shortcuts.ts (el
 * catálogo de atajos del centro de ayuda y de la hoja ⌘/) desde la fuente
 * única apps/admin-web/src/content/shortcuts-registry.ts. El registro declara
 * dónde está cableado cada atajo; el contrato tests/shortcuts-catalog-contract
 * .test.mjs exige que el fichero generado coincida con el registro y que cada
 * `code` esté cableado en el fichero que declara.
 *
 *   node scripts/gen-shortcuts.mjs            # escribe el catálogo
 *   node scripts/gen-shortcuts.mjs --check    # exit 1 si el catálogo está desfasado
 *
 * Node ≥ 22.18 (type stripping): el registro se importa tal cual, sin Vite ni tsx.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const REGISTRY_PATH = join(REPO_ROOT, "apps", "admin-web", "src", "content", "shortcuts-registry.ts");
export const CATALOG_PATH = join(REPO_ROOT, "apps", "admin-web", "src", "content", "help-articles", "keyboard-shortcuts.ts");

/** Marcadores que delimitan el literal JSON del catálogo dentro del fichero generado (el contrato lo lee de ahí). */
export const CATALOG_START = "// shortcuts-catalog:start";
export const CATALOG_END = "// shortcuts-catalog:end";

export async function loadRegistry(path = REGISTRY_PATH) {
  return import(pathToFileURL(path).href);
}

/** Texto del fichero generado a partir del catálogo del registro. */
export function renderCatalog(catalog, { registryRel, scriptRel }) {
  const json = JSON.stringify(catalog, null, 2);
  return [
    "// keyboard-shortcuts — el ÚNICO catálogo de atajos de teclado que admin-web publica.",
    "//",
    `// GENERADO por ${scriptRel} desde ${registryRel} — NO EDITAR A MANO:`,
    `//   node ${scriptRel}            # regenera este fichero`,
    `//   node ${scriptRel} --check    # exit 1 si está desfasado`,
    "//",
    "// Tanda 5 (chrome): el artículo anterior y `GET /developer/keyboard-shortcuts`",
    "// anunciaban 15+ combinaciones que ninguna pantalla implementaba. Desde la Tanda",
    "// UX-1 (lote U5) cada atajo vive en el registro con el fichero que lo cablea y",
    "// el contrato tests/shortcuts-catalog-contract.test.mjs exige igualdad catálogo ↔",
    "// registro: anunciar un atajo sin cablearlo sigue siendo una regresión del plan",
    "// §2.3 («sin jerga … 0 atajos anunciados que no existen»).",
    "",
    'import type { CocoaHelpArticle } from "../../components/cocoa-guidance/CocoaSearchableHelpModal";',
    'import { BRAND } from "../../config/brand";',
    "",
    "export interface KeyboardShortcut {",
    "  /** Notación Mac; en Windows y Linux ⌘ es Ctrl y ⌥ es Alt. */",
    "  readonly keys: string;",
    "  readonly action: string;",
    "}",
    "",
    "export interface KeyboardShortcutCategory {",
    "  readonly category: string;",
    "  readonly shortcuts: readonly KeyboardShortcut[];",
    "}",
    "",
    CATALOG_START,
    `export const KEYBOARD_SHORTCUTS: readonly KeyboardShortcutCategory[] = ${json};`,
    CATALOG_END,
    "",
    "function shortcutsTable(category: KeyboardShortcutCategory): string[] {",
    "  return [",
    "    `## ${category.category}`,",
    '    "",',
    '    "| Atajo | Acción |",',
    '    "| --- | --- |",',
    "    ...category.shortcuts.map((shortcut) => `| \\`${shortcut.keys}\\` | ${shortcut.action} |`),",
    '    ""',
    "  ];",
    "}",
    "",
    "export const KEYBOARD_SHORTCUTS_ARTICLE: CocoaHelpArticle = {",
    '  id: "keyboard-shortcuts",',
    '  title: "Atajos de teclado",',
    '  category: "Atajos de teclado",',
    '  tags: ["atajos", "teclado", "productividad", "paleta", "buscar", "ayuda", "navegación", "teclas de acceso"],',
    "  bodyMd: [",
    "    `Combinaciones de teclado disponibles en ${BRAND.name}. En Windows y Linux sustituye \\`⌘\\` por \\`Ctrl\\` y \\`⌥\\` por \\`Alt\\`.`,",
    '    "",',
    "    ...KEYBOARD_SHORTCUTS.flatMap(shortcutsTable),",
    '    "Consejo: los atajos con ⌥ no actúan mientras escribes en un campo de texto, para no interferir con lo que estás tecleando; mantén ⌥ pulsado para ver la letra de cada acción de la pantalla."',
    '  ].join("\\n")',
    "};",
    "",
    "export default KEYBOARD_SHORTCUTS_ARTICLE;",
    ""
  ].join("\n");
}

/** Literal JSON del catálogo dentro de un fichero generado (entre los marcadores). */
export function parseCatalogFile(source) {
  const start = source.indexOf(CATALOG_START);
  const end = source.indexOf(CATALOG_END);
  if (start < 0 || end < 0 || end < start) throw new Error(`keyboard-shortcuts.ts: faltan los marcadores ${CATALOG_START} / ${CATALOG_END}`);
  const block = source.slice(start + CATALOG_START.length, end);
  const eq = block.indexOf("= ");
  const semi = block.lastIndexOf(";");
  if (eq < 0 || semi < 0) throw new Error("keyboard-shortcuts.ts: el bloque generado no tiene la forma `= <json>;`");
  return JSON.parse(block.slice(eq + 2, semi));
}

async function main(argv) {
  const check = argv.includes("--check");
  const registry = await loadRegistry();
  const catalog = registry.shortcutCatalog();
  const scriptRel = relative(REPO_ROOT, fileURLToPath(import.meta.url)).split("\\").join("/");
  const registryRel = relative(REPO_ROOT, REGISTRY_PATH).split("\\").join("/");
  const next = renderCatalog(catalog, { registryRel, scriptRel });
  let current = "";
  try {
    current = readFileSync(CATALOG_PATH, "utf8");
  } catch {
    current = "";
  }
  const catalogRel = relative(REPO_ROOT, CATALOG_PATH);
  if (check) {
    if (current !== next) {
      console.error(`[gen-shortcuts] ${catalogRel} está desfasado respecto a ${registryRel}: ejecuta node ${scriptRel}`);
      process.exit(1);
    }
    console.log(`[gen-shortcuts] ${catalogRel} al día (${catalog.reduce((n, c) => n + c.shortcuts.length, 0)} atajos en ${catalog.length} categorías)`);
    return;
  }
  if (current === next) {
    console.log(`[gen-shortcuts] ${catalogRel} sin cambios`);
    return;
  }
  writeFileSync(CATALOG_PATH, next, "utf8");
  console.log(`[gen-shortcuts] ${catalogRel} regenerado (${catalog.reduce((n, c) => n + c.shortcuts.length, 0)} atajos en ${catalog.length} categorías)`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[gen-shortcuts] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

// Tanda UX-1 · lote U5 (docs/design/UX-RECEPCION-FEEL.md §1.1 P2, §4 «Atajos por
// pantalla y teclas de acceso», §10 D7 / R8): el catálogo de atajos que ve el
// operador (content/help-articles/keyboard-shortcuts.ts, hoja ⌘/ y centro de
// ayuda) se GENERA desde la fuente única content/shortcuts-registry.ts con
// scripts/gen-shortcuts.mjs. Este contrato exige igualdad catálogo ↔ registro y
// que cada atajo esté cableado en el fichero que declara («anunciar un atajo sin
// cablearlo es regresión», plan §2.3).

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ADMIN_SRC = join(ROOT, "apps", "admin-web", "src");
const REGISTRY_PATH = join(ADMIN_SRC, "content", "shortcuts-registry.ts");
const CATALOG_PATH = join(ADMIN_SRC, "content", "help-articles", "keyboard-shortcuts.ts");
const GENERATOR_PATH = join(ROOT, "scripts", "gen-shortcuts.mjs");

const registry = await import(pathToFileURL(REGISTRY_PATH).href);
const generator = await import(pathToFileURL(GENERATOR_PATH).href);
const catalogSource = readFileSync(CATALOG_PATH, "utf8");

const CODE_SHAPE = /^(?:Key[A-Z]|Digit[0-9])$/;
const JARGON = /sandbox|\bstub\b|\bmock|\bdemo\b|pendiente de implementaci|próximamente/i;
const TODO_MARK = /\bTODO\b/;

describe("shortcuts-catalog · registro único (content/shortcuts-registry.ts)", () => {
  const entries = registry.SHORTCUTS;

  it("tiene ids únicos, categorías del orden declarado y textos en español sin jerga", () => {
    assert.ok(Array.isArray(entries) && entries.length >= 20, `solo ${entries.length} atajos`);
    const ids = new Set();
    for (const entry of entries) {
      assert.ok(entry.id && !ids.has(entry.id), `id duplicado o vacío: ${entry.id}`);
      ids.add(entry.id);
      assert.ok(registry.CATEGORY_ORDER.includes(entry.category), `${entry.id}: categoría «${entry.category}» fuera de CATEGORY_ORDER`);
      assert.ok(entry.keys.trim().length > 0, `${entry.id}: sin teclas`);
      assert.ok(entry.action.trim().length >= 8, `${entry.id}: acción demasiado corta`);
      assert.doesNotMatch(entry.action, JARGON, entry.id);
      assert.doesNotMatch(entry.action, TODO_MARK, entry.id);
      assert.ok(entry.wiredIn && entry.wiredIn.file && entry.wiredIn.token, `${entry.id}: sin wiredIn`);
    }
  });

  it("los atajos con modificador se declaran por `code` (R8: nunca por `key`)", () => {
    for (const entry of entries) {
      if (entry.alt || (entry.mod && entry.shift)) {
        assert.ok(entry.code, `${entry.id}: atajo con modificador sin code`);
      }
      if (entry.code) assert.match(entry.code, CODE_SHAPE, `${entry.id}: code «${entry.code}» no es Key[A-Z]/Digit[0-9]`);
      if (entry.alt) assert.ok(!entry.mod, `${entry.id}: ⌥ y ⌘ juntos no forman parte de la convención D7`);
    }
  });

  it("la navegación con ⌥ cubre las siete teclas de D7 con letras únicas y reservadas para las teclas de acceso", () => {
    const nav = registry.GLOBAL_ALT_SHORTCUTS;
    assert.deepEqual(
      nav.map((entry) => entry.keys),
      ["⌥H", "⌥R", "⌥N", "⌥T", "⌥B", "⌥F", "⌥W"]
    );
    const letters = nav.map((entry) => registry.letterOfCode(entry.code));
    assert.equal(new Set(letters).size, letters.length, "letras ⌥ repetidas");
    assert.deepEqual(registry.RESERVED_ACCESS_LETTERS, letters);
    for (const entry of nav) assert.ok(entry.screen || entry.event, `${entry.id}: sin pantalla ni evento`);
    assert.equal(registry.shortcutCombo(nav[0]), "Alt+KeyH");
    assert.equal(registry.shortcutCombo(registry.shortcutById("trace.next-task")), "Mod+Shift+KeyT");
  });

  it("cada atajo está cableado: el fichero declarado existe y contiene el literal", () => {
    const cache = new Map();
    for (const entry of entries) {
      const file = join(ROOT, entry.wiredIn.file);
      assert.ok(existsSync(file), `${entry.id}: no existe ${entry.wiredIn.file}`);
      if (!cache.has(file)) cache.set(file, readFileSync(file, "utf8"));
      assert.ok(cache.get(file).includes(entry.wiredIn.token), `${entry.id}: «${entry.wiredIn.token}» no aparece en ${entry.wiredIn.file}`);
    }
  });

  it("los atajos ⌥ de navegación se registran desde BackOfficeLayout con el registro tipado y `useCocoaShortcuts`", () => {
    const layout = readFileSync(join(ADMIN_SRC, "layouts", "BackOfficeLayout.tsx"), "utf8");
    assert.match(layout, /GLOBAL_ALT_SHORTCUTS/);
    assert.match(layout, /useCocoaShortcuts\(\)/);
    assert.match(layout, /shortcutCombo\(/);
    assert.match(layout, /isTextEntryTarget\(/, "R8: sin preventDefault dentro de un campo de texto");
    const provider = readFileSync(join(ADMIN_SRC, "providers", "CocoaGlobalProvider.tsx"), "utf8");
    assert.match(provider, /event\.code/, "el registro de atajos del provider compara por code (R8)");
  });

  it("la paleta ⌘K consume los comandos de la página (F16) y anuncia la opción activa", () => {
    const palette = readFileSync(join(ADMIN_SRC, "components", "CommandPalette.tsx"), "utf8");
    assert.match(palette, /subscribePageCommands/);
    assert.match(palette, /getPageCommands/);
    assert.match(palette, /aria-activedescendant/);
    assert.match(palette, /hotelos-open-checkin/);
    assert.match(palette, /hotelos-open-payment/);
  });
});

describe("shortcuts-catalog · catálogo generado (content/help-articles/keyboard-shortcuts.ts)", () => {
  it("lleva la cabecera GENERADO y los marcadores del bloque", () => {
    assert.match(catalogSource, /GENERADO por scripts\/gen-shortcuts\.mjs/);
    assert.ok(catalogSource.includes(generator.CATALOG_START));
    assert.ok(catalogSource.includes(generator.CATALOG_END));
  });

  it("es idéntico al que produce el generador desde el registro (node scripts/gen-shortcuts.mjs --check)", () => {
    const expected = generator.renderCatalog(registry.shortcutCatalog(), {
      registryRel: relative(ROOT, REGISTRY_PATH).split("\\").join("/"),
      scriptRel: relative(ROOT, GENERATOR_PATH).split("\\").join("/")
    });
    assert.equal(catalogSource, expected, "keyboard-shortcuts.ts desfasado: ejecuta node scripts/gen-shortcuts.mjs");
  });

  it("catálogo = registro (mismas categorías, mismas teclas y acciones, en el mismo orden)", () => {
    const parsed = generator.parseCatalogFile(catalogSource);
    assert.deepEqual(parsed, registry.shortcutCatalog());
    const flat = parsed.flatMap((category) => category.shortcuts.map((shortcut) => `${category.category}|${shortcut.keys}|${shortcut.action}`));
    assert.equal(flat.length, registry.SHORTCUTS.length, "el catálogo no lista todos los atajos del registro");
    assert.equal(parsed[0].category, "Global", "el centro de ayuda destaca la primera categoría: debe ser «Global»");
  });

  it("sin duplicados de teclas dentro de una categoría", () => {
    for (const category of generator.parseCatalogFile(catalogSource)) {
      const keys = category.shortcuts.map((shortcut) => shortcut.keys);
      assert.equal(new Set(keys).size, keys.length, `${category.category}: teclas repetidas`);
    }
  });
});

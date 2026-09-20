// Contract test (Tanda FIX-1 · F6): no stale compiled `.js` next to a `.ts` /
// `.tsx` source under packages/*/src.
//
// The workspace packages are consumed from source (tsconfig paths and the Vite
// aliases point at packages/*/src/index.ts) and their barrels import with the
// `.js` suffix (`export * from "./permissions.js"` in packages/shared/src/
// index.ts). Vite and Node resolve that specifier to a real `permissions.js`
// when one exists, so an old compilation left next to the source shadows it
// silently: Configuración › Usuarios y roles › «Comparar plantillas» crashed
// with «b is not iterable» because a permissions.js compiled before Tanda 8a
// (11 templates) hid permissions.ts (24). `.gitignore` hides those files from
// `git status` — this test does not. Remedy: `git clean -fdX packages/*/src`
// (only ignored files are removed) and restart Vite / the API.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, extname, join, relative, sep } from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACKAGES_DIR = join(ROOT, "packages");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", ".turbo"]);

const posix = (file) => relative(ROOT, file).split(sep).join("/");

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** packages/<name>/src directories that exist. */
export function sourceRoots(packagesDir = PACKAGES_DIR) {
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir)
    .map((name) => join(packagesDir, name, "src"))
    .filter((dir) => existsSync(dir) && statSync(dir).isDirectory())
    .sort();
}

/** `.js` files that sit next to a `.ts` / `.tsx` of the same stem, as "<js> (sombra de <ts>)". */
export function shadowedSources(roots) {
  const problems = [];
  for (const root of roots) {
    const files = walk(root);
    const sources = new Set(files.filter((file) => SOURCE_EXTENSIONS.has(extname(file))));
    for (const file of files) {
      if (extname(file) !== ".js") continue;
      const stem = file.slice(0, -".js".length);
      const twin = [`${stem}.ts`, `${stem}.tsx`].find((candidate) => sources.has(candidate));
      if (twin) problems.push(`${posix(file)} (sombra de ${basename(twin)})`);
    }
  }
  return problems.sort();
}

describe("Contrato · packages/*/src sin ficheros compilados que sombreen la fuente", () => {
  it("ningún .js junto a un .ts/.tsx del mismo nombre", () => {
    const roots = sourceRoots();
    assert.ok(roots.length > 0, `${posix(PACKAGES_DIR)}/*/src: ningún directorio de fuentes encontrado`);
    const shadowed = shadowedSources(roots);
    assert.deepEqual(
      shadowed,
      [],
      `fichero compilado obsoleto sombrea la fuente; borrar con git clean -fdX packages/*/src (${shadowed.length} en ${roots.length} paquetes):\n${shadowed.join("\n")}`
    );
  });
});

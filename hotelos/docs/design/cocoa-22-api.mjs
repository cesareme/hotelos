#!/usr/bin/env node
// Cocoa 22 · API block of COCOA-22.md §8 and typecheck of the §4.3 templates.
//
// §8 of docs/design/COCOA-22.md is GENERATED from the exported declarations of
// apps/admin-web/src/components/cocoa/*.ts(x) (barrel order of index.ts): every
// `export interface | type | function | const` with its leading JSDoc, one
// ```ts block per file, between the markers
//   <!-- cocoa-22-api:start -->  …  <!-- cocoa-22-api:end -->
// so the spec can never drift from the code again (review#15).
//
// Usage (from hotelos/):
//   node docs/design/cocoa-22-api.mjs --stdout              print the block
//   node docs/design/cocoa-22-api.mjs --write               replace the block in COCOA-22.md
//   node docs/design/cocoa-22-api.mjs --check               exit 1 when the block is stale
//   node docs/design/cocoa-22-api.mjs --summary             counts (files, types, props, functions)
//   node docs/design/cocoa-22-api.mjs --extract-examples D  write the §4.3 ```tsx templates to D
//   node docs/design/cocoa-22-api.mjs --typecheck-examples  extract + tsc against admin-web (exit 1 on error)
//
// The templates of §4.3 are fenced ```tsx blocks whose first line is
// `// file: screens/ejemplos/<Name>.tsx`; --typecheck-examples mirrors
// apps/admin-web/src through symlinks in a temp dir, writes the templates into
// screens/ejemplos and runs apps/admin-web's tsc on them (only the templates'
// own errors are reported).
//
// Planned home: hotelos/scripts/cocoa-22-api.mjs + rule 16 of
// tests/cocoa-22-contract.test.mjs (handoff to the contract lot).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const adminWeb = join(repoRoot, "apps", "admin-web");
const adminSrc = join(adminWeb, "src");
const cocoaDir = join(adminSrc, "components", "cocoa");
const specPath = join(here, "COCOA-22.md");

const START = "<!-- cocoa-22-api:start -->";
const END = "<!-- cocoa-22-api:end -->";

// ----------------------------------------------------------------- extraction

/** Files in the order of the barrel (`export * from "./X"`), then the named re-exports. */
function barrelOrder() {
  const index = readFileSync(join(cocoaDir, "index.ts"), "utf8");
  const files = [];
  const reexports = [];
  for (const line of index.split("\n")) {
    const star = line.match(/^export \* from "\.\/([\w-]+)";/);
    if (star) {
      const base = star[1];
      const file = existsSync(join(cocoaDir, `${base}.tsx`)) ? `${base}.tsx` : `${base}.ts`;
      files.push(file);
      continue;
    }
    if (/^export \{/.test(line)) reexports.push(line.trim());
  }
  return { files, reexports };
}

/** Index of the line that closes the block opened at `start` (balanced { } [ ] ( )). */
function blockEnd(lines, start) {
  let depth = 0;
  let opened = false;
  for (let i = start; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{" || ch === "[" || ch === "(") {
        depth++;
        opened = true;
      } else if (ch === "}" || ch === "]" || ch === ")") {
        depth--;
      }
    }
    if (opened && depth <= 0) return i;
    if (!opened && /;\s*$/.test(lines[i])) return i;
  }
  return lines.length - 1;
}

/** Leading JSDoc / line comments of a declaration, collapsed to one `/** … *\/` line. */
function leadingDoc(lines, index) {
  let j = index - 1;
  const raw = [];
  while (j >= 0 && (/^\s*(\/\/|\*|\/\*\*?)/.test(lines[j]) || /^\s*\*\/\s*$/.test(lines[j]))) {
    raw.unshift(lines[j]);
    j--;
  }
  if (raw.length === 0) return null;
  const text = raw
    .map((l) => l.replace(/^\s*\/\*\*?\s?/, "").replace(/\*\/\s*$/, "").replace(/^\s*\*\s?/, "").replace(/^\s*\/\/\s?/, "").trim())
    .filter(Boolean)
    .join(" ");
  return text ? `/** ${text} */` : null;
}

/** Top-level keys of an object literal block (`export const X = { a: …, b(…) {…} }`). */
function topLevelKeys(blockLines) {
  const keys = [];
  let depth = 0;
  for (let i = 0; i < blockLines.length; i++) {
    const line = blockLines[i];
    if (i > 0 && depth === 1) {
      const m = line.match(/^\s{2}(?:"([^"]+)"|([\w$]+))\s*[:(=]/);
      if (m) keys.push(m[1] ?? m[2]);
    }
    for (const ch of line) {
      if (ch === "{" || ch === "[" || ch === "(") depth++;
      else if (ch === "}" || ch === "]" || ch === ")") depth--;
    }
  }
  return keys;
}

/** Collapse a multi-line signature to one line (used for functions and one-line consts). */
function oneLine(lines) {
  return lines
    .map((l) => l.replace(/\s*\/\/.*$/, "").trim())
    .join(" ")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/,\s*\)/g, ")")
    .replace(/\s{2,}/g, " ");
}

/** Declarations of one file: `{ doc, kind, name, text: string[] }`. */
export function extractDeclarations(src) {
  const lines = src.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^export default\b/.test(line)) continue;
    const decl = line.match(/^export (interface|type|function|const|class|\{)\s*(?:\{\s*)?([\w$]+)?/);
    if (!decl) continue;
    const kind = decl[1];
    const doc = leadingDoc(lines, i);
    if (kind === "interface" || kind === "type" || kind === "{") {
      const end = blockEnd(lines, i);
      const body = lines.slice(i, end + 1).filter((l) => l.trim() !== "");
      out.push({ doc, kind: kind === "{" ? "reexport" : kind, name: decl[2] ?? "", text: body });
      i = end;
      continue;
    }
    if (kind === "function" || kind === "class") {
      // Signature: until the parameter list is balanced and the line opens the
      // body (`{`) or ends an overload (`;`); braces inside destructured
      // parameters and object types do not count, only parentheses.
      let k = i;
      let parens = 0;
      const sig = [];
      while (k < lines.length) {
        sig.push(lines[k]);
        for (const ch of lines[k]) {
          if (ch === "(") parens++;
          else if (ch === ")") parens--;
        }
        if (parens <= 0 && (/\{\s*$/.test(lines[k]) || /;\s*$/.test(lines[k]))) break;
        k++;
      }
      const text = oneLine(sig).replace(/\s*\{\s*$/, "").replace(/;\s*$/, "");
      out.push({ doc, kind, name: decl[2] ?? "", text: [text] });
      i = k;
      continue;
    }
    // const: one-liner, or a balanced initializer block.
    const end = blockEnd(lines, i);
    const block = lines.slice(i, end + 1);
    if (block.length === 1) {
      out.push({ doc, kind, name: decl[2] ?? "", text: [block[0].replace(/;\s*$/, "")] });
    } else {
      const keys = topLevelKeys(block);
      if (block.length <= 20 || keys.length === 0) {
        // Small object/array initialisers are shown whole (CocoaChart, COCOA_BREAKPOINTS, FOCUSABLE_SELECTOR).
        out.push({ doc, kind, name: decl[2] ?? "", text: block.filter((l) => l.trim() !== "").map((l) => l.replace(/;\s*$/, "")) });
      } else {
        const head = block[0].replace(/\s*[{[(]\s*$/, "").replace(/=\s*$/, "").trim();
        out.push({ doc, kind, name: decl[2] ?? "", text: [`${head} = { ${keys.join(", ")} }  // ${block.length} líneas; solo las claves`] });
      }
    }
    i = end;
  }
  return out;
}

// ----------------------------------------------------------------- rendering

function propsOf(decl) {
  if (decl.kind !== "interface" && decl.kind !== "type") return 0;
  // Object members: `  name?: …` or `  "aria-label"?: …` at depth 1.
  return decl.text.filter((l) => /^\s{2}(?:"[^"]+"|[\w$]+)\??:/.test(l)).length;
}

export function renderBlock() {
  const { files, reexports } = barrelOrder();
  const parts = [START, "", `Generado por \`docs/design/cocoa-22-api.mjs --write\` a partir de \`apps/admin-web/src/components/cocoa/*\` (orden del barrel \`index.ts\`). No editar a mano: \`--check\` falla si difiere del código.`, ""];
  const stats = { files: 0, interfaces: 0, types: 0, functions: 0, consts: 0, props: 0 };
  parts.push("#### Barrel `components/cocoa/index.ts`", "", "```ts");
  for (const file of files) parts.push(`export * from "./${file.replace(/\.tsx?$/, "")}";`);
  for (const line of reexports) parts.push(line);
  parts.push("```", "");
  for (const file of files) {
    const src = readFileSync(join(cocoaDir, file), "utf8");
    const decls = extractDeclarations(src);
    if (decls.length === 0) continue;
    stats.files += 1;
    parts.push(`#### \`${file}\``, "", "```ts");
    let previousMultiline = false;
    decls.forEach((decl, index) => {
      const multiline = decl.text.length > 1;
      if (index > 0 && (multiline || previousMultiline || decl.doc)) parts.push("");
      if (decl.doc) parts.push(decl.doc);
      parts.push(...decl.text);
      previousMultiline = multiline;
      if (decl.kind === "interface") stats.interfaces += 1;
      else if (decl.kind === "type") stats.types += 1;
      else if (decl.kind === "function" || decl.kind === "class") stats.functions += 1;
      else if (decl.kind === "const") stats.consts += 1;
      stats.props += propsOf(decl);
    });
    parts.push("```", "");
  }
  parts.push(END);
  return { block: parts.join("\n"), stats };
}

// ----------------------------------------------------------------- spec I/O

function readSpec() {
  return readFileSync(specPath, "utf8");
}

function currentBlock(spec) {
  const s = spec.indexOf(START);
  const e = spec.indexOf(END);
  if (s === -1 || e === -1 || e < s) return null;
  return spec.slice(s, e + END.length);
}

function writeBlock(block) {
  const spec = readSpec();
  const s = spec.indexOf(START);
  const e = spec.indexOf(END);
  if (s === -1 || e === -1 || e < s) throw new Error(`COCOA-22.md no tiene los marcadores ${START} … ${END}`);
  const next = spec.slice(0, s) + block + spec.slice(e + END.length);
  writeFileSync(specPath, next);
  return next !== spec;
}

// ----------------------------------------------------------------- templates (§4.3)

/** ```tsx blocks whose first line is `// file: screens/ejemplos/<Name>.tsx`. */
export function extractTemplates(spec) {
  const out = [];
  for (const m of spec.matchAll(/```tsx\n(\/\/ file: (screens\/ejemplos\/[\w-]+\.tsx)\n[\s\S]*?)\n```/g)) out.push({ file: m[2], source: m[1] });
  return out;
}

function writeTemplates(dir, templates) {
  for (const t of templates) {
    const target = join(dir, t.file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, t.source.endsWith("\n") ? t.source : `${t.source}\n`);
  }
}

/** Mirror apps/admin-web/src into `dir` with symlinks (screens/ejemplos stays real). */
function buildHarness(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "screens", "ejemplos"), { recursive: true });
  for (const entry of readdirSync(adminSrc)) {
    if (entry === "screens") continue;
    symlinkSync(join(adminSrc, entry), join(dir, entry));
  }
  for (const entry of readdirSync(join(adminSrc, "screens"))) {
    if (entry === "ejemplos") continue;
    symlinkSync(join(adminSrc, "screens", entry), join(dir, "screens", entry));
  }
  symlinkSync(join(adminWeb, "node_modules"), join(dir, "node_modules"));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        extends: join(adminWeb, "tsconfig.json"),
        compilerOptions: { jsx: "react-jsx", noEmit: true, types: ["vite/client"], module: "ESNext", moduleResolution: "Bundler" },
        include: ["screens/ejemplos/**/*.tsx"]
      },
      null,
      2
    )
  );
}

function typecheckTemplates(dir) {
  const spec = readSpec();
  const templates = extractTemplates(spec);
  if (templates.length === 0) throw new Error("COCOA-22.md no tiene plantillas ```tsx con `// file: screens/ejemplos/…`");
  buildHarness(dir);
  writeTemplates(dir, templates);
  const tsc = join(adminWeb, "node_modules", ".bin", "tsc");
  let output = "";
  let ok = true;
  try {
    output = execFileSync(tsc, ["-p", join(dir, "tsconfig.json"), "--pretty", "false"], { encoding: "utf8", cwd: adminWeb, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    ok = false;
    output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  const own = output.split("\n").filter((l) => /screens\/ejemplos\//.test(l));
  const foreign = output.split("\n").filter((l) => /error TS\d+/.test(l) && !/screens\/ejemplos\//.test(l));
  console.log(`Plantillas §4.3: ${templates.length} ficheros (${templates.map((t) => basename(t.file)).join(", ")})`);
  console.log(`Harness: ${dir}`);
  if (own.length > 0) {
    console.log(`Errores en las plantillas (${own.length}):\n${own.join("\n")}`);
    return false;
  }
  if (foreign.length > 0) {
    console.log(`tsc reporta ${foreign.length} errores fuera de las plantillas (admin-web en rojo):\n${foreign.slice(0, 20).join("\n")}`);
    return false;
  }
  console.log(ok ? "tsc: 0 errores en las plantillas y en admin-web" : `tsc terminó con error sin diagnósticos atribuibles:\n${output}`);
  return ok;
}

// ----------------------------------------------------------------- cli

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? null;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const { block, stats } = renderBlock();
  const summary = `${stats.files} ficheros · ${stats.interfaces} interfaces · ${stats.types} type aliases · ${stats.props} props · ${stats.functions} funciones · ${stats.consts} constantes · ${block.split("\n").length} líneas`;
  if (flag("--summary")) {
    console.log(summary);
  } else if (flag("--stdout")) {
    process.stdout.write(`${block}\n`);
  } else if (flag("--write")) {
    const changed = writeBlock(block);
    console.log(`${changed ? "Bloque §8 actualizado" : "Bloque §8 ya estaba al día"} · ${summary}`);
  } else if (flag("--check")) {
    const current = currentBlock(readSpec());
    if (current === block) {
      console.log(`§8 al día · ${summary}`);
    } else {
      console.error("§8 de docs/design/COCOA-22.md está desactualizado: node docs/design/cocoa-22-api.mjs --write");
      process.exit(1);
    }
  } else if (flag("--extract-examples")) {
    const dir = resolve(value("--extract-examples") ?? "cocoa-22-examples");
    const templates = extractTemplates(readSpec());
    writeTemplates(dir, templates);
    console.log(`${templates.length} plantillas escritas en ${dir}`);
  } else if (flag("--typecheck-examples")) {
    const dir = resolve(value("--dir") ?? join(tmpdir(), "cocoa-22-examples"));
    process.exit(typecheckTemplates(dir) ? 0 : 1);
  } else {
    console.log("Uso: --stdout | --write | --check | --summary | --extract-examples DIR | --typecheck-examples [--dir DIR]");
  }
}

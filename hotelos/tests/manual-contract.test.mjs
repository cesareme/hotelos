// Contrato del manual de uso de ehotelOS (docs/manual/**) · Tanda DOC-1.
//
// Fija la estructura del manual y su higiene, sin red (solo lee el sistema de ficheros):
//   (a) ficheros obligatorios: índice, las 8 guías, FAQ, plan de formación, fichas y la receta de capturas;
//   (b) enlaces e imágenes: todo `[..](destino)` y `![..](destino)` relativo de los .md apunta a un FICHERO que
//       existe (un directorio no vale como destino);
//   (c) imágenes: bajo docs/manual/img solo PNG (y capturas.json), cada PNG ≤ 150 KB, ≤ 80 en total y ninguno huérfano;
//   (d) sin nombres reales: ni en el nombre de los ficheros ni en el texto de .md/.json/.mjs (el cliente piloto se
//       cita como «el cliente piloto», sin excepción);
//   (e) marca: exactamente «ehotelOS» en cada .md del manual (fichas incluidas), sin la marca anterior ni grafías
//       incorrectas (los identificadores técnicos que llevan la marca se blanquean antes, como en
//       tests/brand-contract.test.mjs). Los PNG no se leen: la revisión visual de las capturas se hace a ojo (README);
//   (f) 70-recepcion.md es un esqueleto (marcado «se completa en DOC-2») con el capítulo «## Live Timeline»;
//   (g) higiene: sin ficheros de sesión, sin .raw.png, sin extensiones fuera de .md/.png/.json/.mjs; la receta
//       cachea el token en el directorio temporal del sistema y nunca junto al script;
//   (h) índices: README.md y CLAUDE.md enlazan el manual, y docs/manual/README.md enlaza todas las guías.
// Corre con `node --test tests/manual-contract.test.mjs` y dentro de `pnpm test` (node --test tests/*.test.mjs).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MANUAL_DIR = "docs/manual";
const MANUAL = join(ROOT, MANUAL_DIR);
const IMG = join(MANUAL, "img");
const rel = (file) => relative(ROOT, file).split(sep).join("/");
const exists = (relativePath) => existsSync(join(ROOT, relativePath));
const read = (relativePath) => readFileSync(join(ROOT, relativePath), "utf8");

// ---------------------------------------------------------------------------
// Estructura fija del manual.
// ---------------------------------------------------------------------------

const GUIDES = [
  "00-primeros-pasos.md",
  "10-direccion.md",
  "20-administracion.md",
  "30-rrhh.md",
  "40-pisos-mantenimiento.md",
  "50-comercial-revenue.md",
  "60-sistemas.md",
  "70-recepcion.md"
];
const INDEX_TARGETS = [...GUIDES, "faq.md", "formacion/plan-de-formacion.md", "formacion/fichas/README.md"];
const REQUIRED_MD = ["README.md", ...INDEX_TARGETS];
const REQUIRED_FILES = [...REQUIRED_MD, "tools/capturas.mjs"];
const CAPTURE_TOOL = "tools/capturas.mjs";
const RECEPTION_SKELETON = "70-recepcion.md";

const MAX_PNG_BYTES = 153600; // 150 KB
const MAX_PNG_COUNT = 80;
const ALLOWED_EXTENSIONS = new Set([".md", ".png", ".json", ".mjs"]);
const TEXT_EXTENSIONS = new Set([".md", ".json", ".mjs"]);
const BATCH_FILE = "capturas.json";

// Nombres reales del cliente piloto, sus hoteles y grupos: prohibidos en nombres de fichero y en texto.
const REAL_NAMES_RE = /faranda|celuisma|r[ií]as\s+altas|los\s+tilos|playa\s+golf|marsol|alisas|fuerteventura|llanes/i;
const REAL_NAMES_WORD_RE = /\bOca\b/;

// Identificadores técnicos que llevan la marca y no cambian: se blanquean antes del barrido de marca.
const TECHNICAL = [
  /@hotelos\/[\w-]+/g,
  /hotelos[._/-][\w./-]*/g,
  /anfitorio[._-][\w.-]+/g,
  /~\/anfitorio-demo/g,
  // Grafía nueva en identificadores (p. ej. el fichero temporal de sesión de la receta de capturas).
  /ehotelos[._/-][\w./-]*/g
];
const OLD_BRAND_RE = /\b(?:Anfitorio|ANFITORIO|HotelOS|hotelOS|Hotel OS)\b/g;
const MISSPELLING_RE = /\b(?:Ehotelos|EhotelOS|EHotelOS|EHOTELOS|eHotelOS|eHotelos|ehotelos)\b/g;
const BRAND = "ehotelOS";

// ---------------------------------------------------------------------------
// Utilidades.
// ---------------------------------------------------------------------------

/** Ficheros (absolutos, ordenados) bajo `dir`, recursivo, sin ficheros ni carpetas ocultos. `[]` si no existe. */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir).sort()) {
    if (entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) walk(full, out);
    else if (stats.isFile()) out.push(full);
  }
  return out;
}

const manualFiles = () => walk(MANUAL);
const manualMarkdown = () => manualFiles().filter((file) => extname(file) === ".md");

/** Sustituye todo salvo los saltos de línea por espacios: los números de línea no cambian. */
const blank = (text) => text.replace(/[^\n]/g, " ");

/** Quita bloques de código (``` … ```) y código en línea (`…`) conservando los saltos de línea. */
function withoutCode(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, blank).replace(/`[^`\n]*`/g, blank);
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/** `ruta:línea: coincidencia` para cada coincidencia de `re` en `text`. */
function findHits(path, text, re) {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  const hits = [];
  for (const match of text.matchAll(global)) hits.push(`${path}:${lineOf(text, match.index)}: ${match[0]}`);
  return hits;
}

/** ¿Destino externo o solo ancla? (http(s):, mailto:, tel:, …, `#seccion`). */
const isExternal = (destination) => /^[a-z][a-z0-9+.-]*:/i.test(destination) || destination.startsWith("#");

/** Destino relativo → ruta absoluta resuelta desde el .md (sin #fragmento ni ?query, con %20 decodificado). */
function resolveDestination(markdownFile, destination) {
  const clean = destination.replace(/[#?].*$/, "");
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    /* se deja tal cual */
  }
  return resolve(dirname(markdownFile), decoded);
}

/**
 * Enlaces e imágenes relativos de un .md: `[..](destino)`, `![..](destino)` y `<img src="destino">`,
 * fuera del código. Devuelve { line, destination, resolved } por referencia.
 */
function relativeReferences(markdownFile) {
  const text = withoutCode(readFileSync(markdownFile, "utf8"));
  const refs = [];
  const add = (index, destination) => {
    if (!destination || isExternal(destination)) return;
    refs.push({ line: lineOf(text, index), destination, resolved: resolveDestination(markdownFile, destination) });
  };
  for (const match of text.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) add(match.index, match[1]);
  for (const match of text.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) add(match.index, match[1]);
  return refs;
}

/** Rutas absolutas referenciadas desde cualquier .md del manual. */
function referencedPaths() {
  const set = new Set();
  for (const file of manualMarkdown()) for (const ref of relativeReferences(file)) set.add(ref.resolved);
  return set;
}

// ---------------------------------------------------------------------------

describe("Contrato del manual de uso · ehotelOS", () => {
  it("ficheros obligatorios", () => {
    const missing = REQUIRED_FILES.filter((file) => !exists(`${MANUAL_DIR}/${file}`)).map((file) => `${MANUAL_DIR}/${file}`);
    assert.deepEqual(missing, [], `Faltan ficheros obligatorios del manual (${missing.length}):\n${missing.join("\n")}`);
  });

  it("enlaces e imágenes", () => {
    const broken = [];
    for (const file of manualMarkdown()) {
      for (const ref of relativeReferences(file)) {
        if (!existsSync(ref.resolved)) broken.push(`${rel(file)}:${ref.line}: ${ref.destination} → ${rel(ref.resolved)} no existe`);
        else if (!statSync(ref.resolved).isFile()) broken.push(`${rel(file)}:${ref.line}: ${ref.destination} → ${rel(ref.resolved)} no es un fichero`);
      }
    }
    assert.deepEqual(broken, [], `Enlaces o imágenes rotos en ${MANUAL_DIR} (${broken.length}):\n${broken.join("\n")}`);
  });

  it("imágenes", () => {
    const problems = [];
    const files = walk(IMG);
    const pngs = files.filter((file) => extname(file).toLowerCase() === ".png");
    for (const file of files) {
      const ext = extname(file).toLowerCase();
      if (ext !== ".png" && basename(file) !== BATCH_FILE) problems.push(`${rel(file)}: solo se admiten .png y ${BATCH_FILE} bajo ${MANUAL_DIR}/img`);
    }
    for (const file of pngs) {
      const { size } = statSync(file);
      if (size > MAX_PNG_BYTES) problems.push(`${rel(file)}: ${(size / 1024).toFixed(1)} KB > ${MAX_PNG_BYTES / 1024} KB (recorta con --clip/--selector o baja --colors)`);
    }
    if (pngs.length > MAX_PNG_COUNT) problems.push(`${pngs.length} PNG bajo ${MANUAL_DIR}/img (máximo ${MAX_PNG_COUNT})`);
    const referenced = referencedPaths();
    for (const file of pngs) {
      if (!referenced.has(file)) problems.push(`${rel(file)}: PNG huérfano (ninguna guía lo referencia)`);
    }
    assert.deepEqual(problems, [], `Imágenes fuera de contrato (${problems.length}):\n${problems.join("\n")}`);
  });

  it("sin nombres reales", () => {
    const hits = [];
    for (const file of manualFiles()) {
      const path = rel(file);
      const name = relative(MANUAL, file).split(sep).join("/");
      if (REAL_NAMES_RE.test(name) || REAL_NAMES_WORD_RE.test(name)) hits.push(`${path}: nombre de fichero con nombre real`);
      if (!TEXT_EXTENSIONS.has(extname(file).toLowerCase())) continue;
      const text = readFileSync(file, "utf8");
      hits.push(...findHits(path, text, REAL_NAMES_RE), ...findHits(path, text, REAL_NAMES_WORD_RE));
    }
    assert.deepEqual(hits, [], `Nombres reales en el manual (cita «el cliente piloto», sin datos) (${hits.length}):\n${hits.join("\n")}`);
  });

  it("marca", () => {
    const hits = [];
    for (const file of manualMarkdown()) {
      const path = rel(file);
      let text = readFileSync(file, "utf8");
      for (const re of TECHNICAL) text = text.replace(re, blank);
      hits.push(...findHits(path, text, OLD_BRAND_RE).map((hit) => `${hit} (marca anterior)`));
      hits.push(...findHits(path, text, MISSPELLING_RE).map((hit) => `${hit} (grafía incorrecta; la marca es «${BRAND}»)`));
    }
    for (const file of manualMarkdown()) {
      if (!readFileSync(file, "utf8").includes(BRAND)) hits.push(`${rel(file)}: no menciona «${BRAND}»`);
    }
    assert.deepEqual(hits, [], `Marca fuera de contrato en el manual (${hits.length}):\n${hits.join("\n")}`);
  });

  it("esqueleto de recepción", () => {
    const path = `${MANUAL_DIR}/${RECEPTION_SKELETON}`;
    assert.ok(exists(path), `${path} no existe`);
    const text = read(path);
    const problems = [];
    if (!text.includes("se completa en DOC-2")) problems.push(`${path}: falta la marca «se completa en DOC-2»`);
    if (!/^## Live Timeline\b/m.test(text)) problems.push(`${path}: falta el capítulo «## Live Timeline»`);
    assert.deepEqual(problems, [], `Esqueleto de recepción fuera de contrato (${problems.length}):\n${problems.join("\n")}`);
  });

  it("higiene", () => {
    const problems = [];
    for (const file of manualFiles()) {
      const path = rel(file);
      const name = basename(file);
      if (/session.*\.json$/i.test(name)) problems.push(`${path}: fichero de sesión (contiene un token; va en el directorio temporal del sistema)`);
      if (/\.raw\.png$/i.test(name)) problems.push(`${path}: captura sin optimizar (.raw.png)`);
      if (!ALLOWED_EXTENSIONS.has(extname(name).toLowerCase())) problems.push(`${path}: extensión no admitida (solo .md, .png, .json, .mjs)`);
    }
    const tool = `${MANUAL_DIR}/${CAPTURE_TOOL}`;
    if (!exists(tool)) {
      problems.push(`${tool}: no existe`);
    } else {
      const source = read(tool);
      if (!source.includes("tmpdir(")) problems.push(`${tool}: debe cachear la sesión en tmpdir()`);
      if (source.includes("manual-shot-session.json")) problems.push(`${tool}: no debe guardar la sesión junto al script (manual-shot-session.json)`);
    }
    assert.deepEqual(problems, [], `Higiene del manual (${problems.length}):\n${problems.join("\n")}`);
  });

  it("índices", () => {
    const problems = [];
    for (const path of ["README.md", "CLAUDE.md"]) {
      if (!exists(path)) problems.push(`${path}: no existe`);
      else if (!read(path).includes(`${MANUAL_DIR}/README.md`)) problems.push(`${path}: no enlaza ${MANUAL_DIR}/README.md`);
    }
    const index = join(MANUAL, "README.md");
    if (!existsSync(index)) {
      problems.push(`${MANUAL_DIR}/README.md: no existe`);
    } else {
      const linked = new Set(relativeReferences(index).map((ref) => ref.resolved));
      for (const target of INDEX_TARGETS) {
        if (!linked.has(join(MANUAL, target))) problems.push(`${MANUAL_DIR}/README.md: no enlaza ${target}`);
      }
    }
    assert.deepEqual(problems, [], `Índices del manual (${problems.length}):\n${problems.join("\n")}`);
  });
});

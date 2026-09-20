// Contrato del manual de uso de ehotelOS (docs/manual/**) · Tandas DOC-1 y DOC-2.
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
//   (f) guía de recepción completa (DOC-2): 70-recepcion.md lleva sus 18 capítulos en orden, cita ≥ 12 capturas
//       distintas de img/recepcion y los literales de la aplicación que fija el brief (acción por fila, cobro,
//       walk-in ⌥W, nueva reserva ⌥N, deshacer, borrador de factura, cola de riesgos);
//   (g) sin marcas provisionales (DOC-2): ningún .md/.json/.mjs del manual conserva «Provisional (UX-1)»,
//       «se completa en DOC-2», «cajón oculto», «captura forzada», «fixDrawer», «(provisional)»… (en los .md, fuera
//       del código);
//   (h) vocabulario de estados (DOC-2): ningún .md muestra los estados con su nombre técnico (CHECKED_IN, NO_SHOW…)
//       ni con las etiquetas viejas («Alojada», «ALOJADA», «Salida realizada») fuera del código: el diccionario es
//       «Llega hoy · En el hotel · Sale hoy · Salida hecha · No-show · Cancelada»;
//   (i) receta regenerable (DOC-2): tools/capturas.mjs sin fixDrawer, con las claves de trabajo nuevas (login,
//       noSession, collapse, pushState, cmdk, hover, chip), la acción scroll, --out-dir, --login y el tenant UXDAY;
//       cada trabajo de cada img/*/capturas.json usa solo claves conocidas, tiene url y out, su out es un PNG que
//       existe en la misma carpeta (ruta relativa al monorepo, nunca absoluta: el lote es portable) y sus pasos usan
//       solo los verbos de la receta; y, al revés, cada PNG del manual tiene su trabajo (ninguna captura a mano);
//   (j) fichas (DOC-2): las 16 fichas con su nombre fijo, enlazadas desde formacion/fichas/README.md, cada una
//       empieza por «# Ficha · » y termina con «## Más detalle» enlazando al menos una guía;
//   (k) plan de formación (DOC-2): itinerario «### Recepción» definitivo con las sesiones RC-1…RC-6 sobre el tenant
//       UXDAY, evaluación y refuerzo, y enlaces a las fichas 01-04 y 13-16;
//   (l) FAQ (DOC-2): «## Reservas y huéspedes» con al menos 8 preguntas y sin «Provisional»;
//   (m) higiene: sin ficheros de sesión, sin .raw.png, sin extensiones fuera de .md/.png/.json/.mjs; la receta
//       cachea el token en el directorio temporal del sistema y nunca junto al script;
//   (n) índices: README.md y CLAUDE.md enlazan el manual; docs/manual/README.md enlaza todas las guías, ya no
//       describe lotes no regenerables ni fixDrawer y cita el contrato de la ayuda in-app (que existe);
//   (o) auditoría (DOC-2): existe un docs/audits/TANDA-DOC2-*.md con cifras de capturas y pendientes.
// Corre con `node --test tests/manual-contract.test.mjs` y dentro de `pnpm test` (node --test tests/*.test.mjs).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
const PLAN = "formacion/plan-de-formacion.md";
const FICHAS_DIR = "formacion/fichas";
const FICHAS_INDEX = `${FICHAS_DIR}/README.md`;
const FAQ = "faq.md";
const INDEX_TARGETS = [...GUIDES, FAQ, PLAN, FICHAS_INDEX];
const REQUIRED_MD = ["README.md", ...INDEX_TARGETS];
const CAPTURE_TOOL = "tools/capturas.mjs";
const REQUIRED_FILES = [...REQUIRED_MD, CAPTURE_TOOL];

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

// --- Guía de recepción completa (DOC-2) -------------------------------------------------------------------------
const RECEPTION_GUIDE = "70-recepcion.md";
const RECEPTION_IMG = join(IMG, "recepcion");
const RECEPTION_MIN_PNGS = 12;
// Capítulos (H2 exactos) en este orden; se admiten capítulos extra entre ellos.
const RECEPTION_H2 = [
  "Para quién",
  "Cómo están hechas las capturas",
  "Qué verás en tu menú",
  "Mi día",
  "Llegadas y check-in",
  "Salidas y check-out",
  "Walk-in",
  "Nueva reserva",
  "Ficha de reserva",
  "Lista de reservas",
  "Huéspedes y partes de viajeros",
  "Mensajes de huéspedes",
  "Turno y cierre del día",
  "Live Timeline",
  "Atajos de teclado",
  "Errores frecuentes",
  "Qué no hace todavía",
  "Ver también"
];
// Literales de la aplicación que la guía tiene que citar (acción por fila, cobro, walk-in, atajos, deshacer, factura, cola).
const RECEPTION_LITERALS = ["Check-in en", "Cobrar", "Walk-in", "⌥W", "⌥N", "Deshacer", "Borrador para Facturación", "Posible no-show"];

// --- Marcas provisionales de DOC-1 que DOC-2 retira (búsqueda sin distinguir mayúsculas) ------------------------
const PROVISIONAL_MARKERS = [
  "Provisional (UX-1)",
  "se completa en DOC-2",
  "cajón oculto",
  "cajones laterales ocultos",
  "captura forzada",
  "forzada (fixDrawer)",
  "fixDrawer",
  "(provisional)"
];

// --- Vocabulario de estados (D5): ni enums crudos ni etiquetas viejas fuera del código -----------------------------
const RAW_STATUS_RE = /\b(?:CHECKED_IN|CHECKED_OUT|NO_SHOW|CONFIRMED|CANCELLED)\b/g;
const OLD_STATUS_LABEL_RE = /«(?:ALOJADA|ALOJADO|Alojada|Alojado)»|Salida realizada/g;

// --- Receta regenerable ------------------------------------------------------------------------------------------
const RECIPE_FORBIDDEN = ["fixDrawer", "--fix-drawer", "DRAWER_FIX_CSS"];
const RECIPE_REQUIRED = ['"scroll"', "--out-dir", "--login", "prop_uxday", "direccion@uxday.test"];
const RECIPE_JOB_KEYS = ["login", "noSession", "collapse", "pushState", "cmdk", "hover", "chip"];
const ACTION_VERBS = new Set(["click", "button", "tab", "fill", "select", "waitFor", "wait", "file", "hover", "chip", "cmdk", "pushState", "collapse", "key", "scroll"]);

// --- Fichas rápidas (16, nombres fijos) ---------------------------------------------------------------------------
const FICHAS = [
  "01-entrada-de-huesped.md",
  "02-salida-y-cobro.md",
  "03-nueva-reserva.md",
  "04-cambio-de-habitacion.md",
  "05-cierre-del-dia.md",
  "06-importar-sage.md",
  "07-emitir-factura.md",
  "08-alta-de-usuario.md",
  "09-habitacion-limpia-e-inspeccionada.md",
  "10-parte-de-mantenimiento.md",
  "11-cambiar-tarifa-en-la-parrilla.md",
  "12-parte-de-viajeros.md",
  "13-asiento-manual.md",
  "14-exportar-a-gestoria.md",
  "15-nomina-del-mes.md",
  "16-nuevo-grupo.md"
];
const FICHA_TITLE_PREFIX = "# Ficha · ";
const FICHA_LAST_H2 = "Más detalle";

// --- Plan de formación: itinerario de recepción definitivo ---------------------------------------------------------
const PLAN_RECEPTION_H3_RE = /^### Recepción\s*$/m;
const PLAN_SESSIONS = ["RC-1", "RC-2", "RC-3", "RC-4", "RC-5", "RC-6"];
const PLAN_WORDS = ["UXDAY", "uxday.test", "Evaluación", "Refuerzo"];
const PLAN_FICHAS = ["01", "02", "03", "04", "13", "14", "15", "16"].map((n) => FICHAS.find((f) => f.startsWith(`${n}-`)));

// --- FAQ ----------------------------------------------------------------------------------------------------------
const FAQ_BLOCK = "## Reservas y huéspedes";
const FAQ_MIN_QUESTIONS = 8;
const FAQ_QUESTION_RE = /^\*\*P:\*\*/;

// --- Índices y auditoría ------------------------------------------------------------------------------------------
const HELP_CONTRACT_TEST = "tests/ayuda-in-app-contract.test.mjs";
const README_FORBIDDEN = [
  { literal: "Qué lotes NO regenera", why: "todos los lotes se regeneran con la receta tal cual" },
  { literal: "fixDrawer", why: "el defecto de los cajones está corregido: sin workaround" },
  { literal: "Provisional (UX-1)", why: "la guía de recepción ya es definitiva" }
];
const AUDIT_DIR = "docs/audits";
const AUDIT_FILE_RE = /^TANDA-DOC2-.*\.md$/;
const AUDIT_REQUIRED = [
  { label: BRAND, re: /ehotelOS/ },
  { label: "capturas", re: /capturas/i },
  { label: "pendientes", re: /pendientes/i }
];

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
const manualText = () => manualFiles().filter((file) => TEXT_EXTENSIONS.has(extname(file).toLowerCase()));

/** Sustituye todo salvo los saltos de línea por espacios: los números de línea no cambian. */
const blank = (text) => text.replace(/[^\n]/g, " ");

/** Quita bloques de código (``` … ```) y código en línea (`…`) conservando los saltos de línea. */
function withoutCode(markdown) {
  return markdown.replace(/```[\s\S]*?```/g, blank).replace(/`[^`\n]*`/g, blank);
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Expresión que busca un literal tal cual (`flags` por defecto: sin distinguir mayúsculas). */
const literalRe = (literal, flags = "i") => new RegExp(escapeRe(literal), flags);

/** `ruta:línea: coincidencia` para cada coincidencia de `re` en `text`. */
function findHits(path, text, re) {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  const hits = [];
  for (const match of text.matchAll(global)) hits.push(`${path}:${lineOf(text, match.index)}: ${match[0]}`);
  return hits;
}

/** Títulos H2 (`## …`) con su línea, fuera del código. */
function h2Headings(markdown) {
  const text = withoutCode(markdown);
  const headings = [];
  for (const match of text.matchAll(/^## (.+?)\s*$/gm)) headings.push({ line: lineOf(text, match.index), title: match[1].trim() });
  return headings;
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

/** ¿`file` está dentro de `dir` (sin ser `dir`)? */
const isInside = (dir, file) => file.startsWith(dir + sep);

/** `const JOB_KEYS = new Set([...])` de la receta → Set de claves, o null si no se encuentra. */
function parseJobKeys(source) {
  const match = source.match(/const JOB_KEYS\s*=\s*new Set\(\s*\[([\s\S]*?)\]\s*\)/);
  if (!match) return null;
  return new Set([...match[1].matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] ?? m[2]));
}

/** Línea (mejor esfuerzo) del trabajo `i` dentro del JSON del lote: la de su `out`, si no la de su `url`. */
function jobLine(rawJson, job) {
  for (const value of [job?.out, job?.url]) {
    if (typeof value !== "string") continue;
    const index = rawJson.indexOf(JSON.stringify(value));
    if (index >= 0) return lineOf(rawJson, index);
  }
  return 1;
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

  it("guía de recepción completa", () => {
    const path = `${MANUAL_DIR}/${RECEPTION_GUIDE}`;
    assert.ok(exists(path), `${path} no existe`);
    const file = join(MANUAL, RECEPTION_GUIDE);
    const text = read(path);
    const problems = [];

    // Capítulos: todos presentes y en el orden fijado (se admiten capítulos extra entre ellos).
    const headings = h2Headings(text);
    const positions = RECEPTION_H2.map((title) => headings.find((h) => h.title === title) ?? null);
    RECEPTION_H2.forEach((title, i) => {
      if (!positions[i]) problems.push(`${path}: falta el capítulo «## ${title}»`);
    });
    let previous = null;
    RECEPTION_H2.forEach((title, i) => {
      const current = positions[i];
      if (!current) return;
      if (previous && current.line <= previous.heading.line) {
        problems.push(`${path}:${current.line}: «## ${title}» debería ir después de «## ${previous.title}» (línea ${previous.heading.line})`);
      }
      previous = { title, heading: current };
    });

    // Capturas: al menos RECEPTION_MIN_PNGS PNG distintos de img/recepcion.
    const pngs = new Set(
      relativeReferences(file)
        .filter((ref) => isInside(RECEPTION_IMG, ref.resolved) && extname(ref.resolved).toLowerCase() === ".png")
        .map((ref) => ref.resolved)
    );
    if (pngs.size < RECEPTION_MIN_PNGS) problems.push(`${path}: referencia ${pngs.size} PNG distintos de ${rel(RECEPTION_IMG)} (mínimo ${RECEPTION_MIN_PNGS})`);

    // Literales de la aplicación que la guía tiene que citar.
    for (const literal of RECEPTION_LITERALS) {
      if (!text.includes(literal)) problems.push(`${path}: no cita el literal «${literal}»`);
    }
    assert.deepEqual(problems, [], `Guía de recepción fuera de contrato (${problems.length}):\n${problems.join("\n")}`);
  });

  it("sin marcas provisionales", () => {
    const hits = new Set();
    for (const file of manualText()) {
      const path = rel(file);
      const raw = readFileSync(file, "utf8");
      const text = extname(file) === ".md" ? withoutCode(raw) : raw;
      for (const marker of PROVISIONAL_MARKERS) {
        for (const hit of findHits(path, text, literalRe(marker))) hits.add(hit);
      }
    }
    const list = [...hits].sort();
    assert.deepEqual(list, [], `Marcas provisionales de DOC-1 que DOC-2 retira (${list.length}):\n${list.join("\n")}`);
  });

  it("vocabulario de estados", () => {
    const hits = [];
    for (const file of manualMarkdown()) {
      const path = rel(file);
      const text = withoutCode(readFileSync(file, "utf8"));
      hits.push(...findHits(path, text, RAW_STATUS_RE).map((hit) => `${hit} (nombre técnico del estado; usa el diccionario: «En el hotel», «Salida hecha», «No-show», «Confirmada», «Cancelada»)`));
      hits.push(...findHits(path, text, OLD_STATUS_LABEL_RE).map((hit) => `${hit} (etiqueta anterior; hoy «En el hotel» / «Salida hecha»)`));
    }
    assert.deepEqual(hits, [], `Vocabulario de estados fuera del diccionario (${hits.length}):\n${hits.join("\n")}`);
  });

  it("receta regenerable", () => {
    const problems = [];
    const tool = `${MANUAL_DIR}/${CAPTURE_TOOL}`;
    let jobKeys = null;
    if (!exists(tool)) {
      problems.push(`${tool}: no existe`);
    } else {
      const source = read(tool);
      for (const forbidden of RECIPE_FORBIDDEN) {
        problems.push(...findHits(tool, source, literalRe(forbidden, "")).map((hit) => `${hit} (el defecto de los cajones está corregido: sin workaround)`));
      }
      for (const required of RECIPE_REQUIRED) {
        if (!source.includes(required)) problems.push(`${tool}: falta ${required}`);
      }
      jobKeys = parseJobKeys(source);
      if (!jobKeys) problems.push(`${tool}: no se encuentra «const JOB_KEYS = new Set([...])»`);
      else {
        for (const key of RECIPE_JOB_KEYS) {
          if (!jobKeys.has(key)) problems.push(`${tool}: JOB_KEYS no admite «${key}»`);
        }
      }
    }

    // Lotes: cada trabajo reproducible con la receta tal cual.
    const batches = walk(IMG).filter((file) => basename(file) === BATCH_FILE);
    if (batches.length === 0) problems.push(`${rel(IMG)}: ningún ${BATCH_FILE}`);
    const covered = new Set(); // PNG (absolutos) que algún trabajo regenera
    for (const batch of batches) {
      const path = rel(batch);
      const folder = dirname(batch);
      const raw = readFileSync(batch, "utf8");
      let jobs;
      try {
        jobs = JSON.parse(raw);
      } catch (error) {
        problems.push(`${path}: JSON inválido (${error.message})`);
        continue;
      }
      if (!Array.isArray(jobs)) {
        problems.push(`${path}: el lote debe ser un array de trabajos`);
        continue;
      }
      jobs.forEach((job, i) => {
        const where = `${path}:${jobLine(raw, job)}: trabajo ${i + 1}`;
        if (!job || typeof job !== "object" || Array.isArray(job)) {
          problems.push(`${where}: no es un objeto`);
          return;
        }
        if (jobKeys) {
          const unknown = Object.keys(job).filter((key) => !key.startsWith("_") && !jobKeys.has(key));
          if (unknown.length) problems.push(`${where}: claves que la receta no admite: ${unknown.join(", ")}`);
        }
        if (typeof job.url !== "string" || !job.url) problems.push(`${where}: falta «url»`);
        if (typeof job.out !== "string" || !job.out) {
          problems.push(`${where}: falta «out»`);
        } else {
          const out = resolve(ROOT, job.out);
          if (isAbsolute(job.out)) problems.push(`${where}: «out» debe ser una ruta relativa al monorepo, no absoluta (${job.out})`);
          if (extname(out).toLowerCase() !== ".png") problems.push(`${where}: «out» debe ser un .png (${job.out})`);
          if (!isInside(folder, out)) problems.push(`${where}: «out» debe estar en ${rel(folder)}/ (${job.out})`);
          else if (!existsSync(out)) problems.push(`${where}: «out» apunta a un PNG que no existe (${rel(out)})`);
          else covered.add(out);
        }
        if (job.actions !== undefined) {
          if (!Array.isArray(job.actions)) problems.push(`${where}: «actions» debe ser un array`);
          else {
            job.actions.forEach((step, j) => {
              const keys = step && typeof step === "object" && !Array.isArray(step) ? Object.keys(step) : [];
              if (keys.length !== 1) problems.push(`${where}, paso ${j + 1}: cada paso es un objeto con una sola clave (${JSON.stringify(step)})`);
              else if (!ACTION_VERBS.has(keys[0])) problems.push(`${where}, paso ${j + 1}: verbo «${keys[0]}» que la receta no ejecuta (admite ${[...ACTION_VERBS].join(", ")})`);
            });
          }
        }
      });
    }
    // Al revés: cada PNG del manual tiene un trabajo que lo regenera (ninguna captura tomada a mano).
    for (const png of walk(IMG).filter((file) => extname(file).toLowerCase() === ".png")) {
      if (!covered.has(png)) problems.push(`${rel(png)}: PNG sin trabajo en ${rel(dirname(png))}/${BATCH_FILE} (no se regenera con la receta)`);
    }
    assert.deepEqual(problems, [], `Receta de capturas no regenerable (${problems.length}):\n${problems.join("\n")}`);
  });

  it("fichas", () => {
    const problems = [];
    const guides = new Set(GUIDES.map((guide) => join(MANUAL, guide)));
    const indexPath = `${MANUAL_DIR}/${FICHAS_INDEX}`;
    const linked = exists(indexPath) ? new Set(relativeReferences(join(MANUAL, FICHAS_INDEX)).map((ref) => ref.resolved)) : null;
    if (!linked) problems.push(`${indexPath}: no existe`);
    for (const name of FICHAS) {
      const path = `${MANUAL_DIR}/${FICHAS_DIR}/${name}`;
      const file = join(MANUAL, FICHAS_DIR, name);
      if (!exists(path)) {
        problems.push(`${path}: no existe`);
        continue;
      }
      if (linked && !linked.has(file)) problems.push(`${indexPath}: no enlaza ${name}`);
      const text = read(path);
      if (!text.startsWith(FICHA_TITLE_PREFIX)) problems.push(`${path}:1: debe empezar por «${FICHA_TITLE_PREFIX}»`);
      const headings = h2Headings(text);
      const last = headings.at(-1);
      if (!last || last.title !== FICHA_LAST_H2) {
        problems.push(`${path}: el último capítulo debe ser «## ${FICHA_LAST_H2}»${last ? ` (es «## ${last.title}», línea ${last.line})` : " (no tiene capítulos)"}`);
        continue;
      }
      const guideLinks = relativeReferences(file).filter((ref) => ref.line > last.line && guides.has(ref.resolved));
      if (guideLinks.length === 0) problems.push(`${path}:${last.line}: «## ${FICHA_LAST_H2}» no enlaza ninguna guía (${GUIDES.join(", ")})`);
    }
    assert.deepEqual(problems, [], `Fichas fuera de contrato (${problems.length}):\n${problems.join("\n")}`);
  });

  it("plan de formación", () => {
    const path = `${MANUAL_DIR}/${PLAN}`;
    assert.ok(exists(path), `${path} no existe`);
    const file = join(MANUAL, PLAN);
    const text = read(path);
    const problems = [];
    if (!PLAN_RECEPTION_H3_RE.test(text)) problems.push(`${path}: falta el itinerario «### Recepción» (sin «(provisional)»)`);
    for (const session of PLAN_SESSIONS) {
      if (!text.includes(session)) problems.push(`${path}: falta la sesión «${session}»`);
    }
    for (const word of PLAN_WORDS) {
      if (!text.includes(word)) problems.push(`${path}: no menciona «${word}»`);
    }
    const linked = new Set(relativeReferences(file).map((ref) => ref.resolved));
    for (const name of PLAN_FICHAS) {
      if (!linked.has(join(MANUAL, FICHAS_DIR, name))) problems.push(`${path}: no enlaza la ficha ${name}`);
    }
    assert.deepEqual(problems, [], `Plan de formación fuera de contrato (${problems.length}):\n${problems.join("\n")}`);
  });

  it("plan de formación y FAQ con la copia de pisos y mantenimiento de UX-3 (content/pisos-actions.ts; corrector UX-3-REV-M03)", () => {
    // Los avisos que fija content/pisos-actions.ts (PISOS_TOASTS / MANT_TOASTS) tienen que leerse igual en la formación y en la FAQ; un
    // cambio de copia en el código rompe aquí para que los documentos se actualicen a la vez. Se leen del fuente, no se importa el .ts.
    const actions = read("apps/admin-web/src/content/pisos-actions.ts");
    const template = (name) => {
      const match = actions.match(new RegExp(`\\b${name}: \\([^)]*\\) =>[^\`]*\`([^\`]+)\``));
      assert.ok(match, `content/pisos-actions.ts define ${name}`);
      return match[1];
    };
    // Parte fija tras el último marcador (`Hab. ${n} → Limpia · tarea cerrada` → «→ Limpia · tarea cerrada»): los documentos ponen números reales.
    const fixed = (source) => source.split(/\$\{[^}]+\}/).pop().trim();
    const expected = {
      hkCleanTaskClosed: fixed(template("hkCleanTaskClosed")), // «→ Limpia · tarea cerrada»
      incidentReported: "enviada a mantenimiento", // «Avería de la NNN enviada a mantenimiento · 1 foto»
      taken: fixed(template("taken")), // «→ En curso · asignado a ti»
      statusChanged: "→ En curso", // «Parte X → <estado>» con la etiqueta del diccionario
      undoExpired: fixed(template("undoExpired")) // «ya enviada: no se puede deshacer.»
    };
    for (const [key, literal] of Object.entries(expected)) assert.ok(literal.length >= 10, `${key}: literal fijo legible («${literal}»)`);
    assert.match(actions, /incidentReported: \(n: string, photos = 0\) =>/);
    assert.match(actions, /taken: \(t: string\) => `Parte \$\{t\} → En curso · asignado a ti`/);
    const plan = read(`${MANUAL_DIR}/${PLAN}`);
    const faq = read(`${MANUAL_DIR}/${FAQ}`);
    const problems = [];
    for (const [key, literal] of Object.entries(expected)) {
      const target = key === "undoExpired" ? [["plan", plan], ["faq", faq]] : key === "statusChanged" || key === "taken" ? [["plan", plan]] : [["plan", plan], ...(key === "incidentReported" ? [["faq", faq]] : [])];
      for (const [name, text] of target) if (!text.includes(literal)) problems.push(`${name}: no lleva «${literal}» (${key})`);
    }
    const stale = [
      ["Incidencia reportada a mantenimiento", "aviso anterior a UX-3 (ahora «Avería de la NNN enviada a mantenimiento»)"],
      ["Estado actualizado.", "aviso anterior a UX-3 (ahora «Parte X → <estado>»)"],
      ["no cierra su tarea", "desde UX-3 «Limpia» cierra la tarea (D1)"],
      ["no la asigna a nadie", "desde FIX-1 «Tomar» asigna el parte a quien lo toma"],
      ["Mantenimiento: blocked", "el estado de mantenimiento se pinta por diccionario («Bloqueada»)"],
      ["Aviso «Nota guardada»", "aviso anterior a UX-3 (ahora «Nota añadida al parte X.»)"],
      ["campo «Incidencia»", "el cajón «Reportar incidencia» es de motivo + foto desde UX-3"]
    ];
    for (const [literal, why] of stale) {
      for (const [name, text] of [["plan", plan], ["faq", faq]]) if (text.includes(literal)) problems.push(`${name}: conserva «${literal}» (${why})`);
    }
    assert.deepEqual(problems, [], `Copia de pisos/mantenimiento fuera de contrato (${problems.length}):\n${problems.join("\n")}`);
  });

  it("faq", () => {
    const path = `${MANUAL_DIR}/${FAQ}`;
    assert.ok(exists(path), `${path} no existe`);
    const text = read(path);
    const problems = [];
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.trim() === FAQ_BLOCK);
    if (start < 0) {
      problems.push(`${path}: falta el bloque «${FAQ_BLOCK}»`);
    } else {
      let end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
      if (end < 0) end = lines.length;
      const questions = lines.slice(start + 1, end).filter((line) => FAQ_QUESTION_RE.test(line)).length;
      if (questions < FAQ_MIN_QUESTIONS) problems.push(`${path}:${start + 1}: «${FAQ_BLOCK}» tiene ${questions} preguntas «**P:**» (mínimo ${FAQ_MIN_QUESTIONS})`);
    }
    problems.push(...findHits(path, text, /Provisional/g).map((hit) => `${hit} (la FAQ ya no tiene entradas provisionales)`));
    assert.deepEqual(problems, [], `FAQ fuera de contrato (${problems.length}):\n${problems.join("\n")}`);
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
    const indexPath = `${MANUAL_DIR}/README.md`;
    const index = join(MANUAL, "README.md");
    if (!existsSync(index)) {
      problems.push(`${indexPath}: no existe`);
    } else {
      const linked = new Set(relativeReferences(index).map((ref) => ref.resolved));
      for (const target of INDEX_TARGETS) {
        if (!linked.has(join(MANUAL, target))) problems.push(`${indexPath}: no enlaza ${target}`);
      }
      const text = read(indexPath);
      for (const { literal, why } of README_FORBIDDEN) {
        problems.push(...findHits(indexPath, text, literalRe(literal, "")).map((hit) => `${hit} (${why})`));
      }
      if (!text.includes(HELP_CONTRACT_TEST)) problems.push(`${indexPath}: no cita el contrato de la ayuda in-app (${HELP_CONTRACT_TEST})`);
    }
    if (!exists(HELP_CONTRACT_TEST)) problems.push(`${HELP_CONTRACT_TEST}: no existe`);
    assert.deepEqual(problems, [], `Índices del manual (${problems.length}):\n${problems.join("\n")}`);
  });

  it("auditoría", () => {
    const problems = [];
    const audits = walk(join(ROOT, AUDIT_DIR)).filter((file) => dirname(file) === join(ROOT, AUDIT_DIR) && AUDIT_FILE_RE.test(basename(file)));
    if (audits.length === 0) {
      problems.push(`${AUDIT_DIR}/TANDA-DOC2-*.md: no existe ningún informe de la tanda DOC-2`);
    } else {
      const complete = audits.filter((file) => {
        const text = readFileSync(file, "utf8");
        return AUDIT_REQUIRED.every(({ re }) => re.test(text));
      });
      if (complete.length === 0) {
        for (const file of audits) {
          const text = readFileSync(file, "utf8");
          const missing = AUDIT_REQUIRED.filter(({ re }) => !re.test(text)).map(({ label }) => `«${label}»`);
          problems.push(`${rel(file)}: no menciona ${missing.join(", ")}`);
        }
      }
    }
    assert.deepEqual(problems, [], `Informe de auditoría de DOC-2 fuera de contrato (${problems.length}):\n${problems.join("\n")}`);
  });
});

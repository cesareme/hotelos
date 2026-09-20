// Contrato de la ayuda in-app de ehotelOS (Tanda DOC-2): tarjetas de instrucciones
// (apps/admin-web/src/content/screen-instructions/*.ts) y artículos del centro de
// ayuda (apps/admin-web/src/content/help-articles/*.ts).
//
// Sin red y sin importar los módulos: lee la FUENTE de cada fichero, le quita los
// comentarios y extrae sus literales de cadena (entre comillas dobles, simples o
// acentos graves; una plantilla `…${x}…` cuenta como un solo literal). Sobre esos
// literales comprueba:
//   1 · Vocabulario D5 (content/status-dictionary.ts): ningún literal conserva el
//       vocabulario retirado («En casa», «Alojado/Alojada», «Salida realizada», «No
//       presentado») ni el enum crudo del API (CHECKED_IN, CHECKED_OUT, NO_SHOW,
//       CONFIRMED, checked_in…). Se aplica a TODOS los literales, también a los del
//       catálogo generado keyboard-shortcuts.ts (única regla que se le aplica: el
//       resto de su texto sale del registro y lo cubre tests/shortcuts-catalog-contract).
//   2 · Sin inglés no técnico en los literales de negocio (≥ 20 caracteres, con algún
//       espacio y que no son rutas): lista cerrada
//       de palabras prohibidas (FORBIDDEN_ENGLISH) tras retirar las excepciones
//       explícitas (ALLOWED_TERMS: términos del oficio como «walk-in», «no-show»,
//       «rooming list», «cut-off», siglas como BAR/OTA/PMS…).
//   3 · Ortografía: lista cerrada de palabras que llevan tilde y aquí están prohibidas
//       sin ella como palabra completa (TILDE_REQUIRED), solo en literales de negocio.
//       Heurística: los identificadores, ids, tags, roleTokens, screenId, keys y
//       persistKey son literales cortos o sin espacios y las rutas empiezan por «/»
//       (/recepcion/…), así que la regla no los alcanza; dentro de un literal largo,
//       los tokens con «/» (rutas de ficheros como docs/manual/70-recepcion.md y rutas
//       de la aplicación) se retiran antes de aplicarla, porque van sin tildes a
//       propósito; «periodo» NO está en la lista porque la RAE admite
//       «periodo» y «período» y la aplicación usa la primera.
//   4 · Marca: solo «ehotelOS» (los literales no contienen HotelOS, Anfitorio ni
//       grafías incorrectas de la marca nueva; el nombre real sale de config/brand).
//   5 · Forma de cada tarjeta: cada fichero de screen-instructions exporta al menos un
//       objeto con description + steps (forma B) o whatIsThis + howToUse (forma A) y
//       ningún paso repite exactamente el texto de otro paso del mismo objeto.
//   6 · Contenido verificado en runtime: el artículo «primer-check-in» menciona «En el
//       hotel», «Cobrar saldo», «Sin cobro» y «Check-in en»; troubleshooting no habla
//       de «Guardar» (la Nueva reserva rápida tiene «Crear reserva»).
//   7 · keyboard-shortcuts.ts es GENERADO (scripts/gen-shortcuts.mjs): solo la regla 1.
//   8 · Artículos del manual (help-articles/manual-guides.ts, categoría «Manual de uso»):
//       la tabla «Qué guía es la tuya» de docs/manual/README.md manda. Por cada fila
//       `[Título](fichero.md)` existe un artículo `manual-<slug>` (slug = último segmento
//       del fichero sin «.md» ni el prefijo numérico; un README toma el nombre de su
//       carpeta: formacion/fichas/README.md → manual-fichas) cuyo título contiene el de
//       la guía y cuyo cuerpo cita la ruta `docs/manual/<fichero>`; el cuerpo mide entre
//       900 y 2.000 caracteres, empieza por «# <título>» y lleva «## Qué cubre» y «## Dónde
//       está»; cada elemento «…» de «Qué cubre» y cada «capítulo «…»» (en cualquier
//       fichero de artículos) es un H2 (`## …`) de un .md citado en el mismo cuerpo;
//       ningún artículo contiene `](docs/` ni `](../` (los enlaces relativos no resuelven
//       dentro de la aplicación: se cita nombre y ruta en texto); index.ts (leído como
//       texto) incluye MANUAL_GUIDE_ARTICLES en HELP_ARTICLES entre las guías por puesto y
//       «Qué hago si…», y la categoría se declara como «Manual de uso».
//
// Cómo se amplían las listas: añade la palabra a FORBIDDEN_ENGLISH o a TILDE_REQUIRED
// (una alternativa más del patrón) y, si una palabra inglesa es un término del oficio
// que sí puede aparecer, a ALLOWED_TERMS con su motivo en el comentario.
//
// Corre con `node --test tests/ayuda-in-app-contract.test.mjs` y dentro de
// `node --test tests/*.test.mjs`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONTENT = join(ROOT, "apps", "admin-web", "src", "content");
const SCREEN_DIR = join(CONTENT, "screen-instructions");
const HELP_DIR = join(CONTENT, "help-articles");

/** Ficheros generados: solo la regla 1 (vocabulario D5). */
const GENERATED = new Set(["help-articles/keyboard-shortcuts.ts"]);

/** Un literal «largo» es texto de negocio; los cortos suelen ser ids, tags o teclas. */
const LONG_LITERAL = 20;

/**
 * Texto de negocio para las reglas 2 y 3: literal largo (≥ 20 caracteres) CON algún
 * espacio (los ids, screenIds, tags compuestos con guiones y las claves no lo tienen)
 * y que no es una ruta de la aplicación (empieza por «/»: las rutas van sin tildes
 * a propósito, como /recepcion/reservas).
 */
const isBusinessText = (text) => text.length >= LONG_LITERAL && /\s/.test(text) && !text.startsWith("/");

// ---------------------------------------------------------------------------
// Listas cerradas (ampliables).
// ---------------------------------------------------------------------------

/** 1 · Vocabulario retirado por D5 y enum crudo del API. */
const RETIRED_VOCABULARY = [
  /\bEn casa\b/,
  /\bAlojad[ao]s?\b/,
  /\bSalida realizada\b/,
  /\bNo presentado\b/,
  /\bCHECKED_IN\b/,
  /\bCHECKED_OUT\b/,
  /\bNO_SHOW\b/,
  /\bCONFIRMED\b/,
  /\bchecked_in\b/,
  /\bchecked_out\b/,
  /\bno_show\b/
];

/** 2 · Inglés no técnico prohibido en literales largos. */
const FORBIDDEN_ENGLISH =
  /\b(work orders?|rooms?|photo evidence|severity|blocks|priority queue|m[oó]vil-first|maintenance|operations director|document vault|alerts?|export inspection folder|configuration|pricing|owners|asset managers|dashboard|drill-down|log de|stub|mock|sandbox)\b/i;

/**
 * 2 · Excepciones explícitas: términos del oficio hotelero que sí pueden aparecer
 * (se retiran del literal antes de aplicar FORBIDDEN_ENGLISH). Cada entrada lleva
 * su motivo. Hoy ninguna colisiona con la lista prohibida; la mecánica queda para
 * cuando se amplíe la lista (p. ej. si se prohíbe «list» habrá que exceptuar
 * «rooming list»).
 */
const ALLOWED_TERMS = [
  /\bRevenue\b/g, // nombre de la categoría del menú y del módulo
  /\bwalk-ins?\b/gi, // término de recepción (D5)
  /\bno-shows?\b/gi, // estado de reserva (D5)
  /\bcheck-ins?\b/gi, // acción de recepción (D5)
  /\bcheck-outs?\b/gi, // acción de recepción (D5)
  /\boverbooking\b/gi, // término del oficio
  /\brooming lists?\b/gi, // literal de la pantalla de grupos («Importar rooming list»)
  /\bcut-off\b/gi, // fecha límite de grupos y cupos
  /\bpickup\b/gi, // literal de la pantalla de cupos («Pickup y liberación»)
  /\b(ADR|RevPAR|GOPPAR|BAR|OOO|OOS|PMS|ERP|CRS|RMS|ESRS)\s*\([^)]*\)/g, // desarrollo en inglés de una sigla entre paréntesis, una vez (glosario)
  /\b(BAR|OTA|PMS|GDS|TTOO|ADR|RevPAR|GOPPAR|GOP|USALI|CRS|RMS|ERP|ESRS|SLA|SES|SIF|AEAT|CSV|QR|IVA|IGIC|IPSI|TBAI|LROE)\b/g // siglas
];

/** 3 · Palabras que llevan tilde: prohibidas sin ella como palabra completa (literales largos). */
const TILDE_REQUIRED =
  /\b(gestion|tecnico|semaforo|ambar|accion|envio|envios|jurisdiccion|autonoma|autonomos|regimen|documentacion|unica|movil|hoteleria|dinamicamente|comun|informaticos|pais|numero|telefono|habitacion|recepcion|codigo|facturacion|configuracion|dia|aqui|asi|mas|segun|tambien|automatico|automaticos|proximo|ultimo)\b/i;

/** 4 · Marca: grafías prohibidas (la correcta es «ehotelOS» y sale de config/brand). */
const OLD_BRAND = /\b(?:Anfitorio|ANFITORIO|HotelOS|hotelOS|Hotel OS)\b/;
const BRAND_MISSPELLING = /\b(?:Ehotelos|EhotelOS|EHotelOS|EHOTELOS|eHotelOS|eHotelos|ehotelos)\b/;

// ---------------------------------------------------------------------------
// Lectura de la fuente y extracción de literales.
// ---------------------------------------------------------------------------

const posix = (file) => relative(CONTENT, file).split(sep).join("/");

function listTs(dir) {
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".ts"))
    .sort()
    .map((entry) => join(dir, entry));
}

/** Quita comentarios de bloque y de línea completa (los «//» dentro de un literal, como en una URL, se conservan). */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const LITERAL_RE = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

/** Literales de cadena (sin las comillas) en orden de aparición, con su línea. */
function literalsOf(source) {
  const out = [];
  for (const match of source.matchAll(LITERAL_RE)) {
    const raw = match[0];
    out.push({ text: raw.slice(1, -1), line: source.slice(0, match.index).split("\n").length });
  }
  return out;
}

function withoutAllowedTerms(text) {
  let clean = text;
  for (const re of ALLOWED_TERMS) clean = clean.replace(re, " ");
  return clean;
}

/** Regla 3: los tokens con «/» (docs/manual/70-recepcion.md, /hoy/cierre-del-dia, ⌘/) van sin tildes a propósito. */
function withoutPaths(text) {
  return text.replace(/\S*\/\S*/g, " ");
}

const files = [...listTs(SCREEN_DIR), ...listTs(HELP_DIR)].map((file) => {
  const source = stripComments(readFileSync(file, "utf8"));
  return { rel: posix(file), source, literals: literalsOf(source), generated: GENERATED.has(posix(file)) };
});
const screenFiles = files.filter((file) => file.rel.startsWith("screen-instructions/"));
const helpFiles = files.filter((file) => file.rel.startsWith("help-articles/"));
const authored = files.filter((file) => !file.generated);

function hits(file, re, { businessOnly = false, cleaner = (text) => text } = {}) {
  const found = [];
  for (const literal of file.literals) {
    if (businessOnly && !isBusinessText(literal.text)) continue;
    const match = re.exec(cleaner(literal.text));
    if (match) found.push(`${file.rel}:${literal.line}: «${match[0]}» en «${literal.text.slice(0, 70)}…»`);
  }
  return found;
}

/** Texto del array que sigue a `key:` (corchetes emparejados) o null si no existe. */
function arrayAfter(source, key, from = 0) {
  const at = source.indexOf(`${key}:`, from);
  if (at < 0) return null;
  const open = source.indexOf("[", at);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return { text: source.slice(open, index + 1), end: index + 1 };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Contrato.
// ---------------------------------------------------------------------------

describe("ayuda in-app · ficheros y extracción", () => {
  it("lee las tarjetas y los artículos y extrae literales de negocio de cada uno", () => {
    assert.ok(screenFiles.length >= 12, `solo ${screenFiles.length} tarjetas`);
    assert.ok(helpFiles.length >= 5, `solo ${helpFiles.length} ficheros de artículos`);
    for (const file of authored.filter((entry) => !entry.rel.endsWith("/index.ts"))) {
      const long = file.literals.filter((literal) => literal.text.length >= LONG_LITERAL);
      assert.ok(long.length >= 3, `${file.rel}: solo ${long.length} literales largos (¿ha cambiado el formato?)`);
    }
  });
});

describe("ayuda in-app · 1 · vocabulario D5 (también en el catálogo generado)", () => {
  for (const file of files) {
    it(`${file.rel} no conserva el vocabulario retirado ni el enum crudo`, () => {
      const found = RETIRED_VOCABULARY.flatMap((re) => hits(file, re));
      assert.deepEqual(found, []);
    });
  }
});

describe("ayuda in-app · 2 · sin inglés no técnico en los literales largos", () => {
  for (const file of authored) {
    it(`${file.rel} no usa palabras de la lista prohibida`, () => {
      assert.deepEqual(hits(file, FORBIDDEN_ENGLISH, { businessOnly: true, cleaner: withoutAllowedTerms }), []);
    });
  }
});

describe("ayuda in-app · 3 · ortografía: palabras con tilde obligatoria en los literales largos", () => {
  for (const file of authored) {
    it(`${file.rel} lleva tilde donde toca`, () => {
      assert.deepEqual(hits(file, TILDE_REQUIRED, { businessOnly: true, cleaner: withoutPaths }), []);
    });
  }
});

describe("ayuda in-app · 4 · marca «ehotelOS»", () => {
  for (const file of authored) {
    it(`${file.rel} no escribe la marca anterior ni grafías incorrectas`, () => {
      assert.deepEqual(hits(file, OLD_BRAND), []);
      assert.deepEqual(hits(file, BRAND_MISSPELLING), []);
    });
  }
});

describe("ayuda in-app · 5 · forma de las tarjetas de instrucciones", () => {
  for (const file of screenFiles) {
    it(`${file.rel} exporta una tarjeta (description+steps o whatIsThis+howToUse) sin pasos repetidos`, () => {
      const formB = file.source.includes("description:") && file.source.includes("steps:");
      const formA = file.source.includes("whatIsThis:") && file.source.includes("howToUse:");
      assert.ok(formA || formB, `${file.rel}: ni forma A (whatIsThis + howToUse) ni forma B (description + steps)`);
      let objects = 0;
      for (const key of ["howToUse", "steps"]) {
        let from = 0;
        for (;;) {
          const block = arrayAfter(file.source, key, from);
          if (!block) break;
          objects += 1;
          const steps = literalsOf(block.text).map((literal) => literal.text.trim());
          assert.ok(steps.length >= 2, `${file.rel}: «${key}» con menos de dos pasos`);
          assert.equal(new Set(steps).size, steps.length, `${file.rel}: paso repetido en «${key}»`);
          from = block.end;
        }
      }
      assert.ok(objects >= 1, `${file.rel}: sin lista de pasos`);
    });
  }
});

describe("ayuda in-app · 6 · contenido verificado en runtime", () => {
  const gettingStarted = files.find((file) => file.rel === "help-articles/getting-started.ts");
  const troubleshooting = files.find((file) => file.rel === "help-articles/troubleshooting.ts");

  it("«Cómo hacer mi primer check-in» describe el cajón real de Mi día", () => {
    assert.ok(gettingStarted, "falta help-articles/getting-started.ts");
    const article = gettingStarted.literals.map((literal) => literal.text).find((text) => text.includes("# Cómo hacer mi primer check-in"));
    assert.ok(article, "no se encuentra el artículo «Cómo hacer mi primer check-in»");
    for (const expected of ["En el hotel", "Cobrar saldo", "Sin cobro", "Check-in en"]) {
      assert.ok(article.includes(expected), `el artículo del primer check-in no menciona «${expected}»`);
    }
  });

  it("«Qué hago si…» no habla de «Guardar»: la Nueva reserva tiene «Crear reserva»", () => {
    assert.ok(troubleshooting, "falta help-articles/troubleshooting.ts");
    assert.deepEqual(hits(troubleshooting, /\bGuardar\b|\bGuardando\b/), []);
    const bodies = troubleshooting.literals.map((literal) => literal.text).filter((text) => text.length >= LONG_LITERAL);
    assert.ok(bodies.some((text) => text.includes("«Crear reserva»")), "troubleshooting no cita «Crear reserva»");
  });
});

// ---------------------------------------------------------------------------
// 8 · Artículos del manual («Manual de uso»): uno por guía del README del manual.
// ---------------------------------------------------------------------------

const MANUAL_DIR = join(ROOT, "docs", "manual");
const MANUAL_README = "docs/manual/README.md";
const MANUAL_GUIDES_FILE = "help-articles/manual-guides.ts";
const MANUAL_INDEX_FILE = "help-articles/index.ts";
const MANUAL_CATEGORY = "Manual de uso";
const MANUAL_BODY_MIN = 900;
const MANUAL_BODY_MAX = 2000;
const MANUAL_PATH_RE = /docs\/manual\/[\w./-]+\.md/g;
const CHAPTER_RE = /capítulo «([^«»]+)»/g;

/** Filas de la tabla «Qué guía es la tuya» del README: `| [Título](fichero.md) | …`. */
function readmeGuideRows() {
  const rows = [];
  for (const [index, line] of readFileSync(join(ROOT, MANUAL_README), "utf8").split("\n").entries()) {
    const match = /^\|\s*\[([^\]]+)\]\(([^)\s]+\.md)\)\s*\|/.exec(line);
    if (match) rows.push({ title: match[1], file: match[2], line: index + 1 });
  }
  return rows;
}

/** manual-<slug>: último segmento sin «.md» ni prefijo numérico; un README toma el nombre de su carpeta. */
function slugOf(file) {
  const segments = file.split("/");
  let base = segments.pop().replace(/\.md$/, "");
  if (base === "README") base = segments.pop();
  return base.replace(/^\d+-/, "");
}

/** Los H2 («## …») de un .md del manual, sin el «## » (null si el fichero no existe). */
function h2Of(relativeMd) {
  const file = join(ROOT, relativeMd);
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim());
}

/** Texto de un cuerpo tal como lo pinta el centro de ayuda: marca resuelta y acentos graves sin escapar. */
const renderedBody = (raw) => raw.replace(/\$\{BRAND\.name\}/g, "ehotelOS").replace(/\\`/g, "`");

const ARTICLE_RE = /id:\s*"([^"]+)",\s*title:\s*"([^"]+)",\s*category:\s*([^,]+),\s*tags:\s*\[([^\]]*)\],\s*bodyMd:\s*`((?:[^`\\]|\\.)*)`/g;

/** Los artículos de un fichero de help-articles leídos de su FUENTE (sin importar TS). */
function articlesOf(file) {
  const out = [];
  for (const match of file.source.matchAll(ARTICLE_RE)) {
    out.push({
      id: match[1],
      title: match[2],
      category: match[3].trim(),
      body: renderedBody(match[5]),
      line: file.source.slice(0, match.index).split("\n").length
    });
  }
  return out;
}

/** Elementos «…» de la lista que sigue a «## Qué cubre» (hasta el siguiente «## »). */
function coveredChapters(body) {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## Qué cubre");
  if (start < 0) return null;
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const item = /^- «(.+)»(?:: .*)?$/.exec(line.trim());
    if (item) items.push(item[1]);
  }
  return items;
}

/** Cada «capítulo «X»» del texto existe como H2 en alguno de los .md del manual citados en ese mismo texto. */
function unknownChapters(body) {
  const cited = Array.from(new Set(body.match(MANUAL_PATH_RE) ?? []));
  const headings = new Set(cited.flatMap((path) => h2Of(path) ?? []));
  const missing = [];
  for (const match of body.matchAll(CHAPTER_RE)) {
    if (!headings.has(match[1])) missing.push(`capítulo «${match[1]}» no es un H2 de ${cited.join(", ") || "(ningún fichero citado)"}`);
  }
  return missing;
}

describe("ayuda in-app · 8 · artículos del manual («Manual de uso»)", () => {
  const guidesFile = files.find((file) => file.rel === MANUAL_GUIDES_FILE);
  const indexFile = files.find((file) => file.rel === MANUAL_INDEX_FILE);
  const rows = readmeGuideRows();
  const articles = guidesFile ? articlesOf(guidesFile) : [];

  it("la tabla «Qué guía es la tuya» del README del manual tiene sus once filas y cada fichero existe", () => {
    assert.ok(rows.length >= 11, `${MANUAL_README}: solo ${rows.length} filas con [Título](fichero.md)`);
    for (const row of rows) assert.ok(existsSync(join(MANUAL_DIR, row.file)), `${MANUAL_README}:${row.line}: falta docs/manual/${row.file}`);
  });

  it("manual-guides.ts declara la categoría «Manual de uso» y todos sus artículos la usan", () => {
    assert.ok(guidesFile, `falta ${MANUAL_GUIDES_FILE}`);
    assert.match(guidesFile.source, /MANUAL_GUIDES_CATEGORY\s*=\s*"Manual de uso"/, `${MANUAL_GUIDES_FILE}: MANUAL_GUIDES_CATEGORY debe valer «${MANUAL_CATEGORY}»`);
    assert.ok(articles.length >= 11, `${MANUAL_GUIDES_FILE}: solo ${articles.length} artículos reconocidos (¿ha cambiado el formato id/title/category/tags/bodyMd?)`);
    for (const article of articles) {
      assert.equal(article.category, "MANUAL_GUIDES_CATEGORY", `${MANUAL_GUIDES_FILE}:${article.line}: ${article.id} no usa MANUAL_GUIDES_CATEGORY`);
      assert.match(article.id, /^manual-[a-z0-9-]+$/, `${MANUAL_GUIDES_FILE}:${article.line}: id ${article.id} no es manual-<slug>`);
    }
  });

  it("hay un artículo manual-<slug> por fila del README, con el título de la guía y la ruta del fichero", () => {
    const byId = new Map(articles.map((article) => [article.id, article]));
    for (const row of rows) {
      const id = `manual-${slugOf(row.file)}`;
      const article = byId.get(id);
      assert.ok(article, `${MANUAL_README}:${row.line}: falta el artículo ${id} para «${row.title}» en ${MANUAL_GUIDES_FILE}`);
      assert.ok(article.title.includes(row.title), `${MANUAL_GUIDES_FILE}:${article.line}: el título «${article.title}» no contiene «${row.title}»`);
      assert.ok(article.body.includes(`docs/manual/${row.file}`), `${MANUAL_GUIDES_FILE}:${article.line}: ${id} no cita docs/manual/${row.file}`);
    }
    const expected = new Set(rows.map((row) => `manual-${slugOf(row.file)}`));
    for (const article of articles) assert.ok(expected.has(article.id), `${MANUAL_GUIDES_FILE}:${article.line}: ${article.id} no corresponde a ninguna fila del README`);
  });

  it("el artículo «Plan de formación» cita el itinerario de recepción con el número real de sesiones RC-n del plan", () => {
    const article = articles.find((entry) => entry.id === "manual-plan-de-formacion");
    assert.ok(article, `${MANUAL_GUIDES_FILE}: falta el artículo manual-plan-de-formacion`);
    const where = `${MANUAL_GUIDES_FILE}:${article.line}`;
    const cited = /RC-1 a RC-(\d+)/.exec(article.body);
    assert.ok(cited, `${where}: el artículo no dice «RC-1 a RC-n»`);
    const plan = readFileSync(join(ROOT, "docs/manual/formacion/plan-de-formacion.md"), "utf8");
    const sessions = new Set([...plan.matchAll(/^\| RC-(\d+) · /gm)].map((match) => Number(match[1])));
    assert.ok(sessions.size >= 4, "docs/manual/formacion/plan-de-formacion.md: la tabla de sesiones RC-n tiene menos de 4 filas");
    const last = Math.max(...sessions);
    assert.equal(Number(cited[1]), last, `${where}: el artículo dice «RC-1 a RC-${cited[1]}» y el plan tiene RC-1 a RC-${last}`);
  });

  for (const article of articles) {
    it(`${article.id}: cuerpo de 900-2.000 caracteres con «# título», «Qué cubre» y «Dónde está»`, () => {
      const where = `${MANUAL_GUIDES_FILE}:${article.line}`;
      assert.ok(article.body.length >= MANUAL_BODY_MIN && article.body.length <= MANUAL_BODY_MAX, `${where}: ${article.id} mide ${article.body.length} caracteres`);
      assert.ok(article.body.startsWith(`# ${article.title}\n`), `${where}: el cuerpo no empieza por «# ${article.title}»`);
      assert.ok(article.body.includes("\n## Qué cubre\n"), `${where}: falta «## Qué cubre»`);
      assert.ok(article.body.includes("\n## Dónde está\n"), `${where}: falta «## Dónde está»`);
    });

    it(`${article.id}: cada elemento de «Qué cubre» y cada «capítulo «…»» es un H2 de la guía citada`, () => {
      const where = `${MANUAL_GUIDES_FILE}:${article.line}`;
      const cited = Array.from(new Set(article.body.match(MANUAL_PATH_RE) ?? []));
      assert.ok(cited.length >= 1, `${where}: ${article.id} no cita ningún docs/manual/….md`);
      const headings = new Set(cited.flatMap((path) => h2Of(path) ?? []));
      const covered = coveredChapters(article.body);
      assert.ok(covered && covered.length >= 2, `${where}: «Qué cubre» con menos de dos capítulos «…»`);
      for (const chapter of covered) assert.ok(headings.has(chapter), `${where}: «${chapter}» de «Qué cubre» no es un H2 de ${cited.join(", ")}`);
      assert.deepEqual(unknownChapters(article.body).map((text) => `${where}: ${text}`), []);
    });
  }

  for (const file of helpFiles.filter((entry) => !entry.generated)) {
    it(`${file.rel}: sin enlaces relativos al manual y con cada «capítulo «…»» resuelto en un fichero citado`, () => {
      for (const literal of file.literals) {
        assert.ok(!literal.text.includes("](docs/") && !literal.text.includes("](../"), `${file.rel}:${literal.line}: enlace relativo «${literal.text.slice(0, 60)}…» (los enlaces no resuelven dentro de la aplicación)`);
      }
      const missing = file.literals.filter((literal) => isBusinessText(literal.text)).flatMap((literal) => unknownChapters(renderedBody(literal.text)).map((text) => `${file.rel}:${literal.line}: ${text}`));
      assert.deepEqual(missing, []);
    });
  }

  it("index.ts incluye MANUAL_GUIDE_ARTICLES en HELP_ARTICLES entre las guías por puesto y «Qué hago si…»", () => {
    assert.ok(indexFile, `falta ${MANUAL_INDEX_FILE}`);
    assert.match(indexFile.source, /from "\.\/manual-guides"/, `${MANUAL_INDEX_FILE}: no importa ./manual-guides`);
    const start = indexFile.source.indexOf("export const HELP_ARTICLES");
    const end = start < 0 ? -1 : indexFile.source.indexOf("];", start);
    assert.ok(start >= 0 && end > start, `${MANUAL_INDEX_FILE}: no se encuentra el array HELP_ARTICLES`);
    const block = { text: indexFile.source.slice(start, end) };
    const persona = block.text.indexOf("personaGuideArticles()");
    const manual = block.text.indexOf("MANUAL_GUIDE_ARTICLES");
    const trouble = block.text.indexOf("TROUBLESHOOTING_ARTICLES");
    assert.ok(manual >= 0, `${MANUAL_INDEX_FILE}: HELP_ARTICLES no incluye MANUAL_GUIDE_ARTICLES`);
    assert.ok(persona >= 0 && persona < manual && manual < trouble, `${MANUAL_INDEX_FILE}: MANUAL_GUIDE_ARTICLES debe ir tras personaGuideArticles() y antes de TROUBLESHOOTING_ARTICLES`);
    assert.match(indexFile.source, /export \{[^}]*\bMANUAL_GUIDE_ARTICLES\b[^}]*\}/, `${MANUAL_INDEX_FILE}: no reexporta MANUAL_GUIDE_ARTICLES`);
  });
});

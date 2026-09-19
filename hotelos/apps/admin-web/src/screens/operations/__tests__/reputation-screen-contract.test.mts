// Contract test · Tanda T8 · lote T8-G — pantallas de reputación (estático,
// sobre el código fuente; las pantallas y el cliente cargan api-client con
// `import.meta.env` y no se ejecutan bajo node --test):
//   · los seis Drawer/Dialog nuevos de operations/reputation/ nacen con 0
//     `style={`, 0 colores literales y 0 <textarea>/<input>/<select> crudos
//     (Cocoa 22 · reglas 4, 5 y 6);
//   · ReputationDashboard baja a 0 `style={` (tenía 6); Surveys y Quality no
//     suman (5 y 6);
//   · las tres pantallas conservan useScreenModuleGate y su poll de dashboard;
//   · cada endpoint que usa services/reputationApi.ts está en la lista
//     permitida (12 rutas de T8-D + rutas vivas del motor genérico + dashboard)
//     y ninguna termina en /dashboard (l2-motor-generico.test.mts);
//   · las copys clave están en español y no vuelven los rótulos ingleses.
// Desde apps/api:
//   TSX_TSCONFIG_PATH=../admin-web/tsconfig.json node --import tsx --test ../admin-web/src/screens/operations/__tests__/reputation-screen-contract.test.mts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const NEW_FILES = [
  "../reputation/ReviewDetailDrawer.tsx",
  "../reputation/ReviewDraftDialog.tsx",
  "../reputation/ReviewSourceDrawer.tsx",
  "../reputation/ReviewImportDrawer.tsx",
  "../reputation/QualityCaseDrawer.tsx",
  "../reputation/SurveyEditorDrawer.tsx"
] as const;

const SCREENS = { ReputationDashboard: "../ReputationDashboard.tsx", SurveysDashboard: "../SurveysDashboard.tsx", QualityDashboard: "../QualityDashboard.tsx" } as const;
const STYLE_BUDGET: Record<keyof typeof SCREENS, number> = { ReputationDashboard: 0, SurveysDashboard: 5, QualityDashboard: 6 };

const api = source("../../../services/reputationApi.ts");
const helpers = source("../reputation/reputation-helpers.ts");

const RAW_INPUT = /<(?:input|select|textarea)\b[^>]*>/g;
const HEX_COLOUR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const COLOUR_FN = /\b(?:rgba?|hsla?)\(/g;
const COLOUR_CONTEXT = /color|background|border|fill|stroke|shadow|gradient|accent|tone|palette|hex|["'`]#[0-9a-fA-F]{3,8}["'`]/i;

function colourLiterals(src: string): string[] {
  const hits: string[] = [];
  for (const m of src.matchAll(HEX_COLOUR)) {
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    const lineEnd = src.indexOf("\n", m.index);
    const line = src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    if (COLOUR_CONTEXT.test(line)) hits.push(line.trim());
  }
  for (const m of src.matchAll(COLOUR_FN)) hits.push(m[0]);
  return hits;
}

const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

/** Rutas permitidas: literales de plantilla del cliente, con `${enc(x)}` normalizado a `:x`. */
const ALLOWED_PATHS = new Set([
  "/dashboards/reputation",
  "/reputation/properties/:propertyId/inbox",
  "/reputation/properties/:propertyId/sources",
  "/reputation/properties/:propertyId/sources/:id",
  "/reputation/properties/:propertyId/sources/:id/sync",
  "/reputation/properties/:propertyId/runs",
  "/reputation/properties/:propertyId/imports",
  "/reputation/reviews/:id",
  "/reputation/reviews/:id/draft",
  "/reputation/reviews/:id/quality-case",
  "/reputation/reviews/:id/respond",
  "/quality/properties/:propertyId/cases",
  "/quality/cases/:id",
  "/surveys/properties/:propertyId",
  "/surveys/:id/responses"
]);

function pathsUsedBy(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/apiRequest<(?:[^<>]|<[^<>]*>)*>\(\s*(`[^`]+`|"[^"]+")/g)) {
    const literal = m[1]!.slice(1, -1);
    const normalised = literal
      .replace(/\$\{reputationPropertyPath\([^)]*\)\}/g, "/reputation/properties/:propertyId")
      .replace(/\$\{enc\(propertyId\)\}/g, ":propertyId")
      .replace(/\$\{enc\([a-zA-Z]+Id\)\}/g, ":id");
    out.add(normalised);
  }
  return [...out].sort();
}

describe("T8-G · Drawer/Dialog de reputación nacen limpios (Cocoa 22)", () => {
  for (const rel of NEW_FILES) {
    const src = source(rel);
    const name = rel.split("/").pop()!;
    it(`${name}: 0 style={, 0 colores literales, 0 controles crudos`, () => {
      assert.equal(count(src, /\bstyle=\{/g), 0, `${name} pinta style={`);
      assert.deepEqual(colourLiterals(src), [], `${name} tiene colores literales`);
      assert.equal(count(src, /<textarea/g), 0, `${name} pinta un <textarea> crudo`);
      assert.deepEqual([...src.matchAll(RAW_INPUT)].map((m) => m[0]).filter((tag) => !/type="(?:file|hidden)"/.test(tag)), [], `${name} pinta inputs crudos`);
      assert.match(src, /from "\.\.\/\.\.\/\.\.\/components\/cocoa"/, `${name} importa las primitivas Cocoa`);
      assert.doesNotMatch(src, /\bfetch\s*\(/, `${name} no llama a fetch: todo por reputationApi`);
      assert.match(name, /(Drawer|Dialog)\.tsx$/, "sufijo Drawer/Dialog (HEADER_EXEMPT de la regla 7)");
    });
  }

  it("las áreas de texto largas son CocoaInput multiline (respuesta, borrador, descripción, preguntas, comentario)", () => {
    assert.match(source("../reputation/ReviewDetailDrawer.tsx"), /<CocoaInput multiline rows=\{6\}/);
    assert.match(source("../reputation/ReviewDraftDialog.tsx"), /<CocoaInput multiline rows=\{7\}/);
    assert.match(source("../reputation/QualityCaseDrawer.tsx"), /<CocoaInput multiline rows=\{4\}/);
    assert.match(source("../reputation/SurveyEditorDrawer.tsx"), /<CocoaInput multiline rows=\{6\}/);
  });
});

describe("T8-G · pantallas de reputación", () => {
  for (const [name, rel] of Object.entries(SCREENS) as Array<[keyof typeof SCREENS, string]>) {
    const src = source(rel);
    it(`${name}: gate de módulo, poll del dashboard, style={ ≤ ${STYLE_BUDGET[name]}, sin colores ni controles crudos`, () => {
      assert.match(src, new RegExp(`useScreenModuleGate\\("${name}"\\)`));
      assert.match(src, /pollIntervalMs/);
      assert.match(src, /\/dashboards\/(reputation|surveys|quality)/);
      assert.ok(count(src, /\bstyle=\{/g) <= STYLE_BUDGET[name], `${name}: ${count(src, /\bstyle=\{/g)} style={ > ${STYLE_BUDGET[name]}`);
      assert.deepEqual(colourLiterals(src), []);
      assert.equal(count(src, /<textarea/g), 0);
      assert.deepEqual([...src.matchAll(RAW_INPUT)].map((m) => m[0]).filter((tag) => !/type="(?:file|hidden)"/.test(tag)), []);
      assert.match(src, /export function [A-Za-z]+Dashboard\(\)/, "conserva el export con nombre que pinan los loaders de ReputacionTabs");
    });
  }

  it("ReputationDashboard: KPI del índice, estado honesto y las tres secciones locales con sus drawers", () => {
    const src = source(SCREENS.ReputationDashboard);
    for (const copy of ["Índice de reputación (30 d)", "Reseñas · 30 días", "Pendientes de respuesta", "Tasa de respuesta", "Mediana de respuesta", "Configurar fuentes", "Importar CSV", "Sincronizar ahora"]) {
      assert.ok(src.includes(copy), `falta «${copy}»`);
    }
    for (const local of ["function SourcesSection(", "function CategoriesSection(", "function InboxSection(", "function DistributionSection("]) assert.ok(src.includes(local), `falta ${local}`);
    for (const drawer of ["ReviewDetailDrawer", "ReviewImportDrawer", "ReviewSourceDrawer"]) assert.ok(src.includes(`<${drawer}`), `no monta ${drawer}`);
    assert.match(src, /indexStatusCopy\(/);
    assert.match(src, /indexTone\(/);
    assert.match(src, /CocoaSegmentedControl/);
    assert.match(src, /useNavGate\(/);
    assert.match(src, /canRespond\(/);
    assert.doesNotMatch(src, /\/ 5"/, "la escala sobre 5 se retira: el índice es 0-100 y la nota sobre 10");
    assert.doesNotMatch(src, /Valoración media/);
  });

  it("SurveysDashboard: «Nueva encuesta» (surveys.manage) y «Registrar respuesta» abren SurveyEditorDrawer", () => {
    const src = source(SCREENS.SurveysDashboard);
    assert.match(src, /Nueva encuesta/);
    assert.match(src, /Registrar respuesta/);
    assert.match(src, /<SurveyEditorDrawer/);
    assert.match(src, /canManageSurveys\(/);
  });

  it("QualityDashboard: «Nuevo caso», transición desde la lista y caption real del SLA", () => {
    const src = source(SCREENS.QualityDashboard);
    assert.match(src, /Nuevo caso/);
    assert.match(src, /Cambiar estado/);
    assert.match(src, /<QualityCaseDrawer/);
    assert.match(src, /qualitySlaCaption\(kpis\)/);
    assert.doesNotMatch(src, /sin objetivo de SLA configurado/, "el caption fijo se sustituye por el cálculo real");
    assert.match(src, /fromReviews/);
    assert.match(src, /kind: "transition"/);
  });
});

describe("T8-G · services/reputationApi.ts", () => {
  it("solo usa rutas permitidas (12 de T8-D + motor genérico + dashboard) y ninguna termina en /dashboard", () => {
    const used = pathsUsedBy(api);
    assert.ok(used.length >= 15, `se esperaban ≥ 15 rutas, hay ${used.length}: ${used.join(", ")}`);
    const unknown = used.filter((path) => !ALLOWED_PATHS.has(path));
    assert.deepEqual(unknown, [], `rutas fuera de la lista permitida: ${unknown.join(", ")}`);
    assert.ok(!used.some((path) => path.endsWith("/dashboard")), "GET /reputation/properties/:id/dashboard está retirada (l2-motor-generico)");
    for (const path of ALLOWED_PATHS) assert.ok(used.includes(path), `el cliente no cubre ${path}`);
  });

  it("todo pasa por apiRequest, los errores por reputationErrorMessage y el CSV viaja en contentBase64", () => {
    assert.doesNotMatch(api, /\bfetch\s*\(/);
    assert.match(api, /import \{ apiRequest \} from "\.\/api-client"/);
    assert.match(api, /reputationErrorMessage/);
    assert.match(api, /contentBase64\?: string/);
    assert.match(api, /envelope: "1"/, "casos y encuestas se piden con envelope para leer { items, nextCursor, total }");
    assert.doesNotMatch(api, /credentialsJson|accessToken|refreshToken|apiKey|clientSecret/, "nunca credenciales en el cliente");
  });
});

describe("T8-G · español y textos honestos", () => {
  it("las copys del flujo de publicación y del borrador existen en los helpers y en los drawers", () => {
    assert.match(helpers, /"Ya la he publicado en el portal"/);
    assert.match(helpers, /"Se ha enviado a revisión humana; aprobar no publica\."/);
    assert.match(helpers, /"Copiar y abrir portal"/);
    assert.match(helpers, /"Contenido purgado por retención"/);
    assert.match(helpers, /Sin conexión: /);
    const detail = source("../reputation/ReviewDetailDrawer.tsx");
    assert.match(detail, /MANUAL_PUBLICATION_CONFIRM_LABEL/);
    assert.match(detail, /DRAFT_REVIEW_NOTICE/);
    assert.match(detail, /PURGED_BODY_COPY/);
    assert.match(detail, /respondReview\(/);
    assert.match(detail, /publicationPatches\(/);
  });

  it("ningún fichero nuevo vuelve a los rótulos ingleses del director", () => {
    for (const rel of [...NEW_FILES, ...Object.values(SCREENS)]) {
      const src = source(rel);
      assert.doesNotMatch(src, /Reviews score|Service requests|VIPs in-house/, `${rel} contiene un rótulo inglés`);
    }
  });
});

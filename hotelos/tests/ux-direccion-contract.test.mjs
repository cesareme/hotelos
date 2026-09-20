// Tanda UX-2 · contrato de dirección (diseño docs/design/UX-DIRECCION-FEEL.md §4 D2/D9;
// corrector UX2-REV-05 seguridad): lo que las pantallas de dirección, las specs de
// medida y sus helpers deben cumplir para que la tanda no se degrade en silencio.
//
//   1 · Una región viva PROPIA como máximo por pantalla de dirección (role="status" /
//       role="alert" / <CocoaLiveRegion> explícitos); en Mi día › Dirección los vacíos
//       inline de CocoaState van con role="none" y el listado de VIP no anuncia nada.
//   2 · Los comandos ⌘K de tarea están registrados (ids estables) en las 8 pantallas.
//   3 · 0 literales ingleses de la lista de la tanda (F-D2, R-8, REV-05) en
//       screens/{operations,approvals,reports,aiOperations} y components/cocoa-director;
//       todo `reviewType` que escribe el API tiene etiqueta en ai-review-labels.ts.
//   4 · 0 fechas literales (YYYY-MM-DD) en el código de esas cuatro carpetas.
//   5 · Specs de medida: 6 ficheros d1…d6 sobre `_helpers-direccion` + `_measure-direccion`
//       con `createMeasure(page, "dN")` y título «dN · …» sin PII; `results-direccion.json`
//       ignorado por git; el helper no admite overrides por entorno y solo escribe en prop_uxday*.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "apps/admin-web/src");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const stripComments = (source) =>
  source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^[ \t]*\/\*\*?[\s\S]*?\*\//gm, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
    .replace(/[ \t]\/\/[^"'`\n]*$/gm, "");
const listTs = (dir) =>
  readdirSync(join(SRC, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && /\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts"))
    .map((e) => `${dir}/${e.name}`);

/** Las 8 pantallas de dirección y sus comandos de tarea (ids estables). */
const SCREENS = {
  "screens/operations/GeneralManagerScreen.tsx": ["general-manager-pendientes", "general-manager-cierre", "general-manager-cartera", "general-manager-exportar"],
  "screens/operations/OperationsDirectorScreen.tsx": ["operations-director-alertas", "operations-director-pisos", "operations-director-mantenimiento"],
  "screens/approvals/ApprovalsScreen.tsx": ["approvals-approve-selected", "approvals-reject-selected"],
  "screens/aiOperations/AiHumanReviewQueueScreen.tsx": ["ai-review-approve-selected"],
  "screens/operations/PortfolioDashboard.tsx": ["cartera-comparar", "cartera-ordenar-ocupacion", "cartera-ordenar-ingresos"],
  "screens/operations/PropertyDetailScreen.tsx": ["cartera-propiedad-pyg", "cartera-propiedad-cierre", "cartera-propiedad-informe", "cartera-propiedad-back"],
  "screens/reports/ReportingCenterScreen.tsx": ["centro-informes-export", "centro-informes-export-reservas", "centro-informes-export-facturacion"],
  "screens/operations/NightAuditScreen.tsx": ["night-audit-review", "night-audit-open-queue"]
};

/** Rótulos ingleses del recon (F-D2), de los componentes compartidos (R-8) y de la IA (REV-05): ninguno puede seguir. */
const ENGLISH_LITERALS = [
  '"Arrivals"', '"Departures"', '"OOO rooms"', '"Net contribution"', '"Pickup 7d"', '"Workforce"', '"Safety"', "Demand spikes", "vs LY",
  ">Segments<", "BAR Recommendations", "VIPs in-house", "No segment data", "Hotel segments mix", "Guest message reply", "Rate change",
  '"Pre-arrival"', '"In-house"', '"Departing today"', '"Approve"', '"Reject"', "¿Aprobar", "¿Rechazar", "Service requests", "Reviews score"
];

const DIRS = ["screens/operations", "screens/approvals", "screens/reports", "screens/aiOperations", "components/cocoa-director"];

describe("dirección · 1 · una región viva propia por pantalla", () => {
  for (const rel of Object.keys(SCREENS)) {
    it(`${rel}: ≤ 1 role=status/alert o CocoaLiveRegion explícitos`, () => {
      const code = stripComments(read(`apps/admin-web/src/${rel}`));
      const own = (code.match(/role="status"|role="alert"|<CocoaLiveRegion\b/g) ?? []).length;
      assert.ok(own <= 1, `${rel}: ${own} regiones vivas propias`);
    });
  }
  it("Mi día › Dirección: todo CocoaState vacío inline/dashed va con role=\"none\" (los anuncios los hace el shell)", () => {
    const code = stripComments(read("apps/admin-web/src/screens/operations/GeneralManagerScreen.tsx"));
    const empties = code.match(/<CocoaState kind="empty"[^>]*>/g) ?? [];
    assert.ok(empties.length >= 3, `hay vacíos inline en el panel (${empties.length})`);
    for (const tag of empties) assert.match(tag, /role="none"/, tag);
    assert.match(read("apps/admin-web/src/components/cocoa/CocoaState.tsx"), /role\?: "status" \| "alert" \| "none";/);
  });
  it("los componentes del director no anuncian sus vacíos", () => {
    for (const rel of listTs("components/cocoa-director")) {
      assert.doesNotMatch(stripComments(read(`apps/admin-web/src/${rel}`)), /role="status"|role="alert"|aria-live=/, rel);
    }
  });
});

describe("dirección · 2 · comandos ⌘K de tarea registrados", () => {
  for (const [rel, ids] of Object.entries(SCREENS)) {
    it(`${rel}: ${ids.join(" · ")}`, () => {
      const code = read(`apps/admin-web/src/${rel}`);
      assert.match(code, /commands=\{\[/, "CocoaPage con commands");
      for (const id of ids) assert.ok(code.includes(`id: "${id}"`), `falta el comando ${id}`);
    });
  }
});

describe("dirección · 3 · 0 literales ingleses de la lista", () => {
  const files = DIRS.flatMap(listTs);
  it(`recorre ${files.length} ficheros de ${DIRS.length} carpetas`, () => {
    assert.ok(files.length >= 40, `ficheros: ${files.length}`);
  });
  for (const literal of ENGLISH_LITERALS) {
    it(`sin ${literal}`, () => {
      const hits = files.filter((rel) => stripComments(read(`apps/admin-web/src/${rel}`)).includes(literal));
      assert.deepEqual(hits, [], `${literal} sigue en: ${hits.join(", ")}`);
    });
  }
  it("cada reviewType que escribe el API tiene etiqueta en ai-review-labels.ts (nunca un enum humanizado en dirección)", () => {
    const labels = read("apps/admin-web/src/screens/aiOperations/ai-review-labels.ts");
    const map = labels.slice(labels.indexOf("export const REVIEW_TYPE_LABELS"), labels.indexOf("export function reviewTypeLabel"));
    const keys = new Set([...map.matchAll(/^\s+([a-z_]+): "/gm)].map((m) => m[1]));
    const sources = ["apps/api/src", "packages/database/prisma", "packages/ai-core/src"];
    const written = new Set();
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(full);
        } else if (/\.(ts|mts)$/.test(entry.name)) {
          for (const m of readFileSync(full, "utf8").matchAll(/reviewType: "([a-z_]+)"/g)) written.add(m[1]);
        }
      }
    };
    for (const dir of sources) walk(join(ROOT, dir));
    assert.ok(written.size >= 6, `reviewTypes escritos: ${written.size}`);
    for (const type of written) assert.ok(keys.has(type), `reviewType sin etiqueta: ${type}`);
    assert.equal(keys.has("guest_message_reply") && keys.has("rate_change"), true);
  });
});

describe("dirección · 4 · 0 fechas literales en el código", () => {
  for (const dir of DIRS.slice(0, 4)) {
    it(`${dir}: ninguna YYYY-MM-DD fuera de comentarios`, () => {
      const hits = listTs(dir).filter((rel) => /\b20\d{2}-[01]\d-[0-3]\d\b/.test(stripComments(read(`apps/admin-web/src/${rel}`))));
      assert.deepEqual(hits, [], `fechas literales en: ${hits.join(", ")}`);
    });
  }
});

describe("dirección · 5 · specs de medida y helper", () => {
  const measureDir = join(ROOT, "apps/admin-web/e2e/measure");
  const specs = readdirSync(measureDir).filter((name) => /^d[1-6]-.*\.spec\.ts$/.test(name)).sort();
  const SURNAME_BLACKLIST = ["Ameijeiras", "Ares", "Baña", "Brey", "Carballo", "Castiñeira", "Cobas", "Cueto", "Docampo", "Espiño", "Freire", "Insua", "Lavandera", "Lema", "Menéndez", "Nogueira", "Piñeiro", "Prieto", "Requeijo", "Rial", "Rubido", "Salgado", "Souto", "Turnes", "Varela", "Vieites", "Vilar"];

  it("existen las 6 specs d1…d6, cada una sobre el helper de dirección con createMeasure(page, \"dN\")", () => {
    assert.deepEqual(specs.map((name) => name.slice(0, 2)), ["d1", "d2", "d3", "d4", "d5", "d6"]);
    for (const name of specs) {
      const task = name.slice(0, 2);
      const source = readFileSync(join(measureDir, name), "utf8");
      assert.match(source, /from "\.\.\/_helpers-direccion"/, `${name}: loginAsDirector`);
      assert.match(source, /from "\.\/_measure-direccion"/, `${name}: _measure-direccion`);
      assert.ok(source.includes(`createMeasure(page, "${task}")`), `${name}: createMeasure(page, "${task}")`);
      assert.ok(!source.includes("loginAsUxDay("), `${name}: nunca escribe como recepción en prop_uxday`);
    }
  });

  it("títulos «dN · …» sin PII (ni apellidos reales ni correos fuera de uxday.test)", () => {
    for (const name of specs) {
      const source = readFileSync(join(measureDir, name), "utf8");
      const titles = [...source.matchAll(/^test\("([^"]+)"/gm)].map((m) => m[1]);
      assert.ok(titles.length >= 1, `${name}: test(…)`);
      for (const title of titles) assert.match(title, new RegExp(`^${name.slice(0, 2)} · `), `${name}: ${title}`);
      for (const surname of SURNAME_BLACKLIST) assert.ok(!source.includes(surname), `${name}: apellido ${surname}`);
      for (const m of source.matchAll(/[a-z0-9._-]+@[a-z0-9.-]+/gi)) assert.match(m[0], /@uxday\.test$/, `${name}: correo ${m[0]}`);
    }
  });

  it("d2 y d6 miden el camino entregado (3 clics): tarjeta → «Aprobar» en la fila → diálogo nominal; menú → primaria del callout → diálogo", () => {
    const d2 = readFileSync(join(measureDir, "d2-aprobar-pendiente.spec.ts"), "utf8");
    assert.match(d2, /getByRole\("group", \{ name: "Pendientes de hoy" \}\)/);
    assert.match(d2, /getByRole\("dialog", \{ name: \/\^Aprobar \/ \}\)/);
    assert.match(d2, /toastContaining\(page, \/\^Aprobada: \|Primera aprobación registrada\/\)/);
    assert.match(d2, /expect\(result\.clicks\)\.toBe\(3\);/);
    assert.doesNotMatch(d2, /¿Aprobar la solicitud\?|drawer-open|toBe\(4\)/);
    const d6 = readFileSync(join(measureDir, "d6-revisar-cierre.spec.ts"), "utf8");
    assert.match(d6, /getByRole\("button", \{ name: "Marcar como revisado" \}\)\.first\(\)/);
    assert.match(d6, /toastContaining\(page, \/marcado como revisado\/\)/);
    assert.match(d6, /expect\(result\.clicks\)\.toBe\(3\);/);
    assert.doesNotMatch(d6, /Informe del cierre|drawer-open|toBe\(4\)/);
  });

  it("results-direccion.json está ignorado por git", () => {
    assert.match(read(".gitignore"), /^apps\/admin-web\/e2e\/measure\/results-direccion\.json$/m);
  });

  it("_helpers-direccion.ts: sin overrides por entorno y con la guarda del tenant de prueba (UX2-REV-13)", () => {
    const helper = read("apps/admin-web/e2e/_helpers-direccion.ts");
    assert.doesNotMatch(helper, /process\.env\.E2E_DIRECCION/);
    assert.match(helper, /export const UXDAY_PROPERTY_PREFIX = "prop_uxday";/);
    assert.match(helper, /export function assertUxDayProperty\(propertyId: string\): void \{\s*if \(!propertyId\.startsWith\(UXDAY_PROPERTY_PREFIX\)\) \{\s*throw new Error/);
    assert.match(helper, /const propertyName = options\.propertyName \?\? UXDAY_DIRECCION\.propertyName;\s*assertUxDayProperty\(propertyId\);/);
    assert.match(helper, /propertyId: "prop_uxday_b",\s*propertyName: "Hotel UXDAY B \(prueba\)",\s*email: "director@uxday\.test"/);
  });
});

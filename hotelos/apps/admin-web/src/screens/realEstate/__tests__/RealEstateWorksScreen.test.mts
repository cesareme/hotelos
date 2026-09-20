// Tests de la pantalla Finanzas › Activo inmobiliario › Obras (Tanda ACT ·
// lote ACT-F3). Los helpers puros y las piezas sin hooks viven en
// RealEstateWorksScreen.tsx; ese módulo llega (services/activeProperty →
// services/api-client) a `import.meta.env.VITE_API_URL`, que define Vite y no
// `node --test`: el gancho síncrono sustituye solo api-client.ts por su fuente
// sin tipos precedida de `import.meta.env ??= {}` (mismo patrón que
// screens/operations/__tests__/frontdesk-actions.test.mts). Las piezas se
// renderizan con react-dom/server; las reglas Cocoa 22, el copy en español y
// la superficie de red se anclan sobre la fuente.
// Desde apps/admin-web: corepack pnpm --filter @hotelos/admin-web test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/services/api-client.ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
      return { format: "module", source: `import.meta.env ??= {};\n${source}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

const screen = await import("../RealEstateWorksScreen.tsx");
const { ApiError } = await import("../../../services/api-client.ts");
const { REAL_ESTATE_ERROR_MESSAGES } = await import("../real-estate-helpers.ts");
type CapexWorkRecord = import("../../../services/realEstateApi").CapexWorkRecord;

const SOURCE = readFileSync(new URL("../RealEstateWorksScreen.tsx", import.meta.url), "utf8");
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;
const render = (element: unknown) => renderToStaticMarkup(element as never).replace(/\u00a0/g, " ");
/** Texto de un CocoaBadge con ese tono (el texto va en un <span> interior). */
const badge = (tone: string, text: string) => new RegExp(`data-tone="${tone}"[^>]*>(?:<span[^>]*>)?${text}<`);

function project(over: Partial<CapexWorkRecord> = {}): CapexWorkRecord {
  return {
    id: "cpx_test_1",
    propertyId: "prop_test",
    name: "Sustitución enfriadora",
    description: null,
    budget: "48000.00",
    status: "in_progress",
    startDate: "2026-07-01",
    targetEndDate: "2026-12-15",
    ownerApprovedBy: null,
    createdByUserId: "usr_test",
    realEstateAssetId: "rea_test",
    workKind: "eficiencia_energetica",
    licenceRequired: true,
    licenceDocumentId: "red_test_licencia",
    licenceGrantedAt: "2026-06-20",
    icioAmount: "1800.00",
    projectDocumentId: null,
    completionDocumentId: null,
    executionAccountPrefixes: "212",
    executedAmountLedger: "31500.00",
    executedAmountItems: "31500.00",
    executedAmount: "31500.00",
    executionSource: "ledger",
    capitalizedFixedAssetId: null,
    capitalizedAt: null,
    ...over
  };
}

describe("Obras · Cocoa 22, copy y superficie de red (lectura de fuente)", () => {
  it("nace sin estilos inline ni elementos crudos, sin literales de color ni emoji, sin fetch crudo y formatea solo por lib/format", () => {
    assert.equal(count(SOURCE, /\bstyle=\{/g), 0, "style={ debe ser 0");
    assert.doesNotMatch(SOURCE, /(?<!-)\bbo-[a-z0-9-]+/);
    assert.doesNotMatch(SOURCE, /<button\b|<table\b|<(?:input|select|textarea)\b|<h1\b/);
    assert.doesNotMatch(SOURCE, /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/);
    assert.doesNotMatch(SOURCE, /\p{Extended_Pictographic}/u);
    assert.doesNotMatch(SOURCE, /\b(?:window\.|globalThis\.)?fetch\s*\(/);
    assert.doesNotMatch(SOURCE, /Intl\.(?:NumberFormat|DateTimeFormat)|toLocale[A-Za-z]*String\(/);
    assert.doesNotMatch(SOURCE, /money\([^)]*"EUR"\)/);
  });

  it("exporta RealEstateWorksScreen (y por defecto), pinta un CocoaPage y lee con useApiData sobre las rutas del cliente", () => {
    assert.equal(typeof screen.RealEstateWorksScreen, "function");
    assert.equal(screen.default, screen.RealEstateWorksScreen);
    assert.match(SOURCE, /<CocoaPage\b/);
    assert.match(SOURCE, /useApiData<RealEstateWorksResponse>\(realEstateWorksPath\(propertyId\)\)/);
    assert.match(SOURCE, /useApiData<RealEstateAssetDetail>\(realEstatePath\(propertyId\)\)/);
    assert.match(SOURCE, /realEstateDocumentListQuery\(\{ category: "licencias" \}\)/);
    assert.match(SOURCE, /await updateCapexWork\(selected\.id, body\)/);
    assert.match(SOURCE, /await capitalizeCapexProject\(selected\.id\)/);
    assert.match(SOURCE, /<CocoaState\s+kind="empty"/);
  });

  it("crea y aprueba proyectos por las rutas existentes con apiRequest desde helpers locales (sin cliente en services/)", () => {
    assert.match(SOURCE, /apiRequest<CapexProjectSummary>\("\/capex-projects", \{ method: "POST", body: \{ \.\.\.body, propertyId \} \}\)/);
    // ACT-REV-05: la aprobación va por la ruta propia POST /capex-projects/:id/approve (asset.capex.approve), no por el PATCH heredado (capex.create).
    assert.match(SOURCE, /apiRequest<CapexProjectSummary>\(`\/capex-projects\/\$\{enc\(capexProjectId\)\}\/approve`, \{ method: "POST", body: \{\} \}\)/);
    assert.doesNotMatch(SOURCE, /body: \{ status: "approved" \}/);
    assert.equal(typeof screen.createCapexProjectRequest, "function");
    assert.equal(typeof screen.approveCapexProjectRequest, "function");
  });

  it("gatea las escrituras con canDo sobre useNavGate: capex.create, asset.capex.approve y assets.manage", () => {
    assert.match(SOURCE, /const canWork = canDo\(gate, "capex\.create"\);/);
    assert.match(SOURCE, /const canApprove = canDo\(gate, "asset\.capex\.approve"\);/, "aprobar solo exige asset.capex.approve (ACT-REV-05)");
    assert.match(SOURCE, /const canManageAssets = canDo\(gate, "assets\.manage"\);/);
    assert.doesNotMatch(SOURCE, /auth-storage|getUser\(|\?\.permissions/);
    assert.match(SOURCE, /navigateTo\("FixedAssetsScreen"\)/, "enlaza a Finanzas › Proveedores › Inmovilizado");
  });
});

describe("Obras: «Capitalizar» solo con assets.manage y estado completed", () => {
  const { canCapitalize, capitalizeBlockReason, NO_CAPITALIZE_PERMISSION } = screen;

  it("se habilita únicamente con assets.manage, obra terminada, sin capitalizar y enlazada a la ficha", () => {
    assert.equal(canCapitalize(project({ status: "completed" }), true), true);
    for (const status of ["proposed", "approved", "in_progress", "cancelled"] as const) {
      assert.equal(canCapitalize(project({ status }), true), false, `estado ${status}`);
    }
    assert.equal(canCapitalize(project({ status: "completed" }), false), false, "sin assets.manage");
    assert.equal(canCapitalize(project({ status: "completed", capitalizedFixedAssetId: "fa_1", capitalizedAt: "2026-09-01" }), true), false, "ya capitalizada");
    assert.equal(canCapitalize(project({ status: "completed", realEstateAssetId: null }), true), false, "sin enlace a la ficha");
  });

  it("explica la razón en español y no da razón cuando se puede", () => {
    assert.equal(capitalizeBlockReason(project({ status: "completed" }), true), null);
    assert.equal(capitalizeBlockReason(project({ status: "completed" }), false), NO_CAPITALIZE_PERMISSION);
    assert.match(capitalizeBlockReason(project({ status: "in_progress" }), true) ?? "", /Solo se capitaliza una obra terminada/);
    assert.match(capitalizeBlockReason(project({ status: "completed", capitalizedFixedAssetId: "fa_1" }), true) ?? "", /ya está capitalizada/);
    assert.match(capitalizeBlockReason(project({ status: "completed", realEstateAssetId: null }), true) ?? "", /Enlaza la obra a la ficha/);
  });

  it("la pantalla deshabilita los dos botones «Capitalizar» con canCapitalize y pone la razón en el título", () => {
    assert.ok(count(SOURCE, /disabled=\{!canCapitalize\(/g) >= 2, "fila y cajón");
    assert.ok(count(SOURCE, /title=\{capitalizeBlockReason\(/g) >= 2);
    assert.match(SOURCE, /confirmDisabled=\{!selected \|\| !canCapitalize\(selected, canManageAssets\)\}/, "el diálogo de confirmación también");
  });
});

describe("Obras: badge Libro cuando executionSource = ledger", () => {
  const { executionSourceBadge, executionProgress, ExecutionCell } = screen;

  it("«Libro» en acento con el diario y «Partidas» en neutro con las partidas", () => {
    assert.deepEqual(executionSourceBadge({ executionSource: "ledger" }), { label: "Libro", tone: "accent", title: "Diario contable" });
    assert.deepEqual(executionSourceBadge({ executionSource: "items" }), { label: "Partidas", tone: "neutral", title: "Partidas del proyecto" });
  });

  it("la celda «Ejecutado» pinta el importe, el badge y la barra presupuesto / ejecutado", () => {
    const html = render(createElement(ExecutionCell, { project: project() }));
    assert.match(html, badge("accent", "Libro"));
    assert.match(html, /31\.500,00/);
    assert.match(html, /role="progressbar"/);
    assert.match(html, /aria-valuenow="66"/);
    assert.match(html, /66 % de 48\.000,00/);
    const items = render(createElement(ExecutionCell, { project: project({ executionSource: "items", executedAmountLedger: null }) }));
    assert.match(items, badge("neutral", "Partidas"));
    assert.doesNotMatch(items, />Libro</);
  });

  it("la barra pasa a ámbar desde el 90 % y a rojo por encima del presupuesto; sin presupuesto es 0", () => {
    assert.deepEqual(executionProgress({ budget: "100.00", executedAmount: "50.00" }), { pct: 50, tone: "accent" });
    assert.equal(executionProgress({ budget: "100.00", executedAmount: "95.00" }).tone, "warning");
    assert.equal(executionProgress({ budget: "100.00", executedAmount: "120.00" }).tone, "danger");
    assert.deepEqual(executionProgress({ budget: "0.00", executedAmount: "10.00" }), { pct: 0, tone: "accent" });
  });
});

describe("Obras: 409 LICENCE_REQUIRED muestra mensaje", () => {
  const { worksErrorMessage } = screen;

  it("traduce el details.code del 409 a la frase en español del módulo", () => {
    const error = new ApiError("Conflict", 409, "corr_test", { code: "LICENCE_REQUIRED", capexProjectId: "cpx_test_1", from: "approved", to: "in_progress" });
    const message = worksErrorMessage(error);
    assert.equal(message, REAL_ESTATE_ERROR_MESSAGES.LICENCE_REQUIRED);
    assert.match(message, /licencia/);
    assert.doesNotMatch(message, /LICENCE_REQUIRED|Conflict/);
  });

  it("los demás códigos de obra también tienen frase y el resto cae al mensaje del API o al fallback", () => {
    for (const code of ["CAPEX_NOT_COMPLETED", "CAPEX_ALREADY_CAPITALIZED", "CAPEX_NOT_LINKED", "ASSET_NOT_FOUND"] as const) {
      assert.equal(worksErrorMessage(new ApiError("x", 409, undefined, { code })), REAL_ESTATE_ERROR_MESSAGES[code]);
    }
    assert.equal(worksErrorMessage(new Error("boom")), "boom");
    assert.equal(worksErrorMessage(null), "No se pudo guardar la obra. Inténtalo de nuevo.");
  });

  it("«Iniciar obra» envía status in_progress y el fallo se pinta en un CocoaCallout de peligro dentro del cajón", () => {
    assert.match(SOURCE, /kind === "start" \? \{ status: "in_progress" \}/);
    assert.match(SOURCE, /setWorkError\(worksErrorMessage\(err\)\)/);
    assert.match(SOURCE, /<CocoaCallout tone="danger" title="No se pudo completar la acción" role="alert">\s*\{workError\}/);
  });
});

describe("Obras · flujo propuesto → aprobado → licencia → en obra → terminado → capitalizado", () => {
  const { WORK_STAGES, workStageOf, WorkStageFlow, licenceState, licenceMissing, canStartWork, canCompleteWork } = screen;

  it("tiene las seis fases del diseño en orden", () => {
    assert.deepEqual(
      WORK_STAGES.map((stage) => stage.key),
      ["proposed", "approved", "licence", "in_progress", "completed", "capitalized"]
    );
  });

  it("deriva la fase de la obra (aprobada sin licencia exigida se queda en «aprobado»)", () => {
    assert.equal(workStageOf(project({ status: "proposed" })), "proposed");
    assert.equal(workStageOf(project({ status: "approved", licenceDocumentId: null })), "approved");
    assert.equal(workStageOf(project({ status: "approved" })), "licence");
    assert.equal(workStageOf(project({ status: "approved", licenceRequired: false, licenceDocumentId: null })), "licence");
    assert.equal(workStageOf(project({ status: "in_progress" })), "in_progress");
    assert.equal(workStageOf(project({ status: "completed" })), "completed");
    assert.equal(workStageOf(project({ status: "completed", capitalizedFixedAssetId: "fa_1" })), "capitalized");
    assert.equal(workStageOf(project({ status: "cancelled" })), "cancelled");
  });

  it("pinta la fase actual con aria-current=step, las anteriores en verde y las pendientes en neutro", () => {
    const html = render(createElement(WorkStageFlow, { project: project({ status: "in_progress" }) }));
    assert.equal(count(html, /<li/g), 6);
    assert.equal(count(html, /aria-current="step"/g), 1);
    assert.match(html, /aria-current="step"><span[^>]*data-tone="accent"[^>]*>(?:<span[^>]*>)?En obra</);
    assert.equal(count(html, /data-tone="success"/g), 3, "propuesto · aprobado · licencia hechas");
    assert.equal(count(html, /data-tone="neutral"/g), 2, "terminado · capitalizado pendientes");
    const cancelled = render(createElement(WorkStageFlow, { project: project({ status: "cancelled" }) }));
    assert.match(cancelled, badge("danger", "Cancelado"));
  });

  it("la licencia se pinta como no requiere · registrada / concedida · pendiente (roja con la obra en curso)", () => {
    assert.deepEqual(licenceState(project({ licenceRequired: false })), { label: "No requiere", tone: "neutral" });
    assert.deepEqual(licenceState(project({ licenceGrantedAt: null })), { label: "Registrada", tone: "success" });
    assert.equal(licenceState(project()).label, "Concedida 20/06/2026");
    assert.deepEqual(licenceState(project({ status: "approved", licenceDocumentId: null })), { label: "Pendiente", tone: "warning" });
    assert.deepEqual(licenceState(project({ status: "in_progress", licenceDocumentId: null })), { label: "Pendiente", tone: "danger" });
    assert.equal(licenceMissing(project({ licenceDocumentId: null })), true);
    assert.equal(licenceMissing(project({ licenceRequired: false, licenceDocumentId: null })), false);
    assert.equal(canStartWork(project({ status: "approved" })), true);
    assert.equal(canStartWork(project({ status: "in_progress" })), false);
    assert.equal(canCompleteWork(project({ status: "in_progress" })), true);
    assert.equal(canCompleteWork(project({ status: "completed" })), false);
  });
});

describe("Obras · KPI y formularios (puros)", () => {
  const { worksKpis, workFormOf, workPatchOf, workFormErrors, parsePrefixes, projectFormErrors, projectBodyOf, emptyProjectForm } = screen;

  it("worksKpis cuenta abiertos, suma presupuesto y ejecución de los abiertos y las alertas de licencia", () => {
    const projects = [project(), project({ id: "b", status: "completed", budget: "1000.00", executedAmount: "900.00" }), project({ id: "c", status: "proposed", budget: "2000.50", executedAmount: "0.00" }), project({ id: "d", status: "cancelled" })];
    assert.deepEqual(worksKpis(projects, [{ kind: "CAPEX_LICENCE_MISSING" }, { kind: "TAX_DUE" }]), { open: 2, budget: 50000.5, executed: 31500, withoutLicence: 1 });
    assert.deepEqual(worksKpis([], []), { open: 0, budget: 0, executed: 0, withoutLicence: 0 });
  });

  it("el formulario de obra viaja como PATCH …/work con null para borrar y la lista de prefijos parseada", () => {
    const form = workFormOf(project());
    assert.deepEqual(form, { linkAsset: true, workKind: "eficiencia_energetica", licenceRequired: true, licenceDocumentId: "red_test_licencia", licenceGrantedAt: "2026-06-20", icioAmount: "1800.00", executionAccountPrefixes: "212" });
    assert.deepEqual(workPatchOf({ ...form, executionAccountPrefixes: "211, 212, 211", icioAmount: "1.800,50" }, "rea_test"), {
      realEstateAssetId: "rea_test",
      workKind: "eficiencia_energetica",
      licenceRequired: true,
      licenceDocumentId: "red_test_licencia",
      licenceGrantedAt: "2026-06-20",
      icioAmount: "1800.50",
      executionAccountPrefixes: ["211", "212"]
    });
    assert.deepEqual(workPatchOf({ ...form, linkAsset: false, workKind: "", licenceDocumentId: " ", licenceGrantedAt: "", icioAmount: "", executionAccountPrefixes: "" }, "rea_test"), {
      realEstateAssetId: null,
      workKind: null,
      licenceRequired: true,
      licenceDocumentId: null,
      licenceGrantedAt: null,
      icioAmount: null,
      executionAccountPrefixes: null
    });
    assert.equal(workPatchOf({ ...form, linkAsset: true }, null).realEstateAssetId, null, "sin ficha no se enlaza");
  });

  it("valida el ICIO y los prefijos de cuenta", () => {
    assert.deepEqual(parsePrefixes("211, 212"), ["211", "212"]);
    assert.equal(parsePrefixes(""), null);
    assert.equal(parsePrefixes("21x"), undefined);
    assert.deepEqual(workFormErrors(workFormOf(project())), {});
    const errors = workFormErrors({ ...workFormOf(project()), icioAmount: "12,345", executionAccountPrefixes: "2" });
    assert.match(errors.icioAmount ?? "", /dos decimales/);
    assert.match(errors.executionAccountPrefixes ?? "", /prefijo/);
  });

  it("el proyecto nuevo exige nombre y presupuesto > 0 y viaja con el presupuesto como número", () => {
    assert.deepEqual(Object.keys(projectFormErrors(emptyProjectForm())).sort(), ["budget", "name"]);
    assert.match(projectFormErrors({ ...emptyProjectForm(), name: "Reforma", budget: "0" }).budget ?? "", /mayor que cero/);
    assert.match(projectFormErrors({ ...emptyProjectForm(), name: "Reforma", budget: "10", startDate: "2026-10-01", targetEndDate: "2026-09-01" }).targetEndDate ?? "", /anterior al inicio/);
    assert.deepEqual(projectBodyOf({ name: " Reforma lobby ", description: "", budget: "12.500,00", startDate: "2026-10-01", targetEndDate: "" }), { name: "Reforma lobby", budget: 12500, startDate: "2026-10-01" });
  });
});

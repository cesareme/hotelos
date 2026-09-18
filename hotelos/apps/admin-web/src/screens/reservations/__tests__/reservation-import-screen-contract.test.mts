import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Tanda 7 · L4 (design docs/design/RESERVAS-IMPORTACION-MASIVA.md §9): the
// «Importar» tab of Recepción › Reservas, its service and its wiring are
// pinned on the source — the screen reaches api-client (import.meta.env) and
// cannot load under node --test, like payroll-cost-screen-contract.test.mts.
// The pins are the ones the lot promised: Cocoa 22 rules with ZERO inline
// styles (a new screen never adds to the frozen global ceiling), the file input
// (.csv / .txt / .xlsx, ≤ 5 MB) whose bytes travel as base64 (never
// `file.text()`), the four steps with ONE aria-current="step", the gate on
// pms.reservation.create + pms.reservation.modify through canDo(useNavGate()),
// the link to the created reservation through the tree, the downloads through
// saveDownload, the undo dialog with an optional reason, and the navigation
// (tab loader, header action, ⌘K command, App registry, nav tree).

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;
/** Source without comments: only rendered code is checked. */
const stripComments = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

const screen = source("../ReservationImportScreen.tsx");
const helpers = source("../reservation-import-helpers.ts");
const service = source("../../../services/reservationImportApi.ts");
const list = source("../ReservationsListScreen.tsx");
const tabs = source("../../tabs/recepcion/ReservasTabs.tsx");
const provider = source("../../../providers/CocoaGlobalProvider.tsx");
const app = source("../../../App.tsx");
const tree = JSON.parse(source("../../../navigation/nav-tree.generated.json")) as {
  categories: Array<{ items: Array<{ screenKey: string; tabs: Array<{ screenKey: string; label: string; url: string; roles: string[] }> }> }>;
};

/** Rules 1-5, 9-11 of tests/cocoa-22-contract.test.mjs, applied to one file. */
function assertCocoaRules(name: string, src: string) {
  assert.doesNotMatch(src, /(?<!-)\bbo-[a-z0-9-]+/, `${name}: no .bo-* classes`);
  assert.doesNotMatch(src, /<button\b/, `${name}: no raw <button>`);
  assert.doesNotMatch(src, /<table\b/, `${name}: no raw <table>`);
  assert.doesNotMatch(src, /<(?:input|select|textarea)\b/, `${name}: no raw form controls`);
  assert.doesNotMatch(src, /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/, `${name}: no colour literals`);
  assert.doesNotMatch(src, /\p{Extended_Pictographic}/u, `${name}: no emoji`);
  assert.doesNotMatch(src, /transition:\s*["']all|position:\s*["'(]*fixed|zIndex:\s*["'(]*\d/, `${name}: no transition: all, fixed position nor numeric zIndex`);
  assert.doesNotMatch(src, /money\([^)]*"EUR"\)/, `${name}: the currency never travels as a literal`);
  assert.doesNotMatch(src, /\bfetch\s*\(/, `${name}: no raw fetch`);
  assert.doesNotMatch(src, /\bIntl\.|\.toLocale(?:Date|Time)?String\s*\(|\.toFixed\(/, `${name}: formats only through lib/format`);
}

describe("Reservas › Importar · pantalla (Tanda 7 · L4)", () => {
  it("keeps the Cocoa 22 rules with ZERO inline styles (a new screen never spends the frozen global ceiling)", () => {
    assertCocoaRules("ReservationImportScreen.tsx", screen);
    assert.equal(count(screen, /\bstyle=\{/g), 0, "the screen is born without inline styles");
    assert.match(screen, /<CocoaPage\s+eyebrow="Recepción · Reservas"\s+title="Importar reservas"/);
    assert.match(screen, /from "\.\.\/\.\.\/components\/cocoa";/);
    assert.doesNotMatch(screen, /from "\.\.\/\.\.\/components\/v2\//);
    // Only `import type` from the shared contract (the .js stubs win under node --import tsx).
    for (const src of [screen, helpers, service]) {
      for (const line of src.split("\n").filter((entry) => /from "@hotelos\/shared"/.test(entry))) assert.match(line, /^(?:import|export) type\b|^\} from "@hotelos\/shared";$/, `runtime import from @hotelos/shared: ${line}`);
      assert.doesNotMatch(src, /^import \{[^}]*\} from "@hotelos\/shared";/m, "runtime import from @hotelos/shared");
    }
  });

  it("picks the file with CocoaFileInput (.csv / .txt / .xlsx, ≤ 5 MB) and sends its bytes as base64, never as text", () => {
    assert.match(screen, /<CocoaFileInput accept="\.csv,\.txt,\.xlsx" maxBytes=\{5 \* 1024 \* 1024\}/);
    assert.match(screen, /onPick=\{\(picked\) => void pickFile\(picked\)\}/);
    assert.match(screen, /onReject=\{setFileError\}/);
    assert.match(screen, /base64OfArrayBuffer\(await picked\.arrayBuffer\(\)\)/);
    assert.match(screen, /contentBase64: input\.file\.contentBase64/);
    assert.match(screen, /contentBase64: file\.contentBase64/);
    assert.doesNotMatch(stripComments(screen), /\.text\(\)/, "the browser never decodes the file (latin1 must reach the API)");
    assert.doesNotMatch(screen, /\bcontent:/, "the text body of the contract is for the CLI and the tests only");
    assert.match(screen, /downloadReservationImportTemplate\("csv"|downloadTemplate\("csv"\)/);
    assert.match(screen, /downloadTemplate\("xlsx"\)/);
    assert.match(screen, /Descargar plantilla CSV/);
    assert.match(screen, /Descargar plantilla XLSX/);
    assert.match(screen, /El fichero no se guarda: solo el resultado por fila\./);
  });

  it("paints the four steps with CocoaChart.Progress and ONE aria-current=\"step\" on the step button", () => {
    assert.match(screen, /<CocoaChart\.Progress value=\{\(\(step \+ 1\) \/ IMPORT_STEPS\.length\) \* 100\}/);
    assert.match(screen, /<ol className="c22-section__list" aria-label="Pasos del asistente">/);
    const start = screen.indexOf("{IMPORT_STEPS.map((item, index) => (");
    const end = screen.indexOf("</ol>", start);
    assert.ok(start > 0 && end > start, "step list not found");
    const stepItem = screen.slice(start, end);
    assert.equal(count(stepItem, /aria-current=/g), 1);
    assert.match(stepItem, /<CocoaButton[^>]*wrap fullWidth align="start" aria-current=\{index === step \? "step" : undefined\}/);
    assert.match(stepItem, /<CocoaBadge tone=\{stepTone\(index, step\)\} variant="dot" size="small">/);
    assert.match(screen, /<CocoaGrid columns=\{12\} align="start">/);
    assert.match(screen, /<CocoaSpan cols=\{4\} min=\{240\}>/);
    assert.match(screen, /<CocoaSpan cols=\{8\} min=\{480\}>/);
    for (const title of ["1 · Fichero", "2 · Columnas", "3 · Revisión", "4 · Resultado por fila", "Importaciones anteriores", "Opciones de la importación"]) assert.match(screen, new RegExp(`title="${title}"`), `section ${title}`);
    assert.match(screen, /<CocoaActionBar\s+aria-label="Navegación del asistente de importación"/);
  });

  it("maps columns with an inline CocoaSelect per column (a field taken twice is resolved client-side) and previews again with a debounce", () => {
    assert.match(screen, /<CocoaSelect size="small" inline aria-label=\{`Campo de la columna \$\{row\.column\}`\} value=\{fieldSelectValue\(row\.field\)\} onChange=\{\(value\) => changeColumn\(row\.column, value\)\} options=\{FIELD_OPTIONS\}/);
    assert.match(screen, /applyMappingChoice\(preview\.mapping, choices, column, value\)/);
    assert.match(screen, /const PREVIEW_DEBOUNCE_MS = 400;/);
    assert.match(screen, /window\.setTimeout\(\(\) => \{[\s\S]*?void runPreview\(/);
    assert.match(screen, /mapping: buildMapping\(preview\.header, choices\)/);
    // FUX-04: the example comes from the RAW sample cells by column index (unmapped columns and rows with errors included).
    assert.match(screen, /exampleForColumn\(preview\.rows, index, /);
    assert.doesNotMatch(screen, /exampleForField\(/);
    // FUX-03: a failed re-analysis keeps the preview (no setPreview(null) in the catch) and only blocks «Importar».
    assert.match(screen, /const previewStale = preview !== null && previewError !== null;/);
    assert.match(screen, /disabled: importDisabled \|\| previewStale/);
    assert.doesNotMatch(stripComments(screen.slice(screen.indexOf("const runPreview"), screen.indexOf("function cancelDebounce"))), /setPreview\(null\)/);
    // FUX-05: a successful commit discards the spent preview.
    assert.match(screen, /setStep\(RESULT_STEP\);\s*(?:\/\/[^\n]*\n\s*)*discardPreview\(\);/);
    assert.match(screen, /mappingSourceLabel\(row\.source\)/);
    assert.match(screen, /label: "Aplicar y validar", disabled: \{?!mappingReady/);
    assert.match(screen, /const mappingReady = preview !== null && preview\.missingRequired\.length === 0 && !previewing;/);
  });

  it("reviews with the KPI strip, the status filter, a virtualised compact table with row tones, the availability and duplicates callouts and the four switches", () => {
    assert.match(screen, /<CocoaKpiStrip aria-label="Resumen de la revisión">/);
    assert.match(screen, /summaryKpis\(preview\.summary\)\.map\(/);
    assert.match(screen, /<CocoaSegmentedControl size="small" aria-label="Filtrar filas por estado" value=\{rowFilter\}/);
    assert.match(screen, /filterRows\(preview\.rows, rowFilter\)/);
    assert.match(screen, /<CocoaTable\s+columns=\{reviewTable\}\s+rows=\{filteredRows\}[\s\S]*?density="compact"\s+virtualize\s+maxHeight=\{REVIEW_MAX_HEIGHT\}\s+rowTone=/);
    assert.match(screen, /rowTitle=\{\(row\) => issuesTitle\(row\.issues\)\}/);
    assert.match(screen, /title="Disponibilidad por tipo de habitación"/);
    assert.match(screen, /availabilityLine\(type\)/);
    assert.match(screen, /regla de rango/);
    assert.match(screen, /title="Duplicados"/);
    for (const label of ["Omitir filas inválidas", "Permitir overbooking", "Cargar llegadas pasadas como histórico", "Importar de todos modos"]) assert.match(screen, new RegExp(`<CocoaSwitch checked=\\{options\\.[a-zA-Z]+\\} onChange=\\{\\(value\\) => changeOption\\("[a-zA-Z]+", value\\)\\} label="${label}" size="small"`), `switch ${label}`);
    assert.match(screen, /previewBlockers\(preview\)/);
    assert.match(screen, /nunca un valor del fichero/);
  });

  it("imports only when the API says canImport and the session holds create AND modify (canDo over useNavGate), with a Spanish note otherwise", () => {
    assert.match(screen, /import \{ useNavGate \} from "\.\.\/\.\.\/navigation\/useEnabledModules";/);
    assert.match(screen, /import \{ canDo, saveDownload \} from "\.\.\/accounting\/accounting-ui";/);
    assert.match(screen, /const canCreateImport = canDo\(gate, "pms\.reservation\.create"\) && canDo\(gate, "pms\.reservation\.modify"\);/);
    // FUX-7B-05: the sync commit also needs check-in / check-out (the API demands the four keys).
    assert.match(screen, /const canImport = syncMode \? canCreateImport && canDo\(gate, "pms\.checkin\.execute"\) && canDo\(gate, "pms\.checkout\.execute"\) : canCreateImport;/);
    assert.match(screen, /Necesitas los permisos de crear y modificar reservas y los de check-in y check-out para sincronizar un corte/);
    // FUX-7B-09: the sync callout holds an editable date field, so it is not a live region.
    assert.doesNotMatch(screen, /title=\{syncCalloutText\(sync, syncBusinessDate\)\} role="status"/);
    assert.match(screen, /const importDisabled = !preview\?\.canImport \|\| !canImport \|\| importing \|\| previewing;/);
    assert.match(screen, /createReservationImport\(\s*\{[\s\S]*?commit: true \},\s*propertyId\s*\)/);
    assert.match(screen, /`Importar \$\{plural\(preview\?\.summary\.toCreate \?\? 0, "reserva", "reservas"\)\}`/);
    assert.match(screen, /Necesitas los permisos de crear y modificar reservas para importar un lote/);
    assert.doesNotMatch(screen, /auth-storage|getUser\(|\?\.permissions/);
    assert.match(screen, /showToast\(plural\(created\.createdCount, "reserva importada", "reservas importadas"\)/);
  });

  it("links every created reservation to its detail through the tree, downloads the per-row report through saveDownload and undoes through a destructive dialog with an optional reason", () => {
    assert.match(screen, /openTabPath\(urlForScreen\("ReservationDetailWorkspace", \{ id: reservationId \}\) \?\? DETAIL_FALLBACK\)/);
    assert.match(screen, /const DETAIL_FALLBACK = "\/recepcion\/reservas";/);
    assert.match(screen, /saveDownload\(await downloadReservationImportTemplate\(format, propertyId\)\)/);
    assert.match(screen, /saveDownload\(\{ blob: new Blob\(\[csv\], \{ type: "text\/csv;charset=utf-8" \}\), filename: reportFileName\(result\.record\)/);
    assert.match(screen, /buildImportReportCsv\(result\.record\.rows\)/);
    assert.match(screen, /label: "Descargar informe CSV"/);
    assert.match(screen, /<CocoaDialog\s+open=\{undoTarget !== null\}[\s\S]*?tone="destructive"/);
    assert.match(screen, /confirmLabel="Deshacer importación"/);
    assert.match(screen, /<CocoaInput value=\{undoReason\} onChange=\{setUndoReason\} multiline rows=\{3\} maxLength=\{500\}/);
    assert.match(screen, /undoReservationImport\(undoTarget\.id, \{ reason: undoReason\.trim\(\) \|\| undefined \}, propertyId\)/);
    assert.match(screen, /showToast\(undoSummary\(undone\)/);
    // Ronda 1 (FUX-08): undo is gated on pms.reservation.modify alone (canUndo), like the API.
    assert.match(screen, /disabled=\{!canUndo \|\| !canUndoImport\(row\)\}/);
    assert.match(screen, /useApiData<ReservationImportRecord\[\]>\(propertyId \? reservationImportsPath\(propertyId\) : null, \{ query: \{ limit: LIST_LIMIT \} \}\)/);
    assert.match(screen, /toArray<ReservationImportRecord>\(imports\.data\)/);
    assert.match(screen, /emptyState="Todavía no hay importaciones en esta propiedad\."/);
    assert.match(screen, /label: "Nueva importación", onClick: resetAll/);
  });
});

describe("Reservas › Importar · helpers y servicio", () => {
  it("the helpers are pure (no React, no api-client, no import.meta) and format only through lib/format", () => {
    const helpersCode = stripComments(helpers);
    assert.doesNotMatch(helpersCode, /from "react"|api-client|import\.meta/);
    assert.match(helpersCode, /from "\.\.\/\.\.\/lib\/format";/);
    assert.doesNotMatch(helpersCode, /\bIntl\.|\.toLocale(?:Date|Time)?String\s*\(|\.toFixed\(/);
    assert.match(helpers, /export function base64OfArrayBuffer\(buffer: ArrayBuffer\): string/);
    assert.match(helpers, /export function buildImportReportCsv\(rows: readonly ReservationImportRowRecord\[\]\): string/);
    assert.match(helpers, /return `\\uFEFF\$\{lines\.join\("\\r\\n"\)\}\\r\\n`;/);
  });

  it("the service wraps the six routes through apiRequest / apiRequestBlob with the property in the path and maps details.code", () => {
    assert.match(service, /import \{ apiRequest, apiRequestBlob \} from "\.\/api-client";/);
    assert.doesNotMatch(service, /\bfetch\s*\(/);
    assert.match(service, /return `\/properties\/\$\{enc\(propertyId\)\}\/reservations\/imports`;/);
    for (const fn of ["previewReservationImport", "createReservationImport", "listReservationImports", "getReservationImport", "undoReservationImport", "downloadReservationImportTemplate", "reservationImportErrorMessage"]) {
      assert.match(service, new RegExp(`export (?:async )?function ${fn}\\(`), `service exports ${fn}`);
    }
    for (const route of ["/preview", "/template", "/undo"]) assert.ok(service.includes(route), `route ${route}`);
    assert.match(service, /apiRequestBlob\(`\$\{reservationImportsPath\(propertyId\)\}\/template`, \{ query: \{ format \} \}\)/);
    assert.match(service, /financeErrorStatus\(error\) === 413/);
    for (const code of ["RESERVATION_IMPORT_DUPLICATE", "RESERVATION_IMPORT_INVALID", "RESERVATION_IMPORT_MAPPING_INCOMPLETE", "RESERVATION_IMPORT_MAPPING_CONFLICT", "RESERVATION_IMPORT_TOO_MANY_ROWS", "RESERVATION_IMPORT_UNDO_IN_PROGRESS", "RESERVATION_IMPORT_NOT_FOUND"]) {
      assert.ok(service.includes(code), `service names ${code}`);
    }
    assert.match(service, /«Importar de todos modos»/);
    assert.match(service, /«Omitir filas inválidas»/);
  });
});

describe("Reservas › Importar · navegación", () => {
  it("is the sixth tab of Reservas in the tree (/recepcion/reservas/importar) for recepción, dirección, comercial and admin — never pisos", () => {
    const reservas = tree.categories.flatMap((category) => category.items).find((item) => item.screenKey === "ReservationWorkspace");
    assert.ok(reservas, "ReservationWorkspace item");
    const tab = reservas.tabs.find((entry) => entry.screenKey === "ReservationImportScreen");
    assert.ok(tab, "Importar tab");
    assert.equal(tab.label, "Importar");
    assert.equal(tab.url, "/recepcion/reservas/importar");
    assert.deepEqual(tab.roles, ["recepcion", "direccion", "comercial", "admin", "auditoria"]); // Tanda 8a: auditoría interna ve las importaciones (solo lectura)
    assert.ok(!tab.roles.includes("pisos"), "pisos never sees Importar");
    assert.equal(reservas.tabs.indexOf(tab), reservas.tabs.length - 1, "Importar is the last tab (orden 6)");
  });

  it("ReservasTabs loads the screen in one line and offers «Importar reservas» in the header; App.tsx binds the key to the container", () => {
    assert.match(tabs, /^\s+ReservationImportScreen: \(\) => import\("\.\.\/\.\.\/reservations\/ReservationImportScreen"\)\.then\(\(m\) => \(\{ default: m\.ReservationImportScreen \}\)\),$/m);
    assert.match(tabs, /<CocoaButton variant="bordered" tone="neutral" icon=\{<UploadIcon[^>]*\/>\} onClick=\{\(\) => openTabPath\(IMPORT_PATH\)\}>\s*Importar reservas/);
    assert.match(tabs, /const IMPORT_PATH = urlForScreen\("ReservationImportScreen"\) \?\? "\/recepcion\/reservas\/importar";/);
    assert.match(app, /^\s+ReservationImportScreen: ReservasTabs,$/m);
  });

  it("ronda 1: «Autor» is a name (never createdBy raw), undo needs modify only, pisos gets no header action, one live region and focus per step", () => {
    // FUX-02: the list paints importAuthorLabel over the viewer's profile (GET /users/me), never `row.createdBy` raw.
    assert.match(screen, /render: \(row\) => importAuthorLabel\(row\.createdBy, session\)/);
    assert.doesNotMatch(stripComments(screen), /row\.createdBy \?\? EMPTY/);
    assert.match(screen, /import \{ useCurrentUserProfile \} from "\.\.\/\.\.\/services\/usersApi";/);
    assert.match(helpers, /import \{ actorLabel, type ActorSession \} from "\.\.\/accounting\/actor-label";/);
    // FUX-08: «Deshacer» gated on pms.reservation.modify alone (the API's own requirement).
    assert.match(screen, /const canUndo = canDo\(gate, "pms\.reservation\.modify"\);/);
    assert.equal(count(screen, /disabled=\{!canUndo \|\| !canUndoImport\(/g), 2, "both undo buttons use canUndo");
    assert.doesNotMatch(screen, /!canImport \|\| !canUndoImport\(/);
    // FUX-09: the header «Importar reservas» only for roles that see the Importar tab.
    assert.match(tabs, /const IMPORT_TAB = findByScreen\("ReservationImportScreen"\);/);
    assert.match(tabs, /const canSeeImport = IMPORT_TAB\?\.kind === "tab" && gate\.isVisible\(IMPORT_TAB\.tab\);/);
    assert.match(tabs, /\{canSeeImport \? \(\s*<CocoaButton variant="bordered" tone="neutral" icon=\{<UploadIcon/);
    // FUX-10: no aria-live on badges; one CocoaLiveRegion; the step content is a focusable region focused on step change.
    assert.doesNotMatch(screen, /aria-live=/);
    assert.equal(count(screen, /<CocoaLiveRegion message=\{liveMessage\}/g), 1);
    assert.match(screen, /ref=\{stepContentRef\} tabIndex=\{-1\} role="region" aria-label=\{`Paso \$\{step \+ 1\}: \$\{current\.label\}`\}/);
    assert.match(screen, /stepContentRef\.current\?\.focus\(\);\s*\}, \[step\]\);/);
  });

  it("the reservations list offers the action in its header (not hosted) and in ⌘K, and the global palette navigates to it", () => {
    assert.match(list, /const IMPORT_PATH = urlForScreen\("ReservationImportScreen"\) \?\? "\/recepcion\/reservas\/importar";/);
    assert.match(list, /<CocoaButton variant="bordered" tone="neutral" icon=\{<UploadIcon \/>\} onClick=\{openImport\}>\s*\{IMPORT_LABEL\}/);
    assert.match(list, /\{ id: "reservas-importar", label: IMPORT_LABEL, run: openImport \}/);
    assert.match(list, /\{ id: "reservas-nueva", label: newReservationLabel, run: \(\) => navigateTo\("ReservationCreate"\) \}/);
    assert.match(provider, /\{ id: "nav\.reservation-import", label: "Importar reservas", category: "Navegación", onSelect: \(\) => navigateTo\("ReservationImportScreen"\) \},/);
  });
});

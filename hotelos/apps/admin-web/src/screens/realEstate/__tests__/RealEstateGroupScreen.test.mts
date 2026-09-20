// Tests de la vista de grupo del activo inmobiliario (Tanda ACT · lote ACT-F1).
// Desde apps/admin-web: corepack pnpm --filter @hotelos/admin-web test
//
// Mismo arnés que RealEstateAssetScreen.test.mts: un `load` hook de
// node:module sustituye services/realEstateApi.ts, services/activeProperty.ts
// y navigation/useEnabledModules.ts (llegan a api-client.ts, que no carga bajo
// node --test) por stubs que delegan en un registro programable, y la pantalla
// real se pinta con react-dom/server.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { beforeEach, describe, it, mock } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RealEstateAssetDetail, RealEstateGroupOverview, RealEstateGroupRow } from "@hotelos/shared";
import { ToastProvider } from "../../../components/Toast";
import { UI_STATES } from "../../../content/actions";

// ---------------------------------------------------------------- stubs de módulos

const ASSET_SOURCE = readFileSync(new URL("../RealEstateAssetScreen.tsx", import.meta.url), "utf8");
const GROUP_SOURCE = readFileSync(new URL("../RealEstateGroupScreen.tsx", import.meta.url), "utf8");

function importedNames(source: string, specifier: string): string[] {
  const names = new Set<string>();
  const re = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*"${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g");
  for (const match of source.matchAll(re)) {
    for (const entry of match[1].split(",")) {
      const text = entry.trim();
      if (!text || text.startsWith("type ")) continue;
      names.add(text.split(/\s+as\s+/)[0].trim());
    }
  }
  return [...names];
}

type StubCall = { name: string; args: unknown[] };
const registry = { impl: new Map<string, (...args: unknown[]) => unknown>(), calls: [] as StubCall[] };
(globalThis as Record<string, unknown>).__actStubs = {
  call(name: string, args: unknown[]) {
    registry.calls.push({ name, args });
    const fn = registry.impl.get(name);
    if (!fn) throw new Error(`stub sin implementación: ${name}`);
    return fn(...args);
  }
};

const STUBBED: ReadonlyArray<[suffix: string, specifier: string]> = [
  ["/services/realEstateApi.ts", "../../services/realEstateApi"],
  ["/services/activeProperty.ts", "../../services/activeProperty"],
  ["/navigation/useEnabledModules.ts", "../../navigation/useEnabledModules"]
];

function stubSource(specifier: string): string {
  const names = new Set([...importedNames(ASSET_SOURCE, specifier), ...importedNames(GROUP_SOURCE, specifier)]);
  return [...names].map((name) => `export const ${name} = (...args) => globalThis.__actStubs.call(${JSON.stringify(name)}, args);`).join("\n");
}

registerHooks({
  load(url, context, nextLoad) {
    for (const [suffix, specifier] of STUBBED) {
      if (url.endsWith(suffix)) return { format: "module", shortCircuit: true, source: stubSource(specifier) };
    }
    return nextLoad(url, context);
  }
});

const screen = await import("../RealEstateGroupScreen.tsx");
type ViewProps = Parameters<typeof screen.RealEstateGroupView>[0];
type CalendarYear = ViewProps["calendar"];

// ---------------------------------------------------------------- fixtures (ficticios)

const TODAY = "2026-09-20";

const ROWS: RealEstateGroupRow[] = [
  { propertyId: "prop_act_a", propertyCode: "ACTN", propertyName: "Hotel ACT Norte (prueba)", tenureKind: "propiedad", cadastralValueTotal: "9800000.00", lastValuationValue: "12000000.00", annualTaxBurden: "48250.00", documentsValidPct: "83.33", inspectionsOnTimePct: "50.00", openAlertsHigh: 2, openAlerts: 4 },
  { propertyId: "prop_act_b", propertyCode: "ACTS", propertyName: "Hotel ACT Sur (prueba)", tenureKind: "arrendamiento_industria", cadastralValueTotal: "4500000.00", lastValuationValue: null, annualTaxBurden: "1750.50", documentsValidPct: null, inspectionsOnTimePct: "100.00", openAlertsHigh: 0, openAlerts: 1 },
  { propertyId: "prop_act_c", propertyCode: null, propertyName: "Hotel ACT Este (sin ficha)", tenureKind: null, cadastralValueTotal: null, lastValuationValue: null, annualTaxBurden: null, documentsValidPct: null, inspectionsOnTimePct: null, openAlertsHigh: 0, openAlerts: 0 }
];

/** `totals` tal como los calcula el API (computeGroupTotals): la suma de las filas con los null a 0. */
const API_TOTALS = { properties: 3, cadastralValueTotal: "14300000.00", lastValuationValue: "12000000.00", annualTaxBurden: "50000.50", openAlertsHigh: 2, openAlerts: 5 };

const OVERVIEW: RealEstateGroupOverview = {
  rows: ROWS,
  totals: API_TOTALS,
  alerts: [
    { kind: "INSPECTION_OVERDUE", severity: "alta", dueAt: "2026-08-30", entityType: "real_estate_inspection", entityId: "rei_1", propertyId: "prop_act_a", message: "OCA de baja tensión vencida el 30/08/2026" },
    { kind: "CAPEX_LICENCE_MISSING", severity: "alta", dueAt: "2026-09-01", entityType: "capex_project", entityId: "cpx_1", propertyId: "prop_act_a", message: "Obra «Sustitución enfriadora» en curso sin licencia" }
  ]
};

const CALENDAR: NonNullable<CalendarYear> = {
  year: 2026,
  properties: [
    { propertyId: "prop_act_a", propertyCode: "ACTN", propertyName: "Hotel ACT Norte (prueba)" },
    { propertyId: "prop_act_b", propertyCode: "ACTS", propertyName: "Hotel ACT Sur (prueba)" }
  ],
  months: Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    events:
      index + 1 === 11
        ? [{ kind: "TAX_DUE" as const, dueAt: "2026-11-20", entityType: "property_tax_receipt" as const, entityId: "ptr_1", propertyId: "prop_act_a", label: "Fin del periodo voluntario · IBI 2026 PAC-02" }]
        : index + 1 === 10
          ? [{ kind: "INSURANCE_EXPIRING" as const, dueAt: "2026-10-05", entityType: "real_estate_insurance" as const, entityId: "rei_2", propertyId: "prop_act_b", label: "Vencimiento de la póliza multirriesgo" }]
          : []
  })),
  totalEvents: 2
};

const DETAIL: RealEstateAssetDetail = {
  asset: {
    id: "rea_1",
    organizationId: "org_act",
    legalEntityId: "le_act",
    propertyId: "prop_act_a",
    name: "Edificio Hotel ACT Norte",
    yearBuilt: 1978,
    yearLastRefurbished: 2019,
    builtSurfaceM2: "6400.00",
    plotSurfaceM2: "2100.00",
    floorsAbove: 6,
    floorsBelow: 1,
    roomsCount: 120,
    protectionLevel: "none",
    energyRating: "C",
    energyCertValidUntil: "2031-05-31",
    cadastralValueTotal: "9800000.00",
    cadastralValueYear: 2026,
    referenceValue: null,
    lastValuationValue: "12000000.00",
    lastValuationAt: "2026-03-15",
    currentTenureKind: "propiedad",
    status: "active",
    notes: null,
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z"
  },
  units: [],
  valuations: [],
  currentTenure: null,
  taxes: [],
  kpis: { cadastralValueTotal: "9800000.00", lastValuationValue: "12000000.00", valuePerRoom: "100000.00", annualTaxBurden: "48250.00", documentsValidPct: null, inspectionsOnTimePct: null, openAlerts: 0 },
  alerts: []
};

function baseProps(overrides: Partial<ViewProps> = {}): ViewProps {
  return {
    organizationId: "org_act",
    overview: null,
    loading: false,
    error: null,
    calendar: null,
    calendarLoading: false,
    calendarError: null,
    year: 2026,
    today: TODAY,
    canExport: true,
    selected: null,
    selectedDetail: null,
    selectedLoading: false,
    selectedError: null,
    onYearChange: () => {},
    onSelect: () => {},
    onOperate: () => {},
    onRefresh: () => {},
    onNotify: () => {},
    ...overrides
  };
}

function render(props: ViewProps): string {
  return renderToStaticMarkup(createElement(screen.RealEstateGroupView, props));
}

beforeEach(() => {
  registry.impl.clear();
  registry.calls.length = 0;
});

// ---------------------------------------------------------------- Grupo

describe("Grupo · totales", () => {
  it("Grupo: totales = suma de filas", () => {
    const totals = screen.groupTotalsOf(ROWS);
    assert.deepEqual(totals, API_TOTALS, "los totales del cliente coinciden con los del API (suma de filas, null = 0)");
    assert.deepEqual(screen.groupTotalsOf([]), { properties: 0, cadastralValueTotal: "0.00", lastValuationValue: "0.00", annualTaxBurden: "0.00", openAlertsHigh: 0, openAlerts: 0 });

    const html = render(baseProps({ overview: OVERVIEW, calendar: CALENDAR }));
    assert.ok(html.includes("Total · 3 centros"), "fila de totales con el número de centros");
    assert.ok(html.includes("14.300.000,00"), "suma del valor catastral");
    assert.ok(html.includes("50.000,50"), "suma de la carga fiscal");
    assert.ok(html.includes("5 (2 altas)"), "suma de alertas con las altas");
    assert.ok(html.includes("Hotel ACT Norte (prueba)") && html.includes("Hotel ACT Sur (prueba)") && html.includes("Hotel ACT Este (sin ficha)"), "las tres filas");
    assert.ok(html.includes("Sin ficha"), "el centro sin activo se marca");
    assert.ok(html.includes("Arrendamiento de industria"), "la tenencia en español");
    assert.ok(html.includes("83,33"), "porcentaje de documentos vigentes");
    assert.doesNotMatch(html, /undefined|NaN|\[object/);
  });

  it("KPI strip, gráfico de carga fiscal, calendario de 12 meses y alertas altas", () => {
    const html = render(baseProps({ overview: OVERVIEW, calendar: CALENDAR }));
    assert.ok(html.includes("Carga fiscal anual por centro"), "sección del gráfico");
    assert.deepEqual(
      screen.taxBurdenBars(ROWS).map((bar) => [bar.label, bar.value]),
      [
        ["ACTN", 48250],
        ["ACTS", 1750.5]
      ],
      "una barra por centro con importe (el centro sin ficha no entra)"
    );
    assert.ok(html.includes("Calendario anual consolidado"), "sección del calendario");
    assert.ok(html.includes(screen.monthLabel(2026, 1)) && html.includes(screen.monthLabel(2026, 12)), "los doce meses");
    assert.ok(html.includes("Vencimiento de la póliza multirriesgo") && html.includes("Fin del periodo voluntario · IBI 2026 PAC-02"), "los eventos del año");
    assert.ok(html.includes("Alertas altas del grupo") && html.includes("Obra «Sustitución enfriadora» en curso sin licencia"), "alertas altas con su centro");
    assert.ok(html.includes(screen.EXPORT_LABEL) && html.includes(screen.EXPORT_CALENDAR_LABEL), "botones de exportación con real_estate.read");
    assert.ok(!render(baseProps({ overview: OVERVIEW, calendar: CALENDAR, canExport: false })).includes(screen.EXPORT_LABEL), "sin real_estate.read no se ofrece la exportación");
  });

  it("vacío, 403 y error", () => {
    assert.equal(screen.groupViewState({ loading: false, error: null, overview: { rows: [], totals: screen.groupTotalsOf([]), alerts: [] } }), "empty");
    assert.ok(render(baseProps({ overview: { rows: [], totals: screen.groupTotalsOf([]), alerts: [] } })).includes(screen.EMPTY_GROUP_TITLE));
    const forbidden = render(baseProps({ error: { status: 403, message: "Sin permiso." } }));
    assert.ok(forbidden.includes(UI_STATES.forbidden.title) && forbidden.includes('role="alert"'), "403 → CocoaState forbidden");
    const failed = render(baseProps({ error: { status: 500, message: "Fallo del servidor." } }));
    assert.ok(failed.includes("No se pudo cargar la vista de grupo") && failed.includes("Reintentar"));
    assert.ok(render(baseProps({ loading: true })).includes("Cargando"));
  });
});

describe("Grupo · exportar", () => {
  it("Grupo: exportar llama a exportRealEstateCsv", async () => {
    const exportCsv = mock.fn(async () => ({ blob: new Blob(["Centro;Tenencia\r\n"], { type: "text/csv" }), status: 200, contentType: "text/csv; charset=utf-8", contentDisposition: 'attachment; filename="activo-inmobiliario-overview-2026.csv"' }));
    registry.impl.set("exportRealEstateCsv", exportCsv);
    const filename = await screen.downloadGroupCsv("overview", 2026, "org_act");
    assert.equal(exportCsv.mock.callCount(), 1);
    assert.deepEqual(exportCsv.mock.calls[0].arguments, ["overview", 2026, "org_act"]);
    assert.equal(filename, "activo-inmobiliario-overview-2026.csv");

    registry.impl.set("exportRealEstateCsv", async () => ({ blob: new Blob([""]), status: 200, contentType: "text/csv", contentDisposition: null }));
    assert.equal(await screen.downloadGroupCsv("calendar", 2027), "activo-inmobiliario-calendar-2027.csv", "sin cabecera se usa el nombre que emite el API");
    assert.equal(screen.exportFileNameFor("overview", 2026), "activo-inmobiliario-overview-2026.csv");
  });

  it("el botón «Exportar CSV» pasa por downloadGroupCsv → exportRealEstateCsv → saveDownload (blob → URL.createObjectURL revocado)", () => {
    assert.match(GROUP_SOURCE, /const filename = await downloadGroupCsv\(what, year, organizationId\);/);
    assert.match(GROUP_SOURCE, /const file = await exportRealEstateCsv\(what, year, organizationId\);/);
    assert.match(GROUP_SOURCE, /saveDownload\(\{ blob: file\.blob, filename, contentType: file\.contentType \}\);/);
    assert.match(GROUP_SOURCE, /onClick=\{\(\) => void exportCsv\("overview"\)\}/);
    assert.match(GROUP_SOURCE, /onClick=\{\(\) => void exportCsv\("calendar"\)\}/);
    assert.match(GROUP_SOURCE, /const canExport = canDo\(gate, READ_PERMISSION\);/);
    assert.equal(screen.READ_PERMISSION, "real_estate.read");
  });
});

describe("Grupo · detalle del centro sin cambiar la propiedad activa", () => {
  it("la fila abre el cajón con el detalle pedido por id explícito; solo «Operar en este centro» llama a setActiveProperty", async () => {
    // CocoaDrawer monta su portal tras el primer efecto (useMountedTransition): en SSR
    // el cajón no pinta, así que su contenido se comprueba en el resumen que reutiliza
    // y su pie en la fuente.
    const html = render(baseProps({ overview: OVERVIEW, calendar: CALENDAR, selected: ROWS[0], selectedDetail: DETAIL }));
    assert.ok(html.includes('data-cocoa="page"'), "la página sigue pintando con una fila seleccionada");
    const drawer = GROUP_SOURCE.slice(GROUP_SOURCE.indexOf("<CocoaDrawer"), GROUP_SOURCE.indexOf("</CocoaDrawer>"));
    assert.ok(drawer.includes("{OPERATE_LABEL}") && drawer.includes("{ACTIONS.close}"), "el pie del cajón ofrece cerrar y «Operar en este centro»");
    assert.ok(drawer.includes("{detailBody}"), "el cuerpo del cajón es el detalle del centro");
    assert.match(GROUP_SOURCE, /<RealEstateAssetSummary detail=\{selectedDetail\} legalEntityName=\{null\} \/>/, "el cajón reutiliza el resumen de la Ficha");
    const asset = await import("../RealEstateAssetScreen.tsx");
    const summary = renderToStaticMarkup(createElement(asset.RealEstateAssetSummary, { detail: DETAIL, legalEntityName: null }));
    assert.ok(summary.includes("Valor por habitación") && summary.includes("100.000,00"), "resumen del centro con sus KPIs");
    assert.ok(summary.includes("Sin tenencia vigente"), "la tenencia ausente se avisa");

    const occurrences = GROUP_SOURCE.match(/setActiveProperty\(/g) ?? [];
    assert.equal(occurrences.length, 1, "setActiveProperty se llama en un único sitio");
    assert.match(GROUP_SOURCE, /const onOperate = useCallback\(\(row: RealEstateGroupRow\) => setActiveProperty\(\{ propertyId: row\.propertyId, organizationId, propertyName: row\.propertyName \}\)/);
    assert.match(GROUP_SOURCE, /getRealEstateAsset\(selectedId\)/, "el detalle del cajón se pide con el id explícito de la fila");
    assert.match(GROUP_SOURCE, /onSelect=\{\(row\) => onSelect\(row\)\}/, "la fila solo selecciona");
    assert.doesNotMatch(GROUP_SOURCE, /window\.location\.reload|navigateTo\(/, "la vista no navega ni recarga por su cuenta");

    assert.equal(asset.assetViewState({ loading: false, error: { status: 404, message: "Sin ficha.", details: { code: "ASSET_NOT_FOUND" } }, detail: null }), "empty", "un centro sin ficha lo dice en el cajón");
    assert.ok(drawer.length > 0 && GROUP_SOURCE.includes("title={EMPTY_ASSET_TITLE}"), "el cajón pinta «Este centro aún no tiene activo inmobiliario» en ese caso");
  });

  it("el contenedor monta con la organización activa y pide la vista de grupo y el calendario por realEstateApi", () => {
    registry.impl.set("getActiveProperty", () => ({ propertyId: "prop_act_a", organizationId: "org_act", propertyName: "Hotel ACT Norte (prueba)" }));
    registry.impl.set("useNavGate", () => ({ grantedPermissions: ["real_estate.read"], isPlatformAdmin: false }));
    registry.impl.set("getRealEstateGroupOverview", () => new Promise(() => {}));
    registry.impl.set("getRealEstateGroupCalendar", () => new Promise(() => {}));
    const html = renderToStaticMarkup(createElement(ToastProvider, null, createElement(screen.RealEstateGroupScreen)));
    assert.ok(html.includes("Grupo"), "cabecera Cocoa");
    assert.ok(html.includes("Cargando"), "sin efectos en SSR la vista queda cargando");
    assert.ok(!registry.calls.some((call) => call.name === "setActiveProperty"), "montar nunca cambia la propiedad activa");
  });

  it("solo primitivas Cocoa, sin estilos en línea, sin fetch crudo, export con nombre", () => {
    assert.equal((GROUP_SOURCE.match(/\bstyle=\{/g) ?? []).length, 0, "cero style= (regla 13 de Cocoa 22)");
    assert.doesNotMatch(GROUP_SOURCE, /<(?:button|table|input|select|textarea|h1)\b/, "sin etiquetas crudas");
    assert.doesNotMatch(GROUP_SOURCE, /\bfetch\s*\(/, "sin fetch crudo");
    const componentImports = [...GROUP_SOURCE.matchAll(/from "\.\.\/\.\.\/components\/([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(componentImports)].sort(), ["Toast", "cocoa"]);
    assert.match(GROUP_SOURCE, /export function RealEstateGroupScreen\(\)/);
    for (const primitive of ["CocoaPage", "CocoaKpiStrip", "CocoaTable", "CocoaScrollArea", "CocoaChart.Bars", "CocoaGrid", "CocoaDrawer", "CocoaDialog", "CocoaState", "CocoaToolbar", "CocoaSelect"]) {
      assert.ok(GROUP_SOURCE.includes(`<${primitive}`), `usa ${primitive}`);
    }
  });
});

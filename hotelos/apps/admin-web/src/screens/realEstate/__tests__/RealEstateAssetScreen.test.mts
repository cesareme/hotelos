// Tests de la Ficha del activo inmobiliario (Tanda ACT · lote ACT-F1).
// Desde apps/admin-web: corepack pnpm --filter @hotelos/admin-web test
//
// La pantalla importa services/realEstateApi.ts, services/activeProperty.ts y
// navigation/useEnabledModules.ts, que llegan a api-client.ts (import.meta.env:
// no carga bajo node --test). Un `load` hook de node:module (registerHooks)
// sustituye esos tres módulos por stubs generados a partir de los nombres que
// la pantalla importa; cada stub delega en un registro global que el test
// programa (mock de realEstateApi). Con eso la pantalla real se pinta con
// react-dom/server sin red: los tests renderizan `RealEstateAssetView` con el
// estado por props (los efectos no corren en SSR) y el contenedor
// `RealEstateAssetScreen` dentro de ToastProvider para comprobar que monta.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { beforeEach, describe, it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RealEstateAssetDetail, RealEstateCalendarEvent, RealEstateTenureRecord } from "@hotelos/shared";
import { ToastProvider } from "../../../components/Toast";
import { UI_STATES } from "../../../content/actions";

// ---------------------------------------------------------------- stubs de módulos

const ASSET_SOURCE = readFileSync(new URL("../RealEstateAssetScreen.tsx", import.meta.url), "utf8");
const GROUP_SOURCE = readFileSync(new URL("../RealEstateGroupScreen.tsx", import.meta.url), "utf8");

/** Nombres de VALOR que `source` importa de `specifier` (los `import type` y los `type X` en línea se descartan, como hace esbuild). */
export function importedNames(source: string, specifier: string): string[] {
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

const screen = await import("../RealEstateAssetScreen.tsx");

// ---------------------------------------------------------------- fixtures (ficticios, sin personas reales)

const TODAY = "2026-09-20";
const PROPERTY = { propertyId: "prop_act_a", propertyName: "Hotel ACT Norte (prueba)", legalEntityName: "ACT Inmuebles, S.L." };

const TENURE: RealEstateTenureRecord = {
  id: "ret_1",
  assetId: "rea_1",
  kind: "propiedad",
  counterpartyName: "ACT Inmuebles, S.L.",
  counterpartyTaxId: null,
  counterpartyNonResident: false,
  startDate: "2010-03-01",
  endDate: null,
  noticeMonths: null,
  renewal: "ninguna",
  rentKind: null,
  rentMonthly: null,
  rentVariablePct: null,
  rentVariableBase: null,
  rentReviewIndex: null,
  rentReviewMonth: null,
  depositAmount: null,
  vatApplies: false,
  withholdingApplies: false,
  withholdingRatePct: null,
  ibiPayer: "propietario",
  insurancePayer: "propietario",
  capexResponsibility: "propietario",
  ffeReservePct: "4.00",
  brandName: null,
  status: "vigente",
  documentId: null,
  notes: null,
  createdAt: "2026-09-20T10:00:00.000Z",
  updatedAt: "2026-09-20T10:00:00.000Z"
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
    referenceValue: "11500000.00",
    lastValuationValue: "12000000.00",
    lastValuationAt: "2026-03-15",
    currentTenureKind: "propiedad",
    status: "active",
    notes: null,
    createdAt: "2026-09-20T10:00:00.000Z",
    updatedAt: "2026-09-20T10:00:00.000Z"
  },
  units: [
    {
      id: "reu_1",
      organizationId: "org_act",
      assetId: "rea_1",
      kind: "finca_registral",
      registryOffice: "Registro de la Propiedad nº 2",
      registryFincaNumber: "12345",
      registryTomo: "1201",
      registryLibro: "88",
      registryFolio: "14",
      cru: null,
      cadastralReference: "1234567AB1234C0001DE",
      useCode: "hotelero",
      surfaceM2: "6400.00",
      cadastralValueLand: "3200000.00",
      cadastralValueBuilding: "6600000.00",
      titleKind: "pleno_dominio",
      titleHolderTaxId: null,
      titleHolderName: "ACT Inmuebles, S.L.",
      titleDeedDate: "2010-03-01",
      notary: null,
      fixedAssetId: null,
      createdAt: "2026-09-20T10:00:00.000Z",
      updatedAt: "2026-09-20T10:00:00.000Z",
      charges: [
        {
          id: "rec_1",
          unitId: "reu_1",
          kind: "hipoteca",
          holderName: "Banco de pruebas",
          holderTaxId: null,
          amount: "4000000.00",
          outstandingAmount: "2350000.00",
          registeredAt: "2019-06-01",
          expiresAt: "2034-06-01",
          cancelledAt: null,
          documentId: null,
          note: null,
          createdAt: "2026-09-20T10:00:00.000Z"
        }
      ]
    }
  ],
  valuations: [
    { id: "rev_1", assetId: "rea_1", kind: "eco_805", purpose: "hipotecaria", valuedAt: "2026-03-15", value: "12000000.00", valuePerRoom: "100000.00", capRatePct: "6.25", method: "Descuento de flujos", appraiser: "Tasadora de pruebas", documentId: null, createdAt: "2026-09-20T10:00:00.000Z" }
  ],
  currentTenure: TENURE,
  taxes: [],
  kpis: { cadastralValueTotal: "9800000.00", lastValuationValue: "12000000.00", valuePerRoom: "100000.00", annualTaxBurden: "48250.00", documentsValidPct: "83.33", inspectionsOnTimePct: null, openAlerts: 3 },
  alerts: [
    { kind: "INSPECTION_OVERDUE", severity: "alta", dueAt: "2026-08-30", entityType: "real_estate_inspection", entityId: "rei_1", propertyId: "prop_act_a", message: "OCA de baja tensión vencida el 30/08/2026" },
    { kind: "INSURANCE_EXPIRING", severity: "media", dueAt: "2026-10-05", entityType: "real_estate_insurance", entityId: "rei_2", propertyId: "prop_act_a", message: "Póliza multirriesgo vence el 05/10/2026" },
    { kind: "TAX_DUE", severity: "baja", dueAt: "2026-11-20", entityType: "property_tax_receipt", entityId: "ptr_1", propertyId: "prop_act_a", message: "IBI 2026 PAC-02 vence el 20/11/2026" }
  ]
};

const EVENTS: RealEstateCalendarEvent[] = [
  { kind: "TAX_DUE", dueAt: "2026-11-20", entityType: "property_tax_receipt", entityId: "ptr_1", propertyId: "prop_act_a", label: "Fin del periodo voluntario · IBI 2026 PAC-02" },
  { kind: "INSURANCE_EXPIRING", dueAt: "2026-10-05", entityType: "real_estate_insurance", entityId: "rei_2", propertyId: "prop_act_a", label: "Vencimiento de la póliza multirriesgo" },
  { kind: "DOCUMENT_EXPIRING", dueAt: "2027-01-15", entityType: "real_estate_document", entityId: "red_1", propertyId: "prop_act_a", label: "Caduca el certificado energético" },
  { kind: "INSPECTION_DUE", dueAt: "2026-09-01", entityType: "real_estate_inspection", entityId: "rei_9", propertyId: "prop_act_a", label: "Pasada" }
];

const NOT_FOUND = { status: 404, message: "Este centro aún no tiene activo inmobiliario.", details: { code: "ASSET_NOT_FOUND" } };
const FORBIDDEN = { status: 403, message: "Sin permiso.", details: { code: "RBAC_FORBIDDEN" } };

type ViewProps = Parameters<typeof screen.RealEstateAssetView>[0];

function baseProps(overrides: Partial<ViewProps> = {}): ViewProps {
  return {
    ...PROPERTY,
    detail: null,
    loading: false,
    error: null,
    upcoming: null,
    upcomingError: null,
    canManage: true,
    today: TODAY,
    onRefresh: () => {},
    onNotify: () => {},
    ...overrides
  };
}

function render(props: ViewProps): string {
  return renderToStaticMarkup(createElement(screen.RealEstateAssetView, props));
}

beforeEach(() => {
  registry.impl.clear();
  registry.calls.length = 0;
});

// ---------------------------------------------------------------- Ficha

describe("Ficha del activo · estado vacío", () => {
  it("Ficha: estado vacío con botón de alta solo si real_estate.manage", () => {
    assert.equal(screen.assetViewState({ loading: false, error: NOT_FOUND, detail: null }), "empty");

    const withManage = render(baseProps({ error: NOT_FOUND, canManage: true }));
    assert.ok(withManage.includes(screen.EMPTY_ASSET_TITLE), "pinta «Este centro aún no tiene activo inmobiliario»");
    assert.ok(withManage.includes(screen.CREATE_ASSET_LABEL), "ofrece el alta con real_estate.manage");
    assert.ok(withManage.includes('data-kind="empty"') || withManage.includes('data-state="empty"') || withManage.includes("c22-state"), "es un CocoaState");

    const withoutManage = render(baseProps({ error: NOT_FOUND, canManage: false }));
    assert.ok(withoutManage.includes(screen.EMPTY_ASSET_TITLE), "el estado vacío se ve sin permiso de escritura");
    assert.ok(!withoutManage.includes(screen.CREATE_ASSET_LABEL), "sin real_estate.manage no hay botón de alta");
    assert.ok(!withoutManage.includes("Editar ficha"), "sin real_estate.manage no hay botón de edición");
  });

  it("el contenedor decide el permiso con canDo(useNavGate(propertyId), real_estate.manage), nunca con getUser()?.permissions", () => {
    assert.equal(screen.MANAGE_PERMISSION, "real_estate.manage");
    assert.match(ASSET_SOURCE, /const gate = useNavGate\(propertyId\);/);
    assert.match(ASSET_SOURCE, /const canManage = canDo\(gate, MANAGE_PERMISSION\);/);
    assert.doesNotMatch(ASSET_SOURCE, /getUser\(|\?\.permissions|auth-storage/);
  });
});

describe("Ficha del activo · con datos", () => {
  it("Ficha: KPIs y callout de tenencia con datos", () => {
    const html = render(baseProps({ detail: DETAIL, upcoming: screen.upcomingCalendarEvents(EVENTS, TODAY) }));
    assert.equal(screen.assetViewState({ loading: false, error: null, detail: DETAIL }), "ready");
    for (const expected of ["Valor catastral", "9.800.000,00", "Última tasación", "12.000.000,00", "Valor por habitación", "100.000,00", "Carga fiscal anual", "48.250,00", "Alertas abiertas"]) {
      assert.ok(html.includes(expected), `KPI «${expected}»`);
    }
    assert.ok(html.includes("Propietaria: ACT Inmuebles, S.L."), "callout de la tenencia en propiedad");
    assert.ok(html.includes("Finca 12345"), "la unidad registral del sidebar");
    assert.ok(html.includes("Pleno dominio"), "el título de la unidad como badge");
    assert.ok(html.includes("Hipoteca") && html.includes("2.350.000,00"), "la carga con su pendiente");
    assert.ok(html.includes("Tasación ECO 805") && html.includes("Tasadora de pruebas"), "la tabla de valoraciones");
    assert.ok(html.includes("OCA de baja tensión vencida el 30/08/2026"), "las alertas abiertas");
    assert.ok(html.includes("Vencimiento de la póliza multirriesgo") && html.includes("Fin del periodo voluntario · IBI 2026 PAC-02"), "el inspector con los próximos 90 días");
    assert.ok(!html.includes("Caduca el certificado energético") && !html.includes(">Pasada<"), "fuera de la ventana de 90 días no se pinta");
    assert.ok(html.includes("Editar ficha"), "con real_estate.manage se ofrece la edición");
    assert.doesNotMatch(html, /undefined|NaN|\[object/, "sin valores sin formatear");
  });

  it("tenureCalloutTitle: propietaria, arrendataria hasta la fecha y contraparte sin nombre", () => {
    assert.equal(screen.tenureCalloutTitle(TENURE, null), "Propietaria: ACT Inmuebles, S.L.");
    assert.equal(screen.tenureCalloutTitle({ ...TENURE, counterpartyName: null }, "Sociedad Matriz, S.A."), "Propietaria: Sociedad Matriz, S.A.");
    assert.equal(screen.tenureCalloutTitle({ ...TENURE, counterpartyName: null }, null), "Propietaria: la sociedad");
    assert.equal(screen.tenureCalloutTitle({ ...TENURE, kind: "arrendamiento_industria", counterpartyName: "Patrimonial Sur, S.A.", endDate: "2030-12-31" }, null), "Arrendataria de Patrimonial Sur, S.A. hasta el 31/12/2030");
    assert.equal(screen.tenureCalloutTitle({ ...TENURE, kind: "gestion", counterpartyName: "Gestora de pruebas", endDate: null }, null), "Contrato de gestión con Gestora de pruebas sin fecha de fin");
    assert.equal(screen.tenureCalloutTitle(null, null), screen.NO_TENURE_TITLE);
    const lines = screen.tenureCalloutLines({ ...TENURE, kind: "arrendamiento_local", rentKind: "fija", rentMonthly: "18000.00", noticeMonths: 6, renewal: "tacita", rentReviewIndex: "ipc", rentReviewMonth: 1 });
    assert.ok(lines.some((line) => line.includes("18.000,00") && line.includes("Renta fija")), "renta");
    assert.ok(lines.some((line) => line.startsWith("Preaviso: 6 meses")), "preaviso");
    assert.ok(lines.some((line) => line.startsWith("IBI: propietario")), "reparto de costes");
  });

  it("upcomingCalendarEvents: ventana de 90 días ordenada por fecha; calendarYearsFor cubre el cambio de ejercicio", () => {
    const upcoming = screen.upcomingCalendarEvents(EVENTS, TODAY);
    assert.deepEqual(upcoming.map((event) => event.dueAt), ["2026-10-05", "2026-11-20"]);
    assert.deepEqual(screen.calendarYearsFor("2026-09-20"), [2026]);
    assert.deepEqual(screen.calendarYearsFor("2026-11-15"), [2026, 2027]);
    assert.equal(screen.addDays("2026-12-20", 30), "2027-01-19");
  });
});

describe("Ficha del activo · sin acceso y otros fallos", () => {
  it("Ficha: 403 → CocoaState forbidden", () => {
    assert.equal(screen.assetViewState({ loading: false, error: FORBIDDEN, detail: null }), "forbidden");
    const html = render(baseProps({ error: FORBIDDEN }));
    assert.ok(html.includes(UI_STATES.forbidden.title), "título «Sin acceso»");
    assert.ok(html.includes(UI_STATES.forbidden.message), "mensaje del diccionario");
    assert.ok(html.includes('role="alert"'), "el estado se anuncia");
    assert.ok(!html.includes(screen.EMPTY_ASSET_TITLE) && !html.includes(screen.CREATE_ASSET_LABEL), "un 403 nunca ofrece el alta");
  });

  it("otro fallo → CocoaState error con reintento; cargando → estado de carga", () => {
    assert.equal(screen.assetViewState({ loading: false, error: { status: 500, message: "Fallo del servidor." }, detail: null }), "error");
    assert.equal(screen.assetViewState({ loading: true, error: null, detail: null }), "loading");
    const html = render(baseProps({ error: { status: 500, message: "Fallo del servidor." } }));
    assert.ok(html.includes("No se pudo cargar el activo inmobiliario") && html.includes("Fallo del servidor."));
    assert.ok(html.includes("Reintentar"));
    assert.ok(render(baseProps({ loading: true })).includes("Cargando"));
  });
});

describe("Ficha del activo · formularios por especificación", () => {
  it("decimalString normaliza coma y punto; validateForm exige obligatorios, números y la referencia catastral", () => {
    assert.equal(screen.decimalString("1.234,56"), "1234.56");
    assert.equal(screen.decimalString("1234,5"), "1234.5");
    assert.equal(screen.decimalString("1234.50"), "1234.50");
    assert.equal(screen.decimalString("abc"), null);
    assert.equal(screen.decimalString(""), null);
    const errors = screen.validateForm(screen.UNIT_FIELDS, { kind: "", titleKind: "pleno_dominio", cadastralReference: "1234", surfaceM2: "x" });
    assert.equal(errors.kind, "Este campo es obligatorio.");
    assert.match(errors.cadastralReference, /20 caracteres/);
    assert.match(errors.surfaceM2, /número/);
    assert.deepEqual(screen.validateForm(screen.VALUATION_FIELDS, { kind: "eco_805", valuedAt: "2026-03-15", value: "12.000.000,00" }), {});
  });

  it("formBody omite vacíos en el alta y en la edición envía solo lo que cambia (vacío → null)", () => {
    const created = screen.formBody(screen.VALUATION_FIELDS, { kind: "eco_805", valuedAt: "2026-03-15", value: "12.000.000,00", capRatePct: "6,25", appraiser: "" });
    assert.deepEqual(created, { kind: "eco_805", valuedAt: "2026-03-15", value: "12000000.00", capRatePct: "6.25" });
    const initial = screen.valuesOf(screen.ASSET_FIELDS, DETAIL.asset);
    assert.equal(initial.roomsCount, "120");
    assert.equal(initial.notes, "");
    const patch = screen.formBody(screen.ASSET_FIELDS, { ...initial, roomsCount: "118", notes: "", yearLastRefurbished: "" }, initial);
    assert.deepEqual(patch, { roomsCount: 118, yearLastRefurbished: null });
    const bools = screen.formBody(screen.TENURE_FIELDS, { kind: "arrendamiento_local", startDate: "2026-01-01", vatApplies: "1", withholdingApplies: "0" });
    assert.deepEqual(bools, { kind: "arrendamiento_local", startDate: "2026-01-01", vatApplies: true, withholdingApplies: false });
  });
});

describe("Ficha del activo · contenedor y contrato Cocoa 22", () => {
  it("el contenedor monta con las concesiones de la sesión y pide la ficha del centro activo por realEstateApi", () => {
    registry.impl.set("getActiveProperty", () => ({ propertyId: "prop_act_a", organizationId: "org_act", propertyName: "Hotel ACT Norte (prueba)" }));
    registry.impl.set("useNavGate", () => ({ grantedPermissions: ["real_estate.read"], isPlatformAdmin: false }));
    registry.impl.set("getRealEstateAsset", () => new Promise(() => {}));
    registry.impl.set("loadSwitchableProperties", () => Promise.resolve([]));
    const html = renderToStaticMarkup(createElement(ToastProvider, null, createElement(screen.RealEstateAssetScreen)));
    assert.ok(html.includes("Ficha del activo"), "cabecera Cocoa");
    assert.ok(html.includes("Cargando"), "sin efectos en SSR la ficha queda cargando");
    assert.ok(registry.calls.some((call) => call.name === "useNavGate" && call.args[0] === "prop_act_a"), "las claves se leen para el centro de la ficha");
    assert.ok(!html.includes("Editar ficha"), "sin real_estate.manage no hay edición");
  });

  it("solo primitivas Cocoa, sin estilos en línea, sin fetch crudo y todas las escrituras por realEstateApi", () => {
    assert.equal((ASSET_SOURCE.match(/\bstyle=\{/g) ?? []).length, 0, "cero style= (regla 13 de Cocoa 22)");
    assert.doesNotMatch(ASSET_SOURCE, /<(?:button|table|input|select|textarea|h1)\b/, "sin etiquetas crudas");
    assert.doesNotMatch(ASSET_SOURCE, /\bfetch\s*\(/, "sin fetch crudo");
    const componentImports = [...ASSET_SOURCE.matchAll(/from "\.\.\/\.\.\/components\/([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(componentImports)].sort(), ["Toast", "cocoa"], "componentes solo del barrel Cocoa (y el toast)");
    for (const fn of ["createRealEstateAsset", "updateRealEstateAsset", "createRealEstateUnit", "updateRealEstateUnit", "createRealEstateCharge", "updateRealEstateCharge", "createRealEstateValuation", "createRealEstateTenure", "updateRealEstateTenure", "getRealEstateAsset", "getRealEstateCalendar"]) {
      assert.ok(importedNames(ASSET_SOURCE, "../../services/realEstateApi").includes(fn), `${fn} desde services/realEstateApi`);
    }
    assert.match(ASSET_SOURCE, /export function RealEstateAssetScreen\(/, "export con nombre como FixedAssetsScreen");
    for (const primitive of ["CocoaPage", "CocoaKpiStrip", "CocoaSplitView", "CocoaCallout", "CocoaDrawer", "CocoaField", "CocoaInput", "CocoaSelect", "CocoaDatePicker", "CocoaBadge", "CocoaState", "CocoaScrollArea", "CocoaTable"]) {
      assert.ok(ASSET_SOURCE.includes(`<${primitive}`), `usa ${primitive}`);
    }
  });
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Tanda ACT · lote ACT-F2 · Finanzas › Activo inmobiliario › Tributos
// (docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md §8): los helpers puros de
// RealEstateTaxesScreen.tsx se ejecutan de verdad bajo node --test (gates de
// «Proponer asiento» y «Contabilizar», máquina de estados del recibo, KPI,
// calendario de 12 meses, formulario del tributo) y «Proponer asiento» pasa por
// el cliente REAL (services/realEstateApi.ts → api-client) con `fetch` sustituido
// para devolver el 409 FISCAL_YEAR_CLOSED del motor contable: la pantalla enseña
// la frase de real-estate-helpers. Mismo arnés que RealEstateDocumentsScreen.test.mts
// (gancho de `import.meta.env`, window / localStorage emulados).

registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/src/services/api-client.ts")) {
      const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" });
      return { format: "module", source: `import.meta.env = { VITE_API_URL: "http://127.0.0.1:65530", MODE: "test", DEV: false };\n${source}`, shortCircuit: true };
    }
    return nextLoad(url, context);
  }
});

const store = new Map<string, string>();
const localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, String(value)),
  removeItem: (key: string) => void store.delete(key),
  clear: () => store.clear(),
  key: (index: number) => [...store.keys()][index] ?? null,
  get length() {
    return store.size;
  }
};
(globalThis as Record<string, unknown>).window = Object.assign(new EventTarget(), { localStorage, location: { reload() {} } });

type Captured = { url: string; method: string; headers: Record<string, string>; body: unknown };
const captured: Captured[] = [];
let nextResponse: () => Response = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  captured.push({ url: String(input), method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
  return nextResponse();
}) as typeof fetch;

const screenModule = await import("../RealEstateTaxesScreen.tsx");
const { setSession } = await import("../../../services/auth-storage.ts");
const { writeActiveProperty } = await import("../../../services/activeProperty.ts");
const { ApiError } = await import("../../../services/api-client.ts");
const { REAL_ESTATE_ERROR_MESSAGES } = await import("../real-estate-helpers.ts");
const {
  JournalEntryBadge,
  MONTH_LABELS_ES,
  NO_PERMISSION_POST,
  NO_PERMISSION_TAXES,
  RECEIPT_COLUMNS,
  RECEIPT_TRANSITIONS,
  RealEstateTaxesScreen,
  TAX_COLUMNS,
  TAX_VIEW_OPTIONS,
  canAppeal,
  canMarkPaid,
  canMarkReceived,
  emptyTaxForm,
  isTaxView,
  paidDisabledReason,
  paidFieldsLocked,
  postEntryDisabledReason,
  postEntryGate,
  proposeEntryDisabledReason,
  proposeEntryFor,
  receiptTitle,
  taxCalendarMonths,
  taxFailureMessage,
  taxKpis,
  taxRequestOf,
  validateTaxForm,
  yearOptions
} = screenModule;

const SOURCE = readFileSync(new URL("../RealEstateTaxesScreen.tsx", import.meta.url), "utf8");
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

type Receipt = Parameters<typeof taxCalendarMonths>[2][number];

function receipt(id: string, over: Partial<Receipt> & { taxpayer?: Receipt["tax"]["taxpayer"]; kind?: Receipt["tax"]["kind"] } = {}): Receipt {
  const { taxpayer = "sociedad", kind = "ibi", ...rest } = over;
  return {
    id,
    taxId: "ptx_1",
    fiscalYear: 2026,
    period: "anual",
    issuedAt: null,
    dueFrom: "2026-10-01",
    dueTo: "2026-11-30",
    amount: "1250.00",
    surchargeAmount: "0.00",
    status: "recibido",
    paidAt: null,
    paidWith: null,
    journalEntryId: null,
    journalEntryStatus: null,
    capexProjectId: null,
    documentId: null,
    appealRef: null,
    notes: null,
    overdue: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    tax: { id: "ptx_1", kind, taxpayer, authorityName: "Ayuntamiento de prueba", fiscalReference: null, accountCode: "631", status: "activo" },
    ...rest
  };
}

const GRANTS = (...keys: string[]) => ({ grantedPermissions: keys, isPlatformAdmin: false });

describe("Tributos · Cocoa 22 y superficie de red (ACT-F2)", () => {
  it("nace sin estilos en línea, sin elementos crudos, sin literales de color, sin emoji y sin fetch crudo; formato solo por lib/format", () => {
    assert.equal(count(SOURCE, /\bstyle=\{/g), 0, "style={ debe ser 0");
    assert.doesNotMatch(SOURCE, /(?<!-)\bbo-[a-z0-9-]+/);
    assert.doesNotMatch(SOURCE, /<button\b/);
    assert.doesNotMatch(SOURCE, /<table\b/);
    assert.doesNotMatch(SOURCE, /<(?:input|select|textarea)\b/);
    assert.doesNotMatch(SOURCE, /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/);
    assert.doesNotMatch(SOURCE, /\p{Extended_Pictographic}/u);
    assert.doesNotMatch(SOURCE, /<h1\b|transition:\s*["']all|position:\s*["'(]*fixed|zIndex:\s*["'(]*\d/);
    assert.doesNotMatch(SOURCE, /\b(?:window\.|globalThis\.)?fetch\s*\(/);
    assert.doesNotMatch(SOURCE, /Intl\.(?:NumberFormat|DateTimeFormat)|toLocale[A-Za-z]*String\(/);
    assert.doesNotMatch(SOURCE, /from "\.\.\/\.\.\/services\/api-client"/, "la pantalla no importa api-client: todo por services/realEstateApi.ts");
  });

  it("exporta `RealEstateTaxesScreen` como primera función exportada (nombre distinto de compliance/PropertyTaxesScreen), pinta la cabecera Cocoa y las tres vistas del segmented control", () => {
    assert.equal(typeof RealEstateTaxesScreen, "function");
    assert.equal(screenModule.default, RealEstateTaxesScreen);
    assert.equal(/export\s+function\s+([A-Z][a-zA-Z0-9]+)/.exec(SOURCE)?.[1], "RealEstateTaxesScreen");
    assert.match(SOURCE, /<CocoaPage\b/);
    assert.match(SOURCE, /<CocoaSegmentedControl value=\{view\}/);
    assert.match(SOURCE, /role="tabpanel"/);
    assert.deepEqual(TAX_VIEW_OPTIONS.map((option) => option.label), ["Tributos", "Recibos", "Calendario"]);
    assert.equal(isTaxView("recibos"), true);
    assert.equal(isTaxView("iva"), false);
    assert.match(SOURCE, /<CocoaGrid columns=\{12\}/, "calendario de 12 meses en CocoaGrid");
    assert.match(SOURCE, /const canManageTaxes = canDo\(gate, "property_tax\.manage"\);/);
    assert.match(SOURCE, /const posting = postEntryGate\(gate\);/);
    assert.doesNotMatch(SOURCE, /auth-storage|getUser\(|\?\.permissions/);
    assert.deepEqual(
      TAX_COLUMNS.map((column) => column.key),
      ["kind", "taxpayer", "authorityName", "fiscalReference", "taxBase", "ratePct", "expectedAnnualAmount", "periodicity", "directDebit", "status", "receipts"]
    );
    assert.deepEqual(
      RECEIPT_COLUMNS.map((column) => column.key),
      ["tax", "period", "window", "amount", "status", "paid", "journal", "taxpayer"]
    );
    assert.deepEqual(yearOptions(2026).map((option) => option.value), ["2024", "2025", "2026", "2027"]);
    assert.match(SOURCE, /errorCode === "ASSET_NOT_FOUND"/);
  });

  it("acciones del recibo: Marcar recibido · Marcar pagado · Proponer asiento · Contabilizar · Recurrir · Enlazar asiento · Generar previstos <año>", () => {
    for (const label of ["Marcar recibido", "Marcar pagado", "Proponer asiento", "Contabilizar", "Recurrir", "Enlazar asiento", "Desenlazar asiento"]) assert.ok(SOURCE.includes(label), `acción «${label}»`);
    assert.match(SOURCE, /const generateLabel = `Generar previstos \$\{year\}`;/);
    assert.match(SOURCE, /generatePropertyTaxReceipts\(tax\.id, year, propertyId\)/);
    assert.match(SOURCE, /updatePropertyTaxReceipt\(receipt\.id, body, propertyId\)/);
    assert.match(SOURCE, /\{ status: "recibido" \}/);
    assert.match(SOURCE, /\{ status: "pagado", paidAt: paidAt \|\| null, paidWith \}/);
    assert.match(SOURCE, /\{ status: "recurrido", appealRef: ref \}/);
    assert.match(SOURCE, /\{ journalEntryId: id \}/);
    assert.match(SOURCE, /\{ journalEntryId: null \}/);
    assert.match(SOURCE, /postProposedEntry\(selected\.journalEntryId\)/);
    assert.match(SOURCE, /proposeReceiptEntry\(receiptId, propertyId\)/);
  });
});

describe("Tributos: «Proponer asiento» deshabilitado con taxpayer propietario_tercero", () => {
  it("con sujeto pasivo propietario_tercero (o arrendatario) el motivo va en `title` y el botón queda deshabilitado; con la sociedad se puede proponer", () => {
    const reason = proposeEntryDisabledReason(receipt("r1"), { taxpayer: "propietario_tercero" }, true);
    assert.equal(typeof reason, "string");
    assert.match(reason!, /sujeto pasivo es la sociedad/);
    assert.match(reason!, /propietario tercero/);
    assert.match(proposeEntryDisabledReason(receipt("r1"), { taxpayer: "arrendatario" }, true)!, /arrendatario/);
    assert.equal(proposeEntryDisabledReason(receipt("r1"), { taxpayer: "sociedad" }, true), null);
    // El botón del cajón lee ese motivo: disabled cuando hay motivo y `title` con el motivo.
    assert.match(SOURCE, /disabled=\{busy \|\| proposeEntryDisabledReason\(selected, selected\.tax, canManageTaxes\) !== null\}/);
    assert.match(SOURCE, /title=\{proposeEntryDisabledReason\(selected, selected\.tax, canManageTaxes\) \?\? "Crea el asiento en borrador/);
  });

  it("otros motivos: sin permiso, asiento ya enlazado (RECEIPT_ENTRY_EXISTS), recibo previsto o sin importe (RECEIPT_NOT_PAYABLE)", () => {
    assert.equal(proposeEntryDisabledReason(receipt("r1"), { taxpayer: "sociedad" }, false), NO_PERMISSION_TAXES);
    assert.match(proposeEntryDisabledReason(receipt("r1", { journalEntryId: "je_1", journalEntryStatus: "draft" }), { taxpayer: "sociedad" }, true)!, /ya tiene un asiento enlazado \(asiento en borrador\)/);
    assert.match(proposeEntryDisabledReason(receipt("r1", { status: "previsto" }), { taxpayer: "sociedad" }, true)!, /está previsto/);
    assert.match(proposeEntryDisabledReason(receipt("r1", { amount: "0.00" }), { taxpayer: "sociedad" }, true)!, /no tiene importe/);
    assert.equal(proposeEntryDisabledReason(receipt("r1", { status: "recurrido" }), { taxpayer: "sociedad" }, true), null, "un recibo recurrido se propone (la deuda sigue viva)");
  });
});

describe("Tributos: «Contabilizar» solo con accounting.journal.post", () => {
  it("postEntryGate: invisible sin accounting.journal.post; visible pero deshabilitado sin ai.high_risk.confirm; activo con las dos (o como administrador de plataforma)", () => {
    assert.deepEqual(postEntryGate(GRANTS("property_tax.manage", "real_estate.read")), { visible: false, enabled: false, reason: NO_PERMISSION_POST });
    assert.deepEqual(postEntryGate(GRANTS("accounting.journal.post")), { visible: true, enabled: false, reason: NO_PERMISSION_POST });
    assert.deepEqual(postEntryGate(GRANTS("accounting.journal.post", "ai.high_risk.confirm")), { visible: true, enabled: true, reason: null });
    assert.deepEqual(postEntryGate({ grantedPermissions: [], isPlatformAdmin: true }), { visible: true, enabled: true, reason: null });
    assert.deepEqual(postEntryGate({ grantedPermissions: null, isPlatformAdmin: false }), { visible: true, enabled: true, reason: null }, "perfil aún sin cargar: el API responde 403 si procede");
    // El botón solo se pinta con `posting.visible` y lee el motivo de postEntryDisabledReason.
    assert.match(SOURCE, /\{posting\.visible \? \(\s*<CocoaButton[\s\S]*?disabled=\{busy \|\| postEntryDisabledReason\(selected, posting\) !== null\}[\s\S]*?>\s*Contabilizar/);
  });

  it("postEntryDisabledReason: sin borrador enlazado, ya contabilizado, anulado o sin ai.high_risk.confirm; con borrador y las dos claves, null", () => {
    const both = postEntryGate(GRANTS("accounting.journal.post", "ai.high_risk.confirm"));
    const onlyPost = postEntryGate(GRANTS("accounting.journal.post"));
    assert.equal(postEntryDisabledReason(receipt("r1"), both), "Propón primero el asiento en borrador.");
    assert.equal(postEntryDisabledReason(receipt("r1", { journalEntryId: "je_1", journalEntryStatus: "posted" }), both), "El asiento ya está contabilizado.");
    assert.match(postEntryDisabledReason(receipt("r1", { journalEntryId: "je_1", journalEntryStatus: "reversed" }), both)!, /anulado/);
    assert.equal(postEntryDisabledReason(receipt("r1", { journalEntryId: "je_1", journalEntryStatus: "draft" }), onlyPost), NO_PERMISSION_POST);
    assert.equal(postEntryDisabledReason(receipt("r1", { journalEntryId: "je_1", journalEntryStatus: "draft" }), both), null);
    assert.equal(postEntryDisabledReason(receipt("r1", { journalEntryId: "je_1", journalEntryStatus: "draft" }), postEntryGate(GRANTS())), NO_PERMISSION_POST);
  });

  it("el estado del asiento se pinta con CocoaBadge: Borrador (ámbar) · Contabilizado (verde) · Anulado (rojo); sin asiento «—»", () => {
    const badge = (status: "draft" | "posted" | "reversed") => renderToStaticMarkup(createElement(JournalEntryBadge, { receipt: { journalEntryId: "je_1", journalEntryStatus: status } }));
    assert.match(badge("draft"), /warning/);
    assert.match(badge("draft"), /Asiento en borrador/);
    assert.match(badge("posted"), /success/);
    assert.match(badge("posted"), /Asiento contabilizado/);
    assert.match(badge("reversed"), /danger/);
    assert.match(badge("reversed"), /Asiento anulado/);
    assert.equal(renderToStaticMarkup(createElement(JournalEntryBadge, { receipt: { journalEntryId: null, journalEntryStatus: null } })), "<span>—</span>");
  });
});

describe("Tributos: 409 FISCAL_YEAR_CLOSED muestra el mensaje del helper", () => {
  it("proposeEntryFor pasa por el cliente real (POST …/propose-entry) y devuelve la frase de real-estate-helpers para el 409 del motor contable", async () => {
    setSession("token-de-prueba", { userId: "usr_test", organizationId: "org_test", propertyId: "prop_test", fullName: "Prueba ACT F2" });
    assert.equal(writeActiveProperty({ propertyId: "prop_test", organizationId: "org_test", propertyName: "Hotel de prueba" }), true);
    nextResponse = () => new Response(JSON.stringify({ message: "El ejercicio 2025 está cerrado.", details: { code: "FISCAL_YEAR_CLOSED", fiscalYear: "2025" }, correlationId: "corr_1" }), { status: 409, headers: { "content-type": "application/json" } });
    captured.length = 0;
    const result = await proposeEntryFor("ptr_2025", "prop_test");
    assert.equal(result.ok, false);
    assert.equal((result as { message: string }).message, REAL_ESTATE_ERROR_MESSAGES.FISCAL_YEAR_CLOSED);
    assert.match((result as { message: string }).message, /ejercicio está cerrado: enlaza el asiento importado/);
    const request = captured.find((call) => call.url.endsWith("/properties/prop_test/real-estate/receipts/ptr_2025/propose-entry"));
    assert.ok(request, "POST …/receipts/:id/propose-entry");
    assert.equal(request.method, "POST");
    assert.equal(request.headers["x-property-id"], "prop_test");
    // La pantalla enseña ese mensaje en el callout del cajón.
    assert.match(SOURCE, /const result = await proposeEntryFor\(receipt\.id, propertyId\);/);
    assert.match(SOURCE, /setActionFailure\(result\.message\);/);
  });

  it("con 201 devuelve el recibo con el borrador enlazado; taxFailureMessage traduce el resto de códigos y respeta el mensaje del API", async () => {
    nextResponse = () => new Response(JSON.stringify({ ...receipt("ptr_ok"), journalEntryId: "je_new", journalEntryStatus: "draft" }), { status: 201, headers: { "content-type": "application/json" } });
    const result = await proposeEntryFor("ptr_ok", "prop_test");
    assert.equal(result.ok, true);
    assert.equal((result as { receipt: { journalEntryStatus: string } }).receipt.journalEntryStatus, "draft");
    assert.equal(taxFailureMessage(new ApiError("x", 409, undefined, { code: "FISCAL_YEAR_CLOSED" })), REAL_ESTATE_ERROR_MESSAGES.FISCAL_YEAR_CLOSED);
    assert.equal(taxFailureMessage(new ApiError("x", 409, undefined, { code: "TAXPAYER_NOT_ENTITY" })), REAL_ESTATE_ERROR_MESSAGES.TAXPAYER_NOT_ENTITY);
    assert.equal(taxFailureMessage(new ApiError("x", 409, undefined, { code: "RECEIPT_ENTRY_EXISTS" })), REAL_ESTATE_ERROR_MESSAGES.RECEIPT_ENTRY_EXISTS);
    assert.equal(taxFailureMessage(new ApiError("x", 409, undefined, { code: "PROPERTY_TAX_INACTIVE" })), REAL_ESTATE_ERROR_MESSAGES.PROPERTY_TAX_INACTIVE);
    assert.equal(taxFailureMessage(new ApiError("Mensaje del API", 500)), "Mensaje del API");
    assert.equal(taxFailureMessage(null, "fallback propio"), "fallback propio");
  });
});

describe("Tributos: máquina del recibo, KPI, calendario y alta", () => {
  it("la pantalla ofrece solo las transiciones de la máquina RECEIPT del API; sin importe no se paga; con asiento enlazado se paga solo como estado (fecha y medio bloqueados)", () => {
    assert.deepEqual(RECEIPT_TRANSITIONS.previsto, ["recibido", "domiciliado", "pagado", "recurrido"]);
    assert.deepEqual(RECEIPT_TRANSITIONS.pagado, ["recurrido"], "ACT-REV-10: recurrir también desde pagado");
    assert.equal(canMarkReceived(receipt("r", { status: "previsto" })), true);
    assert.equal(canMarkReceived(receipt("r", { status: "recibido" })), false);
    assert.equal(canMarkPaid(receipt("r", { status: "recibido" })), true);
    assert.equal(canMarkPaid(receipt("r", { status: "recurrido" })), true);
    assert.equal(canMarkPaid(receipt("r", { status: "pagado" })), false);
    assert.equal(canAppeal(receipt("r", { status: "domiciliado" })), true);
    assert.equal(canAppeal(receipt("r", { status: "recurrido" })), false);
    assert.equal(canAppeal(receipt("r", { status: "pagado" })), true, "ACT-REV-10");
    assert.match(paidDisabledReason(receipt("r", { amount: "0.00" }))!, /no tiene importe/);
    assert.equal(paidDisabledReason(receipt("r")), null);
    assert.equal(paidDisabledReason(receipt("r", { journalEntryId: "je_1" })), null, "con asiento enlazado el API admite pagar (solo el estado)");
    assert.equal(paidFieldsLocked(receipt("r", { journalEntryId: "je_1", journalEntryStatus: "posted" })), true);
    assert.equal(paidFieldsLocked(receipt("r")), false);
    // El cajón manda fecha y medio solo cuando no están bloqueados; con asiento enlazado viaja solo el estado (409 RECEIPT_ENTRY_EXISTS si viajaran).
    assert.match(SOURCE, /fromDrawer && !paidFieldsLocked\(receipt\) \? \{ status: "pagado", paidAt: paidAt \|\| null, paidWith \} : \{ status: "pagado" \}/);
    assert.match(SOURCE, /disabled=\{busy \|\| paidFieldsLocked\(selected\)\}/);
    assert.equal(receiptTitle(receipt("r")), "IBI 2026");
    assert.equal(receiptTitle(receipt("r", { period: "PAC-02", kind: "iae" })), "IAE 2026 · PAC-02");
  });

  it("taxKpis: carga fiscal anual de los tributos activos (null si ninguno la informa), pendientes / pagados con recargo y vencidos", () => {
    const taxes = [
      { status: "activo" as const, expectedAnnualAmount: "1250.00" },
      { status: "activo" as const, expectedAnnualAmount: "300.50" },
      { status: "activo" as const, expectedAnnualAmount: null },
      { status: "baja" as const, expectedAnnualAmount: "9999.00" }
    ];
    const receipts = [receipt("a", { status: "pagado", amount: "1250.00", surchargeAmount: "0.00" }), receipt("b", { status: "recibido", amount: "300.50", surchargeAmount: "15.00", overdue: true }), receipt("c", { status: "previsto", amount: "100.00" })];
    assert.deepEqual(taxKpis(taxes, receipts), { annualBurden: 1550.5, activeTaxes: 3, pendingCount: 2, pendingAmount: 415.5, paidCount: 1, paidAmount: 1250, overdueCount: 1 });
    assert.equal(taxKpis([{ status: "activo", expectedAnnualAmount: null }], []).annualBurden, null);
  });

  it("taxCalendarMonths: 12 meses; el recibo cae en el mes en que termina su ventana, los periodos sin recibo y los eventos de recibos ajenos se añaden, los del mismo recibo no se duplican y todo va en orden", () => {
    assert.equal(MONTH_LABELS_ES.length, 12);
    const receipts = [receipt("ibi-1", { period: "PAC-01", dueFrom: "2026-05-01", dueTo: "2026-06-30" }), receipt("ibi-2", { period: "PAC-02", dueFrom: "2026-10-01", dueTo: "2026-11-30", status: "pagado" }), receipt("old", { fiscalYear: 2025, dueFrom: "2025-10-01", dueTo: "2025-11-30" })];
    const calendar = {
      year: 2026,
      events: [
        { kind: "TAX_DUE" as const, dueAt: "2026-06-30", entityType: "property_tax_receipt" as const, entityId: "ibi-1", propertyId: "prop_test", label: "duplicado del recibo" },
        { kind: "TAX_OVERDUE" as const, dueAt: "2026-03-31", entityType: "property_tax_receipt" as const, entityId: "otro", propertyId: "prop_test", label: "Tasa de residuos vencida" }
      ],
      pending: [{ taxId: "ptx_2", kind: "iae" as const, period: "anual", dueFrom: "2026-09-01", dueTo: "2026-11-20", amount: "800.00" }]
    };
    const months = taxCalendarMonths(2026, calendar, receipts);
    assert.equal(months.length, 12);
    assert.deepEqual(months.map((month) => month.label), [...MONTH_LABELS_ES]);
    assert.deepEqual(months[5].items.map((item) => item.key), ["receipt:ibi-1"], "junio: el recibo, sin el evento duplicado");
    assert.match(months[5].items[0].detail, /del 01\/05\/2026 al 30\/06\/2026 · 1250,00\s€/, "es-ES no agrupa las cifras de cuatro dígitos y separa el símbolo con un espacio duro");
    assert.equal(months[5].items[0].tone, "warning");
    assert.deepEqual(months[10].items.map((item) => item.key), ["pending:ptx_2:anual", "receipt:ibi-2"], "noviembre en orden de fecha: el IAE previsto (20/11) antes del PAC-02 (30/11)");
    assert.equal(months[10].items[1].tone, "success");
    assert.match(months[10].items[0].label, /IAE 2026 · sin recibo/);
    assert.deepEqual(months[2].items.map((item) => [item.key, item.tone]), [["event:TAX_OVERDUE:otro:2026-03-31", "danger"]]);
    assert.equal(months.flatMap((month) => month.items).some((item) => item.key === "receipt:old"), false, "un recibo de otro ejercicio no entra");
    assert.deepEqual(taxCalendarMonths(2026, null, []).map((month) => month.items.length), Array(12).fill(0));
  });

  it("alta del tributo: autoridad obligatoria, importes con coma normalizados, tipo con 4 decimales, periodo voluntario mes-día por parejas", () => {
    const form = { ...emptyTaxForm(), authorityName: " Ayuntamiento de prueba ", taxBase: "1.250.000,50", ratePct: "0,4525", expectedAnnualAmount: "5656,25", voluntaryFrom: "10-01", voluntaryTo: "11-30", directDebit: true, directDebitBonusPct: "5" };
    assert.deepEqual(validateTaxForm(form), {});
    assert.deepEqual(taxRequestOf(form), {
      kind: "ibi",
      taxpayer: "sociedad",
      authorityName: "Ayuntamiento de prueba",
      fiscalReference: null,
      taxBase: "1250000.50",
      ratePct: "0.4525",
      expectedAnnualAmount: "5656.25",
      periodicity: "anual",
      directDebit: true,
      directDebitBonusPct: "5.00",
      voluntaryFrom: "10-01",
      voluntaryTo: "11-30"
    });
    assert.deepEqual(validateTaxForm({ ...emptyTaxForm(), authorityName: "" }), { authorityName: "Indica la autoridad que recauda el tributo." });
    assert.deepEqual(validateTaxForm({ ...emptyTaxForm(), authorityName: "x", voluntaryFrom: "10-01" }), { voluntaryTo: "Indica las dos fechas del periodo voluntario o ninguna." });
    assert.deepEqual(validateTaxForm({ ...emptyTaxForm(), authorityName: "x", voluntaryFrom: "13-01", voluntaryTo: "11-30" }), { voluntaryFrom: "Formato mes-día (10-01)." });
    assert.deepEqual(validateTaxForm({ ...emptyTaxForm(), authorityName: "x", ratePct: "0,45255" }), { ratePct: "Porcentaje con cuatro decimales como máximo." });
    assert.deepEqual(validateTaxForm({ ...emptyTaxForm(), authorityName: "x", taxBase: "12,345" }), { taxBase: "Importe con dos decimales como máximo." });
    const noWindow = taxRequestOf({ ...emptyTaxForm(), authorityName: "x" });
    assert.equal(Object.hasOwn(noWindow, "voluntaryFrom"), false);
    assert.equal(noWindow.directDebitBonusPct, null, "sin domiciliar, la bonificación no viaja");
  });
});

// Tests unitarios de los helpers puros del activo inmobiliario (Tanda ACT ·
// lote ACT-F0) y contrato de superficie del cliente services/realEstateApi.ts
// (lectura de fuente: api-client.ts no carga bajo node --test por import.meta.env).
// Desde apps/admin-web: corepack pnpm --filter @hotelos/admin-web test

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { REAL_ESTATE_ERROR_CODES } from "@hotelos/shared";
import { COCOA_TONES } from "../../../components/cocoa/cocoa-tones";
import { FINANCE_ERROR_MESSAGES } from "../../../services/finance-contracts";
import {
  ALERT_SEVERITY_TONES,
  DOCUMENT_STATUS_TONES,
  REAL_ESTATE_CATALOGS,
  REAL_ESTATE_ERROR_FALLBACK,
  REAL_ESTATE_ERROR_MESSAGES,
  REAL_ESTATE_EXTRA_ERROR_CODES,
  REAL_ESTATE_MESSAGE_CODES,
  REAL_ESTATE_TONE_MAPS,
  alertKindLabel,
  alertSeverityTone,
  capexWorkKindLabel,
  catalogLabel,
  catalogOptions,
  documentCategoryLabel,
  documentKindLabel,
  documentStatusTone,
  formatDay,
  formatMoney,
  formatPercent,
  inspectionDueStateTone,
  inspectionKindLabel,
  inspectionResultLabel,
  insuranceKindLabel,
  monthDayLabel,
  monthDayRangeLabel,
  realEstateErrorMessage,
  receiptStatusLabel,
  receiptStatusText,
  receiptStatusTone,
  taxKindLabel,
  tenureKindLabel,
  tenureStatusTone
} from "../real-estate-helpers";

const FORBIDDEN_EN = /\b(Save|Cancel|Loading|Status|Pending|Error|Failed|Invalid|Not found|Document|Receipt)\b/;

describe("Activo inmobiliario · mensajes de error", () => {
  it("cada código de error tiene mensaje", () => {
    const codes = [...REAL_ESTATE_ERROR_CODES, ...REAL_ESTATE_EXTRA_ERROR_CODES];
    assert.ok(REAL_ESTATE_ERROR_CODES.length >= 18, `catálogo compartido inesperadamente corto: ${REAL_ESTATE_ERROR_CODES.length}`);
    assert.deepEqual([...REAL_ESTATE_MESSAGE_CODES], codes);
    assert.equal(new Set(codes).size, codes.length, "códigos repetidos entre el catálogo y los extras");
    for (const code of codes) {
      const message = REAL_ESTATE_ERROR_MESSAGES[code];
      assert.equal(typeof message, "string", `${code} sin mensaje`);
      assert.ok(message.trim().length > 20, `${code}: mensaje demasiado corto`);
      assert.match(message, /\.$/, `${code}: la frase termina en punto`);
      assert.doesNotMatch(message, FORBIDDEN_EN, `${code}: literal en inglés`);
      assert.doesNotMatch(message, /_/, `${code}: la frase no enseña códigos con guion bajo`);
    }
    assert.deepEqual(Object.keys(REAL_ESTATE_ERROR_MESSAGES).sort(), [...codes].sort(), "el mapa no lleva claves fuera del catálogo");
  });

  it("fija la frase del ejercicio cerrado del brief y los extras del almacén de documentos", () => {
    assert.equal(REAL_ESTATE_ERROR_MESSAGES.FISCAL_YEAR_CLOSED, "El ejercicio está cerrado: enlaza el asiento importado en vez de proponer uno nuevo.");
    assert.notEqual(REAL_ESTATE_ERROR_MESSAGES.FISCAL_YEAR_CLOSED, FINANCE_ERROR_MESSAGES.FISCAL_YEAR_CLOSED, "la frase del módulo difiere de la genérica de finanzas");
    for (const code of ["DOCUMENT_TOO_LARGE", "DOCUMENT_MIME_NOT_ALLOWED", "DOCUMENT_CONTENT_MISMATCH"] as const) {
      assert.ok(REAL_ESTATE_ERROR_MESSAGES[code], `${code} sin frase propia`);
    }
    assert.match(REAL_ESTATE_ERROR_MESSAGES.DOCUMENT_MIME_NOT_ALLOWED, /TIFF/, "la lista blanca del almacén incluye TIFF");
    assert.match(REAL_ESTATE_ERROR_MESSAGES.DOCUMENT_TOO_LARGE, /40 MiB/, "el límite del API es 40 MiB");
  });

  it("realEstateErrorMessage prioriza el mapa propio", () => {
    // Código compartido con finanzas: gana la frase del módulo.
    assert.equal(realEstateErrorMessage({ details: { code: "FISCAL_YEAR_CLOSED" }, message: "Ejercicio cerrado", status: 409 }), REAL_ESTATE_ERROR_MESSAGES.FISCAL_YEAR_CLOSED);
    assert.equal(realEstateErrorMessage({ details: { code: "DOCUMENT_TOO_LARGE" }, message: "413", status: 413 }), REAL_ESTATE_ERROR_MESSAGES.DOCUMENT_TOO_LARGE);
    // Código del catálogo del módulo: la frase propia, no el mensaje del API.
    assert.equal(realEstateErrorMessage({ details: { code: "LEGAL_HOLD" }, message: "Bloqueo legal activo.", status: 409 }), REAL_ESTATE_ERROR_MESSAGES.LEGAL_HOLD);
    assert.equal(realEstateErrorMessage({ details: { code: "TAXPAYER_NOT_ENTITY" }, message: "x" }), REAL_ESTATE_ERROR_MESSAGES.TAXPAYER_NOT_ENTITY);
    assert.equal(realEstateErrorMessage({ details: { code: "PROPERTY_TAX_INACTIVE" }, message: "x" }), REAL_ESTATE_ERROR_MESSAGES.PROPERTY_TAX_INACTIVE);
    // Las máquinas de estado añaden las transiciones posibles cuando el API las manda.
    assert.equal(
      realEstateErrorMessage({ details: { code: "INSPECTION_INVALID_TRANSITION", machine: "INSPECTION", from: "cerrada", to: "realizada", allowed: ["programada", "con_defectos"] } }),
      `${REAL_ESTATE_ERROR_MESSAGES.INSPECTION_INVALID_TRANSITION} Cambios posibles: programada, con_defectos.`
    );
    assert.equal(realEstateErrorMessage({ details: { code: "TENURE_INVALID_TRANSITION", allowed: [] } }), REAL_ESTATE_ERROR_MESSAGES.TENURE_INVALID_TRANSITION);
    assert.equal(realEstateErrorMessage({ details: { code: "TENURE_INVALID_TRANSITION" } }), REAL_ESTATE_ERROR_MESSAGES.TENURE_INVALID_TRANSITION);
    // Código solo de finanzas: cae en financeErrorMessage.
    assert.equal(realEstateErrorMessage({ details: { code: "JOURNAL_UNBALANCED" }, message: "x" }), FINANCE_ERROR_MESSAGES.JOURNAL_UNBALANCED);
    assert.equal(realEstateErrorMessage({ details: { code: "VALIDATION_ERROR" }, message: "x" }), FINANCE_ERROR_MESSAGES.VALIDATION_ERROR);
    // Sin código conocido: el mensaje del API; sin nada: el fallback.
    assert.equal(realEstateErrorMessage({ details: { code: "DESCONOCIDO" }, message: "  Mensaje del API.  " }), "Mensaje del API.");
    assert.equal(realEstateErrorMessage(new Error("Fallo de red")), "Fallo de red");
    assert.equal(realEstateErrorMessage(null), REAL_ESTATE_ERROR_FALLBACK);
    assert.equal(realEstateErrorMessage(undefined, "Otro fallback."), "Otro fallback.");
    assert.equal(realEstateErrorMessage({ details: {} , message: "" }), REAL_ESTATE_ERROR_FALLBACK);
  });
});

describe("Activo inmobiliario · etiquetas de los catálogos", () => {
  it("cada valor de cada catálogo tiene etiqueta", () => {
    assert.ok(REAL_ESTATE_CATALOGS.length >= 43, `catálogos registrados: ${REAL_ESTATE_CATALOGS.length}`);
    const names = REAL_ESTATE_CATALOGS.map((catalog) => catalog.name);
    assert.equal(new Set(names).size, names.length, "nombres de catálogo repetidos");
    for (const catalog of REAL_ESTATE_CATALOGS) {
      assert.ok(catalog.values.length > 0, `${catalog.name}: catálogo vacío`);
      for (const value of catalog.values) {
        const label = catalog.labels[value];
        assert.equal(typeof label, "string", `${catalog.name}.${value} sin etiqueta`);
        assert.ok(label.trim().length > 0, `${catalog.name}.${value}: etiqueta vacía`);
        assert.doesNotMatch(label, /_/, `${catalog.name}.${value}: la etiqueta enseña un guion bajo`);
        assert.equal(catalogLabel(catalog.labels, value), label);
      }
      assert.deepEqual(Object.keys(catalog.labels).sort(), [...catalog.values].sort(), `${catalog.name}: claves del mapa ≠ valores del catálogo`);
      const options = catalogOptions(catalog.values, catalog.labels);
      assert.deepEqual(
        options,
        catalog.values.map((value) => ({ value, label: catalog.labels[value] }))
      );
    }
  });

  it("las funciones de etiqueta del brief leen su mapa y humanizan lo desconocido", () => {
    assert.equal(tenureKindLabel("arrendamiento_industria"), "Arrendamiento de industria");
    assert.equal(taxKindLabel("ibi"), "IBI");
    assert.equal(receiptStatusLabel("domiciliado"), "Domiciliado");
    assert.equal(documentCategoryLabel("licencias"), "Licencias");
    assert.equal(documentKindLabel("ppcl_legionella"), "Plan de prevención de legionela");
    assert.equal(inspectionKindLabel("oca_ascensor"), "OCA de ascensores");
    assert.equal(inspectionResultLabel("condicionada"), "Favorable con defectos");
    assert.equal(insuranceKindLabel("perdida_beneficios"), "Pérdida de beneficios");
    assert.equal(alertKindLabel("CAPEX_LICENCE_MISSING"), "Obra sin licencia");
    assert.equal(capexWorkKindLabel("pip"), "Plan de mejora (PIP)");
    // Valor que el front aún no conoce: humanizado, nunca el guion bajo; vacío → «—».
    assert.equal(tenureKindLabel("nuevo_tipo"), "Nuevo tipo");
    assert.equal(documentKindLabel(null), "—");
    assert.equal(documentKindLabel("  "), "—");
    assert.equal(alertKindLabel(undefined), "—");
  });

  it("el recibo vencido se lee como «Vencido» salvo si ya está pagado", () => {
    assert.equal(receiptStatusText({ status: "recibido", overdue: true }), "Vencido");
    assert.equal(receiptStatusText({ status: "pagado", overdue: true }), "Pagado");
    assert.equal(receiptStatusText({ status: "previsto", overdue: false }), "Previsto");
  });
});

describe("Activo inmobiliario · tonos por estado", () => {
  it("tonos por estado", () => {
    assert.ok(REAL_ESTATE_TONE_MAPS.length >= 13, `mapas de tono: ${REAL_ESTATE_TONE_MAPS.length}`);
    for (const map of REAL_ESTATE_TONE_MAPS) {
      for (const value of map.values) {
        const tone = map.tones[value];
        assert.ok(tone, `${map.name}.${value} sin tono`);
        assert.ok(COCOA_TONES.includes(tone), `${map.name}.${value}: tono «${tone}» fuera de Cocoa`);
      }
      assert.deepEqual(Object.keys(map.tones).sort(), [...map.values].sort(), `${map.name}: claves ≠ catálogo`);
    }
    // Vigencia del documento: verde · ámbar · rojo · gris (CocoaBadge).
    assert.deepEqual(DOCUMENT_STATUS_TONES, { vigente: "success", caduca_pronto: "warning", caducado: "danger", sin_fecha: "neutral", sustituido: "neutral" });
    assert.equal(documentStatusTone("caduca_pronto"), "warning");
    assert.equal(documentStatusTone("otro"), "neutral");
    assert.equal(documentStatusTone(null), "neutral");
    // Gravedad de la alerta.
    assert.deepEqual(ALERT_SEVERITY_TONES, { alta: "danger", media: "warning", baja: "info" });
    assert.equal(alertSeverityTone("alta"), "danger");
    assert.equal(alertSeverityTone(undefined), "neutral");
    // Tenencia, plazo de inspección y recibo (con el «vencido» derivado).
    assert.equal(tenureStatusTone("vigente"), "success");
    assert.equal(tenureStatusTone("vencido"), "danger");
    assert.equal(inspectionDueStateTone("vencida"), "danger");
    assert.equal(inspectionDueStateTone("proxima"), "warning");
    assert.equal(receiptStatusTone({ status: "recibido", overdue: true }), "danger");
    assert.equal(receiptStatusTone({ status: "pagado", overdue: true }), "success");
    assert.equal(receiptStatusTone({ status: "recurrido", overdue: false }), "warning");
    assert.equal(receiptStatusTone({ status: "inventado" }), "neutral");
  });
});

describe("Activo inmobiliario · formateadores (lib/format, es-ES)", () => {
  it("formatMoney y formatDay reutilizan money/date y devuelven «—» sin valor", () => {
    assert.match(formatMoney("1234.5"), /^1234,50\s€$/);
    assert.match(formatMoney(12500), /^12\.500,00\s€$/);
    assert.equal(formatMoney(null), "—");
    assert.equal(formatMoney("no-numérico"), "—");
    assert.equal(formatDay("2026-09-20"), "20/09/2026");
    assert.equal(formatDay(null), "—");
    assert.equal(formatDay("2026-13-45"), "—");
    assert.match(formatPercent("6.25"), /^6,25\s%$/);
    assert.match(formatPercent("0.4525", 4), /^0,4525\s%$/);
    assert.equal(formatPercent(null), "—");
  });

  it("monthDayLabel y monthDayRangeLabel leen las ventanas MM-DD de los tributos", () => {
    assert.equal(monthDayLabel("10-01", 2026), "1 oct");
    assert.equal(monthDayLabel("13-45", 2026), "—");
    assert.equal(monthDayLabel(null), "—");
    assert.equal(monthDayRangeLabel("10-01", "11-30", 2026), "del 1 oct al 30 nov");
    assert.equal(monthDayRangeLabel(null, "11-30", 2026), "hasta el 30 nov");
    assert.equal(monthDayRangeLabel("10-01", null, 2026), "desde el 1 oct");
    assert.equal(monthDayRangeLabel(null, null), "—");
  });
});

// ---------------------------------------------------------------------------
// Superficie del cliente services/realEstateApi.ts (fuente sin comentarios)
// ---------------------------------------------------------------------------

const API_SOURCE = readFileSync(new URL("../../../services/realEstateApi.ts", import.meta.url), "utf8");
const code = API_SOURCE.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

const API_FUNCTIONS = [
  "getRealEstateAsset",
  "createRealEstateAsset",
  "updateRealEstateAsset",
  "createRealEstateUnit",
  "updateRealEstateUnit",
  "createRealEstateCharge",
  "updateRealEstateCharge",
  "listRealEstateValuations",
  "createRealEstateValuation",
  "listRealEstateTenures",
  "createRealEstateTenure",
  "updateRealEstateTenure",
  "listPropertyTaxes",
  "createPropertyTax",
  "updatePropertyTax",
  "createPropertyTaxReceipt",
  "generatePropertyTaxReceipts",
  "listPropertyTaxReceipts",
  "updatePropertyTaxReceipt",
  "proposeReceiptEntry",
  "getPropertyTaxCalendar",
  "listRealEstateDocuments",
  "uploadRealEstateDocument",
  "uploadRealEstateDocumentVersion",
  "updateRealEstateDocument",
  "retireRealEstateDocument",
  "downloadRealEstateDocument",
  "listRealEstateWorks",
  "updateCapexWork",
  "capitalizeCapexProject",
  "listRealEstateInspections",
  "createRealEstateInspection",
  "updateRealEstateInspection",
  "listRealEstateInsurances",
  "createRealEstateInsurance",
  "updateRealEstateInsurance",
  "listRealEstateAlerts",
  "getRealEstateCalendar",
  "getRealEstateGroupOverview",
  "getRealEstateGroupCalendar",
  "exportRealEstateCsv",
  "postProposedEntry"
];

const API_ROUTES = [
  "/real-estate",
  "/units",
  "/charges",
  "/valuations",
  "/tenures",
  "/taxes",
  "/receipts",
  "/receipts/generate",
  "/propose-entry",
  "/tax-calendar",
  "/documents",
  "/versions",
  "/file",
  "/works",
  "/capex-projects/",
  "/work",
  "/capitalize",
  "/inspections",
  "/insurances",
  "/alerts",
  "/overview",
  "/calendar",
  "/export",
  "/journal-entries/",
  "/post"
];

describe("services/realEstateApi.ts · superficie del cliente", () => {
  it("exporta una función tipada por cada una de las 42 rutas del módulo (41 del activo + el asiento propuesto)", () => {
    assert.equal(API_FUNCTIONS.length, 42);
    for (const name of API_FUNCTIONS) {
      assert.match(code, new RegExp(`export (async )?function ${name}\\(`), `falta ${name}`);
    }
    for (const route of API_ROUTES) {
      assert.ok(code.includes(route), `falta la ruta ${route}`);
    }
  });

  it("pasa siempre por apiRequest / apiRequestBlob (binario para el fichero y el CSV) y lee el fichero con FileReader", () => {
    assert.match(code, /import \{ apiRequest, apiRequestBlob, type BlobResponse \} from "\.\/api-client";/);
    assert.match(code, /import \{ getActiveOrganizationId, getActivePropertyId \} from "\.\/activeProperty";/);
    assert.match(code, /import \{ compactQuery, financeErrorMessage, type FinanceQuery \} from "\.\/finance-contracts";/);
    assert.doesNotMatch(code, /\b(?:window\.|globalThis\.)?fetch\s*\(/, "nunca fetch crudo (tests/admin-web-no-raw-fetch)");
    assert.match(code, /export function downloadRealEstateDocument[\s\S]*?apiRequestBlob\(/);
    assert.match(code, /export function exportRealEstateCsv[\s\S]*?apiRequestBlob\(/);
    assert.match(code, /new FileReader\(\)/);
    assert.match(code, /readAsDataURL\(/);
    assert.match(code, /result\.slice\(comma \+ 1\)/, "el base64 viaja sin el prefijo data:");
    assert.match(code, /file: await documentFileOf\(file\)/, "la subida envía { …meta, file: { fileName, mimeType, base64 } }");
    assert.match(code, /export function realEstateApiErrorMessage\(/);
    assert.doesNotMatch(code, /from "\.\.\/screens\//, "los servicios nunca importan pantallas");
  });
});

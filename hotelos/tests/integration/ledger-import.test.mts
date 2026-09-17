/**
 * Importación contable desde Sage 200 · Tanda 7c · L2 — integración (Postgres, en
 * proceso, sin HTTP). Una organización AISLADA `org_li_<run>` (una sociedad, dos hoteles
 * HA / HB y una oficina central OC, plan PGC Pymes hotelero provisionado) creada aquí y
 * borrada en `after` recorre el servicio con ficheros canónicos SINTÉTICOS construidos
 * inline (empresa Sage ficticia, CIF sintéticos con control válido, ningún NIF real):
 *   · plan: crea la subcuenta 623.2 (padre 623, naturaleza heredada, USALI de la plantilla)
 *     sin renombrar nada; segunda pasada → skipped_existing; nombre distinto → 409 ACCOUNT_CODE_EXISTS;
 *   · mapa analítico persistido (PUT / GET);
 *   · journal septiembre 2026 → asientos numerados en orden de fecha con reference «Sage 200 ·
 *     asiento …», líneas 6/7 con costCenterId de tipo usali, sourceId con periodo, reparto por
 *     centro con Σ exacta, skipped_native de una factura propia (invoice + asiento 'invoice'/<id>);
 *     409 LEDGER_IMPORT_DUPLICATE / LEDGER_IMPORT_OVERLAP; `replace` revierte ENTERO el anterior;
 *   · reconciliación consolidada `ok` y `differences` (asiento nativo extra → native_only; cuenta
 *     Sage sin mapear y apunte excluido → missing_in_ledger) con CSV;
 *   · reverso idempotente; reverso con el original en un mes cerrado → 409 y rollback (0 filas);
 *     periodo cerrado en create → 409 FISCAL_PERIOD_CLOSED y NINGUNA fila del lote;
 *   · vat_books sin vat_settings → 409 LEDGER_IMPORT_VAT_SETTINGS_MISSING (nunca se crea la fila);
 *     con fila → filas sage200 y `rebuildVatBooks` del rango las conserva;
 *   · third_parties sin createSuppliers → 0 suppliers; con createSuppliers → 1 y la segunda pasada no duplica;
 *   · fiscal_years crea 2025 con 12 periodos y la apertura; repetido idempotente; ejercicio ≠ YYYY → 400;
 *     journal 2025 con la apertura ya importada → skipped_existing;
 *   · balances 2024 → apertura + resumen + regularización + cierre, Sumas y saldos / balance / PyG
 *     comparativa con las cifras esperadas, ejercicio closed; reopenFiscalYear → 409
 *     FISCAL_YEAR_CLOSED_FROM_IMPORT; reverso del lote → open y periodos reabiertos;
 *   · listado y detalle.
 * Faranda y org_123 NUNCA se escriben (recuentos idénticos antes y después). Desde el repo:
 *   cd apps/api && node --env-file-if-exists=../../.env --import tsx --test "../../tests/integration/ledger-import.test.mts"
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { UserContext } from "../../apps/api/src/lib/demo-store.js";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {
  // No .env → CI defaults below.
}
process.env.DATABASE_URL ??= "postgresql://hotelos:hotelos@localhost:5432/hotelos";
process.env.JWT_SECRET ??= "integration-test-secret-32chars-minimum-aaaa";
process.env.ENCRYPTION_KEY ??= "integration-test-enckey-32chars-min-aaaa";
delete process.env.STRUCTURE_ENABLED;

const { prisma } = await import("@hotelos/database");
const accounting = await import("../../apps/api/src/modules/accounting/accounting.service.js");
const fiscalPeriods = await import("../../apps/api/src/modules/accounting/fiscal-period.service.js");
const fiscalYears = await import("../../apps/api/src/modules/accounting/fiscal-year.service.js");
const vatBooks = await import("../../apps/api/src/modules/accounting/vat-books.service.js");
const trialBalance = await import("../../apps/api/src/modules/accounting/trial-balance.service.js");
const annual = await import("../../apps/api/src/modules/financial-statements/annual-accounts.service.js");
const { provisionOrganizationChart } = await import("../../apps/api/src/modules/accounting/chart-of-accounts.service.js");
const ledgerImport = await import("../../apps/api/src/modules/accounting/import/ledger-import.service.js");
const reconciliation = await import("../../apps/api/src/modules/accounting/import/ledger-reconciliation.service.js");
const { HttpError } = await import("../../apps/api/src/lib/http-error.js");
const { flushAuditQueues } = await import("../../apps/api/src/modules/audit/audit.service.js");
const { flushAccountingProjection } = await import("../../apps/api/src/modules/accounting/projection.js");
const { flushExtraProjections } = await import("../../apps/api/src/modules/accounting/posting-rules/index.js");

const RUN = Date.now().toString(36);
const ORG = `org_li_${RUN}`;
const ENTITY = `le_li_${RUN}`;
const HA = `prop_li_ha_${RUN}`;
const HB = `prop_li_hb_${RUN}`;
const OC = `prop_li_oc_${RUN}`;
const USER = `usr_li_${RUN}`;
const CORR = `corr_li_${RUN}`;
const FARANDA = "cmrhw9jy30002fyvb6tsdiugt";

/** CIF sintético «A» + 7 dígitos + control válido (misma regla que las suites hermanas y los fixtures de L1). */
function syntheticCif(seed: number): string {
  const digits = String(seed % 10_000_000).padStart(7, "0");
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const digit = Number(digits[i]);
    if (i % 2 === 0) {
      const doubled = digit * 2;
      sum += Math.floor(doubled / 10) + (doubled % 10);
    } else sum += digit;
  }
  return `A${digits}${(10 - (sum % 10)) % 10}`;
}
const TAX_ID = syntheticCif(Date.now());
const NIF_SUMINISTROS = syntheticCif(1234567); // A12345674
const NIF_VIAJES = syntheticCif(2345678); // A23456783
const NIF_LAVANDERIA = syntheticCif(3456789); // A34567891

const context = {
  organizationId: ORG,
  propertyId: HA,
  userId: USER,
  fullName: "Contable LI",
  deviceId: "li-test",
  permissions: ["accounting.journal.post", "accounting.read", "accounting.entity.read", "accounting.configure", "analytics.read", "ai.high_risk.confirm"]
} as unknown as UserContext;
const reader = { ...context, permissions: ["accounting.read", "accounting.entity.read"] } as unknown as UserContext;

type Details = Record<string, unknown>;

async function expectCode<T>(promise: Promise<T>, statusCode: number, code: string): Promise<Details> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof HttpError, `expected an HttpError, got ${String(error)}`);
    assert.equal(error.statusCode, statusCode, `status of ${code}: ${error.message}`);
    const details = (error.details ?? {}) as Details;
    assert.equal(details.code, code, `details.code (${error.message})`);
    return details;
  }
  assert.fail(`expected ${statusCode} ${code}`);
}

/** «250,00» (decimal con coma, como exporta Sage). */
function es(value: string | number): string {
  return Number(value).toFixed(2).replace(".", ",");
}

function csv(header: string, rows: readonly string[][]): string {
  return `\uFEFF${[header, ...rows.map((row) => row.join(";"))].join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// Ficheros canónicos sintéticos (empresa Sage «1»)
// ---------------------------------------------------------------------------

const PLAN_HEADER = "cuenta;titulo;nif;pais;longitud";
const PLAN_ROWS: string[][] = [
  ["6230002", "Asesoría fiscal", "", "", "7"],
  ["6280001", "Electricidad", "", "", "7"],
  ["6290002", "Lavandería externa", "", "", "7"],
  ["4300000123", "Viajes Cantábrico SL", NIF_VIAJES, "ES", "10"],
  ["4000000042", "Suministros Eléctricos del Noroeste SL", NIF_SUMINISTROS, "ES", "10"],
  ["4100000007", "Lavandería Industrial del Cantábrico SL", NIF_LAVANDERIA, "ES", "10"],
  ["7050001", "Alojamiento", "", "", "7"],
  ["4770010", "IVA repercutido 10", "", "", "7"],
  ["4720021", "IVA soportado 21", "", "", "7"],
  ["5720000", "Bancos", "", "", "7"],
  ["1000000", "Capital social", "", "", "7"],
  ["1290000", "Resultado del ejercicio", "", "", "7"],
  ["9990000001", "Cuenta rara", "", "", "10"]
];
const PLAN_CSV = csv(PLAN_HEADER, PLAN_ROWS);
const PLAN_RENAMED_CSV = csv(PLAN_HEADER, [["6230002", "Otro nombre", "", "", "7"]]);

const JOURNAL_HEADER = "empresa;ejercicio;asiento;fecha;periodo;cuenta;debe;haber;concepto;documento;canal;delegacion;departamento;seccion;proyecto;serie;factura;fecha_factura;nif;nombre;base_iva;tipo_iva;cuota_iva;tipo_factura";
type J = { asiento: string; fecha: string; periodo?: string; cuenta: string; debe?: string; haber?: string; concepto: string; documento?: string; delegacion?: string; departamento?: string; serie?: string; factura?: string; fechaFactura?: string; nif?: string; nombre?: string; baseIva?: string; tipoIva?: string; cuotaIva?: string; tipoFactura?: string };
function journalRow(year: string, line: J): string[] {
  return ["1", year, line.asiento, line.fecha, line.periodo ?? String(Number(line.fecha.slice(5, 7))), line.cuenta, line.debe ? es(line.debe) : "", line.haber ? es(line.haber) : "", line.concepto, line.documento ?? "", "", line.delegacion ?? "", line.departamento ?? "", "", "", line.serie ?? "", line.factura ?? "", line.fechaFactura ?? "", line.nif ?? "", line.nombre ?? "", line.baseIva ? es(line.baseIva) : "", line.tipoIva ?? "", line.cuotaIva ? es(line.cuotaIva) : "", line.tipoFactura ?? ""];
}
const SEPT_LINES: J[] = [
  { asiento: "1501", fecha: "2026-09-03", cuenta: "6280001", debe: "250", concepto: "Electricidad septiembre", documento: "F-778", delegacion: "HA", departamento: "MANT" },
  { asiento: "1501", fecha: "2026-09-03", cuenta: "4720021", debe: "52.5", concepto: "IVA soportado 21 %", documento: "F-778", delegacion: "HA", baseIva: "250", tipoIva: "21", cuotaIva: "52.5", tipoFactura: "R" },
  { asiento: "1501", fecha: "2026-09-03", cuenta: "4000000042", haber: "302.5", concepto: "Suministros Eléctricos del Noroeste SL", documento: "F-778", delegacion: "HA", serie: "F", factura: "778", fechaFactura: "2026-09-03", nif: NIF_SUMINISTROS, nombre: "SUMINISTROS ELECTRICOS DEL NOROESTE SL", tipoFactura: "R" },
  { asiento: "1502", fecha: "2026-09-04", cuenta: "4300000123", debe: "1100", concepto: "Viajes Cantábrico SL", documento: "FAC-2026-000015", delegacion: "HA", serie: "FAC-2026", factura: "000015", fechaFactura: "2026-09-04", nif: NIF_VIAJES, nombre: "VIAJES CANTABRICO SL", tipoFactura: "E" },
  { asiento: "1502", fecha: "2026-09-04", cuenta: "7050001", haber: "1000", concepto: "Alojamiento grupo", documento: "FAC-2026-000015", delegacion: "HA", departamento: "HAB" },
  { asiento: "1502", fecha: "2026-09-04", cuenta: "4770010", haber: "100", concepto: "IVA repercutido 10 %", documento: "FAC-2026-000015", delegacion: "HA", baseIva: "1000", tipoIva: "10", cuotaIva: "100", tipoFactura: "E" },
  { asiento: "1503", fecha: "2026-09-05", cuenta: "6290002", debe: "300", concepto: "Lavandería agosto HA", documento: "L-2026-91", delegacion: "HA", departamento: "ADM" },
  { asiento: "1503", fecha: "2026-09-05", cuenta: "6290002", debe: "100", concepto: "Lavandería agosto HB", documento: "L-2026-91", delegacion: "HB", departamento: "ADM" },
  { asiento: "1503", fecha: "2026-09-05", cuenta: "4720021", debe: "84", concepto: "IVA soportado 21 %", documento: "L-2026-91", baseIva: "400", tipoIva: "21", cuotaIva: "84", tipoFactura: "R" },
  { asiento: "1503", fecha: "2026-09-05", cuenta: "4100000007", haber: "484", concepto: "Lavandería Industrial del Cantábrico SL", documento: "L-2026-91", serie: "L", factura: "91", nif: NIF_LAVANDERIA, nombre: "LAVANDERIA INDUSTRIAL DEL CANTABRICO SL", tipoFactura: "R" },
  { asiento: "1504", fecha: "2026-09-06", cuenta: "6230002", debe: "200", concepto: "Asesoría fiscal septiembre", delegacion: "OC", departamento: "ADM" },
  { asiento: "1504", fecha: "2026-09-06", cuenta: "5720000", haber: "200", concepto: "Asesoría fiscal septiembre", delegacion: "OC" },
  { asiento: "1505", fecha: "2026-09-07", cuenta: "4000000042", debe: "302.5", concepto: "Pago F-778", delegacion: "HA" },
  { asiento: "1505", fecha: "2026-09-07", cuenta: "5720000", haber: "302.5", concepto: "Pago F-778", delegacion: "HA" }
];
const SEPT_EXTRA: J[] = [
  { asiento: "1506", fecha: "2026-09-08", cuenta: "6280001", debe: "80", concepto: "Gas septiembre HB", delegacion: "HB", departamento: "MANT" },
  { asiento: "1506", fecha: "2026-09-08", cuenta: "5720000", haber: "80", concepto: "Gas septiembre HB", delegacion: "HB" }
];
const JOURNAL_SEPT_CSV = csv(JOURNAL_HEADER, SEPT_LINES.map((line) => journalRow("2026", line)));
const JOURNAL_SEPT_B_CSV = csv(JOURNAL_HEADER, [...SEPT_LINES, ...SEPT_EXTRA].map((line) => journalRow("2026", line)));
const JOURNAL_OCT_CSV = csv(JOURNAL_HEADER, [
  journalRow("2026", { asiento: "1601", fecha: "2026-10-05", cuenta: "6280001", debe: "50", concepto: "Electricidad octubre", delegacion: "HA", departamento: "MANT" }),
  journalRow("2026", { asiento: "1601", fecha: "2026-10-05", cuenta: "5720000", haber: "50", concepto: "Electricidad octubre", delegacion: "HA" })
]);
const JOURNAL_NOV_CSV = csv(JOURNAL_HEADER, [
  journalRow("2026", { asiento: "1701", fecha: "2026-11-05", cuenta: "6280001", debe: "60", concepto: "Electricidad noviembre", delegacion: "HA", departamento: "MANT" }),
  journalRow("2026", { asiento: "1701", fecha: "2026-11-05", cuenta: "5720000", haber: "60", concepto: "Electricidad noviembre", delegacion: "HA" })
]);
const OPENING_2025: J[] = [
  { asiento: "1", fecha: "2025-01-01", periodo: "0", cuenta: "5720000", debe: "50000", concepto: "Apertura 2025" },
  { asiento: "1", fecha: "2025-01-01", periodo: "0", cuenta: "1000000", haber: "30000", concepto: "Apertura 2025" },
  { asiento: "1", fecha: "2025-01-01", periodo: "0", cuenta: "1290000", haber: "20000", concepto: "Apertura 2025" }
];
const FISCAL_YEARS_CSV = csv(JOURNAL_HEADER, OPENING_2025.map((line) => journalRow("2025", line)));
const FISCAL_YEARS_BAD_CSV = csv(JOURNAL_HEADER, OPENING_2025.map((line) => journalRow("25", line)));
const JOURNAL_2025_CSV = csv(JOURNAL_HEADER, [
  ...OPENING_2025.map((line) => journalRow("2025", line)),
  journalRow("2025", { asiento: "2", fecha: "2025-03-10", cuenta: "6280001", debe: "100", concepto: "Electricidad marzo", delegacion: "HA", departamento: "MANT" }),
  journalRow("2025", { asiento: "2", fecha: "2025-03-10", cuenta: "5720000", haber: "100", concepto: "Electricidad marzo", delegacion: "HA" })
]);

/** Ejercicio 2023 entero por diario, cierre de Sage incluido (periodos «Cierre ejercicio» / «Cierre Contabilidad»), importado ANTES de «ejercicios» (SD-06 / C11). */
const JOURNAL_2023_CSV = csv(JOURNAL_HEADER, [
  journalRow("2023", { asiento: "1", fecha: "2023-01-01", periodo: "0", cuenta: "5720000", debe: "1000", concepto: "Apertura 2023" }),
  journalRow("2023", { asiento: "1", fecha: "2023-01-01", periodo: "0", cuenta: "1000000", haber: "1000", concepto: "Apertura 2023" }),
  journalRow("2023", { asiento: "2", fecha: "2023-03-10", cuenta: "6280001", debe: "100", concepto: "Electricidad marzo", delegacion: "HA", departamento: "MANT" }),
  journalRow("2023", { asiento: "2", fecha: "2023-03-10", cuenta: "5720000", haber: "100", concepto: "Electricidad marzo", delegacion: "HA" }),
  journalRow("2023", { asiento: "3", fecha: "2023-12-31", periodo: "regularizacion", cuenta: "1290000", debe: "100", concepto: "Cierre ejercicio 2023" }),
  journalRow("2023", { asiento: "3", fecha: "2023-12-31", periodo: "regularizacion", cuenta: "6280001", haber: "100", concepto: "Cierre ejercicio 2023", delegacion: "HA", departamento: "MANT" }),
  journalRow("2023", { asiento: "4", fecha: "2023-12-31", periodo: "cierre", cuenta: "1000000", debe: "1000", concepto: "Cierre contabilidad 2023" }),
  journalRow("2023", { asiento: "4", fecha: "2023-12-31", periodo: "cierre", cuenta: "5720000", haber: "900", concepto: "Cierre contabilidad 2023" }),
  journalRow("2023", { asiento: "4", fecha: "2023-12-31", periodo: "cierre", cuenta: "1290000", haber: "100", concepto: "Cierre contabilidad 2023" })
]);
const FISCAL_YEARS_2023_CSV = csv(JOURNAL_HEADER, [
  journalRow("2023", { asiento: "1", fecha: "2023-01-01", periodo: "0", cuenta: "5720000", debe: "1000", concepto: "Apertura 2023" }),
  journalRow("2023", { asiento: "1", fecha: "2023-01-01", periodo: "0", cuenta: "1000000", haber: "1000", concepto: "Apertura 2023" })
]);

const BALANCES_HEADER = "empresa;ejercicio;periodo;cuenta;titulo;delegacion;apertura_debe;apertura_haber;debe;haber;saldo_deudor;saldo_acreedor";
type B = { cuenta: string; titulo: string; delegacion?: string; aperturaDebe?: string; aperturaHaber?: string; debe?: string; haber?: string; deudor?: string; acreedor?: string };
function balanceRow(year: string, period: string, row: B): string[] {
  return ["1", year, period, row.cuenta, row.titulo, row.delegacion ?? "", es(row.aperturaDebe ?? 0), es(row.aperturaHaber ?? 0), es(row.debe ?? 0), es(row.haber ?? 0), es(row.deudor ?? 0), es(row.acreedor ?? 0)];
}
/** Sumas y saldos de septiembre 2026 (nivel 0) coherente con el lote sustituido + la factura propia (Sage registra todo). */
const SAGE_BALANCE_SEPT: B[] = [
  { cuenta: "6280001", titulo: "Electricidad", debe: "330", deudor: "330" },
  { cuenta: "4720021", titulo: "IVA soportado 21", debe: "136.5", deudor: "136.5" },
  { cuenta: "4000000042", titulo: "Suministros Eléctricos", debe: "302.5", haber: "302.5" },
  { cuenta: "6290002", titulo: "Lavandería externa", debe: "400", deudor: "400" },
  { cuenta: "4100000007", titulo: "Lavandería Industrial", haber: "484", acreedor: "484" },
  { cuenta: "6230002", titulo: "Asesoría fiscal", debe: "200", deudor: "200" },
  { cuenta: "5720000", titulo: "Bancos", haber: "582.5", acreedor: "582.5" },
  { cuenta: "4300000123", titulo: "Viajes Cantábrico", debe: "1100", deudor: "1100" },
  { cuenta: "7050001", titulo: "Alojamiento", haber: "1000", acreedor: "1000" },
  { cuenta: "4770010", titulo: "IVA repercutido 10", haber: "100", acreedor: "100" }
];
const BALANCE_SEPT_CSV = csv(BALANCES_HEADER, SAGE_BALANCE_SEPT.map((row) => balanceRow("2026", "2026-09", row)));
const BALANCE_SEPT_DIFF_CSV = csv(BALANCES_HEADER, [...SAGE_BALANCE_SEPT, { cuenta: "9990000001", titulo: "Cuenta rara", debe: "5", deudor: "5" }].map((row) => balanceRow("2026", "2026-09", row)));
/** Ejercicio 2024 entero (periodo anual) con apertura, movimientos brutos y saldos de cierre (§6). */
const BALANCES_2024_CSV = csv(BALANCES_HEADER, [
  balanceRow("2024", "2024", { cuenta: "5720000", titulo: "Bancos", aperturaDebe: "50000", debe: "110000", haber: "48400", deudor: "111600" }),
  balanceRow("2024", "2024", { cuenta: "1000000", titulo: "Capital social", aperturaHaber: "30000", acreedor: "30000" }),
  balanceRow("2024", "2024", { cuenta: "1290000", titulo: "Resultado del ejercicio", aperturaHaber: "20000", acreedor: "20000" }),
  balanceRow("2024", "2024", { cuenta: "7050001", titulo: "Alojamiento", delegacion: "HA", haber: "100000", acreedor: "100000" }),
  balanceRow("2024", "2024", { cuenta: "4770010", titulo: "IVA repercutido 10", haber: "10000", acreedor: "10000" }),
  balanceRow("2024", "2024", { cuenta: "4300000123", titulo: "Clientes", debe: "110000", haber: "110000" }),
  balanceRow("2024", "2024", { cuenta: "6280001", titulo: "Electricidad", delegacion: "HA", debe: "40000", deudor: "40000" }),
  balanceRow("2024", "2024", { cuenta: "4720021", titulo: "IVA soportado 21", debe: "8400", deudor: "8400" }),
  balanceRow("2024", "2024", { cuenta: "4000000042", titulo: "Proveedores", debe: "48400", haber: "48400" })
]);

const VAT_HEADER = "libro;empresa;ejercicio;fecha;fecha_operacion;serie;numero;nif;nombre;pais;base;tipo_iva;cuota;total;tipo_recargo;cuota_recargo;tipo_retencion;retencion;tipo_factura;rectificativa";
const VAT_CSV = csv(VAT_HEADER, [
  ["emitidas", "1", "2026", "2026-09-04", "", "FAC-2026", "000015", NIF_VIAJES, "Viajes Cantábrico SL", "ES", es(1000), "10", es(100), es(1100), "", "", "", "", "F1", "no"],
  ["emitidas", "1", "2026", "2026-09-10", "", "FAC-2026", "000016", NIF_VIAJES, "Viajes Cantábrico SL", "ES", es(500), "10", es(50), es(550), "", "", "", "", "F1", "no"],
  ["recibidas", "1", "2026", "2026-09-03", "", "F", "778", NIF_SUMINISTROS, "Suministros Eléctricos del Noroeste SL", "ES", es(250), "21", es(52.5), es(302.5), "", "", "", "", "F1", "no"]
]);

const THIRD_PARTIES_CSV = csv("codigo;rol;cuenta;nif;pais;nombre", [
  ["123", "customer", "4300000123", NIF_VIAJES, "ES", "Viajes Cantábrico SL"],
  ["42", "supplier", "4000000042", NIF_SUMINISTROS, "ES", "Suministros Eléctricos del Noroeste SL"]
]);

// ---------------------------------------------------------------------------
// Invariantes de Faranda / org_123 y limpieza
// ---------------------------------------------------------------------------

type Invariants = { entries: number; lines: number; invoices: number; verifactu: number; suppliers: number; vatSettings: number; fiscalYears: number; org123Entries: number };

async function invariants(): Promise<Invariants> {
  const [row] = await prisma.$queryRaw<Array<Record<string, bigint>>>`
    SELECT
      (SELECT count(*) FROM journal_entries WHERE organization_id = ${FARANDA}) AS entries,
      (SELECT count(*) FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journal_entry_id WHERE je.organization_id = ${FARANDA}) AS lines,
      (SELECT count(*) FROM invoices i JOIN properties p ON p.id = i.property_id WHERE p.organization_id = ${FARANDA}) AS invoices,
      (SELECT count(*) FROM verifactu_submissions vs JOIN invoices i ON i.id = vs.invoice_id JOIN properties p ON p.id = i.property_id WHERE p.organization_id = ${FARANDA}) AS verifactu,
      (SELECT count(*) FROM suppliers WHERE organization_id = ${FARANDA}) AS suppliers,
      (SELECT count(*) FROM vat_settings WHERE organization_id = ${FARANDA}) AS vat_settings,
      (SELECT count(*) FROM fiscal_years WHERE organization_id = ${FARANDA}) AS fiscal_years,
      (SELECT count(*) FROM journal_entries WHERE organization_id = 'org_123') AS org123_entries`;
  return {
    entries: Number(row!.entries),
    lines: Number(row!.lines),
    invoices: Number(row!.invoices),
    verifactu: Number(row!.verifactu),
    suppliers: Number(row!.suppliers),
    vatSettings: Number(row!.vat_settings),
    fiscalYears: Number(row!.fiscal_years),
    org123Entries: Number(row!.org123_entries)
  };
}

async function cleanup(): Promise<void> {
  await prisma.ledgerReconciliation.deleteMany({ where: { organizationId: ORG } });
  await prisma.ledgerImportBalance.deleteMany({ where: { organizationId: ORG } });
  await prisma.ledgerImportEntry.deleteMany({ where: { organizationId: ORG } });
  await prisma.ledgerImport.deleteMany({ where: { organizationId: ORG } });
  await prisma.ledgerAccountMap.deleteMany({ where: { organizationId: ORG } });
  await prisma.ledgerAnalyticsMap.deleteMany({ where: { organizationId: ORG } });
  await prisma.ledgerThirdParty.deleteMany({ where: { organizationId: ORG } });
  await prisma.vatBookEntry.deleteMany({ where: { organizationId: ORG } });
  await prisma.vatSettings.deleteMany({ where: { organizationId: ORG } });
  await prisma.supplier.deleteMany({ where: { organizationId: ORG } });
  await prisma.costCenter.deleteMany({ where: { propertyId: { in: [HA, HB, OC] } } });
  const entries = await prisma.journalEntry.findMany({ where: { organizationId: ORG }, select: { id: true } });
  if (entries.length) await prisma.journalLine.deleteMany({ where: { journalEntryId: { in: entries.map((e) => e.id) } } });
  await prisma.journalEntry.deleteMany({ where: { organizationId: ORG } });
  await prisma.fiscalPeriod.deleteMany({ where: { organizationId: ORG } });
  await prisma.fiscalYear.deleteMany({ where: { organizationId: ORG } });
  await prisma.invoice.deleteMany({ where: { propertyId: { in: [HA, HB, OC] } } });
  await prisma.account.deleteMany({ where: { organizationId: ORG } });
  await prisma.accountingSetting.deleteMany({ where: { organizationId: ORG } });
  await prisma.property.deleteMany({ where: { organizationId: ORG } });
  await prisma.legalEntity.deleteMany({ where: { organizationId: ORG } });
  await prisma.organization.deleteMany({ where: { id: ORG } });
}

let invariantsBefore: Invariants;
let nativeInvoiceId = "";
let nativeEntryId = "";

before(async () => {
  invariantsBefore = await invariants();
  await prisma.organization.create({ data: { id: ORG, name: "LI Sociedad Test", country: "ES" } });
  await prisma.legalEntity.create({ data: { id: ENTITY, organizationId: ORG, code: "LIT", legalName: "Hoteles del Cantábrico Norte Test SA", taxId: TAX_ID, legalForm: "sa", fiscalAddress: "Calle Prueba 7", fiscalMunicipality: "Gijón", fiscalProvince: "Asturias", isDefault: true, status: "active" } });
  await prisma.property.create({ data: { id: HA, organizationId: ORG, legalEntityId: ENTITY, kind: "hotel", code: "HA", name: "Hotel Alfa", createdAt: new Date("2026-01-01T00:00:00Z") } });
  await prisma.property.create({ data: { id: HB, organizationId: ORG, legalEntityId: ENTITY, kind: "hotel", code: "HB", name: "Hotel Beta", createdAt: new Date("2026-01-02T00:00:00Z") } });
  await prisma.property.create({ data: { id: OC, organizationId: ORG, legalEntityId: ENTITY, kind: "office", code: "OC", name: "Oficina central LI", createdAt: new Date("2026-01-03T00:00:00Z") } });
  await provisionOrganizationChart(ORG);
  // Factura propia de Anfitorio en HA (modo sombra): Sage también la registra (asiento 1502) y el lote debe excluirla.
  const invoice = await prisma.invoice.create({ data: { propertyId: HA, invoiceNumber: "FAC-2026-000015", seriesCode: "FAC-2026", invoiceType: "F1", customerType: "company", customerTaxId: NIF_VIAJES, customerName: "Viajes Cantábrico SL", status: "issued", issuedAt: new Date("2026-09-04T10:00:00Z"), total: "1100.00", taxTotal: "100.00" } });
  nativeInvoiceId = invoice.id;
  const native = await accounting.postJournalEntry({
    organizationId: ORG,
    propertyId: HA,
    entryDate: "2026-09-04",
    sourceType: "invoice",
    sourceId: invoice.id,
    description: "Factura FAC-2026-000015",
    reference: "FAC-2026-000015",
    lines: [
      { accountCode: "4300", debit: "1100.00" },
      { accountCode: "705.1", credit: "1000.00", taxRateCode: "10" },
      { accountCode: "477.10", credit: "100.00", taxRateCode: "10", taxBase: "1000.00" }
    ],
    createdBy: USER
  });
  nativeEntryId = native.id;
});

after(async () => {
  try {
    await flushAuditQueues();
    await flushAccountingProjection();
    await flushExtraProjections();
    await cleanup();
    const invariantsAfter = await invariants();
    // Faranda: idéntica antes y después. org_123 solo se registra: las suites hermanas de integración
    // (financial-statements, fiscal-models…) escriben en org_123 dentro de la misma ejecución paralela.
    const { org123Entries: org123Before, ...farandaBefore } = invariantsBefore;
    const { org123Entries: org123After, ...farandaAfter } = invariantsAfter;
    assert.deepEqual(farandaAfter, farandaBefore, `Faranda intacta: ${JSON.stringify(farandaBefore)} → ${JSON.stringify(farandaAfter)}`);
    console.log(`Faranda después: ${farandaAfter.entries} asientos / ${farandaAfter.lines} líneas / ${farandaAfter.invoices} facturas / ${farandaAfter.verifactu} verifactu / ${farandaAfter.suppliers} suppliers / ${farandaAfter.vatSettings} vat_settings / ${farandaAfter.fiscalYears} fiscal_years · org_123 asientos ${org123Before} → ${org123After} (suites hermanas)`);
  } finally {
    await prisma.$disconnect();
  }
});

describe("importación desde Sage 200 · organización aislada (sociedad + HA + HB + OC)", () => {
  let importPlan = "";
  let importSept = "";
  let importSeptB = "";
  let hashSept = "";
  let importVat = "";
  let importBalances = "";
  let fiscalYear2024Id = "";

  it("Faranda tiene las invariantes esperadas al empezar (solo lectura)", () => {
    assert.ok(invariantsBefore.entries >= 0);
    console.log(`Faranda antes: ${invariantsBefore.entries} asientos / ${invariantsBefore.lines} líneas / ${invariantsBefore.invoices} facturas / ${invariantsBefore.verifactu} verifactu / ${invariantsBefore.suppliers} suppliers / ${invariantsBefore.vatSettings} vat_settings / ${invariantsBefore.fiscalYears} fiscal_years`);
  });

  // ---- plan ----------------------------------------------------------------

  it("plan · preview no escribe; create crea 623.2 (padre 623, expense, USALI admin_general.other_expense) sin renombrar nada y persiste el mapa y los terceros", async () => {
    const preview = await ledgerImport.previewLedgerImport({ context, body: { kind: "plan", content: PLAN_CSV, fileName: "plan-cuentas.csv" } });
    assert.equal(preview.format, "canonical_csv");
    assert.equal(preview.rowCount, 13);
    assert.equal(preview.entryCount, 1, "solo 623.2 es alta");
    assert.deepEqual(preview.unmappedAccounts.map((row) => row.sourceAccount), ["9990000001"]);
    assert.equal(preview.canPost, true);
    assert.equal(await prisma.ledgerImport.count({ where: { organizationId: ORG } }), 0, "la preview nunca escribe");
    assert.equal(await prisma.account.count({ where: { organizationId: ORG, code: "623.2" } }), 0);
    const accountsBefore = await prisma.account.count({ where: { organizationId: ORG } });

    const result = await ledgerImport.createLedgerImport({ context, body: { kind: "plan", content: PLAN_CSV, fileName: "plan-cuentas.csv" }, correlationId: CORR });
    importPlan = result.import.id;
    assert.equal(result.import.status, "posted");
    assert.equal(result.import.kind, "plan");
    assert.equal(result.created, 1);
    assert.equal(await prisma.account.count({ where: { organizationId: ORG } }), accountsBefore + 1);
    const created = await prisma.account.findUnique({ where: { organizationId_code: { organizationId: ORG, code: "623.2" } } });
    const parent = await prisma.account.findUnique({ where: { organizationId_code: { organizationId: ORG, code: "623" } }, select: { id: true, name: true } });
    assert.ok(created && parent);
    assert.deepEqual({ name: created.name, kind: String(created.kind), parentId: created.parentId, isPostable: created.isPostable, group: created.group, level: created.level, usaliDepartment: created.usaliDepartment, usaliLine: created.usaliLine }, { name: "Asesoría fiscal", kind: "expense", parentId: parent.id, isPostable: true, group: 6, level: 4, usaliDepartment: "admin_general", usaliLine: "other_expense" });
    assert.equal(parent.name, "Servicios de profesionales independientes", "el padre no se renombra");
    const map = await ledgerImport.getAccountMap({ context: reader });
    const byAccount = new Map(map.entries.map((entry) => [entry.sourceAccount, entry]));
    assert.equal(map.entries.length, 13);
    assert.deepEqual([byAccount.get("6230002")?.action, byAccount.get("6230002")?.accountCode], ["create", "623.2"]);
    assert.deepEqual([byAccount.get("6280001")?.action, byAccount.get("6280001")?.accountCode], ["map", "628.1"]);
    assert.deepEqual([byAccount.get("4300000123")?.action, byAccount.get("4300000123")?.accountCode, byAccount.get("4300000123")?.carryCounterparty], ["collapse", "4300", true]);
    assert.deepEqual([byAccount.get("4100000007")?.action, byAccount.get("4100000007")?.accountCode], ["collapse", "410"]);
    assert.deepEqual([byAccount.get("4770010")?.action, byAccount.get("4770010")?.accountCode], ["map", "477.10"]);
    assert.deepEqual([byAccount.get("1000000")?.action, byAccount.get("1000000")?.accountCode], ["map", "100"]);
    assert.deepEqual([byAccount.get("9990000001")?.action, byAccount.get("9990000001")?.accountCode], ["block", null]);
    const parties = await prisma.ledgerThirdParty.findMany({ where: { organizationId: ORG }, orderBy: { sourceCode: "asc" } });
    assert.deepEqual(parties.map((party) => [party.role, party.sourceCode, party.taxId]), [["supplier", "4000000042", NIF_SUMINISTROS], ["supplier", "4100000007", NIF_LAVANDERIA], ["customer", "4300000123", NIF_VIAJES]]);
  });

  it("plan · segunda pasada del mismo fichero: los maestros son idempotentes (aviso de duplicado, 623.2 skipped_existing, ningún alta); nombre distinto → 409 ACCOUNT_CODE_EXISTS", async () => {
    const accountsBefore = await prisma.account.count({ where: { organizationId: ORG } });
    const preview = await ledgerImport.previewLedgerImport({ context, body: { kind: "plan", content: PLAN_CSV } });
    assert.equal(preview.duplicateOf?.importId, importPlan);
    assert.equal(preview.canPost, true, "duplicado en un maestro no bloquea");
    assert.equal(preview.entryCount, 0);
    const again = await ledgerImport.createLedgerImport({ context, body: { kind: "plan", content: PLAN_CSV }, correlationId: CORR });
    assert.equal(again.created, 0);
    assert.equal(await prisma.account.count({ where: { organizationId: ORG } }), accountsBefore);
    assert.equal(again.entries.find((entry) => entry.sourceEntryNumber === "6230002")?.status, "skipped_existing");
    const details = await expectCode(ledgerImport.createLedgerImport({ context, body: { kind: "plan", content: PLAN_RENAMED_CSV }, correlationId: CORR }), 409, "ACCOUNT_CODE_EXISTS");
    assert.deepEqual(details.accounts, ["623.2"]);
    assert.equal((await prisma.account.findUnique({ where: { organizationId_code: { organizationId: ORG, code: "623.2" } } }))?.name, "Asesoría fiscal", "nunca renombra");
  });

  // ---- mapa analítico ------------------------------------------------------

  it("mapa analítico · PUT valida y persiste (dimensiones, política, centros y centros de coste USALI); GET lo devuelve", async () => {
    await expectCode(ledgerImport.putAnalyticsMap({ context, body: { centreDimension: "delegacion", costCentreDimension: "departamento", unassignedPolicy: "block", entries: [{ dimension: "delegacion", sourceCode: "ZZ", propertyId: "prop_otra_org", costCentreCode: null }] }, correlationId: CORR }), 400, "LEDGER_IMPORT_MAP_INVALID");
    const saved = await ledgerImport.putAnalyticsMap({
      context,
      body: {
        centreDimension: "delegacion",
        costCentreDimension: "departamento",
        unassignedPolicy: "block",
        entries: [
          { dimension: "delegacion", sourceCode: "HA", sourceName: "Hotel Alfa", propertyId: HA, costCentreCode: null },
          { dimension: "delegacion", sourceCode: "HB", sourceName: "Hotel Beta", propertyId: HB, costCentreCode: null },
          { dimension: "delegacion", sourceCode: "OC", sourceName: "Oficina", propertyId: OC, costCentreCode: null },
          { dimension: "departamento", sourceCode: "HAB", propertyId: null, costCentreCode: "ROOMS" },
          { dimension: "departamento", sourceCode: "ADM", propertyId: null, costCentreCode: "ADMIN_GENERAL" },
          { dimension: "departamento", sourceCode: "MANT", propertyId: null, costCentreCode: "POM" }
        ]
      },
      correlationId: CORR
    });
    assert.deepEqual([saved.centreDimension, saved.costCentreDimension, saved.unassignedPolicy, saved.entries.length], ["delegacion", "departamento", "block", 6]);
    const fetched = await ledgerImport.getAnalyticsMap({ context: reader });
    assert.deepEqual(fetched, saved);
  });

  // ---- journal septiembre 2026 --------------------------------------------

  it("journal · preview: 5 asientos planificados, 1502 excluido por la factura propia, reparto 1503 por centro, aviso de asientos nativos, nada escrito", async () => {
    const preview = await ledgerImport.previewLedgerImport({ context, body: { kind: "journal", content: JOURNAL_SEPT_CSV, fileName: "diario-2026-09.csv" } });
    hashSept = preview.contentHash;
    assert.match(hashSept, /^[0-9a-f]{64}$/);
    assert.deepEqual([preview.fiscalYearCode, preview.periodFrom, preview.periodTo, preview.rowCount, preview.entryCount], ["2026", "2026-09", "2026-09", 14, 5]);
    assert.deepEqual(preview.nativeSkipped.map((row) => [row.sourceEntryNumber, row.invoiceNumber, row.sourceType, row.sourceId]), [["1502", "FAC-2026-000015", "invoice", nativeInvoiceId]]);
    assert.deepEqual(preview.unmappedAccounts, []);
    assert.deepEqual(preview.unmappedAnalytics, []);
    assert.deepEqual(preview.centreRequired, []);
    assert.deepEqual(preview.byMonth, [{ periodCode: "2026-09", entries: 5, lines: 13, debit: "1289.00", credit: "1289.00" }]);
    assert.deepEqual(preview.byProperty.map((row) => [row.propertyCode, row.entries]), [["HA", 3], ["HB", 1], ["OC", 1]]);
    assert.equal(preview.existingNativeEntries, 1, "la factura propia ya numera el ejercicio 2026");
    assert.deepEqual(preview.existing, []);
    assert.equal(preview.duplicateOf, null);
    assert.deepEqual(preview.overlaps, []);
    assert.ok(preview.warnings.some((warning) => warning.includes("Modo sombra")));
    assert.equal(preview.canPost, true);
    assert.deepEqual(preview.blockers, []);
    assert.equal(await prisma.ledgerImport.count({ where: { organizationId: ORG, kind: "journal" } }), 0);
  });

  it("journal · create → 5 asientos numerados en orden de fecha (tras la factura propia), reference Sage, sourceId con periodo y centro, costCenterId usali, reparto con Σ exacta, fila skipped_native", async () => {
    const result = await ledgerImport.createLedgerImport({ context, body: { kind: "journal", content: JOURNAL_SEPT_CSV, fileName: "diario-2026-09.csv", notes: "septiembre" }, correlationId: CORR });
    importSept = result.import.id;
    assert.deepEqual([result.import.status, result.import.kind, result.import.contentHash, result.import.entryCount, result.import.skippedCount, result.created, result.skipped], ["posted", "journal", hashSept, 5, 1, 5, 1]);
    assert.deepEqual([result.import.totalDebit, result.import.totalCredit], ["1289.00", "1289.00"]);
    assert.equal(result.import.journalEntryIds.length, 5);
    assert.equal(result.reconciliation, null);
    const rows = await prisma.ledgerImport.findUnique({ where: { id: importSept } });
    assert.equal(rows?.legalEntityId, ENTITY, "la sociedad sale de resolveLedgerScope");
    const posted = result.entries.filter((entry) => entry.status === "posted");
    assert.deepEqual(posted.map((entry) => [entry.sourceEntryNumber, entry.propertyCode, entry.entryNumber, entry.fiscalYearCode]), [["1501", "HA", 2, "2026"], ["1503", "HA", 3, "2026"], ["1503", "HB", 4, "2026"], ["1504", "OC", 5, "2026"], ["1505", "HA", 6, "2026"]]);
    assert.deepEqual(posted.map((entry) => entry.sourceId), ["1:2026:9:1501", "1:2026:9:1503:HA", "1:2026:9:1503:HB", "1:2026:9:1504", "1:2026:9:1505"]);
    assert.deepEqual(result.entries.find((entry) => entry.sourceEntryNumber === "1502")?.status, "skipped_native");
    const nativeRow = result.entries.find((entry) => entry.sourceEntryNumber === "1502");
    assert.deepEqual([nativeRow?.sourceType, nativeRow?.sourceId, nativeRow?.lineCount], ["invoice", nativeInvoiceId, 3]);

    const entry1501 = await prisma.journalEntry.findUnique({ where: { id: posted[0]!.journalEntryId! } });
    assert.deepEqual([entry1501?.sourceType, entry1501?.reference, entry1501?.propertyId, entry1501?.entryKind, entry1501?.status, entry1501?.createdBy], ["sage200_journal", "Sage 200 · asiento 2026/1501 · periodo 9 · diario 0", HA, "normal", "posted", USER]);
    const lines1501 = await prisma.journalLine.findMany({ where: { journalEntryId: entry1501!.id }, orderBy: { accountCode: "asc" } });
    assert.deepEqual(lines1501.map((line) => [line.accountCode, line.debit.toFixed(2), line.credit.toFixed(2), line.taxRateCode]), [["400", "0.00", "302.50", null], ["472.21", "52.50", "0.00", "21"], ["628.1", "250.00", "0.00", null]]);
    const costLine = lines1501.find((line) => line.accountCode === "628.1");
    assert.ok(costLine?.costCenterId, "la línea 6/7 lleva centro de coste");
    const centre = await prisma.costCenter.findUnique({ where: { id: costLine!.costCenterId! } });
    assert.deepEqual([centre?.propertyId, centre?.code, centre?.type, centre?.active], [HA, "POM", "usali", true]);
    assert.equal(lines1501.find((line) => line.accountCode === "400")?.costCenterId, null, "las líneas de balance no llevan centro de coste");
    assert.match(lines1501.find((line) => line.accountCode === "400")?.description ?? "", /^Sage 4000000042 · A\d{8} · SUMINISTROS/, "collapse con carryCounterparty");

    const partHA = await prisma.journalLine.findMany({ where: { journalEntryId: posted[1]!.journalEntryId! }, orderBy: { accountCode: "asc" } });
    const partHB = await prisma.journalLine.findMany({ where: { journalEntryId: posted[2]!.journalEntryId! }, orderBy: { accountCode: "asc" } });
    assert.deepEqual(partHA.map((line) => [line.accountCode, line.debit.toFixed(2), line.credit.toFixed(2)]), [["410", "0.00", "363.00"], ["472.21", "63.00", "0.00"], ["629.2", "300.00", "0.00"]]);
    assert.deepEqual(partHB.map((line) => [line.accountCode, line.debit.toFixed(2), line.credit.toFixed(2)]), [["410", "0.00", "121.00"], ["472.21", "21.00", "0.00"], ["629.2", "100.00", "0.00"]]);
    const dates = await prisma.journalEntry.findMany({ where: { id: { in: posted.map((entry) => entry.journalEntryId!) } }, orderBy: { entryNumber: "asc" }, select: { entryNumber: true, entryDate: true } });
    for (let i = 1; i < dates.length; i++) assert.ok(dates[i]!.entryDate >= dates[i - 1]!.entryDate, "numeración cronológica");
    assert.equal(await prisma.costCenter.count({ where: { propertyId: { in: [HA, HB, OC] }, type: "usali" } }), 4, "POM/HA · ADMIN_GENERAL/HA · ADMIN_GENERAL/HB · ADMIN_GENERAL/OC");
  });

  it("journal · mismo fichero → 409 LEDGER_IMPORT_DUPLICATE; fichero con asientos nuevos → 409 LEDGER_IMPORT_OVERLAP { overlaps }; replace revierte ENTERO el lote anterior y contabiliza con clave #1", async () => {
    const duplicate = await expectCode(ledgerImport.createLedgerImport({ context, body: { kind: "journal", content: JOURNAL_SEPT_CSV }, correlationId: CORR }), 409, "LEDGER_IMPORT_DUPLICATE");
    assert.equal(duplicate.importId, importSept);
    const preview = await ledgerImport.previewLedgerImport({ context, body: { kind: "journal", content: JOURNAL_SEPT_B_CSV } });
    assert.deepEqual(preview.overlaps, [{ importId: importSept, status: "posted", periodFrom: "2026-09", periodTo: "2026-09", entries: 4 }]);
    assert.equal(preview.canPost, false);
    assert.ok(preview.blockers.some((blocker) => blocker.includes("sustituir")));
    const overlap = await expectCode(ledgerImport.createLedgerImport({ context, body: { kind: "journal", content: JOURNAL_SEPT_B_CSV }, correlationId: CORR }), 409, "LEDGER_IMPORT_OVERLAP");
    assert.equal((overlap.overlaps as Array<{ importId: string }>)[0]?.importId, importSept);
    assert.equal(await prisma.ledgerImport.count({ where: { organizationId: ORG, kind: "journal" } }), 1, "nada escrito");

    const replaced = await ledgerImport.createLedgerImport({ context, body: { kind: "journal", content: JOURNAL_SEPT_B_CSV, fileName: "diario-2026-09-b.csv", options: { replace: true } }, correlationId: CORR });
    importSeptB = replaced.import.id;
    assert.deepEqual([replaced.import.status, replaced.created, replaced.skipped], ["posted", 6, 1]);
    const previous = await prisma.ledgerImport.findUnique({ where: { id: importSept } });
    assert.deepEqual([previous?.status, previous?.replacedById, previous?.reversalJournalEntryIds.length], ["reversed", importSeptB, 5]);
    const reversedOriginals = await prisma.journalEntry.findMany({ where: { id: { in: previous!.journalEntryIds } }, select: { status: true, reversedById: true } });
    assert.ok(reversedOriginals.every((row) => row.status === "reversed" && row.reversedById));
    const reversals = await prisma.journalEntry.findMany({ where: { id: { in: previous!.reversalJournalEntryIds } }, select: { sourceType: true, sourceId: true, entryKind: true } });
    assert.ok(reversals.every((row) => row.sourceType === "reversal" && row.entryKind === "reversal" && row.sourceId?.startsWith(`ledger-import-reverse:${importSept}:`)));
    const postedB = replaced.entries.filter((entry) => entry.status === "posted");
    assert.deepEqual(postedB.map((entry) => entry.sourceId), ["1:2026:9:1501#1", "1:2026:9:1503:HA#1", "1:2026:9:1503:HB#1", "1:2026:9:1504#1", "1:2026:9:1505#1", "1:2026:9:1506"]);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG, sourceType: "sage200_journal", status: "posted" } }), 6);
  });

  // ---- reconciliación ------------------------------------------------------

  it("reconciliación · consolidado ok frente al balance Sage de septiembre (incluida la factura propia que Sage también registra)", async () => {
    const result = await reconciliation.reconcileLedger({ context, body: { from: "2026-09-01", to: "2026-09-30", content: BALANCE_SEPT_CSV, importId: importSeptB }, correlationId: CORR });
    assert.equal(result.status, "ok", JSON.stringify(result.rows.filter((row) => !row.ok)));
    assert.deepEqual([result.propertyCode, result.importId, result.accountsCompared, result.differenceCount], ["SOC", importSeptB, 10, 0]);
    assert.equal(result.summary.tolerance, "0.00");
    assert.match(result.summary.criterion, /regularization \/ closing \/ opening/);
    const bank = result.rows.find((row) => row.accountCode === "572");
    assert.deepEqual([bank?.sourceAccounts, bank?.sourceCredit, bank?.ledgerCredit, bank?.sourceBalance, bank?.ledgerBalance, bank?.ok], [["5720000"], "582.50", "582.50", "-582.50", "-582.50", true]);
    const customers = result.rows.find((row) => row.accountCode === "4300");
    assert.deepEqual([customers?.sourceDebit, customers?.ledgerDebit, customers?.ok], ["1100.00", "1100.00", true]);
    assert.deepEqual(result.missingEntries.map((entry) => [entry.sourceEntryNumber, entry.status]), [["1502", "skipped_native"]]);
    const stored = await reconciliation.getReconciliation({ context: reader, reconciliationId: result.id });
    assert.equal(stored.status, "ok");
  });

  it("reconciliación · differences: asiento nativo extra → native_only (629.9) y amount_diff (572); cuenta Sage sin mapear → missing_in_ledger; CSV con BOM y «;»", async () => {
    await accounting.postJournalEntry({ organizationId: ORG, propertyId: HA, entryDate: "2026-09-20", sourceType: "manual", sourceId: `manual-li-${RUN}`, description: "Ajuste manual", lines: [{ accountCode: "629.9", debit: "100.00" }, { accountCode: "572", credit: "100.00" }], createdBy: USER });
    const result = await reconciliation.reconcileLedger({ context, body: { from: "2026-09-01", to: "2026-09-30", content: BALANCE_SEPT_DIFF_CSV, importId: importSeptB }, correlationId: CORR });
    assert.equal(result.status, "differences");
    const byAccount = new Map(result.rows.map((row) => [row.accountCode, row]));
    assert.equal(byAccount.get("629.9")?.classification, "native_only");
    assert.match(byAccount.get("629.9")?.note ?? "", /manual/);
    assert.deepEqual([byAccount.get("572")?.classification, byAccount.get("572")?.diffCredit], ["amount_diff", "100.00"]);
    assert.equal(byAccount.get("9990000001")?.classification, "missing_in_ledger");
    assert.deepEqual({ nativeOnly: result.summary.nativeOnly, amountDiff: result.summary.amountDiff, missingInLedger: result.summary.missingInLedger }, { nativeOnly: 1, amountDiff: 1, missingInLedger: 1 });
    assert.equal(result.differenceCount, 3);
    assert.deepEqual(result.missingEntries.map((entry) => entry.status), ["skipped_native"], "se lista pero no cuenta como diferencia");
    const list = await reconciliation.listReconciliations({ context: reader, query: { from: "2026-09-01", to: "2026-09-30" } });
    assert.deepEqual(list.map((row) => row.status), ["differences", "ok"]);
    const file = await reconciliation.reconciliationCsv({ context: reader, reconciliationId: result.id });
    assert.equal(file.fileName, "reconciliacion-sage200-2026-09-01-2026-09-30.csv");
    assert.ok(file.content.startsWith("\uFEFFcuenta;nombre;"));
    assert.ok(file.content.includes("572;"));
    assert.ok(file.content.includes("100,00"));
    await expectCode(reconciliation.getReconciliation({ context: { ...reader, organizationId: "org_123" } as UserContext, reconciliationId: result.id }), 404, "LEDGER_RECONCILIATION_NOT_FOUND");
  });

  // ---- reverso ---------------------------------------------------------------

  it("reverso · con el asiento original en un mes cerrado → 409 FISCAL_PERIOD_CLOSED y rollback (lote posted, 0 reversos); tras reabrir → reversed; segundo reverso idempotente", async () => {
    const lot = await ledgerImport.createLedgerImport({ context, body: { kind: "journal", content: JOURNAL_OCT_CSV, fileName: "diario-2026-10.csv" }, correlationId: CORR });
    assert.equal(lot.created, 1);
    const period = await fiscalPeriods.openFiscalPeriod({ context, periodCode: "2026-10", periodType: "month", startDate: "2026-10-01", endDate: "2026-10-31", correlationId: CORR });
    await fiscalPeriods.closeFiscalPeriod({ context, periodId: period.id, correlationId: CORR });
    const details = await expectCode(ledgerImport.reverseLedgerImport({ context, importId: lot.import.id, reason: "prueba de periodo cerrado", correlationId: CORR }), 409, "FISCAL_PERIOD_CLOSED");
    assert.equal(details.periodCode, "2026-10");
    assert.equal(details.journalEntryId, lot.import.journalEntryIds[0]);
    const still = await prisma.ledgerImport.findUnique({ where: { id: lot.import.id } });
    assert.deepEqual([still?.status, still?.reversalJournalEntryIds], ["posted", []]);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG, sourceType: "reversal", sourceId: { startsWith: `ledger-import-reverse:${lot.import.id}:` } } }), 0, "rollback: ningún reverso");
    await fiscalPeriods.reopenFiscalPeriod({ context, periodId: period.id, reason: "prueba", correlationId: CORR });
    const reversed = await ledgerImport.reverseLedgerImport({ context, importId: lot.import.id, reason: "corrección del diario de octubre", correlationId: CORR });
    assert.deepEqual([reversed.status, reversed.alreadyReversed, reversed.reversalJournalEntryIds.length, reversed.reversalReason], ["reversed", false, 1, "corrección del diario de octubre"]);
    const again = await ledgerImport.reverseLedgerImport({ context, importId: lot.import.id, reason: "otra vez", correlationId: CORR });
    assert.deepEqual([again.alreadyReversed, again.reversalJournalEntryIds], [true, reversed.reversalJournalEntryIds]);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG, sourceType: "reversal", sourceId: { startsWith: `ledger-import-reverse:${lot.import.id}:` } } }), 1);
    await expectCode(ledgerImport.reverseLedgerImport({ context, importId: `imp_no_${RUN}`, reason: "x", correlationId: CORR }), 404, "LEDGER_IMPORT_NOT_FOUND");
  });

  it("create · periodo cerrado → 409 FISCAL_PERIOD_CLOSED y NINGUNA fila del lote (rollback)", async () => {
    const period = await fiscalPeriods.openFiscalPeriod({ context, periodCode: "2026-11", periodType: "month", startDate: "2026-11-01", endDate: "2026-11-30", correlationId: CORR });
    await fiscalPeriods.closeFiscalPeriod({ context, periodId: period.id, correlationId: CORR });
    const preview = await ledgerImport.previewLedgerImport({ context, body: { kind: "journal", content: JOURNAL_NOV_CSV } });
    assert.equal(preview.canPost, true, "la preview no comprueba periodos cerrados: lo hace el motor al contabilizar");
    await expectCode(ledgerImport.createLedgerImport({ context, body: { kind: "journal", content: JOURNAL_NOV_CSV }, correlationId: CORR }), 409, "FISCAL_PERIOD_CLOSED");
    assert.equal(await prisma.ledgerImport.count({ where: { organizationId: ORG, contentHash: preview.contentHash } }), 0);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG, entryDate: { gte: new Date("2026-11-01T00:00:00Z") } } }), 0);
    assert.equal(await prisma.ledgerImportEntry.count({ where: { organizationId: ORG, sourceEntryNumber: "1701" } }), 0);
  });

  // ---- vat_books ---------------------------------------------------------------

  it("vat_books · sin fila vat_settings → preview vatSettingsMissing y 409 LEDGER_IMPORT_VAT_SETTINGS_MISSING (la fila nunca se crea); con fila → filas sage200 y rebuildVatBooks las conserva", async () => {
    assert.equal(await prisma.vatSettings.count({ where: { organizationId: ORG } }), 0);
    const preview = await ledgerImport.previewLedgerImport({ context, body: { kind: "vat_books", content: VAT_CSV } });
    // C1 (modo sombra): FAC-2026-000015 es la factura propia de la organización: su fila del libro de Sage se omite (2 filas de 3).
    assert.deepEqual([preview.vatSettingsMissing, preview.canPost, preview.entryCount, preview.periodFrom, preview.periodTo], [true, false, 2, "2026-09", "2026-09"]);
    assert.deepEqual(preview.nativeSkipped.map((row) => [row.sourceChannel, row.sourceEntryNumber, row.invoiceNumber, row.sourceType, row.sourceId]), [["emitidas", "000015", "FAC-2026-000015", "invoice", nativeInvoiceId]]);
    await expectCode(ledgerImport.createLedgerImport({ context, body: { kind: "vat_books", content: VAT_CSV }, correlationId: CORR }), 409, "LEDGER_IMPORT_VAT_SETTINGS_MISSING");
    assert.equal(await prisma.vatSettings.count({ where: { organizationId: ORG } }), 0, "el importador nunca crea vat_settings");
    assert.equal(await prisma.vatBookEntry.count({ where: { organizationId: ORG } }), 0);
    assert.equal(await prisma.ledgerImport.count({ where: { organizationId: ORG, kind: "vat_books" } }), 0);

    await prisma.vatSettings.create({ data: { organizationId: ORG } });
    const result = await ledgerImport.createLedgerImport({ context, body: { kind: "vat_books", content: VAT_CSV, fileName: "libro-iva-2026-3T.csv" }, correlationId: CORR });
    importVat = result.import.id;
    assert.deepEqual([result.import.status, result.created, result.skipped], ["posted", 2, 1]);
    assert.deepEqual(result.entries.filter((entry) => entry.status === "skipped_native").map((entry) => [entry.sourceChannel, entry.sourceType, entry.sourceId]), [["emitidas", "invoice", nativeInvoiceId]]);
    const rows = await prisma.vatBookEntry.findMany({ where: { organizationId: ORG, sourceType: "sage200" }, orderBy: [{ book: "asc" }, { number: "asc" }] });
    // C6: en recibidas la clave lleva el NIF del proveedor (el número es el suyo, no el nuestro).
    assert.deepEqual(rows.map((row) => [row.book, row.sourceId, row.period, row.rate.toFixed(2), row.total.toFixed(2), row.counterpartyNif]), [
      ["emitidas", "1:2026:FAC-2026:000016", "2026-Q3", "10.00", "550.00", NIF_VIAJES],
      ["recibidas", `1:2026:F:778:${NIF_SUMINISTROS}`, "2026-Q3", "21.00", "302.50", NIF_SUMINISTROS]
    ]);
    const rebuilt = await vatBooks.rebuildVatBooks({ context, from: "2026-07-01", to: "2026-09-30", correlationId: CORR });
    assert.ok(rebuilt);
    assert.equal(await prisma.vatBookEntry.count({ where: { organizationId: ORG, sourceType: "sage200" } }), 2, "rebuildVatBooks conserva las filas importadas");
    // La factura propia queda UNA sola vez en el libro (la fila nativa que materializa el rebuild), nunca como sage200 + invoice.
    assert.equal(await prisma.vatBookEntry.count({ where: { organizationId: ORG, book: "emitidas", number: { endsWith: "000015" }, sourceType: "sage200" } }), 0);
    await expectCode(ledgerImport.createLedgerImport({ context, body: { kind: "vat_books", content: VAT_CSV }, correlationId: CORR }), 409, "LEDGER_IMPORT_DUPLICATE");
    // SD-03: el mismo trimestre corregido (hash distinto, mismas facturas) solapa con el lote vivo → 409 LEDGER_IMPORT_OVERLAP { overlaps };
    // con replace se revierte ENTERO el lote anterior y las filas quedan una sola vez (las del lote nuevo).
    const corrected = VAT_CSV.replace(`${es(500)};10;${es(50)};${es(550)}`, `${es(600)};10;${es(60)};${es(660)}`);
    assert.notEqual(corrected, VAT_CSV);
    const overlap = await expectCode(ledgerImport.createLedgerImport({ context, body: { kind: "vat_books", content: corrected }, correlationId: CORR }), 409, "LEDGER_IMPORT_OVERLAP");
    assert.deepEqual((overlap.overlaps as Array<{ importId: string; entries: number }>).map((row) => [row.importId, row.entries]), [[importVat, 2]]);
    const replaced = await ledgerImport.createLedgerImport({ context, body: { kind: "vat_books", content: corrected, options: { replace: true } }, correlationId: CORR });
    assert.deepEqual([replaced.import.status, replaced.created], ["posted", 2]);
    assert.equal((await prisma.ledgerImport.findUnique({ where: { id: importVat } }))?.status, "reversed");
    const afterReplace = await prisma.vatBookEntry.findMany({ where: { organizationId: ORG, sourceType: "sage200" }, orderBy: [{ book: "asc" }, { number: "asc" }] });
    assert.deepEqual(afterReplace.map((row) => [row.sourceId, row.total.toFixed(2)]), [["1:2026:FAC-2026:000016", "660.00"], [`1:2026:F:778:${NIF_SUMINISTROS}`, "302.50"]]);
    // Revertir el lote antiguo (ya revertido por replace) es idempotente y NO toca las filas del lote nuevo.
    const again = await ledgerImport.reverseLedgerImport({ context, importId: importVat, reason: "ya sustituido", correlationId: CORR });
    assert.equal(again.alreadyReversed, true);
    assert.equal(await prisma.vatBookEntry.count({ where: { organizationId: ORG, sourceType: "sage200" } }), 2);
    importVat = replaced.import.id;
  });

  // ---- third_parties -----------------------------------------------------------

  it("third_parties · sin createSuppliers → 0 suppliers y terceros persistidos; con createSuppliers → 1 supplier; segunda pasada no duplica", async () => {
    const first = await ledgerImport.createLedgerImport({ context, body: { kind: "third_parties", content: THIRD_PARTIES_CSV }, correlationId: CORR });
    assert.deepEqual([first.import.status, first.created], ["posted", 2]);
    assert.equal(await prisma.supplier.count({ where: { organizationId: ORG } }), 0);
    const parties = await prisma.ledgerThirdParty.findMany({ where: { organizationId: ORG, sourceCode: { in: ["123", "42"] } }, orderBy: { sourceCode: "asc" } });
    assert.deepEqual(parties.map((party) => [party.role, party.sourceCode, party.sourceAccount, party.taxId, party.supplierId]), [["customer", "123", "4300000123", NIF_VIAJES, null], ["supplier", "42", "4000000042", NIF_SUMINISTROS, null]]);

    const withSuppliers = await ledgerImport.createLedgerImport({ context, body: { kind: "third_parties", content: THIRD_PARTIES_CSV, options: { createSuppliers: true } }, correlationId: CORR });
    assert.equal(withSuppliers.import.status, "posted");
    const suppliers = await prisma.supplier.findMany({ where: { organizationId: ORG } });
    assert.equal(suppliers.length, 1);
    assert.deepEqual([suppliers[0]?.taxId, suppliers[0]?.name, suppliers[0]?.countryCode, suppliers[0]?.active], [NIF_SUMINISTROS, "Suministros Eléctricos del Noroeste SL", "ES", true]);
    assert.ok(suppliers[0]?.nifValidatedAt);
    const linked = await prisma.ledgerThirdParty.findFirst({ where: { organizationId: ORG, role: "supplier", sourceCode: "42" } });
    assert.equal(linked?.supplierId, suppliers[0]?.id);

    const again = await ledgerImport.createLedgerImport({ context, body: { kind: "third_parties", content: THIRD_PARTIES_CSV, options: { createSuppliers: true } }, correlationId: CORR });
    assert.equal(again.entries.find((entry) => entry.sourceEntryNumber === "42")?.status, "skipped_existing");
    assert.equal(await prisma.supplier.count({ where: { organizationId: ORG } }), 1, "la segunda pasada no duplica");
  });

  // ---- fiscal_years 2025 ----------------------------------------------------------

  it("fiscal_years · crea 2025 (año natural, sociedad) con 12 periodos mensuales y la apertura; repetido idempotente; ejercicio ≠ YYYY → 400 LEDGER_IMPORT_YEAR_CODE_INVALID", async () => {
    // «25» lo rechaza ya el parser de L1 (ejercicio de cuatro cifras); un ejercicio distinto del esperado → LEDGER_IMPORT_YEAR_CODE_INVALID.
    const invalid = await expectCode(ledgerImport.createLedgerImport({ context, body: { kind: "fiscal_years", content: FISCAL_YEARS_BAD_CSV }, correlationId: CORR }), 400, "LEDGER_IMPORT_INVALID");
    assert.ok(JSON.stringify(invalid.errors).includes("cuatro cifras"));
    const details = await expectCode(ledgerImport.createLedgerImport({ context, body: { kind: "fiscal_years", content: FISCAL_YEARS_CSV, options: { fiscalYearCode: "2026" } }, correlationId: CORR }), 400, "LEDGER_IMPORT_YEAR_CODE_INVALID");
    assert.deepEqual([details.code, details.expected], ["LEDGER_IMPORT_YEAR_CODE_INVALID", "2026"]);
    assert.equal(await prisma.fiscalYear.count({ where: { organizationId: ORG } }), 0);

    const result = await ledgerImport.createLedgerImport({ context, body: { kind: "fiscal_years", content: FISCAL_YEARS_CSV, fileName: "apertura-2025.csv" }, correlationId: CORR });
    assert.deepEqual([result.import.status, result.import.fiscalYearCode, result.created, result.skipped], ["posted", "2025", 1, 0]);
    const year = await prisma.fiscalYear.findFirst({ where: { organizationId: ORG, code: "2025" } });
    assert.ok(year);
    assert.deepEqual([year.propertyId, year.status, year.startDate.toISOString().slice(0, 10), year.endDate.toISOString().slice(0, 10)], [null, "open", "2025-01-01", "2025-12-31"]);
    const periods = await prisma.fiscalPeriod.findMany({ where: { organizationId: ORG, periodCode: { startsWith: "2025-" } }, orderBy: { periodCode: "asc" } });
    assert.equal(periods.length, 12);
    assert.ok(periods.every((period) => period.propertyId === null && period.periodType === "month" && period.status === "open"));
    assert.deepEqual([periods[0]?.periodCode, periods[11]?.periodCode, periods[1]?.endDate.toISOString().slice(0, 10)], ["2025-01", "2025-12", "2025-02-28"]);
    const opening = await prisma.journalEntry.findFirst({ where: { organizationId: ORG, sourceType: "sage200_journal", sourceId: "1:2025:0:1" } });
    assert.deepEqual([opening?.entryKind, opening?.propertyId, opening?.fiscalYearId, opening?.fiscalYearCode, opening?.entryNumber], ["opening", null, year.id, "2025", 1]);

    const again = await ledgerImport.createLedgerImport({ context, body: { kind: "fiscal_years", content: FISCAL_YEARS_CSV }, correlationId: CORR });
    assert.deepEqual([again.import.status, again.created, again.skipped, again.entries[0]?.status], ["posted", 0, 1, "skipped_existing"]);
    assert.equal(await prisma.fiscalYear.count({ where: { organizationId: ORG, code: "2025" } }), 1);
    assert.equal(await prisma.fiscalPeriod.count({ where: { organizationId: ORG, periodCode: { startsWith: "2025-" } } }), 12);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG, fiscalYearCode: "2025" } }), 1);
  });

  it("journal 2025 · la apertura ya importada por «ejercicios» queda skipped_existing y el asiento nuevo se contabiliza", async () => {
    const preview = await ledgerImport.previewLedgerImport({ context, body: { kind: "journal", content: JOURNAL_2025_CSV } });
    assert.deepEqual(preview.existing.map((row) => [row.sourceEntryNumber, row.sourcePeriod, row.fiscalYearCode, row.entryNumber]), [["1", "0", "2025", 1]]);
    assert.deepEqual(preview.closingDetected, [{ sourceEntryNumber: "1", sourcePeriod: "0", entryKind: "opening" }]);
    assert.equal(preview.canPost, true);
    const result = await ledgerImport.createLedgerImport({ context, body: { kind: "journal", content: JOURNAL_2025_CSV }, correlationId: CORR });
    assert.deepEqual([result.created, result.skipped], [1, 1]);
    assert.deepEqual(result.entries.map((entry) => [entry.sourceEntryNumber, entry.status, entry.entryNumber]), [["1", "skipped_existing", 1], ["2", "posted", 2]]);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG, fiscalYearCode: "2025" } }), 2);
  });

  // ---- balances 2024 ---------------------------------------------------------

  it("C2 · balances sobre un ejercicio que ya tiene diario o apertura importados (2025) → 409 LEDGER_IMPORT_OVERLAP sin replace posible; preview con canPost false", async () => {
    const balances2025 = csv(BALANCES_HEADER, [balanceRow("2025", "2025", { cuenta: "5720000", titulo: "Bancos", aperturaDebe: "50000", haber: "100", deudor: "49900" }), balanceRow("2025", "2025", { cuenta: "1000000", titulo: "Capital social", aperturaHaber: "30000", acreedor: "30000" }), balanceRow("2025", "2025", { cuenta: "1290000", titulo: "Resultado", aperturaHaber: "20000", acreedor: "20000" }), balanceRow("2025", "2025", { cuenta: "6280001", titulo: "Electricidad", delegacion: "HA", debe: "100", deudor: "100" })]);
    const preview = await ledgerImport.previewLedgerImport({ context, body: { kind: "balances", content: balances2025 } });
    assert.equal(preview.canPost, false);
    assert.ok(preview.blockers.some((blocker) => /ya tiene .* asiento\(s\) importados de diario o apertura/.test(blocker)), preview.blockers.join(" | "));
    const details = await expectCode(ledgerImport.createLedgerImport({ context, body: { kind: "balances", content: balances2025 }, correlationId: CORR }), 409, "LEDGER_IMPORT_OVERLAP");
    assert.equal(details.fiscalYearCode, "2025");
    await expectCode(ledgerImport.createLedgerImport({ context, body: { kind: "balances", content: balances2025, options: { replace: true } }, correlationId: CORR }), 409, "LEDGER_IMPORT_OVERLAP");
    assert.equal(await prisma.ledgerImport.count({ where: { organizationId: ORG, kind: "balances" } }), 0);
  });

  it("balances 2024 · apertura + resumen + regularización + cierre, filas LedgerImportBalance, ejercicio closed y periodos cerrados por importación; Sumas y saldos, balance y PyG comparativa con las cifras esperadas", async () => {
    const preview = await ledgerImport.previewLedgerImport({ context, body: { kind: "balances", content: BALANCES_2024_CSV } });
    assert.deepEqual([preview.fiscalYearCode, preview.entryCount, preview.periodFrom, preview.periodTo, preview.canPost], ["2024", 4, "2024-01", "2024-12", true]);
    assert.deepEqual(preview.closingDetected.map((row) => row.entryKind), ["opening", "regularization", "closing"]);
    const result = await ledgerImport.createLedgerImport({ context, body: { kind: "balances", content: BALANCES_2024_CSV, fileName: "sumas-y-saldos-2024.csv" }, correlationId: CORR });
    importBalances = result.import.id;
    assert.deepEqual([result.import.status, result.created, result.import.journalEntryIds.length], ["posted", 4, 4]);
    const byNumber = [...result.entries].sort((a, b) => (a.entryNumber ?? 0) - (b.entryNumber ?? 0));
    assert.deepEqual(byNumber.map((entry) => [entry.entryKind, entry.sourceEntryNumber, entry.propertyCode, entry.entryDate, entry.entryNumber]), [
      ["opening", "apertura", "SOC", "2024-01-01", 1],
      ["normal", "2024", "HA", "2024-12-31", 2],
      ["regularization", "regularizacion", "SOC", "2024-12-31", 3],
      ["closing", "cierre", "SOC", "2024-12-31", 4]
    ]);
    assert.ok(result.warnings.some((warning) => warning.includes("marcado cerrado")));
    const balances = await prisma.ledgerImportBalance.findMany({ where: { importId: importBalances } });
    assert.equal(balances.length, 9);
    const year = await prisma.fiscalYear.findFirst({ where: { organizationId: ORG, code: "2024" } });
    assert.ok(year);
    fiscalYear2024Id = year.id;
    assert.deepEqual([year.status, year.closingEntryId, year.netResult?.toFixed(2), !!year.closedAt], ["closed", result.import.journalEntryIds[3], "60000.00", true]);
    const closedPeriods = await prisma.fiscalPeriod.findMany({ where: { organizationId: ORG, periodCode: { startsWith: "2024-" } } });
    assert.equal(closedPeriods.length, 12);
    assert.ok(closedPeriods.every((period) => period.status === "closed" && period.closingNotes === `cerrado por importación ${importBalances}`));
    const closing = await prisma.journalLine.findMany({ where: { journalEntryId: result.import.journalEntryIds[3]! }, orderBy: { accountCode: "asc" } });
    assert.deepEqual(closing.map((line) => [line.accountCode, line.debit.toFixed(2), line.credit.toFixed(2)]), [["100", "30000.00", "0.00"], ["129", "80000.00", "0.00"], ["472.21", "0.00", "8400.00"], ["477.10", "10000.00", "0.00"], ["572", "0.00", "111600.00"]]);

    const sumas = await trialBalance.buildTrialBalance({ context, asOf: "2024-12-31" });
    assert.equal(sumas.balanced, true);
    const bank = sumas.rows.find((row) => row.accountCode === "572");
    assert.deepEqual([bank?.debitTotal, bank?.creditTotal, bank?.debitBalance], [160000, 48400, 111600]);
    const resultAccount = sumas.rows.find((row) => row.accountCode === "129");
    assert.equal(resultAccount?.creditBalance, 80000, "20.000 de apertura + 60.000 de la regularización importada");

    const pyg = await annual.buildProfitAndLoss({ context, from: "2025-01-01", to: "2025-12-31", comparative: true });
    const revenue = pyg.lines.find((line) => line.id === "P1");
    const otherExpenses = pyg.lines.find((line) => line.id === "P7");
    assert.deepEqual([revenue?.previousAmount, otherExpenses?.previousAmount], ["100000.00", "-40000.00"]);
    const balance = await annual.buildBalanceSheet({ context, from: "2025-01-01", to: "2025-12-31", comparative: true });
    const previousAssets = [...balance.assets.current, ...balance.assets.nonCurrent].reduce((sum, line) => sum + Number(line.previousAmount ?? 0), 0);
    assert.equal(previousAssets.toFixed(2), "120000.00", "activo a 31/12/2024 sin el cierre: 572 111.600 + 472.21 8.400");
    // El comparativo del balance calcula el resultado del periodo anterior desde los movimientos 6/7 (100.000 − 40.000);
    // la 129 traída por la apertura fechada dentro del periodo no entra en «resultados anteriores» (accumulateBalance
    // solo la lee del saldo anterior al periodo): limitación previa del lector, no de la importación.
    assert.equal(balance.equity.lines.find((line) => line.id === "E_VII")?.previousAmount, "60000.00");
    assert.equal(balance.liabilities.current.reduce((sum, line) => sum + Number(line.previousAmount ?? 0), 0).toFixed(2), "10000.00", "477.10 a 31/12/2024");

    // C8: la reconciliación del ejercicio entero frente al balance «hasta el periodo 12» cuadra: el saldo de 129 a 31/12
    // deja fuera la regularización importada (−20.000 de apertura, no −80.000) y las cuentas 6/7 el neto del ejercicio.
    const yearEnd = await reconciliation.reconcileLedger({ context, body: { from: "2024-01-01", to: "2024-12-31", content: BALANCES_2024_CSV, importId: importBalances }, correlationId: CORR });
    assert.equal(yearEnd.status, "ok", JSON.stringify(yearEnd.rows.filter((row) => !row.ok)));
    const result129 = yearEnd.rows.find((row) => row.accountCode === "129");
    assert.deepEqual([result129?.sourceBalance, result129?.ledgerBalance, result129?.ok], ["-20000.00", "-20000.00", true]);
    const revenueRow = yearEnd.rows.find((row) => row.accountCode === "705.1");
    assert.deepEqual([revenueRow?.sourceCredit, revenueRow?.ledgerCredit, revenueRow?.ledgerBalance, revenueRow?.ok], ["100000.00", "100000.00", "-100000.00", true]);
  });

  it("balances 2024 · reopenFiscalYear → 409 FISCAL_YEAR_CLOSED_FROM_IMPORT { importId }; reverso del lote → ejercicio open y periodos reabiertos; LedgerImportBalance se conserva", async () => {
    const details = await expectCode(fiscalYears.reopenFiscalYear({ context, id: fiscalYear2024Id, reason: "prueba", correlationId: CORR }), 409, "FISCAL_YEAR_CLOSED_FROM_IMPORT");
    assert.deepEqual([details.fiscalYearId, details.importId], [fiscalYear2024Id, importBalances]);
    assert.equal((await prisma.fiscalYear.findUnique({ where: { id: fiscalYear2024Id } }))?.status, "closed");
    const reversed = await ledgerImport.reverseLedgerImport({ context, importId: importBalances, reason: "saldos 2024 erróneos", correlationId: CORR });
    assert.deepEqual([reversed.status, reversed.reversalJournalEntryIds.length], ["reversed", 4]);
    const year = await prisma.fiscalYear.findUnique({ where: { id: fiscalYear2024Id } });
    assert.deepEqual([year?.status, year?.closedAt, year?.closingEntryId, year?.openingEntryId, year?.netResult], ["open", null, null, null, null]);
    assert.equal(await prisma.fiscalPeriod.count({ where: { organizationId: ORG, periodCode: { startsWith: "2024-" }, status: "closed" } }), 0, "los periodos cerrados por el lote se reabren");
    assert.equal(await prisma.ledgerImportBalance.count({ where: { importId: importBalances } }), 9, "histórico conservado");
    const originals = await prisma.journalEntry.findMany({ where: { id: { in: reversed.journalEntryIds } }, select: { status: true } });
    assert.ok(originals.every((row) => row.status === "reversed"));
    const sumas = await trialBalance.buildTrialBalance({ context, asOf: "2024-12-31" });
    assert.equal(sumas.rows.find((row) => row.accountCode === "572"), undefined, "sin parejas de reversión el 2024 queda a cero");
  });

  it("SD-06 / C11 · diario 2023 con el cierre de Sage ANTES de «ejercicios»: closeFiscalYear nativo → 409 FISCAL_YEAR_CLOSED_FROM_IMPORT; el lote «ejercicios» adopta el cierre importado (closed, netResult, closingEntryId, asientos enlazados, periodos cerrados)", async () => {
    const journal = await ledgerImport.createLedgerImport({ context, body: { kind: "journal", content: JOURNAL_2023_CSV, fileName: "diario-2023.csv" }, correlationId: CORR });
    assert.deepEqual([journal.import.status, journal.created], ["posted", 4]);
    assert.ok(journal.warnings.some((warning) => /no tiene ese ejercicio: importa antes «ejercicios»/.test(warning)), journal.warnings.join(" | "));
    const closingEntry = journal.entries.find((entry) => entry.entryKind === "closing")!;
    assert.ok(closingEntry.journalEntryId);
    // El usuario crea el ejercicio a mano (createFiscalYear lo deja open) y trata de cerrarlo con el cierre nativo: rehusado, no duplica la 129.
    const manual = await prisma.fiscalYear.create({ data: { organizationId: ORG, propertyId: null, code: "2023", startDate: new Date("2023-01-01T00:00:00Z"), endDate: new Date("2023-12-31T00:00:00Z"), status: "open" } });
    const details = await expectCode(fiscalYears.closeFiscalYear({ context, id: manual.id, correlationId: CORR }), 409, "FISCAL_YEAR_CLOSED_FROM_IMPORT");
    assert.deepEqual([details.fiscalYearId, details.importId], [manual.id, journal.import.id]);
    assert.equal(await prisma.journalEntry.count({ where: { organizationId: ORG, fiscalYearCode: "2023", entryKind: { in: ["regularization", "closing"] } } }), 2, "sin regularización ni cierre nuevos");
    // «Ejercicios» 2023: la apertura ya está (skipped_existing) y el cierre importado se adopta.
    const years = await ledgerImport.createLedgerImport({ context, body: { kind: "fiscal_years", content: FISCAL_YEARS_2023_CSV, fileName: "apertura-2023.csv" }, correlationId: CORR });
    assert.deepEqual([years.import.status, years.created, years.skipped], ["posted", 0, 1]);
    assert.ok(years.warnings.some((warning) => /Ejercicio 2023 marcado cerrado con el cierre importado por un lote anterior/.test(warning)), years.warnings.join(" | "));
    const year = await prisma.fiscalYear.findUnique({ where: { id: manual.id } });
    assert.deepEqual([year?.status, year?.closingEntryId, year?.netResult?.toFixed(2), year?.openingEntryId], ["closed", closingEntry.journalEntryId, "-100.00", null]);
    const linked = await prisma.journalEntry.findMany({ where: { organizationId: ORG, fiscalYearCode: "2023", sourceType: "sage200_journal" }, select: { fiscalYearId: true } });
    assert.ok(linked.length === 4 && linked.every((row) => row.fiscalYearId === manual.id), "los asientos importados antes del ejercicio quedan enlazados a él");
    assert.equal(await prisma.fiscalPeriod.count({ where: { organizationId: ORG, periodCode: { startsWith: "2023-" }, status: "closed", closingNotes: `cerrado por importación ${years.import.id}` } }), 12);
    await expectCode(fiscalYears.reopenFiscalYear({ context, id: manual.id, reason: "prueba", correlationId: CORR }), 409, "FISCAL_YEAR_CLOSED_FROM_IMPORT");
  });

  // ---- listado y detalle ----------------------------------------------------------

  it("listado y detalle · por organización con filtros; detalle con entradas, mapping y balances; 404 opaco desde otra organización; reverso de un borrador → 409 LEDGER_IMPORT_NOT_POSTED", async () => {
    const all = await ledgerImport.listLedgerImports({ context: reader });
    assert.ok(all.length >= 9);
    assert.ok(all.every((row) => ["draft", "posted", "reversed"].includes(row.status)));
    const journals = await ledgerImport.listLedgerImports({ context: reader, query: { kind: "journal", status: "posted" } });
    assert.ok(journals.some((row) => row.id === importSeptB));
    assert.ok(!journals.some((row) => row.id === importSept));
    const september = await ledgerImport.listLedgerImports({ context: reader, query: { from: "2026-09", to: "2026-09" } });
    assert.ok(september.some((row) => row.id === importSeptB) && september.some((row) => row.id === importVat));
    const detail = await ledgerImport.getLedgerImport({ context: reader, importId: importSeptB });
    assert.deepEqual([detail.import.id, detail.entryTotal, detail.entries.length, detail.balances], [importSeptB, 7, 7, undefined]);
    assert.ok(detail.mapping.accounts.length >= 10);
    assert.equal(detail.mapping.analytics?.centreDimension, "delegacion");
    assert.equal(detail.mapping.analytics?.entries.find((entry) => entry.sourceCode === "MANT")?.costCentreCode, "POM");
    const balancesDetail = await ledgerImport.getLedgerImport({ context: reader, importId: importBalances });
    assert.equal(balancesDetail.balances?.length, 9);
    assert.equal(balancesDetail.balances?.find((row) => row.sourceAccount === "5720000")?.accountCode, "572");
    await expectCode(ledgerImport.getLedgerImport({ context: { ...reader, organizationId: "org_123" } as UserContext, importId: importSeptB }), 404, "LEDGER_IMPORT_NOT_FOUND");
    const draft = await ledgerImport.createLedgerImport({ context, body: { kind: "journal", content: JOURNAL_NOV_CSV, post: false }, correlationId: CORR });
    assert.deepEqual([draft.import.status, draft.import.journalEntryIds.length, draft.entries[0]?.status], ["draft", 0, "draft"]);
    await expectCode(ledgerImport.reverseLedgerImport({ context, importId: draft.import.id, reason: "borrador", correlationId: CORR }), 409, "LEDGER_IMPORT_NOT_POSTED");
    await expectCode(ledgerImport.postLedgerImport({ context, importId: draft.import.id, correlationId: CORR }), 409, "FISCAL_PERIOD_CLOSED");
    assert.equal((await prisma.ledgerImport.findUnique({ where: { id: draft.import.id } }))?.status, "draft", "el borrador sigue intacto tras el rollback");
    await assert.rejects(ledgerImport.previewLedgerImport({ context: reader, body: { kind: "journal", content: JOURNAL_NOV_CSV } }), (error: unknown) => error instanceof Error && error.name === "PermissionDeniedError" && /accounting\.journal\.post/.test(error.message), "sin accounting.journal.post no hay preview");
  });
});

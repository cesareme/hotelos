// Generador REPRODUCIBLE del dataset Sage 200 sintético de la Tanda 7c (L6 · integrador).
//
// Simula la contabilidad de una sociedad hotelera ficticia coherente con CELUISMA (empresa
// Sage «1», ocho delegaciones AS FN LL LT MC OC PG RA, departamentos HAB REST MANT ADM COM OTROS,
// cuentas Sage de 7 dígitos y de 10 para terceros) de forma CONTINUA desde el 1 de enero de
// 2024 hasta el 31 de julio de 2026, en céntimos enteros (nunca un float toca un importe), con
// un generador pseudoaleatorio sembrado (mulberry32): la misma semilla produce byte a byte los
// mismos ficheros. NO contiene ningún NIF real: los CIF son sintéticos con dígito de control
// válido (`syntheticCif`, misma regla que los fixtures de L1) y la empresa se identifica por su
// CodigoEmpresa numérico («1»), nunca por NIF.
//
// Qué escribe (todo en --out, git-ignored en <raíz git>/pilots/):
//   · plan-cuentas.{csv,xlsx}            plan Sage (canónico y «Gestor de Exportación»)
//   · terceros.{csv,xlsx}                clientes, proveedores y acreedores
//   · ejercicios/apertura-2025.csv, apertura-2026.csv   asiento de apertura (periodo «Apertura»)
//   · diario/diario-2025-01..12.csv, cierre-2025.csv    diario 2025 completo (+ «Cierre ejercicio» y «Cierre Contabilidad»)
//   · diario/diario-2026-01..07.csv      diario 2026 ene-jul IMPORTABLE (sin las nóminas de los centros
//                                        que el lote de coste de personal de Anfitorio ya devengó)
//   · diario/diario-2026-01.xlsx         enero 2026 en formato «Enviar a Excel» (mismo contenido → mismo hash)
//   · diario/diario-2026-02-ime.csv      febrero 2026 en CSV IME de 60 columnas (mismo contenido → mismo hash)
//   · diario/no-importar/nominas-2026-anfitorio.csv    los asientos de nómina que NO se cargan (decisión §10.1-4)
//   · libros-iva/libro-iva-2025-Q1..Q4.csv, libro-iva-2026-Q1.csv, -Q2.csv, -Q3-parcial.csv
//   · sumas-y-saldos/sumas-y-saldos-2024.csv            anual, para el lote `balances` (§6)
//   · sumas-y-saldos/sumas-y-saldos-2025.{csv,xlsx}     mensual (12 periodos), sumas-y-saldos-2025-RA.csv (hoja de una delegación)
//   · sumas-y-saldos/sumas-y-saldos-2026-ene-jul.csv    mensual (7 periodos)
//   · resumen.json, README.md            cifras esperadas (resultado, IVA por trimestre, ingresos y nómina por centro)
//
// Modo sombra (diseño §5.1): con --organization, los asientos que Anfitorio ya tiene en 2026
// se leen de la BD y se reflejan en Sage con las MISMAS cifras: (a) las facturas y cobros
// nativos (VeriFactu) se escriben en el diario importable con su serie y número → el lote los
// excluye como `skipped_native`; (b) los devengos de nómina del lote de coste de personal (AS LT
// MC OC PG RA, 2026-01..07) van al fichero «no-importar» y al balance de Sage, nunca al diario
// importable. Sin --organization no hay reflejo (el dataset sigue siendo coherente por sí solo).
//
//   cd apps/api && node --env-file-if-exists=../../.env --import tsx src/scripts/generate-sage200-demo.ts \
//     --out ../../../pilots/faranda-celuisma/sage200-demo [--organization <orgId>] [--seed 20260917] [--json]

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import { writeXlsx, type XlsxCell, type XlsxSheet } from "../modules/financial-statements/xlsx-writer.js";
import { SAGE_IME_COLUMNS } from "../modules/accounting/import/sage200.parser.js";

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export type GeneratorFlags = { out: string; organization: string | null; seed: number; json: boolean; help: boolean };

export const USAGE = [
  "Uso (desde apps/api):",
  "  node --env-file-if-exists=../../.env --import tsx src/scripts/generate-sage200-demo.ts --out <directorio> [--organization <orgId>] [--seed <n>] [--json]",
  "",
  "  --out <dir>            directorio destino (se crea); por defecto ../../../pilots/faranda-celuisma/sage200-demo",
  "  --organization <id>    lee de la BD los asientos nativos de 2026 (nómina, facturas y cobros) y los refleja en Sage (modo sombra)",
  "  --seed <n>             semilla del generador (por defecto 20260917): la misma semilla produce los mismos ficheros",
  "  --json                 resumen legible por máquina en stdout"
].join("\n");

export function parseFlags(argv: readonly string[]): GeneratorFlags {
  const flags: GeneratorFlags = { out: "../../../pilots/faranda-celuisma/sage200-demo", organization: null, seed: 20260917, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return { ...flags, help: true };
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`El flag "${arg}" necesita un valor.`);
    if (arg === "--out") flags.out = value;
    else if (arg === "--organization") flags.organization = value;
    else if (arg === "--seed") {
      if (!/^\d+$/.test(value)) throw new Error("--seed debe ser un entero.");
      flags.seed = Number(value);
    } else throw new Error(`Flag desconocido "${arg}".`);
    i++;
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Utilidades puras: PRNG, céntimos, fechas, NIF sintético
// ---------------------------------------------------------------------------

/** mulberry32: PRNG determinista de 32 bits. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Cents = number;

/** Euros (número) → céntimos enteros (HALF_UP). */
function cents(euros: number): Cents {
  return Math.round(euros * 100);
}

/** Importe en céntimos → "1234,56" (canónico: coma decimal). */
export function fmtEs(value: Cents): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

/** Importe en céntimos → "1234.56" (celdas numéricas del XLSX). */
function fmtEn(value: Cents): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Reparte `total` en proporción a `weights` con residuo al mayor peso: Σ partes = total exactamente. */
export function splitCents(total: Cents, weights: readonly number[]): Cents[] {
  const sum = weights.reduce((acc, w) => acc + w, 0);
  if (sum <= 0) throw new Error("splitCents: pesos sin suma positiva");
  let heaviest = 0;
  weights.forEach((w, i) => {
    if (w > weights[heaviest]!) heaviest = i;
  });
  const parts = weights.map((w, i) => (i === heaviest ? 0 : Math.round((total * w) / sum)));
  const assigned = parts.reduce((acc, p) => acc + p, 0);
  parts[heaviest] = total - assigned;
  return parts;
}

function pct(base: Cents, ratePercent: number): Cents {
  return Math.round((base * ratePercent) / 100);
}

function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function ddmmyyyy(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;
}

/** CIF sintético «<letra>» + 7 dígitos + control válido (misma regla que los fixtures de L1). NUNCA un NIF real. */
export function syntheticCif(letter: "A" | "B", seed: number): string {
  const digits = String(seed % 10_000_000).padStart(7, "0");
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const digit = Number(digits[i]);
    if (i % 2 === 0) {
      const doubled = digit * 2;
      sum += Math.floor(doubled / 10) + (doubled % 10);
    } else sum += digit;
  }
  return `${letter}${digits}${(10 - (sum % 10)) % 10}`;
}

// ---------------------------------------------------------------------------
// Estructura de la sociedad sintética
// ---------------------------------------------------------------------------

export type Centre = {
  code: string;
  name: string;
  rooms: number;
  adr: number;
  restaurant: boolean;
  parking: boolean;
  outsourcedCleaning: boolean;
  madrid: boolean;
  office: boolean;
  /** Cuenta Sage del cliente colectivo «mostrador» del hotel. */
  customer: string;
};

export const CENTRES: readonly Centre[] = Object.freeze([
  { code: "RA", name: "Hotel Rías Altas", rooms: 120, adr: 78, restaurant: true, parking: true, outsourcedCleaning: false, madrid: false, office: false, customer: "4300000101" },
  { code: "LT", name: "Hotel Los Tilos", rooms: 92, adr: 72, restaurant: true, parking: true, outsourcedCleaning: false, madrid: false, office: false, customer: "4300000102" },
  { code: "PG", name: "Hotel Pathos Gijón", rooms: 56, adr: 65, restaurant: false, parking: false, outsourcedCleaning: false, madrid: false, office: false, customer: "4300000103" },
  { code: "MC", name: "Hotel Marsol Candás", rooms: 85, adr: 80, restaurant: true, parking: true, outsourcedCleaning: false, madrid: false, office: false, customer: "4300000104" },
  { code: "AS", name: "Hotel Alisas Santander", rooms: 78, adr: 60, restaurant: false, parking: false, outsourcedCleaning: true, madrid: false, office: false, customer: "4300000105" },
  { code: "FN", name: "Hotel Florida Norte Madrid", rooms: 399, adr: 85, restaurant: true, parking: true, outsourcedCleaning: true, madrid: true, office: false, customer: "4300000106" },
  { code: "LL", name: "Hotel Las Lomas Oviedo", rooms: 102, adr: 62, restaurant: false, parking: true, outsourcedCleaning: true, madrid: false, office: false, customer: "4300000107" },
  { code: "OC", name: "Oficina central", rooms: 0, adr: 0, restaurant: false, parking: false, outsourcedCleaning: false, madrid: false, office: true, customer: "" }
]);

const HOTELS = CENTRES.filter((c) => !c.office);
const OFFICE = "OC";

/** Departamentos analíticos Sage → centro de coste USALI (sinónimos del mapa analítico). */
export const DEPARTMENTS: Readonly<Record<string, string>> = Object.freeze({ HAB: "ROOMS", REST: "FNB", MANT: "POM", ADM: "ADMIN_GENERAL", COM: "SALES_MARKETING", OTROS: "OTHER_OPERATED" });

/** Centro de coste USALI de Anfitorio → departamento Sage (reflejo de la nómina nativa). */
const COST_CENTRE_TO_DEPT: Readonly<Record<string, string>> = Object.freeze({ ROOMS: "HAB", FNB: "REST", POM: "MANT", ADMIN_GENERAL: "ADM", SALES_MARKETING: "COM", OTHER_OPERATED: "OTROS", IT: "ADM" });

export type PlanAccount = { cuenta: string; titulo: string; pgc: string; nif?: string; pais?: string };

/** Plan Sage → cuenta PGC Pymes hotelero esperada por las reglas 2-6 del mapa (§4.4). */
export const SAGE_PLAN: readonly PlanAccount[] = Object.freeze([
  { cuenta: "1000000", titulo: "Capital social", pgc: "100" },
  { cuenta: "1120000", titulo: "Reserva legal", pgc: "112" },
  { cuenta: "1130000", titulo: "Reservas voluntarias", pgc: "113" },
  { cuenta: "1290000", titulo: "Resultado del ejercicio", pgc: "129" },
  { cuenta: "1700000", titulo: "Deudas a largo plazo con entidades de crédito", pgc: "170" },
  { cuenta: "2110000", titulo: "Construcciones", pgc: "211" },
  { cuenta: "2130000", titulo: "Maquinaria", pgc: "213" },
  { cuenta: "2160000", titulo: "Mobiliario", pgc: "216" },
  { cuenta: "2170000", titulo: "Equipos para procesos de información", pgc: "217" },
  { cuenta: "2811000", titulo: "Amortización acumulada de construcciones", pgc: "2811" },
  { cuenta: "2813000", titulo: "Amortización acumulada de maquinaria", pgc: "2813" },
  { cuenta: "2816000", titulo: "Amortización acumulada de mobiliario", pgc: "2816" },
  { cuenta: "2817000", titulo: "Amortización acumulada de equipos informáticos", pgc: "2817" },
  { cuenta: "4650000", titulo: "Remuneraciones pendientes de pago", pgc: "465" },
  { cuenta: "4700000", titulo: "Hacienda Pública, deudora por IVA", pgc: "4700" },
  { cuenta: "4720010", titulo: "Hacienda Pública, IVA soportado 10 %", pgc: "472.10" },
  { cuenta: "4720021", titulo: "Hacienda Pública, IVA soportado 21 %", pgc: "472.21" },
  { cuenta: "4750000", titulo: "Hacienda Pública, acreedora por IVA", pgc: "4750" },
  { cuenta: "4752000", titulo: "Hacienda Pública, acreedora por impuesto sobre sociedades", pgc: "4752" },
  { cuenta: "4760000", titulo: "Organismos de la Seguridad Social, acreedores", pgc: "476" },
  { cuenta: "4770010", titulo: "Hacienda Pública, IVA repercutido 10 %", pgc: "477.10" },
  { cuenta: "4770021", titulo: "Hacienda Pública, IVA repercutido 21 %", pgc: "477.21" },
  { cuenta: "5700000", titulo: "Caja, euros", pgc: "570" },
  { cuenta: "5720000", titulo: "Bancos c/c, euros", pgc: "572" },
  { cuenta: "5721000", titulo: "Datáfono pendiente de liquidar", pgc: "5721" },
  { cuenta: "6010001", titulo: "Compras de alimentos", pgc: "601.1" },
  { cuenta: "6010002", titulo: "Compras de bebidas", pgc: "601.2" },
  { cuenta: "6210000", titulo: "Arrendamientos y cánones", pgc: "621" },
  { cuenta: "6220000", titulo: "Reparaciones y conservación", pgc: "622" },
  { cuenta: "6220001", titulo: "Contratos de mantenimiento de instalaciones", pgc: "622.1 (alta)" },
  { cuenta: "6230000", titulo: "Servicios de profesionales independientes", pgc: "623" },
  { cuenta: "6250000", titulo: "Primas de seguros", pgc: "625" },
  { cuenta: "6260000", titulo: "Servicios bancarios y similares", pgc: "626" },
  { cuenta: "6270000", titulo: "Publicidad, propaganda y relaciones públicas", pgc: "627" },
  { cuenta: "6280001", titulo: "Electricidad", pgc: "628.1" },
  { cuenta: "6280002", titulo: "Agua", pgc: "628.2" },
  { cuenta: "6280003", titulo: "Gas y combustibles", pgc: "628.3" },
  { cuenta: "6280004", titulo: "Telecomunicaciones e internet", pgc: "628.4" },
  { cuenta: "6290001", titulo: "Comisiones de canales de venta", pgc: "629.1" },
  { cuenta: "6290002", titulo: "Lavandería y lencería externa", pgc: "629.2" },
  { cuenta: "6290003", titulo: "Licencias y servicios informáticos", pgc: "629.3" },
  { cuenta: "6290004", titulo: "Limpieza externa", pgc: "629.4" },
  { cuenta: "6290005", titulo: "Suscripciones y cuotas asociativas", pgc: "629.5 (alta)" },
  { cuenta: "6300000", titulo: "Impuesto sobre beneficios", pgc: "630" },
  { cuenta: "6310000", titulo: "Otros tributos (IBI)", pgc: "631" },
  { cuenta: "6400000", titulo: "Sueldos y salarios", pgc: "640" },
  { cuenta: "6420000", titulo: "Seguridad Social a cargo de la empresa", pgc: "642" },
  { cuenta: "6620000", titulo: "Intereses de deudas", pgc: "662" },
  { cuenta: "6810000", titulo: "Amortización del inmovilizado material", pgc: "681" },
  { cuenta: "7050000", titulo: "Prestaciones de servicios", pgc: "705" },
  { cuenta: "7050001", titulo: "Prestaciones de servicios: alojamiento", pgc: "705.1" },
  { cuenta: "7050002", titulo: "Prestaciones de servicios: restauración", pgc: "705.2" },
  { cuenta: "7050003", titulo: "Prestaciones de servicios: otros servicios", pgc: "705.3" },
  { cuenta: "7050005", titulo: "Prestaciones de servicios: parking", pgc: "705.5 (alta)" },
  { cuenta: "7520000", titulo: "Ingresos por arrendamientos", pgc: "752" }
]);

export type ThirdParty = { codigo: string; rol: "customer" | "supplier"; cuenta: string; nif: string | null; pais: string; nombre: string; titulo: string };

export const THIRD_PARTIES: readonly ThirdParty[] = Object.freeze([
  ...HOTELS.map((h, i) => ({ codigo: String(101 + i), rol: "customer" as const, cuenta: h.customer, nif: null, pais: "ES", nombre: `Clientes mostrador ${h.name}`, titulo: `Clientes mostrador ${h.code}` })),
  { codigo: "201", rol: "customer", cuenta: "4300000201", nif: syntheticCif("A", 2345678), pais: "ES", nombre: "Viajes Cantábrico SL", titulo: "Viajes Cantábrico SL" },
  { codigo: "202", rol: "customer", cuenta: "4300000202", nif: syntheticCif("B", 7100200), pais: "ES", nombre: "Turismo y Congresos del Norte SA", titulo: "Turismo y Congresos del Norte SA" },
  { codigo: "203", rol: "customer", cuenta: "4300000203", nif: syntheticCif("B", 7100203), pais: "ES", nombre: "Grupo Eventos Atlántico SL", titulo: "Grupo Eventos Atlántico SL" },
  { codigo: "1", rol: "supplier", cuenta: "4000000001", nif: syntheticCif("A", 1234567), pais: "ES", nombre: "Suministros Eléctricos del Noroeste SL", titulo: "Suministros Eléctricos del Noroeste SL" },
  { codigo: "2", rol: "supplier", cuenta: "4000000002", nif: syntheticCif("A", 7000002), pais: "ES", nombre: "Aguas de la Bahía SA", titulo: "Aguas de la Bahía SA" },
  { codigo: "3", rol: "supplier", cuenta: "4000000003", nif: syntheticCif("B", 7000003), pais: "ES", nombre: "Gas Cantábrico Distribución SL", titulo: "Gas Cantábrico Distribución SL" },
  { codigo: "4", rol: "supplier", cuenta: "4000000004", nif: syntheticCif("A", 3456789), pais: "ES", nombre: "Lavandería Industrial Astur SL", titulo: "Lavandería Industrial Astur SL" },
  { codigo: "5", rol: "supplier", cuenta: "4000000005", nif: syntheticCif("B", 7000005), pais: "ES", nombre: "Distribuciones Alimentarias del Norte SL", titulo: "Distribuciones Alimentarias del Norte SL" },
  { codigo: "6", rol: "supplier", cuenta: "4000000006", nif: syntheticCif("B", 7000006), pais: "ES", nombre: "Bebidas y Bodegas Verdes SL", titulo: "Bebidas y Bodegas Verdes SL" },
  { codigo: "7", rol: "supplier", cuenta: "4000000007", nif: syntheticCif("A", 7000007), pais: "ES", nombre: "Telecomunicaciones Ibéricas del Norte SA", titulo: "Telecomunicaciones Ibéricas del Norte SA" },
  { codigo: "8", rol: "supplier", cuenta: "4000000008", nif: syntheticCif("B", 7000008), pais: "ES", nombre: "Limpiezas Integrales Norte SL", titulo: "Limpiezas Integrales Norte SL" },
  { codigo: "9", rol: "supplier", cuenta: "4000000009", nif: syntheticCif("B", 7000009), pais: "ES", nombre: "Mantenimiento Técnico Hotelero SL", titulo: "Mantenimiento Técnico Hotelero SL" },
  { codigo: "10", rol: "supplier", cuenta: "4000000010", nif: syntheticCif("B", 7000010), pais: "ES", nombre: "Publicidad Atlántica SL", titulo: "Publicidad Atlántica SL" },
  { codigo: "11", rol: "supplier", cuenta: "4000000011", nif: syntheticCif("B", 7000011), pais: "ES", nombre: "Software Hotelero Ibérico SL", titulo: "Software Hotelero Ibérico SL" },
  { codigo: "12", rol: "supplier", cuenta: "4000000012", nif: syntheticCif("A", 7000012), pais: "ES", nombre: "Asociación Hotelera del Norte", titulo: "Asociación Hotelera del Norte" },
  { codigo: "501", rol: "supplier", cuenta: "4100000001", nif: syntheticCif("B", 7000501), pais: "ES", nombre: "Reservas Online Europa SL", titulo: "Reservas Online Europa SL" },
  { codigo: "502", rol: "supplier", cuenta: "4100000002", nif: syntheticCif("A", 7000502), pais: "ES", nombre: "Seguros Cantábricos SA", titulo: "Seguros Cantábricos SA" },
  { codigo: "503", rol: "supplier", cuenta: "4100000003", nif: syntheticCif("B", 7000503), pais: "ES", nombre: "Asesoría Fiscal y Laboral Norte SL", titulo: "Asesoría Fiscal y Laboral Norte SL" },
  { codigo: "504", rol: "supplier", cuenta: "4100000004", nif: syntheticCif("B", 7000504), pais: "ES", nombre: "Inmobiliaria Portugal Siete SL", titulo: "Inmobiliaria Portugal Siete SL" }
]);

const PARTY_BY_ACCOUNT = new Map(THIRD_PARTIES.map((party) => [party.cuenta, party]));
const PLAN_TITLE = new Map(SAGE_PLAN.map((row) => [row.cuenta, row.titulo]));

function titleOf(cuenta: string): string {
  return PLAN_TITLE.get(cuenta) ?? PARTY_BY_ACCOUNT.get(cuenta)?.titulo ?? cuenta;
}

// ---------------------------------------------------------------------------
// Modelo del diario sintético
// ---------------------------------------------------------------------------

export type JLine = {
  cuenta: string;
  debe: Cents;
  haber: Cents;
  concepto: string;
  documento?: string | null;
  delegacion?: string | null;
  departamento?: string | null;
  serie?: string | null;
  factura?: string | null;
  fecha_factura?: string | null;
  nif?: string | null;
  nombre?: string | null;
  base_iva?: Cents | null;
  tipo_iva?: string | null;
  cuota_iva?: Cents | null;
  tipo_factura?: string | null;
};

export type EntryTag = "apertura" | "regularizacion" | "cierre" | "nomina" | "nomina-nativa" | "nativo-anfitorio" | "iva" | "normal";

export type JEntry = {
  ejercicio: number;
  asiento: number;
  fecha: string;
  periodo: string;
  tag: EntryTag;
  lines: JLine[];
};

type Event = { date: string; prio: number; seq: number; tag: EntryTag; lines: JLine[] };

export type VatRow = {
  libro: "emitidas" | "recibidas";
  ejercicio: number;
  fecha: string;
  serie: string;
  numero: string;
  nif: string | null;
  nombre: string | null;
  pais: string;
  base: Cents;
  tipo_iva: string;
  cuota: Cents;
  total: Cents;
  tipo_factura: string;
  /** Solo en emitidas de documentos nativos de Anfitorio (reflejo en modo sombra). */
  nativo?: boolean;
};

const START_YEAR = 2024;
const END = { year: 2026, month: 7 };

function isPnlAccount(cuenta: string): boolean {
  return cuenta.startsWith("6") || cuenta.startsWith("7");
}

function balanceKey(cuenta: string, delegacion: string | null | undefined): string {
  return `${cuenta}|${delegacion ?? ""}`;
}

// ---------------------------------------------------------------------------
// Reflejo de lo nativo de Anfitorio (modo sombra) — lectura de la BD
// ---------------------------------------------------------------------------

export type NativePayrollLine = { month: string; property: string; account: string; costCentre: string | null; debit: Cents; credit: Cents; lines: number };
export type NativeDocumentEntry = {
  entryDate: string;
  sourceType: string;
  property: string;
  invoiceNumber: string | null;
  lines: Array<{ account: string; debit: Cents; credit: Cents; taxRate: string | null; taxBase: Cents | null }>;
};
export type NativeMirror = { payroll: NativePayrollLine[]; documents: NativeDocumentEntry[] };

/** Cuenta PGC nativa → cuenta Sage del reflejo (solo las que usan los escritores nativos de Anfitorio). */
const NATIVE_TO_SAGE: Readonly<Record<string, string>> = Object.freeze({
  "4300": "4300000101",
  "705": "7050000",
  "705.1": "7050001",
  "705.2": "7050002",
  "705.3": "7050003",
  "477.21": "4770021",
  "477.10": "4770010",
  "5721": "5721000",
  "572": "5720000",
  "570": "5700000",
  "640": "6400000",
  "642": "6420000",
  "465": "4650000",
  "476": "4760000"
});

function toCents(value: unknown): Cents {
  return Math.round(Number(value) * 100);
}

/** Lee de la BD los asientos nativos de 2026-01..07 (nómina del lote de coste de personal; facturas y cobros VeriFactu). */
export async function readNativeMirror(organizationId: string, to: string): Promise<NativeMirror> {
  const { prisma } = await import("@hotelos/database");
  const payrollRows = await prisma.$queryRaw<Array<{ month: string; property: string | null; account: string | null; cost_centre: string | null; debit: unknown; credit: unknown; lines: unknown }>>(Prisma.sql`
    SELECT to_char(e.entry_date, 'YYYY-MM') AS month, p.code AS property, l.account_code AS account, c.code AS cost_centre,
           SUM(l.debit) AS debit, SUM(l.credit) AS credit, COUNT(*) AS lines
    FROM journal_lines l
    JOIN journal_entries e ON e.id = l.journal_entry_id
    LEFT JOIN properties p ON p.id = e.property_id
    LEFT JOIN cost_centers c ON c.id = l.cost_center_id
    WHERE e.organization_id = ${organizationId} AND e.source_type = 'payroll_cost_import' AND e.status = 'posted' AND e.reversed_by_id IS NULL
      AND e.entry_date >= '2026-01-01'::date AND e.entry_date <= ${to}::date
    GROUP BY 1, 2, 3, 4
    ORDER BY 1, 2, 3, 4`);
  const documentRows = await prisma.$queryRaw<Array<{ id: string; entry_date: Date; source_type: string; source_id: string | null; property: string | null; account: string | null; debit: unknown; credit: unknown; tax_rate: string | null; tax_base: unknown; line_id: string }>>(Prisma.sql`
    SELECT e.id, e.entry_date, e.source_type, e.source_id, p.code AS property, l.account_code AS account, l.debit, l.credit, l.tax_rate_code AS tax_rate, l.tax_base, l.id AS line_id
    FROM journal_entries e
    JOIN journal_lines l ON l.journal_entry_id = e.id
    LEFT JOIN properties p ON p.id = e.property_id
    WHERE e.organization_id = ${organizationId} AND e.status = 'posted' AND e.reversed_by_id IS NULL AND e.reversal_of_id IS NULL
      AND e.source_type IN ('invoice', 'invoice_rectification', 'invoice_cancellation', 'payment', 'payment_refund')
      AND e.entry_date >= '2026-01-01'::date AND e.entry_date <= ${to}::date
    ORDER BY e.entry_date, e.entry_number, l.id`);
  const invoiceIds = [...new Set(documentRows.filter((row) => row.source_type.startsWith("invoice")).map((row) => row.source_id).filter((id): id is string => !!id))];
  const paymentIds = [...new Set(documentRows.filter((row) => row.source_type.startsWith("payment")).map((row) => row.source_id).filter((id): id is string => !!id))];
  const invoices = invoiceIds.length ? await prisma.invoice.findMany({ where: { id: { in: invoiceIds } }, select: { id: true, invoiceNumber: true } }) : [];
  const payments = paymentIds.length ? await prisma.payment.findMany({ where: { id: { in: paymentIds } }, select: { id: true, invoiceId: true } }) : [];
  const invoiceNumberById = new Map(invoices.map((row) => [row.id, row.invoiceNumber]));
  const paymentInvoice = new Map(payments.map((row) => [row.id, row.invoiceId ? invoiceNumberById.get(row.invoiceId) ?? null : null]));
  const documents = new Map<string, NativeDocumentEntry>();
  for (const row of documentRows) {
    const entryDate = row.entry_date.toISOString().slice(0, 10);
    const invoiceNumber = row.source_type.startsWith("invoice") ? invoiceNumberById.get(row.source_id ?? "") ?? null : paymentInvoice.get(row.source_id ?? "") ?? null;
    const existing = documents.get(row.id) ?? { entryDate, sourceType: row.source_type, property: row.property ?? "RA", invoiceNumber, lines: [] };
    existing.lines.push({ account: row.account ?? "", debit: toCents(row.debit), credit: toCents(row.credit), taxRate: row.tax_rate, taxBase: row.tax_base === null ? null : toCents(row.tax_base) });
    documents.set(row.id, existing);
  }
  await prisma.$disconnect();
  return {
    payroll: payrollRows.map((row) => ({ month: row.month, property: row.property ?? OFFICE, account: row.account ?? "", costCentre: row.cost_centre, debit: toCents(row.debit), credit: toCents(row.credit), lines: Number(row.lines) })),
    documents: [...documents.values()]
  };
}

// ---------------------------------------------------------------------------
// Motor de simulación
// ---------------------------------------------------------------------------

export type SimulationResult = {
  entries: JEntry[];
  vatRows: VatRow[];
  /** Saldos de apertura por ejercicio y (cuenta|delegación), en céntimos (debe positivo). */
  openings: Map<number, Map<string, Cents>>;
  /** Movimientos por "YYYY-MM|cuenta|delegación". */
  movements: Map<string, { debe: Cents; haber: Cents }>;
  /** Saldos a fin de cada mes (antes de regularización / cierre) por "YYYY-MM|cuenta|delegación". */
  closingByMonth: Map<string, Cents>;
  summary: Record<string, unknown>;
};

export function simulate(seed: number, native: NativeMirror | null): SimulationResult {
  const rand = mulberry32(seed);
  const noise = (amplitude: number): number => 1 + (rand() * 2 - 1) * amplitude;
  const pick = (min: number, max: number): number => min + Math.floor(rand() * (max - min + 1));

  const events: Event[] = [];
  let seq = 0;
  const schedule = (date: string, lines: JLine[], tag: EntryTag = "normal", prio = 5): void => {
    if (date > iso(END.year, END.month, daysIn(END.year, END.month))) return;
    events.push({ date, prio, seq: seq++, tag, lines });
  };
  const vatRows: VatRow[] = [];

  // Estado contable continuo.
  const balance = new Map<string, Cents>();
  const movements = new Map<string, { debe: Cents; haber: Cents }>();
  const closingByMonth = new Map<string, Cents>();
  const openings = new Map<number, Map<string, Cents>>();
  const entries: JEntry[] = [];
  const addBalance = (cuenta: string, delegacion: string | null | undefined, delta: Cents): void => {
    const key = balanceKey(cuenta, delegacion);
    balance.set(key, (balance.get(key) ?? 0) + delta);
  };
  let asiento = 0;
  const post = (year: number, month: number, date: string, periodo: string, tag: EntryTag, lines: JLine[], countsAsMovement: boolean): JEntry => {
    let debe = 0;
    let haber = 0;
    for (const line of lines) {
      if (line.debe < 0 || line.haber < 0 || (line.debe > 0 && line.haber > 0)) throw new Error(`Línea inválida en ${date} ${line.cuenta}: ${line.debe}/${line.haber}`);
      debe += line.debe;
      haber += line.haber;
    }
    if (debe !== haber) throw new Error(`Asiento descuadrado ${date} (${tag}): ${debe} ≠ ${haber} · ${lines.map((l) => `${l.cuenta} ${l.debe}/${l.haber}`).join(", ")}`);
    if (lines.length < 2) throw new Error(`Asiento con menos de dos líneas ${date} (${tag})`);
    asiento += 1;
    const entry: JEntry = { ejercicio: year, asiento, fecha: date, periodo, tag, lines };
    entries.push(entry);
    for (const line of lines) {
      addBalance(line.cuenta, line.delegacion, line.debe - line.haber);
      if (countsAsMovement) {
        const key = `${iso(year, month, 1).slice(0, 7)}|${balanceKey(line.cuenta, line.delegacion)}`;
        const current = movements.get(key) ?? { debe: 0, haber: 0 };
        current.debe += line.debe;
        current.haber += line.haber;
        movements.set(key, current);
      }
    }
    return entry;
  };

  // Apertura inicial 2024 (balance construido a mano, 129 = 0: el resultado de 2023 ya está en reservas).
  const fixedAssets = (h: Centre) => ({ buildings: cents(h.rooms * 45_000), machinery: cents(h.rooms * 4_000), furniture: cents(h.rooms * 6_000), it: cents(h.rooms * 500) });
  for (const h of HOTELS) {
    const fa = fixedAssets(h);
    addBalance("2110000", h.code, fa.buildings);
    addBalance("2130000", h.code, fa.machinery);
    addBalance("2160000", h.code, fa.furniture);
    addBalance("2170000", h.code, fa.it);
    addBalance("2811000", h.code, -Math.round(fa.buildings * 0.35));
    addBalance("2813000", h.code, -Math.round(fa.machinery * 0.5));
    addBalance("2816000", h.code, -Math.round(fa.furniture * 0.5));
    addBalance("2817000", h.code, -Math.round(fa.it * 0.6));
    addBalance("5720000", h.code, cents(150_000));
    addBalance("5700000", h.code, cents(2_000));
  }
  addBalance("2170000", OFFICE, cents(40_000));
  addBalance("2817000", OFFICE, -cents(24_000));
  addBalance("5720000", OFFICE, cents(900_000));
  addBalance("1700000", OFFICE, -cents(2_400_000));
  addBalance("1000000", OFFICE, -cents(6_000_000));
  addBalance("1120000", OFFICE, -cents(1_200_000));
  const plug = [...balance.values()].reduce((sum, value) => sum + value, 0);
  addBalance("1130000", OFFICE, -plug);
  let loanOutstanding = cents(2_400_000);

  // Numeración de facturas emitidas (resúmenes semanales, agencias, alquiler) y recibidas por proveedor.
  const issued = new Map<string, number>();
  const nextIssued = (serie: string): string => {
    const n = (issued.get(serie) ?? 0) + 1;
    issued.set(serie, n);
    return String(n).padStart(4, "0");
  };
  const supplierSeq = new Map<string, number>();
  const nextSupplierDoc = (cuenta: string, year: number): string => {
    const key = `${cuenta}|${year}`;
    const n = (supplierSeq.get(key) ?? 0) + 1;
    supplierSeq.set(key, n);
    const party = PARTY_BY_ACCOUNT.get(cuenta)!;
    return `${party.rol === "supplier" && cuenta.startsWith("41") ? "A" : "F"}${String(year).slice(2)}-${party.codigo.padStart(3, "0")}-${String(n).padStart(4, "0")}`;
  };

  // Facturas de proveedor pendientes de pago por (centro, mes de pago).
  const payables = new Map<string, Array<{ cuenta: string; total: Cents; nombre: string }>>();
  const addPayable = (centre: string, payMonth: string, cuenta: string, total: Cents, nombre: string): void => {
    const key = `${centre}|${payMonth}`;
    payables.set(key, [...(payables.get(key) ?? []), { cuenta, total, nombre }]);
  };
  const cardTakings = new Map<string, Cents>();

  const occupancy = (h: Centre, year: number, month: number): number => {
    const coastal = [0.42, 0.45, 0.55, 0.62, 0.66, 0.74, 0.86, 0.92, 0.78, 0.64, 0.5, 0.48];
    const madrid = [0.6, 0.65, 0.7, 0.72, 0.7, 0.68, 0.55, 0.45, 0.7, 0.75, 0.7, 0.6];
    const base = (h.madrid ? madrid : coastal)[month - 1]!;
    const growth = year === 2024 ? 0.96 : year === 2025 ? 1 : 1.03;
    return Math.min(0.97, base * growth * noise(0.04));
  };

  /** Factura recibida: gasto + IVA soportado contra el proveedor / acreedor; se paga en la remesa del mes siguiente. */
  const supplierInvoice = (h: Centre, date: string, cuenta: string, expense: string, dept: string | null, base: Cents, rate: 10 | 21 | 0, concept: string): void => {
    const party = PARTY_BY_ACCOUNT.get(cuenta)!;
    const year = Number(date.slice(0, 4));
    const doc = nextSupplierDoc(cuenta, year);
    const quota = rate === 0 ? 0 : pct(base, rate);
    const total = base + quota;
    const lines: JLine[] = [{ cuenta: expense, debe: base, haber: 0, concepto: concept, documento: doc, delegacion: h.code, departamento: dept }];
    if (rate !== 0) {
      lines.push({ cuenta: rate === 10 ? "4720010" : "4720021", debe: quota, haber: 0, concepto: `IVA soportado ${rate} %`, documento: doc, delegacion: h.code, base_iva: base, tipo_iva: String(rate), cuota_iva: quota, tipo_factura: "R" });
      vatRows.push({ libro: "recibidas", ejercicio: year, fecha: date, serie: "", numero: doc, nif: party.nif, nombre: party.nombre, pais: party.pais, base, tipo_iva: String(rate), cuota: quota, total, tipo_factura: "F1" });
    }
    lines.push({ cuenta, debe: 0, haber: total, concepto: party.nombre, documento: doc, delegacion: h.code, fecha_factura: date, nif: party.nif, nombre: party.nombre });
    schedule(date, lines);
    const month = Number(date.slice(5, 7));
    const payYear = month === 12 ? year + 1 : year;
    const payMonth = month === 12 ? 1 : month + 1;
    addPayable(h.code, iso(payYear, payMonth, 1).slice(0, 7), cuenta, total, party.nombre);
  };

  const emitted = (h: Centre, date: string, serie: string, numero: string, rows: Array<{ base: Cents; rate: 10 | 21; quota: Cents }>, tipo: string, nif: string | null, nombre: string | null): void => {
    for (const row of rows) {
      if (row.base === 0 && row.quota === 0) continue;
      vatRows.push({ libro: "emitidas", ejercicio: Number(date.slice(0, 4)), fecha: date, serie, numero, nif, nombre, pais: "ES", base: row.base, tipo_iva: String(row.rate), cuota: row.quota, total: row.base + row.quota, tipo_factura: tipo });
    }
    void h;
  };

  /** Nómina sintética de un centro: 640 / 642 por departamento contra 465 / 476; pago del neto el día 3 y de la SS a fin del mes siguiente. */
  const syntheticPayroll = (h: Centre, year: number, month: number, salaries: Cents): void => {
    const weights = h.office ? { ADM: 62, COM: 38 } : h.restaurant ? { HAB: 46, REST: 28, ADM: 12, MANT: 9, COM: 5 } : { HAB: 60, REST: 10, ADM: 15, MANT: 10, COM: 5 };
    const social = Math.round(salaries * (h.office ? 0.235 : 0.32));
    const depts = Object.keys(weights);
    const salaryParts = splitCents(salaries, Object.values(weights));
    const socialParts = splitCents(social, Object.values(weights));
    const date = iso(year, month, daysIn(year, month));
    const lines: JLine[] = [];
    depts.forEach((dept, i) => lines.push({ cuenta: "6400000", debe: salaryParts[i]!, haber: 0, concepto: `Nómina ${String(month).padStart(2, "0")}/${year} · ${dept}`, delegacion: h.code, departamento: dept }));
    depts.forEach((dept, i) => lines.push({ cuenta: "6420000", debe: socialParts[i]!, haber: 0, concepto: `Seguridad Social empresa ${String(month).padStart(2, "0")}/${year} · ${dept}`, delegacion: h.code, departamento: dept }));
    lines.push({ cuenta: "4650000", debe: 0, haber: salaries, concepto: `Nómina ${String(month).padStart(2, "0")}/${year}`, delegacion: h.code });
    lines.push({ cuenta: "4760000", debe: 0, haber: social, concepto: `Seguridad Social ${String(month).padStart(2, "0")}/${year}`, delegacion: h.code });
    schedule(date, lines, "nomina");
    schedulePayrollPayments(h, year, month, salaries, social);
  };
  const schedulePayrollPayments = (h: Centre, year: number, month: number, salaries: Cents, social: Cents): void => {
    const nextYear = month === 12 ? year + 1 : year;
    const nextMonth = month === 12 ? 1 : month + 1;
    schedule(iso(nextYear, nextMonth, 3), [
      { cuenta: "4650000", debe: salaries, haber: 0, concepto: `Pago nóminas ${String(month).padStart(2, "0")}/${year}`, delegacion: h.code },
      { cuenta: "5720000", debe: 0, haber: salaries, concepto: `Pago nóminas ${String(month).padStart(2, "0")}/${year}`, delegacion: h.code }
    ]);
    schedule(iso(nextYear, nextMonth, daysIn(nextYear, nextMonth)), [
      { cuenta: "4760000", debe: social, haber: 0, concepto: `Pago Seguridad Social ${String(month).padStart(2, "0")}/${year}`, delegacion: h.code },
      { cuenta: "5720000", debe: 0, haber: social, concepto: `Pago Seguridad Social ${String(month).padStart(2, "0")}/${year}`, delegacion: h.code }
    ]);
  };

  // Nómina nativa (reflejo): índice por (mes, centro).
  const nativePayroll = new Map<string, NativePayrollLine[]>();
  for (const row of native?.payroll ?? []) nativePayroll.set(`${row.month}|${row.property}`, [...(nativePayroll.get(`${row.month}|${row.property}`) ?? []), row]);
  const nativePayrollCentres = new Set([...nativePayroll.keys()].map((key) => key.split("|")[1]!));

  const revenueByCentreYear = new Map<string, Cents>();
  const payrollByCentreYear = new Map<string, Cents>();
  const bump = (map: Map<string, Cents>, key: string, delta: Cents): void => {
    map.set(key, (map.get(key) ?? 0) + delta);
  };

  /** Un mes de un hotel: ventas semanales, cobros, comisiones, facturas de proveedor, nómina y amortización. */
  const hotelMonth = (h: Centre, year: number, month: number): void => {
    const days = daysIn(year, month);
    const occ = occupancy(h, year, month);
    const roomsRev = cents(h.rooms * days * occ * h.adr);
    const fnbRev = Math.round(roomsRev * (h.restaurant ? 0.32 : 0.08) * noise(0.08));
    const otherRev = Math.round(roomsRev * 0.04 * noise(0.1));
    const parkRev = h.parking ? Math.round(roomsRev * 0.025 * noise(0.1)) : 0;
    const totalRev = roomsRev + fnbRev + otherRev + parkRev;
    bump(revenueByCentreYear, `${h.code}|${year}`, totalRev);
    const weeks: Array<[number, number]> = [[1, 7], [8, 14], [15, 21], [22, days]];
    const weights = weeks.map(([a, b]) => b - a + 1);
    const roomsW = splitCents(roomsRev, weights);
    const fnbW = splitCents(fnbRev, weights);
    const otherW = splitCents(otherRev, weights);
    const parkW = splitCents(parkRev, weights);
    weeks.forEach(([, end], w) => {
      const date = iso(year, month, end);
      const base10 = roomsW[w]! + fnbW[w]!;
      const base21 = otherW[w]! + parkW[w]!;
      const q10 = pct(base10, 10);
      const q21 = pct(base21, 21);
      const total = base10 + base21 + q10 + q21;
      const serie = `${h.code}${String(year).slice(2)}`;
      const numero = nextIssued(serie);
      const doc = `CJ-${h.code}-${year}-${String(month).padStart(2, "0")}-${w + 1}`;
      const lines: JLine[] = [
        { cuenta: h.customer, debe: total, haber: 0, concepto: `Ventas semana ${w + 1} ${String(month).padStart(2, "0")}/${year}`, documento: doc, delegacion: h.code },
        { cuenta: "7050001", debe: 0, haber: roomsW[w]!, concepto: "Alojamiento", documento: doc, delegacion: h.code, departamento: "HAB" },
        { cuenta: "7050002", debe: 0, haber: fnbW[w]!, concepto: "Restauración", documento: doc, delegacion: h.code, departamento: "REST" },
        { cuenta: "7050003", debe: 0, haber: otherW[w]!, concepto: "Otros servicios", documento: doc, delegacion: h.code, departamento: "OTROS" }
      ];
      if (parkW[w]! > 0) lines.push({ cuenta: "7050005", debe: 0, haber: parkW[w]!, concepto: "Parking", documento: doc, delegacion: h.code, departamento: "OTROS" });
      lines.push({ cuenta: "4770010", debe: 0, haber: q10, concepto: "IVA repercutido 10 %", documento: doc, delegacion: h.code, serie, factura: numero, base_iva: base10, tipo_iva: "10", cuota_iva: q10, tipo_factura: "E" });
      lines.push({ cuenta: "4770021", debe: 0, haber: q21, concepto: "IVA repercutido 21 %", documento: doc, delegacion: h.code, serie, factura: numero, base_iva: base21, tipo_iva: "21", cuota_iva: q21, tipo_factura: "E" });
      schedule(date, lines.filter((line) => line.debe > 0 || line.haber > 0));
      emitted(h, date, serie, numero, [{ base: base10, rate: 10, quota: q10 }, { base: base21, rate: 21, quota: q21 }], "F4", null, null);
      // Cobro tres días después: 80 % banco, 20 % datáfono (liquidado el día 5 del mes siguiente).
      const [bank, card] = splitCents(total, [80, 20]);
      const collectDate = addDays(date, 3);
      schedule(collectDate, [
        { cuenta: "5720000", debe: bank!, haber: 0, concepto: `Cobro ventas semana ${w + 1} ${String(month).padStart(2, "0")}/${year}`, documento: doc, delegacion: h.code },
        { cuenta: "5721000", debe: card!, haber: 0, concepto: `Cobro datáfono semana ${w + 1} ${String(month).padStart(2, "0")}/${year}`, documento: doc, delegacion: h.code },
        { cuenta: h.customer, debe: 0, haber: total, concepto: `Cobro ventas semana ${w + 1} ${String(month).padStart(2, "0")}/${year}`, documento: doc, delegacion: h.code }
      ]);
      const cardKey = `${h.code}|${collectDate.slice(0, 7)}`;
      cardTakings.set(cardKey, (cardTakings.get(cardKey) ?? 0) + card!);
    });
    // Liquidación del datáfono del mes anterior (día 5).
    const prevYear = month === 1 ? year - 1 : year;
    const prevMonth = month === 1 ? 12 : month - 1;
    const cardPrev = cardTakings.get(`${h.code}|${iso(prevYear, prevMonth, 1).slice(0, 7)}`) ?? 0;
    if (cardPrev > 0) {
      schedule(iso(year, month, 5), [
        { cuenta: "5720000", debe: cardPrev, haber: 0, concepto: `Liquidación datáfono ${String(prevMonth).padStart(2, "0")}/${prevYear}`, delegacion: h.code },
        { cuenta: "5721000", debe: 0, haber: cardPrev, concepto: `Liquidación datáfono ${String(prevMonth).padStart(2, "0")}/${prevYear}`, delegacion: h.code }
      ]);
    }
    // Factura mensual a una agencia (F1 con NIF, cobro a 32 días).
    const agency = h.code === "FN" ? PARTY_BY_ACCOUNT.get("4300000202")! : ["RA", "LT", "MC"].includes(h.code) ? PARTY_BY_ACCOUNT.get("4300000201")! : null;
    if (agency) {
      const base = Math.round(roomsRev * 0.12 * noise(0.1));
      const quota = pct(base, 10);
      const date = iso(year, month, 28);
      const serie = `FA${String(year).slice(2)}`;
      const numero = nextIssued(serie);
      schedule(date, [
        { cuenta: agency.cuenta, debe: base + quota, haber: 0, concepto: `Factura agencia ${agency.nombre} ${String(month).padStart(2, "0")}/${year}`, documento: `${serie}-${numero}`, delegacion: h.code, serie, factura: numero, fecha_factura: date, nif: agency.nif, nombre: agency.nombre },
        { cuenta: "7050001", debe: 0, haber: base, concepto: "Alojamiento agencia", documento: `${serie}-${numero}`, delegacion: h.code, departamento: "HAB" },
        { cuenta: "4770010", debe: 0, haber: quota, concepto: "IVA repercutido 10 %", documento: `${serie}-${numero}`, delegacion: h.code, serie, factura: numero, base_iva: base, tipo_iva: "10", cuota_iva: quota, tipo_factura: "E" }
      ]);
      emitted(h, date, serie, numero, [{ base, rate: 10, quota }], "F1", agency.nif, agency.nombre);
      schedule(addDays(date, 32), [
        { cuenta: "5720000", debe: base + quota, haber: 0, concepto: `Cobro ${serie}-${numero} ${agency.nombre}`, delegacion: h.code },
        { cuenta: agency.cuenta, debe: 0, haber: base + quota, concepto: `Cobro ${serie}-${numero} ${agency.nombre}`, delegacion: h.code }
      ]);
      bump(revenueByCentreYear, `${h.code}|${year}`, base);
    }
    // Alquiler de un local en Rías Altas (752).
    if (h.code === "RA") {
      const tenant = PARTY_BY_ACCOUNT.get("4300000203")!;
      const base = cents(1_200);
      const quota = pct(base, 21);
      const date = iso(year, month, 1);
      const serie = `AL${String(year).slice(2)}`;
      const numero = nextIssued(serie);
      schedule(date, [
        { cuenta: tenant.cuenta, debe: base + quota, haber: 0, concepto: `Alquiler local ${String(month).padStart(2, "0")}/${year}`, documento: `${serie}-${numero}`, delegacion: h.code, serie, factura: numero, fecha_factura: date, nif: tenant.nif, nombre: tenant.nombre },
        { cuenta: "7520000", debe: 0, haber: base, concepto: "Ingresos por arrendamiento del local", documento: `${serie}-${numero}`, delegacion: h.code },
        { cuenta: "4770021", debe: 0, haber: quota, concepto: "IVA repercutido 21 %", documento: `${serie}-${numero}`, delegacion: h.code, serie, factura: numero, base_iva: base, tipo_iva: "21", cuota_iva: quota, tipo_factura: "E" }
      ]);
      emitted(h, date, serie, numero, [{ base, rate: 21, quota }], "F1", tenant.nif, tenant.nombre);
      schedule(addDays(date, 15), [
        { cuenta: "5720000", debe: base + quota, haber: 0, concepto: `Cobro alquiler ${serie}-${numero}`, delegacion: h.code },
        { cuenta: tenant.cuenta, debe: 0, haber: base + quota, concepto: `Cobro alquiler ${serie}-${numero}`, delegacion: h.code }
      ]);
    }
    // Comisión OTA del mes (acreedor; se paga en la remesa del mes siguiente).
    supplierInvoice(h, iso(year, month, days), "4100000001", "6290001", "COM", Math.round(roomsRev * 0.06 * noise(0.06)), 21, `Comisiones de reservas ${String(month).padStart(2, "0")}/${year}`);
    // Suministros y servicios.
    const winter = [1, 2, 11, 12].includes(month) ? 1.2 : [6, 7, 8].includes(month) ? 0.85 : 1;
    supplierInvoice(h, iso(year, month, pick(3, 9)), "4000000001", "6280001", "MANT", Math.round(totalRev * 0.032 * winter * noise(0.08)), 21, `Electricidad ${String(month).padStart(2, "0")}/${year}`);
    supplierInvoice(h, iso(year, month, pick(4, 12)), "4000000002", "6280002", "MANT", Math.round(totalRev * 0.005 * noise(0.1)), 10, `Agua ${String(month).padStart(2, "0")}/${year}`);
    supplierInvoice(h, iso(year, month, pick(5, 14)), "4000000003", "6280003", "MANT", Math.round(totalRev * 0.011 * (winter === 1.2 ? 1.4 : winter === 0.85 ? 0.6 : 1) * noise(0.1)), 21, `Gas ${String(month).padStart(2, "0")}/${year}`);
    supplierInvoice(h, iso(year, month, pick(2, 6)), "4000000007", "6280004", "ADM", Math.round(totalRev * 0.0025 * noise(0.05)), 21, `Telecomunicaciones ${String(month).padStart(2, "0")}/${year}`);
    supplierInvoice(h, iso(year, month, pick(10, 20)), "4000000004", "6290002", "HAB", Math.round(roomsRev * 0.02 * noise(0.08)), 21, `Lavandería ${String(month).padStart(2, "0")}/${year}`);
    if (h.outsourcedCleaning) supplierInvoice(h, iso(year, month, pick(20, 28)), "4000000008", "6290004", "HAB", Math.round(roomsRev * 0.013 * noise(0.06)), 21, `Limpieza externa ${String(month).padStart(2, "0")}/${year}`);
    if (fnbRev > 0) {
      supplierInvoice(h, iso(year, month, pick(6, 16)), "4000000005", "6010001", "REST", Math.round(fnbRev * 0.3 * noise(0.08)), 10, `Compras de alimentos ${String(month).padStart(2, "0")}/${year}`);
      supplierInvoice(h, iso(year, month, pick(8, 22)), "4000000006", "6010002", "REST", Math.round(fnbRev * 0.09 * noise(0.1)), 21, `Compras de bebidas ${String(month).padStart(2, "0")}/${year}`);
    }
    supplierInvoice(h, iso(year, month, pick(1, 5)), "4000000009", "6220001", "MANT", cents(h.rooms * 3.5), 21, `Contrato de mantenimiento ${String(month).padStart(2, "0")}/${year}`);
    const repairs = pick(0, 2);
    for (let r = 0; r < repairs; r++) supplierInvoice(h, iso(year, month, pick(7, 26)), "4000000009", "6220000", "MANT", cents(pick(300, 2500)), 21, `Reparación ${r + 1} ${String(month).padStart(2, "0")}/${year}`);
    supplierInvoice(h, iso(year, month, pick(12, 24)), "4000000010", "6270000", "COM", Math.round(totalRev * 0.006 * noise(0.15)), 21, `Publicidad ${String(month).padStart(2, "0")}/${year}`);
    supplierInvoice(h, iso(year, month, 2), "4000000011", "6290003", "ADM", cents(450), 21, `Licencias de software ${String(month).padStart(2, "0")}/${year}`);
    if ([1, 4, 7, 10].includes(month)) supplierInvoice(h, iso(year, month, 10), "4000000012", "6290005", "ADM", cents(300), 21, `Cuota asociativa trimestre ${Math.floor((month - 1) / 3) + 1}/${year}`);
    if (month === 10) {
      const ibi = cents(h.rooms * 45);
      schedule(iso(year, month, 15), [
        { cuenta: "6310000", debe: ibi, haber: 0, concepto: `IBI ${year}`, delegacion: h.code, departamento: "ADM" },
        { cuenta: "5720000", debe: 0, haber: ibi, concepto: `Pago IBI ${year}`, delegacion: h.code }
      ]);
    }
    // Nómina: reflejo del lote nativo cuando existe (2026, seis centros), sintética en el resto.
    const monthKey = iso(year, month, 1).slice(0, 7);
    const nativeRows = nativePayroll.get(`${monthKey}|${h.code}`);
    if (nativeRows && nativeRows.length > 0) {
      nativePayrollFromDb(h, year, month, nativeRows);
    } else {
      const salaries = Math.round(totalRev * 0.215 * noise(0.04));
      syntheticPayroll(h, year, month, salaries);
      bump(payrollByCentreYear, `${h.code}|${year}`, salaries + Math.round(salaries * 0.32));
    }
    // Amortización mensual.
    const fa = fixedAssets(h);
    const amort = [Math.round(fa.buildings * 0.02 / 12), Math.round(fa.machinery * 0.1 / 12), Math.round(fa.furniture * 0.1 / 12), Math.round(fa.it * 0.25 / 12)];
    const amortTotal = amort.reduce((a, b) => a + b, 0);
    schedule(iso(year, month, days), [
      { cuenta: "6810000", debe: amortTotal, haber: 0, concepto: `Amortización ${String(month).padStart(2, "0")}/${year}`, delegacion: h.code },
      { cuenta: "2811000", debe: 0, haber: amort[0]!, concepto: "Amortización construcciones", delegacion: h.code },
      { cuenta: "2813000", debe: 0, haber: amort[1]!, concepto: "Amortización maquinaria", delegacion: h.code },
      { cuenta: "2816000", debe: 0, haber: amort[2]!, concepto: "Amortización mobiliario", delegacion: h.code },
      { cuenta: "2817000", debe: 0, haber: amort[3]!, concepto: "Amortización equipos informáticos", delegacion: h.code }
    ], "normal", 6);
  };

  /** Devengo de nómina con las cifras EXACTAS del lote de coste de personal de Anfitorio (reflejo en modo sombra). */
  const nativePayrollFromDb = (h: Centre, year: number, month: number, rows: NativePayrollLine[]): void => {
    const date = iso(year, month, daysIn(year, month));
    const lines: JLine[] = [];
    let salaries = 0;
    let social = 0;
    for (const row of rows.filter((r) => r.account === "640" || r.account === "642")) {
      const dept = row.costCentre ? COST_CENTRE_TO_DEPT[row.costCentre] ?? "ADM" : "ADM";
      lines.push({ cuenta: NATIVE_TO_SAGE[row.account]!, debe: row.debit - row.credit, haber: 0, concepto: `${row.account === "640" ? "Nómina" : "Seguridad Social empresa"} ${String(month).padStart(2, "0")}/${year} · ${dept}`, delegacion: h.code, departamento: dept });
      if (row.account === "640") salaries += row.debit - row.credit;
      else social += row.debit - row.credit;
    }
    for (const row of rows.filter((r) => r.account === "465" || r.account === "476")) {
      lines.push({ cuenta: NATIVE_TO_SAGE[row.account]!, debe: 0, haber: row.credit - row.debit, concepto: `${row.account === "465" ? "Nómina" : "Seguridad Social"} ${String(month).padStart(2, "0")}/${year}`, delegacion: h.code });
    }
    schedule(date, lines, "nomina-nativa");
    schedulePayrollPayments(h, year, month, salaries, social);
    bump(payrollByCentreYear, `${h.code}|${year}`, salaries + social);
  };

  /** Un mes de la oficina central: préstamo, gestoría, alquiler, software, comisiones bancarias (sin delegación), nómina y amortización. */
  const officeMonth = (year: number, month: number): void => {
    const oc = CENTRES.find((c) => c.office)!;
    const days = daysIn(year, month);
    const interest = Math.round((loanOutstanding * 0.04) / 12);
    const principal = cents(20_000);
    schedule(iso(year, month, 1), [
      { cuenta: "1700000", debe: principal, haber: 0, concepto: `Cuota préstamo ${String(month).padStart(2, "0")}/${year} · amortización`, delegacion: OFFICE },
      { cuenta: "6620000", debe: interest, haber: 0, concepto: `Cuota préstamo ${String(month).padStart(2, "0")}/${year} · intereses`, delegacion: OFFICE, departamento: "ADM" },
      { cuenta: "5720000", debe: 0, haber: principal + interest, concepto: `Cuota préstamo ${String(month).padStart(2, "0")}/${year}`, delegacion: OFFICE }
    ]);
    loanOutstanding -= principal;
    supplierInvoice(oc, iso(year, month, 5), "4100000003", "6230000", "ADM", cents(1_800), 21, `Asesoría fiscal y laboral ${String(month).padStart(2, "0")}/${year}`);
    supplierInvoice(oc, iso(year, month, 1), "4100000004", "6210000", "ADM", cents(3_200), 21, `Alquiler oficina ${String(month).padStart(2, "0")}/${year}`);
    supplierInvoice(oc, iso(year, month, 2), "4000000011", "6290003", "ADM", cents(1_900), 21, `Licencias de software corporativas ${String(month).padStart(2, "0")}/${year}`);
    // Comisiones bancarias SIN delegación: apunte 6/7 sin analítica → política «office» del mapa analítico.
    const fees = cents(240);
    schedule(iso(year, month, 15), [
      { cuenta: "6260000", debe: fees, haber: 0, concepto: `Comisiones bancarias ${String(month).padStart(2, "0")}/${year}` },
      { cuenta: "5720000", debe: 0, haber: fees, concepto: `Comisiones bancarias ${String(month).padStart(2, "0")}/${year}` }
    ]);
    const monthKey = iso(year, month, 1).slice(0, 7);
    const nativeRows = nativePayroll.get(`${monthKey}|${OFFICE}`);
    if (nativeRows && nativeRows.length > 0) nativePayrollFromDb(oc, year, month, nativeRows);
    else {
      const salaries = Math.round(cents(84_000) * (year === 2024 ? 0.97 : 1) * noise(0.03));
      syntheticPayroll(oc, year, month, salaries);
      bump(payrollByCentreYear, `${OFFICE}|${year}`, salaries + Math.round(salaries * 0.235));
    }
    const amort = Math.round((cents(40_000) * 0.25) / 12);
    schedule(iso(year, month, days), [
      { cuenta: "6810000", debe: amort, haber: 0, concepto: `Amortización ${String(month).padStart(2, "0")}/${year}`, delegacion: OFFICE },
      { cuenta: "2817000", debe: 0, haber: amort, concepto: "Amortización equipos informáticos", delegacion: OFFICE }
    ], "normal", 6);
    // Seguro trimestral: UN asiento con gasto en los ocho centros (reparto por centro en Anfitorio) y el acreedor sin delegación.
    if ([1, 4, 7, 10].includes(month)) {
      const date = iso(year, month, 1);
      const lines: JLine[] = [];
      let total = 0;
      for (const h of HOTELS) {
        const premium = cents(h.rooms * 9);
        total += premium;
        lines.push({ cuenta: "6250000", debe: premium, haber: 0, concepto: `Seguro multirriesgo trimestre ${Math.floor((month - 1) / 3) + 1}/${year} · ${h.code}`, delegacion: h.code, departamento: "ADM" });
      }
      const officePremium = cents(900);
      total += officePremium;
      lines.push({ cuenta: "6250000", debe: officePremium, haber: 0, concepto: `Seguro trimestre ${Math.floor((month - 1) / 3) + 1}/${year} · oficina`, delegacion: OFFICE, departamento: "ADM" });
      const insurer = PARTY_BY_ACCOUNT.get("4100000002")!;
      const doc = nextSupplierDoc(insurer.cuenta, year);
      lines.push({ cuenta: insurer.cuenta, debe: 0, haber: total, concepto: insurer.nombre, documento: doc, fecha_factura: date, nif: insurer.nif, nombre: insurer.nombre });
      schedule(date, lines);
      schedule(iso(year, month, 15), [
        { cuenta: insurer.cuenta, debe: total, haber: 0, concepto: `Pago seguro ${doc}`, documento: doc },
        { cuenta: "5720000", debe: 0, haber: total, concepto: `Pago seguro ${doc}`, delegacion: OFFICE }
      ]);
    }
  };

  /** Remesa del día 25: paga las facturas de proveedor / acreedor del mes anterior de cada centro. */
  const remittances = (year: number, month: number): void => {
    for (const c of CENTRES) {
      const due = payables.get(`${c.code}|${iso(year, month, 1).slice(0, 7)}`) ?? [];
      if (due.length === 0) continue;
      const bySupplier = new Map<string, Cents>();
      for (const item of due) bySupplier.set(item.cuenta, (bySupplier.get(item.cuenta) ?? 0) + item.total);
      const lines: JLine[] = [];
      let total = 0;
      for (const [cuenta, amount] of bySupplier) {
        lines.push({ cuenta, debe: amount, haber: 0, concepto: `Remesa ${String(month).padStart(2, "0")}/${year} · ${PARTY_BY_ACCOUNT.get(cuenta)?.nombre ?? cuenta}`, delegacion: c.code });
        total += amount;
      }
      lines.push({ cuenta: "5720000", debe: 0, haber: total, concepto: `Remesa de pagos ${String(month).padStart(2, "0")}/${year}`, delegacion: c.code });
      schedule(iso(year, month, 25), lines);
    }
  };

  // Reflejo de facturas y cobros nativos de Anfitorio (modo sombra): mismas cifras, serie + número en el asiento.
  const nativeDocuments = (year: number, month: number): void => {
    for (const doc of native?.documents ?? []) {
      if (doc.entryDate.slice(0, 7) !== iso(year, month, 1).slice(0, 7)) continue;
      const number = doc.invoiceNumber ?? "";
      const dash = number.lastIndexOf("-");
      const serie = dash > 0 ? number.slice(0, dash) : null;
      const serial = dash > 0 ? number.slice(dash + 1) : null;
      const isInvoice = doc.sourceType.startsWith("invoice");
      const lines: JLine[] = doc.lines.map((line) => {
        const cuenta = NATIVE_TO_SAGE[line.account];
        if (!cuenta) throw new Error(`Cuenta nativa sin reflejo en Sage: ${line.account}`);
        const vat = /^(472|477)/.test(line.account);
        return {
          cuenta,
          debe: line.debit,
          haber: line.credit,
          // El cobro no cita la factura: se excluye por importe y fecha (± 3 días) contra el cobro nativo (heurística SD-04).
          concepto: isInvoice ? `Factura ${number} (emitida por Anfitorio)` : `Cobro TPV ${ddmmyyyy(doc.entryDate)}`,
          documento: isInvoice ? number || null : null,
          delegacion: doc.property,
          departamento: line.account.startsWith("705") ? "HAB" : null,
          ...(isInvoice && line.account.startsWith("43") ? { serie, factura: serial, fecha_factura: doc.entryDate } : {}),
          ...(vat ? { serie, factura: serial, base_iva: line.taxBase, tipo_iva: line.taxRate, cuota_iva: Math.max(line.debit, line.credit), tipo_factura: "E" } : {})
        };
      });
      schedule(doc.entryDate, lines, "nativo-anfitorio", 4);
      if (isInvoice && serie && serial) {
        for (const line of doc.lines.filter((l) => /^477/.test(l.account))) {
          vatRows.push({ libro: "emitidas", ejercicio: year, fecha: doc.entryDate, serie, numero: serial, nif: null, nombre: null, pais: "ES", base: line.taxBase ?? 0, tipo_iva: line.taxRate ?? "0", cuota: line.credit - line.debit, total: (line.taxBase ?? 0) + line.credit - line.debit, tipo_factura: "F1", nativo: true });
        }
      }
    }
  };

  // ---- Bucle principal: mes a mes desde 2024-01 hasta 2026-07 ----
  const vatByQuarter: Record<string, { rep10: Cents; rep21: Cents; sop10: Cents; sop21: Cents; net: Cents }> = {};
  const resultByYear: Record<string, Cents> = {};
  const taxByYear: Record<string, Cents> = {};
  const sumOf = (prefix: string, filter?: (key: string) => boolean): Cents => [...balance].filter(([key]) => key.startsWith(prefix) && (!filter || filter(key))).reduce((sum, [, value]) => sum + value, 0);

  for (let year = START_YEAR; year <= END.year; year++) {
    asiento = 0;
    // Apertura del ejercicio: saldos 1-5 vivos (el de 2024 es el balance inicial construido a mano).
    const opening = new Map([...balance].filter(([, value]) => value !== 0));
    openings.set(year, opening);
    const openingLines: JLine[] = [...opening]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => {
        const [cuenta, delegacion] = key.split("|") as [string, string];
        return { cuenta, debe: value > 0 ? value : 0, haber: value < 0 ? -value : 0, concepto: `Apertura ${year}`, delegacion: delegacion || null };
      });
    balance.clear();
    post(year, 1, iso(year, 1, 1), "Apertura", "apertura", openingLines, false);

    const lastMonth = year === END.year ? END.month : 12;
    for (let month = 1; month <= lastMonth; month++) {
      for (const h of HOTELS) hotelMonth(h, year, month);
      officeMonth(year, month);
      remittances(year, month);
      nativeDocuments(year, month);
      // Aplicación del resultado del ejercicio anterior (30 de junio).
      if (month === 6) {
        const result129 = balance.get(balanceKey("1290000", OFFICE)) ?? 0;
        if (result129 < 0) {
          schedule(iso(year, 6, 30), [
            { cuenta: "1290000", debe: -result129, haber: 0, concepto: `Aplicación del resultado ${year - 1} a reservas voluntarias`, delegacion: OFFICE },
            { cuenta: "1130000", debe: 0, haber: -result129, concepto: `Aplicación del resultado ${year - 1} a reservas voluntarias`, delegacion: OFFICE }
          ], "normal", 3);
        }
      }
      // Pago del impuesto sobre sociedades del ejercicio anterior (25 de julio).
      if (month === 7) {
        const pending = -(balance.get(balanceKey("4752000", OFFICE)) ?? 0);
        if (pending > 0) {
          schedule(iso(year, 7, 25), [
            { cuenta: "4752000", debe: pending, haber: 0, concepto: `Pago impuesto sobre sociedades ${year - 1}`, delegacion: OFFICE },
            { cuenta: "5720000", debe: 0, haber: pending, concepto: `Pago impuesto sobre sociedades ${year - 1}`, delegacion: OFFICE }
          ], "normal", 3);
        }
      }
      // Contabiliza los eventos del mes en orden de fecha.
      const monthKey = iso(year, month, 1).slice(0, 7);
      const due = events.filter((event) => event.date.slice(0, 7) === monthKey).sort((a, b) => a.date.localeCompare(b.date) || a.prio - b.prio || a.seq - b.seq);
      for (const event of due) post(year, month, event.date, String(month), event.tag, event.lines, true);
      // Liquidación trimestral del IVA (último día del trimestre, nivel sociedad).
      if (month % 3 === 0) {
        const rep10 = -sumOf("4770010|");
        const rep21 = -sumOf("4770021|");
        const sop10 = sumOf("4720010|");
        const sop21 = sumOf("4720021|");
        const net = rep10 + rep21 - sop10 - sop21;
        const q = `${year}-Q${month / 3}`;
        vatByQuarter[q] = { rep10, rep21, sop10, sop21, net };
        const lines: JLine[] = [
          { cuenta: "4770010", debe: rep10, haber: 0, concepto: `Liquidación IVA ${q}` },
          { cuenta: "4770021", debe: rep21, haber: 0, concepto: `Liquidación IVA ${q}` },
          { cuenta: "4720010", debe: 0, haber: sop10, concepto: `Liquidación IVA ${q}` },
          { cuenta: "4720021", debe: 0, haber: sop21, concepto: `Liquidación IVA ${q}` },
          net >= 0 ? { cuenta: "4750000", debe: 0, haber: net, concepto: `Liquidación IVA ${q} · a ingresar` } : { cuenta: "4700000", debe: -net, haber: 0, concepto: `Liquidación IVA ${q} · a compensar` }
        ];
        post(year, month, iso(year, month, daysIn(year, month)), String(month), "iva", lines.filter((line) => line.debe > 0 || line.haber > 0), true);
        if (net > 0) {
          const payYear = month === 12 ? year + 1 : year;
          const payMonth = month === 12 ? 1 : month + 1;
          schedule(iso(payYear, payMonth, 20), [
            { cuenta: "4750000", debe: net, haber: 0, concepto: `Pago liquidación IVA ${q}`, delegacion: OFFICE },
            { cuenta: "5720000", debe: 0, haber: net, concepto: `Pago liquidación IVA ${q}`, delegacion: OFFICE }
          ]);
        }
      }
      // Saldos a fin de mes (antes de regularización / cierre) para las sumas y saldos.
      for (const [key, value] of balance) if (value !== 0) closingByMonth.set(`${monthKey}|${key}`, value);
    }

    if (year === END.year) break;

    // Provisión del impuesto sobre sociedades (25 % del resultado antes de impuestos, si es positivo).
    const income = -sumOf("7");
    const expenses = sumOf("6");
    const pretax = income - expenses;
    const tax = pretax > 0 ? Math.round(pretax * 0.25) : 0;
    taxByYear[String(year)] = tax;
    if (tax > 0) {
      post(year, 12, iso(year, 12, 31), "12", "normal", [
        { cuenta: "6300000", debe: tax, haber: 0, concepto: `Impuesto sobre beneficios ${year}`, delegacion: OFFICE, departamento: "ADM" },
        { cuenta: "4752000", debe: 0, haber: tax, concepto: `Impuesto sobre beneficios ${year}`, delegacion: OFFICE }
      ], true);
      for (const [key, value] of balance) if (value !== 0) closingByMonth.set(`${iso(year, 12, 1).slice(0, 7)}|${key}`, value);
    }
    // Regularización («Cierre ejercicio» de Sage): 6/7 contra 129.
    const pnl = [...balance].filter(([key, value]) => isPnlAccount(key) && value !== 0).sort(([a], [b]) => a.localeCompare(b));
    const result = pnl.reduce((sum, [, value]) => sum - value, 0);
    resultByYear[String(year)] = result;
    const regLines: JLine[] = pnl.map(([key, value]) => {
      const [cuenta, delegacion] = key.split("|") as [string, string];
      return { cuenta, debe: value < 0 ? -value : 0, haber: value > 0 ? value : 0, concepto: `Regularización ${year}`, delegacion: delegacion || null };
    });
    regLines.push({ cuenta: "1290000", debe: result < 0 ? -result : 0, haber: result > 0 ? result : 0, concepto: `Resultado del ejercicio ${year}`, delegacion: OFFICE });
    post(year, 12, iso(year, 12, 31), "Cierre ejercicio", "regularizacion", regLines, false);
    // Cierre («Cierre Contabilidad» de Sage): grupos 1-5 a cero.
    const closingLines: JLine[] = [...balance]
      .filter(([, value]) => value !== 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => {
        const [cuenta, delegacion] = key.split("|") as [string, string];
        return { cuenta, debe: value < 0 ? -value : 0, haber: value > 0 ? value : 0, concepto: `Cierre ${year}`, delegacion: delegacion || null };
      });
    const preClosing = new Map([...balance].filter(([, value]) => value !== 0));
    post(year, 12, iso(year, 12, 31), "Cierre Contabilidad", "cierre", closingLines, false);
    for (const [key] of balance) balance.set(key, 0);
    for (const [key, value] of preClosing) balance.set(key, value);
  }

  const summary = {
    seed,
    centres: CENTRES.map((c) => c.code),
    entries: entries.length,
    lines: entries.reduce((sum, entry) => sum + entry.lines.length, 0),
    totalDebit: fmtEs(entries.reduce((sum, entry) => sum + entry.lines.reduce((s, l) => s + l.debe, 0), 0)),
    byYear: Object.fromEntries([2024, 2025, 2026].map((year) => [year, { entries: entries.filter((e) => e.ejercicio === year).length, lines: entries.filter((e) => e.ejercicio === year).reduce((sum, e) => sum + e.lines.length, 0) }])),
    resultByYear: Object.fromEntries(Object.entries(resultByYear).map(([year, value]) => [year, fmtEs(value)])),
    taxByYear: Object.fromEntries(Object.entries(taxByYear).map(([year, value]) => [year, fmtEs(value)])),
    vatByQuarter: Object.fromEntries(Object.entries(vatByQuarter).map(([q, v]) => [q, { repercutido10: fmtEs(v.rep10), repercutido21: fmtEs(v.rep21), soportado10: fmtEs(v.sop10), soportado21: fmtEs(v.sop21), resultado: fmtEs(v.net) }])),
    revenueByCentreYear: Object.fromEntries([...revenueByCentreYear].map(([key, value]) => [key, fmtEs(value)])),
    payrollByCentreYear: Object.fromEntries([...payrollByCentreYear].map(([key, value]) => [key, fmtEs(value)])),
    nativePayrollCentres: [...nativePayrollCentres].sort(),
    nativeDocuments: (native?.documents ?? []).map((doc) => ({ date: doc.entryDate, sourceType: doc.sourceType, invoiceNumber: doc.invoiceNumber, total: fmtEs(doc.lines.reduce((sum, line) => sum + line.debit, 0)) })),
    vatRows: vatRows.length
  };
  return { entries, vatRows, openings, movements, closingByMonth, summary };
}

// ---------------------------------------------------------------------------
// Escritores de ficheros
// ---------------------------------------------------------------------------

const JOURNAL_COLUMNS = ["empresa", "ejercicio", "asiento", "fecha", "periodo", "cuenta", "debe", "haber", "concepto", "documento", "canal", "delegacion", "departamento", "seccion", "proyecto", "serie", "factura", "fecha_factura", "nif", "nombre", "base_iva", "tipo_iva", "cuota_iva", "tipo_factura"] as const;
const BALANCE_COLUMNS = ["empresa", "ejercicio", "periodo", "cuenta", "titulo", "delegacion", "apertura_debe", "apertura_haber", "debe", "haber", "saldo_deudor", "saldo_acreedor"] as const;
const PLAN_COLUMNS = ["cuenta", "titulo", "nif", "pais", "longitud"] as const;
const THIRD_PARTY_COLUMNS = ["codigo", "rol", "cuenta", "nif", "pais", "nombre"] as const;
const VAT_COLUMNS = ["libro", "empresa", "ejercicio", "fecha", "fecha_operacion", "serie", "numero", "nif", "nombre", "pais", "base", "tipo_iva", "cuota", "total", "tipo_recargo", "cuota_recargo", "tipo_retencion", "retencion", "tipo_factura", "rectificativa"] as const;

function csvCell(value: string | null | undefined): string {
  const text = value ?? "";
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(header: readonly string[], rows: readonly (readonly (string | null | undefined)[])[]): string {
  return `\uFEFF${[header.join(";"), ...rows.map((row) => row.map(csvCell).join(";"))].join("\r\n")}\r\n`;
}

function journalRows(entries: readonly JEntry[]): string[][] {
  const rows: string[][] = [];
  for (const entry of entries) {
    for (const line of entry.lines) {
      rows.push([
        "1",
        String(entry.ejercicio),
        String(entry.asiento),
        entry.fecha,
        entry.periodo,
        line.cuenta,
        line.debe > 0 ? fmtEs(line.debe) : "",
        line.haber > 0 ? fmtEs(line.haber) : "",
        line.concepto,
        line.documento ?? "",
        "",
        line.delegacion ?? "",
        line.departamento ?? "",
        "",
        "",
        line.serie ?? "",
        line.factura ?? "",
        line.fecha_factura ?? "",
        line.nif ?? "",
        line.nombre ?? "",
        line.base_iva != null ? fmtEs(line.base_iva) : "",
        line.tipo_iva ?? "",
        line.cuota_iva != null ? fmtEs(line.cuota_iva) : "",
        line.tipo_factura ?? ""
      ]);
    }
  }
  return rows;
}

export function journalCsv(entries: readonly JEntry[]): string {
  return csv(JOURNAL_COLUMNS, journalRows(entries));
}

/** Diario en formato «Enviar a Excel» de Sage (cabeceras con sinónimos, fechas dd/mm/yyyy, celdas numéricas). */
export function journalXlsx(entries: readonly JEntry[]): Buffer {
  const header = ["Empresa", "Ejercicio", "Asiento", "Fecha asiento", "Periodo", "Cuenta", "Concepto", "Documento", "Debe", "Haber", "Delegación", "Departamento", "Serie", "Factura", "Fecha factura", "CIF/DNI", "Nombre", "Base IVA", "% IVA", "Cuota IVA", "Tipo factura"];
  const rows: XlsxCell[][] = [header.map((text) => ({ text, bold: true }))];
  for (const entry of entries) {
    for (const line of entry.lines) {
      rows.push([
        1,
        entry.ejercicio,
        entry.asiento,
        ddmmyyyy(entry.fecha),
        entry.periodo,
        line.cuenta,
        line.concepto,
        line.documento ?? null,
        line.debe > 0 ? { amount: fmtEn(line.debe) } : null,
        line.haber > 0 ? { amount: fmtEn(line.haber) } : null,
        line.delegacion ?? null,
        line.departamento ?? null,
        line.serie ?? null,
        line.factura ?? null,
        line.fecha_factura ? ddmmyyyy(line.fecha_factura) : null,
        line.nif ?? null,
        line.nombre ?? null,
        line.base_iva != null ? { amount: fmtEn(line.base_iva) } : null,
        line.tipo_iva != null ? Number(line.tipo_iva) : null,
        line.cuota_iva != null ? { amount: fmtEn(line.cuota_iva) } : null,
        line.tipo_factura ?? null
      ]);
    }
  }
  return writeXlsx([{ name: "Diario", rows, widths: [8, 9, 8, 12, 16, 12, 44, 18, 14, 14, 11, 13, 8, 8, 12, 12, 40, 12, 7, 12, 6] }], new Date("2026-09-17T09:00:00Z"));
}

/** Diario en CSV IME de 60 columnas (formato de importación de asientos de Sage 200). */
export function journalImeCsv(entries: readonly JEntry[]): string {
  const rows: string[][] = [];
  for (const entry of entries) {
    for (const line of entry.lines) {
      const row = new Map<string, string>();
      row.set("CodigoEmpresa", "1");
      row.set("Ejercicio", String(entry.ejercicio));
      row.set("Asiento", String(entry.asiento));
      row.set("CargoAbono", line.debe > 0 ? "D" : "H");
      row.set("CodigoCuenta", line.cuenta);
      row.set("FechaAsiento", ddmmyyyy(entry.fecha));
      row.set("DocumentoConta", line.documento ?? "");
      row.set("Comentario", line.concepto);
      row.set("ImporteAsiento", fmtEs(line.debe > 0 ? line.debe : line.haber));
      row.set("CodigoDiario", "0");
      row.set("CodigoDepartamento", line.departamento ?? "");
      row.set("IdDelegacion", line.delegacion ?? "");
      row.set("NumeroPeriodo", /^\d+$/.test(entry.periodo) ? entry.periodo : entry.periodo === "Apertura" ? "0" : entry.periodo === "Cierre ejercicio" ? "14" : "15");
      if (line.base_iva != null) row.set("BaseIva1", fmtEs(line.base_iva));
      if (line.tipo_iva) {
        row.set("CodigoIva1", `IVA${line.tipo_iva}`);
        row.set("PorIva1", line.tipo_iva);
      }
      if (line.cuota_iva != null) row.set("CuotaIva1", fmtEs(line.cuota_iva));
      row.set("Serie", line.serie ?? "");
      row.set("Factura", line.factura ?? "");
      row.set("FechaFactura", line.fecha_factura ? ddmmyyyy(line.fecha_factura) : "");
      row.set("TipoFactura", line.tipo_factura ?? "");
      row.set("CifDni", line.nif ?? "");
      row.set("Nombre", line.nombre ?? "");
      row.set("SiglaNacion", line.nif ? "ES" : "");
      rows.push(SAGE_IME_COLUMNS.map((column) => row.get(column) ?? ""));
    }
  }
  return `\uFEFF${[SAGE_IME_COLUMNS.join(";"), ...rows.map((row) => row.map(csvCell).join(";"))].join("\r\n")}\r\n`;
}

export function planCsv(): string {
  const rows = [
    ...SAGE_PLAN.map((row) => [row.cuenta, row.titulo, "", "", String(row.cuenta.length)]),
    ...THIRD_PARTIES.map((party) => [party.cuenta, party.titulo, party.nif ?? "", party.nif ? party.pais : "", String(party.cuenta.length)])
  ].sort((a, b) => a[0]!.localeCompare(b[0]!));
  return csv(PLAN_COLUMNS, rows);
}

export function planXlsx(): Buffer {
  const rows: XlsxCell[][] = [["Código cuenta", "Descripción", "CIF/DNI", "Sigla nación", "Longitud"].map((text) => ({ text, bold: true }))];
  const all = [
    ...SAGE_PLAN.map((row) => ({ cuenta: row.cuenta, titulo: row.titulo, nif: "", pais: "" })),
    ...THIRD_PARTIES.map((party) => ({ cuenta: party.cuenta, titulo: party.titulo, nif: party.nif ?? "", pais: party.nif ? party.pais : "" }))
  ].sort((a, b) => a.cuenta.localeCompare(b.cuenta));
  for (const row of all) rows.push([row.cuenta, row.titulo, row.nif || null, row.pais || null, row.cuenta.length]);
  return writeXlsx([{ name: "Plan de cuentas", rows, widths: [14, 56, 12, 8, 8] }], new Date("2026-09-17T09:00:00Z"));
}

export function thirdPartiesCsv(): string {
  return csv(THIRD_PARTY_COLUMNS, THIRD_PARTIES.map((party) => [party.codigo, party.rol, party.cuenta, party.nif ?? "", party.pais, party.nombre]));
}

export function thirdPartiesXlsx(): Buffer {
  const rows: XlsxCell[][] = [["Código", "Razón social", "Código contable", "CIF/DNI", "Sigla nación", "Tipo"].map((text) => ({ text, bold: true }))];
  for (const party of THIRD_PARTIES) rows.push([party.codigo, party.nombre, party.cuenta, party.nif, party.pais, party.rol === "customer" ? "Cliente" : "Proveedor"]);
  return writeXlsx([{ name: "Clientes y proveedores", rows, widths: [8, 44, 14, 12, 8, 10] }], new Date("2026-09-17T09:00:00Z"));
}

export function vatCsv(rows: readonly VatRow[]): string {
  return csv(
    VAT_COLUMNS,
    rows.map((row) => [row.libro, "1", String(row.ejercicio), row.fecha, "", row.serie, row.numero, row.nif ?? "", row.nombre ?? "", row.pais, fmtEs(row.base), row.tipo_iva, fmtEs(row.cuota), fmtEs(row.total), "", "", "", "", row.tipo_factura, "no"])
  );
}

type BalanceLine = { periodo: string; cuenta: string; delegacion: string; apertura: Cents; debe: Cents; haber: Cents; saldo: Cents; previous: Cents };

/** Filas de sumas y saldos por (cuenta, delegación) y periodo: apertura del ejercicio, Debe / Haber del periodo, saldo acumulado al cierre del periodo. */
export function balanceLines(sim: SimulationResult, year: number, periods: readonly string[], annual: boolean, onlyDelegacion?: string): BalanceLine[] {
  const opening = sim.openings.get(year) ?? new Map<string, Cents>();
  const keys = new Set<string>();
  for (const key of opening.keys()) keys.add(key);
  for (const key of sim.movements.keys()) if (key.startsWith(`${year}-`)) keys.add(key.slice(8));
  const out: BalanceLine[] = [];
  for (const key of [...keys].sort()) {
    const [cuenta, delegacion] = key.split("|") as [string, string];
    if (onlyDelegacion !== undefined && delegacion !== onlyDelegacion) continue;
    const apertura = opening.get(key) ?? 0;
    let running = apertura;
    let previous = apertura;
    if (annual) {
      let debe = 0;
      let haber = 0;
      for (const period of periods) {
        const mov = sim.movements.get(`${period}|${key}`);
        debe += mov?.debe ?? 0;
        haber += mov?.haber ?? 0;
      }
      if (apertura === 0 && debe === 0 && haber === 0) continue;
      out.push({ periodo: String(year), cuenta, delegacion, apertura, debe, haber, saldo: apertura + debe - haber, previous: apertura });
      continue;
    }
    const monthly: BalanceLine[] = [];
    let any = apertura !== 0;
    for (const period of periods) {
      const mov = sim.movements.get(`${period}|${key}`) ?? { debe: 0, haber: 0 };
      previous = running;
      running += mov.debe - mov.haber;
      if (mov.debe !== 0 || mov.haber !== 0) any = true;
      monthly.push({ periodo: period, cuenta, delegacion, apertura, debe: mov.debe, haber: mov.haber, saldo: running, previous });
    }
    if (any) out.push(...monthly);
  }
  return out;
}

export function balanceCsv(lines: readonly BalanceLine[], year: number): string {
  return csv(
    BALANCE_COLUMNS,
    lines.map((line) => [
      "1",
      String(year),
      line.periodo,
      line.cuenta,
      titleOf(line.cuenta),
      line.delegacion,
      line.apertura > 0 ? fmtEs(line.apertura) : "0,00",
      line.apertura < 0 ? fmtEs(-line.apertura) : "0,00",
      fmtEs(line.debe),
      fmtEs(line.haber),
      line.saldo > 0 ? fmtEs(line.saldo) : "0,00",
      line.saldo < 0 ? fmtEs(-line.saldo) : "0,00"
    ])
  );
}

/** Sumas y saldos en formato Excel de Sage («Comparativo periodo acumulado»: sumas anteriores = acumulado hasta el periodo previo). */
export function balanceXlsx(lines: readonly BalanceLine[], year: number): Buffer {
  const header = ["Ejercicio", "Periodo", "Cuenta", "Título", "Delegación", "Sumas anteriores Debe", "Sumas anteriores Haber", "Debe", "Haber", "Saldo deudor", "Saldo acreedor"];
  const rows: XlsxCell[][] = [header.map((text) => ({ text, bold: true }))];
  for (const line of lines) {
    rows.push([
      year,
      line.periodo,
      line.cuenta,
      titleOf(line.cuenta),
      line.delegacion || null,
      { amount: fmtEn(line.previous > 0 ? line.previous : 0) },
      { amount: fmtEn(line.previous < 0 ? -line.previous : 0) },
      { amount: fmtEn(line.debe) },
      { amount: fmtEn(line.haber) },
      { amount: fmtEn(line.saldo > 0 ? line.saldo : 0) },
      { amount: fmtEn(line.saldo < 0 ? -line.saldo : 0) }
    ]);
  }
  const sheet: XlsxSheet = { name: "Sumas y saldos", rows, widths: [9, 9, 12, 48, 11, 16, 16, 14, 14, 14, 14] };
  return writeXlsx([sheet], new Date("2026-09-17T09:00:00Z"));
}

function readme(sim: SimulationResult, organization: string | null): string {
  const s = sim.summary as Record<string, unknown>;
  return [
    "# Dataset Sage 200 sintético · CELUISMA (Tanda 7c · L6)",
    "",
    `Generado por \`apps/api/src/scripts/generate-sage200-demo.ts\` (semilla ${String(s.seed)}${organization ? `, reflejo nativo de la organización ${organization}` : ", sin reflejo nativo"}). Empresa Sage \`1\`, delegaciones AS FN LL LT MC OC PG RA, departamentos HAB REST MANT ADM COM OTROS. Ningún NIF real: CIF sintéticos con dígito de control válido.`,
    "",
    "## Ficheros y orden de carga (CLI `sage200:import`)",
    "",
    "| # | Fichero | `--type` | Formato | Notas |",
    "|---|---|---|---|---|",
    "| 1 | `plan-cuentas.csv` (o `.xlsx`) | `plan` | canónico / `sage_excel` | crea 622.1, 629.5 y 705.5 (regla 6) y persiste el mapa de cuentas |",
    "| 2 | `ejercicios/apertura-2025.csv` | `fiscal_years` | canónico | crea el ejercicio 2025, 12 periodos y el asiento `opening` |",
    "| 3 | `diario/diario-2025-01.csv` … `diario-2025-12.csv` | `journal` | canónico | un lote por mes; `--unassigned office` para las comisiones bancarias sin delegación |",
    "| 4 | `diario/cierre-2025.csv` | `journal` | canónico | «Cierre ejercicio» → `regularization`, «Cierre Contabilidad» → `closing`; marca 2025 cerrado |",
    "| 5 | `libros-iva/libro-iva-2025-Q1..Q4.csv` | `vat_books` | canónico | exige la fila `vat_settings` |",
    "| 6 | `terceros.csv` (o `.xlsx`) | `third_parties` | canónico / `sage_excel` | `Supplier` solo con `options.createSuppliers` |",
    "| 7 | `sumas-y-saldos/sumas-y-saldos-2024.csv` | `balances` | canónico | ejercicio anterior SIN diario (§6): apertura + resumen anual por centro + regularización + cierre |",
    "| 8 | `sumas-y-saldos/sumas-y-saldos-2025.csv` | `--reconcile` suelto | canónico | reconciliación 2025-01-01 → 2025-12-31 |",
    "| 9 | `ejercicios/apertura-2026.csv` | `fiscal_years` | canónico | crea 2026 (los 112 asientos nativos ya llevan `fiscal_year_code` 2026) |",
    "| 10 | `diario/diario-2026-01.csv` … `diario-2026-07.csv` | `journal` | canónico | julio trae el reflejo de las facturas y cobros nativos → `skipped_native` |",
    "| 11 | `libros-iva/libro-iva-2026-Q1.csv`, `-Q2.csv`, `-Q3-parcial.csv` | `vat_books` | canónico | Q3 solo julio; la emitida nativa se omite (C1) |",
    "| 12 | `sumas-y-saldos/sumas-y-saldos-2026-ene-jul.csv` | `--reconcile` suelto | canónico | reconciliación 2026-01-01 → 2026-07-31 |",
    "",
    "Variantes del mismo contenido para probar los otros formatos: `diario/diario-2026-01.xlsx` («Enviar a Excel», mismo hash que el CSV de enero → 409 LEDGER_IMPORT_DUPLICATE tras cargar el CSV), `diario/diario-2026-02-ime.csv` (CSV IME de 60 columnas, mismo hash que el CSV de febrero), `sumas-y-saldos/sumas-y-saldos-2025.xlsx` (columnas «Sumas anteriores» = acumulado hasta el periodo previo, semántica Sage [S]) y `sumas-y-saldos/sumas-y-saldos-2025-RA.csv` (hoja de una sola delegación, para `--reconcile --property RA`).",
    "",
    "`diario/no-importar/nominas-2026-anfitorio.csv` contiene los devengos de nómina de AS LT MC OC PG RA (2026-01..07) con las cifras EXACTAS del lote de coste de personal de Anfitorio: Sage los tiene (y el balance de Sage los incluye), Anfitorio ya los devengó, así que NO se cargan (diseño §10.1-4). FN y LL no estaban en aquel lote y su nómina de Sage sí se importa.",
    "",
    "## Cifras esperadas (resumen.json)",
    "",
    "```json",
    JSON.stringify({ resultByYear: s.resultByYear, taxByYear: s.taxByYear, vatByQuarter: s.vatByQuarter, byYear: s.byYear }, null, 2),
    "```",
    ""
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------

export async function generate(flags: GeneratorFlags): Promise<{ out: string; files: string[]; summary: Record<string, unknown> }> {
  const out = resolvePath(flags.out);
  const native = flags.organization ? await readNativeMirror(flags.organization, iso(END.year, END.month, daysIn(END.year, END.month))) : null;
  const sim = simulate(flags.seed, native);
  const files: string[] = [];
  const write = (relative: string, content: string | Buffer): void => {
    const path = join(out, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    files.push(relative);
  };
  const monthsOf = (year: number, from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, i) => iso(year, from + i, 1).slice(0, 7));

  write("plan-cuentas.csv", planCsv());
  write("plan-cuentas.xlsx", planXlsx());
  write("terceros.csv", thirdPartiesCsv());
  write("terceros.xlsx", thirdPartiesXlsx());
  for (const year of [2025, 2026]) write(`ejercicios/apertura-${year}.csv`, journalCsv(sim.entries.filter((e) => e.ejercicio === year && e.tag === "apertura")));
  const monthlyEntries = (year: number, month: number, importable: boolean): JEntry[] =>
    sim.entries.filter((e) => e.ejercicio === year && e.fecha.slice(0, 7) === iso(year, month, 1).slice(0, 7) && !["apertura", "regularizacion", "cierre"].includes(e.tag) && (!importable || e.tag !== "nomina-nativa"));
  for (let month = 1; month <= 12; month++) write(`diario/diario-2025-${String(month).padStart(2, "0")}.csv`, journalCsv(monthlyEntries(2025, month, true)));
  write("diario/cierre-2025.csv", journalCsv(sim.entries.filter((e) => e.ejercicio === 2025 && (e.tag === "regularizacion" || e.tag === "cierre"))));
  for (let month = 1; month <= END.month; month++) write(`diario/diario-2026-${String(month).padStart(2, "0")}.csv`, journalCsv(monthlyEntries(2026, month, true)));
  write("diario/diario-2026-01.xlsx", journalXlsx(monthlyEntries(2026, 1, true)));
  write("diario/diario-2026-02-ime.csv", journalImeCsv(monthlyEntries(2026, 2, true)));
  write("diario/no-importar/nominas-2026-anfitorio.csv", journalCsv(sim.entries.filter((e) => e.ejercicio === 2026 && e.tag === "nomina-nativa")));
  const quarterOf = (row: VatRow): string => `${row.ejercicio}-Q${Math.floor((Number(row.fecha.slice(5, 7)) - 1) / 3) + 1}`;
  for (const q of ["2025-Q1", "2025-Q2", "2025-Q3", "2025-Q4", "2026-Q1", "2026-Q2"]) write(`libros-iva/libro-iva-${q}.csv`, vatCsv(sim.vatRows.filter((row) => quarterOf(row) === q).sort((a, b) => a.libro.localeCompare(b.libro) || a.fecha.localeCompare(b.fecha))));
  write("libros-iva/libro-iva-2026-Q3-parcial.csv", vatCsv(sim.vatRows.filter((row) => quarterOf(row) === "2026-Q3").sort((a, b) => a.libro.localeCompare(b.libro) || a.fecha.localeCompare(b.fecha))));
  write("sumas-y-saldos/sumas-y-saldos-2024.csv", balanceCsv(balanceLines(sim, 2024, monthsOf(2024, 1, 12), true), 2024));
  const lines2025 = balanceLines(sim, 2025, monthsOf(2025, 1, 12), false);
  write("sumas-y-saldos/sumas-y-saldos-2025.csv", balanceCsv(lines2025, 2025));
  write("sumas-y-saldos/sumas-y-saldos-2025.xlsx", balanceXlsx(lines2025, 2025));
  write("sumas-y-saldos/sumas-y-saldos-2025-RA.csv", balanceCsv(balanceLines(sim, 2025, monthsOf(2025, 1, 12), false, "RA"), 2025));
  write("sumas-y-saldos/sumas-y-saldos-2026-ene-jul.csv", balanceCsv(balanceLines(sim, 2026, monthsOf(2026, 1, END.month), false), 2026));
  const summary = { ...sim.summary, organization: flags.organization, out, files: files.length };
  write("resumen.json", `${JSON.stringify(summary, null, 2)}\n`);
  write("README.md", readme(sim, flags.organization));
  return { out, files, summary };
}

const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: GeneratorFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(`[sage200:demo] ${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (flags.help) {
    console.log(USAGE);
    process.exit(0);
  }
  generate(flags)
    .then((result) => {
      if (flags.json) console.log(JSON.stringify(result.summary, null, 2));
      else {
        console.log(`[sage200:demo] ${result.files.length} ficheros escritos en ${result.out}`);
        console.log(`  asientos ${String(result.summary.entries)} · apuntes ${String(result.summary.lines)} · Σ Debe ${String(result.summary.totalDebit)}`);
        console.log(`  resultado por ejercicio ${JSON.stringify(result.summary.resultByYear)} · IVA por trimestre ${JSON.stringify(result.summary.vatByQuarter)}`);
      }
      process.exit(0);
    })
    .catch((error) => {
      console.error("[sage200:demo] fallo:", error instanceof Error ? error.stack ?? error.message : error);
      process.exit(1);
    });
}

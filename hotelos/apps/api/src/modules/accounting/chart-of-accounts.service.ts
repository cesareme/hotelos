// Chart of accounts «PGC Pymes hotelero» (Finanzas · lote schema · 2026-09-15).
//
// Two things live here:
//
//   1. PGC_PYMES_HOTEL_TEMPLATE — the full template as DATA: PGC de Pymes
//      (RD 1515/2007 and later amendments) groups 1-7 with the official Spanish
//      names, the hotel sub-accounts the canonical posting rules use (705.1..4,
//      477.21/10/04, 472.21/10/04, 5721/5722, 629.1, 4759, 640.x/642.x by
//      department…) and, for every P&L account, its default USALI (11th ed.)
//      department + line. Balance-sheet accounts carry no USALI mapping.
//      Codes follow the canonical rules literally: PGC cuentas are 3 digits,
//      classic sub-accounts are 4 digits ("4300", "5721", "2816") and hotel
//      analytical sub-accounts use a dot ("705.1", "477.21").
//
//   2. provisionOrganizationChart(organizationId) — idempotent provisioning of
//      that template for ONE organisation: creates the accounts that are
//      missing, links parentId along the code hierarchy, fills the USALI default
//      of existing accounts that have none, and records the template code in
//      accounting_settings. It NEVER deletes, renames or re-types an existing
//      account: a legacy chart (org_123 seeded by prisma/seed.ts) keeps its
//      names and gains the missing accounts. Reads and writes go through a small
//      ChartStore interface so the unit tests run on an in-memory store; the
//      Prisma store wraps everything in one transaction.
//
// Readers of Account must keep using `accountType` (legacy alias, revenue ==
// income) until balance/PyG/cash-flow migrate to `kind`. Contract of every
// column: docs/runbooks/finanzas-contabilidad.md.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";

export const CHART_TEMPLATE_CODE = "pgc_pymes_hotelero_v1";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const ACCOUNT_KINDS = ["asset", "liability", "equity", "income", "expense"] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** Legacy `Account.accountType` values still read by balance/PyG/cash-flow. */
export type LegacyAccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

/** USALI 11th ed. departments of the summary operating statement (Spanish labels for the UI). */
export const USALI_DEPARTMENTS = {
  rooms: "Habitaciones",
  fnb: "Alimentos y bebidas",
  other_operated: "Otros departamentos operados",
  misc_income: "Ingresos varios",
  admin_general: "Administración y general",
  it: "Tecnología de la información",
  sales_marketing: "Ventas y marketing",
  pom: "Mantenimiento y operación de la propiedad",
  utilities: "Suministros",
  management_fees: "Honorarios de gestión",
  non_operating: "Ingresos y gastos no operativos",
  below_ebitda: "Bajo EBITDA"
} as const;
export type UsaliDepartment = keyof typeof USALI_DEPARTMENTS;

export const USALI_LINES = {
  revenue: "Ingresos",
  cost_of_sales: "Coste de ventas",
  labor: "Costes de personal",
  other_expense: "Otros gastos",
  management_fee: "Honorarios de gestión",
  rent: "Alquiler",
  property_taxes: "Impuestos sobre la propiedad",
  insurance: "Seguros",
  other: "Otros",
  interest: "Intereses",
  depreciation_amortization: "Amortización",
  income_tax: "Impuesto sobre beneficios"
} as const;
export type UsaliLine = keyof typeof USALI_LINES;

/** Lines each department admits (USALI 11th ed. schedules). */
export const USALI_DEPARTMENT_LINES: Record<UsaliDepartment, readonly UsaliLine[]> = {
  rooms: ["revenue", "labor", "other_expense"],
  fnb: ["revenue", "cost_of_sales", "labor", "other_expense"],
  other_operated: ["revenue", "cost_of_sales", "labor", "other_expense"],
  misc_income: ["revenue"],
  admin_general: ["labor", "other_expense"],
  it: ["labor", "other_expense"],
  sales_marketing: ["labor", "other_expense"],
  pom: ["labor", "other_expense"],
  utilities: ["other_expense"],
  management_fees: ["management_fee"],
  non_operating: ["rent", "property_taxes", "insurance", "other"],
  below_ebitda: ["interest", "depreciation_amortization", "income_tax"]
};

/** "department.line" as stored on Account.usaliDepartment / usaliLine. */
export type UsaliRef = `${UsaliDepartment}.${UsaliLine}`;

export type ChartTemplateAccount = {
  code: string;
  name: string;
  kind: AccountKind;
  usali?: UsaliRef;
};

// ---------------------------------------------------------------------------
// Code helpers (pure)
// ---------------------------------------------------------------------------

export function accountDigits(code: string): string {
  return code.replace(/[^0-9]/g, "");
}

/** PGC group = first digit (1-7 in Pymes). 0 when the code does not start with a digit. */
export function accountGroup(code: string): number {
  const first = code.charAt(0);
  return /[1-9]/.test(first) ? Number(first) : 0;
}

/** 1 grupo · 2 subgrupo · 3 cuenta · 4 subcuenta (4+ digits or a dotted code). */
export function accountLevel(code: string): number {
  return Math.min(accountDigits(code).length, 4);
}

/** Groups and subgroups are headers: they never receive journal lines. */
export function isPostableCode(code: string): boolean {
  return accountLevel(code) >= 3;
}

/**
 * Proper prefixes of a code, longest first: the provisioner links parentId to
 * the longest one that exists in the organisation. "477.21" → ["477", "47", "4"];
 * "4300" → ["430", "43", "4"]; "43000001" → ["4300000", …, "430", "43", "4"].
 */
export function parentCandidates(code: string): string[] {
  const out: string[] = [];
  const dot = code.indexOf(".");
  let base = code;
  if (dot > 0) {
    const sub = code.slice(dot + 1);
    for (let i = sub.length - 1; i >= 1; i--) out.push(`${code.slice(0, dot)}.${sub.slice(0, i)}`);
    base = code.slice(0, dot);
    out.push(base);
  }
  for (let i = base.length - 1; i >= 1; i--) out.push(base.slice(0, i));
  return out;
}

export function legacyAccountType(kind: AccountKind): LegacyAccountType {
  return kind === "income" ? "revenue" : kind;
}

export function kindFromLegacyType(accountType: string): AccountKind {
  switch (accountType) {
    case "asset":
    case "liability":
    case "equity":
    case "expense":
      return accountType;
    case "revenue":
    case "income":
      return "income";
    default:
      return "expense";
  }
}

export function splitUsaliRef(ref: UsaliRef | undefined | null): { usaliDepartment: UsaliDepartment; usaliLine: UsaliLine } | null {
  if (!ref) return null;
  const [department, line] = ref.split(".") as [UsaliDepartment, UsaliLine];
  return { usaliDepartment: department, usaliLine: line };
}

export function isUsaliRef(value: string): value is UsaliRef {
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const department = value.slice(0, dot) as UsaliDepartment;
  const line = value.slice(dot + 1) as UsaliLine;
  const lines = USALI_DEPARTMENT_LINES[department];
  return Array.isArray(lines) && lines.includes(line);
}

// ---------------------------------------------------------------------------
// Template «PGC Pymes hotelero»
// ---------------------------------------------------------------------------

const A = (code: string, name: string, kind: AccountKind, usali?: UsaliRef): ChartTemplateAccount =>
  usali ? { code, name, kind, usali } : { code, name, kind };

export const PGC_PYMES_HOTEL_TEMPLATE: readonly ChartTemplateAccount[] = Object.freeze([
  // ---- Grupo 1 · Financiación básica --------------------------------------
  A("1", "Financiación básica", "equity"),
  A("10", "Capital", "equity"),
  A("100", "Capital social", "equity"),
  A("102", "Capital", "equity"),
  A("11", "Reservas y otros instrumentos de patrimonio", "equity"),
  A("112", "Reserva legal", "equity"),
  A("113", "Reservas voluntarias", "equity"),
  A("118", "Aportaciones de socios o propietarios", "equity"),
  A("12", "Resultados pendientes de aplicación", "equity"),
  A("120", "Remanente", "equity"),
  A("121", "Resultados negativos de ejercicios anteriores", "equity"),
  A("129", "Resultado del ejercicio", "equity"),
  A("13", "Subvenciones, donaciones y ajustes por cambios de valor", "equity"),
  A("130", "Subvenciones oficiales de capital", "equity"),
  A("14", "Provisiones", "liability"),
  A("142", "Provisión para otras responsabilidades", "liability"),
  A("17", "Deudas a largo plazo por préstamos recibidos, empréstitos y otros conceptos", "liability"),
  A("170", "Deudas a largo plazo con entidades de crédito", "liability"),
  A("171", "Deudas a largo plazo", "liability"),
  A("173", "Proveedores de inmovilizado a largo plazo", "liability"),
  A("174", "Acreedores por arrendamiento financiero a largo plazo", "liability"),
  A("18", "Pasivos por fianzas, garantías y otros conceptos a largo plazo", "liability"),
  A("180", "Fianzas recibidas a largo plazo", "liability"),

  // ---- Grupo 2 · Activo no corriente ---------------------------------------
  A("2", "Activo no corriente", "asset"),
  A("20", "Inmovilizaciones intangibles", "asset"),
  A("203", "Propiedad industrial", "asset"),
  A("206", "Aplicaciones informáticas", "asset"),
  A("21", "Inmovilizaciones materiales", "asset"),
  A("210", "Terrenos y bienes naturales", "asset"),
  A("211", "Construcciones", "asset"),
  A("212", "Instalaciones técnicas", "asset"),
  A("213", "Maquinaria", "asset"),
  A("214", "Utillaje", "asset"),
  A("215", "Otras instalaciones", "asset"),
  A("216", "Mobiliario", "asset"),
  A("217", "Equipos para procesos de información", "asset"),
  A("218", "Elementos de transporte", "asset"),
  A("219", "Otro inmovilizado material", "asset"),
  A("23", "Inmovilizaciones materiales en curso", "asset"),
  A("231", "Construcciones en curso", "asset"),
  A("26", "Fianzas y depósitos constituidos a largo plazo", "asset"),
  A("260", "Fianzas constituidas a largo plazo", "asset"),
  A("28", "Amortización acumulada del inmovilizado", "asset"),
  A("280", "Amortización acumulada del inmovilizado intangible", "asset"),
  A("2806", "Amortización acumulada de aplicaciones informáticas", "asset"),
  A("281", "Amortización acumulada del inmovilizado material", "asset"),
  A("2811", "Amortización acumulada de construcciones", "asset"),
  A("2812", "Amortización acumulada de instalaciones técnicas", "asset"),
  A("2813", "Amortización acumulada de maquinaria", "asset"),
  A("2814", "Amortización acumulada de utillaje", "asset"),
  A("2815", "Amortización acumulada de otras instalaciones", "asset"),
  A("2816", "Amortización acumulada de mobiliario", "asset"),
  A("2817", "Amortización acumulada de equipos para procesos de información", "asset"),
  A("2818", "Amortización acumulada de elementos de transporte", "asset"),
  A("2819", "Amortización acumulada de otro inmovilizado material", "asset"),
  A("29", "Deterioro de valor de activos no corrientes", "asset"),
  A("291", "Deterioro de valor del inmovilizado material", "asset"),

  // ---- Grupo 3 · Existencias ----------------------------------------------
  A("3", "Existencias", "asset"),
  A("30", "Comerciales", "asset"),
  A("300", "Mercaderías", "asset"),
  A("31", "Materias primas", "asset"),
  A("310", "Materias primas", "asset"),
  A("32", "Otros aprovisionamientos", "asset"),
  A("321", "Combustibles", "asset"),
  A("322", "Repuestos", "asset"),
  A("325", "Materiales diversos", "asset"),
  A("328", "Material de oficina", "asset"),
  A("39", "Deterioro de valor de las existencias", "asset"),
  A("390", "Deterioro de valor de las mercaderías", "asset"),

  // ---- Grupo 4 · Acreedores y deudores por operaciones comerciales ----------
  A("4", "Acreedores y deudores por operaciones comerciales", "asset"),
  A("40", "Proveedores", "liability"),
  A("400", "Proveedores", "liability"),
  A("4000", "Proveedores (euros)", "liability"),
  A("401", "Proveedores, efectos comerciales a pagar", "liability"),
  A("407", "Anticipos a proveedores", "asset"),
  A("41", "Acreedores varios", "liability"),
  A("410", "Acreedores por prestaciones de servicios", "liability"),
  A("4100", "Acreedores por prestaciones de servicios (euros)", "liability"),
  A("4109", "Acreedores por comisiones de canales de venta (OTA)", "liability"),
  A("43", "Clientes", "asset"),
  A("430", "Clientes", "asset"),
  A("4300", "Clientes (euros)", "asset"),
  A("4304", "Clientes, agencias de viaje y canales de venta", "asset"),
  A("431", "Clientes, efectos comerciales a cobrar", "asset"),
  A("4310", "Efectos comerciales en cartera", "asset"),
  A("436", "Clientes de dudoso cobro", "asset"),
  A("438", "Anticipos de clientes", "liability"),
  A("44", "Deudores varios", "asset"),
  A("440", "Deudores", "asset"),
  A("4400", "Deudores (euros)", "asset"),
  A("46", "Personal", "liability"),
  A("460", "Anticipos de remuneraciones", "asset"),
  A("465", "Remuneraciones pendientes de pago", "liability"),
  A("47", "Administraciones públicas", "liability"),
  A("470", "Hacienda Pública, deudora por diversos conceptos", "asset"),
  A("4700", "Hacienda Pública, deudora por IVA", "asset"),
  A("4708", "Hacienda Pública, deudora por subvenciones concedidas", "asset"),
  A("4709", "Hacienda Pública, deudora por devolución de impuestos", "asset"),
  A("471", "Organismos de la Seguridad Social, deudores", "asset"),
  A("472", "Hacienda Pública, IVA soportado", "asset"),
  A("472.21", "Hacienda Pública, IVA soportado al 21 %", "asset"),
  A("472.10", "Hacienda Pública, IVA soportado al 10 %", "asset"),
  A("472.04", "Hacienda Pública, IVA / IPSI soportado al 4 %", "asset"),
  A("472.07", "Hacienda Pública, IGIC soportado al 7 %", "asset"),
  A("472.03", "Hacienda Pública, IGIC soportado al 3 %", "asset"),
  A("472.02", "Hacienda Pública, IPSI soportado al 2 %", "asset"),
  A("473", "Hacienda Pública, retenciones y pagos a cuenta", "asset"),
  A("475", "Hacienda Pública, acreedora por conceptos fiscales", "liability"),
  A("4750", "Hacienda Pública, acreedora por IVA", "liability"),
  A("4751", "Hacienda Pública, acreedora por retenciones practicadas", "liability"),
  A("4752", "Hacienda Pública, acreedora por impuesto sobre sociedades", "liability"),
  A("4759", "Tasa turística recaudada pendiente de ingreso", "liability"),
  A("476", "Organismos de la Seguridad Social, acreedores", "liability"),
  A("477", "Hacienda Pública, IVA repercutido", "liability"),
  A("477.21", "Hacienda Pública, IVA repercutido al 21 %", "liability"),
  A("477.10", "Hacienda Pública, IVA repercutido al 10 %", "liability"),
  A("477.04", "Hacienda Pública, IVA / IPSI repercutido al 4 %", "liability"),
  A("477.07", "Hacienda Pública, IGIC repercutido al 7 %", "liability"),
  A("477.03", "Hacienda Pública, IGIC repercutido al 3 %", "liability"),
  A("477.02", "Hacienda Pública, IPSI repercutido al 2 %", "liability"),
  A("48", "Ajustes por periodificación", "asset"),
  A("480", "Gastos anticipados", "asset"),
  A("485", "Ingresos anticipados", "liability"),
  A("49", "Deterioro de valor de créditos comerciales y provisiones a corto plazo", "asset"),
  A("490", "Deterioro de valor de créditos por operaciones comerciales", "asset"),

  // ---- Grupo 5 · Cuentas financieras ---------------------------------------
  A("5", "Cuentas financieras", "asset"),
  A("52", "Deudas a corto plazo por préstamos recibidos y otros conceptos", "liability"),
  A("520", "Deudas a corto plazo con entidades de crédito", "liability"),
  A("521", "Deudas a corto plazo", "liability"),
  A("523", "Proveedores de inmovilizado a corto plazo", "liability"),
  A("524", "Acreedores por arrendamiento financiero a corto plazo", "liability"),
  A("55", "Otras cuentas no bancarias", "liability"),
  A("551", "Cuenta corriente con socios y administradores", "liability"),
  A("555", "Partidas pendientes de aplicación", "liability"),
  A("56", "Fianzas y depósitos recibidos y constituidos a corto plazo", "liability"),
  A("560", "Fianzas recibidas a corto plazo", "liability"),
  A("565", "Fianzas constituidas a corto plazo", "asset"),
  A("57", "Tesorería", "asset"),
  A("570", "Caja, euros", "asset"),
  A("572", "Bancos e instituciones de crédito c/c vista, euros", "asset"),
  A("5721", "Datáfono pendiente de liquidar", "asset"),
  A("5722", "Pasarela de pago pendiente de liquidar", "asset"),
  A("574", "Bancos e instituciones de crédito, cuentas de ahorro, euros", "asset"),

  // ---- Grupo 6 · Compras y gastos ------------------------------------------
  A("6", "Compras y gastos", "expense"),
  A("60", "Compras", "expense"),
  A("600", "Compras de mercaderías", "expense", "other_operated.cost_of_sales"),
  A("601", "Compras de materias primas", "expense", "fnb.cost_of_sales"),
  A("601.1", "Compras de alimentos", "expense", "fnb.cost_of_sales"),
  A("601.2", "Compras de bebidas", "expense", "fnb.cost_of_sales"),
  A("602", "Compras de otros aprovisionamientos", "expense", "rooms.other_expense"),
  A("606", "Descuentos sobre compras por pronto pago", "expense", "fnb.cost_of_sales"),
  A("607", "Trabajos realizados por otras empresas", "expense", "rooms.other_expense"),
  A("608", "Devoluciones de compras y operaciones similares", "expense", "fnb.cost_of_sales"),
  A("609", "Rappels por compras", "expense", "fnb.cost_of_sales"),
  A("61", "Variación de existencias", "expense"),
  A("610", "Variación de existencias de mercaderías", "expense", "other_operated.cost_of_sales"),
  A("611", "Variación de existencias de materias primas", "expense", "fnb.cost_of_sales"),
  A("612", "Variación de existencias de otros aprovisionamientos", "expense", "rooms.other_expense"),
  A("62", "Servicios exteriores", "expense"),
  A("621", "Arrendamientos y cánones", "expense", "non_operating.rent"),
  A("622", "Reparaciones y conservación", "expense", "pom.other_expense"),
  A("623", "Servicios de profesionales independientes", "expense", "admin_general.other_expense"),
  A("623.1", "Honorarios de gestión hotelera", "expense", "management_fees.management_fee"),
  A("6230", "Comisiones de agentes mediadores", "expense", "rooms.other_expense"),
  A("624", "Transportes", "expense", "admin_general.other_expense"),
  A("625", "Primas de seguros", "expense", "non_operating.insurance"),
  A("626", "Servicios bancarios y similares", "expense", "admin_general.other_expense"),
  A("626.1", "Comisiones de datáfono y pasarela de pago", "expense", "admin_general.other_expense"),
  A("627", "Publicidad, propaganda y relaciones públicas", "expense", "sales_marketing.other_expense"),
  A("628", "Suministros", "expense", "utilities.other_expense"),
  A("628.1", "Electricidad", "expense", "utilities.other_expense"),
  A("628.2", "Agua", "expense", "utilities.other_expense"),
  A("628.3", "Gas y combustibles", "expense", "utilities.other_expense"),
  A("628.4", "Telecomunicaciones e internet", "expense", "it.other_expense"),
  A("629", "Otros servicios", "expense", "admin_general.other_expense"),
  A("629.1", "Comisiones de canales de venta", "expense", "rooms.other_expense"),
  A("629.2", "Lavandería y lencería externa", "expense", "rooms.other_expense"),
  A("629.3", "Licencias y servicios informáticos", "expense", "it.other_expense"),
  A("629.4", "Limpieza externa", "expense", "rooms.other_expense"),
  A("629.9", "Otros servicios diversos", "expense", "admin_general.other_expense"),
  A("63", "Tributos", "expense"),
  A("630", "Impuesto sobre beneficios", "expense", "below_ebitda.income_tax"),
  A("631", "Otros tributos", "expense", "non_operating.property_taxes"),
  A("634", "Ajustes negativos en la imposición indirecta", "expense", "admin_general.other_expense"),
  A("639", "Ajustes positivos en la imposición indirecta", "expense", "admin_general.other_expense"),
  A("64", "Gastos de personal", "expense"),
  A("640", "Sueldos y salarios", "expense", "admin_general.labor"),
  A("640.1", "Sueldos y salarios: habitaciones", "expense", "rooms.labor"),
  A("640.2", "Sueldos y salarios: alimentos y bebidas", "expense", "fnb.labor"),
  A("640.3", "Sueldos y salarios: otros departamentos operados", "expense", "other_operated.labor"),
  A("640.4", "Sueldos y salarios: administración y general", "expense", "admin_general.labor"),
  A("640.5", "Sueldos y salarios: ventas y marketing", "expense", "sales_marketing.labor"),
  A("640.6", "Sueldos y salarios: mantenimiento", "expense", "pom.labor"),
  A("641", "Indemnizaciones", "expense", "admin_general.labor"),
  A("642", "Seguridad Social a cargo de la empresa", "expense", "admin_general.labor"),
  A("642.1", "Seguridad Social a cargo de la empresa: habitaciones", "expense", "rooms.labor"),
  A("642.2", "Seguridad Social a cargo de la empresa: alimentos y bebidas", "expense", "fnb.labor"),
  A("642.3", "Seguridad Social a cargo de la empresa: otros departamentos operados", "expense", "other_operated.labor"),
  A("642.4", "Seguridad Social a cargo de la empresa: administración y general", "expense", "admin_general.labor"),
  A("642.5", "Seguridad Social a cargo de la empresa: ventas y marketing", "expense", "sales_marketing.labor"),
  A("642.6", "Seguridad Social a cargo de la empresa: mantenimiento", "expense", "pom.labor"),
  A("649", "Otros gastos sociales", "expense", "admin_general.labor"),
  A("65", "Otros gastos de gestión", "expense"),
  A("650", "Pérdidas de créditos comerciales incobrables", "expense", "admin_general.other_expense"),
  A("659", "Otras pérdidas en gestión corriente", "expense", "admin_general.other_expense"),
  A("66", "Gastos financieros", "expense"),
  A("662", "Intereses de deudas", "expense", "below_ebitda.interest"),
  A("669", "Otros gastos financieros", "expense", "below_ebitda.interest"),
  A("67", "Pérdidas procedentes de activos no corrientes y gastos excepcionales", "expense"),
  A("671", "Pérdidas procedentes del inmovilizado material", "expense", "non_operating.other"),
  A("678", "Gastos excepcionales", "expense", "non_operating.other"),
  A("68", "Dotaciones para amortizaciones", "expense"),
  A("680", "Amortización del inmovilizado intangible", "expense", "below_ebitda.depreciation_amortization"),
  A("681", "Amortización del inmovilizado material", "expense", "below_ebitda.depreciation_amortization"),
  A("69", "Pérdidas por deterioro y otras dotaciones", "expense"),
  A("694", "Pérdidas por deterioro de créditos por operaciones comerciales", "expense", "admin_general.other_expense"),

  // ---- Grupo 7 · Ventas e ingresos -----------------------------------------
  A("7", "Ventas e ingresos", "income"),
  A("70", "Ventas de mercaderías, de producción propia, de servicios, etc.", "income"),
  A("700", "Ventas de mercaderías", "income", "other_operated.revenue"),
  A("705", "Prestaciones de servicios", "income", "rooms.revenue"),
  A("705.1", "Prestaciones de servicios: alojamiento", "income", "rooms.revenue"),
  A("705.2", "Prestaciones de servicios: restauración", "income", "fnb.revenue"),
  A("705.3", "Prestaciones de servicios: otros servicios", "income", "other_operated.revenue"),
  A("705.4", "Prestaciones de servicios: eventos", "income", "fnb.revenue"),
  A("706", "Descuentos sobre ventas por pronto pago", "income", "rooms.revenue"),
  A("708", "Devoluciones de ventas y operaciones similares", "income", "rooms.revenue"),
  A("709", "Rappels sobre ventas", "income", "rooms.revenue"),
  A("75", "Otros ingresos de gestión", "income"),
  A("752", "Ingresos por arrendamientos", "income", "misc_income.revenue"),
  A("754", "Ingresos por comisiones", "income", "misc_income.revenue"),
  A("759", "Ingresos por servicios diversos", "income", "misc_income.revenue"),
  A("76", "Ingresos financieros", "income"),
  A("762", "Ingresos de créditos", "income", "below_ebitda.interest"),
  A("769", "Otros ingresos financieros", "income", "below_ebitda.interest"),
  A("77", "Beneficios procedentes de activos no corrientes e ingresos excepcionales", "income"),
  A("771", "Beneficios procedentes del inmovilizado material", "income", "non_operating.other"),
  A("778", "Ingresos excepcionales", "income", "non_operating.other"),
  A("79", "Excesos y aplicaciones de provisiones y de pérdidas por deterioro", "income"),
  A("794", "Reversión del deterioro de créditos por operaciones comerciales", "income", "admin_general.other_expense")
]);

/**
 * Accounts the canonical posting rules of docs/runbooks/finanzas-contabilidad.md
 * post to. The template test asserts every one of them exists; the provisioner
 * reports any that would still be missing after a run (should always be none).
 */
export const CANONICAL_RULE_ACCOUNT_CODES: readonly string[] = Object.freeze([
  // Patrimonio neto y cierre
  "100", "112", "113", "120", "121", "129",
  // Inmovilizado y amortización
  "206", "211", "212", "213", "215", "216", "217", "218", "219", "280", "281", "2811", "2812", "2816", "2817", "2818",
  // Existencias
  "300",
  // Proveedores, acreedores, clientes
  "400", "410", "4100", "430", "4300", "438",
  // Administraciones públicas
  "4700", "4709", "472", "472.21", "472.10", "472.04", "4750", "4751", "4752", "4759", "476",
  "477", "477.21", "477.10", "477.04", "465",
  // Tesorería
  "570", "572", "5721", "5722",
  // Gastos
  "600", "607", "621", "622", "623", "624", "625", "626", "627", "628", "629", "629.1", "630", "631", "640", "642", "662", "680", "681",
  // Ingresos
  "700", "705", "705.1", "705.2", "705.3", "705.4", "708", "762", "769"
]);

// ---------------------------------------------------------------------------
// Template validation (also run by the unit tests)
// ---------------------------------------------------------------------------

export function validateChartTemplate(template: readonly ChartTemplateAccount[] = PGC_PYMES_HOTEL_TEMPLATE): string[] {
  const issues: string[] = [];
  const codes = new Set<string>();
  for (const account of template) {
    if (!/^[1-7][0-9]*(\.[0-9]+)?$/.test(account.code)) issues.push(`Código no válido: "${account.code}"`);
    if (codes.has(account.code)) issues.push(`Código duplicado: "${account.code}"`);
    codes.add(account.code);
    if (!account.name.trim()) issues.push(`Cuenta ${account.code} sin nombre`);
    if (!ACCOUNT_KINDS.includes(account.kind)) issues.push(`Cuenta ${account.code} con kind desconocido "${account.kind}"`);
    const group = accountGroup(account.code);
    if (group === 6 && account.kind !== "expense") issues.push(`Cuenta ${account.code} del grupo 6 debe ser expense`);
    if (group === 7 && account.kind !== "income") issues.push(`Cuenta ${account.code} del grupo 7 debe ser income`);
    if ((group === 2 || group === 3) && account.kind !== "asset") issues.push(`Cuenta ${account.code} del grupo ${group} debe ser asset`);
    if (group === 1 && !(account.kind === "equity" || account.kind === "liability")) issues.push(`Cuenta ${account.code} del grupo 1 debe ser equity o liability`);
    if ((group === 4 || group === 5) && account.kind !== "asset" && account.kind !== "liability") issues.push(`Cuenta ${account.code} del grupo ${group} debe ser asset o liability`);
    if (account.usali !== undefined) {
      if (!isUsaliRef(account.usali)) issues.push(`Cuenta ${account.code} con mapeo USALI no válido "${account.usali}"`);
      if (group !== 6 && group !== 7) issues.push(`Cuenta ${account.code} de balance no puede llevar mapeo USALI`);
      if (!isPostableCode(account.code)) issues.push(`Cabecera ${account.code} no puede llevar mapeo USALI`);
    } else if ((group === 6 || group === 7) && isPostableCode(account.code)) {
      issues.push(`Cuenta ${account.code} de PyG sin mapeo USALI por defecto`);
    }
  }
  for (const account of template) {
    if (accountLevel(account.code) === 1) continue;
    if (!parentCandidates(account.code).some((candidate) => codes.has(candidate))) {
      issues.push(`Cuenta ${account.code} sin cabecera en la plantilla`);
    }
  }
  for (const code of CANONICAL_RULE_ACCOUNT_CODES) {
    if (!codes.has(code)) issues.push(`Cuenta canónica ${code} ausente de la plantilla`);
  }
  return issues;
}

const templateByCode = new Map(PGC_PYMES_HOTEL_TEMPLATE.map((account) => [account.code, account]));

export function templateAccount(code: string): ChartTemplateAccount | undefined {
  return templateByCode.get(code);
}

/**
 * Default USALI mapping for a code: the template entry itself, or the longest
 * template prefix that carries one ("640.7" → 640 → admin_general.labor).
 * Balance-sheet codes and unknown groups return null.
 */
export function templateUsaliFor(code: string): { usaliDepartment: UsaliDepartment; usaliLine: UsaliLine } | null {
  const exact = templateByCode.get(code);
  if (exact?.usali) return splitUsaliRef(exact.usali);
  for (const candidate of parentCandidates(code)) {
    const parent = templateByCode.get(candidate);
    if (parent?.usali) return splitUsaliRef(parent.usali);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Store abstraction
// ---------------------------------------------------------------------------

export type ChartAccountRow = {
  id: string;
  code: string;
  name: string;
  accountType: string;
  parentId: string | null;
  kind: AccountKind;
  group: number;
  level: number;
  isPostable: boolean;
  usaliDepartment: string | null;
  usaliLine: string | null;
};

export type NewChartAccountRow = Omit<ChartAccountRow, "id" | "parentId"> & { organizationId: string };

export type ChartAccountPatch = Partial<Pick<ChartAccountRow, "parentId" | "usaliDepartment" | "usaliLine">>;

export type ChartStore = {
  organizationExists(organizationId: string): Promise<boolean>;
  listAccounts(organizationId: string): Promise<ChartAccountRow[]>;
  /** Insert the rows that do not exist yet (unique (organizationId, code) → skip duplicates). */
  createAccounts(rows: NewChartAccountRow[]): Promise<number>;
  updateAccount(id: string, patch: ChartAccountPatch): Promise<void>;
  findChartSetting(organizationId: string): Promise<{ id: string; chartTemplate: string | null } | null>;
  createChartSetting(organizationId: string, chartTemplate: string): Promise<void>;
  updateChartSetting(id: string, chartTemplate: string): Promise<void>;
};

type ChartClient = Pick<typeof prisma, "organization" | "account" | "accountingSetting"> | Prisma.TransactionClient;

export function prismaChartStore(client: ChartClient): ChartStore {
  return {
    async organizationExists(organizationId) {
      const row = await client.organization.findUnique({ where: { id: organizationId }, select: { id: true } });
      return row !== null;
    },
    async listAccounts(organizationId) {
      const rows = await client.account.findMany({
        where: { organizationId },
        select: {
          id: true,
          code: true,
          name: true,
          accountType: true,
          parentId: true,
          kind: true,
          group: true,
          level: true,
          isPostable: true,
          usaliDepartment: true,
          usaliLine: true
        },
        orderBy: { code: "asc" }
      });
      return rows.map((row) => ({ ...row, kind: row.kind as AccountKind }));
    },
    async createAccounts(rows) {
      if (rows.length === 0) return 0;
      const result = await client.account.createMany({ data: rows, skipDuplicates: true });
      return result.count;
    },
    async updateAccount(id, patch) {
      await client.account.update({ where: { id }, data: patch });
    },
    async findChartSetting(organizationId) {
      const row = await client.accountingSetting.findFirst({
        where: { organizationId, propertyId: null },
        select: { id: true, chartTemplate: true },
        orderBy: { updatedAt: "asc" }
      });
      return row;
    },
    async createChartSetting(organizationId, chartTemplate) {
      await client.accountingSetting.create({ data: { organizationId, propertyId: null, chartTemplate } });
    },
    async updateChartSetting(id, chartTemplate) {
      await client.accountingSetting.update({ where: { id }, data: { chartTemplate } });
    }
  };
}

// ---------------------------------------------------------------------------
// Plan + apply
// ---------------------------------------------------------------------------

export type ChartProvisionPlan = {
  organizationId: string;
  templateCode: string;
  templateSize: number;
  existing: number;
  /** Template codes absent from the organisation (created on apply). */
  toCreate: string[];
  /** Existing accounts whose parentId is null but have a parent in the org (linked on apply). */
  toLink: Array<{ code: string; parentCode: string }>;
  /** Existing P&L accounts without USALI default that the template can fill (filled on apply). */
  toFillUsali: Array<{ code: string; usaliDepartment: UsaliDepartment; usaliLine: UsaliLine }>;
  /** Existing accounts whose name differs from the template — reported, NEVER changed. */
  nameDiffers: Array<{ code: string; current: string; template: string }>;
  setting: "create" | "update" | "keep";
  /** Canonical rule accounts still missing after the plan (must be empty). */
  missingCanonical: string[];
};

export type ChartProvisionResult = {
  plan: ChartProvisionPlan;
  applied: boolean;
  created: number;
  linked: number;
  usaliFilled: number;
  settingWritten: boolean;
  /** Accounts in the organisation after the run (== existing when dry-run). */
  totalAfter: number;
};

export function templateToRow(organizationId: string, account: ChartTemplateAccount): NewChartAccountRow {
  const usali = splitUsaliRef(account.usali);
  return {
    organizationId,
    code: account.code,
    name: account.name,
    accountType: legacyAccountType(account.kind),
    kind: account.kind,
    group: accountGroup(account.code),
    level: accountLevel(account.code),
    isPostable: isPostableCode(account.code),
    usaliDepartment: usali?.usaliDepartment ?? null,
    usaliLine: usali?.usaliLine ?? null
  };
}

/** Longest existing proper prefix of `code` among `codes` (the parent to link to), or null. */
export function resolveParentCode(code: string, codes: ReadonlySet<string>): string | null {
  for (const candidate of parentCandidates(code)) if (codes.has(candidate)) return candidate;
  return null;
}

export async function planOrganizationChart(organizationId: string, store: ChartStore): Promise<ChartProvisionPlan> {
  if (!(await store.organizationExists(organizationId))) {
    throw new Error(`La organización "${organizationId}" no existe.`);
  }
  const existing = await store.listAccounts(organizationId);
  const existingByCode = new Map(existing.map((row) => [row.code, row]));
  const toCreate = PGC_PYMES_HOTEL_TEMPLATE.filter((account) => !existingByCode.has(account.code)).map((account) => account.code);
  const allCodes = new Set<string>([...existingByCode.keys(), ...toCreate]);

  const toLink: ChartProvisionPlan["toLink"] = [];
  const toFillUsali: ChartProvisionPlan["toFillUsali"] = [];
  const nameDiffers: ChartProvisionPlan["nameDiffers"] = [];
  for (const row of existing) {
    if (row.parentId === null) {
      const parentCode = resolveParentCode(row.code, allCodes);
      if (parentCode) toLink.push({ code: row.code, parentCode });
    }
    if (row.usaliDepartment === null && row.usaliLine === null && (row.group === 6 || row.group === 7) && row.isPostable) {
      const usali = templateUsaliFor(row.code);
      if (usali) toFillUsali.push({ code: row.code, ...usali });
    }
    const template = templateByCode.get(row.code);
    if (template && template.name !== row.name) nameDiffers.push({ code: row.code, current: row.name, template: template.name });
  }

  const setting = await store.findChartSetting(organizationId);
  const settingAction: ChartProvisionPlan["setting"] = setting === null ? "create" : setting.chartTemplate === CHART_TEMPLATE_CODE ? "keep" : "update";
  const missingCanonical = CANONICAL_RULE_ACCOUNT_CODES.filter((code) => !allCodes.has(code));

  return {
    organizationId,
    templateCode: CHART_TEMPLATE_CODE,
    templateSize: PGC_PYMES_HOTEL_TEMPLATE.length,
    existing: existing.length,
    toCreate,
    toLink,
    toFillUsali,
    nameDiffers,
    setting: settingAction,
    missingCanonical
  };
}

export type ProvisionOptions = {
  /** In-memory or transactional store; default = Prisma inside one transaction. */
  store?: ChartStore;
  /** Compute the plan only, write nothing. */
  dryRun?: boolean;
};

/**
 * Idempotent: creates the template accounts that are missing, links parents,
 * fills USALI defaults of existing P&L accounts and records the template in
 * accounting_settings. Never deletes, renames or re-types an account. A second
 * run returns created/linked/usaliFilled = 0 and settingWritten = false.
 */
export async function provisionOrganizationChart(organizationId: string, options: ProvisionOptions = {}): Promise<ChartProvisionResult> {
  if (options.store) return provisionWithStore(organizationId, options.store, options.dryRun === true);
  if (options.dryRun) return provisionWithStore(organizationId, prismaChartStore(prisma), true);
  return prisma.$transaction((tx) => provisionWithStore(organizationId, prismaChartStore(tx), false), { maxWait: 15_000, timeout: 120_000 });
}

async function provisionWithStore(organizationId: string, store: ChartStore, dryRun: boolean): Promise<ChartProvisionResult> {
  const plan = await planOrganizationChart(organizationId, store);
  if (dryRun) {
    return { plan, applied: false, created: 0, linked: 0, usaliFilled: 0, settingWritten: false, totalAfter: plan.existing };
  }

  // 1. Missing accounts (parentId resolved in step 2 once every row has an id).
  const rows = plan.toCreate.map((code) => templateToRow(organizationId, templateByCode.get(code)!));
  const created = await store.createAccounts(rows);

  // 2. Parent links: new rows and legacy rows without parent, longest existing prefix.
  const after = await store.listAccounts(organizationId);
  const idByCode = new Map(after.map((row) => [row.code, row.id]));
  const codes = new Set(idByCode.keys());
  let linked = 0;
  for (const row of after) {
    if (row.parentId !== null) continue;
    const parentCode = resolveParentCode(row.code, codes);
    if (!parentCode) continue;
    await store.updateAccount(row.id, { parentId: idByCode.get(parentCode)! });
    linked += 1;
  }

  // 3. USALI defaults on legacy P&L accounts that have none (never overwrite).
  let usaliFilled = 0;
  for (const fill of plan.toFillUsali) {
    const id = idByCode.get(fill.code);
    if (!id) continue;
    await store.updateAccount(id, { usaliDepartment: fill.usaliDepartment, usaliLine: fill.usaliLine });
    usaliFilled += 1;
  }

  // 4. Template marker in accounting_settings (organisation-level row).
  let settingWritten = false;
  if (plan.setting === "create") {
    await store.createChartSetting(organizationId, CHART_TEMPLATE_CODE);
    settingWritten = true;
  } else if (plan.setting === "update") {
    const setting = await store.findChartSetting(organizationId);
    if (setting) {
      await store.updateChartSetting(setting.id, CHART_TEMPLATE_CODE);
      settingWritten = true;
    }
  }

  return { plan, applied: true, created, linked, usaliFilled, settingWritten, totalAfter: after.length };
}

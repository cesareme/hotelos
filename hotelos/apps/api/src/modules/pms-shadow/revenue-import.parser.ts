// OPERA Cloud · modo sombra (Tanda 7b · L2) — parser de ficheros de ingresos
// diarios, PURO (sin base de datos ni red).
//
// Convierte un fichero de OPERA en una `PmsShadowRevenueParsed` común —hotel,
// business date, una línea por transaction code con tipo, descripción e importe
// neto (Decimal a 2 decimales como string), Σ importes y avisos— a partir de
// cuatro formatos (diseño docs/design/OPERA-CLOUD-MODO-SOMBRA.md §3 fila
// «Ingresos diarios», §4.4 y §6.4):
//   · `parseGenXmlboRevenue` — export XML `GEN_XMLBO_REVENUE` [V]: elementos
//     literales de Oracle `revenue{hotel_code,date}` > `transaction_total
//     {transaction_type}` > `transaction_code, description, total_amount,
//     total_guest_ledger, total_package_ledger, total_ar_ledger,
//     total_deposit_ledger` > `transaction_details/transaction{market_code,
//     room_class, trx_amount, …}`; `hotel_code` / `date` / `transaction_type` se
//     aceptan como atributo o como elemento hijo (la doc los agrupa con llaves y
//     no fija la sintaxis); importes con 2 decimales, punto y signo «-»; fecha
//     YYYY-MM-DD; `transaction_type` ∈ REVENUE · NON REVENUE · PAYMENT · PAID OUT ·
//     PACKAGE · INTERNAL (otro valor → aviso, se conserva en mayúsculas).
//   · `parseFindeptcodesXml` — informe `findeptcodes` en XML (modelo de datos de
//     BI Publisher). Los nombres de elemento NO están documentados [S]: por
//     defecto se buscan los rótulos plegados TRN_CODE / DESCRIPTION / DAY_GROSS /
//     DAY_NET (MONTH_* y YEAR_* se ignoran) sin distinguir mayúsculas, y un mapa
//     opcional los sustituye cuando llegue la muestra real (§7.2 paso 5). Se usa
//     Day Net; filas sin código o cuya descripción / código plegado empieza por
//     total / subtotal / grand_total se descartan (subtotales por Group / Subgroup
//     y Grand Total del informe).
//   · `parseFindeptcodesDelimited` — el mismo informe en «Delimited Data»
//     (cabeceras «Trn. Code», «Description», «Day Gross», «Day Net», «Month
//     Gross», «Month Net», «Year Gross», «Year Net» [V]) sobre `parseCsvTable` de
//     la Tanda 7; mismo descarte de subtotales; Oracle desaconseja Delimited en
//     informes con group-by, así que si el nº de filas de datos no cuadra con el
//     nº de códigos distintos se avisa (filas duplicadas u omitidas).
//   · `parseResponsysTrx` — export `RESPONSYS_TRX` (TRANSACTION_DATE,
//     TRANSACTION_ID, RESERVATION_ID, REVENUE_TYPES, REVENUE_AMOUNTS, CURRENCY
//     [V]): agrega los importes por REVENUE_TYPES como códigos de tipo REVENUE;
//     la fecha de negocio es la TRANSACTION_DATE única del fichero (más de una →
//     400 PMS_SHADOW_REVENUE_DAY_MISMATCH). RESERVATION_ID y TRANSACTION_ID no se
//     persisten (GDPR: solo agregados).
//
// Guardas comunes: > PMS_SHADOW_MAX_FILE_BYTES → 400 PMS_SHADOW_FILE_TOO_LARGE;
// ilegible (XML roto, DOCTYPE, CSV sin cabecera reconocible) → 400
// PMS_SHADOW_FILE_UNREADABLE { reason }; sin líneas → 400
// PMS_SHADOW_REVENUE_EMPTY. `sniffRevenueSource` decide el formato por nombre
// y por los primeros bytes; `parseRevenueFile` es la entrada del servicio y del
// CLI. Errores con `ledgerBadRequest` (details.code).

import { Prisma } from "@prisma/client";
import { PMS_SHADOW_MAX_FILE_BYTES, type IsoDate, type MoneyString, type PmsShadowRevenueLedgers, type PmsShadowRevenueSource } from "@hotelos/shared";
import { XmlLiteError, childText, childrenNamed, decodeXmlBytes, findFirst, parseXml, walkXml, type XmlNode } from "../../lib/xml-lite.js";
import { ledgerBadRequest } from "../accounting/accounting.service.js";
import { ReservationImportParseError, decodeBytes, parseCsvTable, type ParsedTable } from "../pms/reservation-import.parser.js";

type Dec = Prisma.Decimal;
const D = Prisma.Decimal;
const ZERO = new D(0);

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Transaction types del XML de Revenue de Oracle [V]. */
export const PMS_SHADOW_XML_TRANSACTION_TYPES = ["REVENUE", "NON REVENUE", "PAYMENT", "PAID OUT", "PACKAGE", "INTERNAL"] as const;
export type PmsShadowXmlTransactionType = (typeof PMS_SHADOW_XML_TRANSACTION_TYPES)[number];

/** Una línea del fichero: un transaction code del día (aún sin mapear). */
export type PmsShadowRevenueParsedLine = {
  code: string;
  description: string;
  /** REVENUE · NON REVENUE · PAYMENT · PAID OUT · PACKAGE · INTERNAL (XML) o "" cuando el formato no lo trae (findeptcodes). */
  transactionType: string;
  /** Importe neto a 2 decimales, punto, signo «-» explícito. */
  amount: MoneyString;
  ledgers?: PmsShadowRevenueLedgers;
};

export type PmsShadowRevenueParsed = {
  source: PmsShadowRevenueSource;
  /** `hotel_code` del XML; null en formatos sin código de hotel. */
  hotelCode: string | null;
  /** `date` del XML o TRANSACTION_DATE del Responsys; null cuando el fichero no la declara (findeptcodes). */
  businessDate: IsoDate | null;
  lines: PmsShadowRevenueParsedLine[];
  /** Σ importes de TODAS las líneas (regla de Oracle: ≡ «Transaction Total Today» del Trial Balance). */
  sumTotalAmount: MoneyString;
  warnings: string[];
};

export type PmsShadowRevenueFileInput = {
  fileName?: string | null;
  source?: PmsShadowRevenueSource | "auto" | null;
  /** Texto (CLI y tests). */
  content?: string | null;
  /** Bytes en base64 (navegador, ingest, correo). */
  contentBase64?: string | null;
};

/** Nombres de elemento del modelo de datos BI Publisher de `findeptcodes` [S]; se comparan plegados y sin distinguir mayúsculas. */
export type FindeptcodesElementNames = {
  code: string;
  description: string;
  dayGross: string;
  dayNet: string;
  /** Elemento con el business date del informe (parámetro), si existe. */
  businessDate: string;
};

export const FINDEPTCODES_DEFAULT_ELEMENTS: FindeptcodesElementNames = Object.freeze({
  code: "TRN_CODE",
  description: "DESCRIPTION",
  dayGross: "DAY_GROSS",
  dayNet: "DAY_NET",
  businessDate: "BUSINESS_DATE"
});

/** Cabeceras literales del «Delimited Data» de `findeptcodes` [V], plegadas. */
export const FINDEPTCODES_CSV_HEADERS = Object.freeze({
  code: "trn_code",
  description: "description",
  dayGross: "day_gross",
  dayNet: "day_net",
  monthGross: "month_gross",
  monthNet: "month_net",
  yearGross: "year_gross",
  yearNet: "year_net"
});

/** Columnas literales del export `RESPONSYS_TRX` [V]. */
export const RESPONSYS_TRX_COLUMNS = ["TRANSACTION_DATE", "TRANSACTION_ID", "RESERVATION_ID", "REVENUE_TYPES", "REVENUE_AMOUNTS", "CURRENCY"] as const;

const MAX_WARNINGS = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Plegado de rótulos: minúsculas, sin diacríticos, `[^a-z0-9]+` → «_», sin «_» inicial ni final. */
export function foldLabel(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

const SUBTOTAL_RE = /^(sub_?total|grand_?total|gran_?total|total)(_|$)/;

/** true si el rótulo plegado es una fila de subtotal / total del informe. */
export function isSubtotalLabel(value: unknown): boolean {
  return SUBTOTAL_RE.test(foldLabel(value));
}

/**
 * SC-10: una fila de `findeptcodes` es subtotal / total SOLO cuando lo dice su columna de
 * código (vacía o rotulada «Total…»); una descripción que empieza por «Total» junto a un
 * transaction code real (p. ej. `9010 · Total Beverage Package`) es una línea de ingreso y
 * se conserva. Antes se descartaba en silencio por la descripción y el ingreso desaparecía.
 */
export function isSubtotalRow(code: string, description: string): boolean {
  const trimmed = code.trim();
  if (trimmed === "" || isSubtotalLabel(trimmed)) return true;
  // Código que no parece un transaction code de OPERA (≤ 20, sin espacios) y descripción de total → subtotal rotulado en la columna de código.
  return isSubtotalLabel(description) && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/.test(trimmed);
}

function unreadable(message: string, details: Record<string, unknown> = {}): never {
  throw ledgerBadRequest("PMS_SHADOW_FILE_UNREADABLE", message, details);
}

function tooLarge(bytes: number): never {
  throw ledgerBadRequest("PMS_SHADOW_FILE_TOO_LARGE", "El fichero supera el tamaño admitido (5 MB).", { bytes, max: PMS_SHADOW_MAX_FILE_BYTES });
}

function empty(message = "El fichero de ingresos no contiene ninguna línea."): never {
  throw ledgerBadRequest("PMS_SHADOW_REVENUE_EMPTY", message);
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" válida en el calendario (UTC) o null. */
export function normalizeIsoDate(value: string): IsoDate | null {
  const match = ISO_DATE_RE.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * Fecha de un export / informe → ISO: YYYY-MM-DD (con o sin hora), YYYYMMDD
 * (máscara `Column Format` de los exports [V]), DD/MM/YYYY, DD-MM-YYYY,
 * DD.MM.YYYY (Delimited: formato no documentado [S], se asume día-mes-año en
 * España). null si no se reconoce.
 */
export function parseFeedDate(raw: string): IsoDate | null {
  const value = raw.trim();
  if (value === "") return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(value);
  if (iso) return normalizeIsoDate(`${iso[1]}-${iso[2]}-${iso[3]}`);
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (compact) return normalizeIsoDate(`${compact[1]}-${compact[2]}-${compact[3]}`);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[T ].*)?$/.exec(value);
  if (dmy) return normalizeIsoDate(`${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}`);
  return null;
}

const XML_AMOUNT_RE = /^[-+]?\d+(\.\d+)?$/;

/** Importe del XML de Oracle (2 decimales, punto, signo «-»); admite «−» tipográfico y más decimales (redondeo HALF_UP). null si no es numérico. */
export function parseXmlAmount(raw: string | null | undefined): Dec | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim().replace(/−/g, "-");
  if (value === "") return null;
  if (!XML_AMOUNT_RE.test(value)) return null;
  return new D(value);
}

/**
 * Importe de un Delimited: «1.234,56», «1,234.56», «1234.56», «1234,56»,
 * «-900,00», «(900,00)», «900,00-», con o sin «€» y espacios. null si no es numérico.
 */
export function parseAmountFlexible(raw: string | null | undefined): Dec | null {
  if (raw === null || raw === undefined) return null;
  let value = raw
    .replace(/\u00a0/g, " ")
    .replace(/[€$\s]/g, "")
    .replace(/−/g, "-")
    .trim();
  if (value === "") return null;
  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1);
  }
  if (value.endsWith("-")) {
    negative = !negative;
    value = value.slice(0, -1);
  }
  if (value.startsWith("-")) {
    negative = !negative;
    value = value.slice(1);
  } else if (value.startsWith("+")) {
    value = value.slice(1);
  }
  if (!/^[\d.,]+$/.test(value)) return null;
  const lastComma = value.lastIndexOf(",");
  const lastDot = value.lastIndexOf(".");
  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    // El último separador es el decimal; el otro, de miles.
    normalized = lastComma > lastDot ? value.replace(/\./g, "").replace(",", ".") : value.replace(/,/g, "");
  } else if (lastComma >= 0) {
    const parts = value.split(",");
    // «1,234» con exactamente 3 dígitos tras una sola coma es ambiguo: en un informe español es decimal («1,234» → 1.234 no existe a 2 decimales) → se toma como decimal.
    normalized = parts.length === 2 ? `${parts[0]}.${parts[1]}` : value.replace(/,/g, "");
  } else if (lastDot >= 0) {
    const parts = value.split(".");
    normalized = parts.length === 2 ? value : value.replace(/\./g, "");
  } else {
    normalized = value;
  }
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const dec = new D(normalized);
  return negative ? dec.negated() : dec;
}

function money(value: Dec): MoneyString {
  return value.toDecimalPlaces(2, D.ROUND_HALF_UP).toFixed(2);
}

function pushWarning(warnings: string[], message: string): void {
  if (warnings.length < MAX_WARNINGS) warnings.push(message);
  else if (warnings.length === MAX_WARNINGS) warnings.push("… y más avisos omitidos.");
}

/** Atributo o hijo directo con ese nombre (la doc de Oracle no fija cuál). */
function attrOrChild(node: XmlNode, name: string): string | null {
  if (Object.prototype.hasOwnProperty.call(node.attrs, name)) return node.attrs[name]!;
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(node.attrs)) if (key.toUpperCase() === upper) return value;
  const text = childText(node, name);
  if (text !== null) return text;
  const child = node.children.find((candidate) => candidate.name.toUpperCase() === upper);
  return child ? child.text : null;
}

function parseXmlOrThrow(input: string | Uint8Array): XmlNode {
  try {
    return parseXml(input, { maxBytes: PMS_SHADOW_MAX_FILE_BYTES });
  } catch (error) {
    if (error instanceof XmlLiteError) {
      if (error.code === "XML_LITE_TOO_LARGE") tooLarge(Number(error.details?.bytes ?? 0));
      unreadable(`XML no válido: ${error.message}`, { reason: error.code, ...(error.details ?? {}) });
    }
    throw error;
  }
}

/** Agrega líneas por código (mismo código dos veces → suma; tipos distintos → aviso). */
function aggregateByCode(rows: PmsShadowRevenueParsedLine[], warnings: string[], label: string): PmsShadowRevenueParsedLine[] {
  const byCode = new Map<string, { line: PmsShadowRevenueParsedLine; amount: Dec; ledgers: { guest: Dec; package: Dec; ar: Dec; deposit: Dec } | null; count: number }>();
  for (const row of rows) {
    const key = foldLabel(row.code);
    const existing = byCode.get(key);
    if (!existing) {
      byCode.set(key, {
        line: { ...row },
        amount: new D(row.amount),
        ledgers: row.ledgers ? { guest: new D(row.ledgers.guest), package: new D(row.ledgers.package), ar: new D(row.ledgers.ar), deposit: new D(row.ledgers.deposit) } : null,
        count: 1
      });
      continue;
    }
    existing.count += 1;
    existing.amount = existing.amount.plus(row.amount);
    if (existing.ledgers && row.ledgers) {
      existing.ledgers = {
        guest: existing.ledgers.guest.plus(row.ledgers.guest),
        package: existing.ledgers.package.plus(row.ledgers.package),
        ar: existing.ledgers.ar.plus(row.ledgers.ar),
        deposit: existing.ledgers.deposit.plus(row.ledgers.deposit)
      };
    }
    if (row.transactionType !== existing.line.transactionType) {
      pushWarning(warnings, `${label}: el código ${row.code} aparece con tipos distintos (${existing.line.transactionType || "—"} / ${row.transactionType || "—"}); se conserva el primero.`);
    }
    if (!existing.line.description && row.description) existing.line.description = row.description;
  }
  const out: PmsShadowRevenueParsedLine[] = [];
  for (const entry of byCode.values()) {
    if (entry.count > 1) pushWarning(warnings, `${label}: el código ${entry.line.code} aparece ${entry.count} veces; se suman sus importes.`);
    const line: PmsShadowRevenueParsedLine = { ...entry.line, amount: money(entry.amount) };
    if (entry.ledgers) line.ledgers = { guest: money(entry.ledgers.guest), package: money(entry.ledgers.package), ar: money(entry.ledgers.ar), deposit: money(entry.ledgers.deposit) };
    out.push(line);
  }
  return out;
}

function sumAmounts(lines: readonly PmsShadowRevenueParsedLine[]): MoneyString {
  let total: Dec = ZERO;
  for (const line of lines) total = total.plus(line.amount);
  return money(total);
}

// ---------------------------------------------------------------------------
// XML GEN_XMLBO_REVENUE
// ---------------------------------------------------------------------------

const LEDGER_ELEMENTS = { guest: "total_guest_ledger", package: "total_package_ledger", ar: "total_ar_ledger", deposit: "total_deposit_ledger" } as const;

/** Export XML `GEN_XMLBO_REVENUE` → líneas por transaction code (elementos literales de Oracle [V]). */
export function parseGenXmlboRevenue(input: string | Uint8Array): PmsShadowRevenueParsed {
  const warnings: string[] = [];
  const document = parseXmlOrThrow(input);
  const revenue = findFirst(document, "revenue") ?? findFirst(document, "REVENUE");
  if (!revenue) unreadable("El XML no contiene el elemento <revenue> del export GEN_XMLBO_REVENUE.", { reason: "no_revenue_element", root: document.name });

  const hotelCodeRaw = attrOrChild(revenue, "hotel_code");
  const hotelCode = hotelCodeRaw && hotelCodeRaw.trim() !== "" ? hotelCodeRaw.trim() : null;
  if (!hotelCode) pushWarning(warnings, "El XML no declara hotel_code: no se puede comprobar el hotel del perfil.");
  const dateRaw = attrOrChild(revenue, "date");
  let businessDate: IsoDate | null = null;
  if (dateRaw && dateRaw.trim() !== "") {
    businessDate = normalizeIsoDate(dateRaw) ?? parseFeedDate(dateRaw);
    if (!businessDate) unreadable(`La fecha «${dateRaw.trim()}» del XML no tiene formato YYYY-MM-DD.`, { reason: "bad_date" });
  } else {
    pushWarning(warnings, "El XML no declara la fecha (date): indica el business date al importar.");
  }

  const rows: PmsShadowRevenueParsedLine[] = [];
  let index = 0;
  for (const total of childrenNamed(revenue, "transaction_total")) {
    index += 1;
    const code = (childText(total, "transaction_code") ?? "").trim();
    if (code === "") {
      pushWarning(warnings, `transaction_total nº ${index} sin transaction_code: se omite.`);
      continue;
    }
    const typeRaw = (attrOrChild(total, "transaction_type") ?? "").trim().toUpperCase().replace(/[_\s]+/g, " ");
    let transactionType = typeRaw;
    if (typeRaw === "") {
      pushWarning(warnings, `código ${code}: sin transaction_type; se trata como REVENUE.`);
      transactionType = "REVENUE";
    } else if (!(PMS_SHADOW_XML_TRANSACTION_TYPES as readonly string[]).includes(typeRaw)) {
      pushWarning(warnings, `código ${code}: transaction_type «${typeRaw}» no documentado; se conserva tal cual.`);
    }
    const amountRaw = childText(total, "total_amount");
    const amount = parseXmlAmount(amountRaw);
    if (amount === null) unreadable(`código ${code}: total_amount «${(amountRaw ?? "").trim()}» no es un importe válido.`, { reason: "bad_amount", code });
    if (amountRaw && /\.\d{3,}$/.test(amountRaw.trim())) pushWarning(warnings, `código ${code}: total_amount con más de 2 decimales; se redondea.`);
    const ledgers: PmsShadowRevenueLedgers = { guest: "0.00", package: "0.00", ar: "0.00", deposit: "0.00" };
    for (const [key, element] of Object.entries(LEDGER_ELEMENTS) as Array<[keyof PmsShadowRevenueLedgers, string]>) {
      const raw = childText(total, element);
      if (raw === null || raw.trim() === "") continue;
      const value = parseXmlAmount(raw);
      if (value === null) {
        pushWarning(warnings, `código ${code}: ${element} «${raw.trim()}» no es un importe válido; se toma 0.`);
        continue;
      }
      ledgers[key] = money(value);
    }
    // Detalle por market code / room class: solo cuadre informativo.
    const details = findFirst(total, "transaction_details");
    if (details) {
      let detailSum: Dec = ZERO;
      let detailCount = 0;
      for (const transaction of childrenNamed(details, "transaction")) {
        const trx = parseXmlAmount(attrOrChild(transaction, "trx_amount"));
        if (trx === null) continue;
        detailSum = detailSum.plus(trx);
        detailCount += 1;
      }
      if (detailCount > 0 && !detailSum.toDecimalPlaces(2, D.ROUND_HALF_UP).equals(amount.toDecimalPlaces(2, D.ROUND_HALF_UP))) {
        pushWarning(warnings, `código ${code}: Σ trx_amount del detalle (${money(detailSum)}) ≠ total_amount (${money(amount)}); se usa total_amount.`);
      }
    }
    rows.push({ code, description: (childText(total, "description") ?? "").trim(), transactionType, amount: money(amount), ledgers });
  }

  const lines = aggregateByCode(rows, warnings, "XML de ingresos");
  if (lines.length === 0) empty("El XML de ingresos no contiene ningún transaction_total con código.");
  return { source: "xml_revenue", hotelCode, businessDate, lines, sumTotalAmount: sumAmounts(lines), warnings };
}

// ---------------------------------------------------------------------------
// findeptcodes · XML (modelo de datos BI Publisher) [S]
// ---------------------------------------------------------------------------

function childByFoldedName(node: XmlNode, folded: string): XmlNode | null {
  return node.children.find((child) => foldLabel(child.name) === folded) ?? null;
}

/** Informe `findeptcodes` en XML: filas = elementos con un hijo TRN_CODE (o el nombre del mapa); Day Net; subtotales descartados. */
export function parseFindeptcodesXml(input: string | Uint8Array, elementNames: Partial<FindeptcodesElementNames> = {}): PmsShadowRevenueParsed {
  const warnings: string[] = [];
  const names: FindeptcodesElementNames = { ...FINDEPTCODES_DEFAULT_ELEMENTS, ...elementNames };
  const folded = {
    code: foldLabel(names.code),
    description: foldLabel(names.description),
    dayGross: foldLabel(names.dayGross),
    dayNet: foldLabel(names.dayNet),
    businessDate: foldLabel(names.businessDate)
  };
  const document = parseXmlOrThrow(input);

  const rows: PmsShadowRevenueParsedLine[] = [];
  let businessDate: IsoDate | null = null;
  let discarded = 0;
  let usedGross = 0;
  walkXml(document, (node) => {
    if (businessDate === null && foldLabel(node.name) === folded.businessDate && node.text.trim() !== "") {
      businessDate = parseFeedDate(node.text);
    }
    const codeNode = childByFoldedName(node, folded.code);
    if (!codeNode) return;
    const code = codeNode.text.trim();
    const description = (childByFoldedName(node, folded.description)?.text ?? "").trim();
    if (isSubtotalRow(code, description)) {
      discarded += 1;
      return;
    }
    let raw = childByFoldedName(node, folded.dayNet)?.text ?? null;
    if (raw === null || raw.trim() === "") {
      const gross = childByFoldedName(node, folded.dayGross)?.text ?? null;
      if (gross !== null && gross.trim() !== "") {
        usedGross += 1;
        raw = gross;
      }
    }
    if (raw === null || raw.trim() === "") {
      pushWarning(warnings, `código ${code}: sin ${names.dayNet} ni ${names.dayGross}; se toma 0.`);
      raw = "0";
    }
    const amount = parseXmlAmount(raw) ?? parseAmountFlexible(raw);
    if (amount === null) unreadable(`código ${code}: importe «${raw.trim()}» no válido.`, { reason: "bad_amount", code });
    rows.push({ code, description, transactionType: "", amount: money(amount) });
  });
  if (rows.length === 0) {
    if (discarded === 0) unreadable(`El XML no contiene filas con el elemento ${names.code} (informe findeptcodes).`, { reason: "no_rows", element: names.code });
    empty("El informe findeptcodes solo contiene subtotales.");
  }
  if (discarded > 0) pushWarning(warnings, `${discarded} fila(s) de subtotal / total descartadas.`);
  if (usedGross > 0) pushWarning(warnings, `${usedGross} fila(s) sin ${names.dayNet}: se ha usado ${names.dayGross}.`);
  if (businessDate === null) pushWarning(warnings, "El informe no declara el business date: indícalo al importar.");
  const lines = aggregateByCode(rows, warnings, "findeptcodes");
  return { source: "findeptcodes_xml", hotelCode: null, businessDate, lines, sumTotalAmount: sumAmounts(lines), warnings };
}

// ---------------------------------------------------------------------------
// CSV común
// ---------------------------------------------------------------------------

function csvTable(input: string | Uint8Array, limits: { maxRows?: number } = {}): ParsedTable {
  const size = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.length;
  if (size > PMS_SHADOW_MAX_FILE_BYTES) tooLarge(size);
  try {
    return parseCsvTable(input, limits);
  } catch (error) {
    if (error instanceof ReservationImportParseError) {
      if (error.code === "RESERVATION_IMPORT_TOO_LARGE") tooLarge(Number(error.details?.bytes ?? size));
      if (error.code === "RESERVATION_IMPORT_EMPTY") empty("El fichero de ingresos está vacío.");
      unreadable(error.message, { reason: error.code, ...(error.details ?? {}) });
    }
    throw error;
  }
}

function columnIndex(header: readonly string[], folded: string): number {
  return header.findIndex((cell) => foldLabel(cell) === folded);
}

// ---------------------------------------------------------------------------
// findeptcodes · Delimited Data [V cabeceras]
// ---------------------------------------------------------------------------

/** Informe `findeptcodes` en «Delimited Data» → líneas (Day Net; subtotales y Grand Total descartados). */
export function parseFindeptcodesDelimited(input: string | Uint8Array): PmsShadowRevenueParsed {
  const table = csvTable(input);
  const warnings = [...table.warnings];
  const codeIdx = columnIndex(table.header, FINDEPTCODES_CSV_HEADERS.code);
  const descriptionIdx = columnIndex(table.header, FINDEPTCODES_CSV_HEADERS.description);
  const netIdx = columnIndex(table.header, FINDEPTCODES_CSV_HEADERS.dayNet);
  const grossIdx = columnIndex(table.header, FINDEPTCODES_CSV_HEADERS.dayGross);
  if (codeIdx < 0 || (netIdx < 0 && grossIdx < 0)) {
    unreadable("El fichero no tiene las columnas «Trn. Code» y «Day Net» del informe findeptcodes.", { reason: "missing_columns", header: table.header });
  }
  if (netIdx < 0) pushWarning(warnings, "Sin columna «Day Net»: se usa «Day Gross».");

  const rows: PmsShadowRevenueParsedLine[] = [];
  let discarded = 0;
  for (const row of table.rows) {
    const code = (row.cells[codeIdx] ?? "").trim();
    const description = descriptionIdx >= 0 ? (row.cells[descriptionIdx] ?? "").trim() : "";
    if (isSubtotalRow(code, description)) {
      discarded += 1;
      continue;
    }
    const raw = netIdx >= 0 ? (row.cells[netIdx] ?? "") : (row.cells[grossIdx] ?? "");
    const amount = raw.trim() === "" ? ZERO : parseAmountFlexible(raw);
    if (amount === null) unreadable(`fila ${row.rowNumber} (código ${code}): importe no válido.`, { reason: "bad_amount", row: row.rowNumber, code });
    rows.push({ code, description, transactionType: "", amount: money(amount) });
  }
  if (rows.length === 0) empty("El informe findeptcodes solo contiene subtotales.");
  if (discarded > 0) pushWarning(warnings, `${discarded} fila(s) de subtotal / total descartadas.`);
  const distinct = new Set(rows.map((row) => foldLabel(row.code))).size;
  if (distinct !== rows.length) {
    pushWarning(warnings, `Delimited con group-by: ${rows.length} filas de datos para ${distinct} códigos distintos (Oracle desaconseja este formato en informes agrupados); se suman los repetidos. Valida con el PDF o usa el XML.`);
  }
  const lines = aggregateByCode(rows, warnings, "findeptcodes");
  pushWarning(warnings, "El informe no declara el business date: indícalo al importar.");
  return { source: "findeptcodes_csv", hotelCode: null, businessDate: null, lines, sumTotalAmount: sumAmounts(lines), warnings };
}

// ---------------------------------------------------------------------------
// RESPONSYS_TRX [V columnas]
// ---------------------------------------------------------------------------

function splitList(value: string): string[] {
  return value
    .split(/[|;,]/)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** Export `RESPONSYS_TRX` → líneas agregadas por REVENUE_TYPES (tipo REVENUE); fecha = TRANSACTION_DATE única. */
export function parseResponsysTrx(input: string | Uint8Array): PmsShadowRevenueParsed {
  const table = csvTable(input, { maxRows: 100_000 });
  const warnings = [...table.warnings];
  const dateIdx = columnIndex(table.header, "transaction_date");
  const typesIdx = columnIndex(table.header, "revenue_types");
  const amountsIdx = columnIndex(table.header, "revenue_amounts");
  const currencyIdx = columnIndex(table.header, "currency");
  if (typesIdx < 0 || amountsIdx < 0) {
    unreadable("El fichero no tiene las columnas REVENUE_TYPES y REVENUE_AMOUNTS del export RESPONSYS_TRX.", { reason: "missing_columns", header: table.header });
  }
  if (dateIdx < 0) pushWarning(warnings, "Sin columna TRANSACTION_DATE: indica el business date al importar.");

  const totals = new Map<string, { code: string; amount: Dec }>();
  const dates = new Set<IsoDate>();
  const currencies = new Set<string>();
  let skipped = 0;
  for (const row of table.rows) {
    const typesRaw = (row.cells[typesIdx] ?? "").trim();
    const amountsRaw = (row.cells[amountsIdx] ?? "").trim();
    if (typesRaw === "" && amountsRaw === "") {
      skipped += 1;
      continue;
    }
    const types = splitList(typesRaw);
    const amounts = splitList(amountsRaw);
    if (types.length === 0) {
      skipped += 1;
      continue;
    }
    let pairs: Array<[string, string]>;
    if (types.length === amounts.length) {
      pairs = types.map((type, index) => [type, amounts[index]!]);
    } else if (types.length === 1) {
      pairs = [[types[0]!, amountsRaw]];
    } else {
      unreadable(`fila ${row.rowNumber}: REVENUE_TYPES (${types.length}) y REVENUE_AMOUNTS (${amounts.length}) no tienen el mismo número de valores.`, { reason: "types_amounts_mismatch", row: row.rowNumber });
    }
    for (const [type, amountRaw] of pairs) {
      const amount = parseXmlAmount(amountRaw) ?? parseAmountFlexible(amountRaw);
      if (amount === null) unreadable(`fila ${row.rowNumber} (${type}): importe «${amountRaw}» no válido.`, { reason: "bad_amount", row: row.rowNumber });
      const key = foldLabel(type);
      const entry = totals.get(key) ?? { code: type, amount: ZERO };
      entry.amount = entry.amount.plus(amount);
      totals.set(key, entry);
    }
    if (dateIdx >= 0) {
      const dateRaw = (row.cells[dateIdx] ?? "").trim();
      if (dateRaw !== "") {
        const date = parseFeedDate(dateRaw);
        if (!date) unreadable(`fila ${row.rowNumber}: TRANSACTION_DATE «${dateRaw}» no reconocida.`, { reason: "bad_date", row: row.rowNumber });
        dates.add(date);
      }
    }
    if (currencyIdx >= 0) {
      const currency = (row.cells[currencyIdx] ?? "").trim().toUpperCase();
      if (currency !== "") currencies.add(currency);
    }
  }
  if (totals.size === 0) empty("El export RESPONSYS_TRX no contiene transacciones con REVENUE_TYPES.");
  if (skipped > 0) pushWarning(warnings, `${skipped} fila(s) sin REVENUE_TYPES omitidas.`);
  if (dates.size > 1) {
    throw ledgerBadRequest("PMS_SHADOW_REVENUE_DAY_MISMATCH", `El export RESPONSYS_TRX mezcla ${dates.size} fechas de transacción: un lote = un business date.`, { dates: Array.from(dates).sort() });
  }
  const foreign = Array.from(currencies).filter((currency) => currency !== "EUR");
  if (foreign.length > 0) pushWarning(warnings, `Moneda distinta de EUR en el export (${foreign.join(", ")}): los importes se toman tal cual.`);
  const lines: PmsShadowRevenueParsedLine[] = Array.from(totals.values())
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((entry) => ({ code: entry.code, description: entry.code, transactionType: "REVENUE", amount: money(entry.amount) }));
  const businessDate = dates.size === 1 ? Array.from(dates)[0]! : null;
  return { source: "responsys_trx", hotelCode: null, businessDate, lines, sumTotalAmount: sumAmounts(lines), warnings };
}

// ---------------------------------------------------------------------------
// Entrada: bytes, sniff y despacho
// ---------------------------------------------------------------------------

/** `content` (texto) o `contentBase64` (bytes) → bytes; tamaño acotado; vacío → PMS_SHADOW_REVENUE_EMPTY. */
export function revenueFileBytes(input: Pick<PmsShadowRevenueFileInput, "content" | "contentBase64">): Uint8Array {
  const hasBase64 = typeof input.contentBase64 === "string" && input.contentBase64.length > 0;
  const hasContent = typeof input.content === "string" && input.content.length > 0;
  if (!hasBase64 && !hasContent) empty("No se ha recibido ningún fichero de ingresos.");
  const bytes = hasBase64 ? new Uint8Array(Buffer.from(input.contentBase64!, "base64")) : new Uint8Array(Buffer.from(input.content!, "utf8"));
  if (bytes.length > PMS_SHADOW_MAX_FILE_BYTES) tooLarge(bytes.length);
  if (bytes.length === 0) empty("El fichero de ingresos está vacío.");
  return bytes;
}

/** Primeros caracteres del fichero (decodificados) para el sniff. */
export function revenueFileHead(bytes: Uint8Array, chars = 4096): string {
  return decodeBytes(bytes.subarray(0, Math.min(bytes.length, chars * 4))).text.slice(0, chars);
}

/**
 * Formato por nombre y contenido: XML con `<revenue` → xml_revenue; XML con
 * `trn_code` → findeptcodes_xml; texto con la cabecera «Trn. Code» →
 * findeptcodes_csv; texto con TRANSACTION_ID / REVENUE_TYPES → responsys_trx;
 * null si no se reconoce.
 */
export function sniffRevenueSource(fileName: string | null | undefined, head: string): PmsShadowRevenueSource | null {
  const text = head.replace(/^\uFEFF/, "");
  const lower = text.toLowerCase();
  const name = (fileName ?? "").trim().toLowerCase();
  const looksXml = /^\s*(<\?xml|<!--|<[a-z_])/i.test(text) || name.endsWith(".xml");
  if (looksXml) {
    if (/<(?:[a-z_][\w.-]*:)?revenue\b/i.test(text)) return "xml_revenue";
    if (/<(?:[a-z_][\w.-]*:)?trn_code\b/i.test(text) || /findeptcodes/i.test(text)) return "findeptcodes_xml";
    if (/gen_xmlbo_rev|xmlbo_revenue/i.test(name)) return "xml_revenue";
    if (/findeptcodes|findept/i.test(name)) return "findeptcodes_xml";
    return null;
  }
  const headerLine = lower.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  if (/trn\.?\s*_?code/.test(headerLine) && /day\s*_?net|day\s*_?gross/.test(headerLine)) return "findeptcodes_csv";
  if (/transaction_id|revenue_types|revenue_amounts/.test(headerLine)) return "responsys_trx";
  if (/findeptcodes|findept/i.test(name)) return "findeptcodes_csv";
  if (/responsys_trx|resp_trx/i.test(name)) return "responsys_trx";
  return null;
}

/** Entrada del servicio y del CLI: bytes → sniff (si `source` es auto / ausente) → parser del formato. */
export function parseRevenueFile(input: PmsShadowRevenueFileInput): { parsed: PmsShadowRevenueParsed; bytes: Uint8Array; source: PmsShadowRevenueSource } {
  const bytes = revenueFileBytes(input);
  let source: PmsShadowRevenueSource | null = input.source && input.source !== "auto" ? input.source : null;
  if (!source) {
    source = sniffRevenueSource(input.fileName, revenueFileHead(bytes));
    if (!source) {
      throw ledgerBadRequest("PMS_SHADOW_FEED_UNKNOWN", "No se reconoce el formato del fichero de ingresos: indica source (xml_revenue · findeptcodes_xml · findeptcodes_csv · responsys_trx).", { fileName: input.fileName ?? null });
    }
  }
  let parsed: PmsShadowRevenueParsed;
  switch (source) {
    case "xml_revenue":
      parsed = parseGenXmlboRevenue(bytes);
      break;
    case "findeptcodes_xml":
      parsed = parseFindeptcodesXml(bytes);
      break;
    case "findeptcodes_csv":
      parsed = parseFindeptcodesDelimited(bytes);
      break;
    case "responsys_trx":
      parsed = parseResponsysTrx(bytes);
      break;
  }
  const decoded = decodeXmlBytes(bytes);
  if (decoded.encoding === "windows-1252" && !parsed.warnings.some((w) => w.includes("Windows-1252"))) {
    parsed.warnings.unshift("El fichero no es UTF-8: se ha leído como Windows-1252 (latin1).");
  }
  return { parsed, bytes, source };
}

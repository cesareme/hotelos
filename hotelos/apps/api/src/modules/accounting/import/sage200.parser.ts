// Importación contable desde Sage 200 (Tanda 7c · L1) — lectores por CABECERA, PUROS.
//
// Sage 200 no documenta las columnas de sus Excel («Enviar a Excel» exporta lo que
// se ve en pantalla) ni la estructura del XML (diseño §2.1, §4.3, §10.3): por eso
// todo se lee por cabecera con sinónimos plegados (`SAGE_HEADER_SYNONYMS`, [S]
// hasta tener una exportación real) y nunca por posición.
//   · `detectLedgerImportFormat({ fileName, bytes, content, header, kind })` →
//     `sage_ime_csv` si la cabecera ⊇ {CodigoEmpresa, Ejercicio, Asiento, CargoAbono,
//     CodigoCuenta, FechaAsiento, ImporteAsiento}; `canonical_csv` si ⊇ la cabecera
//     canónica del tipo (§4.3); `canonical_json` si es JSON { system, company, kind,
//     rows }; `sage_xml` si .xml / .zip (un ZIP con `xl/` es un .xlsx); si no
//     `sage_excel` cuando la cabecera casa con algún campo del tipo; desconocido →
//     LEDGER_IMPORT_FORMAT_UNKNOWN;
//   · `parseSageJournal(table, { format })` → filas canónicas (Debe/Haber o
//     CargoAbono D/H + Importe; fechas dd/mm/yyyy, yyyy-mm-dd y seriales Excel;
//     decimales con coma o punto; NumeroPeriodo por columna o por mes de la fecha);
//     `parseSageBalances`, `parseSagePlan`, `parseSageThirdParties` análogos;
//   · `parseSageVatBook(bytes)` — Libro Registro de IVA «Formato Libros AEAT»: hojas
//     EXPEDIDAS_INGRESOS / RECIBIDAS_GASTOS leídas con `readXlsxTable` (filas crudas)
//     porque la cabecera va en las filas 7-8; la fila de cabecera se LOCALIZA POR
//     CONTENIDO (la primera cuyas celdas plegadas contienen «fecha_expedicion» /
//     «base_imponible» / «nif»…, nunca por índice) y los campos genéricos («Serie»,
//     «Número», «NIF»…) se prefijan con el grupo de la fila superior
//     («Identificación de la Factura» → identificacion_factura_serie);
//   · `readSageTable` — XLSX / CSV de cualquier tipo: si la primera fila no es la
//     cabecera (listados con título), se localiza por contenido igual;
//   · `parseLedgerImportFile(input)` — entrada única de las rutas y del CLI.
//
// Errores tipados: `LedgerImportParseError(code, message, details)` (definida en
// ledger-import.canonical.ts y reexportada aquí). Sin Prisma, sin red, sin disco.

import type { LedgerImportFormat, LedgerImportKind } from "@hotelos/shared";
import { XlsxLiteError, readXlsxTable, readZipCentralDirectory, type XlsxRow } from "../../../lib/xlsx-lite.js";
import { foldHeader } from "../../pms/reservation-import.mapping.js";
import type { ParsedRow, ParsedTable } from "../../pms/reservation-import.parser.js";
import {
  CANONICAL_COLUMNS,
  LEDGER_TABLE_LIMITS,
  LedgerImportParseError,
  compactHeader,
  hasZipSignature,
  matchColumns,
  parseBalancesTable,
  parseCanonicalJson,
  parseJournalTable,
  parsePlanTable,
  parseThirdPartiesTable,
  parseVatTable,
  readLedgerTable,
  type BalancesTableOptions,
  type CanonicalBalanceRow,
  type CanonicalJournalRow,
  type CanonicalPlanRow,
  type CanonicalRowOf,
  type CanonicalThirdPartyRow,
  type CanonicalVatRow,
  type HeaderSynonyms,
  type TableParseResult
} from "./ledger-import.canonical.js";
import { parseSageXml } from "./sage200.xml.js";

export { LedgerImportParseError } from "./ledger-import.canonical.js";

// ---------------------------------------------------------------------------
// Sinónimos de cabecera por campo canónico (plegados; se comparan en forma compacta)
// ---------------------------------------------------------------------------

const JOURNAL_SYNONYMS: HeaderSynonyms = Object.freeze({
  empresa: ["empresa", "codigo_empresa", "cod_empresa", "id_empresa", "company"],
  ejercicio: ["ejercicio", "ano", "anio", "year", "ejercicio_contable"],
  asiento: ["asiento", "n_asiento", "num_asiento", "numero_asiento", "no_asiento", "nasiento", "asiento_n"],
  fecha: ["fecha", "fecha_asiento", "fecha_contable", "f_asiento", "fecha_apunte"],
  periodo: ["periodo", "numero_periodo", "n_periodo", "num_periodo", "nombre_periodo", "mes", "periodo_contable"],
  cuenta: ["cuenta", "codigo_cuenta", "cod_cuenta", "subcuenta", "codigo_subcuenta", "n_cuenta", "numero_cuenta", "cuenta_contable", "cta"],
  contrapartida: ["contrapartida", "cuenta_contrapartida", "cta_contrapartida"],
  concepto: ["concepto", "comentario", "descripcion", "descripcion_apunte", "texto", "observaciones", "concepto_apunte"],
  debe: ["debe", "importe_debe", "cargo_importe", "debit"],
  haber: ["haber", "importe_haber", "abono_importe", "credit"],
  cargo_abono: ["cargo_abono", "cargoabono", "d_h", "dh", "debe_haber", "tipo_apunte", "signo", "naturaleza", "cargo", "abono"],
  importe: ["importe", "importe_asiento", "importe_apunte", "valor", "amount"],
  documento: ["documento", "documento_conta", "n_documento", "num_documento", "referencia", "doc", "numero_documento"],
  diario: ["diario", "codigo_diario", "cod_diario"],
  canal: ["canal", "codigo_canal", "cod_canal"],
  delegacion: ["delegacion", "id_delegacion", "codigo_delegacion", "cod_delegacion"],
  departamento: ["departamento", "codigo_departamento", "cod_departamento"],
  seccion: ["seccion", "codigo_seccion", "cod_seccion"],
  proyecto: ["proyecto", "codigo_proyecto", "cod_proyecto"],
  serie: ["serie", "serie_factura"],
  factura: ["factura", "numero_factura", "n_factura", "num_factura", "no_factura"],
  su_factura_no: ["su_factura_no", "su_factura", "sufacturano", "numero_factura_proveedor", "factura_proveedor", "identificacion_factura"],
  fecha_factura: ["fecha_factura", "f_factura"],
  ejercicio_factura: ["ejercicio_factura"],
  nif: ["nif", "cif_dni", "cifdni", "cif", "dni", "nif_cif", "nif_tercero", "cif_nif"],
  nombre: ["nombre", "razon_social", "nombre_tercero", "tercero", "nombre_razon_social"],
  base_iva: ["base_iva", "base_iva1", "base_iva_1", "base_imponible", "base"],
  base_iva2: ["base_iva2", "base_iva_2"],
  base_iva3: ["base_iva3", "base_iva_3"],
  codigo_iva: ["codigo_iva", "codigo_iva1", "codigo_iva_1"],
  tipo_iva: ["tipo_iva", "por_iva", "por_iva1", "por_iva_1", "porcentaje_iva", "iva", "poriva"],
  cuota_iva: ["cuota_iva", "cuota_iva1", "cuota_iva_1", "cuota"],
  cuota_iva2: ["cuota_iva2", "cuota_iva_2"],
  cuota_iva3: ["cuota_iva3", "cuota_iva_3"],
  tipo_factura: ["tipo_factura"]
});

const BALANCES_SYNONYMS: HeaderSynonyms = Object.freeze({
  empresa: ["empresa", "codigo_empresa", "cod_empresa"],
  ejercicio: ["ejercicio", "ano", "anio", "year"],
  periodo: ["periodo", "numero_periodo", "mes", "trimestre", "periodo_contable"],
  cuenta: ["cuenta", "codigo_cuenta", "cod_cuenta", "subcuenta", "n_cuenta", "numero_cuenta", "cuenta_contable", "cta"],
  titulo: ["titulo", "descripcion", "nombre", "nombre_cuenta", "titulo_cuenta", "denominacion", "cuenta_descripcion"],
  delegacion: ["delegacion", "id_delegacion", "codigo_delegacion", "canal", "codigo_canal", "centro"],
  apertura_debe: ["apertura_debe", "debe_apertura", "sumas_anteriores_debe", "debe_anterior", "debe_acumulado_anterior", "saldo_anterior_debe", "debe_apertura_ejercicio"],
  apertura_haber: ["apertura_haber", "haber_apertura", "sumas_anteriores_haber", "haber_anterior", "haber_acumulado_anterior", "saldo_anterior_haber", "haber_apertura_ejercicio"],
  saldo_apertura: ["saldo_apertura", "sumas_anteriores", "saldo_anterior", "apertura", "saldo_inicial"],
  debe: ["debe", "debe_periodo", "sumas_debe", "debe_mes", "debe_ejercicio"],
  haber: ["haber", "haber_periodo", "sumas_haber", "haber_mes", "haber_ejercicio"],
  saldo: ["saldo", "saldo_final", "saldo_periodo", "saldo_acumulado"],
  saldo_deudor: ["saldo_deudor", "deudor", "saldos_deudor", "saldo_deudor_acumulado"],
  saldo_acreedor: ["saldo_acreedor", "acreedor", "saldos_acreedor", "saldo_acreedor_acumulado"]
});

const PLAN_SYNONYMS: HeaderSynonyms = Object.freeze({
  cuenta: ["cuenta", "codigo_cuenta", "cod_cuenta", "codigo", "subcuenta", "numero_cuenta", "n_cuenta"],
  titulo: ["titulo", "descripcion", "nombre", "cuenta_descripcion", "denominacion", "nombre_cuenta", "titulo_cuenta"],
  nif: ["nif", "cif_dni", "cifdni", "cif", "dni", "nif_cif"],
  pais: ["pais", "sigla_nacion", "siglanacion", "codigo_pais", "nacion"],
  longitud: ["longitud", "longitud_cuenta", "nivel", "digitos", "tamano"]
});

const THIRD_PARTIES_SYNONYMS: HeaderSynonyms = Object.freeze({
  codigo: ["codigo", "codigo_cliente", "codigo_proveedor", "cod_cliente", "cod_proveedor", "cliente", "proveedor", "id", "codigo_tercero", "codigo_cliente_proveedor"],
  cuenta: ["cuenta", "codigo_contable", "cod_contable", "cuenta_contable", "codigo_cuenta", "subcuenta"],
  nif: ["nif", "cif_dni", "cifdni", "cif", "dni", "nif_cif"],
  pais: ["pais", "sigla_nacion", "siglanacion", "codigo_pais", "nacion"],
  nombre: ["nombre", "razon_social", "razonsocial", "nombre_comercial", "denominacion", "nombre_razon_social"],
  rol: ["rol", "tipo", "tipo_tercero", "clase", "tipo_cliente_proveedor"]
});

const VAT_SYNONYMS: HeaderSynonyms = Object.freeze({
  libro: ["libro", "tipo_libro"],
  empresa: ["empresa", "codigo_empresa"],
  ejercicio: ["ejercicio", "autoliquidacion_ejercicio"],
  periodo: ["periodo", "autoliquidacion_periodo"],
  fecha: ["fecha_expedicion", "fecha_factura", "fecha", "fecha_emision", "identificacion_factura_fecha_expedicion"],
  fecha_operacion: ["fecha_operacion"],
  serie: ["serie", "identificacion_factura_serie", "identificacion_factura_expedidor_serie", "serie_factura"],
  numero: ["numero", "identificacion_factura_numero", "identificacion_factura_expedidor_numero", "numero_factura", "n_factura", "factura", "num_factura"],
  nif: ["nif", "nif_destinatario", "nif_expedidor", "destinatario_nif", "expedidor_nif", "cif_dni", "nif_cif", "cif"],
  nombre: ["nombre", "nombre_destinatario", "nombre_expedidor", "destinatario_nombre", "expedidor_nombre", "razon_social", "nombre_razon_social"],
  pais: ["pais", "codigo_pais", "destinatario_codigo_pais", "expedidor_codigo_pais", "sigla_nacion"],
  base: ["base_imponible", "base", "base_iva"],
  tipo_iva: ["tipo_iva", "por_iva", "porcentaje_iva", "tipo_impositivo"],
  cuota: ["cuota_iva_repercutida", "cuota_iva_soportada", "cuota_iva", "cuota", "cuota_repercutida", "cuota_soportada"],
  cuota_deducible: ["cuota_deducible"],
  total: ["total_factura", "total", "importe_total", "total_operacion"],
  tipo_recargo: ["tipo_recargo_eq", "tipo_recargo_equivalencia", "tipo_recargo", "recargo_eq_tipo", "por_recargo_equivalencia"],
  cuota_recargo: ["cuota_recargo_eq", "cuota_recargo_equivalencia", "cuota_recargo", "recargo_eq_cuota", "recargo_equivalencia"],
  tipo_retencion: ["tipo_retencion", "retencion_tipo", "por_retencion"],
  retencion: ["importe_retencion", "retencion", "importe_de_la_retencion", "base_retencion_importe"],
  tipo_factura: ["tipo_factura"],
  tipo_rectificativa: ["tipo_rectificativa"],
  rectificativa: ["rectificativa", "es_rectificativa"]
});

/** Sinónimos por campo canónico y tipo de lote (cabeceras plegadas con `foldHeader`; la comparación es en forma compacta, sin «_»). */
export const SAGE_HEADER_SYNONYMS: Readonly<Record<LedgerImportKind, HeaderSynonyms>> = Object.freeze({
  journal: JOURNAL_SYNONYMS,
  fiscal_years: JOURNAL_SYNONYMS,
  balances: BALANCES_SYNONYMS,
  plan: PLAN_SYNONYMS,
  third_parties: THIRD_PARTIES_SYNONYMS,
  vat_books: VAT_SYNONYMS
});

/** Cabeceras del CSV IME (formato de importación de asientos de Sage 200, §2.1 D) que identifican el formato. */
export const SAGE_IME_SIGNATURE_HEADERS: readonly string[] = Object.freeze(["CodigoEmpresa", "Ejercicio", "Asiento", "CargoAbono", "CodigoCuenta", "FechaAsiento", "ImporteAsiento"]);

/** Las 60 columnas del CSV IME (§2.1 D), en su orden. */
export const SAGE_IME_COLUMNS: readonly string[] = Object.freeze([
  "CodigoEmpresa", "Ejercicio", "Asiento", "CargoAbono", "CodigoCuenta", "Contrapartida", "FechaAsiento", "DocumentoConta", "Comentario", "ImporteAsiento",
  "CodigoDiario", "CodigoCanal", "CodigoDepartamento", "CodigoSeccion", "CodigoProyecto", "IdDelegacion", "FechaVencimiento", "NumeroPeriodo", "TipoCarteraIME", "TipoAnaliticaIME",
  "TipoImportacionIME", "BaseIva1", "BaseIva2", "BaseIva3", "CodigoIva1", "CodigoIva2", "CodigoIva3", "PorIva1", "PorIva2", "PorIva3",
  "CuotaIva1", "CuotaIva2", "CuotaIva3", "PorRecargoEquivalencia1", "PorRecargoEquivalencia2", "PorRecargoEquivalencia3", "RecargoEquivalencia1", "RecargoEquivalencia2", "RecargoEquivalencia3", "CodigoTransaccion1",
  "CodigoTransaccion2", "CodigoTransaccion3", "Serie", "Factura", "SuFacturaNo", "FechaFactura", "ImporteFactura", "TipoFactura", "CifDni", "Nombre",
  "CodigoRetencion", "BaseRetencion", "PorRetencion", "ImporteRetencion", "CodigoTerritorio", "SiglaNacion", "EjercicioFactura", "Exclusion347", "Previsiones", "MantenerAsiento"
]);

/** Columnas del CSV IME que el lote no usa (se conocen: no se avisan como desconocidas). */
const IME_KNOWN_UNUSED: readonly string[] = Object.freeze([
  "fechavencimiento", "tipocarteraime", "tipoanaliticaime", "tipoimportacionime", "codigoiva2", "codigoiva3", "poriva2", "poriva3",
  "porrecargoequivalencia1", "porrecargoequivalencia2", "porrecargoequivalencia3", "recargoequivalencia1", "recargoequivalencia2", "recargoequivalencia3",
  "codigotransaccion1", "codigotransaccion2", "codigotransaccion3", "importefactura", "codigoretencion", "baseretencion", "porretencion", "importeretencion",
  "codigoterritorio", "siglanacion", "exclusion347", "previsiones", "mantenerasiento"
]);

/** Columnas del libro AEAT que el lote conoce y no usa (no se avisan). */
const AEAT_KNOWN_UNUSED = /^(actividad_|factura_rectificada_|cobro_|pago_|inmueble_|bien_inversion(_|$)|identificacion_factura_numero_final|identificacion_factura_expedidor_numero_final|numero_final|clave_operacion|calificacion_operacion|operacion_exenta|concepto_ingreso|concepto_gasto|ingreso_computable|gasto_deducible|registro_acuerdo_facturacion|referencia_externa|medio_utilizado|identificacion_medio_utilizado|fecha_recepcion|numero_recepcion|codigo$|tipo$|grupo(_o)?_epigrafe_iae|situacion_inmueble|referencia_catastral)/;

// ---------------------------------------------------------------------------
// Detección de formato
// ---------------------------------------------------------------------------

export type DetectFormatInput = {
  fileName?: string;
  bytes?: Uint8Array;
  content?: string;
  /** Cabecera ya leída (si el llamador la tiene); si falta se lee del fichero. */
  header?: readonly string[];
  /** Tipo de lote pedido: decide la cabecera canónica que se busca. */
  kind?: LedgerImportKind;
};

function looksLikeJson(text: string): boolean {
  const trimmed = text.replace(/^\uFEFF/, "").trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function zipIsWorkbook(bytes: Uint8Array): boolean {
  try {
    const entries = readZipCentralDirectory(bytes);
    return entries.some((entry) => entry.name.toLowerCase().startsWith("xl/") || entry.name === "[Content_Types].xml");
  } catch {
    return false;
  }
}

function headerHasAll(header: readonly string[], required: readonly string[]): boolean {
  const compact = new Set(header.map(compactHeader));
  return required.every((name) => compact.has(compactHeader(name)));
}

function headerMatchesAny(header: readonly string[], synonyms: HeaderSynonyms): boolean {
  return matchColumns(header, synonyms).index.size > 0;
}

/**
 * Formato por firma y cabecera: `sage_ime_csv` (cabecera ⊇ SAGE_IME_SIGNATURE_HEADERS),
 * `canonical_csv` (cabecera ⊇ CANONICAL_COLUMNS del tipo), `canonical_json`, `sage_xml`
 * (.xml / .zip que no es un libro), `sage_excel` si la cabecera casa con algún campo del
 * tipo; si no → LEDGER_IMPORT_FORMAT_UNKNOWN.
 */
export function detectLedgerImportFormat(input: DetectFormatInput): LedgerImportFormat {
  const name = (input.fileName ?? "").trim().toLowerCase();
  const bytes = input.bytes;
  if (/\.(xml)$/.test(name)) return "sage_xml";
  if (/\.zip$/.test(name)) return bytes && zipIsWorkbook(bytes) ? "sage_excel" : "sage_xml";
  if (/\.json$/.test(name)) return "canonical_json";
  if (bytes && hasZipSignature(bytes) && !/\.(xlsx|xlsm)$/.test(name) && !zipIsWorkbook(bytes)) return "sage_xml";
  const text = input.content ?? (bytes && !hasZipSignature(bytes) && bytes.length < 4 * 1024 * 1024 ? new TextDecoder("utf-8").decode(bytes.subarray(0, 64)) : undefined);
  if (text !== undefined && looksLikeJson(text)) return "canonical_json";
  if (bytes && !hasZipSignature(bytes) && !/\.(xlsx|xlsm|csv|txt|tsv)$/.test(name)) {
    const head = new TextDecoder("utf-8").decode(bytes.subarray(0, 256)).replace(/^\uFEFF/, "").trimStart();
    if (head.startsWith("<")) return "sage_xml";
  }
  let header = input.header;
  if (!header) {
    try {
      header = readLedgerTable({ bytes, content: input.content, fileName: input.fileName }).header;
    } catch (error) {
      if (error instanceof LedgerImportParseError && (error.code === "LEDGER_IMPORT_TOO_LARGE" || error.code === "LEDGER_IMPORT_TOO_MANY_ROWS" || error.code === "LEDGER_IMPORT_EMPTY")) throw error;
      throw new LedgerImportParseError("LEDGER_IMPORT_FORMAT_UNKNOWN", "No se reconoce el formato del fichero: indícalo o revisa la cabecera.", { fileName: input.fileName ?? null, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  if (headerHasAll(header, SAGE_IME_SIGNATURE_HEADERS)) return "sage_ime_csv";
  const kinds: LedgerImportKind[] = input.kind ? [input.kind] : (["journal", "balances", "plan", "third_parties", "vat_books"] as LedgerImportKind[]);
  for (const kind of kinds) {
    if (headerHasAll(header, CANONICAL_COLUMNS[kind])) return "canonical_csv";
  }
  for (const kind of kinds) {
    if (headerMatchesAny(header, SAGE_HEADER_SYNONYMS[kind])) return "sage_excel";
  }
  // Libro con filas de título encima de la cabecera: se localiza por contenido (readSageTable).
  if (bytes && hasZipSignature(bytes)) {
    for (const kind of kinds) {
      try {
        const located = readSageTable({ bytes, fileName: input.fileName, reader: "xlsx" }, kind).header;
        if (headerHasAll(located, SAGE_IME_SIGNATURE_HEADERS)) return "sage_ime_csv";
        if (headerHasAll(located, CANONICAL_COLUMNS[kind])) return "canonical_csv";
        if (headerMatchesAny(located, SAGE_HEADER_SYNONYMS[kind])) return "sage_excel";
      } catch (error) {
        if (error instanceof LedgerImportParseError && (error.code === "LEDGER_IMPORT_TOO_LARGE" || error.code === "LEDGER_IMPORT_TOO_MANY_ROWS")) throw error;
      }
    }
    if (input.kind === "vat_books" || !input.kind) {
      try {
        parseSageVatBook(bytes, {});
        return "sage_excel";
      } catch (error) {
        if (error instanceof LedgerImportParseError && (error.code === "LEDGER_IMPORT_TOO_LARGE" || error.code === "LEDGER_IMPORT_TOO_MANY_ROWS")) throw error;
      }
    }
  }
  throw new LedgerImportParseError("LEDGER_IMPORT_FORMAT_UNKNOWN", "No se reconoce el formato del fichero: indícalo o revisa la cabecera.", { fileName: input.fileName ?? null, header: header.slice(0, 20) });
}

// ---------------------------------------------------------------------------
// Localización de la cabecera por contenido (XLSX con título / AEAT filas 7-8)
// ---------------------------------------------------------------------------

/** Campos «genéricos» del libro AEAT que solo tienen sentido con el grupo de la fila superior. */
const GENERIC_AEAT_FIELDS = new Set(["serie", "numero", "numero_final", "fecha", "importe", "codigo", "tipo", "nif", "nombre", "medio_utilizado", "identificacion_medio_utilizado", "cuota", "base", "situacion", "referencia_catastral"]);

function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name, index) => {
    let value = name === "" ? `columna_${index + 1}` : name;
    const times = seen.get(value) ?? 0;
    if (times > 0) value = `${value} (${times + 1})`;
    seen.set(name === "" ? value : name, times + 1);
    return value;
  });
}

/** Tabla `ParsedTable` a partir de las filas crudas de una hoja: `headerIndex` es la fila de cabecera y `groupIndex` (opcional) la fila de grupos que prefija los campos genéricos. */
export function tableFromXlsxRows(rows: readonly XlsxRow[], headerIndex: number, options: { groupIndex?: number | null; sheetName: string; warnings?: string[]; truncated?: boolean } ): ParsedTable {
  const headerRow = rows[headerIndex]!;
  const groupRow = options.groupIndex !== undefined && options.groupIndex !== null ? rows[options.groupIndex]! : null;
  const width = Math.max(headerRow.cells.length, groupRow?.cells.length ?? 0);
  const names: string[] = [];
  let group = "";
  for (let column = 0; column < width; column += 1) {
    const groupCell = groupRow?.cells[column]?.raw.trim() ?? "";
    if (groupCell !== "") group = foldHeader(groupCell);
    const field = headerRow.cells[column]?.raw.trim() ?? "";
    const folded = foldHeader(field);
    if (field === "") {
      names.push("");
      continue;
    }
    names.push(groupRow && group !== "" && GENERIC_AEAT_FIELDS.has(folded) ? `${group}_${folded}` : field);
  }
  while (names.length > 0 && names[names.length - 1] === "") names.pop();
  const header = uniqueNames(names);
  const data: ParsedRow[] = [];
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    const cells = header.map((_, column) => (row.cells[column]?.raw ?? "").trim());
    if (cells.every((cell) => cell === "")) continue;
    data.push({ rowNumber: data.length + 1, line: row.row, cells, kinds: header.map((_, column) => (cells[column] === "" ? "empty" : row.cells[column]?.kind ?? "string")) });
  }
  return { header, rows: data, format: "xlsx", bom: false, sheetName: options.sheetName, warnings: options.warnings ?? [], truncated: options.truncated ?? false };
}

/** Índice de la primera fila cuyas celdas plegadas casan con ≥ `minMatches` campos de los sinónimos (o con `anchors`); −1 si ninguna. */
export function locateHeaderRow(rows: readonly XlsxRow[], synonyms: HeaderSynonyms, options: { minMatches?: number; anchors?: readonly string[]; maxScan?: number } = {}): number {
  const minMatches = options.minMatches ?? 2;
  const limit = Math.min(rows.length, options.maxScan ?? 60);
  for (let index = 0; index < limit; index += 1) {
    const cells = rows[index]!.cells.map((cell) => cell.raw.trim());
    if (cells.filter((cell) => cell !== "").length < minMatches) continue;
    // Con fila de grupos encima, los genéricos se prefijan; sin ella se prueban tal cual.
    const previous = index > 0 && rows[index - 1]!.row === rows[index]!.row - 1 ? index - 1 : null;
    const candidates = [tableFromXlsxRows(rows, index, { groupIndex: null, sheetName: "" }).header];
    if (previous !== null) candidates.push(tableFromXlsxRows(rows, index, { groupIndex: previous, sheetName: "" }).header);
    for (const header of candidates) {
      const match = matchColumns(header, synonyms);
      const anchorsOk = !options.anchors || options.anchors.some((anchor) => match.index.has(anchor));
      if (match.index.size >= minMatches && anchorsOk) return index;
    }
  }
  return -1;
}

export type SageTableInput = {
  bytes?: Uint8Array;
  content?: string;
  fileName?: string;
  sheetName?: string;
  reader?: "xlsx" | "csv";
};

/**
 * XLSX / CSV de Sage → `ParsedTable`. Primero el lector común (`readLedgerTable`); si la
 * primera fila no casa con ningún campo del tipo y el fichero es un XLSX, se localiza la
 * cabecera por contenido en las filas crudas (listados con título encima).
 */
export function readSageTable(input: SageTableInput, kind: LedgerImportKind): ParsedTable {
  const synonyms = SAGE_HEADER_SYNONYMS[kind];
  let firstError: LedgerImportParseError | null = null;
  let table: ParsedTable | null = null;
  try {
    table = readLedgerTable(input);
  } catch (error) {
    if (!(error instanceof LedgerImportParseError) || error.code !== "LEDGER_IMPORT_INVALID" && error.code !== "LEDGER_IMPORT_EMPTY") throw error;
    firstError = error;
  }
  if (table && matchColumns(table.header, synonyms).index.size > 0) return table;
  const name = (input.fileName ?? "").trim().toLowerCase();
  const isXlsx = input.reader === "xlsx" || /\.(xlsx|xlsm)$/.test(name) || (input.bytes !== undefined && hasZipSignature(input.bytes) && !/\.(csv|txt|tsv)$/.test(name));
  if (!isXlsx || !input.bytes) {
    if (firstError) throw firstError;
    return table!;
  }
  let raw;
  try {
    raw = readXlsxTable(input.bytes, { sheetName: input.sheetName, maxRows: LEDGER_TABLE_LIMITS.maxRows + 60, maxCols: LEDGER_TABLE_LIMITS.maxColumns, maxCellChars: LEDGER_TABLE_LIMITS.maxCellChars });
  } catch (error) {
    if (error instanceof XlsxLiteError) throw new LedgerImportParseError("LEDGER_IMPORT_INVALID", error.message, { errors: [{ line: 0, message: error.message }], reason: error.code });
    throw error;
  }
  const headerIndex = locateHeaderRow(raw.rows, synonyms);
  if (headerIndex < 0) {
    if (table) return table;
    throw firstError ?? new LedgerImportParseError("LEDGER_IMPORT_INVALID", "No se ha localizado la fila de cabecera en la hoja.", { errors: [{ line: 0, message: "cabecera no localizada" }], sheetName: raw.sheetName });
  }
  const previous = headerIndex > 0 && raw.rows[headerIndex - 1]!.row === raw.rows[headerIndex]!.row - 1 ? headerIndex - 1 : null;
  const withGroups = previous !== null ? tableFromXlsxRows(raw.rows, headerIndex, { groupIndex: previous, sheetName: raw.sheetName, warnings: [...raw.warnings], truncated: raw.truncated }) : null;
  const plain = tableFromXlsxRows(raw.rows, headerIndex, { groupIndex: null, sheetName: raw.sheetName, warnings: [...raw.warnings], truncated: raw.truncated });
  const chosen = withGroups && matchColumns(withGroups.header, synonyms).index.size > matchColumns(plain.header, synonyms).index.size ? withGroups : plain;
  if (headerIndex > 0) chosen.warnings.push(`La cabecera de la hoja «${raw.sheetName}» está en la fila ${raw.rows[headerIndex]!.row}: las filas anteriores se ignoran.`);
  if (chosen.rows.length === 0) throw new LedgerImportParseError("LEDGER_IMPORT_EMPTY", "La hoja no tiene filas de datos tras la cabecera.", { sheetName: raw.sheetName });
  return chosen;
}

// ---------------------------------------------------------------------------
// Parsers Sage por tipo
// ---------------------------------------------------------------------------

export type SageParseOptions = {
  format?: LedgerImportFormat;
  companyCode?: string;
  fiscalYearCode?: string;
};

function dropKnownUnused(result: TableParseResult<unknown>, known: readonly string[] | RegExp): void {
  const keep: string[] = [];
  for (const header of result.unknownHeaders) {
    const compact = compactHeader(header);
    const folded = foldHeader(header);
    const isKnown = known instanceof RegExp ? known.test(folded) : known.includes(compact);
    if (isKnown) {
      const index = result.warnings.findIndex((warning) => warning === `Columna «${header}» no reconocida: se ignora.`);
      if (index >= 0) result.warnings.splice(index, 1);
    } else keep.push(header);
  }
  result.unknownHeaders = keep;
}

/** Diario Sage (Excel del Diario / Consulta de asientos, CSV IME de 60 columnas o canónico) → filas canónicas. */
export function parseSageJournal(table: ParsedTable, options: SageParseOptions = {}): TableParseResult<CanonicalJournalRow> {
  const result = parseJournalTable(table, { synonyms: JOURNAL_SYNONYMS, companyCode: options.companyCode, fiscalYearCode: options.fiscalYearCode });
  if (options.format === "sage_ime_csv" || headerHasAll(table.header, SAGE_IME_SIGNATURE_HEADERS)) dropKnownUnused(result, IME_KNOWN_UNUSED);
  return result;
}

/** Sumas y saldos nivel 0 (Excel de Sage o canónico de saldos) → filas canónicas. */
export function parseSageBalances(table: ParsedTable, options: SageParseOptions & Pick<BalancesTableOptions, "periodCode" | "propertyCode"> = {}): TableParseResult<CanonicalBalanceRow> {
  return parseBalancesTable(table, { synonyms: BALANCES_SYNONYMS, companyCode: options.companyCode, fiscalYearCode: options.fiscalYearCode, periodCode: options.periodCode, propertyCode: options.propertyCode });
}

/** Plan de cuentas (Gestor de Exportación o canónico) → filas canónicas. */
export function parseSagePlan(table: ParsedTable): TableParseResult<CanonicalPlanRow> {
  return parsePlanTable(table, { synonyms: PLAN_SYNONYMS });
}

/** Clientes / proveedores (Gestor de Exportación o canónico) → filas canónicas. */
export function parseSageThirdParties(table: ParsedTable, options: { defaultRole?: "customer" | "supplier" } = {}): TableParseResult<CanonicalThirdPartyRow> {
  return parseThirdPartiesTable(table, { synonyms: THIRD_PARTIES_SYNONYMS, defaultRole: options.defaultRole });
}

/** Hojas del libro AEAT por libro, en orden de preferencia. */
export const AEAT_VAT_SHEETS: Readonly<Record<"emitidas" | "recibidas", readonly string[]>> = Object.freeze({
  emitidas: ["EXPEDIDAS_INGRESOS", "EXPEDIDAS", "EMITIDAS", "FACTURAS EXPEDIDAS", "FACTURAS EMITIDAS"],
  recibidas: ["RECIBIDAS_GASTOS", "RECIBIDAS", "FACTURAS RECIBIDAS", "SOPORTADAS"]
});

/** Campos que identifican la fila de cabecera del libro AEAT. */
const AEAT_ANCHORS: readonly string[] = Object.freeze(["fecha", "base", "total", "cuota"]);

export type SageVatBookOptions = SageParseOptions & {
  /** Hoja concreta (una sola); por defecto se leen las dos hojas AEAT. */
  sheetName?: string;
  /** Libro de la hoja pedida cuando su nombre no lo delata. */
  book?: "emitidas" | "recibidas";
};

function bookFromSheetName(name: string): "emitidas" | "recibidas" | null {
  const folded = foldHeader(name);
  if (/expedid|emitid|ingres/.test(folded)) return "emitidas";
  if (/recibid|gasto|soportad/.test(folded)) return "recibidas";
  return null;
}

function readAeatSheet(bytes: Uint8Array, sheetName: string, book: "emitidas" | "recibidas", options: SageParseOptions): TableParseResult<CanonicalVatRow> | null {
  let raw;
  try {
    raw = readXlsxTable(bytes, { sheetName, maxRows: LEDGER_TABLE_LIMITS.maxRows + 20, maxCols: LEDGER_TABLE_LIMITS.maxColumns, maxCellChars: LEDGER_TABLE_LIMITS.maxCellChars });
  } catch (error) {
    if (error instanceof XlsxLiteError && error.code === "XLSX_NO_SHEET") return null;
    if (error instanceof XlsxLiteError) throw new LedgerImportParseError("LEDGER_IMPORT_INVALID", error.message, { errors: [{ line: 0, message: error.message }], reason: error.code, sheetName });
    throw error;
  }
  if (raw.rows.length === 0) return null;
  const headerIndex = locateHeaderRow(raw.rows, VAT_SYNONYMS, { minMatches: 3, anchors: AEAT_ANCHORS });
  if (headerIndex < 0) {
    throw new LedgerImportParseError("LEDGER_IMPORT_INVALID", `No se ha localizado la cabecera del libro en la hoja «${raw.sheetName}» (se buscan «Fecha expedición», «Base imponible», «Total factura»…).`, { errors: [{ line: 0, message: "cabecera del libro no localizada" }], sheetName: raw.sheetName });
  }
  const previous = headerIndex > 0 && raw.rows[headerIndex - 1]!.row === raw.rows[headerIndex]!.row - 1 ? headerIndex - 1 : null;
  const plain = tableFromXlsxRows(raw.rows, headerIndex, { groupIndex: null, sheetName: raw.sheetName, warnings: [...raw.warnings], truncated: raw.truncated });
  const grouped = previous !== null ? tableFromXlsxRows(raw.rows, headerIndex, { groupIndex: previous, sheetName: raw.sheetName, warnings: [...raw.warnings], truncated: raw.truncated }) : null;
  // Con fila de grupos gana la variante que casa más campos (los genéricos «Serie» / «Número» / «NIF» la necesitan).
  const table = grouped && matchColumns(grouped.header, VAT_SYNONYMS).index.size >= matchColumns(plain.header, VAT_SYNONYMS).index.size ? grouped : plain;
  if (table.rows.length === 0) return { rows: [], warnings: [`La hoja «${raw.sheetName}» no tiene facturas.`], unknownHeaders: [] };
  const result = parseVatTable(table, { synonyms: VAT_SYNONYMS, book, companyCode: options.companyCode, fiscalYearCode: options.fiscalYearCode });
  dropKnownUnused(result, AEAT_KNOWN_UNUSED);
  result.warnings.unshift(`Hoja «${raw.sheetName}»: cabecera localizada en la fila ${raw.rows[headerIndex]!.row}.`);
  return result;
}

/**
 * Libro Registro de IVA «Formato Libros AEAT» (.xlsx): lee EXPEDIDAS_INGRESOS y
 * RECIBIDAS_GASTOS (o la hoja pedida) localizando la cabecera por contenido y devuelve
 * las filas canónicas de ambos libros. Un CSV plano con cabecera de libro se lee con
 * `parseSageVatTable`.
 */
export function parseSageVatBook(bytes: Uint8Array, options: SageVatBookOptions = {}): TableParseResult<CanonicalVatRow> {
  if (!hasZipSignature(bytes)) {
    throw new LedgerImportParseError("LEDGER_IMPORT_INVALID", "El libro de IVA formato AEAT debe ser un libro .xlsx; para CSV usa el formato canónico de libros.", { errors: [{ line: 0, message: "no es un .xlsx" }] });
  }
  const rows: CanonicalVatRow[] = [];
  const warnings: string[] = [];
  const unknown = new Set<string>();
  const sheetsRead: string[] = [];
  const merge = (result: TableParseResult<CanonicalVatRow> | null, sheet: string): void => {
    if (!result) return;
    sheetsRead.push(sheet);
    rows.push(...result.rows);
    warnings.push(...result.warnings);
    for (const header of result.unknownHeaders) unknown.add(header);
  };
  if (options.sheetName) {
    const book = options.book ?? bookFromSheetName(options.sheetName);
    if (!book) throw new LedgerImportParseError("LEDGER_IMPORT_INVALID", `No se sabe si la hoja «${options.sheetName}» es de expedidas o de recibidas: indica el libro.`, { errors: [{ line: 0, message: "libro de la hoja desconocido" }], sheetName: options.sheetName });
    const result = readAeatSheet(bytes, options.sheetName, book, options);
    if (!result) throw new LedgerImportParseError("LEDGER_IMPORT_INVALID", `La hoja «${options.sheetName}» no existe en el libro.`, { errors: [{ line: 0, message: "hoja inexistente" }], sheetName: options.sheetName });
    merge(result, options.sheetName);
  } else {
    for (const book of ["emitidas", "recibidas"] as const) {
      for (const sheet of AEAT_VAT_SHEETS[book]) {
        const result = readAeatSheet(bytes, sheet, book, options);
        if (result) {
          merge(result, sheet);
          break;
        }
      }
    }
    if (sheetsRead.length === 0) {
      throw new LedgerImportParseError("LEDGER_IMPORT_KIND_MISMATCH", "El libro no tiene las hojas EXPEDIDAS_INGRESOS / RECIBIDAS_GASTOS del formato AEAT.", { expected: [...AEAT_VAT_SHEETS.emitidas, ...AEAT_VAT_SHEETS.recibidas] });
    }
  }
  if (rows.length === 0) throw new LedgerImportParseError("LEDGER_IMPORT_EMPTY", "El libro de IVA no contiene facturas.", { sheets: sheetsRead });
  return { rows, warnings, unknownHeaders: [...unknown] };
}

/** Libro de IVA en tabla plana (CSV canónico de libros o Excel con una fila de cabecera y columna `libro`). */
export function parseSageVatTable(table: ParsedTable, options: SageParseOptions & { book?: "emitidas" | "recibidas" } = {}): TableParseResult<CanonicalVatRow> {
  return parseVatTable(table, { synonyms: VAT_SYNONYMS, book: options.book, companyCode: options.companyCode, fiscalYearCode: options.fiscalYearCode });
}

// ---------------------------------------------------------------------------
// Entrada única
// ---------------------------------------------------------------------------

export type LedgerImportFileInput = {
  kind: LedgerImportKind;
  format?: LedgerImportFormat;
  fileName?: string;
  /** Bytes del fichero (el llamador decodifica contentBase64). */
  bytes?: Uint8Array;
  /** Texto (CSV / JSON canónicos). */
  content?: string;
  sheetName?: string;
  companyCode?: string;
  fiscalYearCode?: string;
  /** balances: periodo del fichero si no trae columna. */
  periodCode?: string;
  /** balances: centro del fichero si no trae columna. */
  propertyCode?: string;
  /** third_parties: rol por defecto. */
  defaultRole?: "customer" | "supplier";
  /** vat_books: libro de la hoja pedida. */
  book?: "emitidas" | "recibidas";
};

export type LedgerImportParsedFile<K extends LedgerImportKind = LedgerImportKind> = TableParseResult<CanonicalRowOf<K>> & {
  kind: K;
  format: LedgerImportFormat;
  rowCount: number;
  sheetName: string | null;
  company: string | null;
};

function contentBytes(input: LedgerImportFileInput): Uint8Array | undefined {
  if (input.bytes) return input.bytes;
  if (typeof input.content === "string" && input.content.length > 0) return new TextEncoder().encode(input.content);
  return undefined;
}

/**
 * Punto de entrada de las rutas y del CLI: detecta el formato (si no viene), lee la tabla o
 * el JSON y devuelve las filas canónicas del tipo con avisos y cabeceras desconocidas.
 * Errores de fichero → LedgerImportParseError.
 */
export function parseLedgerImportFile<K extends LedgerImportKind>(input: LedgerImportFileInput & { kind: K }): LedgerImportParsedFile<K> {
  const hasBytes = !!input.bytes && input.bytes.length > 0;
  const hasContent = typeof input.content === "string" && input.content.length > 0;
  if (!hasBytes && !hasContent) throw new LedgerImportParseError("LEDGER_IMPORT_EMPTY", "No se ha recibido ningún fichero.");
  const format = input.format ?? detectLedgerImportFormat({ fileName: input.fileName, bytes: input.bytes, content: input.content, kind: input.kind });
  const kind = input.kind;
  const options: SageParseOptions = { format, companyCode: input.companyCode, fiscalYearCode: input.fiscalYearCode };

  if (format === "sage_xml") {
    const bytes = contentBytes(input);
    if (!bytes) throw new LedgerImportParseError("LEDGER_IMPORT_EMPTY", "No se ha recibido ningún fichero.");
    return parseSageXml(bytes);
  }
  if (format === "canonical_json") {
    const result = parseCanonicalJson(kind, input.bytes ?? input.content ?? "", { companyCode: input.companyCode, fiscalYearCode: input.fiscalYearCode, periodCode: input.periodCode, propertyCode: input.propertyCode });
    return { ...result, kind, format, rowCount: result.rows.length, sheetName: null, company: result.company };
  }

  const name = (input.fileName ?? "").trim().toLowerCase();
  const isXlsx = /\.(xlsx|xlsm)$/.test(name) || (hasBytes && hasZipSignature(input.bytes!) && !/\.(csv|txt|tsv)$/.test(name));
  if (kind === "vat_books" && isXlsx && hasBytes) {
    const result = parseSageVatBook(input.bytes!, { ...options, sheetName: input.sheetName, book: input.book });
    return { ...(result as TableParseResult<CanonicalRowOf<K>>), kind, format, rowCount: result.rows.length, sheetName: input.sheetName ?? null, company: input.companyCode ?? null };
  }

  const table = readSageTable({ bytes: input.bytes, content: input.content, fileName: input.fileName, sheetName: input.sheetName, reader: isXlsx ? "xlsx" : "csv" }, kind);
  let result: TableParseResult<CanonicalRowOf<K>>;
  switch (kind) {
    case "journal":
    case "fiscal_years":
      result = parseSageJournal(table, options) as TableParseResult<CanonicalRowOf<K>>;
      break;
    case "balances":
      result = parseSageBalances(table, { ...options, periodCode: input.periodCode, propertyCode: input.propertyCode }) as TableParseResult<CanonicalRowOf<K>>;
      break;
    case "plan":
      result = parseSagePlan(table) as TableParseResult<CanonicalRowOf<K>>;
      break;
    case "third_parties":
      result = parseSageThirdParties(table, { defaultRole: input.defaultRole }) as TableParseResult<CanonicalRowOf<K>>;
      break;
    default:
      result = parseSageVatTable(table, { ...options, book: input.book }) as TableParseResult<CanonicalRowOf<K>>;
      break;
  }
  return { ...result, kind, format, rowCount: result.rows.length, sheetName: table.sheetName ?? null, company: input.companyCode ?? (result.rows[0] as { empresa?: string } | undefined)?.empresa ?? null };
}

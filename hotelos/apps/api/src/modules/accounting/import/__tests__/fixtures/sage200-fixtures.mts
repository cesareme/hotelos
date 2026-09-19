// Fixtures sintéticos de la Tanda 7c · L1 (importación desde Sage 200).
//
// Empresa Sage ficticia «Hoteles del Cantábrico Norte SA» (CodigoEmpresa 1, ejercicio
// 2026, delegaciones RA / LT / MC / OC, departamentos HAB / REST / MANT / ADM / COM),
// coherente con la estructura de la sociedad piloto pero SIN ningún NIF real: los NIF
// son CIF sintéticos con dígito de control válido (`syntheticCif`). Los libros .xlsx
// se montan en memoria con el escritor propio del repo (`writeXlsx`); el CSV IME de
// 60 columnas vive también en `diario-ime-2026-09.csv` (mismo contenido).

import { writeXlsx, writeZip, type XlsxCell } from "../../../../financial-statements/xlsx-writer.js";
import { SAGE_IME_COLUMNS } from "../../sage200.parser.js";

/** CIF sintético «A» + 7 dígitos + control válido (misma regla que los tests de integración). */
export function syntheticCif(seed: number): string {
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

export const NIF_SUMINISTROS = syntheticCif(1234567); // A12345674
export const NIF_VIAJES = syntheticCif(2345678); // A23456783
export const NIF_LAVANDERIA = syntheticCif(3456789); // A34567891
export const NIF_EMPRESA = syntheticCif(4567890); // A45678901

export const COMPANY_NAME = "Hoteles del Cantábrico Norte SA";

export const PROPERTIES = [
  { id: "prop_ra", code: "RA", name: "Hotel Rías Altas", tradeName: "Rías Altas" },
  { id: "prop_lt", code: "LT", name: "Hotel Los Tilos", tradeName: "Los Tilos" },
  { id: "prop_mc", code: "MC", name: "Hotel Marsol Candás", tradeName: "Marsol" },
  { id: "prop_oc", code: "OC", name: "Oficina central", tradeName: null }
] as const;

/** Un apunte del diario sintético (importes como texto con punto decimal). */
export type JournalLineFixture = {
  asiento: string;
  fecha: string; // dd/mm/yyyy
  periodo: string;
  cuenta: string;
  concepto: string;
  debe: string;
  haber: string;
  documento?: string;
  delegacion?: string;
  departamento?: string;
  serie?: string;
  factura?: string;
  fechaFactura?: string;
  nif?: string;
  nombre?: string;
  baseIva?: string;
  porIva?: string;
  cuotaIva?: string;
  tipoFactura?: string;
  diario?: string;
};

/** Diario de septiembre de 2026 (empresa 1): 6 asientos con los casos del diseño §9. */
export const JOURNAL_2026_09: readonly JournalLineFixture[] = [
  // 1501 · factura recibida de suministros en RA (mantenimiento)
  { asiento: "1501", fecha: "03/09/2026", periodo: "9", cuenta: "6280001", concepto: "Electricidad septiembre", debe: "250.00", haber: "", documento: "F-778", delegacion: "RA", departamento: "MANT" },
  { asiento: "1501", fecha: "03/09/2026", periodo: "9", cuenta: "4720021", concepto: "IVA soportado 21 %", debe: "52.50", haber: "", documento: "F-778", delegacion: "RA", baseIva: "250.00", porIva: "21", cuotaIva: "52.50", tipoFactura: "R" },
  { asiento: "1501", fecha: "03/09/2026", periodo: "9", cuenta: "4000000042", concepto: "Suministros Eléctricos del Noroeste SL", debe: "", haber: "302.50", documento: "F-778", delegacion: "RA", serie: "F", factura: "778", fechaFactura: "03/09/2026", nif: NIF_SUMINISTROS, nombre: "SUMINISTROS ELECTRICOS DEL NOROESTE SL", tipoFactura: "R" },
  // 1502 · factura emitida por Anfitorio en RA (nativa: se excluye por serie + número)
  { asiento: "1502", fecha: "04/09/2026", periodo: "9", cuenta: "4300000123", concepto: "Viajes Cantábrico SL", debe: "1100.00", haber: "", documento: "FAC-2026-000015", delegacion: "RA", serie: "FAC-2026", factura: "000015", fechaFactura: "04/09/2026", nif: NIF_VIAJES, nombre: "VIAJES CANTABRICO SL", tipoFactura: "E" },
  { asiento: "1502", fecha: "04/09/2026", periodo: "9", cuenta: "7050001", concepto: "Alojamiento grupo", debe: "", haber: "1000.00", documento: "FAC-2026-000015", delegacion: "RA", departamento: "HAB" },
  { asiento: "1502", fecha: "04/09/2026", periodo: "9", cuenta: "4770010", concepto: "IVA repercutido 10 %", debe: "", haber: "100.00", documento: "FAC-2026-000015", delegacion: "RA", baseIva: "1000.00", porIva: "10", cuotaIva: "100.00", tipoFactura: "E" },
  // 1503 · gasto en dos hoteles (reparto)
  { asiento: "1503", fecha: "05/09/2026", periodo: "9", cuenta: "6290001", concepto: "Lavandería agosto RA", debe: "300.00", haber: "", documento: "L-2026-91", delegacion: "RA", departamento: "ADM" },
  { asiento: "1503", fecha: "05/09/2026", periodo: "9", cuenta: "6290001", concepto: "Lavandería agosto LT", debe: "100.00", haber: "", documento: "L-2026-91", delegacion: "LT", departamento: "ADM" },
  { asiento: "1503", fecha: "05/09/2026", periodo: "9", cuenta: "4720021", concepto: "IVA soportado 21 %", debe: "84.00", haber: "", documento: "L-2026-91", baseIva: "400.00", porIva: "21", cuotaIva: "84.00", tipoFactura: "R" },
  { asiento: "1503", fecha: "05/09/2026", periodo: "9", cuenta: "4100000007", concepto: "Lavandería Industrial del Cantábrico SL", debe: "", haber: "484.00", documento: "L-2026-91", serie: "L", factura: "91", nif: NIF_LAVANDERIA, nombre: "LAVANDERIA INDUSTRIAL DEL CANTABRICO SL", tipoFactura: "R" },
  // 1504 · gasto sin delegación (política de apuntes sin analítica)
  { asiento: "1504", fecha: "06/09/2026", periodo: "9", cuenta: "6210000", concepto: "Alquiler oficina", debe: "500.00", haber: "" },
  { asiento: "1504", fecha: "06/09/2026", periodo: "9", cuenta: "5720000", concepto: "Alquiler oficina", debe: "", haber: "500.00" },
  // 1505 · cobro de la factura nativa (se excluye por el número en el documento)
  { asiento: "1505", fecha: "10/09/2026", periodo: "9", cuenta: "5720000", concepto: "Cobro transferencia", debe: "1100.00", haber: "", documento: "FAC-2026-000015", delegacion: "RA" },
  { asiento: "1505", fecha: "10/09/2026", periodo: "9", cuenta: "4300000123", concepto: "Cobro transferencia", debe: "", haber: "1100.00", documento: "FAC-2026-000015", delegacion: "RA" },
  // 1506 · nómina de LT
  { asiento: "1506", fecha: "12/09/2026", periodo: "9", cuenta: "6400000", concepto: "Nómina septiembre LT", debe: "2000.00", haber: "", delegacion: "LT", departamento: "ADM" },
  { asiento: "1506", fecha: "12/09/2026", periodo: "9", cuenta: "4650000", concepto: "Nómina septiembre LT", debe: "", haber: "2000.00", delegacion: "LT" }
];

/** Apertura (periodo 0, asiento 1) y un asiento nº 1 del periodo 1: misma numeración, claves distintas. */
export const JOURNAL_OPENING_AND_JANUARY: readonly JournalLineFixture[] = [
  { asiento: "1", fecha: "01/01/2026", periodo: "Apertura", cuenta: "5720000", concepto: "Apertura 2026", debe: "15000.00", haber: "" },
  { asiento: "1", fecha: "01/01/2026", periodo: "Apertura", cuenta: "1000000", concepto: "Apertura 2026", debe: "", haber: "15000.00" },
  { asiento: "1", fecha: "02/01/2026", periodo: "1", cuenta: "5700000", concepto: "Traspaso a caja", debe: "100.00", haber: "" },
  { asiento: "1", fecha: "02/01/2026", periodo: "1", cuenta: "5720000", concepto: "Traspaso a caja", debe: "", haber: "100.00" }
];

/** Cierre de Sage: «Cierre ejercicio» (6/7 contra 129) y «Cierre Contabilidad» (1-5). */
export const JOURNAL_YEAR_END: readonly JournalLineFixture[] = [
  { asiento: "9001", fecha: "31/12/2026", periodo: "Cierre ejercicio", cuenta: "7050001", concepto: "Regularización 2026", debe: "1000.00", haber: "" },
  { asiento: "9001", fecha: "31/12/2026", periodo: "Cierre ejercicio", cuenta: "6280001", concepto: "Regularización 2026", debe: "", haber: "250.00" },
  { asiento: "9001", fecha: "31/12/2026", periodo: "Cierre ejercicio", cuenta: "6290001", concepto: "Regularización 2026", debe: "", haber: "400.00" },
  { asiento: "9001", fecha: "31/12/2026", periodo: "Cierre ejercicio", cuenta: "6210000", concepto: "Regularización 2026", debe: "", haber: "500.00" },
  { asiento: "9001", fecha: "31/12/2026", periodo: "Cierre ejercicio", cuenta: "6400000", concepto: "Regularización 2026", debe: "", haber: "2000.00" },
  { asiento: "9001", fecha: "31/12/2026", periodo: "Cierre ejercicio", cuenta: "1290000", concepto: "Regularización 2026", debe: "2150.00", haber: "" },
  { asiento: "9002", fecha: "31/12/2026", periodo: "Cierre Contabilidad", cuenta: "1000000", concepto: "Cierre 2026", debe: "15000.00", haber: "" },
  { asiento: "9002", fecha: "31/12/2026", periodo: "Cierre Contabilidad", cuenta: "5720000", concepto: "Cierre 2026", debe: "", haber: "12850.00" },
  { asiento: "9002", fecha: "31/12/2026", periodo: "Cierre Contabilidad", cuenta: "1290000", concepto: "Cierre 2026", debe: "", haber: "2150.00" }
];

// ---------------------------------------------------------------------------
// Excel del Diario (dos variantes de cabecera) y canónico
// ---------------------------------------------------------------------------

const JOURNAL_HEADERS_DEBE_HABER = ["Empresa", "Ejercicio", "Asiento", "Fecha asiento", "Periodo", "Código cuenta", "Concepto", "Debe", "Haber", "Documento", "Delegación", "Departamento", "Serie", "Factura", "Fecha factura", "CIF/DNI", "Nombre", "Base IVA", "% IVA", "Cuota IVA", "Tipo factura", "Diario"];
const JOURNAL_HEADERS_CARGO_ABONO = ["Empresa", "Ejercicio", "Asiento", "FechaAsiento", "NumeroPeriodo", "CodigoCuenta", "Comentario", "Cargo/Abono", "Importe", "DocumentoConta", "IdDelegacion", "CodigoDepartamento", "Serie", "Factura", "FechaFactura", "CifDni", "Nombre", "BaseIva1", "PorIva1", "CuotaIva1", "TipoFactura", "CodigoDiario"];

function num(value: string | undefined): XlsxCell {
  return value === undefined || value === "" ? "" : Number(value);
}

function journalRowDebeHaber(line: JournalLineFixture): XlsxCell[] {
  return ["1", "2026", line.asiento, line.fecha, line.periodo, line.cuenta, line.concepto, num(line.debe), num(line.haber), line.documento ?? "", line.delegacion ?? "", line.departamento ?? "", line.serie ?? "", line.factura ?? "", line.fechaFactura ?? "", line.nif ?? "", line.nombre ?? "", num(line.baseIva), num(line.porIva), num(line.cuotaIva), line.tipoFactura ?? "", line.diario ?? "0"];
}

function journalRowCargoAbono(line: JournalLineFixture): XlsxCell[] {
  const debit = line.debe !== "";
  return ["1", "2026", line.asiento, line.fecha, line.periodo, line.cuenta, line.concepto, debit ? "D" : "H", num(debit ? line.debe : line.haber), line.documento ?? "", line.delegacion ?? "", line.departamento ?? "", line.serie ?? "", line.factura ?? "", line.fechaFactura ?? "", line.nif ?? "", line.nombre ?? "", num(line.baseIva), num(line.porIva), num(line.cuotaIva), line.tipoFactura ?? "", line.diario ?? "0"];
}

/** Diario «Enviar a Excel» con Debe / Haber. `titleRows` añade filas de título encima de la cabecera (listado con encabezado). */
export function journalXlsxDebeHaber(lines: readonly JournalLineFixture[] = JOURNAL_2026_09, options: { titleRows?: number } = {}): Buffer {
  const rows: XlsxCell[][] = [];
  for (let i = 0; i < (options.titleRows ?? 0); i += 1) rows.push(i === 0 ? [COMPANY_NAME, "", "Diario de movimientos"] : [`Fila de título ${i + 1}`]);
  rows.push([...JOURNAL_HEADERS_DEBE_HABER], ...lines.map(journalRowDebeHaber));
  return writeXlsx([{ name: "Diario", rows }], new Date(Date.UTC(2026, 8, 17)));
}

/** El mismo diario con Cargo/Abono (D/H) + Importe y cabeceras «a la Sage». */
export function journalXlsxCargoAbono(lines: readonly JournalLineFixture[] = JOURNAL_2026_09): Buffer {
  return writeXlsx([{ name: "Diario", rows: [[...JOURNAL_HEADERS_CARGO_ABONO], ...lines.map(journalRowCargoAbono)] }], new Date(Date.UTC(2026, 8, 17)));
}

function iso(dmy: string): string {
  const [d, m, y] = dmy.split("/");
  return `${y}-${m}-${d}`;
}

function es(value: string | undefined): string {
  return value === undefined || value === "" ? "" : value.replace(".", ",");
}

/** CSV canónico de diario (`;`, decimales con coma) equivalente al Excel. */
export function journalCanonicalCsv(lines: readonly JournalLineFixture[] = JOURNAL_2026_09): string {
  const header = "empresa;ejercicio;asiento;fecha;periodo;cuenta;debe;haber;concepto;documento;canal;delegacion;departamento;seccion;proyecto;serie;factura;fecha_factura;nif;nombre;base_iva;tipo_iva;cuota_iva;tipo_factura";
  const body = lines.map((line) =>
    ["1", "2026", line.asiento, iso(line.fecha), line.periodo, line.cuenta, es(line.debe), es(line.haber), line.concepto, line.documento ?? "", "", line.delegacion ?? "", line.departamento ?? "", "", "", line.serie ?? "", line.factura ?? "", line.fechaFactura ? iso(line.fechaFactura) : "", line.nif ?? "", line.nombre ?? "", es(line.baseIva), line.porIva ?? "", es(line.cuotaIva), line.tipoFactura ?? ""].join(";")
  );
  return `\uFEFF${[header, ...body].join("\r\n")}\r\n`;
}

/** CSV IME de 60 columnas (§2.1 D): CargoAbono D/H + ImporteAsiento, decimales con coma. */
export function journalImeCsv(lines: readonly JournalLineFixture[] = JOURNAL_2026_09): string {
  const body = lines.map((line) => {
    const debit = line.debe !== "";
    const record: Record<string, string> = {
      CodigoEmpresa: "1",
      Ejercicio: "2026",
      Asiento: line.asiento,
      CargoAbono: debit ? "D" : "H",
      CodigoCuenta: line.cuenta,
      Contrapartida: "",
      FechaAsiento: line.fecha,
      DocumentoConta: line.documento ?? "",
      Comentario: line.concepto,
      ImporteAsiento: es(debit ? line.debe : line.haber),
      CodigoDiario: line.diario ?? "0",
      CodigoCanal: "",
      CodigoDepartamento: line.departamento ?? "",
      CodigoSeccion: "",
      CodigoProyecto: "",
      IdDelegacion: line.delegacion ?? "",
      FechaVencimiento: "",
      NumeroPeriodo: line.periodo === "Apertura" ? "0" : line.periodo === "Cierre ejercicio" ? "14" : line.periodo === "Cierre Contabilidad" ? "15" : line.periodo,
      TipoCarteraIME: "",
      TipoAnaliticaIME: "",
      TipoImportacionIME: "",
      BaseIva1: es(line.baseIva),
      CodigoIva1: line.porIva ? `IVA${line.porIva}` : "",
      PorIva1: line.porIva ?? "",
      CuotaIva1: es(line.cuotaIva),
      Serie: line.serie ?? "",
      Factura: line.factura ?? "",
      SuFacturaNo: "",
      FechaFactura: line.fechaFactura ?? "",
      ImporteFactura: "",
      TipoFactura: line.tipoFactura ?? "",
      CifDni: line.nif ?? "",
      Nombre: line.nombre ?? "",
      SiglaNacion: line.nif ? "ES" : "",
      EjercicioFactura: line.fechaFactura ? "2026" : ""
    };
    return SAGE_IME_COLUMNS.map((column) => record[column] ?? "").join(";");
  });
  return `${SAGE_IME_COLUMNS.join(";")}\r\n${body.join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// Libro Registro de IVA formato AEAT (cabecera en las filas 7-8)
// ---------------------------------------------------------------------------

const AEAT_EXPEDIDAS_GROUPS: XlsxCell[] = ["Autoliquidación", "", "Actividad", "", "", "", "", "", "", "", "Identificación de la Factura", "", "", "", "Factura Rectificada", "", "", "Destinatario", "", "", "", "", "", "", "", "", "", "", "Cobro (Operación Criterio de Caja)", "", "", "", "", "", "", ""];
const AEAT_EXPEDIDAS_FIELDS: XlsxCell[] = ["Ejercicio", "Periodo", "Código", "Tipo", "Grupo o Epígrafe del IAE", "Tipo de Factura", "Concepto de Ingreso", "Ingreso Computable", "Fecha Expedición", "Fecha Operación", "Serie", "Número", "Número-Final", "Tipo Rectificativa", "Serie", "Número", "Número-Final", "NIF", "Nombre", "Código País", "Clave de Operación", "Calificación de la Operación", "Operación Exenta", "Total Factura", "Base Imponible", "Tipo de IVA", "Cuota IVA Repercutida", "Tipo de Recargo eq.", "Cuota Recargo eq.", "Fecha", "Importe", "Medio Utilizado", "Identificación Medio Utilizado", "Tipo de retención", "Importe de la retención", "Registro Acuerdo Facturación", "Referencia Externa"];

const AEAT_RECIBIDAS_GROUPS: XlsxCell[] = ["Autoliquidación", "", "Actividad", "", "", "", "", "", "", "", "", "Identificación de la Factura del Expedidor", "", "", "", "Expedidor", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "Pago (Operación Criterio de Caja)", "", "", "", "", "", ""];
// «Inversión del Sujeto Pasivo» (S/N) tras «Bien de Inversión», como en el libro real de recibidas (FIX-1, corrector).
const AEAT_RECIBIDAS_FIELDS: XlsxCell[] = ["Ejercicio", "Periodo", "Código", "Tipo", "Grupo o Epígrafe del IAE", "Tipo de Factura", "Concepto de Gasto", "Gasto Deducible", "Fecha Expedición", "Fecha Operación", "Fecha Recepción", "Serie", "Número", "Número-Final", "Número Recepción", "NIF", "Nombre", "Código País", "Clave de Operación", "Calificación de la Operación", "Operación Exenta", "Total Factura", "Base Imponible", "Tipo de IVA", "Cuota IVA Soportada", "Cuota Deducible", "Tipo de Recargo eq.", "Cuota Recargo eq.", "Bien de Inversión", "Inversión del Sujeto Pasivo", "Fecha", "Importe", "Medio Utilizado", "Identificación Medio Utilizado", "Tipo de retención", "Importe de la retención", "Referencia Externa"];

export type VatFixtureRow = { fecha: string; serie: string; numero: string; nif: string; nombre: string; base: number; tipo: number; cuota: number; total: number; tipoFactura?: string; retencion?: number; rectificativa?: boolean; /** Recibidas: «Inversión del Sujeto Pasivo» = S (por defecto N). */ isp?: boolean };

export const VAT_EXPEDIDAS_2026_Q3: readonly VatFixtureRow[] = [
  { fecha: "03/07/2026", serie: "FAC-2026", numero: "000010", nif: NIF_VIAJES, nombre: "VIAJES CANTABRICO SL", base: 1000, tipo: 10, cuota: 100, total: 1100, tipoFactura: "F1" },
  { fecha: "15/08/2026", serie: "FAC-2026", numero: "000011", nif: NIF_LAVANDERIA, nombre: "LAVANDERIA INDUSTRIAL DEL CANTABRICO SL", base: 200, tipo: 21, cuota: 42, total: 242, tipoFactura: "F1" },
  { fecha: "20/09/2026", serie: "REC-2026", numero: "000003", nif: NIF_VIAJES, nombre: "VIAJES CANTABRICO SL", base: -100, tipo: 10, cuota: -10, total: -110, tipoFactura: "R1", rectificativa: true }
];

export const VAT_RECIBIDAS_2026_Q3: readonly VatFixtureRow[] = [
  { fecha: "03/09/2026", serie: "F", numero: "778", nif: NIF_SUMINISTROS, nombre: "SUMINISTROS ELECTRICOS DEL NOROESTE SL", base: 250, tipo: 21, cuota: 52.5, total: 302.5, tipoFactura: "F1" },
  { fecha: "05/09/2026", serie: "L", numero: "91", nif: NIF_LAVANDERIA, nombre: "LAVANDERIA INDUSTRIAL DEL CANTABRICO SL", base: 400, tipo: 21, cuota: 84, total: 484, tipoFactura: "F1" }
];

function aeatTitleRows(book: string): XlsxCell[][] {
  return [
    [`LIBRO REGISTRO DE FACTURAS ${book}`],
    [COMPANY_NAME, NIF_EMPRESA],
    ["Ejercicio 2026 · Periodo 3T"],
    ["Exportado desde Sage 200 (formato libros AEAT)"],
    [],
    []
  ];
}

/** Libro Registro de IVA «Formato Libros AEAT»: hojas EXPEDIDAS_INGRESOS y RECIBIDAS_GASTOS con títulos en 1-6, grupos en 7 y campos en 8. */
export function aeatVatBookXlsx(options: { expedidas?: readonly VatFixtureRow[]; recibidas?: readonly VatFixtureRow[] } = {}): Buffer {
  const expedidas = options.expedidas ?? VAT_EXPEDIDAS_2026_Q3;
  const recibidas = options.recibidas ?? VAT_RECIBIDAS_2026_Q3;
  const expedidasRows: XlsxCell[][] = expedidas.map((row) => ["2026", "3T", "01", "A", "681", row.tipoFactura ?? "F1", "I01", "S", row.fecha, "", row.serie, row.numero, "", row.rectificativa ? "S" : "", row.rectificativa ? "FAC-2026" : "", row.rectificativa ? "000010" : "", "", row.nif, row.nombre, "ES", "01", "S1", "", row.total, row.base, row.tipo, row.cuota, "", "", "", "", "", "", "", row.retencion ?? "", "", ""]);
  const recibidasRows: XlsxCell[][] = recibidas.map((row) => ["2026", "3T", "01", "A", "681", row.tipoFactura ?? "F1", "G01", "S", row.fecha, "", row.fecha, row.serie, row.numero, "", "", row.nif, row.nombre, "ES", "01", "S1", "", row.total, row.base, row.tipo, row.cuota, row.cuota, "", "", "N", row.isp ? "S" : "N", "", "", "", "", "", row.retencion ?? "", ""]);
  return writeXlsx(
    [
      { name: "EXPEDIDAS_INGRESOS", rows: [...aeatTitleRows("EXPEDIDAS"), AEAT_EXPEDIDAS_GROUPS, AEAT_EXPEDIDAS_FIELDS, ...expedidasRows] },
      { name: "RECIBIDAS_GASTOS", rows: [...aeatTitleRows("RECIBIDAS"), AEAT_RECIBIDAS_GROUPS, AEAT_RECIBIDAS_FIELDS, ...recibidasRows] }
    ],
    new Date(Date.UTC(2026, 8, 17))
  );
}

// ---------------------------------------------------------------------------
// Sumas y saldos, plan y terceros
// ---------------------------------------------------------------------------

export type BalanceFixtureRow = { cuenta: string; titulo: string; delegacion?: string; aperturaDebe?: number; aperturaHaber?: number; debe: number; haber: number; deudor?: number; acreedor?: number };

/** Sumas y saldos anual 2025 (nivel 0, Debe/Haber/Deudor/Acreedor, comparativo acumulado) que cuadra. */
export const BALANCES_2025: readonly BalanceFixtureRow[] = [
  { cuenta: "1000000", titulo: "Capital social", aperturaHaber: 9000, debe: 0, haber: 0, acreedor: 9000 },
  { cuenta: "1290000", titulo: "Resultado del ejercicio", debe: 0, haber: 0 },
  { cuenta: "4000000", titulo: "Proveedores", aperturaHaber: 3000, debe: 3000, haber: 4000, acreedor: 4000 },
  { cuenta: "4300000", titulo: "Clientes", aperturaDebe: 2000, debe: 9000, haber: 8000, deudor: 3000 },
  { cuenta: "5720000", titulo: "Bancos c/c", aperturaDebe: 10000, debe: 8000, haber: 3000, deudor: 15000 },
  { cuenta: "6280001", titulo: "Electricidad", delegacion: "RA", debe: 4000, haber: 0, deudor: 4000 },
  { cuenta: "7050001", titulo: "Alojamiento", delegacion: "RA", debe: 0, haber: 9000, acreedor: 9000 }
];

/** Apertura 2026 = cierre 2025 (con `break` se altera 572 en un céntimo). */
export function openingRows2026(options: { break?: boolean } = {}): BalanceFixtureRow[] {
  return [
    { cuenta: "1000000", titulo: "Capital social", debe: 0, haber: 0, acreedor: 9000 },
    { cuenta: "1290000", titulo: "Resultado del ejercicio", debe: 0, haber: 0, acreedor: 5000 },
    { cuenta: "4000000", titulo: "Proveedores", debe: 0, haber: 0, acreedor: 4000 },
    { cuenta: "4300000", titulo: "Clientes", debe: 0, haber: 0, deudor: 3000 },
    { cuenta: "5720000", titulo: "Bancos c/c", debe: 0, haber: 0, deudor: options.break ? 15000.01 : 15000 }
  ];
}

/** Sumas y saldos «a la Sage» en Excel: Cuenta · Título · Delegación · Apertura Debe · Apertura Haber · Debe · Haber · Deudor · Acreedor (+ Periodo · Ejercicio opcionales). */
export function balancesXlsx(rows: readonly BalanceFixtureRow[] = BALANCES_2025, options: { periodo?: string; ejercicio?: string } = {}): Buffer {
  const header: XlsxCell[] = ["Cuenta", "Título", "Delegación", "Sumas anteriores Debe", "Sumas anteriores Haber", "Debe", "Haber", "Saldo Deudor", "Saldo Acreedor"];
  if (options.periodo) header.push("Periodo");
  if (options.ejercicio) header.push("Ejercicio");
  const body = rows.map((row) => {
    const cells: XlsxCell[] = [row.cuenta, row.titulo, row.delegacion ?? "", row.aperturaDebe ?? 0, row.aperturaHaber ?? 0, row.debe, row.haber, row.deudor ?? "", row.acreedor ?? ""];
    if (options.periodo) cells.push(options.periodo);
    if (options.ejercicio) cells.push(options.ejercicio);
    return cells;
  });
  return writeXlsx([{ name: "Sumas y saldos", rows: [header, ...body, ["TOTALES", "", "", "", "", rows.reduce((s, r) => s + r.debe, 0), rows.reduce((s, r) => s + r.haber, 0), "", ""]] }], new Date(Date.UTC(2026, 8, 17)));
}

/** CSV canónico de saldos (`;`, decimales con coma). */
export function balancesCanonicalCsv(rows: readonly BalanceFixtureRow[], ejercicio: string, periodo: string): string {
  const header = "empresa;ejercicio;periodo;cuenta;titulo;delegacion;apertura_debe;apertura_haber;debe;haber;saldo_deudor;saldo_acreedor";
  const fmt = (value: number | undefined): string => (value === undefined ? "0,00" : value.toFixed(2).replace(".", ","));
  const body = rows.map((row) => ["1", ejercicio, periodo, row.cuenta, row.titulo, row.delegacion ?? "", fmt(row.aperturaDebe), fmt(row.aperturaHaber), fmt(row.debe), fmt(row.haber), fmt(row.deudor), fmt(row.acreedor)].join(";"));
  return `${[header, ...body].join("\n")}\n`;
}

/** Plan de cuentas (Gestor de Exportación). */
export function planXlsx(): Buffer {
  return writeXlsx(
    [
      {
        name: "Plan de cuentas",
        rows: [
          ["Código cuenta", "Descripción", "CIF/DNI", "Sigla nación", "Longitud"],
          ["1000000", "Capital social", "", "", 7],
          ["4000000042", "Suministros Eléctricos del Noroeste SL", NIF_SUMINISTROS, "ES", 10],
          ["4300000123", "Viajes Cantábrico SL", NIF_VIAJES, "ES", 10],
          ["4720021", "IVA soportado 21 %", "", "", 7],
          ["6280001", "Electricidad", "", "", 7],
          ["6230002", "Asesoría laboral", "", "", 7],
          ["7050001", "Alojamiento", "", "", 7]
        ]
      }
    ],
    new Date(Date.UTC(2026, 8, 17))
  );
}

/** Clientes y proveedores (dos hojas con cabeceras distintas). */
export function thirdPartiesXlsx(): Buffer {
  return writeXlsx(
    [
      {
        name: "Proveedores",
        rows: [
          ["CodigoProveedor", "CodigoContable", "CifDni", "SiglaNacion", "RazonSocial"],
          ["42", "4000000042", NIF_SUMINISTROS, "ES", "Suministros Eléctricos del Noroeste SL"],
          ["7", "4100000007", NIF_LAVANDERIA, "ES", "Lavandería Industrial del Cantábrico SL"]
        ]
      },
      {
        name: "Clientes",
        rows: [
          ["CodigoCliente", "CodigoContable", "CifDni", "SiglaNacion", "RazonSocial"],
          ["123", "4300000123", NIF_VIAJES, "ES", "Viajes Cantábrico SL"]
        ]
      }
    ],
    new Date(Date.UTC(2026, 8, 17))
  );
}

// ---------------------------------------------------------------------------
// XML «Datos contables» (estructura inventada solo para el inspector)
// ---------------------------------------------------------------------------

export const SAGE_XML_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<DatosContables Empresa="1" Ejercicio="2026">
  <PlanCuentas><Cuenta CodigoCuenta="6280001" Titulo="Electricidad"/><Cuenta CodigoCuenta="4720021" Titulo="IVA soportado 21"/></PlanCuentas>
  <Movimientos><Movimiento Asiento="1501" CargoAbono="D" CodigoCuenta="6280001" ImporteAsiento="250,00"/><Movimiento Asiento="1501" CargoAbono="H" CodigoCuenta="4000000042" ImporteAsiento="250,00"/></Movimientos>
  <MovimientosAnalitica><Linea Asiento="1501" IdDelegacion="RA"/></MovimientosAnalitica>
  <BloqueDesconocido><Dato/></BloqueDesconocido>
</DatosContables>
`;

/** ZIP `Temporal.zip` con dos XML (y un fichero que no es XML). */
export function sageXmlZip(): Buffer {
  const second = `<?xml version="1.0" encoding="UTF-8"?><ClientesProveedores><Cliente CodigoCliente="123"/><Proveedor CodigoProveedor="42"/></ClientesProveedores>`;
  return writeZip(
    [
      { name: "DatosContables.xml", data: Buffer.from(SAGE_XML_SAMPLE, "utf8") },
      { name: "ClientesProveedores.xml", data: Buffer.from(second, "utf8") },
      { name: "leeme.txt", data: Buffer.from("no es xml", "utf8") }
    ],
    new Date(Date.UTC(2026, 8, 17))
  );
}

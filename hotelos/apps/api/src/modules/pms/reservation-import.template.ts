// Importación masiva de reservas (Tanda 7 · L2) — plantilla oficial descargable.
//
// `GET /properties/:propertyId/reservations/imports/template?format=csv|xlsx`
// devuelve `plantilla-reservas.csv` (BOM UTF-8, separador «;», CRLF, 33
// cabeceras en el orden canónico de `RESERVATION_IMPORT_FIELDS` + 2 filas de
// ejemplo FICTICIAS con e-mails @example.com) o `plantilla-reservas.xlsx`
// (hoja «Reservas» con cabecera en negrita y anchos de columna + hoja
// «Instrucciones» generada desde `RESERVATION_IMPORT_HELP_ES`: campo ·
// obligatorio · formato y valores admitidos). Las fechas del ejemplo son
// relativas a hoy (+30 días) y van como texto (ISO en la primera fila,
// DD/MM/AAAA + «noches» en la segunda) para enseñar los dos formatos.
//
// Reutiliza los escritores existentes (`csvDocument`, `writeXlsx`): sin
// dependencias. Puro salvo por la fecha de referencia (`now`, inyectable).

import {
  RESERVATION_IMPORT_FIELDS,
  RESERVATION_IMPORT_HELP_ES,
  RESERVATION_IMPORT_LABELS_ES,
  RESERVATION_IMPORT_MAX_BYTES,
  RESERVATION_IMPORT_MAX_ROWS,
  RESERVATION_IMPORT_REQUIRED_FIELDS,
  RESERVATION_IMPORT_TEMPLATE_FILE_NAMES,
  type ReservationImportField,
  type ReservationImportFormat
} from "@hotelos/shared";
import { csvDocument } from "../financial-statements/csv.js";
import { writeXlsx, type XlsxCell, type XlsxSheet } from "../financial-statements/xlsx-writer.js";

/** Cabecera de la plantilla: los 33 campos canónicos en orden. */
export const RESERVATION_IMPORT_TEMPLATE_HEADER: readonly ReservationImportField[] = RESERVATION_IMPORT_FIELDS;

export const RESERVATION_IMPORT_TEMPLATE_CONTENT_TYPES: Readonly<Record<ReservationImportFormat, string>> = Object.freeze({
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
});

/** Nombre de la hoja de datos y de la hoja de ayuda del XLSX. */
export const RESERVATION_IMPORT_TEMPLATE_SHEET = "Reservas";
export const RESERVATION_IMPORT_TEMPLATE_HELP_SHEET = "Instrucciones";

export type ReservationImportTemplateFile = {
  buffer: Buffer;
  contentType: string;
  fileName: string;
};

const DAY_MS = 86400000;

function isoPlusDays(now: Date, days: number): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + days * DAY_MS).toISOString().slice(0, 10);
}

function dmy(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

/**
 * Dos filas de ejemplo con huéspedes INVENTADOS (@example.com): la primera con
 * fechas ISO y habitación fija, la segunda con DD/MM/AAAA + noches y tarifa por
 * nombre. Devuelve una celda por campo canónico (33 por fila), siempre como texto.
 */
export function buildReservationImportTemplateRows(now: Date = new Date()): string[][] {
  const arrival1 = isoPlusDays(now, 30);
  const departure1 = isoPlusDays(now, 33);
  const arrival2 = isoPlusDays(now, 31);
  const row = (values: Partial<Record<ReservationImportField, string>>): string[] => RESERVATION_IMPORT_FIELDS.map((field) => values[field] ?? "");
  return [
    row({
      referencia_externa: "IMP-2026-001",
      llegada: arrival1,
      salida: departure1,
      tipo_habitacion: "DBL",
      tarifa: "BAR",
      habitacion: "",
      habitaciones: "1",
      adultos: "2",
      ninos: "0",
      bebes: "0",
      regimen: "BB",
      canal: "directo",
      segmento: "leisure",
      estado: "confirmada",
      nombre: "Lucía",
      apellidos: "Ferreiro Castro",
      email: "lucia.ferreiro@example.com",
      telefono: "+34 600 111 001",
      nacionalidad: "ES",
      documento_tipo: "DNI",
      documento_numero: "11111111H",
      importe_total: "250,00",
      moneda: "EUR",
      deposito: "0",
      metodo_pago: "tarjeta",
      hora_llegada: "16:30",
      peticiones: "Cama de matrimonio",
      vip: "no"
    }),
    row({
      referencia_externa: "IMP-2026-002",
      llegada: dmy(arrival2),
      noches: "2",
      tipo_habitacion: "DBL",
      tarifa: "BAR",
      habitaciones: "1",
      adultos: "2",
      ninos: "1",
      bebes: "0",
      regimen: "Alojamiento y desayuno",
      canal: "booking",
      segmento: "ota",
      estado: "confirmada",
      nombre: "Marek",
      apellidos: "Nowak",
      email: "marek.nowak@example.com",
      telefono: "+48 600 111 002",
      nacionalidad: "PL",
      documento_tipo: "PAS",
      documento_numero: "AB1234567",
      importe_total: "250,00",
      moneda: "EUR",
      deposito: "50,00",
      metodo_pago: "prepago",
      peticiones: "Cuna para el niño",
      notas: "Booking.com 4411223344",
      vip: "no"
    })
  ];
}

function requirementLabel(field: ReservationImportField): string {
  if ((RESERVATION_IMPORT_REQUIRED_FIELDS as readonly string[]).includes(field)) {
    return field === "apellidos" ? "Sí (salvo columna de nombre completo)" : "Sí";
  }
  if (field === "salida") return "Sí, si no hay «noches»";
  if (field === "noches") return "Sí, si no hay «salida»";
  return "No";
}

/** Filas de la hoja «Instrucciones»: campo · obligatorio · formato y valores admitidos (+ notas generales). */
export function buildReservationImportHelpRows(): XlsxCell[][] {
  const header: XlsxCell[] = [
    { text: "Campo", bold: true },
    { text: "Etiqueta", bold: true },
    { text: "Obligatorio", bold: true },
    { text: "Formato y valores admitidos", bold: true }
  ];
  const fields: XlsxCell[][] = RESERVATION_IMPORT_FIELDS.map((field) => [field, RESERVATION_IMPORT_LABELS_ES[field], requirementLabel(field), RESERVATION_IMPORT_HELP_ES[field]]);
  const notes: XlsxCell[][] = [
    [],
    [{ text: "Notas", bold: true }],
    ["Rellena la hoja «Reservas» respetando la cabecera; el orden de las columnas no importa y el mapeo admite cabeceras en español o inglés."],
    [`Límites: ${Math.round(RESERVATION_IMPORT_MAX_BYTES / (1024 * 1024))} MB y ${RESERVATION_IMPORT_MAX_ROWS} filas de datos por fichero.`],
    ["Las fechas se recomiendan como texto AAAA-MM-DD; las celdas de fecha de Excel también se leen."],
    ["El fichero no se guarda en el sistema: solo el resultado por fila (número de fila, referencia, fechas, tipo, tarifa y código de reserva o error)."],
    ["Las dos filas de ejemplo son ficticias: bórralas antes de importar."]
  ];
  return [header, ...fields, ...notes];
}

/** Anchos de columna (caracteres) de la hoja «Reservas», por campo. */
function templateWidths(): number[] {
  return RESERVATION_IMPORT_FIELDS.map((field) => {
    switch (field) {
      case "referencia_externa":
      case "email":
      case "peticiones":
      case "notas":
        return 28;
      case "tipo_habitacion":
      case "apellidos":
      case "telefono":
      case "empresa":
      case "agencia":
        return 20;
      case "regimen":
      case "canal":
      case "segmento":
      case "estado":
      case "nombre":
      case "documento_numero":
      case "metodo_pago":
      case "importe_total":
        return 16;
      default:
        return 12;
    }
  });
}

/**
 * Bytes de la plantilla oficial en el formato pedido, con su `content-type` y el
 * nombre de fichero de `RESERVATION_IMPORT_TEMPLATE_FILE_NAMES`.
 */
export function buildReservationImportTemplate(format: ReservationImportFormat, now: Date = new Date()): ReservationImportTemplateFile {
  const header = [...RESERVATION_IMPORT_TEMPLATE_HEADER];
  const examples = buildReservationImportTemplateRows(now);
  const fileName = RESERVATION_IMPORT_TEMPLATE_FILE_NAMES[format];
  const contentType = RESERVATION_IMPORT_TEMPLATE_CONTENT_TYPES[format];
  if (format === "csv") {
    return { buffer: Buffer.from(csvDocument(header, examples), "utf8"), contentType, fileName };
  }
  const data: XlsxSheet = {
    name: RESERVATION_IMPORT_TEMPLATE_SHEET,
    widths: templateWidths(),
    rows: [header.map((field): XlsxCell => ({ text: field, bold: true })), ...examples.map((cells): XlsxCell[] => cells.map((cell) => cell))]
  };
  const help: XlsxSheet = {
    name: RESERVATION_IMPORT_TEMPLATE_HELP_SHEET,
    widths: [22, 22, 30, 120],
    rows: buildReservationImportHelpRows()
  };
  return { buffer: writeXlsx([data, help], now), contentType, fileName };
}

// Unit tests · Tanda 7 · L1 — mapeo de columnas con sinónimos ES/EN y
// normalizadores de catálogo. Sin base de datos. Desde apps/api:
//   node --import tsx --test src/modules/pms/__tests__/reservation-import-mapping.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RESERVATION_IMPORT_FIELDS } from "@hotelos/shared";
import {
  RESERVATION_IMPORT_SYNONYMS,
  ROOM_TYPE_SYNONYMS,
  applyMapping,
  foldHeader,
  foldValue,
  isFullNameHeader,
  normalizeBoard,
  normalizeChannel,
  normalizeDocumentType,
  normalizeEstado,
  normalizeNationality,
  normalizePaymentMethod,
  normalizeSegment,
  normalizeVip,
  suggestMapping
} from "../reservation-import.mapping.js";

describe("foldHeader · foldValue", () => {
  it("pliega diacríticos, separadores y partículas", () => {
    assert.equal(foldHeader("Nº hab."), "n_hab");
    assert.equal(foldHeader("Check-in"), "check_in");
    assert.equal(foldHeader("Fecha de entrada"), "fecha_entrada");
    assert.equal(foldHeader("  Tipo de habitación "), "tipo_habitacion");
    assert.equal(foldHeader("E-mail"), "e_mail");
    assert.equal(foldHeader("Régimen"), "regimen");
    assert.equal(foldHeader("Room Type"), "room_type");
    assert.equal(foldHeader("Importe (€)"), "importe");
    assert.equal(foldHeader("Número de habitación"), "numero_habitacion");
    assert.equal(foldHeader("The Guest"), "guest");
    assert.equal(foldHeader("Nombre y apellidos"), "nombre_apellidos");
    assert.equal(foldHeader("Tel:"), "tel");
    assert.equal(foldHeader("#Reserva"), "reserva");
    assert.equal(foldHeader("de"), "de", "una cabecera que solo es partícula no se vacía");
    assert.equal(foldHeader(""), "");
    assert.equal(foldValue("Booking.com"), "booking_com");
    assert.equal(foldValue(" Walk-in "), "walk_in");
    assert.equal(foldValue("Alojamiento y desayuno"), "alojamiento_y_desayuno");
  });

  it("todos los sinónimos están plegados (idempotentes) y los campos se reconocen a sí mismos", () => {
    for (const field of RESERVATION_IMPORT_FIELDS) {
      for (const synonym of RESERVATION_IMPORT_SYNONYMS[field]) {
        assert.equal(foldHeader(synonym), synonym, `sinónimo «${synonym}» de ${field} no está plegado`);
      }
      assert.equal(suggestMapping([field]).mapping[field], field);
    }
  });
});

describe("suggestMapping", () => {
  it("cabeceras ES/EN/mixtas: «Check-in», «Fecha de entrada», «Room Type», «Guest name», «E-mail», «Nº hab.», «Régimen», «Rooms»", () => {
    const header = ["Check-in", "Fecha de entrada", "Room Type", "Guest name", "E-mail", "Nº hab.", "Régimen", "Rooms"];
    const result = suggestMapping(header);
    assert.deepEqual(result.mapping, {
      "Check-in": "llegada",
      "Fecha de entrada": null,
      "Room Type": "tipo_habitacion",
      "Guest name": "nombre",
      "E-mail": "email",
      "Nº hab.": "habitacion",
      Régimen: "regimen",
      Rooms: "habitaciones"
    });
    assert.deepEqual(result.mappingSource, {
      "Check-in": "synonym",
      "Fecha de entrada": "none",
      "Room Type": "synonym",
      "Guest name": "synonym",
      "E-mail": "synonym",
      "Nº hab.": "synonym",
      Régimen: "synonym",
      Rooms: "synonym"
    });
    assert.deepEqual(result.unmappedColumns, ["Fecha de entrada"]);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0]!, /«Fecha de entrada».*«Llegada».*sin mapear/);
  });

  it("fichero de terceros del diseño: todas las columnas por sinónimo", () => {
    const header = ["Booking ID", "Check-in", "Check-out", "Room Type", "Rate", "Guest name", "E-mail", "Adults", "Board", "Channel", "Total"];
    const result = suggestMapping(header);
    assert.deepEqual(Object.values(result.mapping), ["referencia_externa", "llegada", "salida", "tipo_habitacion", "tarifa", "nombre", "email", "adultos", "regimen", "canal", "importe_total"]);
    assert.ok(Object.values(result.mappingSource).every((source) => source === "synonym"));
    assert.deepEqual(result.unmappedColumns, []);
  });

  it("aproximado por contención: gana el término más largo y el prefijo; los exactos se asignan antes que los aproximados", () => {
    assert.equal(suggestMapping(["Notas internas"]).mapping["Notas internas"], "notas");
    assert.equal(suggestMapping(["Email cliente"]).mapping["Email cliente"], "email", "el prefijo «email» gana a «cliente»");
    assert.equal(suggestMapping(["Nombre del huésped"]).mapping["Nombre del huésped"], "nombre");
    assert.equal(suggestMapping(["Fecha llegada prevista"]).mapping["Fecha llegada prevista"], "llegada");
    assert.equal(suggestMapping(["Nº habitaciones"]).mapping["Nº habitaciones"], "habitaciones");
    assert.equal(suggestMapping(["ID"]).mapping.ID, null, "cabeceras de < 3 caracteres no casan por aproximación");
    assert.equal(suggestMapping(["Fecha de nacimiento"]).mapping["Fecha de nacimiento"], null, "«nacimiento» no es nacionalidad");
    const order = suggestMapping(["Fecha", "Llegada"]);
    assert.equal(order.mapping.Llegada, "llegada", "el exacto de la segunda columna gana al aproximado de la primera");
    assert.equal(order.mapping.Fecha, null);
    assert.equal(order.mappingSource.Fecha, "none");
    const fuzzy = suggestMapping(["Fecha"]);
    assert.equal(fuzzy.mapping.Fecha, "llegada");
    assert.equal(fuzzy.mappingSource.Fecha, "fuzzy");
  });

  it("columna repetida: la primera gana, la repetida queda sin mapear con aviso", () => {
    const result = suggestMapping(["Llegada", "Arrival", "Notas", "Notas (2)"]);
    assert.equal(result.mapping.Llegada, "llegada");
    assert.equal(result.mapping.Arrival, null);
    assert.equal(result.mapping.Notas, "notas");
    assert.equal(result.mapping["Notas (2)"], null);
    assert.equal(result.warnings.length, 2);
  });
});

describe("applyMapping", () => {
  const HEADER = ["Booking ID", "Check-in", "Check-out", "Room Type", "Rate", "Guest name", "E-mail", "Adults", "Board", "Channel", "Total"];

  it("sin explícito: sugerido, splitName por «Guest name», sin missingRequired (apellidos exento)", () => {
    const result = applyMapping(HEADER);
    assert.equal(result.splitName, true);
    assert.deepEqual(result.missingRequired, []);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.unmappedColumns, []);
    assert.equal(result.columnIndex.nombre, 5);
    assert.equal(result.columnIndex.llegada, 1);
    assert.deepEqual(result.mappingByIndex, ["referencia_externa", "llegada", "salida", "tipo_habitacion", "tarifa", "nombre", "email", "adultos", "regimen", "canal", "importe_total"]);
  });

  it("explícito gana al sugerido; null ignora la columna; el campo liberado no se reasigna al sugerido", () => {
    const result = applyMapping(HEADER, { Total: "deposito", Channel: null });
    assert.equal(result.mapping.Total, "deposito");
    assert.equal(result.mappingSource.Total, "explicit");
    assert.equal(result.mapping.Channel, null);
    assert.equal(result.mappingSource.Channel, "explicit");
    assert.deepEqual(result.unmappedColumns, ["Channel"]);
    assert.equal(result.columnIndex.importe_total, undefined);
    assert.equal(result.columnIndex.deposito, 10);
  });

  it("integrador 7b: con mapeo explícito no se avisa «también parece» de las columnas explícitas (mapeadas o ignoradas)", () => {
    const ambiguous = ["Importe", "Total", "Llegada", "Tipo", "Nombre", "Apellidos"];
    const suggested = applyMapping(ambiguous);
    assert.ok(suggested.warnings.some((warning) => warning.startsWith("La columna «Total»")), "sin explícito el sugeridor avisa de la columna repetida");
    const explicit = applyMapping(ambiguous, { Importe: "importe_total", Total: null });
    assert.ok(!explicit.warnings.some((warning) => warning.startsWith("La columna «Total»")), "con «Total» explícita (ignorada) no hay aviso");
    assert.equal(explicit.mapping.Total, null);
    assert.equal(explicit.mapping.Importe, "importe_total");
    assert.deepEqual(explicit.conflicts, []);
  });

  it("explícito sobre un campo ya sugerido en otra columna: el explícito manda y la otra queda sin mapear", () => {
    const result = applyMapping(["Llegada", "Fecha"], { Fecha: "llegada" });
    assert.equal(result.mapping.Fecha, "llegada");
    assert.equal(result.mapping.Llegada, null);
    assert.equal(result.mappingSource.Llegada, "none");
    assert.deepEqual(result.conflicts, []);
  });

  it("missingRequired: sin salida ni noches → «salida»; «Nombre» sin apellidos → «apellidos»; sin tipo → «tipo_habitacion»", () => {
    const noDates = applyMapping(["Llegada", "Tipo", "Nombre", "Apellidos"]);
    assert.deepEqual(noDates.missingRequired, ["salida"]);
    assert.equal(noDates.splitName, false);
    const noSurname = applyMapping(["Llegada", "Noches", "Tipo", "Nombre"]);
    assert.deepEqual(noSurname.missingRequired, ["apellidos"]);
    assert.equal(noSurname.splitName, false, "«Nombre» no es de nombre completo");
    const fullName = applyMapping(["Llegada", "Noches", "Tipo", "Cliente"]);
    assert.deepEqual(fullName.missingRequired, []);
    assert.equal(fullName.splitName, true);
    const fullNameWithSurname = applyMapping(["Llegada", "Noches", "Tipo", "Cliente", "Apellidos"]);
    assert.equal(fullNameWithSurname.splitName, false, "con apellidos mapeados no se parte");
    const nothing = applyMapping(["columna_1", "columna_2"]);
    assert.deepEqual(nothing.missingRequired, ["llegada", "tipo_habitacion", "nombre", "apellidos", "salida"]);
  });

  it("conflictos: campo en dos columnas, columna inexistente, campo desconocido", () => {
    const twice = applyMapping(["A", "B", "C"], { A: "llegada", B: "llegada" });
    assert.equal(twice.conflicts.length, 1);
    assert.equal(twice.conflicts[0]!.field, "llegada");
    assert.deepEqual(twice.conflicts[0]!.columns, ["A", "B"]);
    assert.match(twice.conflicts[0]!.message, /«Llegada».*2 columnas/);
    const missing = applyMapping(["A"], { Inexistente: "notas" });
    assert.equal(missing.conflicts.length, 1);
    assert.deepEqual(missing.conflicts[0]!.columns, ["Inexistente"]);
    assert.match(missing.conflicts[0]!.message, /no existe en la cabecera/);
    const unknown = applyMapping(["A"], { A: "campo_falso" as never });
    assert.equal(unknown.conflicts.length, 1);
    assert.match(unknown.conflicts[0]!.message, /campo desconocido/);
  });

  it("isFullNameHeader: exacto o contención ≥ 5 sin «first name»", () => {
    assert.equal(isFullNameHeader("guest_name"), true);
    assert.equal(isFullNameHeader("name"), true);
    assert.equal(isFullNameHeader("nombre_cliente"), true);
    assert.equal(isFullNameHeader("guest_first_name"), false);
    assert.equal(isFullNameHeader("nombre"), false);
    assert.equal(isFullNameHeader("first_name"), false);
  });
});

describe("normalizadores de catálogo", () => {
  it("régimen: códigos, equivalentes SA/AD/MP/PC/TI y texto ES/EN", () => {
    assert.equal(normalizeBoard("Alojamiento y desayuno"), "BB");
    assert.equal(normalizeBoard("Media pensión"), "HB");
    assert.equal(normalizeBoard("Pensión completa"), "FB");
    assert.equal(normalizeBoard("Todo incluido"), "AI");
    assert.equal(normalizeBoard("Solo alojamiento"), "RO");
    assert.equal(normalizeBoard("sin desayuno"), "RO");
    assert.equal(normalizeBoard("Room only"), "RO");
    assert.equal(normalizeBoard("B&B"), "BB");
    assert.equal(normalizeBoard("Bed and breakfast"), "BB");
    assert.equal(normalizeBoard("half board"), "HB");
    assert.equal(normalizeBoard("All-inclusive"), "AI");
    assert.equal(normalizeBoard("bb"), "BB");
    assert.equal(normalizeBoard("MP"), "HB");
    assert.equal(normalizeBoard("PC"), "FB");
    assert.equal(normalizeBoard("TI"), "AI");
    assert.equal(normalizeBoard("SA"), "RO");
    assert.equal(normalizeBoard(""), null);
    assert.equal(normalizeBoard("Cena romántica"), null);
  });

  it("canal: catálogo, vacío → direct, desconocido plegado ≤ 80", () => {
    assert.deepEqual(normalizeChannel("Booking.com"), { channel: "booking_com", known: true });
    assert.deepEqual(normalizeChannel("booking"), { channel: "booking_com", known: true });
    assert.deepEqual(normalizeChannel(""), { channel: "direct", known: true });
    assert.deepEqual(normalizeChannel("Directo"), { channel: "direct", known: true });
    assert.deepEqual(normalizeChannel("Walk-in"), { channel: "walk_in", known: true });
    assert.deepEqual(normalizeChannel("Teléfono"), { channel: "phone", known: true });
    assert.deepEqual(normalizeChannel("Agencia de viajes"), { channel: "agency", known: true });
    assert.deepEqual(normalizeChannel("Hotels.com"), { channel: "hotels_com", known: true });
    assert.deepEqual(normalizeChannel("Amadeus"), { channel: "gds", known: true });
    assert.deepEqual(normalizeChannel("Bedbank"), { channel: "wholesale", known: true });
    assert.deepEqual(normalizeChannel("Mi canal raro"), { channel: "mi_canal_raro", known: false });
    assert.equal(normalizeChannel("x".repeat(100)).channel.length, 80);
  });

  it("segmento, método de pago, estado, vip, tipo de documento", () => {
    assert.deepEqual(normalizeSegment("Ocio"), { segment: "leisure", known: true });
    assert.deepEqual(normalizeSegment("MICE"), { segment: "mice", known: true });
    assert.deepEqual(normalizeSegment("Boda"), { segment: "wedding", known: true });
    assert.deepEqual(normalizeSegment(""), { segment: null, known: true });
    assert.deepEqual(normalizeSegment("peregrinos"), { segment: "peregrinos", known: false });
    assert.deepEqual(normalizePaymentMethod("tarjeta"), { method: "credit_card", known: true });
    assert.deepEqual(normalizePaymentMethod("prepago OTA"), { method: "online_prepaid", known: true });
    assert.deepEqual(normalizePaymentMethod("Transferencia"), { method: "bank_transfer", known: true });
    assert.deepEqual(normalizePaymentMethod("Factura a empresa"), { method: "company_invoice", known: true });
    assert.deepEqual(normalizePaymentMethod("débito"), { method: "debit_card", known: true });
    assert.deepEqual(normalizePaymentMethod("Efectivo"), { method: "cash", known: true });
    assert.deepEqual(normalizePaymentMethod("trueque"), { method: "trueque", known: false });
    assert.equal(normalizeEstado(""), "confirmada");
    assert.equal(normalizeEstado("Confirmada"), "confirmada");
    assert.equal(normalizeEstado("OK"), "confirmada");
    assert.equal(normalizeEstado("tentative"), "tentativa");
    assert.equal(normalizeEstado("Pendiente"), "tentativa");
    assert.equal(normalizeEstado("Cancelled"), "cancelada");
    assert.equal(normalizeEstado("Anulada"), "cancelada");
    assert.equal(normalizeEstado("no-show"), null);
    assert.deepEqual(normalizeVip("sí"), { value: true, known: true });
    assert.deepEqual(normalizeVip("x"), { value: true, known: true });
    assert.deepEqual(normalizeVip("VIP"), { value: true, known: true });
    assert.deepEqual(normalizeVip("no"), { value: false, known: true });
    assert.deepEqual(normalizeVip(""), { value: false, known: true });
    assert.deepEqual(normalizeVip("quizás"), { value: false, known: false });
    assert.deepEqual(normalizeDocumentType("PAS"), { type: "PASSPORT", known: true });
    assert.deepEqual(normalizeDocumentType("dni"), { type: "DNI", known: true });
    assert.deepEqual(normalizeDocumentType("NIF"), { type: "DNI", known: true });
    assert.deepEqual(normalizeDocumentType("nie"), { type: "NIE", known: true });
    assert.deepEqual(normalizeDocumentType("TIE"), { type: "TIE", known: true });
    assert.deepEqual(normalizeDocumentType(""), { type: null, known: true });
    assert.deepEqual(normalizeDocumentType("carné de conducir"), { type: "CARNÉ DE CONDUCIR", known: false });
  });

  it("nacionalidad: alfa-3 tal cual, alfa-2 → alfa-3, nombres y gentilicios ES/EN", () => {
    assert.equal(normalizeNationality("ES"), "ESP");
    assert.equal(normalizeNationality("es"), "ESP");
    assert.equal(normalizeNationality("ESP"), "ESP");
    assert.equal(normalizeNationality("UK"), "GBR");
    assert.equal(normalizeNationality("GB"), "GBR");
    assert.equal(normalizeNationality("PL"), "POL");
    assert.equal(normalizeNationality("Alemania"), "DEU");
    assert.equal(normalizeNationality("Germany"), "DEU");
    assert.equal(normalizeNationality("española"), "ESP");
    assert.equal(normalizeNationality("British"), "GBR");
    assert.equal(normalizeNationality("Estados Unidos"), "USA");
    assert.equal(normalizeNationality("EE.UU."), "USA");
    assert.equal(normalizeNationality("Países Bajos"), "NLD");
    assert.equal(normalizeNationality("Corea del Sur"), "KOR");
    assert.equal(normalizeNationality("PRT"), "PRT");
    assert.equal(normalizeNationality("XYZ"), "XYZ", "alfa-3 desconocido se conserva tal cual");
    assert.equal(normalizeNationality("ZZ"), null);
    assert.equal(normalizeNationality("Atlántida"), null);
    assert.equal(normalizeNationality(""), null);
  });

  it("ROOM_TYPE_SYNONYMS conserva los grupos del agente de reservas", () => {
    assert.equal(ROOM_TYPE_SYNONYMS.length, 11);
    assert.deepEqual(ROOM_TYPE_SYNONYMS[0], ["double", "doble"]);
    assert.deepEqual(ROOM_TYPE_SYNONYMS[1], ["single", "individual", "sencilla"]);
    assert.deepEqual(ROOM_TYPE_SYNONYMS[10], ["standard", "estandar", "estándar"]);
  });
});

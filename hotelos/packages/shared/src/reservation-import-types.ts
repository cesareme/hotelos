/**
 * Importación masiva de reservas (Tanda 7 · L0, 2026-09-16): contrato wire entre el
 * API (`apps/api/src/modules/pms/reservation-import.*`, el CLI `reservations:import`)
 * y el admin-web (pestaña «Importar» de Recepción › Reservas).
 *
 * Qué es. Un lote (`ReservationImport`) = un fichero (csv | xlsx) importado en UNA
 * propiedad. Cada fila válida se convierte en reserva por el mismo camino que una
 * reserva de recepción (`createReservation`: lock por (propiedad, tipo), código con
 * reintento, huésped principal, folio, auditoría), con `bookingSource
 * "import:<importId>"` como clave de pertenencia al lote y del deshacer. El lote nace
 * `processing` ANTES de la primera reserva y siempre se puede deshacer.
 *
 * Convenciones (docs/design/RESERVAS-IMPORTACION-MASIVA.md):
 *   · GDPR: el fichero nunca se guarda. La fila del lote (`ReservationImportRow`)
 *     registra SOLO nº de fila, referencia externa, fechas, tipo/tarifa, nº de
 *     habitaciones, código de reserva creado o código de error; los mensajes de
 *     error y aviso citan columna y nº de fila, nunca valores. Los datos del
 *     huésped viajan solo en `NormalizedReservationRow` (muestra de la preview).
 *   · Dinero como `MoneyString` ("1234.56", dos decimales, punto): el API calcula
 *     con Prisma.Decimal y nunca expone floats; el front solo formatea.
 *   · Fechas de estancia como `IsoDate` ("YYYY-MM-DD"); instantes (`…At`) como ISO.
 *   · Idempotencia doble: hash sha256 de las filas normalizadas (409
 *     RESERVATION_IMPORT_DUPLICATE salvo `force`) y `referencia_externa` ya presente
 *     en una reserva activa de la propiedad (fila omitida).
 *   · Preview y commit comparten el mismo análisis: lo que la pantalla enseña es
 *     exactamente lo que el commit va a hacer.
 *
 * Diseño: §2 (formato), §3 (límites), §4.3 (este fichero), §5 (previsualización y
 * códigos de fila), §6 (importar y deshacer), §7 (API y códigos de lote).
 * Sin dependencias de runtime.
 */

import type { IsoDate, MoneyString } from "./financial-statements-types.js";

// ---------------------------------------------------------------------------
// Límites (diseño §3.1, §2.2, §6, §7)
// ---------------------------------------------------------------------------

/** Tamaño máximo del fichero en bytes (5 MiB) → 400 RESERVATION_IMPORT_TOO_LARGE. */
export const RESERVATION_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
/** Longitud máxima de `contentBase64` en caracteres (zod; base64 infla 4/3). */
export const RESERVATION_IMPORT_MAX_BASE64_CHARS = 7 * 1024 * 1024;
/** Longitud máxima de `content` (texto, solo CLI y tests) en caracteres. */
export const RESERVATION_IMPORT_MAX_CONTENT_CHARS = 5 * 1024 * 1024;
/** Filas de datos máximas por fichero → 400 RESERVATION_IMPORT_TOO_MANY_ROWS. */
export const RESERVATION_IMPORT_MAX_ROWS = 5000;
/** Columnas máximas de la cabecera → 400 RESERVATION_IMPORT_UNREADABLE. */
export const RESERVATION_IMPORT_MAX_COLUMNS = 200;
/** Caracteres máximos por celda: se trunca con aviso RESERVATION_IMPORT_ROW_CELL_TRUNCATED. */
export const RESERVATION_IMPORT_MAX_CELL_CHARS = 2000;
/** Noches máximas de una estancia importada (RESERVATION_IMPORT_ROW_INVALID_NIGHTS por encima). */
export const RESERVATION_IMPORT_MAX_NIGHTS = 365;
/** Longitud máxima de `fileName`. */
export const RESERVATION_IMPORT_MAX_FILE_NAME = 200;
/** Longitud máxima de `sheetName` (hoja XLSX pedida). */
export const RESERVATION_IMPORT_MAX_SHEET_NAME = 64;
/** Claves máximas del mapeo explícito (una por columna del fichero). */
export const RESERVATION_IMPORT_MAX_MAPPING_KEYS = 200;
/** Filas normalizadas devueltas en la muestra de la preview por defecto. */
export const RESERVATION_IMPORT_DEFAULT_SAMPLE_SIZE = 200;
/** Tope de `sampleSize`. */
export const RESERVATION_IMPORT_MAX_SAMPLE_SIZE = 1000;
/** Importe máximo admitido en `importe_total` y `deposito` (Decimal(12,2) de `reservations`). */
export const RESERVATION_IMPORT_AMOUNT_MAX = "999999.99";
/** Dígitos mínimos / máximos de un teléfono aceptado (fuera de rango → descartado con aviso). */
export const RESERVATION_IMPORT_PHONE_MIN_DIGITS = 7;
export const RESERVATION_IMPORT_PHONE_MAX_DIGITS = 20;
/** Llegada a más de estos días de la fecha de negocio → aviso RESERVATION_IMPORT_ROW_FAR_FUTURE. */
export const RESERVATION_IMPORT_FAR_FUTURE_DAYS = 730;
/** Más de estas noches → aviso RESERVATION_IMPORT_ROW_LONG_STAY. */
export const RESERVATION_IMPORT_LONG_STAY_NIGHTS = 60;
/** Longitud máxima del `errorMessage` persistido en la fila del lote (sin PII). */
export const RESERVATION_IMPORT_MAX_ERROR_MESSAGE = 500;
/** Longitud máxima del motivo del deshacer. */
export const RESERVATION_IMPORT_MAX_UNDO_REASON = 500;
/** Motivo por defecto del deshacer (cancelación de cada reserva del lote). */
export const RESERVATION_IMPORT_UNDO_DEFAULT_REASON = "Importación deshecha";
/** Minutos tras los que una reclamación de deshacer sin cerrar se considera abandonada (409 RESERVATION_IMPORT_UNDO_IN_PROGRESS antes). */
export const RESERVATION_IMPORT_UNDO_CLAIM_MINUTES = 15;
/** `GET …/imports`: límite por defecto y máximo. */
export const RESERVATION_IMPORT_LIST_DEFAULT_LIMIT = 50;
export const RESERVATION_IMPORT_LIST_MAX_LIMIT = 200;
/** Filas del lote persistidas por bloque durante el commit. */
export const RESERVATION_IMPORT_ROW_BATCH_SIZE = 100;
/** Prefijo de `Reservation.bookingSource` de las reservas de un lote: `import:<importId>`. */
export const RESERVATION_IMPORT_BOOKING_SOURCE_PREFIX = "import:";

/**
 * Longitud máxima (caracteres) de los campos de texto libre tras el mapeo (diseño
 * §2.2): por encima se trunca con aviso RESERVATION_IMPORT_ROW_CELL_TRUNCATED. Los
 * campos ausentes se validan por formato, no por longitud.
 */
export const RESERVATION_IMPORT_FIELD_MAX_LENGTHS: Readonly<Partial<Record<ReservationImportField, number>>> = Object.freeze({
  referencia_externa: 200,
  nombre: 120,
  apellidos: 120,
  telefono: 40,
  documento_tipo: 40,
  documento_numero: 60,
  empresa: 200,
  agencia: 200,
  grupo: 80,
  canal: 80,
  segmento: 80,
  metodo_pago: 40,
  peticiones: 2000,
  notas: 2000
});

// ---------------------------------------------------------------------------
// Campos canónicos del fichero (diseño §2.1-2.2)
// ---------------------------------------------------------------------------

/**
 * Los 33 campos canónicos en el orden de la plantilla oficial (cabecera del CSV y
 * de la hoja «Reservas» del XLSX). El mapeo de columnas resuelve cualquier cabecera
 * (sinónimos ES/EN en `reservation-import.mapping.ts`) a uno de estos campos.
 */
export const RESERVATION_IMPORT_FIELDS = [
  "referencia_externa",
  "llegada",
  "salida",
  "noches",
  "tipo_habitacion",
  "tarifa",
  "habitacion",
  "habitaciones",
  "adultos",
  "ninos",
  "bebes",
  "regimen",
  "canal",
  "segmento",
  "estado",
  "nombre",
  "apellidos",
  "email",
  "telefono",
  "nacionalidad",
  "documento_tipo",
  "documento_numero",
  "empresa",
  "agencia",
  "grupo",
  "importe_total",
  "moneda",
  "deposito",
  "metodo_pago",
  "hora_llegada",
  "peticiones",
  "notas",
  "vip"
] as const;
export type ReservationImportField = (typeof RESERVATION_IMPORT_FIELDS)[number];

/**
 * Campos que deben estar mapeados y rellenos. `apellidos` queda exento cuando la
 * columna mapeada a `nombre` es de nombre completo (`splitName` de la preview).
 * Además rige la regla «`salida` o `noches`» (`RESERVATION_IMPORT_ONE_OF_FIELDS`).
 */
export const RESERVATION_IMPORT_REQUIRED_FIELDS = ["llegada", "tipo_habitacion", "nombre", "apellidos"] as const;
export type ReservationImportRequiredField = (typeof RESERVATION_IMPORT_REQUIRED_FIELDS)[number];

/** Al menos uno de los dos debe estar mapeado y relleno; si vienen ambos deben coincidir. */
export const RESERVATION_IMPORT_ONE_OF_FIELDS = ["salida", "noches"] as const;

/** Cabecera de la plantilla CSV oficial (separador «;», 33 campos en orden canónico). */
export const RESERVATION_IMPORT_CSV_HEADER = RESERVATION_IMPORT_FIELDS.join(";");

/** Nombres de fichero de la plantilla oficial por formato. */
export const RESERVATION_IMPORT_TEMPLATE_FILE_NAMES: Readonly<Record<ReservationImportFormat, string>> = Object.freeze({
  csv: "plantilla-reservas.csv",
  xlsx: "plantilla-reservas.xlsx"
});

/** Etiqueta en español de cada campo (cabeceras de la UI, informe CSV, hoja «Instrucciones»). */
export const RESERVATION_IMPORT_LABELS_ES: Readonly<Record<ReservationImportField, string>> = Object.freeze({
  referencia_externa: "Referencia externa",
  llegada: "Llegada",
  salida: "Salida",
  noches: "Noches",
  tipo_habitacion: "Tipo de habitación",
  tarifa: "Tarifa",
  habitacion: "Habitación",
  habitaciones: "Habitaciones",
  adultos: "Adultos",
  ninos: "Niños",
  bebes: "Bebés",
  regimen: "Régimen",
  canal: "Canal",
  segmento: "Segmento",
  estado: "Estado",
  nombre: "Nombre",
  apellidos: "Apellidos",
  email: "E-mail",
  telefono: "Teléfono",
  nacionalidad: "Nacionalidad",
  documento_tipo: "Tipo de documento",
  documento_numero: "Número de documento",
  empresa: "Empresa",
  agencia: "Agencia",
  grupo: "Grupo",
  importe_total: "Importe total",
  moneda: "Moneda",
  deposito: "Depósito",
  metodo_pago: "Método de pago",
  hora_llegada: "Hora de llegada",
  peticiones: "Peticiones",
  notas: "Notas",
  vip: "VIP"
});

/**
 * Ayuda en español por campo (obligatoriedad, formato y valores admitidos): alimenta
 * la hoja «Instrucciones» de la plantilla XLSX, los tooltips del paso «Columnas» y el
 * runbook. Espejo de la tabla del diseño §2.2.
 */
export const RESERVATION_IMPORT_HELP_ES: Readonly<Record<ReservationImportField, string>> = Object.freeze({
  referencia_externa:
    "Opcional. Localizador de la OTA, agencia o PMS de origen (hasta 200 caracteres). Si ya existe en una reserva activa de la propiedad, la fila se omite; si existe en una cancelada o no-show se crea una reserva nueva con aviso.",
  llegada:
    "Obligatoria. Fecha de llegada: AAAA-MM-DD (recomendado), AAAA/MM/DD, DD/MM/AAAA, DD-MM-AAAA, DD.MM.AAAA, D/M/AA o celda de fecha de Excel. Anterior a la fecha de negocio solo con la opción «histórico».",
  salida:
    "Obligatoria si no hay «noches». Fecha de salida, posterior a la llegada, en los mismos formatos que «llegada».",
  noches: "Obligatorio si no hay «salida». Entero de 1 a 365. Si vienen «salida» y «noches», deben coincidir.",
  tipo_habitacion: "Obligatorio. Código o nombre del tipo de habitación de la propiedad (por ejemplo DBL o «Doble»).",
  tarifa: "Opcional. Código o nombre del plan de tarifa de la propiedad; vacío → tarifa BAR por defecto.",
  habitacion:
    "Opcional. Número exacto de la habitación a asignar: debe ser del tipo indicado y estar libre en esas fechas; solo con «habitaciones» = 1.",
  habitaciones: "Opcional. Unidades del tipo de habitación (entero mayor o igual que 1; por defecto 1).",
  adultos: "Opcional. Entero mayor o igual que 1 (por defecto 1).",
  ninos:
    "Opcional. Entero mayor o igual que 0 (por defecto 0). Adultos + niños no puede superar la ocupación máxima del tipo multiplicada por «habitaciones».",
  bebes: "Opcional. Entero mayor o igual que 0 (por defecto 0); no cuenta para la ocupación.",
  regimen:
    "Opcional. RO, BB, HB, FB o AI (también SA, AD, MP, PC, TI; «Solo alojamiento», «Alojamiento y desayuno», «Media pensión», «Pensión completa», «Todo incluido»; room only, b&b, half board, full board, all inclusive). Otro valor se descarta con aviso.",
  canal:
    "Opcional. directo, booking, expedia, hotels.com, airbnb, agencia, empresa, telefono, email, walk-in, grupo, gds, mayorista u ota (y sus equivalentes en inglés). Vacío → directo; otro valor se guarda tal cual con aviso.",
  segmento:
    "Opcional. corporate, leisure, mice, wedding, sports, group, government, wholesale, complimentary u ota (en español: empresa, ocio, eventos, boda, deportes, grupo, gobierno, mayorista, cortesía, online). Otro valor se guarda tal cual con aviso.",
  estado:
    "Opcional. confirmada (por defecto), tentativa (se crea confirmada con nota interna «confirmar con el cliente») o cancelada (se crea y se cancela en el mismo lote).",
  nombre:
    "Obligatorio. Nombre del huésped principal (hasta 120 caracteres). Si la columna es de nombre completo («Apellidos, Nombre» o «Nombre Apellidos») se reparte automáticamente con aviso.",
  apellidos: "Obligatorio salvo con columna de nombre completo. Uno o dos apellidos separados por espacio (hasta 120 caracteres).",
  email:
    "Opcional. E-mail del huésped; con formato inválido se descarta con aviso. Sirve para reutilizar la ficha del huésped de la organización. La importación no envía correos.",
  telefono: "Opcional. Teléfono con 7 a 20 dígitos (se admiten +, espacios, puntos y guiones); inválido → descartado con aviso.",
  nacionalidad:
    "Opcional. Código ISO alfa-3 (ESP, PRT, FRA…), alfa-2 (ES, PT, FR…) o nombre del país en español o inglés; fuera de la tabla → descartada con aviso.",
  documento_tipo: "Opcional. DNI, NIE, PASSPORT (pasaporte, PAS) o TIE; otro valor se guarda en mayúsculas con aviso.",
  documento_numero:
    "Opcional. Número de documento (se guarda en mayúsculas y sin espacios, hasta 60 caracteres). Clave prioritaria para reutilizar la ficha del huésped.",
  empresa: "Opcional. Empresa (hasta 200 caracteres).",
  agencia: "Opcional. Agencia o touroperador (hasta 200 caracteres).",
  grupo: "Opcional. Código de grupo o evento (hasta 80 caracteres).",
  importe_total:
    "Opcional. Importe total de la estancia: 1.234,56 · 1,234.56 · 1234.56 · € 312 (de 0 a 999.999,99). Vacío → se cotiza con la tarifa (aviso); sin precio en la tarifa → 0 (aviso).",
  moneda: "Opcional. Código ISO (EUR) o «€»; vacía → moneda de la propiedad; distinta de la de la propiedad → error.",
  deposito: "Opcional. Depósito o anticipo, mismo formato que «importe_total».",
  metodo_pago:
    "Opcional. cash, credit_card, debit_card, bank_transfer, voucher, company_invoice, online_prepaid o pms_account (en español: efectivo, tarjeta, débito, transferencia, bono, factura a empresa, prepago, cuenta). Otro valor se guarda tal cual con aviso.",
  hora_llegada: "Opcional. Hora estimada de llegada H:MM, HH:MM, HH.MM o celda de hora de Excel.",
  peticiones: "Opcional. Peticiones especiales del huésped (hasta 2.000 caracteres; se recorta con aviso).",
  notas: "Opcional. Notas de la reserva (hasta 2.000 caracteres; se recorta con aviso).",
  vip: "Opcional. sí, s, yes, y, true, 1, x o vip → VIP; no, n, false, 0 o vacío → no. Otro valor → no, con aviso."
});

// ---------------------------------------------------------------------------
// Catálogos (espejo del enum Prisma ReservationImportStatus y de los valores
// documentales del runbook)
// ---------------------------------------------------------------------------

/** Formato del fichero (`ReservationImport.format`). */
export const RESERVATION_IMPORT_FORMATS = ["csv", "xlsx"] as const;
export type ReservationImportFormat = (typeof RESERVATION_IMPORT_FORMATS)[number];

export const RESERVATION_IMPORT_FORMAT_LABELS_ES: Readonly<Record<ReservationImportFormat, string>> = Object.freeze({
  csv: "CSV",
  xlsx: "Excel (XLSX)"
});

/** Codificación detectada de un CSV (UTF-8 con `fatal` y, si falla, Windows-1252). */
export const RESERVATION_IMPORT_ENCODINGS = ["utf-8", "windows-1252"] as const;
export type ReservationImportEncoding = (typeof RESERVATION_IMPORT_ENCODINGS)[number];

/** Quién lanzó el commit (`optionsJson.source`). */
export const RESERVATION_IMPORT_SOURCES = ["http", "cli"] as const;
export type ReservationImportSource = (typeof RESERVATION_IMPORT_SOURCES)[number];

/**
 * Estado del lote (enum Prisma `ReservationImportStatus`): `processing` (creado
 * antes de la primera reserva; si el proceso muere queda así y sigue siendo
 * deshacible) → `imported` (todas las filas creadas) | `partial` (creadas > 0 y
 * omitidas + errores > 0) | `failed` (0 creadas) → `undone` (deshecho).
 */
export const RESERVATION_IMPORT_STATUSES = ["processing", "imported", "partial", "failed", "undone"] as const;
export type ReservationImportStatus = (typeof RESERVATION_IMPORT_STATUSES)[number];

export const RESERVATION_IMPORT_STATUS_LABELS_ES: Readonly<Record<ReservationImportStatus, string>> = Object.freeze({
  processing: "Interrumpida",
  imported: "Importada",
  partial: "Parcial",
  failed: "Fallida",
  undone: "Deshecha"
});

/** Veredicto de una fila en la preview: `error` > `skipped` > `warning` > `valid`. */
export const RESERVATION_IMPORT_ROW_STATUSES = ["valid", "warning", "error", "skipped"] as const;
export type ReservationImportRowStatus = (typeof RESERVATION_IMPORT_ROW_STATUSES)[number];

export const RESERVATION_IMPORT_ROW_STATUS_LABELS_ES: Readonly<Record<ReservationImportRowStatus, string>> = Object.freeze({
  valid: "Válida",
  warning: "Con avisos",
  error: "Con errores",
  skipped: "Omitida"
});

/** Resultado persistido de una fila tras el commit (`ReservationImportRow.outcome`). */
export const RESERVATION_IMPORT_ROW_OUTCOMES = ["created", "skipped", "error"] as const;
export type ReservationImportRowOutcome = (typeof RESERVATION_IMPORT_ROW_OUTCOMES)[number];

export const RESERVATION_IMPORT_ROW_OUTCOME_LABELS_ES: Readonly<Record<ReservationImportRowOutcome, string>> = Object.freeze({
  created: "Creada",
  skipped: "Omitida",
  error: "Error"
});

/**
 * Qué pasó con la reserva de una fila al deshacer (`ReservationImportRow.undoOutcome`):
 * `cancelled` (draft/confirmed → cancelada), `kept` (ya con check-in o check-out,
 * históricas incluidas: se conserva), `skipped` (ya estaba cancelada o no-show).
 */
export const RESERVATION_IMPORT_UNDO_OUTCOMES = ["cancelled", "kept", "skipped"] as const;
export type ReservationImportUndoOutcome = (typeof RESERVATION_IMPORT_UNDO_OUTCOMES)[number];

export const RESERVATION_IMPORT_UNDO_OUTCOME_LABELS_ES: Readonly<Record<ReservationImportUndoOutcome, string>> = Object.freeze({
  cancelled: "Cancelada",
  kept: "Conservada (ya con check-in)",
  skipped: "Sin cambios (ya cancelada)"
});

/**
 * Estado pedido por la columna `estado` del fichero: `confirmada` (por defecto) →
 * `confirmed`; `tentativa` → creada `confirmed` con aviso y nota interna (el PMS no
 * tiene transición draft → confirmed); `cancelada` → creada y cancelada en el commit.
 */
export const RESERVATION_IMPORT_ESTADOS = ["confirmada", "tentativa", "cancelada"] as const;
export type ReservationImportEstado = (typeof RESERVATION_IMPORT_ESTADOS)[number];

export const RESERVATION_IMPORT_ESTADO_LABELS_ES: Readonly<Record<ReservationImportEstado, string>> = Object.freeze({
  confirmada: "Confirmada",
  tentativa: "Tentativa (se crea confirmada)",
  cancelada: "Cancelada"
});

/**
 * Canales canónicos a los que normaliza la columna `canal` (`Reservation.channel`);
 * el valor crudo se conserva en `sourceCode`. Vacío → `direct`; desconocido →
 * plegado (≤ 80) + aviso RESERVATION_IMPORT_ROW_CHANNEL_UNKNOWN.
 */
export const RESERVATION_IMPORT_CHANNELS = [
  "direct",
  "booking_com",
  "expedia",
  "hotels_com",
  "airbnb",
  "agency",
  "corporate",
  "phone",
  "email",
  "walk_in",
  "group",
  "gds",
  "wholesale",
  "ota"
] as const;
export type ReservationImportChannel = (typeof RESERVATION_IMPORT_CHANNELS)[number];

export const RESERVATION_IMPORT_CHANNEL_LABELS_ES: Readonly<Record<ReservationImportChannel, string>> = Object.freeze({
  direct: "Directo",
  booking_com: "Booking.com",
  expedia: "Expedia",
  hotels_com: "Hotels.com",
  airbnb: "Airbnb",
  agency: "Agencia / touroperador",
  corporate: "Empresa",
  phone: "Teléfono",
  email: "Correo electrónico",
  walk_in: "Walk-in",
  group: "Grupo",
  gds: "GDS",
  wholesale: "Mayorista",
  ota: "OTA / online"
});

/** Segmentos canónicos de `segmento` (`Reservation.marketSegment`); desconocido → plegado + aviso. */
export const RESERVATION_IMPORT_SEGMENTS = [
  "corporate",
  "leisure",
  "mice",
  "wedding",
  "sports",
  "group",
  "government",
  "wholesale",
  "complimentary",
  "ota"
] as const;
export type ReservationImportSegment = (typeof RESERVATION_IMPORT_SEGMENTS)[number];

export const RESERVATION_IMPORT_SEGMENT_LABELS_ES: Readonly<Record<ReservationImportSegment, string>> = Object.freeze({
  corporate: "Corporativo",
  leisure: "Ocio",
  mice: "MICE / Convenciones",
  wedding: "Bodas",
  sports: "Deportes",
  group: "Grupos",
  government: "Administración pública",
  wholesale: "Mayorista",
  complimentary: "Cortesía",
  ota: "OTA / online"
});

/**
 * Métodos de pago canónicos de `metodo_pago` (`Reservation.paymentMethod`, mismos
 * valores que el alta de reserva del admin-web); desconocido → plegado (≤ 40) + aviso.
 * No confundir con `PaymentMethodCode` de los cobros (`payments-types.ts`).
 */
export const RESERVATION_IMPORT_PAYMENT_METHODS = [
  "cash",
  "credit_card",
  "debit_card",
  "bank_transfer",
  "voucher",
  "company_invoice",
  "online_prepaid",
  "pms_account"
] as const;
export type ReservationImportPaymentMethod = (typeof RESERVATION_IMPORT_PAYMENT_METHODS)[number];

export const RESERVATION_IMPORT_PAYMENT_METHOD_LABELS_ES: Readonly<Record<ReservationImportPaymentMethod, string>> = Object.freeze({
  cash: "Efectivo",
  credit_card: "Tarjeta de crédito",
  debit_card: "Tarjeta de débito",
  bank_transfer: "Transferencia bancaria",
  voucher: "Bono / tarjeta regalo",
  company_invoice: "Factura a empresa",
  online_prepaid: "Prepago en línea (OTA)",
  pms_account: "Cuenta PMS / facturación directa"
});

/** Regímenes de `regimen` (`Reservation.boardType`); desconocido → descartado + aviso. */
export const RESERVATION_IMPORT_BOARDS = ["RO", "BB", "HB", "FB", "AI"] as const;
export type ReservationImportBoard = (typeof RESERVATION_IMPORT_BOARDS)[number];

export const RESERVATION_IMPORT_BOARD_LABELS_ES: Readonly<Record<ReservationImportBoard, string>> = Object.freeze({
  RO: "Solo alojamiento",
  BB: "Alojamiento y desayuno",
  HB: "Media pensión",
  FB: "Pensión completa",
  AI: "Todo incluido"
});

/** Tipos de documento canónicos de `documento_tipo` (`Guest.documentType`); otro → mayúsculas + aviso. */
export const RESERVATION_IMPORT_DOCUMENT_TYPES = ["DNI", "NIE", "PASSPORT", "TIE"] as const;
export type ReservationImportDocumentType = (typeof RESERVATION_IMPORT_DOCUMENT_TYPES)[number];

export const RESERVATION_IMPORT_DOCUMENT_TYPE_LABELS_ES: Readonly<Record<ReservationImportDocumentType, string>> = Object.freeze({
  DNI: "DNI",
  NIE: "NIE",
  PASSPORT: "Pasaporte",
  TIE: "TIE"
});

/** Cómo se resolvió cada columna del fichero a un campo (paso «Columnas»). */
export const RESERVATION_IMPORT_MAPPING_SOURCES = ["explicit", "synonym", "fuzzy", "none"] as const;
export type ReservationImportMappingSourceKind = (typeof RESERVATION_IMPORT_MAPPING_SOURCES)[number];

export const RESERVATION_IMPORT_MAPPING_SOURCE_LABELS_ES: Readonly<Record<ReservationImportMappingSourceKind, string>> = Object.freeze({
  explicit: "Elegida",
  synonym: "Sinónimo",
  fuzzy: "Aproximada",
  none: "Sin mapear"
});

/** De dónde sale `totalAmount` de una fila: del fichero, cotizado con la tarifa o sin precio (0). */
export const RESERVATION_IMPORT_TOTAL_SOURCES = ["file", "quoted", "none"] as const;
export type ReservationImportTotalSource = (typeof RESERVATION_IMPORT_TOTAL_SOURCES)[number];

/** Clave por la que se reutilizó un `Guest` existente de la organización (nunca por nombre). */
export const RESERVATION_IMPORT_GUEST_REUSE_KEYS = ["document", "email"] as const;
export type ReservationImportGuestReuse = (typeof RESERVATION_IMPORT_GUEST_REUSE_KEYS)[number];

// ---------------------------------------------------------------------------
// Mapeo y opciones
// ---------------------------------------------------------------------------

/**
 * Mapeo columna del fichero → campo canónico (`{ "<cabecera tal cual>": "<campo>" }`).
 * `null` = «Ignorar columna». El explícito prevalece sobre el sugerido; un campo
 * asignado a dos columnas o una columna ausente en la cabecera → 400
 * RESERVATION_IMPORT_MAPPING_CONFLICT. Es lo que se guarda en `mappingJson`.
 */
export type ReservationImportMapping = Record<string, ReservationImportField | null>;

/** Origen del mapeo por columna del fichero (misma clave que `ReservationImportMapping`). */
export type ReservationImportMappingSource = Record<string, ReservationImportMappingSourceKind>;

/** Opciones del análisis y del commit (cuerpo de preview / import). */
export type ReservationImportOptions = {
  /** Crear las filas válidas aunque haya filas con errores (por defecto false: 0 errores exigidos). */
  omitirInvalidas: boolean;
  /** Convertir RESERVATION_IMPORT_ROW_NO_AVAILABILITY en aviso y crear por encima del cupo (auditado). */
  permitirOverbooking: boolean;
  /** Llegadas anteriores a la fecha de negocio como estancia cerrada (`checked_out`, folio cerrado). */
  historico: boolean;
  /** Importar aunque exista un lote no deshecho con el mismo hash. */
  force: boolean;
};

/** Lo que se guarda en `optionsJson` del lote: opciones + contexto del fichero y del commit. */
export type ReservationImportStoredOptions = ReservationImportOptions & {
  encoding?: ReservationImportEncoding;
  delimiter?: string;
  sheetName?: string;
  /** Con `force`: lote vivo con el mismo hash que se ignoró. */
  duplicateOfImportId?: string;
  /** Duración del commit en milisegundos. */
  durationMs?: number;
  source: ReservationImportSource;
};

// ---------------------------------------------------------------------------
// Fila normalizada (solo en la muestra de la preview; NUNCA se persiste)
// ---------------------------------------------------------------------------

/** Huésped principal tal como lo recibirá `createReservation` (alta o reutilización). */
export type ReservationImportGuestFields = {
  firstName: string;
  surname1: string;
  surname2?: string;
  email?: string;
  phone?: string;
  /** ISO alfa-3. */
  nationality?: string;
  documentType?: string;
  documentNumber?: string;
};

/**
 * Fila resuelta contra los catálogos de la propiedad: es la entrada de
 * `buildCreateReservationInput` y del hash del lote. Contiene datos personales:
 * viaja solo en la muestra (`sampleSize`) de la preview y en el CLI; jamás en
 * `ReservationImportRow`.
 */
export type NormalizedReservationRow = {
  externalReference?: string;
  arrivalDate: IsoDate;
  departureDate: IsoDate;
  nights: number;
  roomTypeId: string;
  roomTypeCode: string;
  /** Vacío solo si la propiedad no tiene tarifa por defecto. */
  ratePlanId?: string;
  ratePlanCode?: string;
  /** Habitación pedida por `habitacion` (asignada con `assignRoom` tras crear). */
  roomId?: string;
  roomNumber?: string;
  roomsCount: number;
  adults: number;
  children: number;
  infants: number;
  boardType?: ReservationImportBoard;
  /** Canal canónico o valor plegado (≤ 80) si no se reconoció. */
  channel: string;
  /** Valor crudo de la columna `canal`. */
  sourceCode?: string;
  marketSegment?: string;
  estado: ReservationImportEstado;
  /** true → se crea como estancia cerrada (`checked_out`, folio cerrado, `Stay` si hay habitación). */
  historical: boolean;
  guest: ReservationImportGuestFields;
  companyName?: string;
  travelAgentName?: string;
  groupCode?: string;
  totalAmount: MoneyString;
  totalSource: ReservationImportTotalSource;
  currency: string;
  depositAmount?: MoneyString;
  paymentMethod?: string;
  /** "HH:MM". */
  estimatedArrivalTime?: string;
  specialRequests?: string;
  notes?: string;
  vipFlag: boolean;
};

// ---------------------------------------------------------------------------
// Previsualización (`POST …/reservations/imports/preview`, nunca escribe)
// ---------------------------------------------------------------------------

/**
 * Error, omisión o aviso de una fila. `message` en español, cita columna y nº de
 * fila y NUNCA un valor del fichero (`stripRowValues`): es lo que se persiste en
 * `errorMessage` / `warningsJson`. `details` lleva datos no personales (sugerencias
 * de tipo, código de la reserva existente, primer error omitido…).
 */
export type ReservationImportIssue = {
  code: ReservationImportRowCode;
  message: string;
  /** Campo canónico afectado, si aplica. */
  column?: ReservationImportField;
  details?: Record<string, unknown>;
};

/** Resumen SIN datos personales de una fila normalizada: lo que ven todas las filas de la preview y lo que se persiste. */
export type ReservationImportRowResolved = {
  externalReference: string | null;
  arrivalDate: IsoDate;
  departureDate: IsoDate;
  nights: number;
  roomTypeCode: string;
  ratePlanCode: string | null;
  roomNumber: string | null;
  roomsCount: number;
  estado: ReservationImportEstado;
  historical: boolean;
  totalAmount: MoneyString;
  totalSource: ReservationImportTotalSource;
};

/** Cupo del tipo para la fila según la regla de rango del PMS (BD + filas anteriores del fichero). */
export type ReservationImportRowAvailability = {
  totalRooms: number;
  /** Σ roomsCount de reservas confirmed | checked_in del tipo que solapan el rango de la fila. */
  bookedDb: number;
  /** Σ roomsCount de las filas ANTERIORES aceptadas del mismo tipo que solapan. */
  bookedFile: number;
  /** bookedDb + bookedFile + roomsCount > totalRooms. */
  exceeds: boolean;
};

/** Fila de la preview: veredicto e incidencias para TODAS las filas; `normalized` solo en la muestra. */
export type ReservationImportPreviewRow = {
  /** 1 = primera fila de datos tras la cabecera. */
  rowNumber: number;
  /** Línea física 1-based del fichero (para citar en los mensajes); fila de la hoja en XLSX. */
  line: number;
  status: ReservationImportRowStatus;
  issues: ReservationImportIssue[];
  /** Huésped existente reutilizado por documento o e-mail; null / ausente si se dará de alta. */
  guestReuse?: ReservationImportGuestReuse | null;
  /** Presente cuando la fila llegó a normalizarse (sin PII). */
  resolved?: ReservationImportRowResolved;
  /** Solo en las primeras `sampleSize` filas (con datos del huésped). */
  normalized?: NormalizedReservationRow;
  /**
   * Celdas crudas de la fila (recortadas, ≤ 200 caracteres), en el orden de
   * `header`; solo en las primeras `sampleSize` filas (mismo alcance que
   * `normalized`, nunca persistidas). La pantalla «Columnas» las enseña como
   * ejemplo también en columnas sin mapear y en filas con error (FUX-04).
   */
  cells?: string[];
  /** Solo en filas que entran en el planificador (a crear, no históricas). */
  availability?: ReservationImportRowAvailability;
};

/** Disponibilidad agregada por tipo de habitación sobre el fichero entero. */
export type ReservationImportAvailabilityByType = {
  roomTypeId: string;
  code: string;
  name: string;
  /** Habitaciones vendibles y no bloqueadas del tipo (misma consulta que `createReservation`). */
  totalRooms: number;
  /** Σ roomsCount de las filas del fichero que piden este tipo. */
  rowsRequested: number;
  /** Pico de reservas de BD que solapan alguna fila. */
  peakBookedDb: number;
  /** Pico de filas del fichero aceptadas que solapan entre sí. */
  peakBookedFile: number;
  /** Noches ("YYYY-MM-DD") en las que Σ por noche (BD + fichero) supera el cupo: tabla informativa. */
  nightsExceeded: IsoDate[];
  /** Filas rechazadas por la regla de rango del PMS que cabrían por noche. */
  rangeRuleRows: number[];
};

export type ReservationImportAvailability = {
  byRoomType: ReservationImportAvailabilityByType[];
  /** Filas creadas por encima del cupo gracias a `permitirOverbooking`. */
  overbookingRows: number[];
};

/** Catálogos de la propiedad usados para resolver el fichero (para los selects y las sugerencias de la UI). */
export type ReservationImportCatalog = {
  roomTypes: Array<{
    id: string;
    code: string;
    name: string;
    maxOccupancy: number;
    totalRooms: number;
    active: boolean;
  }>;
  ratePlans: Array<{
    id: string;
    code: string;
    name: string;
    active: boolean;
  }>;
  /** Plan BAR activo con menor código; null si la propiedad no tiene ninguno. */
  defaultRatePlanCode: string | null;
  currency: string;
};

/** Recuento de filas por veredicto. */
export type ReservationImportSummary = {
  valid: number;
  warning: number;
  error: number;
  skipped: number;
  /** Filas que se crearán como estancia cerrada. */
  historical: number;
  /** Filas que el commit creará (válidas + con avisos; con `omitirInvalidas`, sin las erróneas). */
  toCreate: number;
};

/** Lote vivo con el mismo contenido (409 RESERVATION_IMPORT_DUPLICATE sin `force`). */
export type ReservationImportDuplicateRef = {
  importId: string;
  createdAt: string;
  status: ReservationImportStatus;
  fileName: string | null;
};

export type ReservationImportDuplicates = {
  /** Filas omitidas por referencia externa ya existente en una reserva activa. */
  byReferenceRows: number[];
  /** Filas omitidas por referencia repetida dentro del fichero. */
  inFileRows: number[];
  /** Filas con aviso de posible duplicado (mismo huésped + llegada + tipo). */
  possibleRows: number[];
  ofImport: ReservationImportDuplicateRef | null;
};

export type ReservationImportTotals = {
  /** Σ importes de las filas a crear que traen `importe_total`. */
  fromFile: MoneyString;
  /** Σ importes cotizados con la tarifa (filas sin importe). */
  quoted: MoneyString;
  currency: string;
};

/** Impedimento de fichero o de mapeo que deja `canImport = false` (el commit lo devuelve como 400/409 con este `code`). */
export type ReservationImportBlocker = {
  code: ReservationImportErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

/** Respuesta de `POST …/reservations/imports/preview`. */
export type ReservationImportPreview = {
  propertyId: string;
  format: ReservationImportFormat;
  fileName: string | null;
  /** sha256 hex de las filas normalizadas (mismo hash para CSV/XLSX equivalentes, otro orden o espacios). */
  contentHash: string;
  encoding: ReservationImportEncoding;
  delimiter?: string;
  sheetName?: string;
  /** Cabecera del fichero tal cual (columnas vacías → `columna_<n>`). */
  header: string[];
  /** Mapeo efectivo (explícito + sugerido): el que se guardará en `mappingJson`. */
  mapping: ReservationImportMapping;
  mappingSource: ReservationImportMappingSource;
  unmappedColumns: string[];
  missingRequired: ReservationImportField[];
  /** true cuando la columna mapeada a `nombre` es de nombre completo (`apellidos` no exigido). */
  splitName: boolean;
  catalog: ReservationImportCatalog;
  /** Fecha de negocio de la propiedad (`business_dates`): informativa; si va por detrás de `today` hay días sin cerrar (aviso en `warnings`). */
  businessDate: IsoDate;
  /** Hoy en la zona horaria de la propiedad: frontera de «llegada pasada» (la misma que la guarda `historical` de createReservation). */
  today: IsoDate;
  /** Filas de datos del fichero. */
  rowCount: number;
  summary: ReservationImportSummary;
  rows: ReservationImportPreviewRow[];
  /** Filas con `normalized` (primeras N). */
  sampleSize: number;
  availability: ReservationImportAvailability;
  duplicates: ReservationImportDuplicates;
  totals: ReservationImportTotals;
  options: ReservationImportOptions;
  /** Mapeo completo ∧ (0 errores ∨ omitirInvalidas) ∧ toCreate > 0 ∧ (sin duplicado ∨ force). */
  canImport: boolean;
  blockers: ReservationImportBlocker[];
  /** Avisos de fichero (codificación, columnas sin mapear, filas largas…) en español. */
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Lote y filas persistidas
// ---------------------------------------------------------------------------

/** Lote tal como lo devuelven el listado, el deshacer y (ampliado) el detalle. */
export type ReservationImportRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  format: ReservationImportFormat;
  fileName: string | null;
  contentHash: string;
  status: ReservationImportStatus;
  rowCount: number;
  createdCount: number;
  skippedCount: number;
  errorCount: number;
  /** Filas con al menos un aviso. */
  warningCount: number;
  mapping: ReservationImportMapping;
  options: ReservationImportStoredOptions;
  /** Primera / última llegada de las reservas creadas (informativo). */
  arrivalFrom: IsoDate | null;
  arrivalTo: IsoDate | null;
  /** Σ totalAmount de las reservas creadas. */
  totalAmount: MoneyString;
  currency: string;
  createdBy: string | null;
  createdAt: string;
  undoneAt: string | null;
  undoneBy: string | null;
  undoReason: string | null;
  undoneCount: number;
  undoKeptCount: number;
  /** Solo en la respuesta del deshacer: true cuando el lote ya estaba deshecho (idempotente, nada escrito). */
  alreadyUndone?: boolean;
};

/** Fila persistida (`reservation_import_rows`): resultado sin datos personales. */
export type ReservationImportRowRecord = {
  id: string;
  importId: string;
  rowNumber: number;
  outcome: ReservationImportRowOutcome;
  externalReference: string | null;
  arrivalDate: IsoDate | null;
  departureDate: IsoDate | null;
  roomTypeCode: string | null;
  ratePlanCode: string | null;
  roomsCount: number;
  /** Reserva creada (única por fila y por reserva). */
  reservationId: string | null;
  reservationCode: string | null;
  /** Código de error u omisión (RESERVATION_IMPORT_ROW_*). */
  errorCode: ReservationImportRowCode | null;
  /** Mensaje en español sin valores personales (≤ 500). */
  errorMessage: string | null;
  warnings: ReservationImportIssue[];
  undoOutcome: ReservationImportUndoOutcome | null;
};

/** `GET …/reservations/imports/:id`: lote + filas ordenadas por `rowNumber`. */
export type ReservationImportDetail = ReservationImportRecord & {
  rows: ReservationImportRowRecord[];
};

/** `POST …/reservations/imports` (201 siempre que el lote exista, incluso `failed`). */
export type ReservationImportResult = ReservationImportDetail & {
  warnings: string[];
};

/** `POST …/reservations/imports/:id/undo` (200, idempotente). */
export type ReservationImportUndoResult = ReservationImportRecord & {
  alreadyUndone: boolean;
  cancelledReservationIds: string[];
};

// ---------------------------------------------------------------------------
// Cuerpos y consultas de las rutas (diseño §7)
// ---------------------------------------------------------------------------

/**
 * `POST …/reservations/imports/preview`. Exactamente uno de `content` (texto: CLI y
 * tests) o `contentBase64` (bytes: siempre desde el navegador, CSV incluido, para que
 * el API decida la codificación). Formato: `format` > extensión de `fileName` > firma.
 */
export type ReservationImportPreviewBody = {
  fileName?: string;
  format?: ReservationImportFormat;
  content?: string;
  contentBase64?: string;
  /** Hoja del XLSX; por defecto la primera no oculta. */
  sheetName?: string;
  mapping?: ReservationImportMapping;
  omitirInvalidas?: boolean;
  permitirOverbooking?: boolean;
  historico?: boolean;
  force?: boolean;
  /** 1..1000 (por defecto 200). */
  sampleSize?: number;
};

/** `POST …/reservations/imports`: la preview más `commit: true` (literal). */
export type ReservationImportCreateBody = ReservationImportPreviewBody & {
  commit: true;
};

/** `POST …/reservations/imports/:id/undo`. */
export type ReservationImportUndoBody = {
  /** ≤ 500 caracteres; por defecto «Importación deshecha». */
  reason?: string;
};

/** `GET …/reservations/imports`. */
export type ReservationImportListQuery = {
  status?: ReservationImportStatus;
  /** 1..200 (por defecto 50). */
  limit?: number;
};

/** `GET …/reservations/imports/template`. */
export type ReservationImportTemplateQuery = {
  /** Por defecto csv. */
  format?: ReservationImportFormat;
};

// ---------------------------------------------------------------------------
// Códigos de error de lote (`details.code`, diseño §7.3)
// ---------------------------------------------------------------------------

/** Códigos con los que responden las rutas `/properties/:propertyId/reservations/imports*`. */
export const RESERVATION_IMPORT_ERROR_CODES = [
  /** 400 · issues zod: clave desconocida, `content` y `contentBase64` a la vez, `commit` ≠ true, `limit` fuera de 1..200, `reason` > 500. */
  "VALIDATION_ERROR",
  /** 400 · `{ reason }`: no es ZIP, ZIP64, bomba, XML roto, más de 200 columnas. */
  "RESERVATION_IMPORT_UNREADABLE",
  /** 400 · `{ bytes, max }`: fichero > 5 MiB (413 de Fastify si el cuerpo supera el `bodyLimit`). */
  "RESERVATION_IMPORT_TOO_LARGE",
  /** 400 · `{ rows, max }`: más de 5.000 filas de datos. */
  "RESERVATION_IMPORT_TOO_MANY_ROWS",
  /** 400 · sin filas de datos, o 0 filas a crear en el commit. */
  "RESERVATION_IMPORT_EMPTY",
  /** 400 · `{ missing }`: campo obligatorio sin columna mapeada. */
  "RESERVATION_IMPORT_MAPPING_INCOMPLETE",
  /** 400 · `{ field, columns }`: campo asignado a dos columnas o columna inexistente en la cabecera. */
  "RESERVATION_IMPORT_MAPPING_CONFLICT",
  /** 400 · `{ errorCount, rows: [{ rowNumber, code }] (≤ 50) }`: commit con errores de fila sin `omitirInvalidas`. */
  "RESERVATION_IMPORT_INVALID",
  /** 409 · `{ importId, createdAt, status, fileName }`: mismo hash en un lote no deshecho ni fallido, sin `force`. */
  "RESERVATION_IMPORT_DUPLICATE",
  /** 404 opaco · lote inexistente, de otra propiedad o de otra organización. */
  "RESERVATION_IMPORT_NOT_FOUND",
  /** 409 · `{ importId, undoneAt }`: otro deshacer reclamado hace menos de 15 minutos. */
  "RESERVATION_IMPORT_UNDO_IN_PROGRESS"
] as const;
export type ReservationImportErrorCode = (typeof RESERVATION_IMPORT_ERROR_CODES)[number];

/** Mensaje en español por código de lote (fallback del front y del CLI). */
export const RESERVATION_IMPORT_ERROR_LABELS_ES: Readonly<Record<ReservationImportErrorCode, string>> = Object.freeze({
  VALIDATION_ERROR: "La petición no es válida.",
  RESERVATION_IMPORT_UNREADABLE: "No se ha podido leer el fichero: guárdalo como .xlsx normal o como CSV.",
  RESERVATION_IMPORT_TOO_LARGE: "El fichero supera el tamaño admitido (5 MB): pártelo o impórtalo por CLI.",
  RESERVATION_IMPORT_TOO_MANY_ROWS: "El fichero supera las 5.000 filas: pártelo.",
  RESERVATION_IMPORT_EMPTY: "El fichero no tiene filas de datos o no hay ninguna reserva que crear.",
  RESERVATION_IMPORT_MAPPING_INCOMPLETE: "Faltan columnas obligatorias por mapear.",
  RESERVATION_IMPORT_MAPPING_CONFLICT: "El mapeo asigna un campo a dos columnas o cita una columna que no existe.",
  RESERVATION_IMPORT_INVALID: "Hay filas con errores: corrígelas o activa «Omitir filas inválidas».",
  RESERVATION_IMPORT_DUPLICATE: "Este fichero ya se importó: deshaz el lote anterior o activa «Importar de todos modos».",
  RESERVATION_IMPORT_NOT_FOUND: "Importación de reservas no encontrada.",
  RESERVATION_IMPORT_UNDO_IN_PROGRESS: "Otro deshacer de este lote está en curso: espera unos minutos."
});

// ---------------------------------------------------------------------------
// Códigos de fila (diseño §5.8): error · omisión · aviso
// ---------------------------------------------------------------------------

/** Tipo de incidencia de fila: `error` bloquea la fila, `skipped` la omite, `warning` no bloquea. */
export const RESERVATION_IMPORT_ROW_SEVERITIES = ["error", "skipped", "warning"] as const;
export type ReservationImportRowSeverity = (typeof RESERVATION_IMPORT_ROW_SEVERITIES)[number];

/** Códigos de las incidencias por fila (`ReservationImportIssue.code`, `ReservationImportRow.errorCode`). */
export const RESERVATION_IMPORT_ROW_CODES = [
  // ---- errores (la fila no se crea) ----
  /** error · falta un campo obligatorio (llegada, tipo, nombre/apellidos, salida o noches). */
  "RESERVATION_IMPORT_ROW_MISSING_FIELD",
  /** error · fecha no reconocida o inexistente (31/02). */
  "RESERVATION_IMPORT_ROW_INVALID_DATE",
  /** error · salida ≤ llegada. */
  "RESERVATION_IMPORT_ROW_DATE_ORDER",
  /** error · `salida` y `noches` presentes e incoherentes. */
  "RESERVATION_IMPORT_ROW_NIGHTS_MISMATCH",
  /** error · noches < 1 o > 365. */
  "RESERVATION_IMPORT_ROW_INVALID_NIGHTS",
  /** error · llegada anterior a la fecha de negocio sin `historico` (la auditoría nocturna la marcaría no-show). */
  "RESERVATION_IMPORT_ROW_PAST_ARRIVAL",
  /** error · llegada pasada y salida futura (estancia en curso) con `historico`: se hace por recepción. */
  "RESERVATION_IMPORT_ROW_IN_HOUSE_PAST",
  /** error · tipo no resuelto por código, nombre ni sinónimo (`details.suggestions`). */
  "RESERVATION_IMPORT_ROW_ROOM_TYPE_UNKNOWN",
  /** error · tipo de habitación desactivado. */
  "RESERVATION_IMPORT_ROW_ROOM_TYPE_INACTIVE",
  /** error · tarifa no resuelta por código ni nombre. */
  "RESERVATION_IMPORT_ROW_RATE_PLAN_UNKNOWN",
  /** error · tarifa desactivada. */
  "RESERVATION_IMPORT_ROW_RATE_PLAN_INACTIVE",
  /** error · número de habitación inexistente en la propiedad. */
  "RESERVATION_IMPORT_ROW_ROOM_UNKNOWN",
  /** error · la habitación pedida es de otro tipo. */
  "RESERVATION_IMPORT_ROW_ROOM_TYPE_MISMATCH",
  /** error · `canAssignRoom` la rechaza (ocupada, bloqueada, no vendible). */
  "RESERVATION_IMPORT_ROW_ROOM_UNAVAILABLE",
  /** error · misma habitación con noches solapadas en otra fila del fichero. */
  "RESERVATION_IMPORT_ROW_ROOM_DUPLICATE_IN_FILE",
  /** error · habitación fija con `habitaciones` > 1 (una fila por habitación). */
  "RESERVATION_IMPORT_ROW_ROOM_WITH_MULTIPLE_ROOMS",
  /** error · adultos / niños / bebés / habitaciones no enteros. */
  "RESERVATION_IMPORT_ROW_INVALID_NUMBER",
  /** error · 0 adultos. */
  "RESERVATION_IMPORT_ROW_ADULTS_REQUIRED",
  /** error · adultos + niños > ocupación máxima del tipo × habitaciones. */
  "RESERVATION_IMPORT_ROW_OCCUPANCY_EXCEEDED",
  /** error · `estado` fuera de confirmada / tentativa / cancelada. */
  "RESERVATION_IMPORT_ROW_INVALID_STATUS",
  /** error · importe no numérico, negativo o > 999.999,99. */
  "RESERVATION_IMPORT_ROW_INVALID_AMOUNT",
  /** error · moneda distinta de la de la propiedad. */
  "RESERVATION_IMPORT_ROW_INVALID_CURRENCY",
  /** error · regla de rango del PMS excedida (BD + filas anteriores del fichero) sin `permitirOverbooking`. */
  "RESERVATION_IMPORT_ROW_NO_AVAILABILITY",
  /** error · fila cancelada o con habitación sin `pms.reservation.modify`. */
  "RESERVATION_IMPORT_ROW_PERMISSION",
  /** error (commit) · `createReservation` rechazó la fila (mensaje del servicio sin PII). */
  "RESERVATION_IMPORT_ROW_CREATE_FAILED",
  /** error (commit) · RESERVATION_CODE_CONFLICT tras los reintentos. */
  "RESERVATION_IMPORT_ROW_CODE_CONFLICT",
  // ---- omisiones (la fila no se crea, sin ser un error del fichero) ----
  /** omisión · referencia externa ya existente en una reserva activa de la propiedad (`details.reservationCode`). */
  "RESERVATION_IMPORT_ROW_DUPLICATE_REFERENCE",
  /** omisión · referencia externa repetida dentro del fichero (gana la primera fila). */
  "RESERVATION_IMPORT_ROW_DUPLICATE_IN_FILE",
  /** omisión · fila con errores omitida por `omitirInvalidas` (`details.firstError`). */
  "RESERVATION_IMPORT_ROW_INVALID_SKIPPED",
  // ---- avisos (la fila se crea) ----
  /** aviso · fecha leída de un serial numérico de Excel. */
  "RESERVATION_IMPORT_ROW_DATE_FROM_SERIAL",
  /** aviso · nombre completo partido en nombre / apellidos. */
  "RESERVATION_IMPORT_ROW_NAME_SPLIT",
  /** aviso · e-mail con formato inválido, descartado. */
  "RESERVATION_IMPORT_ROW_EMAIL_DROPPED",
  /** aviso · teléfono sin 7..20 dígitos, descartado. */
  "RESERVATION_IMPORT_ROW_PHONE_DROPPED",
  /** aviso · nacionalidad fuera de la tabla alfa-2 / alfa-3 / nombres, descartada. */
  "RESERVATION_IMPORT_ROW_NATIONALITY_DROPPED",
  /** aviso · régimen fuera del catálogo, descartado. */
  "RESERVATION_IMPORT_ROW_BOARD_UNKNOWN",
  /** aviso · canal desconocido, guardado plegado (≤ 80). */
  "RESERVATION_IMPORT_ROW_CHANNEL_UNKNOWN",
  /** aviso · segmento desconocido, guardado plegado. */
  "RESERVATION_IMPORT_ROW_SEGMENT_UNKNOWN",
  /** aviso · método de pago desconocido, guardado plegado (≤ 40). */
  "RESERVATION_IMPORT_ROW_PAYMENT_METHOD_UNKNOWN",
  /** aviso · tipo de documento fuera de DNI / NIE / PASSPORT / TIE, guardado en mayúsculas. */
  "RESERVATION_IMPORT_ROW_DOCUMENT_TYPE_UNKNOWN",
  /** aviso · valor de `vip` no reconocido → false. */
  "RESERVATION_IMPORT_ROW_VIP_UNKNOWN",
  /** aviso · tipo resuelto por contención de nombre o sinónimo (candidato único). */
  "RESERVATION_IMPORT_ROW_ROOM_TYPE_FUZZY",
  /** aviso · columna `tarifa` mapeada y vacía → tarifa BAR por defecto. */
  "RESERVATION_IMPORT_ROW_RATE_PLAN_DEFAULTED",
  /** aviso · referencia existente solo en una reserva cancelada / no-show: se crea una reserva nueva. */
  "RESERVATION_IMPORT_ROW_REFERENCE_REUSED_CANCELLED",
  /** aviso · mismo huésped + llegada + tipo en la BD o en otra fila del fichero. */
  "RESERVATION_IMPORT_ROW_POSSIBLE_DUPLICATE",
  /** aviso · huésped existente reutilizado por documento o e-mail (la ficha nunca se sobreescribe). */
  "RESERVATION_IMPORT_ROW_GUEST_REUSED",
  /** aviso · el apellido del fichero difiere del de la ficha reutilizada. */
  "RESERVATION_IMPORT_ROW_GUEST_NAME_MISMATCH",
  /** aviso · importe vacío cotizado desde la tarifa (`quoteReservationTotal` × habitaciones). */
  "RESERVATION_IMPORT_ROW_TOTAL_QUOTED",
  /** aviso · importe vacío y sin precio en la tarifa → 0. */
  "RESERVATION_IMPORT_ROW_TOTAL_NOT_QUOTED",
  /** aviso · fila creada por encima del cupo con `permitirOverbooking` (auditada). */
  "RESERVATION_IMPORT_ROW_OVERBOOKING",
  /** aviso · llegada a más de 730 días de la fecha de negocio. */
  "RESERVATION_IMPORT_ROW_FAR_FUTURE",
  /** aviso · más de 60 noches. */
  "RESERVATION_IMPORT_ROW_LONG_STAY",
  /** aviso · fila creada como estancia cerrada (`checked_out`, folio cerrado). */
  "RESERVATION_IMPORT_ROW_HISTORICAL",
  /** aviso · `tentativa` / `cancelada` ignorado en una fila histórica. */
  "RESERVATION_IMPORT_ROW_STATUS_IGNORED_HISTORICAL",
  /** aviso · tentativa creada como confirmada con nota interna «confirmar con el cliente». */
  "RESERVATION_IMPORT_ROW_TENTATIVE_AS_CONFIRMED",
  /** aviso · fila creada y cancelada en el mismo commit. */
  "RESERVATION_IMPORT_ROW_CANCELLED_AT_IMPORT",
  /** aviso · celda recortada al máximo del campo. */
  "RESERVATION_IMPORT_ROW_CELL_TRUNCATED",
  /** aviso (commit) · la reserva se creó pero `assignRoom` falló (carrera): asignar desde recepción. */
  "RESERVATION_IMPORT_ROW_ROOM_ASSIGN_FAILED"
] as const;
export type ReservationImportRowCode = (typeof RESERVATION_IMPORT_ROW_CODES)[number];

/** Tipo de cada código de fila: decide el veredicto (`error` > `skipped` > `warning`). */
export const RESERVATION_IMPORT_ROW_CODE_SEVERITY: Readonly<Record<ReservationImportRowCode, ReservationImportRowSeverity>> = Object.freeze({
  RESERVATION_IMPORT_ROW_MISSING_FIELD: "error",
  RESERVATION_IMPORT_ROW_INVALID_DATE: "error",
  RESERVATION_IMPORT_ROW_DATE_ORDER: "error",
  RESERVATION_IMPORT_ROW_NIGHTS_MISMATCH: "error",
  RESERVATION_IMPORT_ROW_INVALID_NIGHTS: "error",
  RESERVATION_IMPORT_ROW_PAST_ARRIVAL: "error",
  RESERVATION_IMPORT_ROW_IN_HOUSE_PAST: "error",
  RESERVATION_IMPORT_ROW_ROOM_TYPE_UNKNOWN: "error",
  RESERVATION_IMPORT_ROW_ROOM_TYPE_INACTIVE: "error",
  RESERVATION_IMPORT_ROW_RATE_PLAN_UNKNOWN: "error",
  RESERVATION_IMPORT_ROW_RATE_PLAN_INACTIVE: "error",
  RESERVATION_IMPORT_ROW_ROOM_UNKNOWN: "error",
  RESERVATION_IMPORT_ROW_ROOM_TYPE_MISMATCH: "error",
  RESERVATION_IMPORT_ROW_ROOM_UNAVAILABLE: "error",
  RESERVATION_IMPORT_ROW_ROOM_DUPLICATE_IN_FILE: "error",
  RESERVATION_IMPORT_ROW_ROOM_WITH_MULTIPLE_ROOMS: "error",
  RESERVATION_IMPORT_ROW_INVALID_NUMBER: "error",
  RESERVATION_IMPORT_ROW_ADULTS_REQUIRED: "error",
  RESERVATION_IMPORT_ROW_OCCUPANCY_EXCEEDED: "error",
  RESERVATION_IMPORT_ROW_INVALID_STATUS: "error",
  RESERVATION_IMPORT_ROW_INVALID_AMOUNT: "error",
  RESERVATION_IMPORT_ROW_INVALID_CURRENCY: "error",
  RESERVATION_IMPORT_ROW_NO_AVAILABILITY: "error",
  RESERVATION_IMPORT_ROW_PERMISSION: "error",
  RESERVATION_IMPORT_ROW_CREATE_FAILED: "error",
  RESERVATION_IMPORT_ROW_CODE_CONFLICT: "error",
  RESERVATION_IMPORT_ROW_DUPLICATE_REFERENCE: "skipped",
  RESERVATION_IMPORT_ROW_DUPLICATE_IN_FILE: "skipped",
  RESERVATION_IMPORT_ROW_INVALID_SKIPPED: "skipped",
  RESERVATION_IMPORT_ROW_DATE_FROM_SERIAL: "warning",
  RESERVATION_IMPORT_ROW_NAME_SPLIT: "warning",
  RESERVATION_IMPORT_ROW_EMAIL_DROPPED: "warning",
  RESERVATION_IMPORT_ROW_PHONE_DROPPED: "warning",
  RESERVATION_IMPORT_ROW_NATIONALITY_DROPPED: "warning",
  RESERVATION_IMPORT_ROW_BOARD_UNKNOWN: "warning",
  RESERVATION_IMPORT_ROW_CHANNEL_UNKNOWN: "warning",
  RESERVATION_IMPORT_ROW_SEGMENT_UNKNOWN: "warning",
  RESERVATION_IMPORT_ROW_PAYMENT_METHOD_UNKNOWN: "warning",
  RESERVATION_IMPORT_ROW_DOCUMENT_TYPE_UNKNOWN: "warning",
  RESERVATION_IMPORT_ROW_VIP_UNKNOWN: "warning",
  RESERVATION_IMPORT_ROW_ROOM_TYPE_FUZZY: "warning",
  RESERVATION_IMPORT_ROW_RATE_PLAN_DEFAULTED: "warning",
  RESERVATION_IMPORT_ROW_REFERENCE_REUSED_CANCELLED: "warning",
  RESERVATION_IMPORT_ROW_POSSIBLE_DUPLICATE: "warning",
  RESERVATION_IMPORT_ROW_GUEST_REUSED: "warning",
  RESERVATION_IMPORT_ROW_GUEST_NAME_MISMATCH: "warning",
  RESERVATION_IMPORT_ROW_TOTAL_QUOTED: "warning",
  RESERVATION_IMPORT_ROW_TOTAL_NOT_QUOTED: "warning",
  RESERVATION_IMPORT_ROW_OVERBOOKING: "warning",
  RESERVATION_IMPORT_ROW_FAR_FUTURE: "warning",
  RESERVATION_IMPORT_ROW_LONG_STAY: "warning",
  RESERVATION_IMPORT_ROW_HISTORICAL: "warning",
  RESERVATION_IMPORT_ROW_STATUS_IGNORED_HISTORICAL: "warning",
  RESERVATION_IMPORT_ROW_TENTATIVE_AS_CONFIRMED: "warning",
  RESERVATION_IMPORT_ROW_CANCELLED_AT_IMPORT: "warning",
  RESERVATION_IMPORT_ROW_CELL_TRUNCATED: "warning",
  RESERVATION_IMPORT_ROW_ROOM_ASSIGN_FAILED: "warning"
});

/** Etiqueta corta en español por código de fila (informe CSV, tabla de revisión, CLI); el `message` de la incidencia añade columna y nº de fila. */
export const RESERVATION_IMPORT_ROW_CODE_LABELS_ES: Readonly<Record<ReservationImportRowCode, string>> = Object.freeze({
  RESERVATION_IMPORT_ROW_MISSING_FIELD: "Falta un campo obligatorio",
  RESERVATION_IMPORT_ROW_INVALID_DATE: "Fecha no válida",
  RESERVATION_IMPORT_ROW_DATE_ORDER: "La salida no es posterior a la llegada",
  RESERVATION_IMPORT_ROW_NIGHTS_MISMATCH: "Salida y noches no coinciden",
  RESERVATION_IMPORT_ROW_INVALID_NIGHTS: "Noches fuera de 1..365",
  RESERVATION_IMPORT_ROW_PAST_ARRIVAL: "Llegada anterior a hoy",
  RESERVATION_IMPORT_ROW_IN_HOUSE_PAST: "Estancia en curso: créala por recepción",
  RESERVATION_IMPORT_ROW_ROOM_TYPE_UNKNOWN: "Tipo de habitación desconocido",
  RESERVATION_IMPORT_ROW_ROOM_TYPE_INACTIVE: "Tipo de habitación desactivado",
  RESERVATION_IMPORT_ROW_RATE_PLAN_UNKNOWN: "Tarifa desconocida",
  RESERVATION_IMPORT_ROW_RATE_PLAN_INACTIVE: "Tarifa desactivada",
  RESERVATION_IMPORT_ROW_ROOM_UNKNOWN: "Habitación inexistente",
  RESERVATION_IMPORT_ROW_ROOM_TYPE_MISMATCH: "La habitación es de otro tipo",
  RESERVATION_IMPORT_ROW_ROOM_UNAVAILABLE: "Habitación no disponible en esas fechas",
  RESERVATION_IMPORT_ROW_ROOM_DUPLICATE_IN_FILE: "Habitación repetida en el fichero con noches solapadas",
  RESERVATION_IMPORT_ROW_ROOM_WITH_MULTIPLE_ROOMS: "Habitación fija con varias unidades",
  RESERVATION_IMPORT_ROW_INVALID_NUMBER: "Número no válido",
  RESERVATION_IMPORT_ROW_ADULTS_REQUIRED: "Hace falta al menos un adulto",
  RESERVATION_IMPORT_ROW_OCCUPANCY_EXCEEDED: "Ocupación superior a la máxima del tipo",
  RESERVATION_IMPORT_ROW_INVALID_STATUS: "Estado no admitido",
  RESERVATION_IMPORT_ROW_INVALID_AMOUNT: "Importe no válido",
  RESERVATION_IMPORT_ROW_INVALID_CURRENCY: "Moneda distinta de la de la propiedad",
  RESERVATION_IMPORT_ROW_NO_AVAILABILITY: "Sin disponibilidad para el tipo en esas fechas",
  RESERVATION_IMPORT_ROW_PERMISSION: "Sin permiso para cancelar o asignar habitación",
  RESERVATION_IMPORT_ROW_CREATE_FAILED: "El PMS rechazó la reserva",
  RESERVATION_IMPORT_ROW_CODE_CONFLICT: "Conflicto de código de reserva",
  RESERVATION_IMPORT_ROW_DUPLICATE_REFERENCE: "Referencia externa ya existente",
  RESERVATION_IMPORT_ROW_DUPLICATE_IN_FILE: "Referencia externa repetida en el fichero",
  RESERVATION_IMPORT_ROW_INVALID_SKIPPED: "Fila con errores omitida",
  RESERVATION_IMPORT_ROW_DATE_FROM_SERIAL: "Fecha leída de un serial de Excel",
  RESERVATION_IMPORT_ROW_NAME_SPLIT: "Nombre completo repartido en nombre y apellidos",
  RESERVATION_IMPORT_ROW_EMAIL_DROPPED: "E-mail no válido, descartado",
  RESERVATION_IMPORT_ROW_PHONE_DROPPED: "Teléfono no válido, descartado",
  RESERVATION_IMPORT_ROW_NATIONALITY_DROPPED: "Nacionalidad no reconocida, descartada",
  RESERVATION_IMPORT_ROW_BOARD_UNKNOWN: "Régimen no reconocido, descartado",
  RESERVATION_IMPORT_ROW_CHANNEL_UNKNOWN: "Canal no reconocido, guardado tal cual",
  RESERVATION_IMPORT_ROW_SEGMENT_UNKNOWN: "Segmento no reconocido, guardado tal cual",
  RESERVATION_IMPORT_ROW_PAYMENT_METHOD_UNKNOWN: "Método de pago no reconocido, guardado tal cual",
  RESERVATION_IMPORT_ROW_DOCUMENT_TYPE_UNKNOWN: "Tipo de documento no reconocido",
  RESERVATION_IMPORT_ROW_VIP_UNKNOWN: "Valor de VIP no reconocido",
  RESERVATION_IMPORT_ROW_ROOM_TYPE_FUZZY: "Tipo de habitación resuelto por aproximación",
  RESERVATION_IMPORT_ROW_RATE_PLAN_DEFAULTED: "Tarifa por defecto aplicada",
  RESERVATION_IMPORT_ROW_REFERENCE_REUSED_CANCELLED: "Referencia de una reserva cancelada reutilizada",
  RESERVATION_IMPORT_ROW_POSSIBLE_DUPLICATE: "Posible duplicado (mismo huésped, llegada y tipo)",
  RESERVATION_IMPORT_ROW_GUEST_REUSED: "Huésped existente reutilizado",
  RESERVATION_IMPORT_ROW_GUEST_NAME_MISMATCH: "El apellido difiere de la ficha del huésped",
  RESERVATION_IMPORT_ROW_TOTAL_QUOTED: "Importe cotizado con la tarifa",
  RESERVATION_IMPORT_ROW_TOTAL_NOT_QUOTED: "Sin importe ni precio en la tarifa (0)",
  RESERVATION_IMPORT_ROW_OVERBOOKING: "Creada por encima del cupo (overbooking)",
  RESERVATION_IMPORT_ROW_FAR_FUTURE: "Llegada a más de dos años",
  RESERVATION_IMPORT_ROW_LONG_STAY: "Estancia de más de 60 noches",
  RESERVATION_IMPORT_ROW_HISTORICAL: "Creada como estancia cerrada (histórico)",
  RESERVATION_IMPORT_ROW_STATUS_IGNORED_HISTORICAL: "Estado ignorado en una fila histórica",
  RESERVATION_IMPORT_ROW_TENTATIVE_AS_CONFIRMED: "Tentativa creada como confirmada",
  RESERVATION_IMPORT_ROW_CANCELLED_AT_IMPORT: "Creada y cancelada en la importación",
  RESERVATION_IMPORT_ROW_CELL_TRUNCATED: "Celda recortada",
  RESERVATION_IMPORT_ROW_ROOM_ASSIGN_FAILED: "Reserva creada sin la habitación pedida"
});

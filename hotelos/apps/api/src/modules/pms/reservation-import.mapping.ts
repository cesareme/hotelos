// Importación masiva de reservas (Tanda 7 · L1) — mapeo de columnas y
// normalizadores de catálogo, PUROS (sin Prisma, sin red).
//
//   · `foldHeader` — pliega una cabecera para compararla: sin diacríticos, en
//     minúsculas, `[\s\-./º°()]+` → «_», sin «_» extremos y sin las partículas
//     «de / del / la / el / los / las / of / the / y / and» y los símbolos
//     residuales («Fecha de entrada» →
//     `fecha_entrada`, «Nº hab.» → `n_hab`, «Check-in» → `check_in`);
//   · `RESERVATION_IMPORT_SYNONYMS` — sinónimos ES/EN ya plegados por campo (§2.3);
//   · `suggestMapping(header)` — por columna: exacto (campo o sinónimo) →
//     contención bidireccional (≥ 3 caracteres, gana el término más largo; el
//     que es prefijo de la cabecera puntúa más) → sin mapear; primero se asignan
//     los exactos y después los aproximados; cada campo una sola vez (la primera
//     columna gana, la repetida queda sin mapear con aviso);
//   · `applyMapping(header, explicit)` — el explícito prevalece (`null` = ignorar);
//     un campo en dos columnas o una columna inexistente → conflicto;
//     `missingRequired` (llegada, tipo_habitacion, nombre, apellidos salvo
//     `splitName`, y «salida o noches») y `splitName` (la columna de `nombre` es
//     de nombre completo y `apellidos` no está mapeado);
//   · normalizadores de valores de catálogo (régimen, canal, segmento, método de
//     pago, estado, vip, tipo de documento, nacionalidad) y `ROOM_TYPE_SYNONYMS`
//     (copia de reservation-agent.service.ts:215-243) para la resolución de tipos;
//   · Tanda 7b (modo `sync`, perfil OPERA Cloud): `resolveProfileMapping(header,
//     feedProfile)` casa por `foldHeader` cada cabecera LITERAL del perfil con la
//     cabecera real y devuelve un mapeo explícito con las cabeceras reales como
//     clave (`applyMapping` exige que la clave exista en la cabecera), más las
//     columnas desconocidas y las del perfil que faltan; `foldStatusLiteral` (=
//     `foldValue`) y `resolveSyncTargetStatus(raw, statusMap)` resuelven el estado
//     OPERA contra el diccionario del perfil sin tocar `normalizeEstado`.
//
// GDPR: ninguna función de este módulo incluye valores del fichero en sus mensajes.

import {
  RESERVATION_IMPORT_FIELDS,
  RESERVATION_IMPORT_LABELS_ES,
  RESERVATION_IMPORT_REQUIRED_FIELDS,
  RESERVATION_SYNC_TARGET_STATUSES,
  type PmsShadowFeedProfile,
  type PmsShadowStatusMap,
  type ReservationImportBoard,
  type ReservationImportChannel,
  type ReservationImportDocumentType,
  type ReservationImportEstado,
  type ReservationImportField,
  type ReservationImportMapping,
  type ReservationImportMappingSource,
  type ReservationImportPaymentMethod,
  type ReservationImportSegment,
  type ReservationSyncTargetStatus
} from "@hotelos/shared";
import { foldLabel } from "../payroll/cost-import.parser.js";

// ---------------------------------------------------------------------------
// Plegado de cabeceras y valores
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set(["de", "del", "la", "el", "los", "las", "of", "the", "y", "and"]);

/** Cabecera plegada (ver cabecera del fichero). */
export function foldHeader(value: unknown): string {
  const folded = foldLabel(value)
    .replace(/[\s\-./º°()]+/g, "_")
    .replace(/[^a-z0-9_]+/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!folded.includes("_")) return folded;
  const tokens = folded.split("_").filter((token) => token !== "" && !STOP_WORDS.has(token));
  return tokens.length > 0 ? tokens.join("_") : folded;
}

/** Valor de celda plegado para casar con un catálogo: minúsculas sin diacríticos, `[^a-z0-9]+` → «_». */
export function foldValue(value: unknown): string {
  return foldLabel(value)
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// ---------------------------------------------------------------------------
// Sinónimos (ya plegados)
// ---------------------------------------------------------------------------

/** Cabeceras que contienen el nombre completo del huésped: activan `splitName` si `apellidos` no está mapeado. */
export const FULL_NAME_SYNONYMS: readonly string[] = [
  "nombre_completo",
  "full_name",
  "fullname",
  "guest_name",
  "guest",
  "huesped",
  "cliente",
  "titular",
  "customer",
  "customer_name",
  "name",
  "nombre_apellidos",
  "apellidos_nombre",
  "nombre_huesped",
  "nombre_cliente",
  "name_surname"
];

/** Términos que indican «solo nombre de pila» (desactivan `splitName`). */
const FIRST_NAME_TERMS: readonly string[] = ["first_name", "firstname", "given_name", "nombre_pila", "first"];

export const RESERVATION_IMPORT_SYNONYMS: Readonly<Record<ReservationImportField, readonly string[]>> = Object.freeze({
  referencia_externa: [
    "referencia",
    "ref",
    "reference",
    "external_reference",
    "external_ref",
    "booking_id",
    "booking_ref",
    "booking_reference",
    "reservation_id",
    "reservation_number",
    "localizador",
    "locator",
    "confirmation_number",
    "confirmation",
    "ota_reference",
    "pms_id",
    "id_reserva",
    "numero_reserva",
    "n_reserva",
    "num_reserva",
    "codigo_reserva",
    "cod_reserva"
  ],
  llegada: ["entrada", "fecha_entrada", "fecha_llegada", "check_in", "checkin", "arrival", "arrival_date", "from", "desde", "inicio", "fecha_inicio", "start_date", "check_in_date", "date_from"],
  salida: ["fecha_salida", "check_out", "checkout", "departure", "departure_date", "to", "hasta", "fin", "fecha_fin", "end_date", "check_out_date", "date_to"],
  noches: ["nights", "num_noches", "n_noches", "estancia", "numero_noches", "no_nights", "nr_nights"],
  tipo_habitacion: ["tipo", "tipo_hab", "categoria", "room_type", "roomtype", "room_category", "category", "unit_type", "tipologia", "tipo_habitacion"],
  tarifa: ["rate", "rate_plan", "rateplan", "rate_code", "ratecode", "plan", "tarifa_codigo", "codigo_tarifa", "plan_tarifario", "rate_plan_code"],
  habitacion: ["room", "room_number", "room_no", "hab", "num_hab", "n_hab", "numero_habitacion", "num_habitacion", "unit", "room_nr"],
  habitaciones: ["rooms", "rooms_count", "num_habitaciones", "unidades", "units", "qty_rooms", "n_habitaciones", "numero_habitaciones", "number_rooms", "no_rooms"],
  adultos: ["adults", "adult", "ad", "pax", "pax_adultos", "personas", "guests_count", "num_adultos", "n_adultos", "adultos"],
  ninos: ["children", "child", "kids", "ch", "menores", "pax_ninos", "num_ninos", "n_ninos", "ninos"],
  bebes: ["infants", "infant", "babies", "cunas", "bb", "num_bebes", "n_bebes", "bebes"],
  regimen: ["board", "board_type", "meal_plan", "mealplan", "pension", "alimentacion", "plan_comidas", "regimen", "board_basis", "meal"],
  canal: ["channel", "source", "origen", "fuente", "procedencia", "booking_source", "distribution_channel", "canal"],
  segmento: ["segment", "market_segment", "mercado", "market", "segmento"],
  estado: ["status", "state", "estado_reserva", "reservation_status", "situacion", "estado", "booking_status"],
  nombre: ["first_name", "firstname", "given_name", "nombre_pila", "nombre", ...FULL_NAME_SYNONYMS],
  apellidos: ["apellido", "last_name", "lastname", "surname", "surnames", "family_name", "apellido1", "primer_apellido", "apellidos", "last"],
  email: ["e_mail", "correo", "correo_electronico", "mail", "guest_email", "email", "email_address"],
  telefono: ["tel", "phone", "telephone", "movil", "mobile", "celular", "guest_phone", "telefono", "phone_number"],
  nacionalidad: ["nationality", "pais", "country", "country_code", "nacionalidad"],
  documento_tipo: ["tipo_documento", "document_type", "id_type", "doc_type", "documento_tipo"],
  documento_numero: ["numero_documento", "documento", "document_number", "dni", "nif", "nie", "pasaporte", "passport", "id_number", "doc_number", "num_doc", "documento_numero", "n_documento"],
  empresa: ["company", "company_name", "compania", "razon_social", "corporate", "empresa"],
  agencia: ["agency", "travel_agent", "travel_agency", "tour_operator", "touroperador", "intermediario", "agente", "agencia"],
  grupo: ["group", "group_code", "codigo_grupo", "evento", "event", "grupo"],
  importe_total: ["importe", "total", "total_amount", "amount", "precio", "price", "total_price", "pvp", "revenue", "importe_total"],
  moneda: ["currency", "divisa", "currency_code", "moneda"],
  deposito: ["deposit", "prepago", "prepaid", "anticipo", "senal", "paid_amount", "deposito"],
  metodo_pago: ["forma_pago", "payment_method", "payment", "pago", "garantia", "guarantee", "metodo_pago"],
  hora_llegada: ["hora", "eta", "arrival_time", "check_in_time", "hora_entrada", "hora_llegada"],
  peticiones: ["special_requests", "requests", "preferencias", "observaciones", "remarks", "guest_remarks", "peticiones"],
  notas: ["notes", "comments", "comentarios", "internal_notes", "note", "notas"],
  vip: ["vip_flag", "is_vip", "es_vip", "vip"]
});

const EXACT_INDEX: ReadonlyMap<string, ReservationImportField> = (() => {
  const map = new Map<string, ReservationImportField>();
  for (const field of RESERVATION_IMPORT_FIELDS) {
    if (!map.has(field)) map.set(field, field);
    for (const synonym of RESERVATION_IMPORT_SYNONYMS[field]) {
      if (!map.has(synonym)) map.set(synonym, field);
    }
  }
  return map;
})();

const FUZZY_TERMS: ReadonlyArray<{ field: ReservationImportField; term: string }> = RESERVATION_IMPORT_FIELDS.flatMap((field) =>
  [field, ...RESERVATION_IMPORT_SYNONYMS[field]].filter((term) => term.length >= 3).map((term) => ({ field, term }))
);

/** ¿La cabecera (plegada) es de nombre completo? Exacta, o contiene un término de ≥ 5 caracteres sin ser «first name». */
export function isFullNameHeader(folded: string): boolean {
  if (FIRST_NAME_TERMS.some((term) => folded.includes(term))) return false;
  if (FULL_NAME_SYNONYMS.includes(folded)) return true;
  return FULL_NAME_SYNONYMS.some((term) => term.length >= 5 && folded.includes(term));
}

// ---------------------------------------------------------------------------
// Sugerencia y aplicación del mapeo
// ---------------------------------------------------------------------------

export type SuggestMappingResult = {
  mapping: ReservationImportMapping;
  mappingSource: ReservationImportMappingSource;
  unmappedColumns: string[];
  warnings: string[];
};

function fuzzyMatch(folded: string): ReservationImportField | null {
  if (folded.length < 3) return null;
  let best: { field: ReservationImportField; score: number } | null = null;
  for (const { field, term } of FUZZY_TERMS) {
    let score = 0;
    if (folded.includes(term)) score = term.length + (folded.startsWith(term) ? 3 : 0);
    else if (term.includes(folded)) score = folded.length;
    if (score > 0 && (best === null || score > best.score)) best = { field, score };
  }
  return best ? best.field : null;
}

/** Mapeo propuesto por sinónimos (exacto) y contención (aproximado); cada campo una sola vez. */
export function suggestMapping(header: readonly string[]): SuggestMappingResult {
  const mapping: ReservationImportMapping = {};
  const mappingSource: ReservationImportMappingSource = {};
  const warnings: string[] = [];
  const taken = new Set<ReservationImportField>();
  const folded = header.map((column) => foldHeader(column));

  const assign = (index: number, field: ReservationImportField | null, source: "synonym" | "fuzzy"): void => {
    const column = header[index]!;
    if (field === null) return;
    if (taken.has(field)) {
      warnings.push(`La columna «${column}» también parece «${RESERVATION_IMPORT_LABELS_ES[field]}», ya asignada a otra columna: queda sin mapear.`);
      return;
    }
    taken.add(field);
    mapping[column] = field;
    mappingSource[column] = source;
  };

  header.forEach((_column, index) => assign(index, EXACT_INDEX.get(folded[index]!) ?? null, "synonym"));
  header.forEach((column, index) => {
    if (mapping[column] !== undefined) return;
    if (EXACT_INDEX.has(folded[index]!)) return; // exacto ya rechazado por repetición
    assign(index, fuzzyMatch(folded[index]!), "fuzzy");
  });
  const unmappedColumns: string[] = [];
  for (const column of header) {
    if (mapping[column] === undefined) {
      mapping[column] = null;
      mappingSource[column] = "none";
      unmappedColumns.push(column);
    }
  }
  return { mapping, mappingSource, unmappedColumns, warnings };
}

export type ReservationImportMappingConflict = {
  field: ReservationImportField | null;
  columns: string[];
  message: string;
};

export type ApplyMappingResult = {
  /** Mapeo efectivo (una clave por columna de la cabecera). */
  mapping: ReservationImportMapping;
  mappingSource: ReservationImportMappingSource;
  unmappedColumns: string[];
  missingRequired: ReservationImportField[];
  splitName: boolean;
  conflicts: ReservationImportMappingConflict[];
  warnings: string[];
  /** Campo → índice de columna. */
  columnIndex: Partial<Record<ReservationImportField, number>>;
  /** Índice de columna → campo o null (alineado con la cabecera). */
  mappingByIndex: Array<ReservationImportField | null>;
};

/**
 * Mapeo efectivo: explícito > sugerido. `null` explícito = ignorar columna. Un
 * campo asignado explícitamente a dos columnas, o una columna del mapeo que no
 * existe en la cabecera, es un conflicto (400 RESERVATION_IMPORT_MAPPING_CONFLICT).
 */
export function applyMapping(header: readonly string[], explicit?: ReservationImportMapping | null): ApplyMappingResult {
  const suggested = suggestMapping(header);
  const mapping: ReservationImportMapping = {};
  const mappingSource: ReservationImportMappingSource = {};
  const conflicts: ReservationImportMappingConflict[] = [];
  // Integrador 7b: los avisos «también parece …, queda sin mapear» del sugeridor solo valen para las columnas que
  // resuelve el sugeridor; con un mapeo explícito por columna (perfil OPERA Cloud: RATE_CODE → tarifa,
  // NAME_ON_CARD → ignorada…) decían «queda sin mapear» de columnas mapeadas o ignoradas a propósito.
  const explicitColumns = explicit ? Object.keys(explicit) : [];
  const warnings = suggested.warnings.filter((warning) => !explicitColumns.some((column) => warning.startsWith(`La columna «${column}»`)));
  const headerSet = new Set(header);
  const explicitByField = new Map<ReservationImportField, string[]>();

  if (explicit) {
    for (const [column, field] of Object.entries(explicit)) {
      if (!headerSet.has(column)) {
        conflicts.push({ field: field ?? null, columns: [column], message: `El mapeo cita la columna «${column}», que no existe en la cabecera.` });
        continue;
      }
      if (field === null || field === undefined) {
        mapping[column] = null;
        mappingSource[column] = "explicit";
        continue;
      }
      if (!RESERVATION_IMPORT_FIELDS.includes(field)) {
        conflicts.push({ field: null, columns: [column], message: `El mapeo de la columna «${column}» usa un campo desconocido.` });
        continue;
      }
      const list = explicitByField.get(field) ?? [];
      list.push(column);
      explicitByField.set(field, list);
      mapping[column] = field;
      mappingSource[column] = "explicit";
    }
    for (const [field, columns] of explicitByField) {
      if (columns.length > 1) {
        conflicts.push({ field, columns, message: `El campo «${RESERVATION_IMPORT_LABELS_ES[field]}» está asignado a ${columns.length} columnas.` });
      }
    }
  }

  const taken = new Set<ReservationImportField>(explicitByField.keys());
  for (const column of header) {
    if (mapping[column] !== undefined) continue;
    const field = suggested.mapping[column] ?? null;
    if (field !== null && !taken.has(field)) {
      taken.add(field);
      mapping[column] = field;
      mappingSource[column] = suggested.mappingSource[column] ?? "synonym";
    } else {
      mapping[column] = null;
      mappingSource[column] = "none";
    }
  }

  const columnIndex: Partial<Record<ReservationImportField, number>> = {};
  const mappingByIndex: Array<ReservationImportField | null> = header.map((column, index) => {
    const field = mapping[column] ?? null;
    if (field !== null && columnIndex[field] === undefined) columnIndex[field] = index;
    return field;
  });
  const unmappedColumns = header.filter((column) => (mapping[column] ?? null) === null);

  const nameIndex = columnIndex.nombre;
  const splitName = nameIndex !== undefined && columnIndex.apellidos === undefined && isFullNameHeader(foldHeader(header[nameIndex]!));
  const missingRequired: ReservationImportField[] = [];
  for (const field of RESERVATION_IMPORT_REQUIRED_FIELDS) {
    if (columnIndex[field] !== undefined) continue;
    if (field === "apellidos" && splitName) continue;
    missingRequired.push(field);
  }
  if (columnIndex.salida === undefined && columnIndex.noches === undefined) missingRequired.push("salida");

  return { mapping, mappingSource, unmappedColumns, missingRequired, splitName, conflicts, warnings, columnIndex, mappingByIndex };
}

// ---------------------------------------------------------------------------
// Tanda 7b · perfil preinstalado (cabecera literal → campo) y estados del PMS
// ---------------------------------------------------------------------------

export type ResolveProfileMappingResult = {
  /** Mapeo EXPLÍCITO con las cabeceras reales del fichero como clave (`null` = ignorada por el perfil). */
  mapping: ReservationImportMapping;
  /** Columnas del fichero que el perfil no conoce (en `sync` → 400 RESERVATION_IMPORT_HEADER_MISMATCH). */
  unknownColumns: string[];
  /** Columnas del perfil que el fichero no trae (renombradas o suprimidas). */
  missingProfileColumns: string[];
};

/**
 * Casa por `foldHeader` cada cabecera LITERAL del perfil del feed con la cabecera
 * real del fichero. Una columna real que pliega igual que una del perfil toma su
 * campo (o `null` si el perfil la ignora); las demás se ignoran EXPLÍCITAMENTE
 * (`null`, para que `applyMapping` no las sugiera por sinónimo: con un perfil, lo
 * que el perfil no conoce no se importa) y se devuelven en `unknownColumns`. Un
 * mismo campo nunca se asigna dos veces (gana la primera columna real, en el
 * orden del fichero).
 */
export function resolveProfileMapping(header: readonly string[], feedProfile: Pick<PmsShadowFeedProfile, "mapping">): ResolveProfileMappingResult {
  const byFolded = new Map<string, { column: string; field: ReservationImportField | null }>();
  for (const [column, field] of Object.entries(feedProfile.mapping)) {
    const folded = foldHeader(column);
    if (!byFolded.has(folded)) byFolded.set(folded, { column, field });
  }
  const mapping: ReservationImportMapping = {};
  const unknownColumns: string[] = [];
  const seenProfileColumns = new Set<string>();
  const taken = new Set<ReservationImportField>();
  for (const column of header) {
    const entry = byFolded.get(foldHeader(column));
    if (!entry) {
      unknownColumns.push(column);
      mapping[column] = null;
      continue;
    }
    seenProfileColumns.add(entry.column);
    if (entry.field !== null && !taken.has(entry.field)) {
      taken.add(entry.field);
      mapping[column] = entry.field;
    } else {
      mapping[column] = null;
    }
  }
  const missingProfileColumns = Object.keys(feedProfile.mapping).filter((column) => !seenProfileColumns.has(column));
  return { mapping, unknownColumns, missingProfileColumns };
}

/** Literal de estado del PMS plegado como clave del diccionario del perfil (= `foldValue`: «Checked In» → `checked_in`, «NO SHOW» → `no_show`). */
export function foldStatusLiteral(raw: unknown): string {
  return foldValue(raw);
}

/**
 * Estado destino de una fila en modo `sync`: literal plegado → `statusMap` del
 * perfil. Vacío o fuera del diccionario → null (error RESERVATION_IMPORT_ROW_INVALID_STATUS);
 * un valor del diccionario fuera de RESERVATION_SYNC_TARGET_STATUSES (perfil
 * corrupto en BD) también → null.
 */
export function resolveSyncTargetStatus(raw: unknown, statusMap: PmsShadowStatusMap): ReservationSyncTargetStatus | null {
  const folded = foldStatusLiteral(raw);
  if (folded === "") return null;
  const target = statusMap[folded];
  if (target === undefined || !RESERVATION_SYNC_TARGET_STATUSES.includes(target)) return null;
  return target;
}

// ---------------------------------------------------------------------------
// Normalizadores de catálogo (valor plegado → canónico)
// ---------------------------------------------------------------------------

const BOARD_CODES: Readonly<Record<string, ReservationImportBoard>> = Object.freeze({
  ro: "RO",
  sa: "RO",
  ep: "RO",
  bb: "BB",
  ad: "BB",
  hb: "HB",
  mp: "HB",
  fb: "FB",
  pc: "FB",
  ai: "AI",
  ti: "AI"
});

/**
 * Régimen: códigos RO/BB/HB/FB/AI y SA/AD/MP/PC/TI, o texto ES/EN (patrones de
 * `parseBoard` de reservation-agent.service.ts:186 con «sin desayuno» → RO antes
 * que «desayuno» → BB). Vacío o desconocido → null.
 */
export function normalizeBoard(raw: unknown): ReservationImportBoard | null {
  const folded = foldLabel(raw);
  if (folded === "") return null;
  const code = BOARD_CODES[folded.replace(/[^a-z]/g, "")];
  if (code && folded.replace(/[^a-z]/g, "").length <= 2) return code;
  if (/\b(all[- ]?inclusive|todo incluido|todo_incluido)\b/.test(folded)) return "AI";
  if (/\b(full[- ]?board|pension completa|pension_completa)\b/.test(folded)) return "FB";
  if (/\b(half[- ]?board|media pension|media_pension)\b/.test(folded)) return "HB";
  if (/\b(room[- ]?only|solo alojamiento|solo_alojamiento|sin desayuno|only room|habitacion sola)\b/.test(folded)) return "RO";
  if (/(breakfast|desayuno|bed and breakfast|b&b|b_b|\bbb\b)/.test(folded)) return "BB";
  return null;
}

type CatalogRule<T extends string> = { value: T; exact: readonly string[]; contains?: readonly string[] };

function matchCatalog<T extends string>(folded: string, rules: ReadonlyArray<CatalogRule<T>>): T | null {
  for (const rule of rules) {
    if (rule.exact.includes(folded)) return rule.value;
  }
  for (const rule of rules) {
    if (rule.contains?.some((term) => folded.includes(term))) return rule.value;
  }
  return null;
}

const CHANNEL_RULES: ReadonlyArray<CatalogRule<ReservationImportChannel>> = [
  { value: "direct", exact: ["directo", "direct", "web", "hotel", "motor", "propia", "directa", "website", "own_website", "motor_reservas", "direct_booking", "pagina_web"], contains: ["direct", "motor_reserv"] },
  { value: "booking_com", exact: ["booking", "booking_com", "bcom", "bookingcom"], contains: ["booking_com", "bookingcom"] },
  { value: "expedia", exact: ["expedia"], contains: ["expedia"] },
  { value: "hotels_com", exact: ["hotels_com", "hotelscom", "hotels"], contains: ["hotels_com"] },
  { value: "airbnb", exact: ["airbnb"], contains: ["airbnb"] },
  { value: "agency", exact: ["agencia", "agency", "travel_agent", "tour_operator", "tto", "touroperador", "agencia_viajes", "travel_agency"], contains: ["agencia", "agency", "tour_operator", "touroperador"] },
  { value: "corporate", exact: ["empresa", "corporate", "company", "corporativo"], contains: ["corporat", "empresa"] },
  { value: "phone", exact: ["telefono", "phone", "llamada", "tel", "telephone"], contains: ["telefon", "phone"] },
  { value: "email", exact: ["email", "correo", "mail", "e_mail", "correo_electronico"], contains: ["mail", "correo"] },
  { value: "walk_in", exact: ["walk_in", "walkin", "mostrador", "walk"], contains: ["walk"] },
  { value: "group", exact: ["grupo", "group", "grupos", "groups"], contains: ["grupo", "group"] },
  { value: "gds", exact: ["gds", "amadeus", "sabre", "galileo", "travelport"], contains: ["gds", "amadeus", "sabre"] },
  { value: "wholesale", exact: ["wholesale", "mayorista", "bedbank", "wholesaler", "bed_bank"], contains: ["wholesal", "mayorista", "bedbank"] },
  { value: "ota", exact: ["ota", "online", "otas"], contains: ["ota"] }
];

/** Canal: vacío → `direct`; conocido → canónico; desconocido → plegado (≤ 80) con `known = false`. */
export function normalizeChannel(raw: unknown): { channel: string; known: boolean } {
  const folded = foldValue(raw);
  if (folded === "") return { channel: "direct", known: true };
  const found = matchCatalog(folded, CHANNEL_RULES);
  if (found) return { channel: found, known: true };
  return { channel: folded.slice(0, 80), known: false };
}

const SEGMENT_RULES: ReadonlyArray<CatalogRule<ReservationImportSegment>> = [
  { value: "corporate", exact: ["corporate", "empresa", "business", "corporativo", "negocios", "empresas"], contains: ["corporat", "business", "empresa"] },
  { value: "leisure", exact: ["leisure", "ocio", "vacacional", "vacaciones", "turismo"], contains: ["leisure", "ocio", "vacacion"] },
  { value: "mice", exact: ["mice", "eventos", "congresos", "congreso", "evento", "convenciones"], contains: ["mice", "congres", "evento", "convenc"] },
  { value: "wedding", exact: ["wedding", "boda", "bodas", "weddings"], contains: ["wedding", "boda"] },
  { value: "sports", exact: ["sports", "deportes", "deporte", "sport"], contains: ["sport", "deport"] },
  { value: "group", exact: ["group", "grupo", "grupos", "groups"], contains: ["group", "grupo"] },
  { value: "government", exact: ["government", "gobierno", "administracion", "administracion_publica", "public"], contains: ["govern", "gobierno", "administracion"] },
  { value: "wholesale", exact: ["wholesale", "mayorista", "bedbank", "wholesaler"], contains: ["wholesal", "mayorista"] },
  { value: "complimentary", exact: ["complimentary", "cortesia", "invitacion", "comp", "gratuito"], contains: ["compliment", "cortesia", "invitac"] },
  { value: "ota", exact: ["ota", "online", "otas"], contains: ["ota", "online"] }
];

/** Segmento: vacío → null; conocido → canónico; desconocido → plegado (≤ 80) con `known = false`. */
export function normalizeSegment(raw: unknown): { segment: string | null; known: boolean } {
  const folded = foldValue(raw);
  if (folded === "") return { segment: null, known: true };
  const found = matchCatalog(folded, SEGMENT_RULES);
  if (found) return { segment: found, known: true };
  return { segment: folded.slice(0, 80), known: false };
}

const PAYMENT_RULES: ReadonlyArray<CatalogRule<ReservationImportPaymentMethod>> = [
  { value: "cash", exact: ["cash", "efectivo", "metalico", "contado"], contains: ["efectivo", "cash", "metalico"] },
  { value: "debit_card", exact: ["debit_card", "debito", "tarjeta_debito", "debit", "maestro"], contains: ["debit"] },
  { value: "credit_card", exact: ["credit_card", "tarjeta", "card", "visa", "mastercard", "tarjeta_credito", "credito", "amex", "credit"], contains: ["tarjeta", "card", "visa", "master", "credit", "amex"] },
  { value: "bank_transfer", exact: ["bank_transfer", "transferencia", "transfer", "wire", "sepa"], contains: ["transfer", "wire"] },
  { value: "voucher", exact: ["voucher", "bono", "bono_regalo", "gift_card"], contains: ["voucher", "bono", "gift"] },
  { value: "company_invoice", exact: ["company_invoice", "factura", "factura_a_empresa", "factura_empresa", "credito_empresa", "invoice", "credit_company"], contains: ["factura", "invoice", "credito_empresa"] },
  { value: "online_prepaid", exact: ["online_prepaid", "prepago", "prepaid", "vcc", "virtual_card", "online", "prepago_ota", "prepaid_ota"], contains: ["prepag", "prepaid", "vcc", "virtual"] },
  { value: "pms_account", exact: ["pms_account", "cuenta", "cargo_en_cuenta", "pms", "cargo_cuenta", "account"], contains: ["cuenta", "account", "pms"] }
];

/** Método de pago: vacío → null; conocido → canónico; desconocido → plegado (≤ 40) con `known = false`. */
export function normalizePaymentMethod(raw: unknown): { method: string | null; known: boolean } {
  const folded = foldValue(raw);
  if (folded === "") return { method: null, known: true };
  const found = matchCatalog(folded, PAYMENT_RULES);
  if (found) return { method: found, known: true };
  return { method: folded.slice(0, 40), known: false };
}

const ESTADO_RULES: ReadonlyArray<CatalogRule<ReservationImportEstado>> = [
  { value: "confirmada", exact: ["confirmada", "confirmed", "confirm", "ok", "garantizada", "guaranteed", "confirmado", "activa", "active", "booked", "reservada"] },
  { value: "tentativa", exact: ["tentativa", "tentative", "draft", "provisional", "opcional", "option", "pendiente", "pending", "borrador", "optional", "on_request"] },
  { value: "cancelada", exact: ["cancelada", "cancelled", "canceled", "anulada", "baja", "cancelado", "cancel", "anulado"] }
];

/** Estado pedido: vacío → `confirmada`; desconocido → null (error RESERVATION_IMPORT_ROW_INVALID_STATUS). */
export function normalizeEstado(raw: unknown): ReservationImportEstado | null {
  const folded = foldValue(raw);
  if (folded === "") return "confirmada";
  return matchCatalog(folded, ESTADO_RULES);
}

const VIP_TRUE = new Set(["si", "s", "yes", "y", "true", "1", "x", "vip", "verdadero"]);
const VIP_FALSE = new Set(["no", "n", "false", "0", "falso", "-"]);

/** VIP: sí/s/yes/y/true/1/x/vip → true; no/n/false/0/vacío → false; otro → false con `known = false`. */
export function normalizeVip(raw: unknown): { value: boolean; known: boolean } {
  const folded = foldValue(raw);
  if (folded === "" || VIP_FALSE.has(folded)) return { value: false, known: true };
  if (VIP_TRUE.has(folded)) return { value: true, known: true };
  return { value: false, known: false };
}

const DOCUMENT_TYPE_RULES: ReadonlyArray<CatalogRule<ReservationImportDocumentType>> = [
  { value: "DNI", exact: ["dni", "nif", "dni_nif", "nif_dni", "documento_nacional_identidad", "carnet_identidad", "id_card", "national_id", "cedula"] },
  { value: "NIE", exact: ["nie"] },
  { value: "PASSPORT", exact: ["pasaporte", "passport", "pas", "ppt", "pass", "pp", "passeport"] },
  { value: "TIE", exact: ["tie", "tarjeta_residencia", "residence_card", "permiso_residencia"] }
];

/** Tipo de documento: vacío → null; conocido → DNI/NIE/PASSPORT/TIE; otro → mayúsculas ≤ 40 con `known = false`. */
export function normalizeDocumentType(raw: unknown): { type: string | null; known: boolean } {
  const folded = foldValue(raw);
  if (folded === "") return { type: null, known: true };
  const found = matchCatalog(folded, DOCUMENT_TYPE_RULES);
  if (found) return { type: found, known: true };
  return { type: String(raw).trim().toUpperCase().slice(0, 40), known: false };
}

// ---------------------------------------------------------------------------
// Nacionalidad: alfa-2 → alfa-3, nombres y gentilicios ES/EN
// ---------------------------------------------------------------------------

type CountryRow = readonly [alpha2: string, alpha3: string, aliases: readonly string[]];

/** Tabla de países (alfa-2, alfa-3, nombres y gentilicios en español e inglés, ya sin diacríticos). */
export const RESERVATION_IMPORT_COUNTRIES: readonly CountryRow[] = [
  ["ES", "ESP", ["espana", "spain", "espanola", "espanol", "spanish"]],
  ["PT", "PRT", ["portugal", "portuguesa", "portugues", "portuguese"]],
  ["FR", "FRA", ["francia", "france", "francesa", "frances", "french"]],
  ["DE", "DEU", ["alemania", "germany", "alemana", "aleman", "german", "deutschland"]],
  ["GB", "GBR", ["reino unido", "united kingdom", "uk", "great britain", "gran bretana", "inglaterra", "england", "britanica", "britanico", "british", "inglesa", "ingles", "english", "escocia", "scotland", "gales", "wales"]],
  ["IT", "ITA", ["italia", "italy", "italiana", "italiano", "italian"]],
  ["US", "USA", ["estados unidos", "united states", "united states of america", "eeuu", "ee uu", "ee.uu.", "estadounidense", "american", "americana", "americano", "norteamericana", "norteamericano"]],
  ["NL", "NLD", ["paises bajos", "holanda", "netherlands", "holland", "the netherlands", "holandesa", "holandes", "dutch", "neerlandesa", "neerlandes"]],
  ["BE", "BEL", ["belgica", "belgium", "belga", "belgian"]],
  ["IE", "IRL", ["irlanda", "ireland", "irlandesa", "irlandes", "irish"]],
  ["PL", "POL", ["polonia", "poland", "polaca", "polaco", "polish"]],
  ["CH", "CHE", ["suiza", "switzerland", "suizo", "swiss"]],
  ["AT", "AUT", ["austria", "austriaca", "austriaco", "austrian"]],
  ["BR", "BRA", ["brasil", "brazil", "brasilena", "brasileno", "brazilian"]],
  ["AR", "ARG", ["argentina", "argentino", "argentinian", "argentine"]],
  ["MX", "MEX", ["mexico", "mejico", "mexicana", "mexicano", "mexican"]],
  ["CN", "CHN", ["china", "chino", "chinese"]],
  ["JP", "JPN", ["japon", "japan", "japonesa", "japones", "japanese"]],
  ["MA", "MAR", ["marruecos", "morocco", "marroqui", "moroccan"]],
  ["CO", "COL", ["colombia", "colombiana", "colombiano", "colombian"]],
  ["SE", "SWE", ["suecia", "sweden", "sueca", "sueco", "swedish"]],
  ["NO", "NOR", ["noruega", "norway", "noruego", "norwegian"]],
  ["DK", "DNK", ["dinamarca", "denmark", "danesa", "danes", "danish"]],
  ["FI", "FIN", ["finlandia", "finland", "finlandesa", "finlandes", "finnish"]],
  ["CZ", "CZE", ["chequia", "republica checa", "czechia", "czech republic", "checa", "checo", "czech"]],
  ["RO", "ROU", ["rumania", "romania", "rumana", "rumano", "romanian"]],
  ["RU", "RUS", ["rusia", "russia", "rusa", "ruso", "russian"]],
  ["UA", "UKR", ["ucrania", "ukraine", "ucraniana", "ucraniano", "ukrainian"]],
  ["CA", "CAN", ["canada", "canadiense", "canadian"]],
  ["AU", "AUS", ["australia", "australiana", "australiano", "australian"]],
  ["IN", "IND", ["india", "indio", "indian"]],
  ["KR", "KOR", ["corea del sur", "corea", "south korea", "korea", "coreana", "coreano", "korean"]],
  ["IL", "ISR", ["israel", "israeli"]],
  ["TR", "TUR", ["turquia", "turkey", "turkiye", "turca", "turco", "turkish"]],
  ["GR", "GRC", ["grecia", "greece", "griega", "griego", "greek"]],
  ["CL", "CHL", ["chile", "chilena", "chileno", "chilean"]],
  ["PE", "PER", ["peru", "peruana", "peruano", "peruvian"]],
  ["VE", "VEN", ["venezuela", "venezolana", "venezolano", "venezuelan"]],
  ["UY", "URY", ["uruguay", "uruguaya", "uruguayo", "uruguayan"]],
  ["EC", "ECU", ["ecuador", "ecuatoriana", "ecuatoriano", "ecuadorian"]],
  ["CU", "CUB", ["cuba", "cubana", "cubano", "cuban"]],
  ["DO", "DOM", ["republica dominicana", "dominican republic", "dominicana", "dominicano", "dominican"]],
  ["HU", "HUN", ["hungria", "hungary", "hungara", "hungaro", "hungarian"]],
  ["LU", "LUX", ["luxemburgo", "luxembourg", "luxemburguesa", "luxemburgues"]],
  ["AD", "AND", ["andorra", "andorrana", "andorrano", "andorran"]],
  ["DZ", "DZA", ["argelia", "algeria", "argelina", "argelino", "algerian"]],
  ["EG", "EGY", ["egipto", "egypt", "egipcia", "egipcio", "egyptian"]],
  ["ZA", "ZAF", ["sudafrica", "south africa", "sudafricana", "sudafricano", "south african"]],
  ["NZ", "NZL", ["nueva zelanda", "new zealand", "neozelandesa", "neozelandes"]],
  ["AE", "ARE", ["emiratos arabes unidos", "united arab emirates", "emiratos", "uae"]],
  ["SA", "SAU", ["arabia saudi", "arabia saudita", "saudi arabia", "saudi"]],
  ["BG", "BGR", ["bulgaria", "bulgara", "bulgaro", "bulgarian"]],
  ["HR", "HRV", ["croacia", "croatia", "croata", "croatian"]],
  ["SK", "SVK", ["eslovaquia", "slovakia", "eslovaca", "eslovaco", "slovak"]],
  ["SI", "SVN", ["eslovenia", "slovenia", "eslovena", "esloveno", "slovenian"]],
  ["LT", "LTU", ["lituania", "lithuania", "lituana", "lituano", "lithuanian"]],
  ["LV", "LVA", ["letonia", "latvia", "letona", "leton", "latvian"]],
  ["EE", "EST", ["estonia", "estonian"]],
  ["IS", "ISL", ["islandia", "iceland", "islandesa", "islandes", "icelandic"]],
  ["MT", "MLT", ["malta", "maltesa", "maltes", "maltese"]],
  ["CY", "CYP", ["chipre", "cyprus", "chipriota", "cypriot"]],
  ["PH", "PHL", ["filipinas", "philippines", "filipina", "filipino"]],
  ["TH", "THA", ["tailandia", "thailand", "tailandesa", "tailandes", "thai"]],
  ["SG", "SGP", ["singapur", "singapore"]],
  ["ID", "IDN", ["indonesia", "indonesian"]],
  ["VN", "VNM", ["vietnam", "vietnamita", "vietnamese"]],
  ["TW", "TWN", ["taiwan", "taiwanesa", "taiwanes"]],
  ["HK", "HKG", ["hong kong"]]
];

const COUNTRY_BY_ALPHA2 = new Map<string, string>();
const COUNTRY_BY_ALPHA3 = new Set<string>();
const COUNTRY_BY_ALIAS = new Map<string, string>();
for (const [alpha2, alpha3, aliases] of RESERVATION_IMPORT_COUNTRIES) {
  COUNTRY_BY_ALPHA2.set(alpha2, alpha3);
  COUNTRY_BY_ALPHA3.add(alpha3);
  for (const alias of aliases) {
    if (!COUNTRY_BY_ALIAS.has(alias)) COUNTRY_BY_ALIAS.set(alias, alpha3);
  }
}
COUNTRY_BY_ALPHA2.set("UK", "GBR");

/**
 * Nacionalidad → ISO alfa-3: alfa-3 tal cual (mayúsculas), alfa-2 → tabla («UK» →
 * GBR), nombre o gentilicio ES/EN → tabla; vacío o desconocido → null.
 */
export function normalizeNationality(raw: unknown): string | null {
  const folded = foldLabel(raw).replace(/\./g, "").trim();
  if (folded === "") return null;
  if (/^[a-z]{3}$/.test(folded)) {
    const upper = folded.toUpperCase();
    if (COUNTRY_BY_ALPHA3.has(upper)) return upper;
    const alias = COUNTRY_BY_ALIAS.get(folded);
    return alias ?? upper;
  }
  if (/^[a-z]{2}$/.test(folded)) return COUNTRY_BY_ALPHA2.get(folded.toUpperCase()) ?? null;
  return COUNTRY_BY_ALIAS.get(folded) ?? COUNTRY_BY_ALIAS.get(folded.replace(/\s+/g, " ")) ?? null;
}

// ---------------------------------------------------------------------------
// Sinónimos de tipo de habitación (copia de reservation-agent.service.ts:215-243)
// ---------------------------------------------------------------------------

/** Grupos de sinónimos ES/EN para resolver un tipo por nombre («Doble» ≈ «Double»). */
export const ROOM_TYPE_SYNONYMS: ReadonlyArray<readonly string[]> = [
  ["double", "doble"],
  ["single", "individual", "sencilla"],
  ["twin"],
  ["triple"],
  ["suite"],
  ["junior"],
  ["family", "familiar"],
  ["apartment", "apartamento", "studio", "estudio"],
  ["deluxe"],
  ["superior"],
  ["standard", "estandar", "estándar"]
];

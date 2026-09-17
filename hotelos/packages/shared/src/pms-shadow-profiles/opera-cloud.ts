/**
 * Perfil de mapeo «OPERA Cloud» preinstalado (Tanda 7b · L0, diseño §3, §4.1, §4.2 y
 * §6.2). SOLO lo confirmado en la documentación oficial de Oracle [V]:
 *   · export `RESPONSYS_RESV_AUTO` (33 columnas, próximos 30 días de llegadas, CSV):
 *     `OC/25.5/ocsuh/t_exports_responsys_general_reservation_exports.htm`;
 *   · informe «Departures» `departure_all` (19 columnas, agrupado por fecha):
 *     `OC/26.2/ocsuh/c_reports_departure_report_departure_all.htm`.
 * Los informes cuyas columnas Oracle NO publica en Cloud (`res_detail`, `gibyroom`,
 * `resreservyesterday`, `rescancel`, `nanoshow`, `GENERIC_*`) quedan como huecos
 * documentados (`feeds.inhouse` y `feeds.changes` = undefined) hasta recibir una
 * salida real de Faranda (§7.2 paso 5); entonces se añaden con un test de contrato
 * que fije la cabecera recibida (OPERA_FEED_COLUMNS_CHANGED si cambia).
 *
 * Claves de los diccionarios (estados, canales, segmentos, métodos de pago): literal
 * OPERA plegado como `foldValue` (minúsculas, sin diacríticos, `[^a-z0-9]+` → «_»).
 * Las claves del `mapping` de cada feed son las cabeceras LITERALES del fichero.
 * Sin dependencias de runtime.
 */

import type { PmsShadowFeedProfile, PmsShadowProfileDefinition, PmsShadowStatusMap } from "../pms-shadow-types.js";

// ---------------------------------------------------------------------------
// Export RESPONSYS_RESV_AUTO (feed `arrivals`) [V]
// ---------------------------------------------------------------------------

/** Las 33 columnas del export `RESPONSYS_RESV_AUTO`, en el orden documentado por Oracle [V]. */
export const OPERA_CLOUD_RESPONSYS_HEADER = [
  "RESERVATION_ID",
  "GUEST_LAST_NAME",
  "GUEST_FIRST_NAME",
  "GUEST_MIDDLE_NAME",
  "TRAVEL_AGENT_NAME",
  "COMPANY_NAME",
  "BOOKING_SOURCE",
  "PROPERTY_NAME",
  "ARRIVAL_DATE",
  "DEPARTURE_DATE",
  "NUM_NIGHTS",
  "NUM_ADULTS",
  "NUM_CHILDREN",
  "NUM_ROOMS",
  "ROOM_TYPE",
  "ROOM_TYPE_TO_CHARGE",
  "ROOM_NUMBER",
  "RATE",
  "BLOCK_CODE",
  "RESERVATION_TYPE",
  "PAYMENT_TYPE",
  "NAME_ON_CARD",
  "DISCOUNT_AMOUNT",
  "DISCOUNT_PERCENTAGE",
  "DISCOUNT_REASON",
  "SPECIAL_REQUESTS",
  "PROMOTION",
  "ROOM_PREFERENCES",
  "OTHER_PREFERENCES",
  "SHARED_ROOM",
  "RATE_CODE",
  "PARENT_BLOCK",
  "RESERVATION_STATUS"
] as const;
export type OperaCloudResponsysColumn = (typeof OPERA_CLOUD_RESPONSYS_HEADER)[number];

/**
 * Columna → campo canónico de la Tanda 7. `null` = ignorada por diseño.
 *   · `RESERVATION_ID` ES el nº de confirmación (no el id interno) [V] → `referencia_externa`.
 *   · `RATE` = tarifa de la PRIMERA noche [V]: no se mapea a `tarifa` (eso es `RATE_CODE`);
 *     L1 la usa para estimar `importe_total` = RATE × noches × habitaciones con aviso
 *     OPERA_TOTAL_ESTIMATED (diseño §6.2) [S].
 *   · `ROOM_NUMBER` puede traer varias habitaciones separadas por coma [V]; L1 toma la primera.
 *   · `NAME_ON_CARD`, `DISCOUNT_*`, `PROMOTION`, `*_PREFERENCES`, `SHARED_ROOM`, `PARENT_BLOCK`
 *     se descartan: PII de tarjeta o datos sin campo destino (§3, §6.2).
 *   · `PROPERTY_NAME` no se mapea: el hotel lo fija el perfil (`operaHotelCode`), no el fichero.
 */
const RESPONSYS_MAPPING: PmsShadowFeedProfile["mapping"] = {
  RESERVATION_ID: "referencia_externa",
  GUEST_LAST_NAME: "apellidos",
  GUEST_FIRST_NAME: "nombre",
  GUEST_MIDDLE_NAME: null,
  TRAVEL_AGENT_NAME: "agencia",
  COMPANY_NAME: "empresa",
  BOOKING_SOURCE: "canal",
  PROPERTY_NAME: null,
  ARRIVAL_DATE: "llegada",
  DEPARTURE_DATE: "salida",
  NUM_NIGHTS: "noches",
  NUM_ADULTS: "adultos",
  NUM_CHILDREN: "ninos",
  NUM_ROOMS: "habitaciones",
  ROOM_TYPE: "tipo_habitacion",
  ROOM_TYPE_TO_CHARGE: null,
  ROOM_NUMBER: "habitacion",
  RATE: null,
  BLOCK_CODE: "grupo",
  RESERVATION_TYPE: null,
  PAYMENT_TYPE: "metodo_pago",
  NAME_ON_CARD: null,
  DISCOUNT_AMOUNT: null,
  DISCOUNT_PERCENTAGE: null,
  DISCOUNT_REASON: null,
  SPECIAL_REQUESTS: "peticiones",
  PROMOTION: null,
  ROOM_PREFERENCES: null,
  OTHER_PREFERENCES: null,
  SHARED_ROOM: null,
  RATE_CODE: "tarifa",
  PARENT_BLOCK: null,
  RESERVATION_STATUS: "estado"
};

// ---------------------------------------------------------------------------
// Informe departure_all (feed `departures`) [V]
// ---------------------------------------------------------------------------

/** Las 19 columnas del informe «Departures» (`departure_all`), en el orden documentado [V]. */
export const OPERA_CLOUD_DEPARTURE_ALL_HEADER = [
  "Room No.",
  "Name",
  "Company",
  "Travel Agent",
  "Group",
  "VIP Code",
  "Arr. Date",
  "Dep. Date",
  "Adl.",
  "Chl.",
  "Rms",
  "Nts",
  "Room Type",
  "Block Code",
  "Rate Code",
  "Res. Status",
  "Dep. Time",
  "Pay Mth",
  "Balance"
] as const;
export type OperaCloudDepartureAllColumn = (typeof OPERA_CLOUD_DEPARTURE_ALL_HEADER)[number];

/**
 * Columna → campo canónico. «Name» es el nombre completo (activa `splitName` de la
 * Tanda 7: `name` es sinónimo de nombre completo). «Block Code» no se mapea porque
 * «Group» ya va a `grupo`; «Dep. Time» y «Balance» no tienen campo destino (el saldo
 * vive en OPERA). El informe NO trae nº de confirmación: L1 solo puede casarlo con un
 * enlace existente por (habitación, llegada, salida) y usarlo para la transición a
 * check-out; nunca crea reservas desde este feed [S, diseño §5.3].
 */
const DEPARTURE_ALL_MAPPING: PmsShadowFeedProfile["mapping"] = {
  "Room No.": "habitacion",
  Name: "nombre",
  Company: "empresa",
  "Travel Agent": "agencia",
  Group: "grupo",
  "VIP Code": "vip",
  "Arr. Date": "llegada",
  "Dep. Date": "salida",
  "Adl.": "adultos",
  "Chl.": "ninos",
  Rms: "habitaciones",
  Nts: "noches",
  "Room Type": "tipo_habitacion",
  "Block Code": null,
  "Rate Code": "tarifa",
  "Res. Status": "estado",
  "Dep. Time": null,
  "Pay Mth": "metodo_pago",
  Balance: null
};

// ---------------------------------------------------------------------------
// Columnas ignoradas por diseño (para tests, el panel y los ficheros de ejemplo de L6)
// ---------------------------------------------------------------------------

/** Columnas que el perfil descarta a propósito, por feed (= claves con `null` en el mapeo). */
export const OPERA_CLOUD_IGNORED_COLUMNS: Readonly<Record<"arrivals" | "departures", readonly string[]>> = Object.freeze({
  /** PII de tarjeta (`NAME_ON_CARD`), descuentos, promoción, preferencias, compartida, bloque padre, tipo de cargo, tipo de reserva (garantía), nombre del hotel, segundo nombre y `RATE` (solo primera noche). */
  arrivals: [
    "GUEST_MIDDLE_NAME",
    "PROPERTY_NAME",
    "ROOM_TYPE_TO_CHARGE",
    "RATE",
    "RESERVATION_TYPE",
    "NAME_ON_CARD",
    "DISCOUNT_AMOUNT",
    "DISCOUNT_PERCENTAGE",
    "DISCOUNT_REASON",
    "PROMOTION",
    "ROOM_PREFERENCES",
    "OTHER_PREFERENCES",
    "SHARED_ROOM",
    "PARENT_BLOCK"
  ],
  /** «Block Code» (Group ya va a `grupo`), «Dep. Time» y «Balance» (el saldo vive en OPERA). */
  departures: ["Block Code", "Dep. Time", "Balance"]
});

// ---------------------------------------------------------------------------
// Estados (diseño §4.1) [V literales; S equivalencias marcadas]
// ---------------------------------------------------------------------------

/**
 * Literal OPERA plegado → estado destino. Cubre las grafías de informes («Res. Status»),
 * exports (`RESERVATION_STATUS`), el enum síncrono `pMS_ResStatusType` (Reserved,
 * Requested, NoShow, Cancelled, InHouse, CheckedOut, Waitlisted, DueIn, DueOut, Walkin,
 * PendingCheckout), el enum del async `database_ResStatusType` (RESERVED, REQUESTED,
 * NO SHOW, CANCELLED, IN HOUSE, CHECKED IN, CHECKED OUT, WAITLIST, DUE IN, DUE OUT,
 * WALKIN, PENDING CHECKOUT, PROSPECT) y los literales de Business Events / guía RMS
 * («Confirmed», «Checked In», «Checked Out», «No Show», «Canceled»).
 *   · Prospect (non-deduct) y Requested → `confirmed` con aviso TENTATIVE_AS_CONFIRMED
 *     (equivalencia Requested ≡ Prospect [S]).
 *   · Walkin y PendingCheckout → `checked_in` (semántica no documentada en la spec [S]).
 *   · Waitlist → `skip` (sin equivalente; aviso OPERA_WAITLIST_SKIPPED [S]).
 * Regla: mapear por el estado REAL (`reservationStatus` / `resvStatus`), nunca por
 * `computedReservationStatus`.
 */
export const OPERA_CLOUD_STATUS_MAP: PmsShadowStatusMap = Object.freeze({
  // → confirmed
  reserved: "confirmed",
  confirmed: "confirmed",
  due_in: "confirmed",
  duein: "confirmed",
  prospect: "confirmed",
  requested: "confirmed",
  // → checked_in
  checked_in: "checked_in",
  in_house: "checked_in",
  inhouse: "checked_in",
  due_out: "checked_in",
  dueout: "checked_in",
  pendingcheckout: "checked_in",
  pending_checkout: "checked_in",
  walkin: "checked_in",
  // → checked_out
  checked_out: "checked_out",
  checkedout: "checked_out",
  // → cancelled
  cancelled: "cancelled",
  canceled: "cancelled",
  // → no_show
  no_show: "no_show",
  noshow: "no_show",
  // → skip (waitlist)
  waitlist: "skip",
  waitlisted: "skip"
});

// ---------------------------------------------------------------------------
// Perfil completo
// ---------------------------------------------------------------------------

/**
 * Perfil «OPERA Cloud». Los diccionarios de canal, segmento y método de pago llevan
 * los EJEMPLOS de §4.2 [S]: cada hotel completa los suyos en `PmsShadowProfile.mappingJson`
 * (sourceCodes / marketCodes / paymentTypes) con sus listados de configuración (§7.4);
 * un código sin entrada → valor plegado + aviso (regla de la Tanda 7).
 */
export const OPERA_CLOUD_PROFILE: PmsShadowProfileDefinition = Object.freeze({
  system: "opera_cloud",
  feeds: Object.freeze({
    /** Export RESPONSYS_RESV_AUTO: fechas con máscara `YYYYMMDD` (Column Format del export) [V]. */
    arrivals: Object.freeze({
      mapping: RESPONSYS_MAPPING,
      dateOrder: "ymd",
      ignoredColumns: [...OPERA_CLOUD_IGNORED_COLUMNS.arrivals]
    }) as PmsShadowFeedProfile,
    /** Pendiente de muestra real (§7.2 paso 5): columnas de `gibyroom` no publicadas en Cloud. */
    inhouse: undefined,
    /** Informe departure_all en Delimited Data: sin fila de cabecera [S] → `headerless`; fechas DD/MM/YY[YY] [S]. */
    departures: Object.freeze({
      mapping: DEPARTURE_ALL_MAPPING,
      headerless: [...OPERA_CLOUD_DEPARTURE_ALL_HEADER],
      dateOrder: "dmy",
      ignoredColumns: [...OPERA_CLOUD_IGNORED_COLUMNS.departures]
    }) as PmsShadowFeedProfile,
    /** Pendiente de muestra real (§7.2 paso 5): columnas de `resreservyesterday`, `rescancel` y `nanoshow` no publicadas en Cloud. */
    changes: undefined
  }),
  statusMap: OPERA_CLOUD_STATUS_MAP,
  /** Source / booking source plegado → canal canónico (RESERVATION_IMPORT_CHANNELS) [S ejemplos §4.2]. */
  channelMap: Object.freeze({
    bdc: "booking_com",
    booking: "booking_com",
    exp: "expedia",
    web: "direct",
    be: "direct",
    ta: "agency"
  }),
  /** Market code plegado → segmento canónico (RESERVATION_IMPORT_SEGMENTS) [S ejemplos §4.2]. */
  marketSegmentMap: Object.freeze({
    fit: "leisure",
    ind: "leisure",
    corp: "corporate",
    grp: "group"
  }),
  /** Payment type plegado → método canónico (RESERVATION_IMPORT_PAYMENT_METHODS) [S ejemplos §4.2]. `NAME_ON_CARD` nunca se lee. */
  paymentMethodMap: Object.freeze({
    ca: "cash",
    vi: "credit_card",
    mc: "credit_card",
    ax: "credit_card",
    cl: "company_invoice",
    ar: "company_invoice"
  })
});

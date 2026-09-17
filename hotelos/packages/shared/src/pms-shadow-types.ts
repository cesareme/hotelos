/**
 * OPERA Cloud · modo sombra (Tanda 7b · L0, 2026-09-17): contrato wire entre el API
 * (`apps/api/src/modules/pms-shadow/*`, el modo `sync` del importador de reservas de
 * la Tanda 7, el CLI `pms-shadow:pull`, el job del líder y el conector de correo con
 * propósito `pms_shadow`) y el admin-web (Configuración › Integraciones › Modo sombra).
 *
 * Qué es. OPERA Cloud sigue siendo el sistema de registro del hotel; Anfitorio recibe
 * cada día un corte (feed) de reservas, los ingresos del día por transaction code y,
 * con menos frecuencia, perfiles y estadísticas; nunca escribe en OPERA y ante
 * conflicto gana OPERA. Cada fichero recibido es un `PmsShadowRun`; cada reserva
 * conocida tiene un `PmsShadowLink` (clave natural: propiedad + nº de confirmación);
 * cada día de ingresos es un `PmsShadowRevenueImport` con su asiento; cada desviación
 * es una `PmsShadowAlert` que se resuelve en el panel con motivo.
 *
 * Convenciones (docs/design/OPERA-CLOUD-MODO-SOMBRA.md §5, §6):
 *   · GDPR: los ficheros no se guardan; los registros, alertas y JSON citan nº de
 *     confirmación, códigos OPERA, métricas e importes, nunca nombre, e-mail,
 *     teléfono ni documento del huésped. `NAME_ON_CARD` no se lee jamás.
 *   · Dinero como `MoneyString` ("1234.56", dos decimales, punto): el API calcula con
 *     Prisma.Decimal y nunca expone floats; el front solo formatea.
 *   · Fechas de negocio como `IsoDate` ("YYYY-MM-DD"); instantes (`…At`) como ISO.
 *   · Los estados de las tablas son texto con catálogo aquí (sin enums Prisma nuevos).
 *   · Claves de los diccionarios del perfil (estados, canales, segmentos, métodos de
 *     pago) = literal OPERA PLEGADO como `foldValue` de reservation-import.mapping.ts:
 *     minúsculas, sin diacríticos, `[^a-z0-9]+` → «_», sin «_» inicial ni final.
 *
 * Sin dependencias de runtime; los imports son solo de tipo.
 */

import type { JournalSourceType } from "./accounting-types.js";
import type { IsoDate, MoneyString } from "./financial-statements-types.js";
import type { ReservationImportField } from "./reservation-import-types.js";

// ---------------------------------------------------------------------------
// Sistemas, feeds y orígenes (diseño §1, §3, §6.1)
// ---------------------------------------------------------------------------

/** Sistemas de registro admitidos en modo sombra (`PmsShadowProfile.system`). */
export const PMS_SHADOW_SYSTEMS = ["opera_cloud"] as const;
export type PmsShadowSystem = (typeof PMS_SHADOW_SYSTEMS)[number];

export const PMS_SHADOW_SYSTEM_LABELS_ES: Readonly<Record<PmsShadowSystem, string>> = Object.freeze({
  opera_cloud: "Oracle OPERA Cloud"
});

/**
 * Feeds (cortes) que puede recibir una propiedad (`PmsShadowRun.feed`): los cuatro
 * primeros van al importador de reservas en modo `sync`; `revenue` al importador de
 * ingresos diarios; `profiles` y `stats` (Manager Report / Trial Balance /
 * GEN_XMLBO_STATISTICS) alimentan perfiles y reconciliación; `ohip_delta` es el ciclo
 * async `dailySummary` de la vía C (fase 2).
 */
export const PMS_SHADOW_FEEDS = ["arrivals", "inhouse", "departures", "changes", "revenue", "profiles", "stats", "ohip_delta"] as const;
export type PmsShadowFeed = (typeof PMS_SHADOW_FEEDS)[number];

export const PMS_SHADOW_FEED_LABELS_ES: Readonly<Record<PmsShadowFeed, string>> = Object.freeze({
  arrivals: "Llegadas (hoy y próximos 30 días)",
  inhouse: "En casa",
  departures: "Salidas del día",
  changes: "Nuevas, canceladas y no-show de ayer",
  revenue: "Ingresos del día por transaction code",
  profiles: "Perfiles de huésped",
  stats: "Estadísticas y cuadre (Manager Report / Trial Balance)",
  ohip_delta: "Delta OHIP (dailySummary)"
});

/** Feeds que el modo `sync` del importador de reservas procesa (snapshot de reservas). */
export const PMS_SHADOW_RESERVATION_FEEDS = ["arrivals", "inhouse", "departures", "changes"] as const satisfies readonly PmsShadowFeed[];
export type PmsShadowReservationFeed = (typeof PMS_SHADOW_RESERVATION_FEEDS)[number];

/** Por dónde llegó el corte (`PmsShadowRun.source`). */
export const PMS_SHADOW_RUN_SOURCES = ["email", "sftp", "api_key", "manual", "ohip", "cli"] as const;
export type PmsShadowRunSource = (typeof PMS_SHADOW_RUN_SOURCES)[number];

export const PMS_SHADOW_RUN_SOURCE_LABELS_ES: Readonly<Record<PmsShadowRunSource, string>> = Object.freeze({
  email: "Correo (Report Scheduler)",
  sftp: "SFTP (Exports)",
  api_key: "Clave de API (ingest)",
  manual: "Subida manual",
  ohip: "OHIP (REST)",
  cli: "CLI pms-shadow:pull"
});

/**
 * Estado del corte (`PmsShadowRun.status`). `received` queda reservado para un run
 * registrado y aún no procesado; el ingest procesa en línea y crea el run ya en
 * `processing` → `done` (0 errores) | `partial` (algo creado y algo con error) |
 * `failed` (nada aplicado).
 */
export const PMS_SHADOW_RUN_STATUSES = ["received", "processing", "done", "partial", "failed"] as const;
export type PmsShadowRunStatus = (typeof PMS_SHADOW_RUN_STATUSES)[number];

export const PMS_SHADOW_RUN_STATUS_LABELS_ES: Readonly<Record<PmsShadowRunStatus, string>> = Object.freeze({
  received: "Recibido",
  processing: "En proceso",
  done: "Procesado",
  partial: "Parcial",
  failed: "Fallido"
});

/** Estado del perfil (`PmsShadowProfile.status`): en pausa no se ingiere ni se vigila la puntualidad de los feeds. */
export const PMS_SHADOW_PROFILE_STATUSES = ["active", "paused"] as const;
export type PmsShadowProfileStatus = (typeof PMS_SHADOW_PROFILE_STATUSES)[number];

export const PMS_SHADOW_PROFILE_STATUS_LABELS_ES: Readonly<Record<PmsShadowProfileStatus, string>> = Object.freeze({
  active: "Activo",
  paused: "En pausa"
});

// ---------------------------------------------------------------------------
// Alertas (diseño §5.5, §6.5)
// ---------------------------------------------------------------------------

export const PMS_SHADOW_ALERT_SEVERITIES = ["info", "warning", "error"] as const;
export type PmsShadowAlertSeverity = (typeof PMS_SHADOW_ALERT_SEVERITIES)[number];

export const PMS_SHADOW_ALERT_SEVERITY_LABELS_ES: Readonly<Record<PmsShadowAlertSeverity, string>> = Object.freeze({
  info: "Información",
  warning: "Aviso",
  error: "Error"
});

/** Códigos de alerta (`PmsShadowAlert.code`, `PmsShadowRunAlert.code`): los 10 de §5.5 más el fichero no reconocido de §6.5. */
export const PMS_SHADOW_ALERT_CODES = [
  /** Reserva conocida, en ventana, ausente del snapshot y sin fila en cancelaciones / no-show (§5.2): no se cancela sola. */
  "OPERA_MISSING_IN_SNAPSHOT",
  /** El nº de confirmación coincide con una reserva creada en Anfitorio por otra vía (sin bookingSource opera:*): fila omitida. */
  "OPERA_CONFLICT_LOCAL_RESERVATION",
  /** OPERA la tiene en casa pero `ROOM_NUMBER` / «Room No.» no resuelve a una habitación válida: permanece confirmada. */
  "OPERA_CHECKIN_WITHOUT_ROOM",
  /** Transaction code sin entrada en `trxMappingJson`: el día de ingresos queda bloqueado hasta mapearlo. */
  "OPERA_TRX_CODE_UNMAPPED",
  /** Room type OPERA sin entrada en `mappingJson.roomTypes` (y no pseudo): la fila no se crea. */
  "OPERA_ROOM_TYPE_UNMAPPED",
  /** Rate code OPERA sin entrada en `mappingJson.rateCodes`: se aplica la tarifa BAR por defecto. */
  "OPERA_RATE_CODE_UNMAPPED",
  /** Conteos del día (llegadas, salidas, ocupadas, no-shows) distintos de los declarados por OPERA. */
  "OPERA_RECON_COUNT_MISMATCH",
  /** Σ ingresos / impuestos del día fuera de tolerancia frente al Trial Balance o al Manager Report. */
  "OPERA_RECON_REVENUE_MISMATCH",
  /** Feed programado sin fichero a la hora prevista + PMS_SHADOW_FEED_LATE_GRACE_MINUTES. */
  "OPERA_FEED_LATE",
  /** La cabecera recibida no coincide con la del perfil (columnas añadidas, quitadas o renombradas). */
  "OPERA_FEED_COLUMNS_CHANGED",
  /** Correo o fichero sin feed reconocible por nombre ni por cabecera (§6.5). */
  "OPERA_FEED_UNRECOGNIZED"
] as const;
export type PmsShadowAlertCode = (typeof PMS_SHADOW_ALERT_CODES)[number];

/** Severidad fija por código: `error` bloquea o exige acción; `warning` informa de una desviación que el corte ya trató. */
export const PMS_SHADOW_ALERT_SEVERITY: Readonly<Record<PmsShadowAlertCode, PmsShadowAlertSeverity>> = Object.freeze({
  OPERA_MISSING_IN_SNAPSHOT: "warning",
  OPERA_CONFLICT_LOCAL_RESERVATION: "warning",
  OPERA_CHECKIN_WITHOUT_ROOM: "warning",
  OPERA_TRX_CODE_UNMAPPED: "error",
  OPERA_ROOM_TYPE_UNMAPPED: "error",
  OPERA_RATE_CODE_UNMAPPED: "warning",
  OPERA_RECON_COUNT_MISMATCH: "error",
  OPERA_RECON_REVENUE_MISMATCH: "error",
  OPERA_FEED_LATE: "warning",
  OPERA_FEED_COLUMNS_CHANGED: "error",
  OPERA_FEED_UNRECOGNIZED: "warning"
});

export const PMS_SHADOW_ALERT_LABELS_ES: Readonly<Record<PmsShadowAlertCode, string>> = Object.freeze({
  OPERA_MISSING_IN_SNAPSHOT: "Reserva ausente del corte de OPERA",
  OPERA_CONFLICT_LOCAL_RESERVATION: "Conflicto con una reserva creada en Anfitorio",
  OPERA_CHECKIN_WITHOUT_ROOM: "Check-in en OPERA sin habitación válida",
  OPERA_TRX_CODE_UNMAPPED: "Transaction code sin mapear",
  OPERA_ROOM_TYPE_UNMAPPED: "Tipo de habitación de OPERA sin mapear",
  OPERA_RATE_CODE_UNMAPPED: "Rate code de OPERA sin mapear",
  OPERA_RECON_COUNT_MISMATCH: "Los conteos del día no cuadran con OPERA",
  OPERA_RECON_REVENUE_MISMATCH: "Los ingresos del día no cuadran con OPERA",
  OPERA_FEED_LATE: "Corte de OPERA no recibido a la hora prevista",
  OPERA_FEED_COLUMNS_CHANGED: "La cabecera del informe ha cambiado",
  OPERA_FEED_UNRECOGNIZED: "Fichero o correo sin corte reconocible"
});

// ---------------------------------------------------------------------------
// Ingresos diarios (diseño §4.3, §6.4)
// ---------------------------------------------------------------------------

/** Formato del fichero de ingresos (`PmsShadowRevenueImport.source`). */
export const PMS_SHADOW_REVENUE_SOURCES = ["xml_revenue", "findeptcodes_xml", "findeptcodes_csv", "responsys_trx"] as const;
export type PmsShadowRevenueSource = (typeof PMS_SHADOW_REVENUE_SOURCES)[number];

export const PMS_SHADOW_REVENUE_SOURCE_LABELS_ES: Readonly<Record<PmsShadowRevenueSource, string>> = Object.freeze({
  xml_revenue: "XML GEN_XMLBO_REVENUE (export Back Office)",
  findeptcodes_xml: "Informe findeptcodes (XML)",
  findeptcodes_csv: "Informe findeptcodes (Delimited Data)",
  responsys_trx: "Export RESPONSYS_TRX (CSV)"
});

/** Estado del lote de ingresos (`PmsShadowRevenueImport.status`): previsualizado → contabilizado → revertido. */
export const PMS_SHADOW_REVENUE_STATUSES = ["draft", "posted", "reversed"] as const;
export type PmsShadowRevenueStatus = (typeof PMS_SHADOW_REVENUE_STATUSES)[number];

export const PMS_SHADOW_REVENUE_STATUS_LABELS_ES: Readonly<Record<PmsShadowRevenueStatus, string>> = Object.freeze({
  draft: "Previsualizado",
  posted: "Contabilizado",
  reversed: "Revertido"
});

/**
 * Naturaleza contable de un transaction code (`PmsShadowTrxCodeMapping.kind`):
 * `revenue` → H 705.x, `tax` → H 477.x, `payment` → D 57x / H 4300, `ignore` → se
 * lista en la previsualización sin asiento (paid out, non-revenue, internal, package).
 */
export const PMS_SHADOW_TRX_KINDS = ["revenue", "tax", "payment", "ignore"] as const;
export type PmsShadowTrxKind = (typeof PMS_SHADOW_TRX_KINDS)[number];

export const PMS_SHADOW_TRX_KIND_LABELS_ES: Readonly<Record<PmsShadowTrxKind, string>> = Object.freeze({
  revenue: "Ingreso",
  tax: "Impuesto repercutido",
  payment: "Cobro",
  ignore: "Sin asiento"
});

/**
 * Departamentos USALI que admiten la línea `revenue` (chart-of-accounts.service.ts
 * USALI_DEPARTMENT_LINES): los únicos válidos para un transaction code de ingreso.
 */
export const PMS_SHADOW_USALI_REVENUE_DEPARTMENTS = ["rooms", "fnb", "other_operated", "misc_income"] as const;
export type PmsShadowUsaliRevenueDepartment = (typeof PMS_SHADOW_USALI_REVENUE_DEPARTMENTS)[number];

export const PMS_SHADOW_USALI_REVENUE_DEPARTMENT_LABELS_ES: Readonly<Record<PmsShadowUsaliRevenueDepartment, string>> = Object.freeze({
  rooms: "Habitaciones",
  fnb: "Alimentos y bebidas",
  other_operated: "Otros departamentos operativos",
  misc_income: "Ingresos diversos"
});

/** Entrada de `PmsShadowProfile.trxMappingJson`: un transaction code de OPERA → cómo se contabiliza. */
export type PmsShadowTrxCodeMapping = {
  /** Transaction code tal como aparece en el fichero (p. ej. "1000"). */
  code: string;
  /** Descripción OPERA (informativa; se copia a la línea del asiento «<code> · <description>»). */
  description?: string;
  /** Transaction Type OPERA (Lodging, Food and Beverage, Tax, Payment…), informativo. */
  transactionType?: string;
  kind: PmsShadowTrxKind;
  /** Cuenta PGC de la línea: 705.1 / 705.2 / 705.3 (ingreso), 477.10 / 477.21 (impuesto), 570 / 572 / 5721 / 5722 (cobro). Obligatoria salvo `ignore`. */
  accountCode?: string;
  /** Departamento USALI de la línea de ingreso (solo `revenue`). */
  usaliDepartment?: PmsShadowUsaliRevenueDepartment;
  /** Código de tipo impositivo (solo `tax`), informativo para el cuadre por tipo. */
  taxRateCode?: string;
};

/** `PmsShadowProfile.mappingJson`: códigos maestros OPERA → códigos Anfitorio de la propiedad (diseño §4.2). */
export type PmsShadowPropertyMapping = {
  /** Room type OPERA → `RoomType.code`. */
  roomTypes?: Record<string, string>;
  /** Rate code OPERA → `RatePlan.code`. */
  rateCodes?: Record<string, string>;
  /** Market code OPERA → `Reservation.marketSegment` (segmento canónico de la Tanda 7). */
  marketCodes?: Record<string, string>;
  /** Source code OPERA → `Reservation.channel` (canal canónico de la Tanda 7). */
  sourceCodes?: Record<string, string>;
  /** Payment type OPERA → `Reservation.paymentMethod` (método canónico de la Tanda 7). */
  paymentTypes?: Record<string, string>;
  /** Pseudo rooms (PM, HOUSE…): no son inventario; sus filas se omiten con aviso. */
  pseudoRoomTypes?: string[];
};

/** Feed esperado en `PmsShadowProfile.scheduleJson.feeds[]`. */
export type PmsShadowScheduleFeed = {
  feed: PmsShadowFeed;
  /** Hora local del hotel "HH:mm" a la que debería haber llegado el fichero. */
  expectedTime: string;
  /** Business date que trae el fichero respecto al día natural de la entrega: -1 (tras el night audit) | 0. */
  businessDateOffset: -1 | 0;
  /** Sin fichero a la hora + gracia → OPERA_FEED_LATE (solo los required). */
  required: boolean;
};

export type PmsShadowSchedule = {
  feeds: PmsShadowScheduleFeed[];
};

// ---------------------------------------------------------------------------
// Modo `sync` del importador de reservas (diseño §4.1, §5, §6.2, §6.3)
// ---------------------------------------------------------------------------

/**
 * Estado destino de una fila sincronizada (`PmsShadowLink.lastStatus`): los cinco
 * estados vivos de `ReservationStatus` (nunca `draft`) más `skip` (waitlist: sin
 * equivalente, fila omitida con aviso).
 */
export const RESERVATION_SYNC_TARGET_STATUSES = ["confirmed", "checked_in", "checked_out", "cancelled", "no_show", "skip"] as const;
export type ReservationSyncTargetStatus = (typeof RESERVATION_SYNC_TARGET_STATUSES)[number];

export const RESERVATION_SYNC_TARGET_STATUS_LABELS_ES: Readonly<Record<ReservationSyncTargetStatus, string>> = Object.freeze({
  confirmed: "Confirmada",
  checked_in: "En casa (check-in)",
  checked_out: "Salida (check-out)",
  cancelled: "Cancelada",
  no_show: "No-show",
  skip: "Omitida (sin equivalente)"
});

/** Literal OPERA de estado PLEGADO (`foldValue`) → estado destino. */
export type PmsShadowStatusMap = Record<string, ReservationSyncTargetStatus>;

/** Orden de los componentes de una fecha en el fichero (regla explícita del perfil; el parser de la Tanda 7 la respeta). */
export const PMS_SHADOW_DATE_ORDERS = ["dmy", "ymd", "mdy"] as const;
export type PmsShadowDateOrder = (typeof PMS_SHADOW_DATE_ORDERS)[number];

/** Perfil de un feed de reservas: cómo se lee un informe / export concreto de OPERA. */
export type PmsShadowFeedProfile = {
  /** Cabecera LITERAL del export o informe → campo canónico de la Tanda 7 (`null` = columna ignorada por diseño). */
  mapping: Record<string, ReservationImportField | null>;
  /** Cabecera sintética, en orden, cuando el «Delimited Data» no trae fila de cabecera [S]. */
  headerless?: string[];
  dateOrder: PmsShadowDateOrder;
  /** Columnas que el perfil descarta a propósito (PII de tarjeta, descuentos, preferencias…). */
  ignoredColumns: string[];
};

/** Perfil preinstalado de un sistema (`packages/shared/src/pms-shadow-profiles/*`). */
export type PmsShadowProfileDefinition = {
  system: PmsShadowSystem;
  /** Feeds con columnas confirmadas; los pendientes de muestra real quedan `undefined`. */
  feeds: Partial<Record<PmsShadowReservationFeed, PmsShadowFeedProfile>>;
  statusMap: PmsShadowStatusMap;
  /** Source / booking source OPERA plegado → canal canónico de la Tanda 7. */
  channelMap: Record<string, string>;
  /** Market code OPERA plegado → segmento canónico de la Tanda 7. */
  marketSegmentMap: Record<string, string>;
  /** Payment type OPERA plegado → método de pago canónico de la Tanda 7. */
  paymentMethodMap: Record<string, string>;
};

// ---------------------------------------------------------------------------
// DTOs wire (respuestas de las rutas /properties/:propertyId/pms-shadow/*)
// ---------------------------------------------------------------------------

/** `pms_shadow_profiles` tal como lo devuelve el API (JSON ya tipados). */
export type PmsShadowProfileRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  system: PmsShadowSystem;
  operaHotelCode: string;
  status: PmsShadowProfileStatus;
  mapping: PmsShadowPropertyMapping;
  trxMapping: PmsShadowTrxCodeMapping[];
  schedule: PmsShadowSchedule;
  inboxEmail: string | null;
  sftpFolder: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Enlace persistido (`pms_shadow_links`), sin datos personales. */
export type PmsShadowLinkRecord = {
  id: string;
  propertyId: string;
  confirmationNo: string;
  operaReservationId: string | null;
  crsReference: string | null;
  reservationId: string;
  lastStatus: ReservationSyncTargetStatus;
  lastSeenAt: string;
  lastBusinessDate: IsoDate;
  firstImportId: string;
  lastImportId: string | null;
  missingStreak: number;
  operaLastModifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** Elemento de `PmsShadowRun.alertsJson`: alerta emitida por el corte (sin PII). */
export type PmsShadowRunAlert = {
  code: PmsShadowAlertCode;
  severity: PmsShadowAlertSeverity;
  /** Español, sin valores personales. */
  message: string;
  confirmationNo?: string | null;
  /** Datos no personales: métrica, esperado / obtenido, código OPERA, nº de fila… */
  details?: Record<string, unknown>;
};

/** `pms_shadow_runs` tal como lo devuelven el listado, el detalle y el 202 del ingest. */
export type PmsShadowRunRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  feed: PmsShadowFeed;
  source: PmsShadowRunSource;
  businessDate: IsoDate | null;
  fileName: string | null;
  contentHash: string;
  status: PmsShadowRunStatus;
  reservationImportId: string | null;
  revenueImportId: string | null;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  transitionedCount: number;
  skippedCount: number;
  errorCount: number;
  /** `resultJson`: valores declarados por OPERA (stats), cabecera reconocida, totales… */
  result: Record<string, unknown>;
  /** `alertsJson` tipado. */
  alerts: PmsShadowRunAlert[];
  errorMessage: string | null;
  correlationId: string | null;
  createdBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
};

/** `pms_shadow_alerts` tal como lo devuelven el listado y la resolución. */
export type PmsShadowAlertRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  businessDate: IsoDate | null;
  code: PmsShadowAlertCode;
  severity: PmsShadowAlertSeverity;
  message: string;
  expected: Record<string, unknown>;
  actual: Record<string, unknown>;
  runId: string | null;
  confirmationNo: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  createdAt: string;
};

/** Importe por ledger de un transaction code en el XML de Revenue (guest · package · AR · deposit). */
export type PmsShadowRevenueLedgers = {
  guest: MoneyString;
  package: MoneyString;
  ar: MoneyString;
  deposit: MoneyString;
};

/** Línea del lote de ingresos (`linesJson[]`): un transaction code del día, resuelto (o no) por el mapeo. */
export type PmsShadowRevenueLine = {
  code: string;
  description: string;
  /** REVENUE · NON REVENUE · PAYMENT · PAID OUT · PACKAGE · INTERNAL (XML) o el Transaction Type del informe. */
  transactionType: string;
  /** Neto sin impuestos para ingresos (los impuestos van en su propio código); signo «-» explícito en correcciones. */
  amount: MoneyString;
  ledgers?: PmsShadowRevenueLedgers;
  kind?: PmsShadowTrxKind;
  accountCode?: string | null;
  usaliDepartment?: string | null;
  /** false → OPERA_TRX_CODE_UNMAPPED (bloquea la contabilización). */
  mapped: boolean;
};

/** Totales del lote por naturaleza contable. */
export type PmsShadowRevenueTotals = {
  revenue: MoneyString;
  tax: MoneyString;
  payments: MoneyString;
  other: MoneyString;
};

/** Cuadre con el Trial Balance del mismo día (regla de Oracle: Σ total_amount ≡ Transaction Total Today). */
export type PmsShadowRevenueReconciliation = {
  transactionTotalToday?: MoneyString;
  sumTotalAmount: MoneyString;
  delta: MoneyString;
  ok: boolean;
};

/** `pms_shadow_revenue_imports` tal como lo devuelven el listado, el detalle, el post y el reverso. */
export type PmsShadowRevenueImportRecord = {
  id: string;
  organizationId: string;
  propertyId: string;
  businessDate: IsoDate;
  source: PmsShadowRevenueSource;
  fileName: string | null;
  contentHash: string;
  status: PmsShadowRevenueStatus;
  lines: PmsShadowRevenueLine[];
  totals: PmsShadowRevenueTotals;
  journalEntryIds: string[];
  reversalJournalEntryIds: string[];
  reconciliation: PmsShadowRevenueReconciliation | null;
  warnings: string[];
  replacedById: string | null;
  createdBy: string | null;
  createdAt: string;
  postedAt: string | null;
  reversedAt: string | null;
  reversedBy: string | null;
  reversalReason: string | null;
};

/** Impedimento que deja `canPost = false` (la contabilización lo devuelve como 400/409 con este `code`). */
export type PmsShadowBlocker = {
  code: PmsShadowErrorCode;
  message: string;
  details?: Record<string, unknown>;
};

/** Respuesta de la previsualización de ingresos (nunca escribe). */
export type PmsShadowRevenuePreview = {
  source: PmsShadowRevenueSource;
  /** `hotel_code` del XML (null en formatos sin código de hotel). */
  hotelCode: string | null;
  businessDate: IsoDate;
  lines: PmsShadowRevenueLine[];
  totals: PmsShadowRevenueTotals;
  /** Líneas con `mapped = false`. */
  unmapped: PmsShadowRevenueLine[];
  reconciliation?: PmsShadowRevenueReconciliation;
  /** 0 líneas sin mapear ∧ día no contabilizado (o `replace`) ∧ periodo abierto ∧ hotel = perfil. */
  canPost: boolean;
  blockers: PmsShadowBlocker[];
  /** Avisos en español (códigos ignorados, redondeos, día distinto del business date actual…). */
  warnings: string[];
};

/** Fila de la tabla de reconciliación del día (diseño §5.4). */
export type PmsShadowReconciliationRow = {
  /** arrivals · departures · rooms_occupied · occupancy_pct · no_shows · revenue_total · revenue_rooms · tax_total · adr · revpar · reservations_made · cancellations… */
  metric: string;
  /** Valor declarado por OPERA (null si el feed stats del día no ha llegado). */
  opera: string | null;
  /** Valor calculado por Anfitorio. */
  anfitorio: string;
  delta: string | null;
  status: "ok" | "mismatch" | "missing";
};

/** Estado de un feed en el panel (fila de la tabla de feeds). */
export const PMS_SHADOW_FEED_STATES = ["ok", "late", "failed", "pending", "unscheduled"] as const;
export type PmsShadowFeedState = (typeof PMS_SHADOW_FEED_STATES)[number];

export const PMS_SHADOW_FEED_STATE_LABELS_ES: Readonly<Record<PmsShadowFeedState, string>> = Object.freeze({
  ok: "Recibido",
  late: "Retrasado",
  failed: "Con errores",
  pending: "Pendiente",
  unscheduled: "Sin programar"
});

export type PmsShadowFeedStatus = {
  feed: PmsShadowFeed;
  expectedTime: string | null;
  required: boolean;
  state: PmsShadowFeedState;
  /** Último run del feed (null si nunca llegó). */
  lastRun: PmsShadowRunRecord | null;
};

/** KPIs del panel «Modo sombra» (`GET …/pms-shadow/overview`). */
export type PmsShadowOverview = {
  propertyId: string;
  profile: PmsShadowProfileRecord | null;
  lastRunAt: string | null;
  linkedReservations: number;
  openAlerts: number;
  /** Último business date con reconciliación en verde (null si nunca). */
  lastReconciledDate: IsoDate | null;
  feeds: PmsShadowFeedStatus[];
};

// ---------------------------------------------------------------------------
// Códigos de error de las rutas (`details.code`)
// ---------------------------------------------------------------------------

/** Códigos con los que responden las rutas `/properties/:propertyId/pms-shadow/*` y el modo `sync` del importador. */
export const PMS_SHADOW_ERROR_CODES = [
  /** 400 · issues zod. */
  "VALIDATION_ERROR",
  /** 404 opaco · la propiedad no tiene perfil de modo sombra (o es de otra organización). */
  "PMS_SHADOW_PROFILE_NOT_FOUND",
  /** 409 · perfil en pausa: no se ingiere. */
  "PMS_SHADOW_PROFILE_PAUSED",
  /** 400 · `{ feed }`: feed fuera de PMS_SHADOW_FEEDS o no reconocible por nombre / cabecera. */
  "PMS_SHADOW_FEED_UNKNOWN",
  /** 400 · `{ reason }`: fichero ilegible (codificación, XML roto, ZIP inválido). */
  "PMS_SHADOW_FILE_UNREADABLE",
  /** 400 · `{ bytes, max }`: fichero > PMS_SHADOW_MAX_FILE_BYTES. */
  "PMS_SHADOW_FILE_TOO_LARGE",
  /** 409 · `{ runId }`: mismo (feed, businessDate, contentHash) ya registrado en la propiedad. */
  "PMS_SHADOW_RUN_DUPLICATE",
  /** 404 opaco · run inexistente, de otra propiedad o de otra organización. */
  "PMS_SHADOW_RUN_NOT_FOUND",
  /** 404 opaco · alerta inexistente, de otra propiedad o de otra organización. */
  "PMS_SHADOW_ALERT_NOT_FOUND",
  /** 409 · la alerta ya estaba resuelta. */
  "PMS_SHADOW_ALERT_ALREADY_RESOLVED",
  /** 401 / 403 · clave de API ausente, inválida, revocada o sin el scope pms.shadow.ingest, o de otra organización. */
  "PMS_SHADOW_INGEST_UNAUTHORIZED",
  /** 400 · `{ codes: [{ code, description }] }`: transaction codes sin mapear (la contabilización se bloquea). */
  "OPERA_TRX_CODE_UNMAPPED",
  /** 400 · el fichero de ingresos no tiene líneas. */
  "PMS_SHADOW_REVENUE_EMPTY",
  /** 409 · `{ importId }`: mismo hash en un lote no revertido de la propiedad. */
  "PMS_SHADOW_REVENUE_DUPLICATE",
  /** 409 · `{ importId }`: el día ya está contabilizado (usa `replace` para reverso + nuevo). */
  "PMS_SHADOW_REVENUE_ALREADY_POSTED",
  /** 404 opaco · lote de ingresos inexistente, de otra propiedad o de otra organización. */
  "PMS_SHADOW_REVENUE_NOT_FOUND",
  /** 409 · el lote no está `posted` (no se puede revertir un borrador ni un revertido). */
  "PMS_SHADOW_REVENUE_NOT_POSTED",
  /** 400 · `{ fileDate, businessDate }`: el fichero es de otro día del indicado. */
  "PMS_SHADOW_REVENUE_DAY_MISMATCH",
  /** 400 · `{ fileHotelCode, profileHotelCode }`: el `hotel_code` del fichero no es el del perfil. */
  "PMS_SHADOW_REVENUE_HOTEL_MISMATCH",
  /** 409 · `{ journalEntryId }`: ya existe un asiento pms_shadow_revenue para ese sourceId fuera de un lote (idempotencia del motor). */
  "PMS_SHADOW_REVENUE_ENTRY_EXISTS",
  /** 409 · ejercicio cerrado (motor contable). */
  "FISCAL_YEAR_CLOSED",
  /** 409 · periodo cerrado (motor contable). */
  "FISCAL_PERIOD_CLOSED",
  /** 400 · línea de ingreso sin centro de trabajo (motor contable). */
  "WORK_CENTER_REQUIRED"
] as const;
export type PmsShadowErrorCode = (typeof PMS_SHADOW_ERROR_CODES)[number];

/** Mensaje en español por código (fallback del front y del CLI). */
export const PMS_SHADOW_ERROR_LABELS_ES: Readonly<Record<PmsShadowErrorCode, string>> = Object.freeze({
  VALIDATION_ERROR: "La petición no es válida.",
  PMS_SHADOW_PROFILE_NOT_FOUND: "Esta propiedad no tiene configurado el modo sombra.",
  PMS_SHADOW_PROFILE_PAUSED: "El modo sombra de esta propiedad está en pausa: reactívalo para recibir cortes.",
  PMS_SHADOW_FEED_UNKNOWN: "No se reconoce el tipo de corte del fichero: indícalo o revisa la cabecera.",
  PMS_SHADOW_FILE_UNREADABLE: "No se ha podido leer el fichero recibido.",
  PMS_SHADOW_FILE_TOO_LARGE: "El fichero supera el tamaño admitido (5 MB).",
  PMS_SHADOW_RUN_DUPLICATE: "Este fichero ya se recibió para ese corte y ese día.",
  PMS_SHADOW_RUN_NOT_FOUND: "Corte no encontrado.",
  PMS_SHADOW_ALERT_NOT_FOUND: "Alerta no encontrada.",
  PMS_SHADOW_ALERT_ALREADY_RESOLVED: "La alerta ya estaba resuelta.",
  PMS_SHADOW_INGEST_UNAUTHORIZED: "Clave de API no válida o sin permiso para enviar cortes a esta propiedad.",
  OPERA_TRX_CODE_UNMAPPED: "Hay transaction codes sin mapear: complétalos en el perfil antes de contabilizar el día.",
  PMS_SHADOW_REVENUE_EMPTY: "El fichero de ingresos no contiene ninguna línea.",
  PMS_SHADOW_REVENUE_DUPLICATE: "Este fichero de ingresos ya se importó: revierte el lote anterior o usa «sustituir».",
  PMS_SHADOW_REVENUE_ALREADY_POSTED: "Los ingresos de ese día ya están contabilizados: usa «sustituir» (reverso + nuevo).",
  PMS_SHADOW_REVENUE_NOT_FOUND: "Lote de ingresos no encontrado.",
  PMS_SHADOW_REVENUE_NOT_POSTED: "El lote de ingresos no está contabilizado: no hay nada que revertir.",
  PMS_SHADOW_REVENUE_DAY_MISMATCH: "El fichero corresponde a otro día distinto del indicado.",
  PMS_SHADOW_REVENUE_HOTEL_MISMATCH: "El código de hotel del fichero no es el de esta propiedad.",
  PMS_SHADOW_REVENUE_ENTRY_EXISTS: "Ya existe un asiento de ingresos de OPERA para ese día.",
  FISCAL_YEAR_CLOSED: "El ejercicio está cerrado: no se puede contabilizar ni revertir en él.",
  FISCAL_PERIOD_CLOSED: "El periodo contable está cerrado.",
  WORK_CENTER_REQUIRED: "Las líneas de ingreso exigen un centro de trabajo."
});

// ---------------------------------------------------------------------------
// Constantes (límites, ingest, reconciliación, contabilidad)
// ---------------------------------------------------------------------------

/** Tamaño máximo del fichero recibido en bytes (5 MiB) → 400 PMS_SHADOW_FILE_TOO_LARGE. */
export const PMS_SHADOW_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Longitud máxima de `contentBase64` en caracteres (zod; base64 infla 4/3), como RESERVATION_IMPORT_MAX_BASE64_CHARS. */
export const PMS_SHADOW_MAX_BASE64_CHARS = 7 * 1024 * 1024;
/** Cabecera HTTP con la clave de API del ingest (`DeveloperApp`). */
export const PMS_SHADOW_INGEST_HEADER = "x-api-key";
/** Scope que debe tener la app de desarrollador para `POST …/pms-shadow/ingest` (toda la organización). */
export const PMS_SHADOW_INGEST_SCOPE = "pms.shadow.ingest";
/**
 * SEC-04: variante del scope ligada a UN centro, `pms.shadow.ingest:<propertyId>` (una o varias por app).
 * Una app con solo scopes ligados no puede enviar cortes de otro centro (401 único del ingest): la clave
 * del agente SFTP de un hotel comprometida no escribe en los 8 centros de la cadena. `pms.shadow.ingest`
 * a secas sigue admitiendo cualquier centro de la organización (integraciones centrales).
 */
export const PMS_SHADOW_INGEST_SCOPE_PROPERTY_PREFIX = `${PMS_SHADOW_INGEST_SCOPE}:`;
/** `pms.shadow.ingest:<propertyId>`: el scope que conviene dar a la app de un solo hotel (runbook §3.2). */
export function pmsShadowIngestScopeFor(propertyId: string): string {
  return `${PMS_SHADOW_INGEST_SCOPE_PROPERTY_PREFIX}${propertyId}`;
}
/** `createdBy` / actor de auditoría de los runs del job del líder y del conector de correo. */
export const PMS_SHADOW_SYSTEM_USER_ID = "usr_system_pms_shadow";
/** Minutos de gracia tras `expectedTime` antes de emitir OPERA_FEED_LATE. */
export const PMS_SHADOW_FEED_LATE_GRACE_MINUTES = 120;
/** Tolerancias de la reconciliación diaria (diseño §5.4), como MoneyString / entero. */
export const PMS_SHADOW_RECON_TOLERANCES = Object.freeze({
  /** Conteo exacto de habitaciones (llegadas, salidas, ocupadas, no-shows). */
  rooms: "0",
  /** Por transaction code (redondeos). */
  revenuePerCode: "0.01",
  /** Σ ingresos del día. */
  revenueTotal: "1.00",
  /** ADR y RevPAR. */
  adr: "0.05"
} as const);
/** `JournalEntry.sourceType` del asiento diario de ingresos de OPERA. */
export const PMS_SHADOW_REVENUE_SOURCE_TYPE = "pms_shadow_revenue" as const satisfies JournalSourceType;
/**
 * `JournalEntry.sourceId` del asiento diario: `<propertyId>:<YYYY-MM-DD>` (idempotencia por
 * (organización, sourceType, sourceId)). SC-11: tras un reverso (`replace` o reimportación de un
 * día revertido) el puente del diario (`treasury/ledger-bridge.ts` · `resolveSourceKey`) libera la
 * clave añadiendo `#<n>` (`<propertyId>:<YYYY-MM-DD>#1`, `#2`…) al asiento VIVO nuevo; los
 * revertidos conservan la clave anterior. Para localizar el asiento vivo del día: `sourceId LIKE
 * '<propertyId>:<YYYY-MM-DD>%'` y `status = 'posted'` (o `PmsShadowRevenueImport.journalEntryIds`).
 */
export function pmsShadowRevenueSourceId(propertyId: string, businessDate: IsoDate): string {
  return `${propertyId}:${businessDate}`;
}
/** Prefijo de `Reservation.bookingSource` de las reservas sincronizadas desde OPERA: `opera:<Hotel Code>`. */
export const PMS_SHADOW_BOOKING_SOURCE_PREFIX = "opera:";
/** `Reservation.bookingSource` de una reserva sincronizada desde OPERA para ese hotel. */
export function pmsShadowBookingSource(operaHotelCode: string): string {
  return `${PMS_SHADOW_BOOKING_SOURCE_PREFIX}${operaHotelCode}`;
}

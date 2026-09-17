// Unit tests · Tanda 7b · L0 — tipos compartidos del modo sombra OPERA Cloud
// (packages/shared/src/pms-shadow-types.ts) y perfil preinstalado «OPERA Cloud»
// (packages/shared/src/pms-shadow-profiles/opera-cloud.ts). Sin base de datos.
// Desde apps/api:
//   node --import tsx --test src/modules/pms-shadow/__tests__/pms-shadow-types.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  JOURNAL_SOURCE_TYPES,
  OPERA_CLOUD_DEPARTURE_ALL_HEADER,
  OPERA_CLOUD_IGNORED_COLUMNS,
  OPERA_CLOUD_PROFILE,
  OPERA_CLOUD_RESPONSYS_HEADER,
  OPERA_CLOUD_STATUS_MAP,
  PMS_SHADOW_ALERT_CODES,
  PMS_SHADOW_ALERT_LABELS_ES,
  PMS_SHADOW_ALERT_SEVERITIES,
  PMS_SHADOW_ALERT_SEVERITY,
  PMS_SHADOW_ERROR_CODES,
  PMS_SHADOW_ERROR_LABELS_ES,
  PMS_SHADOW_FEEDS,
  PMS_SHADOW_FEED_LABELS_ES,
  PMS_SHADOW_FEED_LATE_GRACE_MINUTES,
  PMS_SHADOW_INGEST_HEADER,
  PMS_SHADOW_INGEST_SCOPE,
  PMS_SHADOW_MAX_BASE64_CHARS,
  PMS_SHADOW_MAX_FILE_BYTES,
  PMS_SHADOW_PROFILE_STATUSES,
  PMS_SHADOW_RECON_TOLERANCES,
  PMS_SHADOW_RESERVATION_FEEDS,
  PMS_SHADOW_REVENUE_SOURCES,
  PMS_SHADOW_REVENUE_SOURCE_LABELS_ES,
  PMS_SHADOW_REVENUE_SOURCE_TYPE,
  PMS_SHADOW_REVENUE_STATUSES,
  PMS_SHADOW_RUN_SOURCES,
  PMS_SHADOW_RUN_SOURCE_LABELS_ES,
  PMS_SHADOW_RUN_STATUSES,
  PMS_SHADOW_RUN_STATUS_LABELS_ES,
  PMS_SHADOW_SYSTEMS,
  PMS_SHADOW_SYSTEM_USER_ID,
  PMS_SHADOW_TRX_KINDS,
  PMS_SHADOW_USALI_REVENUE_DEPARTMENTS,
  RESERVATION_IMPORT_CHANNELS,
  RESERVATION_IMPORT_FIELDS,
  RESERVATION_IMPORT_MAX_BASE64_CHARS,
  RESERVATION_IMPORT_MAX_BYTES,
  RESERVATION_IMPORT_PAYMENT_METHODS,
  RESERVATION_IMPORT_SEGMENTS,
  RESERVATION_SYNC_TARGET_STATUSES,
  pmsShadowBookingSource,
  pmsShadowRevenueSourceId
} from "@hotelos/shared";
import type { PmsShadowFeedProfile, ReservationSyncTargetStatus } from "@hotelos/shared";
import { USALI_DEPARTMENT_LINES } from "../../accounting/chart-of-accounts.service.js";
import { FULL_NAME_SYNONYMS, foldHeader, foldValue } from "../../pms/reservation-import.mapping.js";

const FIELDS = new Set<string>(RESERVATION_IMPORT_FIELDS);
const unique = (values: readonly string[]) => new Set(values).size === values.length;

/**
 * Las 34 grafías de estado de la tabla §4.1 del diseño (informes «Res. Status»,
 * exports `RESERVATION_STATUS`, enum síncrono `pMS_ResStatusType`, enum del async
 * `database_ResStatusType`, Business Events y guía RMS) con su estado destino.
 */
const OPERA_STATUS_LITERALS: ReadonlyArray<readonly [string, ReservationSyncTargetStatus]> = [
  ["Reserved", "confirmed"],
  ["RESERVED", "confirmed"],
  ["Confirmed", "confirmed"],
  ["Due In", "confirmed"],
  ["DueIn", "confirmed"],
  ["DUE IN", "confirmed"],
  ["Prospect", "confirmed"],
  ["PROSPECT", "confirmed"],
  ["Requested", "confirmed"],
  ["REQUESTED", "confirmed"],
  ["Checked In", "checked_in"],
  ["CHECKED IN", "checked_in"],
  ["In House", "checked_in"],
  ["InHouse", "checked_in"],
  ["IN HOUSE", "checked_in"],
  ["Due Out", "checked_in"],
  ["DueOut", "checked_in"],
  ["DUE OUT", "checked_in"],
  ["PendingCheckout", "checked_in"],
  ["PENDING CHECKOUT", "checked_in"],
  ["Walkin", "checked_in"],
  ["WALKIN", "checked_in"],
  ["Checked Out", "checked_out"],
  ["CHECKED OUT", "checked_out"],
  ["CheckedOut", "checked_out"],
  ["Cancelled", "cancelled"],
  ["CANCELLED", "cancelled"],
  ["Canceled", "cancelled"],
  ["No Show", "no_show"],
  ["NO SHOW", "no_show"],
  ["NoShow", "no_show"],
  ["Waitlist", "skip"],
  ["WAITLIST", "skip"],
  ["Waitlisted", "skip"]
];

function feedProfile(feed: "arrivals" | "departures"): PmsShadowFeedProfile {
  const profile = OPERA_CLOUD_PROFILE.feeds[feed];
  assert.ok(profile, `feeds.${feed} definido`);
  return profile;
}

function assertFeedMapping(feed: "arrivals" | "departures", header: readonly string[]) {
  const profile = feedProfile(feed);
  const keys = Object.keys(profile.mapping);
  assert.deepEqual(keys, [...header], `las claves del mapeo de ${feed} son la cabecera literal, en orden`);
  const mapped = Object.values(profile.mapping).filter((v): v is NonNullable<typeof v> => v !== null);
  for (const field of mapped) assert.ok(FIELDS.has(field), `${feed}: ${field} es un campo canónico`);
  assert.ok(unique(mapped), `${feed}: ningún campo canónico repetido`);
  const nullKeys = keys.filter((k) => profile.mapping[k] === null);
  assert.deepEqual(nullKeys, [...OPERA_CLOUD_IGNORED_COLUMNS[feed]], `${feed}: las columnas con null son exactamente las ignoradas`);
  assert.deepEqual(profile.ignoredColumns, [...OPERA_CLOUD_IGNORED_COLUMNS[feed]]);
  return profile;
}

describe("Perfil OPERA Cloud · feed arrivals (RESPONSYS_RESV_AUTO)", () => {
  it("la cabecera tiene 33 columnas únicas y son las claves del mapeo", () => {
    assert.equal(OPERA_CLOUD_RESPONSYS_HEADER.length, 33);
    assert.ok(unique(OPERA_CLOUD_RESPONSYS_HEADER));
    const profile = assertFeedMapping("arrivals", OPERA_CLOUD_RESPONSYS_HEADER);
    assert.equal(profile.dateOrder, "ymd", "Responsys exporta fechas YYYYMMDD");
    assert.equal(profile.headerless, undefined, "el export trae fila de cabecera");
    assert.equal(Object.values(profile.mapping).filter((v) => v !== null).length, 19);
  });

  it("mapea los campos obligatorios y la referencia externa", () => {
    const { mapping } = feedProfile("arrivals");
    assert.equal(mapping.RESERVATION_ID, "referencia_externa", "RESERVATION_ID es el nº de confirmación");
    assert.equal(mapping.ARRIVAL_DATE, "llegada");
    assert.equal(mapping.DEPARTURE_DATE, "salida");
    assert.equal(mapping.NUM_NIGHTS, "noches");
    assert.equal(mapping.ROOM_TYPE, "tipo_habitacion");
    assert.equal(mapping.GUEST_FIRST_NAME, "nombre");
    assert.equal(mapping.GUEST_LAST_NAME, "apellidos");
    assert.equal(mapping.RATE_CODE, "tarifa");
    assert.equal(mapping.ROOM_NUMBER, "habitacion");
    assert.equal(mapping.NUM_ROOMS, "habitaciones");
    assert.equal(mapping.BLOCK_CODE, "grupo");
    assert.equal(mapping.BOOKING_SOURCE, "canal");
    assert.equal(mapping.RESERVATION_STATUS, "estado");
    assert.equal(mapping.PAYMENT_TYPE, "metodo_pago");
    assert.equal(mapping.SPECIAL_REQUESTS, "peticiones");
  });

  it("descarta por diseño la PII de tarjeta, descuentos, preferencias y RATE (solo primera noche)", () => {
    const { mapping } = feedProfile("arrivals");
    for (const column of [
      "NAME_ON_CARD",
      "DISCOUNT_AMOUNT",
      "DISCOUNT_PERCENTAGE",
      "DISCOUNT_REASON",
      "RATE",
      "PROMOTION",
      "ROOM_PREFERENCES",
      "OTHER_PREFERENCES",
      "SHARED_ROOM",
      "PARENT_BLOCK"
    ]) {
      assert.equal(mapping[column], null, `${column} → null`);
      assert.ok(OPERA_CLOUD_IGNORED_COLUMNS.arrivals.includes(column));
    }
    assert.ok(!Object.values(mapping).includes("importe_total"), "RATE no se mapea a importe_total (estimación en L1)");
    assert.ok(!Object.values(mapping).includes("email"), "el export no trae e-mail");
    assert.equal(OPERA_CLOUD_IGNORED_COLUMNS.arrivals.length, 14);
  });
});

describe("Perfil OPERA Cloud · feed departures (departure_all)", () => {
  it("la cabecera tiene 19 columnas únicas, es headerless en el mismo orden y lee fechas DMY", () => {
    assert.equal(OPERA_CLOUD_DEPARTURE_ALL_HEADER.length, 19);
    assert.ok(unique(OPERA_CLOUD_DEPARTURE_ALL_HEADER));
    const profile = assertFeedMapping("departures", OPERA_CLOUD_DEPARTURE_ALL_HEADER);
    assert.deepEqual(profile.headerless, [...OPERA_CLOUD_DEPARTURE_ALL_HEADER]);
    assert.equal(profile.dateOrder, "dmy");
    assert.equal(Object.values(profile.mapping).filter((v) => v !== null).length, 16);
  });

  it("mapea llegada, tipo y un nombre completo (splitName de la Tanda 7)", () => {
    const { mapping } = feedProfile("departures");
    assert.equal(mapping["Arr. Date"], "llegada");
    assert.equal(mapping["Dep. Date"], "salida");
    assert.equal(mapping["Room Type"], "tipo_habitacion");
    assert.equal(mapping.Name, "nombre");
    assert.ok(!Object.values(mapping).includes("apellidos"), "sin columna de apellidos: la cubre el nombre completo");
    assert.ok(FULL_NAME_SYNONYMS.includes(foldHeader("Name")), "«Name» es sinónimo de nombre completo en la Tanda 7");
    assert.equal(mapping["Room No."], "habitacion");
    assert.equal(mapping.Group, "grupo");
    assert.equal(mapping["Block Code"], null, "Block Code se ignora: Group ya va a grupo");
    assert.equal(mapping["Dep. Time"], null);
    assert.equal(mapping.Balance, null);
    assert.equal(mapping["VIP Code"], "vip");
    assert.equal(mapping["Res. Status"], "estado");
    assert.equal(mapping["Pay Mth"], "metodo_pago");
  });

  it("los feeds sin columnas publicadas quedan como huecos documentados", () => {
    assert.equal(OPERA_CLOUD_PROFILE.system, "opera_cloud");
    assert.ok(PMS_SHADOW_SYSTEMS.includes(OPERA_CLOUD_PROFILE.system));
    assert.equal(OPERA_CLOUD_PROFILE.feeds.inhouse, undefined);
    assert.equal(OPERA_CLOUD_PROFILE.feeds.changes, undefined);
    for (const feed of Object.keys(OPERA_CLOUD_PROFILE.feeds)) {
      assert.ok((PMS_SHADOW_RESERVATION_FEEDS as readonly string[]).includes(feed), `${feed} es un feed de reservas`);
    }
  });
});

describe("Perfil OPERA Cloud · estados y diccionarios", () => {
  it("statusMap cubre las 34 grafías de §4.1 (22 claves plegadas) con el estado destino correcto", () => {
    assert.equal(OPERA_STATUS_LITERALS.length, 34);
    for (const [literal, expected] of OPERA_STATUS_LITERALS) {
      const key = foldValue(literal);
      assert.ok(key in OPERA_CLOUD_STATUS_MAP, `${literal} → «${key}» está en el statusMap`);
      assert.equal(OPERA_CLOUD_STATUS_MAP[key], expected, `${literal} → ${expected}`);
    }
    const folded = new Set(OPERA_STATUS_LITERALS.map(([literal]) => foldValue(literal)));
    assert.equal(folded.size, 22);
    assert.equal(Object.keys(OPERA_CLOUD_STATUS_MAP).length, 22, "sin claves fuera de §4.1");
    assert.equal(OPERA_CLOUD_PROFILE.statusMap, OPERA_CLOUD_STATUS_MAP);
  });

  it("statusMap solo devuelve estados de RESERVATION_SYNC_TARGET_STATUSES y sus claves ya están plegadas", () => {
    const targets = new Set<string>(RESERVATION_SYNC_TARGET_STATUSES);
    for (const [key, value] of Object.entries(OPERA_CLOUD_STATUS_MAP)) {
      assert.equal(key, foldValue(key), `clave plegada: ${key}`);
      assert.ok(targets.has(value), `${key} → ${value} es un estado destino`);
    }
    assert.deepEqual(RESERVATION_SYNC_TARGET_STATUSES, ["confirmed", "checked_in", "checked_out", "cancelled", "no_show", "skip"]);
    assert.ok(!targets.has("draft"), "nunca se sincroniza a draft");
    assert.equal(OPERA_CLOUD_STATUS_MAP.waitlist, "skip");
    assert.equal(OPERA_CLOUD_STATUS_MAP.prospect, "confirmed");
    assert.equal(OPERA_CLOUD_STATUS_MAP.walkin, "checked_in");
  });

  it("channelMap / marketSegmentMap / paymentMethodMap: claves plegadas y valores canónicos de la Tanda 7", () => {
    const check = (map: Record<string, string>, canonical: readonly string[], label: string) => {
      assert.ok(Object.keys(map).length > 0, `${label} no está vacío`);
      for (const [key, value] of Object.entries(map)) {
        assert.equal(key, foldValue(key), `${label}: clave plegada ${key}`);
        assert.ok(canonical.includes(value), `${label}: ${key} → ${value} es canónico`);
      }
    };
    check(OPERA_CLOUD_PROFILE.channelMap, RESERVATION_IMPORT_CHANNELS, "channelMap");
    check(OPERA_CLOUD_PROFILE.marketSegmentMap, RESERVATION_IMPORT_SEGMENTS, "marketSegmentMap");
    check(OPERA_CLOUD_PROFILE.paymentMethodMap, RESERVATION_IMPORT_PAYMENT_METHODS, "paymentMethodMap");
    assert.equal(OPERA_CLOUD_PROFILE.channelMap[foldValue("BDC")], "booking_com");
    assert.equal(OPERA_CLOUD_PROFILE.channelMap.exp, "expedia");
    assert.equal(OPERA_CLOUD_PROFILE.channelMap.web, "direct");
    assert.equal(OPERA_CLOUD_PROFILE.channelMap.ta, "agency");
    assert.equal(OPERA_CLOUD_PROFILE.marketSegmentMap.corp, "corporate");
    assert.equal(OPERA_CLOUD_PROFILE.marketSegmentMap.grp, "group");
    assert.equal(OPERA_CLOUD_PROFILE.paymentMethodMap[foldValue("VI")], "credit_card");
    assert.equal(OPERA_CLOUD_PROFILE.paymentMethodMap.ca, "cash");
    assert.equal(OPERA_CLOUD_PROFILE.paymentMethodMap.ar, "company_invoice");
  });
});

describe("Modo sombra · catálogos compartidos", () => {
  it("feeds, orígenes y estados de run con etiqueta en español", () => {
    assert.deepEqual(PMS_SHADOW_FEEDS, ["arrivals", "inhouse", "departures", "changes", "revenue", "profiles", "stats", "ohip_delta"]);
    assert.deepEqual(PMS_SHADOW_RESERVATION_FEEDS, ["arrivals", "inhouse", "departures", "changes"]);
    for (const feed of PMS_SHADOW_FEEDS) assert.ok(PMS_SHADOW_FEED_LABELS_ES[feed].length > 0, feed);
    assert.deepEqual(PMS_SHADOW_RUN_SOURCES, ["email", "sftp", "api_key", "manual", "ohip", "cli"]);
    for (const source of PMS_SHADOW_RUN_SOURCES) assert.ok(PMS_SHADOW_RUN_SOURCE_LABELS_ES[source].length > 0, source);
    assert.deepEqual(PMS_SHADOW_RUN_STATUSES, ["received", "processing", "done", "partial", "failed"]);
    for (const status of PMS_SHADOW_RUN_STATUSES) assert.ok(PMS_SHADOW_RUN_STATUS_LABELS_ES[status].length > 0, status);
    assert.deepEqual(PMS_SHADOW_PROFILE_STATUSES, ["active", "paused"]);
  });

  it("PMS_SHADOW_ALERT_CODES tiene 11 códigos únicos, cada uno con severidad y etiqueta", () => {
    assert.equal(PMS_SHADOW_ALERT_CODES.length, 11);
    assert.ok(unique(PMS_SHADOW_ALERT_CODES));
    for (const code of PMS_SHADOW_ALERT_CODES) {
      assert.match(code, /^OPERA_[A-Z_]+$/, code);
      assert.ok(PMS_SHADOW_ALERT_SEVERITIES.includes(PMS_SHADOW_ALERT_SEVERITY[code]), `${code} tiene severidad`);
      assert.ok(PMS_SHADOW_ALERT_LABELS_ES[code].length > 0, `${code} tiene etiqueta`);
    }
    assert.deepEqual(Object.keys(PMS_SHADOW_ALERT_SEVERITY).sort(), [...PMS_SHADOW_ALERT_CODES].sort());
    assert.deepEqual(Object.keys(PMS_SHADOW_ALERT_LABELS_ES).sort(), [...PMS_SHADOW_ALERT_CODES].sort());
    for (const code of [
      "OPERA_MISSING_IN_SNAPSHOT",
      "OPERA_CONFLICT_LOCAL_RESERVATION",
      "OPERA_CHECKIN_WITHOUT_ROOM",
      "OPERA_TRX_CODE_UNMAPPED",
      "OPERA_ROOM_TYPE_UNMAPPED",
      "OPERA_RATE_CODE_UNMAPPED",
      "OPERA_RECON_COUNT_MISMATCH",
      "OPERA_RECON_REVENUE_MISMATCH",
      "OPERA_FEED_LATE",
      "OPERA_FEED_COLUMNS_CHANGED",
      "OPERA_FEED_UNRECOGNIZED"
    ] as const) {
      assert.ok(PMS_SHADOW_ALERT_CODES.includes(code), code);
    }
    assert.equal(PMS_SHADOW_ALERT_SEVERITY.OPERA_TRX_CODE_UNMAPPED, "error", "un código sin mapear bloquea el día");
    assert.equal(PMS_SHADOW_ALERT_SEVERITY.OPERA_FEED_LATE, "warning");
  });

  it("ingresos: orígenes, estados, naturalezas y departamentos USALI con línea revenue", () => {
    assert.deepEqual(PMS_SHADOW_REVENUE_SOURCES, ["xml_revenue", "findeptcodes_xml", "findeptcodes_csv", "responsys_trx"]);
    for (const source of PMS_SHADOW_REVENUE_SOURCES) assert.ok(PMS_SHADOW_REVENUE_SOURCE_LABELS_ES[source].length > 0, source);
    assert.deepEqual(PMS_SHADOW_REVENUE_STATUSES, ["draft", "posted", "reversed"]);
    assert.deepEqual(PMS_SHADOW_TRX_KINDS, ["revenue", "tax", "payment", "ignore"]);
    const revenueDepartments = Object.entries(USALI_DEPARTMENT_LINES)
      .filter(([, lines]) => (lines as readonly string[]).includes("revenue"))
      .map(([department]) => department);
    assert.deepEqual([...PMS_SHADOW_USALI_REVENUE_DEPARTMENTS], revenueDepartments, "los únicos departamentos USALI con línea revenue");
  });

  it("JOURNAL_SOURCE_TYPES incluye pms_shadow_revenue y el sourceId es <propertyId>:<YYYY-MM-DD>", () => {
    assert.ok(JOURNAL_SOURCE_TYPES.includes("pms_shadow_revenue"));
    assert.equal(PMS_SHADOW_REVENUE_SOURCE_TYPE, "pms_shadow_revenue");
    assert.equal(JOURNAL_SOURCE_TYPES.indexOf("pms_shadow_revenue"), JOURNAL_SOURCE_TYPES.indexOf("payroll_cost_import") + 1);
    assert.equal(pmsShadowRevenueSourceId("cmrhw9jy40003fyvbuu2ec2w7", "2026-09-16"), "cmrhw9jy40003fyvbuu2ec2w7:2026-09-16");
    assert.equal(pmsShadowBookingSource("RIAS"), "opera:RIAS");
  });

  it("PMS_SHADOW_ERROR_LABELS_ES cubre exactamente todos los códigos de error", () => {
    assert.ok(unique(PMS_SHADOW_ERROR_CODES));
    assert.ok(PMS_SHADOW_ERROR_CODES.includes("VALIDATION_ERROR"));
    assert.ok(PMS_SHADOW_ERROR_CODES.includes("OPERA_TRX_CODE_UNMAPPED"));
    assert.ok(PMS_SHADOW_ERROR_CODES.includes("PMS_SHADOW_INGEST_UNAUTHORIZED"));
    assert.ok(PMS_SHADOW_ERROR_CODES.includes("FISCAL_YEAR_CLOSED"));
    assert.equal(PMS_SHADOW_ERROR_CODES.length, 23, "los 23 códigos del diseño §6 / brief");
    assert.deepEqual(Object.keys(PMS_SHADOW_ERROR_LABELS_ES).sort(), [...PMS_SHADOW_ERROR_CODES].sort());
    for (const code of PMS_SHADOW_ERROR_CODES) {
      assert.ok(PMS_SHADOW_ERROR_LABELS_ES[code].length > 0, code);
      assert.doesNotMatch(PMS_SHADOW_ERROR_LABELS_ES[code], /[A-Z]{3,}_[A-Z]/, `${code}: el mensaje es texto, no un código`);
    }
  });

  it("límites y constantes del ingest coinciden con la Tanda 7 y el diseño", () => {
    assert.equal(PMS_SHADOW_MAX_FILE_BYTES, 5 * 1024 * 1024);
    assert.equal(PMS_SHADOW_MAX_FILE_BYTES, RESERVATION_IMPORT_MAX_BYTES);
    assert.equal(PMS_SHADOW_MAX_BASE64_CHARS, 7 * 1024 * 1024);
    assert.equal(PMS_SHADOW_MAX_BASE64_CHARS, RESERVATION_IMPORT_MAX_BASE64_CHARS);
    assert.equal(PMS_SHADOW_INGEST_HEADER, "x-api-key");
    assert.equal(PMS_SHADOW_INGEST_SCOPE, "pms.shadow.ingest");
    assert.equal(PMS_SHADOW_SYSTEM_USER_ID, "usr_system_pms_shadow");
    assert.equal(PMS_SHADOW_FEED_LATE_GRACE_MINUTES, 120);
    assert.deepEqual(PMS_SHADOW_RECON_TOLERANCES, { rooms: "0", revenuePerCode: "0.01", revenueTotal: "1.00", adr: "0.05" });
    for (const value of Object.values(PMS_SHADOW_RECON_TOLERANCES)) assert.match(value, /^\d+(\.\d{2})?$/, value);
  });
});

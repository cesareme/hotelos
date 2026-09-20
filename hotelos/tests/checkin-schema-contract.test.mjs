import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync } from "node:fs";

// Tanda CHK · W1-A (check-in automatizado): contrato de esquema, migración,
// PII y tipos wire SIN base de datos. Lo que sí necesita BD (columna a columna)
// lo cubren `db:drift:check` y `db:install:check`.

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migrationsDir = new URL("../packages/database/prisma/migrations/", import.meta.url);
const migrationFolders = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.endsWith("_checkin_automatizado"))
  .map((entry) => entry.name);

const schema = read("packages/database/prisma/schema.prisma");
const crypto = read("packages/database/src/crypto-fields.ts");
const types = read("packages/shared/src/checkin-types.ts");
const sharedIndex = read("packages/shared/src/index.ts");

const TABLES = {
  CheckInSession: "checkin_sessions",
  CheckInGuest: "checkin_guests",
  DocumentCapture: "document_captures",
  Signature: "signatures",
  AssignmentSuggestion: "assignment_suggestions",
  RoomBlock: "room_blocks",
  RoomConnection: "room_connections",
  KioskDevice: "kiosk_devices",
  PropertyCheckInPolicy: "property_checkin_policies"
};

const INDEXES = [
  'CREATE INDEX "checkin_sessions_property_id_status_idx"',
  'CREATE UNIQUE INDEX "checkin_sessions_reservation_id_key"',
  'CREATE INDEX "checkin_guests_session_id_ordinal_idx"',
  'CREATE INDEX "checkin_guests_guest_register_record_id_idx"',
  'CREATE INDEX "checkin_guests_property_id_idx"',
  'CREATE INDEX "document_captures_checkin_guest_id_idx"',
  'CREATE INDEX "document_captures_purge_at_idx"',
  'CREATE INDEX "signatures_guest_register_record_id_idx"',
  'CREATE INDEX "signatures_retention_until_idx"',
  'CREATE INDEX "assignment_suggestions_property_id_status_created_at_idx"',
  'CREATE INDEX "assignment_suggestions_reservation_id_idx"',
  'CREATE INDEX "kiosk_devices_property_id_status_idx"',
  'CREATE UNIQUE INDEX "property_checkin_policies_property_id_key"',
  'CREATE INDEX "room_blocks_room_id_from_date_to_date_idx"',
  'CREATE INDEX "room_blocks_property_id_idx"',
  'CREATE INDEX "room_connections_property_id_idx"',
  'CREATE UNIQUE INDEX "room_connections_room_a_id_room_b_id_key"'
];

// Pares (array `as const` del contrato wire ↔ modelo.campo documentado con `///`).
const VOCABULARIES = [
  ["CHECKIN_SESSION_STATUSES", "CheckInSession", "status"],
  ["CHECKIN_CHANNELS", "CheckInSession", "channel"],
  ["CHECKIN_PAYMENT_STATUSES", "CheckInSession", "paymentStatus"],
  ["CHECKIN_GUEST_STATUSES", "CheckInGuest", "status"],
  ["IDENTITY_VERIFICATION_METHODS", "CheckInGuest", "identityVerificationMethod"],
  ["DOCUMENT_CAPTURE_SOURCES", "DocumentCapture", "source"],
  ["SIGNATURE_METHODS", "Signature", "method"],
  ["ASSIGNMENT_SUGGESTION_STATUSES", "AssignmentSuggestion", "status"],
  ["ASSIGNMENT_SOURCES", "AssignmentSuggestion", "source"],
  ["AUTO_ASSIGN_LEVELS", "AssignmentSuggestion", "automationLevel"],
  ["AUTO_ASSIGN_LEVELS", "PropertyCheckInPolicy", "autoAssignLevel"],
  ["DEPOSIT_POLICIES", "PropertyCheckInPolicy", "depositPolicy"],
  ["KIOSK_DEVICE_STATUSES", "KioskDevice", "status"],
  ["ROOM_BLOCK_REASONS", "RoomBlock", "reason"],
  ["ROOM_CONNECTION_KINDS", "RoomConnection", "kind"]
];

const count = (source, re) => (source.match(re) ?? []).length;
const modelBlock = (model) => {
  const match = new RegExp(`^model ${model} \\{[\\s\\S]*?^\\}`, "m").exec(schema);
  assert.ok(match, `model ${model} no está en schema.prisma`);
  return match[0];
};
// Valores del `///` inmediatamente anterior al campo (se ignora un paréntesis final).
const docValues = (model, field) => {
  const match = new RegExp(`^  /// ([^\\n]+)\\n  ${field}\\s`, "m").exec(modelBlock(model));
  assert.ok(match, `${model}.${field} debe llevar un /// con sus valores`);
  return match[1].replace(/\s*\(.*$/, "").split("|").map((value) => value.trim());
};
const constValues = (name) => {
  const match = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(types);
  assert.ok(match, `checkin-types.ts debe exportar ${name}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
};

describe("Check-in automatizado · esquema, migración, PII y tipos wire (Tanda CHK · W1-A)", () => {
  const migrationFolder = migrationFolders[0];
  const migration = migrationFolder ? readFileSync(new URL(`${migrationFolder}/migration.sql`, migrationsDir), "utf8") : "";
  // DDL sin la cabecera comentada (la cabecera menciona a propósito lo que NO lleva).
  const ddl = migration.replace(/^--.*$/gm, "");

  it("hay UNA migración *_checkin_automatizado, con marca de 14 dígitos y cabecera que explica qué se quitó a mano", () => {
    assert.equal(migrationFolders.length, 1, `esperaba una carpeta *_checkin_automatizado, hay ${migrationFolders.length}`);
    assert.match(migrationFolder, /^\d{14}_checkin_automatizado$/);
    assert.match(migration, /--from-schema-datasource prisma\/schema\.prisma/);
    assert.match(migration, /VatBookRegime/, "la cabecera documenta los DROP de IVA (otro carril) eliminados del SQL generado");
    assert.match(migration, /Reversible/);
  });

  it("declara los 9 modelos con su @@map y la migración crea exactamente esas 9 tablas", () => {
    for (const [model, table] of Object.entries(TABLES)) {
      assert.match(modelBlock(model), new RegExp(`@@map\\("${table}"\\)`), `${model} → ${table}`);
      assert.match(migration, new RegExp(`^CREATE TABLE "${table}" \\($`, "m"), `CREATE TABLE ${table}`);
    }
    assert.equal(count(migration, /^CREATE TABLE "/gm), 9);
  });

  it("0 enums, 0 columnas en tablas existentes, 0 DROP, 0 backfill, 0 imagen: solo CREATE TABLE + índices + 1 FK", () => {
    assert.equal(count(ddl, /^CREATE TYPE /gm), 0, "los estados son String documentados con ///");
    assert.equal(count(ddl, /^DROP /gm), 0);
    assert.equal(count(ddl, /ADD COLUMN/g), 0);
    assert.equal(count(ddl, /^(INSERT|UPDATE|DELETE) /gm), 0);
    assert.doesNotMatch(ddl, /DO \$\$/);
    assert.doesNotMatch(ddl, /BYTEA/i, "nunca se persiste la imagen del documento");
    assert.doesNotMatch(ddl, /guest_register_records/, "el índice único de partes queda como deuda documentada, no en esta migración");
    assert.doesNotMatch(schema, /^model (MobileKey|RoomFeatureAssignment) /m);
    for (const index of INDEXES) assert.match(migration, new RegExp(`^${index.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"), index);
    assert.equal(count(migration, /^CREATE (UNIQUE )?INDEX "/gm), INDEXES.length);
    assert.equal(count(migration, /^ALTER TABLE /gm), 1);
    assert.match(
      migration,
      /^ALTER TABLE "checkin_guests" ADD CONSTRAINT "checkin_guests_session_id_fkey" FOREIGN KEY \("session_id"\) REFERENCES "checkin_sessions"\("id"\) ON DELETE CASCADE/m
    );
    assert.match(modelBlock("CheckInGuest"), /session CheckInSession @relation\(fields: \[sessionId\], references: \[id\], onDelete: Cascade\)/);
  });

  it("PII de CheckInGuest: cifrada por PII_FIELDS con hashes de búsqueda en LOOKUP_HASH_FIELDS y columnas *_lookup_hash", () => {
    const pii = /PII_FIELDS[\s\S]*?CheckInGuest: \[([\s\S]*?)\]/.exec(crypto);
    assert.ok(pii, "PII_FIELDS.CheckInGuest");
    assert.deepEqual(
      [...pii[1].matchAll(/"(\w+)"/g)].map((m) => m[1]).sort(),
      ["documentNumber", "documentSupportNumber", "email", "phoneMobile", "residenceFullAddress"]
    );
    const lookup = /LOOKUP_HASH_FIELDS = \{[\s\S]*?CheckInGuest: \{([\s\S]*?)\}/.exec(crypto);
    assert.ok(lookup, "LOOKUP_HASH_FIELDS.CheckInGuest");
    const pairs = Object.fromEntries([...lookup[1].matchAll(/(\w+): "(\w+)"/g)].map((m) => [m[1], m[2]]));
    assert.deepEqual(pairs, { documentNumber: "documentNumberLookupHash", email: "emailLookupHash", phoneMobile: "phoneMobileLookupHash" });
    const guest = modelBlock("CheckInGuest");
    for (const [field, hash] of Object.entries(pairs)) {
      assert.match(guest, new RegExp(`^  ${field}\\s+String\\?`, "m"), `${field} es String? (ciphertext)`);
      assert.match(guest, new RegExp(`^  ${hash}\\s+String\\?\\s+@map\\("\\w+_lookup_hash"\\)`, "m"), hash);
    }
    for (const column of ["document_number_lookup_hash", "email_lookup_hash", "phone_mobile_lookup_hash", "document_support_number", "residence_full_address"]) {
      assert.match(migration, new RegExp(`^CREATE TABLE "checkin_guests" \\([\\s\\S]*?"${column}" TEXT,[\\s\\S]*?^\\);`, "m"), column);
    }
    // document_captures.fields_json solo lleva valores no PII: no hay columnas de PII en la tabla.
    assert.doesNotMatch(/^CREATE TABLE "document_captures" \(([\s\S]*?)^\);/m.exec(migration)[1], /document_number|first_name|surname|email|phone/);
  });

  it("corrector SEC-2: el trazo (PNG/SVG) y el PDF del parte del almacén provisional (data: URI en la fila) van cifrados por PII_FIELDS.Signature", () => {
    const pii = /PII_FIELDS[\s\S]*?\n  Signature: \[([\s\S]*?)\]/.exec(crypto);
    assert.ok(pii, "PII_FIELDS.Signature");
    assert.deepEqual([...pii[1].matchAll(/"(\w+)"/g)].map((m) => m[1]).sort(), ["objectKey", "pdfObjectKey"]);
    const signature = modelBlock("Signature");
    assert.match(signature, /^  objectKey\s+String\s+@map\("object_key"\)/m);
    assert.match(signature, /^  pdfObjectKey\s+String\?\s+@map\("pdf_object_key"\)/m);
  });

  it("los arrays `as const` del contrato wire son exactamente los valores documentados con /// en schema.prisma", () => {
    for (const [name, model, field] of VOCABULARIES) {
      assert.deepEqual(constValues(name), docValues(model, field), `${name} ↔ ${model}.${field}`);
    }
    assert.deepEqual(constValues("PREFERENCE_VOCABULARY"), [
      "floor_high", "floor_low", "quiet", "near_elevator", "far_elevator", "view_sea", "view_city", "bed_twin", "bed_king", "accessible", "connecting", "crib"
    ]);
    // Los defaults JSON de la política solo usan valores del vocabulario.
    const policy = /^CREATE TABLE "property_checkin_policies" \(([\s\S]*?)^\);/m.exec(migration)[1];
    const jsonDefault = (column) => JSON.parse(new RegExp(`"${column}" JSONB NOT NULL DEFAULT '(\\[[^']*\\])'`).exec(policy)[1]);
    for (const method of jsonDefault("allowed_verification_methods_json")) assert.ok(constValues("IDENTITY_VERIFICATION_METHODS").includes(method), method);
    for (const channel of jsonDefault("welcome_channel_order_json")) assert.ok(constValues("CHECKIN_CHANNELS").includes(channel), channel);
    assert.match(policy, /"auto_assign_level" TEXT NOT NULL DEFAULT 'suggest_and_confirm'/);
    assert.match(policy, /"deposit_policy" TEXT NOT NULL DEFAULT 'balance'/);
    assert.match(migration, /"image_stored" BOOLEAN NOT NULL DEFAULT false/);
  });

  it("checkin-types.ts exporta CHECKIN_ERROR_CODES, PREFERENCE_VOCABULARY, los DTOs previstos y está reexportado en index.ts", () => {
    assert.deepEqual(constValues("CHECKIN_ERROR_CODES"), [
      "GUEST_SESSION_INVALID", "CHECKIN_GUEST_LIMIT", "DOCUMENT_UNREADABLE", "MRZ_CHECKSUM_FAILED", "IDENTITY_MISMATCH",
      "SIGNATURE_NOT_REQUIRED", "GUEST_REGISTER_INCOMPLETE", "CHECKIN_INCOMPLETE", "ROOM_NOT_READY", "ROOM_BLOCKED", "BALANCE_DUE",
      "CHECKIN_ALREADY_DONE", "IDENTITY_NOT_VERIFIED",
      "CHECK_IN_DATE_OUT_OF_RANGE", "PSP_NOT_CONFIGURED", "UPSELL_UNAVAILABLE", "KIOSK_PAIRING_INVALID", "OTP_INVALID", "OTP_RATE_LIMITED"
    ]);
    for (const exported of [
      "type CheckInSessionStatus", "type CheckInChannel", "type CheckInGuestStatus", "type IdentityVerificationMethod", "type DocumentCaptureSource",
      "interface CheckInSessionDto", "interface CheckInGuestDto", "interface DocumentCaptureResult", "interface AssignmentCandidate",
      "interface AssignmentSuggestionDto", "interface PropertyCheckInPolicyDto", "interface KioskDeviceDto"
    ]) {
      assert.match(types, new RegExp(`^export ${exported}\\b`, "m"), exported);
    }
    // DTO del viajero sin PII: nombre + últimos 3 del documento, nada más.
    const guestDto = /export interface CheckInGuestDto \{([\s\S]*?)\n\}/.exec(types)[1];
    assert.match(guestDto, /documentNumberLast3: string \| null/);
    assert.doesNotMatch(guestDto, /\b(documentNumber|documentSupportNumber|email|phoneMobile|residenceFullAddress|dateOfBirth): /);
    const kioskDto = /export interface KioskDeviceDto \{([\s\S]*?)\n\}/.exec(types)[1];
    assert.doesNotMatch(kioskDto, /Hash/);
    assert.match(types, /DocumentCaptureResult \{[\s\S]*?fields: DocumentCaptureFields;[\s\S]*?confidence:[\s\S]*?checks: MrzChecks;[\s\S]*?source: DocumentCaptureSource;[\s\S]*?needsReview: /);
    assert.match(types, /AssignmentCandidate \{[\s\S]*?roomId: string;[\s\S]*?number: string;[\s\S]*?score: number;[\s\S]*?reasons: AssignmentReason\[\];[\s\S]*?warnings: string\[\];/);
    assert.match(types, /AssignmentReason \{[\s\S]*?rule: string;[\s\S]*?weight: number;[\s\S]*?detail: string;/);
    assert.match(sharedIndex, /^export \* from "\.\/checkin-types\.js";$/m);
    assert.ok(sharedIndex.indexOf('export * from "./checkin-types.js";') < sharedIndex.indexOf('export type { MoneyString }'), "antes de los export type finales");
  });
});

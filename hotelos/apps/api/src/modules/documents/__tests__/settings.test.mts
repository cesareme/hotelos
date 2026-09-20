// Unit tests · Tanda T9 · lote T9-13 — ajustes de documentos por organización
// (settings.service.ts): esquema zod .strict() del PATCH (decimales
// normalizados, años acotados, aiAllowedKinds del catálogo sin repetidos, al
// menos un campo), valores por defecto del GET sin fila (aiAllowedKinds
// [invoice, delivery_note, receipt], updatedAt null), datos de creación /
// actualización, diff auditable y el servicio con BD simulada (upsert, 403 sin
// documents.admin, 400 con cuerpo inválido). Sin Postgres. Desde apps/api:
//   node --import tsx --test src/modules/documents/__tests__/settings.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PermissionDeniedError, type PermissionKey } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import { HttpError } from "../../../lib/http-error.js";
import {
  aiAllowedKindsOf,
  changedSettings,
  createDocumentSettingsService,
  DEFAULT_AI_ALLOWED_KINDS,
  DEFAULT_DOCUMENT_SETTINGS,
  DocumentSettingsPatchSchema,
  settingsCreateData,
  settingsUpdateData,
  toDocumentSettingsDto
} from "../settings.service.js";

const NOW = new Date("2026-09-20T10:00:00.000Z");

function context(permissions: PermissionKey[]): UserContext {
  return { organizationId: "org_t9", propertyId: "prop_t9a", userId: "usr_admin", fullName: "Prueba T9", deviceId: "dev_t9", permissions };
}

const decimal = (value: string) => ({ toFixed: (scale: number) => Number(value).toFixed(scale) });

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "ds_1",
    organizationId: "org_t9",
    officeSlaBusinessDays: 2,
    autoSendToOffice: false,
    aiAllowedKindsJson: ["invoice", "delivery_note", "receipt"],
    priceTolerancePct: decimal("2"),
    quantityTolerance: decimal("0"),
    amountToleranceAbs: decimal("1"),
    requireMatchForApproval: false,
    retentionYearsDefault: 6,
    letterRetentionYears: 6,
    extendedRetentionYears: 10,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Esquema
// ---------------------------------------------------------------------------

describe("DocumentSettingsPatchSchema (.strict())", () => {
  it("acepta un PATCH parcial y normaliza los decimales a la escala de la columna", () => {
    const parsed = DocumentSettingsPatchSchema.parse({ officeSlaBusinessDays: 3, priceTolerancePct: "2.5", quantityTolerance: 1, amountToleranceAbs: "0,5" });
    assert.deepEqual(parsed, { officeSlaBusinessDays: 3, priceTolerancePct: "2.50", quantityTolerance: "1.000", amountToleranceAbs: "0.50" });
  });

  it("rechaza claves desconocidas, cuerpo vacío, decimales negativos o con más decimales de la cuenta y años fuera de 1..30", () => {
    assert.equal(DocumentSettingsPatchSchema.safeParse({ foo: 1 }).success, false);
    assert.equal(DocumentSettingsPatchSchema.safeParse({}).success, false);
    assert.equal(DocumentSettingsPatchSchema.safeParse({ priceTolerancePct: "-1" }).success, false);
    assert.equal(DocumentSettingsPatchSchema.safeParse({ priceTolerancePct: "2.555" }).success, false);
    assert.equal(DocumentSettingsPatchSchema.safeParse({ priceTolerancePct: "150" }).success, false);
    assert.equal(DocumentSettingsPatchSchema.safeParse({ retentionYearsDefault: 0 }).success, false);
    assert.equal(DocumentSettingsPatchSchema.safeParse({ retentionYearsDefault: 31 }).success, false);
    assert.equal(DocumentSettingsPatchSchema.safeParse({ retentionYearsDefault: 6.5 }).success, false);
    assert.equal(DocumentSettingsPatchSchema.safeParse({ officeSlaBusinessDays: -1 }).success, false);
    assert.equal(DocumentSettingsPatchSchema.safeParse({ officeSlaBusinessDays: 0 }).success, true);
    assert.equal(DocumentSettingsPatchSchema.safeParse({ autoSendToOffice: "sí" }).success, false);
  });

  it("aiAllowedKinds: solo tipos del catálogo, sin repetidos; [] se admite", () => {
    assert.deepEqual(DocumentSettingsPatchSchema.parse({ aiAllowedKinds: ["invoice", "letter", "invoice"] }), { aiAllowedKinds: ["invoice", "letter"] });
    assert.deepEqual(DocumentSettingsPatchSchema.parse({ aiAllowedKinds: [] }), { aiAllowedKinds: [] });
    assert.equal(DocumentSettingsPatchSchema.safeParse({ aiAllowedKinds: ["tarjeta"] }).success, false);
    assert.equal(DocumentSettingsPatchSchema.safeParse({ aiAllowedKinds: "invoice" }).success, false);
  });
});

// ---------------------------------------------------------------------------
// DTO y defaults
// ---------------------------------------------------------------------------

describe("valores por defecto y DTO", () => {
  it("sin fila: defaults de la tanda con aiAllowedKinds [invoice, delivery_note, receipt] y updatedAt null", () => {
    assert.deepEqual(DEFAULT_AI_ALLOWED_KINDS, ["invoice", "delivery_note", "receipt"]);
    assert.deepEqual(toDocumentSettingsDto(null, "org_t9"), {
      organizationId: "org_t9",
      officeSlaBusinessDays: 2,
      autoSendToOffice: false,
      aiAllowedKinds: ["invoice", "delivery_note", "receipt"],
      priceTolerancePct: "2.00",
      quantityTolerance: "0.000",
      amountToleranceAbs: "1.00",
      requireMatchForApproval: false,
      retentionYearsDefault: 6,
      letterRetentionYears: 6,
      updatedAt: null
    });
    assert.equal(DEFAULT_DOCUMENT_SETTINGS.extendedRetentionYears, 10);
  });

  it("con fila: decimales como cadena a escala fija, aiAllowedKindsJson filtrado al catálogo", () => {
    const dto = toDocumentSettingsDto(row({ priceTolerancePct: decimal("3.5"), aiAllowedKindsJson: ["invoice", "tarjeta", 7, "invoice"] }) as never, "org_t9");
    assert.equal(dto.priceTolerancePct, "3.50");
    assert.equal(dto.quantityTolerance, "0.000");
    assert.deepEqual(dto.aiAllowedKinds, ["invoice"]);
    assert.equal(dto.updatedAt, NOW.toISOString());
    assert.deepEqual(aiAllowedKindsOf(null), ["invoice", "delivery_note", "receipt"]);
    assert.deepEqual(aiAllowedKindsOf([]), []);
  });

  it("settingsCreateData / settingsUpdateData: solo los campos presentes; la creación fija aiAllowedKindsJson por defecto", () => {
    assert.deepEqual(settingsUpdateData({ officeSlaBusinessDays: 3 }), { officeSlaBusinessDays: 3 });
    assert.deepEqual(settingsUpdateData({ aiAllowedKinds: ["letter"], requireMatchForApproval: true }), { aiAllowedKindsJson: ["letter"], requireMatchForApproval: true });
    assert.deepEqual(settingsCreateData("org_t9", { officeSlaBusinessDays: 3 }), { organizationId: "org_t9", aiAllowedKindsJson: ["invoice", "delivery_note", "receipt"], officeSlaBusinessDays: 3 });
    assert.deepEqual(settingsCreateData("org_t9", { aiAllowedKinds: [] }), { organizationId: "org_t9", aiAllowedKindsJson: [] });
  });

  it("changedSettings: solo lo que cambia, sin organizationId ni updatedAt", () => {
    const before = toDocumentSettingsDto(null, "org_t9");
    const after = { ...before, officeSlaBusinessDays: 3, aiAllowedKinds: ["invoice" as const], updatedAt: NOW.toISOString() };
    assert.deepEqual(changedSettings(before, after), {
      before: { officeSlaBusinessDays: 2, aiAllowedKinds: ["invoice", "delivery_note", "receipt"] },
      after: { officeSlaBusinessDays: 3, aiAllowedKinds: ["invoice"] }
    });
    assert.deepEqual(changedSettings(before, before), { before: {}, after: {} });
  });
});

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

describe("getDocumentSettings / patchDocumentSettings", () => {
  function fakeDb() {
    const state: { row: ReturnType<typeof row> | null; upserts: Array<{ create: unknown; update: unknown }> } = { row: null, upserts: [] };
    return {
      state,
      documentSettings: {
        findUnique: async () => state.row,
        upsert: async (args: { where: { organizationId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
          state.upserts.push({ create: args.create, update: args.update });
          const merged = state.row ? { ...state.row, ...args.update } : { ...row(), ...args.create };
          for (const key of ["priceTolerancePct", "quantityTolerance", "amountToleranceAbs"] as const) {
            if (typeof merged[key] === "string") merged[key] = decimal(merged[key] as string);
          }
          state.row = merged as ReturnType<typeof row>;
          return state.row;
        }
      }
    };
  }

  type AuditCall = { action: string; entityType: string; actorUserId?: string; beforeJson?: unknown; afterJson?: unknown };

  function serviceWith(db: ReturnType<typeof fakeDb>) {
    const audits: AuditCall[] = [];
    const service = createDocumentSettingsService({
      db: db as unknown as Parameters<typeof createDocumentSettingsService>[0]["db"],
      audit: ((input: AuditCall) => {
        audits.push(input);
        return { id: `aud_${audits.length}` };
      }) as unknown as Parameters<typeof createDocumentSettingsService>[0]["audit"]
    });
    return { service, audits };
  }

  it("GET sin fila devuelve los defaults; PATCH crea la fila con defaults + cambios y después actualiza solo lo enviado; auditoría con el diff", async () => {
    const db = fakeDb();
    const { service, audits } = serviceWith(db);
    const admin = context(["documents.admin"]);
    const initial = await service.getDocumentSettings({ context: admin, organizationId: "org_t9" });
    assert.equal(initial.updatedAt, null);
    assert.equal(initial.officeSlaBusinessDays, 2);
    const created = await service.patchDocumentSettings({ context: admin, organizationId: "org_t9", body: { officeSlaBusinessDays: 3, priceTolerancePct: "2.5" } });
    assert.equal(created.officeSlaBusinessDays, 3);
    assert.equal(created.priceTolerancePct, "2.50");
    assert.deepEqual(created.aiAllowedKinds, ["invoice", "delivery_note", "receipt"]);
    assert.ok(created.updatedAt);
    assert.deepEqual(db.state.upserts[0]!.create, { organizationId: "org_t9", aiAllowedKindsJson: ["invoice", "delivery_note", "receipt"], officeSlaBusinessDays: 3, priceTolerancePct: "2.50" });
    const updated = await service.patchDocumentSettings({ context: admin, organizationId: "org_t9", body: { aiAllowedKinds: ["invoice", "letter"] } });
    assert.deepEqual(updated.aiAllowedKinds, ["invoice", "letter"]);
    assert.equal(updated.officeSlaBusinessDays, 3, "lo no enviado se conserva");
    assert.deepEqual(db.state.upserts[1]!.update, { aiAllowedKindsJson: ["invoice", "letter"] });
    assert.equal(audits.length, 2);
    assert.equal(audits[0]!.action, "DOCUMENT_SETTINGS_UPDATED");
    assert.equal(audits[0]!.entityType, "document_settings");
    assert.equal(audits[0]!.actorUserId, "usr_admin");
    assert.deepEqual(audits[0]!.beforeJson, { officeSlaBusinessDays: 2, priceTolerancePct: "2.00" });
    assert.deepEqual(audits[0]!.afterJson, { officeSlaBusinessDays: 3, priceTolerancePct: "2.50" });
    assert.deepEqual(audits[1]!.afterJson, { aiAllowedKinds: ["invoice", "letter"] });
  });

  it("403 sin documents.admin (GET y PATCH); 400 con cuerpo inválido o vacío", async () => {
    const db = fakeDb();
    const { service, audits } = serviceWith(db);
    await assert.rejects(service.getDocumentSettings({ context: context(["documents.review"]), organizationId: "org_t9" }), PermissionDeniedError);
    await assert.rejects(service.patchDocumentSettings({ context: context(["documents.archive.read"]), organizationId: "org_t9", body: { officeSlaBusinessDays: 3 } }), PermissionDeniedError);
    await assert.rejects(service.patchDocumentSettings({ context: context(["documents.admin"]), organizationId: "org_t9", body: { officeSlaBusinessDays: 99 } }), (error: unknown) => error instanceof HttpError && error.statusCode === 400);
    await assert.rejects(service.patchDocumentSettings({ context: context(["documents.admin"]), organizationId: "org_t9", body: {} }), (error: unknown) => error instanceof HttpError && error.statusCode === 400);
    assert.equal(db.state.upserts.length, 0);
    assert.equal(audits.length, 0, "ningún rechazo audita");
  });
});

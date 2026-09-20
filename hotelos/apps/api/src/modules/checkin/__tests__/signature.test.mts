// Tanda CHK · W2-B: firma del parte con dependencias inyectadas (sin Prisma).
// El almacén es el real (data-URI). From apps/api:
//   node --import tsx --test src/modules/checkin/__tests__/signature.test.mts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import type { GuestRegisterRecord, UserContext } from "../../../lib/demo-store.js";
import { BadRequestError, ConflictError, HttpError, NotFoundError } from "../../../lib/http-error.js";
import { ageAt, decodeSignaturePng, resetSignatureServiceForTests, signGuest, type GuestRegisterRow, type SignatureCheckInGuestRow, type SignatureDeps, type SignaturePropertyRow } from "../signature.service.js";
import { dataUriSignatureStorage } from "../signature-storage.js";

globalThis.fetch = (() => {
  throw new Error("red prohibida en los tests de firma");
}) as typeof fetch;

const NOW = new Date("2026-09-19T15:30:00.000Z");
const CHECKIN_AT = new Date("2026-09-19T15:00:00.000Z");
const CHECKOUT_AT = new Date("2026-09-21T11:00:00.000Z");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(96, 7)]);
const PNG_B64 = PNG.toString("base64");
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const STROKE = { points: 42, durationMs: 1800, bbox: { x: 10, y: 20, width: 300, height: 120 } };

function user(overrides: Partial<UserContext> = {}): UserContext {
  return { organizationId: "org_t", propertyId: "prop_t", userId: "usr_t", fullName: "Recepción", deviceId: "dev_t", permissions: ["guest_register.sign"], ...overrides };
}

function row(overrides: Partial<GuestRegisterRow> = {}): GuestRegisterRow {
  return {
    id: "grr_1",
    propertyId: "prop_t",
    reservationId: "res_1",
    guestId: "gst_1",
    recordType: "checkin",
    status: "ready_to_sign",
    isPrimaryGuest: true,
    isMinor: false,
    providedByAdultGuestId: null,
    firstName: "ANNA",
    surname1: "PRUEBA",
    surname2: null,
    sex: "M",
    nationality: "ESP",
    dateOfBirth: new Date("1990-01-15T00:00:00.000Z"),
    documentType: "DNI",
    documentNumber: "12345678Z",
    documentSupportNumber: "AAA123456",
    residenceFullAddress: "Rúa da Proba 1",
    residenceLocality: "A Coruña",
    residenceCountry: "ES",
    phoneLandline: null,
    phoneMobile: "+34600000001",
    email: "huesped.01@chk.test",
    travellerCount: 1,
    kinshipRelationIfMinor: null,
    contractReference: "CHK-01",
    contractDate: CHECKIN_AT,
    checkinAt: CHECKIN_AT,
    checkoutAt: CHECKOUT_AT,
    propertyFullAddress: null,
    contractedRoomCount: 1,
    internetConnection: null,
    paymentType: "TARJET",
    paymentMethodIdentifier: null,
    paymentHolder: null,
    paymentCardExpiryMonth: null,
    paymentCardExpiryYear: null,
    paymentDate: null,
    paymentReference: null,
    requiredPayloadJson: {},
    validationErrorsJson: [],
    signatureRequired: true,
    signatureObjectKey: null,
    signedAt: null,
    identityVerified: false,
    identityVerifiedBy: null,
    identityVerifiedAt: null,
    identityVerificationMethod: null,
    idImageStored: false,
    idImageDiscarded: true,
    idImageDiscardedAt: CHECKIN_AT,
    retentionUntil: new Date("2029-09-21T11:00:00.000Z"),
    createdBy: "usr_t",
    updatedBy: "usr_t",
    createdAt: CHECKIN_AT,
    updatedAt: CHECKIN_AT,
    ...overrides
  } as unknown as GuestRegisterRow;
}

function guest(overrides: Partial<SignatureCheckInGuestRow> = {}): SignatureCheckInGuestRow {
  return {
    id: "cig_1",
    sessionId: "cis_1",
    propertyId: "prop_t",
    guestRegisterRecordId: "grr_1",
    status: "data_complete",
    isMinor: false,
    ageAtArrival: 36,
    dateOfBirth: new Date("1990-01-15T00:00:00.000Z"),
    session: { id: "cis_1", organizationId: "org_t", propertyId: "prop_t", reservationId: "res_1" },
    ...overrides
  };
}

const PROPERTY: SignaturePropertyRow = { id: "prop_t", organizationId: "org_t", name: "Hotel CHK (prueba)", tradeName: null, address: "Rúa da Proba 1", postalCode: "15001", municipality: "A Coruña", province: "A Coruña", country: "ES", sesEstablishmentCode: "CHK0000001" };

type FakeState = {
  guest: SignatureCheckInGuestRow | null;
  row: GuestRegisterRow | null;
  signatures: Array<Record<string, unknown>>;
  signatureUpdates: Array<{ id: string; data: Record<string, unknown> }>;
  signedCalls: Array<{ guestRegisterRecordId: string; signatureObjectKey: string; correlationId: string }>;
  guestUpdates: Array<{ id: string; data: Record<string, unknown> }>;
  audits: Array<Record<string, unknown>>;
};

function fakeDeps(overrides: Partial<FakeState> = {}): { deps: Partial<SignatureDeps>; state: FakeState } {
  const state: FakeState = { guest: null, row: null, signatures: [], signatureUpdates: [], signedCalls: [], guestUpdates: [], audits: [], ...overrides };
  let seq = 0;
  const deps: Partial<SignatureDeps> = {
    now: () => NOW,
    createId: (prefix) => `${prefix}_${(++seq).toString(16).padStart(16, "0")}`,
    signatureMaxBytes: () => 524_288,
    storage: () => dataUriSignatureStorage,
    loadCheckInGuest: async (id) => (state.guest && state.guest.id === id ? state.guest : null),
    loadGuestRegisterRow: async (id) => (state.row && state.row.id === id ? state.row : null),
    loadProperty: async (id) => (id === "prop_t" ? PROPERTY : null),
    loadReservationDates: async () => ({ arrivalDate: new Date("2026-09-19T00:00:00.000Z"), departureDate: new Date("2026-09-21T00:00:00.000Z") }),
    createSignature: async (data) => {
      state.signatures.push(data as unknown as Record<string, unknown>);
      return { id: String(data.id) };
    },
    updateSignature: async (id, data) => {
      state.signatureUpdates.push({ id, data: data as Record<string, unknown> });
    },
    markGuestRegisterSigned: (async (input: { guestRegisterRecordId: string; signatureObjectKey: string; correlationId: string }) => {
      state.signedCalls.push({ guestRegisterRecordId: input.guestRegisterRecordId, signatureObjectKey: input.signatureObjectKey, correlationId: input.correlationId });
      const current = state.row!;
      const record: GuestRegisterRecord = {
        id: current.id,
        propertyId: current.propertyId,
        reservationId: current.reservationId ?? undefined,
        guestId: current.guestId ?? undefined,
        recordType: "checkin",
        status: "ready_to_submit",
        firstName: current.firstName ?? undefined,
        surname1: current.surname1 ?? undefined,
        sex: current.sex ?? undefined,
        nationality: current.nationality ?? undefined,
        dateOfBirth: "1990-01-15",
        documentType: current.documentType ?? undefined,
        documentNumber: current.documentNumber ?? undefined,
        documentSupportNumber: current.documentSupportNumber ?? undefined,
        residenceFullAddress: current.residenceFullAddress ?? undefined,
        residenceLocality: current.residenceLocality ?? undefined,
        residenceCountry: current.residenceCountry ?? undefined,
        phoneMobile: current.phoneMobile ?? undefined,
        email: current.email ?? undefined,
        travellerCount: current.travellerCount ?? undefined,
        contractReference: current.contractReference ?? undefined,
        checkinAt: CHECKIN_AT.toISOString(),
        checkoutAt: CHECKOUT_AT.toISOString(),
        signatureRequired: true,
        signatureObjectKey: input.signatureObjectKey,
        signedAt: NOW.toISOString(),
        requiredPayloadJson: {},
        retentionUntil: "2029-09-21T11:00:00.000Z",
        createdAt: CHECKIN_AT.toISOString()
      };
      return record;
    }) as unknown as SignatureDeps["markGuestRegisterSigned"],
    updateCheckInGuest: async (id, data) => {
      state.guestUpdates.push({ id, data: data as Record<string, unknown> });
    },
    recordAuditEvent: ((input: Record<string, unknown>) => {
      state.audits.push(input);
      return input;
    }) as unknown as SignatureDeps["recordAuditEvent"]
  };
  return { deps, state };
}

function conflictWith(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ConflictError && (error.details as { code?: string }).code === code;
}

describe("signGuest", () => {
  afterEach(() => resetSignatureServiceForTests());

  it("menor < 14 → SIGNATURE_NOT_REQUIRED", async () => {
    // Por bandera del viajero…
    const flagged = fakeDeps({ guest: guest({ isMinor: true, ageAtArrival: 9 }), row: row() });
    resetSignatureServiceForTests(flagged.deps);
    await assert.rejects(signGuest({ context: user(), checkInGuestId: "cig_1", pngBase64: PNG_B64, strokeMeta: STROKE, method: "touch_portal" }), conflictWith("SIGNATURE_NOT_REQUIRED"));
    assert.equal(flagged.state.signatures.length, 0);
    assert.equal(flagged.state.signedCalls.length, 0);
    // …y por edad calculada desde la fecha de nacimiento a la llegada (sin viajero de check-in).
    const computed = fakeDeps({ row: row({ dateOfBirth: new Date("2017-03-01T00:00:00.000Z") }) });
    resetSignatureServiceForTests(computed.deps);
    await assert.rejects(signGuest({ context: user(), guestRegisterRecordId: "grr_1", pngBase64: PNG_B64, strokeMeta: STROKE, method: "touch_reception" }), (error: unknown) => conflictWith("SIGNATURE_NOT_REQUIRED")(error) && (error as ConflictError & { details: { ageAtArrival: number } }).details.ageAtArrival === 9);
    // 14 cumplidos el día de la llegada sí firma.
    assert.equal(ageAt(new Date("2012-09-19T00:00:00.000Z"), new Date("2026-09-19T15:00:00.000Z")), 14);
    assert.equal(ageAt(new Date("2012-09-20T00:00:00.000Z"), new Date("2026-09-19T15:00:00.000Z")), 13);
  });

  it("parte incompleto → GUEST_REGISTER_INCOMPLETE", async () => {
    // Sin parte enlazado al viajero.
    const noRecord = fakeDeps({ guest: guest({ guestRegisterRecordId: null }) });
    resetSignatureServiceForTests(noRecord.deps);
    await assert.rejects(signGuest({ context: user(), checkInGuestId: "cig_1", pngBase64: PNG_B64, strokeMeta: STROKE, method: "touch_portal" }), conflictWith("GUEST_REGISTER_INCOMPLETE"));
    // Parte sin número de documento ni teléfono: el validador (signatureRequired:false) lista lo que falta.
    const incomplete = fakeDeps({ guest: guest(), row: row({ documentNumber: null, phoneMobile: null }) });
    resetSignatureServiceForTests(incomplete.deps);
    await assert.rejects(
      signGuest({ context: user(), checkInGuestId: "cig_1", pngBase64: PNG_B64, strokeMeta: STROKE, method: "touch_portal" }),
      (error: unknown) => {
        if (!conflictWith("GUEST_REGISTER_INCOMPLETE")(error)) return false;
        const details = (error as ConflictError).details as { missing: string[]; issues: string[] };
        assert.ok(details.missing.includes("documentNumber"));
        assert.ok(details.missing.includes("phoneMobile"));
        assert.ok(!details.issues.includes("signature_required"), "la firma que falta no cuenta como incompleto");
        return true;
      }
    );
    assert.equal(incomplete.state.signatures.length, 0);
    // Parte inexistente → 404 opaco.
    const missing = fakeDeps({ guest: guest({ guestRegisterRecordId: "grr_missing" }) });
    resetSignatureServiceForTests(missing.deps);
    await assert.rejects(signGuest({ context: user(), checkInGuestId: "cig_1", pngBase64: PNG_B64, strokeMeta: STROKE, method: "touch_portal" }), NotFoundError);
  });

  it("sha256 y retención 3 años", async () => {
    const { deps, state } = fakeDeps({ guest: guest(), row: row() });
    resetSignatureServiceForTests(deps);
    const result = await signGuest({ context: user(), checkInGuestId: "cig_1", pngBase64: `data:image/png;base64,${PNG_B64}`, svg: "<svg xmlns='http://www.w3.org/2000/svg'><path d='M1 1L2 2'/></svg>", strokeMeta: STROKE, method: "touch_portal", ip: "203.0.113.5", userAgent: "Mozilla/5.0 (test)", sessionId: "gps_1", correlationId: "corr_sig" });

    assert.equal(result.sha256, sha(PNG));
    assert.equal(result.retentionUntil, "2029-09-21T11:00:00.000Z", "salida + 3 años (art. 5.3)");
    assert.equal(result.signedAt, NOW.toISOString());
    assert.equal(result.checkInGuestStatus, "signed");
    assert.equal(result.guestRegisterStatus, "ready_to_submit");
    assert.equal(result.method, "touch_portal");

    const created = state.signatures[0]!;
    assert.equal(created.sha256, sha(PNG));
    assert.equal((created.retentionUntil as Date).toISOString(), "2029-09-21T11:00:00.000Z");
    assert.equal(created.method, "touch_portal");
    assert.equal(created.ip, "203.0.113.5");
    assert.equal(created.userAgent, "Mozilla/5.0 (test)");
    assert.equal(created.sessionId, "gps_1");
    assert.equal(created.checkInGuestId, "cig_1");
    assert.equal(created.guestRegisterRecordId, "grr_1");
    assert.equal(created.organizationId, "org_t");
    const stored = await dataUriSignatureStorage.get(String(created.objectKey));
    assert.ok(stored && stored.mime === "image/png" && stored.bytes.equals(PNG), "el almacén devuelve el PNG intacto");
    const meta = created.strokeMetaJson as { points: number; durationMs: number; bbox: Record<string, number>; svgObjectKey?: string; svgSha256?: string };
    assert.equal(meta.points, 42);
    assert.equal(meta.durationMs, 1800);
    assert.deepEqual(meta.bbox, STROKE.bbox);
    assert.match(meta.svgObjectKey ?? "", /^data:image\/svg\+xml;base64,/);
    assert.equal(meta.svgSha256?.length, 64);

    // PDF del parte: hash de los bytes guardados y %PDF- de una página con la firma referenciada.
    assert.equal(state.signatureUpdates.length, 1);
    const update = state.signatureUpdates[0]!;
    assert.equal(update.id, result.signatureId);
    const pdf = await dataUriSignatureStorage.get(String(update.data.pdfObjectKey));
    assert.ok(pdf && pdf.mime === "application/pdf");
    assert.equal(update.data.pdfSha256, sha(pdf!.bytes));
    assert.equal(result.pdfSha256, sha(pdf!.bytes));
    const text = pdf!.bytes.toString("latin1");
    assert.ok(text.startsWith("%PDF-1.4"));
    assert.equal(text.match(/\/Type \/Page(?!s)/g)?.length, 1);
    assert.ok(text.includes(result.sha256));
    assert.ok(text.includes("(12345678Z)"));
    assert.ok(text.includes("Orden INT/1922/2003"));

    assert.deepEqual(state.guestUpdates, [{ id: "cig_1", data: { status: "signed" } }]);
    const audit = state.audits.find((a) => a.action === "CHECKIN_GUEST_SIGNED")!;
    assert.equal(audit.entityType, "signature");
    assert.equal(audit.entityId, result.signatureId);
    assert.equal(audit.correlationId, "corr_sig");
  });

  it("markGuestRegisterSigned recibe el id de la firma", async () => {
    const { deps, state } = fakeDeps({ guest: guest(), row: row() });
    resetSignatureServiceForTests(deps);
    const result = await signGuest({ context: user(), checkInGuestId: "cig_1", pngBase64: PNG_B64, strokeMeta: STROKE, method: "touch_kiosk" });
    assert.equal(state.signedCalls.length, 1);
    assert.equal(state.signedCalls[0]!.guestRegisterRecordId, "grr_1");
    assert.equal(state.signedCalls[0]!.signatureObjectKey, result.signatureId);
    assert.equal(state.signatures[0]!.id, result.signatureId, "la fila signatures se crea ANTES de marcar el parte con su id");
    assert.match(result.signatureId, /^sgn_[0-9a-f]{16}$/);
    assert.doesNotMatch(result.signatureId, /^sig_(drawer|manual|demo)/, "nunca los literales fijos del drawer/demo");
    assert.ok(state.signedCalls[0]!.correlationId.startsWith("corr_"), "sin correlationId se genera uno");
    // Un parte firmado directamente (drawer, sin viajero de check-in) usa el mismo camino sin tocar CheckInGuest.
    const direct = fakeDeps({ row: row() });
    resetSignatureServiceForTests(direct.deps);
    const signed = await signGuest({ context: user(), guestRegisterRecordId: "grr_1", pngBase64: PNG_B64, strokeMeta: STROKE, method: "touch_reception" });
    assert.equal(signed.checkInGuestId, null);
    assert.equal(signed.checkInGuestStatus, null);
    assert.equal(direct.state.guestUpdates.length, 0);
    assert.equal(direct.state.signedCalls[0]!.signatureObjectKey, signed.signatureId);
  });

  it("valida trazo mínimo, PNG, tamaño, método y ámbito", async () => {
    const { deps, state } = fakeDeps({ guest: guest(), row: row() });
    resetSignatureServiceForTests(deps);
    await assert.rejects(signGuest({ context: user(), checkInGuestId: "cig_1", pngBase64: PNG_B64, strokeMeta: { ...STROKE, points: 7 }, method: "touch_portal" }), /al menos 8 puntos/);
    await assert.rejects(signGuest({ context: user(), checkInGuestId: "cig_1", pngBase64: Buffer.from("GIF89a-not-png").toString("base64"), strokeMeta: STROKE, method: "touch_portal" }), /no es un PNG/);
    await assert.rejects(signGuest({ context: user(), checkInGuestId: "cig_1", pngBase64: `data:image/jpeg;base64,${PNG_B64}`, strokeMeta: STROKE, method: "touch_portal" }), /image\/png/);
    await assert.rejects(signGuest({ context: user(), checkInGuestId: "cig_1", pngBase64: PNG_B64, strokeMeta: STROKE, method: "wet_ink" as never }), BadRequestError);
    await assert.rejects(signGuest({ context: user(), pngBase64: PNG_B64, strokeMeta: STROKE, method: "touch_portal" }), /checkInGuestId o guestRegisterRecordId/);
    assert.throws(() => decodeSignaturePng(PNG_B64, 50), (error: unknown) => error instanceof HttpError && error.statusCode === 413);
    await assert.rejects(signGuest({ context: user({ organizationId: "org_other" }), checkInGuestId: "cig_1", pngBase64: PNG_B64, strokeMeta: STROKE, method: "touch_portal" }), NotFoundError);
    await assert.rejects(signGuest({ context: user({ permissions: [] }), checkInGuestId: "cig_1", pngBase64: PNG_B64, strokeMeta: STROKE, method: "touch_portal" }), (error: unknown) => (error as { statusCode?: number }).statusCode === 403 && /guest_register\.sign/.test(String((error as Error).message)));
    assert.equal(state.signatures.length, 0);
  });
});

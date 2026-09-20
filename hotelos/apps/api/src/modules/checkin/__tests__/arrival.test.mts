// Tanda CHK · W3-A: llegada (completeCheckIn) con dependencias inyectadas (sin
// Prisma ni servicios reales). From apps/api:
//   node --import tsx --test src/modules/checkin/__tests__/arrival.test.mts
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { PropertyCheckInPolicyDto } from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import { ConflictError, HttpError } from "../../../lib/http-error.js";
import {
  arrivalWindow,
  balanceVerdict,
  completeCheckIn,
  identityVerdict,
  isRoomReady,
  precheckCheckIn,
  profileFillFromTraveller,
  resetArrivalServiceForTests,
  signatureGaps,
  type ArrivalDeps,
  type ArrivalGuestRow,
  type ArrivalRecordRow,
  type ArrivalReservationRow,
  type ArrivalRoomRow,
  type ArrivalSessionRow
} from "../arrival.service.js";

globalThis.fetch = (() => {
  throw new Error("red prohibida en los tests de llegada");
}) as typeof fetch;

const NOW = new Date("2026-10-02T15:00:00.000Z");
const ARRIVAL = new Date("2026-10-02T00:00:00.000Z");
const DEPARTURE = new Date("2026-10-04T00:00:00.000Z");
const PROP = "prop_t";
const ORG = "org_t";
const TOKEN = "token-de-prueba";

function policy(overrides: Partial<PropertyCheckInPolicyDto> = {}): PropertyCheckInPolicyDto {
  return {
    propertyId: PROP,
    selfCheckInEnabled: true,
    inviteDaysBefore: 3,
    reminderDaysBefore: 1,
    allowedVerificationMethods: ["visual_reception", "mrz_checksum", "otp_email"],
    requireVisualCheckAtKiosk: true,
    requireInspectedRoom: false,
    depositPolicy: "balance",
    depositAmount: null,
    allowWalkIn: false,
    allowUpgradeSuggestion: true,
    autoAssignLevel: "suggest_and_confirm",
    assignmentWeights: {},
    welcomeChannelOrder: ["email"],
    guestConsentText: null,
    aiDisclosureText: null,
    updatedAt: "",
    ...overrides
  };
}

function guest(overrides: Partial<ArrivalGuestRow> = {}): ArrivalGuestRow {
  return { id: "cg_1", guestId: "gst_1", guestRegisterRecordId: "grr_1", isPrimary: true, ordinal: 0, status: "signed", isMinor: false, identityVerificationMethod: "mrz_checksum", identityVerifiedAt: null, firstName: "ANNA", ...overrides };
}

function record(overrides: Partial<ArrivalRecordRow> = {}): ArrivalRecordRow {
  return { id: "grr_1", guestId: "gst_1", status: "signed", isMinor: false, signedAt: new Date("2026-10-01T10:00:00.000Z"), signatureObjectKey: "sgn_0123456789abcdef", identityVerified: false, identityVerificationMethod: null, ...overrides };
}

function room(overrides: Partial<ArrivalRoomRow> = {}): ArrivalRoomRow {
  return { id: "room_101", propertyId: PROP, number: "101", floor: "1", roomTypeId: "rt_dbl", status: "clean", housekeepingStatus: "clean", maintenanceStatus: "ok", sellable: true, ...overrides };
}

function reservation(overrides: Partial<ArrivalReservationRow> = {}): ArrivalReservationRow {
  return { id: "res_1", code: "CHK-T-1", propertyId: PROP, status: "confirmed", arrivalDate: ARRIVAL, departureDate: DEPARTURE, roomTypeId: "rt_dbl", assignedRoomId: "room_101", totalAmount: "200.00", ...overrides };
}

function session(overrides: Partial<ArrivalSessionRow> = {}): ArrivalSessionRow {
  return { id: "cis_1", organizationId: ORG, propertyId: PROP, reservationId: "res_1", status: "ready_for_arrival", arrivedAt: null, checkedInAt: null, paymentStatus: "paid", kioskDeviceId: null, guests: [guest()], ...overrides };
}

const serviceContext = (userId: string): UserContext => ({ organizationId: ORG, propertyId: PROP, userId, fullName: "Check-in automatizado", deviceId: "checkin", permissions: ["pms.checkin.execute", "pms.reservation.read", "pms.reservation.modify"], assignedPropertyIds: [PROP], orgScope: false });

type Calls = { checkIn: Array<Record<string, unknown>>; suggest: number; confirm: Array<{ suggestionId: string; roomId: string | null | undefined }>; ses: string[]; welcome: number; sessionUpdates: Array<Record<string, unknown>>; audits: Array<{ action: string; afterJson: unknown }>; folio: number; key: number; ensureRecords: number };

type World = {
  session: ArrivalSessionRow;
  reservation: ArrivalReservationRow;
  policy: PropertyCheckInPolicyDto;
  records: ArrivalRecordRow[];
  rooms: ArrivalRoomRow[];
  candidates: string[];
  folio: { balanceDue: number; paymentsTotal: number; currency: string | null } | null;
  sesError?: (recordId: string) => Error | null;
  hkEta?: Date | null;
  /** RoomBlock que solapan la estancia por habitación (corrector REV3-01). */
  blocks?: Record<string, { id: string; fromDate: string; toDate: string; reason: string }>;
  /** Partes creados por recepción (corrector REV3-04): viajeros devueltos con guestRegisterRecordId. */
  ensureRecords?: (guests: ArrivalGuestRow[]) => ArrivalGuestRow[];
  calls: Calls;
};

function world(overrides: Partial<Omit<World, "calls">> = {}): World {
  return {
    session: session(),
    reservation: reservation(),
    policy: policy(),
    records: [record()],
    rooms: [room()],
    candidates: [],
    folio: { balanceDue: 0, paymentsTotal: 200, currency: "EUR" },
    calls: { checkIn: [], suggest: 0, confirm: [], ses: [], welcome: 0, sessionUpdates: [], audits: [], folio: 0, key: 0, ensureRecords: 0 },
    ...overrides
  };
}

function depsFor(w: World): Partial<ArrivalDeps> {
  return {
    now: () => NOW,
    createId: (prefix) => `${prefix}_fixed`,
    verifyGuestToken: async (token) => (token === TOKEN ? { reservationId: w.reservation.id, propertyId: PROP } : null),
    loadSession: async (reservationId) => (reservationId === w.session.reservationId ? w.session : null),
    loadReservation: async (id) => (id === w.reservation.id ? w.reservation : null),
    loadProperty: async () => ({ organizationId: ORG, timezone: "UTC" }),
    loadPolicy: async () => w.policy,
    missingFields: () => [],
    loadRecords: async (ids) => w.records.filter((r) => ids.includes(r.id)),
    loadRoom: async (roomId) => w.rooms.find((r) => r.id === roomId) ?? null,
    loadRooms: async (ids) => w.rooms.filter((r) => ids.includes(r.id)),
    loadRoomBlock: async (roomId) => w.blocks?.[roomId] ?? null,
    ensureGuestRegisterRecords: async (sessionRow) => {
      w.calls.ensureRecords += 1;
      const guests = w.ensureRecords ? w.ensureRecords(sessionRow.guests) : sessionRow.guests;
      w.session = { ...w.session, guests };
      return guests;
    },
    loadChosenRoomId: async () => null,
    loadHousekeepingEta: async () => w.hkEta ?? null,
    folioBalance: async () => w.folio,
    loadGuestProfile: async () => null,
    updateGuestProfile: async () => undefined,
    businessDate: async () => "2026-10-02",
    todayInTimezone: () => "2026-10-02",
    serviceContext: async (_propertyId, actor) => serviceContext(actor.kind === "guest" ? `guest:${actor.sessionId}` : actor.kind === "kiosk" ? `kiosk:${actor.deviceId}` : `system:checkin:${actor.job}`),
    suggestForReservation: (async () => {
      w.calls.suggest += 1;
      return {
        id: "asg_1",
        propertyId: PROP,
        reservationId: w.reservation.id,
        sessionId: w.session.id,
        candidates: w.candidates.map((roomId) => ({ roomId, number: w.rooms.find((r) => r.id === roomId)?.number ?? roomId, score: 50, reasons: [], warnings: [] })),
        rejectedCount: 0,
        chosenRoomId: null,
        confidence: 0.5,
        rulesVersion: "test",
        source: "rules",
        automationLevel: "suggest_and_confirm",
        status: "suggested",
        decidedBy: null,
        decidedAt: null,
        aiToolCallId: null,
        createdAt: NOW.toISOString(),
        rejected: [],
        dataNotes: [],
        housekeepingAlerts: [],
        persisted: true
      };
    }) as unknown as ArrivalDeps["suggestForReservation"],
    confirmSuggestion: (async (input: { suggestionId: string; roomId?: string | null }) => {
      w.calls.confirm.push({ suggestionId: input.suggestionId, roomId: input.roomId });
      w.reservation = { ...w.reservation, assignedRoomId: input.roomId ?? null };
      return { suggestion: {}, reservation: { assignedRoomId: input.roomId ?? null } };
    }) as unknown as ArrivalDeps["confirmSuggestion"],
    ensurePrimaryFolio: (async () => {
      w.calls.folio += 1;
      return { folio: { id: "fol_1" }, created: false };
    }) as unknown as ArrivalDeps["ensurePrimaryFolio"],
    checkInReservation: (async (input: Record<string, unknown>) => {
      w.calls.checkIn.push(input);
      w.reservation = { ...w.reservation, status: "checked_in", assignedRoomId: String(input.roomId) };
      return { id: w.reservation.id, status: "checked_in" };
    }) as unknown as ArrivalDeps["checkInReservation"],
    issueWalletPass: (async () => {
      w.calls.key += 1;
      return { serialNumber: "abc123", validFrom: "2026-10-02", validUntil: "2026-10-04", signedByApple: false, appleWalletPass: { unsigned: true }, googleWalletObject: { id: "g" }, mobileKey: { qrPayload: "hotelos://unlock?serial=abc123" } };
    }) as unknown as ArrivalDeps["issueWalletPass"],
    queueSesHospedajesSubmission: (async (input: { guestRegisterRecordId: string }) => {
      const error = w.sesError?.(input.guestRegisterRecordId);
      if (error) throw error;
      w.calls.ses.push(input.guestRegisterRecordId);
      return { id: `ses_${input.guestRegisterRecordId}`, status: "queued" };
    }) as unknown as ArrivalDeps["queueSesHospedajesSubmission"],
    sendWelcomeMessage: (async () => {
      w.calls.welcome += 1;
      return { status: "simulated", channel: "email", deliveryId: "nd_1" };
    }) as unknown as ArrivalDeps["sendWelcomeMessage"],
    updateSession: async (_id, data) => {
      w.calls.sessionUpdates.push(data as Record<string, unknown>);
      w.session = { ...w.session, ...(data as Partial<ArrivalSessionRow>) };
    },
    recordAuditEvent: ((input: { action: string; afterJson: unknown }) => {
      w.calls.audits.push({ action: input.action, afterJson: input.afterJson });
      return {} as never;
    }) as unknown as ArrivalDeps["recordAuditEvent"],
    recordDomainEvent: (() => ({}) as never) as unknown as ArrivalDeps["recordDomainEvent"]
  };
}

async function expectConflict(run: () => Promise<unknown>, code: string): Promise<Record<string, any>> {
  try {
    await run();
  } catch (error) {
    assert.ok(error instanceof ConflictError, `esperaba ConflictError, llegó ${String(error)}`);
    const details = (error as HttpError).details as Record<string, any>;
    assert.equal(details.code, code, `code ${details.code} ≠ ${code}: ${(error as Error).message}`);
    return details;
  }
  assert.fail(`esperaba 409 ${code}`);
}

afterEach(() => resetArrivalServiceForTests());

describe("W3-A · funciones puras", () => {
  it("arrivalWindow: ±1 día sobre la mayor de fecha de negocio y hoy local", () => {
    assert.equal(arrivalWindow({ businessDate: "2026-10-01", localToday: "2026-10-02", arrivalDate: ARRIVAL }).withinWindow, true);
    assert.equal(arrivalWindow({ businessDate: "2026-10-03", localToday: "2026-10-02", arrivalDate: ARRIVAL }).offsetDays, -1);
    const out = arrivalWindow({ businessDate: "2026-09-29", localToday: "2026-09-30", arrivalDate: ARRIVAL });
    assert.deepEqual([out.withinWindow, out.offsetDays, out.referenceDate], [false, 2, "2026-09-30"]);
  });

  it("identityVerdict: mrz_checksum sin fecha cuenta solo si la política lo admite y el kiosco no exige cotejo visual", () => {
    const allowed = ["visual_reception", "mrz_checksum"];
    assert.equal(identityVerdict({ guest: guest(), record: null, allowedMethods: allowed, actor: "guest", requireVisualCheckAtKiosk: true }).verified, true);
    assert.deepEqual(identityVerdict({ guest: guest(), record: null, allowedMethods: ["visual_reception"], actor: "guest", requireVisualCheckAtKiosk: true }), { verified: false, method: "mrz_checksum", reason: "method_not_allowed" });
    assert.deepEqual(identityVerdict({ guest: guest(), record: null, allowedMethods: allowed, actor: "kiosk", requireVisualCheckAtKiosk: true }), { verified: false, method: "mrz_checksum", reason: "kiosk_visual_check" });
    assert.equal(identityVerdict({ guest: guest(), record: null, allowedMethods: allowed, actor: "kiosk", requireVisualCheckAtKiosk: false }).verified, true);
    // Cotejo visual de recepción sobre el parte (markGuestRegisterIdentityVerified) vale aunque el viajero no lleve fecha.
    assert.deepEqual(identityVerdict({ guest: guest({ identityVerificationMethod: null }), record: record({ identityVerified: true, identityVerificationMethod: "visual_reception" }), allowedMethods: allowed, actor: "guest", requireVisualCheckAtKiosk: true }), { verified: true, method: "visual_reception" });
    assert.deepEqual(identityVerdict({ guest: guest({ identityVerificationMethod: null }), record: null, allowedMethods: allowed, actor: "guest", requireVisualCheckAtKiosk: true }), { verified: false, method: null, reason: "no_method" });
    // OTP verificado con fecha pero método fuera de la política → no cuenta.
    assert.equal(identityVerdict({ guest: guest({ identityVerificationMethod: "otp_email", identityVerifiedAt: NOW }), record: null, allowedMethods: allowed, actor: "guest", requireVisualCheckAtKiosk: true }).verified, false);
    assert.equal(identityVerdict({ guest: guest({ identityVerificationMethod: "otp_email", identityVerifiedAt: NOW }), record: null, allowedMethods: [...allowed, "otp_email"], actor: "guest", requireVisualCheckAtKiosk: true }).verified, true);
  });

  it("balanceVerdict: none no exige; balance mira el folio o el paymentStatus; fixed compara con lo cobrado", () => {
    const res = reservation();
    assert.deepEqual(balanceVerdict({ policy: policy({ depositPolicy: "none" }), paymentStatus: "none", folio: { balanceDue: 200, paymentsTotal: 0, currency: "EUR" }, reservation: res }), { ok: true });
    assert.deepEqual(balanceVerdict({ policy: policy(), paymentStatus: "none", folio: { balanceDue: 200, paymentsTotal: 0, currency: "EUR" }, reservation: res }), { ok: false, required: 200, paid: 0, balanceDue: 200 });
    // Corrector REV3-02: `at_reception` (sin PSP) solo cuenta como pagado si la política admite el pago en recepción.
    assert.deepEqual(balanceVerdict({ policy: policy(), paymentStatus: "at_reception", folio: { balanceDue: 200, paymentsTotal: 0, currency: "EUR" }, reservation: res }), { ok: false, required: 200, paid: 0, balanceDue: 200 });
    assert.deepEqual(balanceVerdict({ policy: policy({ allowPayAtReception: true }), paymentStatus: "at_reception", folio: { balanceDue: 200, paymentsTotal: 0, currency: "EUR" }, reservation: res }), { ok: true });
    assert.deepEqual(balanceVerdict({ policy: policy(), paymentStatus: "paid", folio: { balanceDue: 200, paymentsTotal: 0, currency: "EUR" }, reservation: res }), { ok: true });
    assert.deepEqual(balanceVerdict({ policy: policy(), paymentStatus: "none", folio: { balanceDue: 0, paymentsTotal: 200, currency: "EUR" }, reservation: res }), { ok: true });
    assert.deepEqual(balanceVerdict({ policy: policy({ depositPolicy: "fixed", depositAmount: "50.00" }), paymentStatus: "none", folio: { balanceDue: 150, paymentsTotal: 50, currency: "EUR" }, reservation: res }), { ok: true });
    assert.equal(balanceVerdict({ policy: policy({ depositPolicy: "first_night" }), paymentStatus: "none", folio: { balanceDue: 200, paymentsTotal: 0, currency: "EUR" }, reservation: res }).ok, false);
  });

  it("isRoomReady: libre, sin bloqueo, limpia (inspeccionada si la política lo exige) y de la propiedad", () => {
    const ready = { propertyId: PROP, requireInspectedRoom: false };
    assert.equal(isRoomReady(room(), ready), true);
    assert.equal(isRoomReady(room({ housekeepingStatus: "dirty", status: "dirty" }), ready), false);
    assert.equal(isRoomReady(room({ status: "occupied" }), ready), false);
    assert.equal(isRoomReady(room({ sellable: false }), ready), false);
    assert.equal(isRoomReady(room({ maintenanceStatus: "blocked" }), ready), false);
    assert.equal(isRoomReady(room({ propertyId: "otra" }), ready), false);
    assert.equal(isRoomReady(room(), { ...ready, requireInspectedRoom: true }), false);
    assert.equal(isRoomReady(room({ housekeepingStatus: "inspected", status: "inspected" }), { ...ready, requireInspectedRoom: true }), true);
  });

  it("profileFillFromTraveller: solo completa los campos vacíos del perfil, nunca pisa los existentes", () => {
    const profile = { surname1: "Delta", surname2: null, sex: null, nationality: "ESP", dateOfBirth: null, documentType: null, documentNumber: "", documentSupportNumber: null, documentExpiryDate: null, email: "a@b.test", mobilePhone: null, residenceAddress: null, residenceLocality: null, residenceCountry: null };
    const patch = profileFillFromTraveller(profile, { surname1: "OTRO", surname2: "", sex: "H", nationality: "UTO", documentType: "PASSPORT", documentNumber: "XB7654321", email: "otro@b.test", phoneMobile: "+34600000102", residenceFullAddress: "Rúa 2", residenceLocality: "A Coruña", residenceCountry: "ESP", dateOfBirth: new Date("1988-01-20T00:00:00.000Z") });
    assert.deepEqual(patch, { sex: "H", dateOfBirth: new Date("1988-01-20T00:00:00.000Z"), documentType: "PASSPORT", documentNumber: "XB7654321", mobilePhone: "+34600000102", residenceAddress: "Rúa 2", residenceLocality: "A Coruña", residenceCountry: "ESP" });
    assert.deepEqual(profileFillFromTraveller(profile, {}), {});
  });

  it("signatureGaps: adulto sin firma, sin parte o con literal sig_*; el menor < 14 no bloquea", () => {
    const records = new Map([["grr_1", record()], ["grr_2", record({ id: "grr_2", signedAt: null, signatureObjectKey: null })], ["grr_3", record({ id: "grr_3", signatureObjectKey: "sig_drawer_checkin" })], ["grr_4", record({ id: "grr_4", isMinor: true, signedAt: null, signatureObjectKey: null })]]);
    const gaps = signatureGaps(
      [guest(), guest({ id: "cg_2", ordinal: 1, guestRegisterRecordId: "grr_2", isPrimary: false }), guest({ id: "cg_3", ordinal: 2, guestRegisterRecordId: "grr_3", isPrimary: false }), guest({ id: "cg_4", ordinal: 3, guestRegisterRecordId: "grr_4", isPrimary: false, isMinor: true }), guest({ id: "cg_5", ordinal: 4, guestRegisterRecordId: null, isPrimary: false })],
      records
    );
    assert.deepEqual(gaps, [
      { checkInGuestId: "cg_2", ordinal: 1, reason: "signature" },
      { checkInGuestId: "cg_3", ordinal: 2, reason: "legacy_signature" },
      { checkInGuestId: "cg_5", ordinal: 4, reason: "guest_register_record" }
    ]);
  });
});

describe("W3-A · completeCheckIn con dobles", () => {
  it("identidad no verificada → 409 IDENTITY_NOT_VERIFIED y nada se ejecuta", async () => {
    const w = world({ policy: policy({ allowedVerificationMethods: ["visual_reception"] }) });
    resetArrivalServiceForTests(depsFor(w));
    const details = await expectConflict(() => completeCheckIn({ actor: "guest", token: TOKEN, reservationId: "res_1" }), "IDENTITY_NOT_VERIFIED");
    assert.equal(details.reason, "method_not_allowed");
    assert.deepEqual(details.allowedMethods, ["visual_reception"]);
    assert.equal(w.calls.checkIn.length, 0);
    assert.equal(w.calls.suggest, 0);
  });

  it("parte sin firmar → 409 GUEST_REGISTER_INCOMPLETE con el viajero", async () => {
    const w = world({ records: [record({ signedAt: null, signatureObjectKey: null })] });
    resetArrivalServiceForTests(depsFor(w));
    const details = await expectConflict(() => completeCheckIn({ actor: "guest", token: TOKEN, reservationId: "res_1" }), "GUEST_REGISTER_INCOMPLETE");
    assert.deepEqual(details.missing, [{ checkInGuestId: "cg_1", ordinal: 0, reason: "signature" }]);
    assert.equal(w.calls.checkIn.length, 0);
  });

  it("menor sin firma no bloquea: el check-in se hace con la firma del adulto", async () => {
    const minor = guest({ id: "cg_2", guestId: "gst_2", guestRegisterRecordId: "grr_2", isPrimary: false, ordinal: 1, status: "data_complete", isMinor: true, identityVerificationMethod: null });
    const w = world({ session: session({ guests: [guest(), minor] }), records: [record(), record({ id: "grr_2", guestId: "gst_2", isMinor: true, status: "ready_to_submit", signedAt: null, signatureObjectKey: null })] });
    resetArrivalServiceForTests(depsFor(w));
    const result = await completeCheckIn({ actor: "guest", token: TOKEN, reservationId: "res_1" });
    assert.equal(result.room.number, "101");
    assert.equal(w.calls.checkIn.length, 1);
    assert.equal(w.calls.checkIn[0]!.signatureObjectKey, "sgn_0123456789abcdef");
    assert.deepEqual(w.calls.ses.sort(), ["grr_1", "grr_2"], "un encolado SES por parte, menor incluido");
    assert.equal(result.ses.status, "queued");
    assert.equal(w.session.status, "checked_in");
    assert.equal(w.calls.audits.some((a) => a.action === "GUEST_SELF_CHECKED_IN"), true);
  });

  it("habitación sucia → reasigna a otra lista de la misma categoría por la sugerencia y la confirma", async () => {
    const dirty = room({ housekeepingStatus: "dirty", status: "dirty" });
    const sup = room({ id: "room_301", number: "301", roomTypeId: "rt_sup" });
    const clean = room({ id: "room_102", number: "102" });
    const w = world({ rooms: [dirty, sup, clean], candidates: ["room_301", "room_102"] });
    resetArrivalServiceForTests(depsFor(w));
    const result = await completeCheckIn({ actor: "guest", token: TOKEN, reservationId: "res_1" });
    assert.equal(w.calls.suggest, 1);
    assert.deepEqual(w.calls.confirm, [{ suggestionId: "asg_1", roomId: "room_102" }], "salta la superior (otra categoría) y elige la 102 limpia");
    assert.equal(result.reassigned, true);
    assert.equal(result.room.number, "102");
    assert.equal(w.calls.checkIn[0]!.roomId, "room_102");
    assert.ok(result.warnings.some((line) => line.includes("101") && line.includes("102")));
  });

  it("sin habitación lista → 409 ROOM_NOT_READY con etaReady y handoff room_not_ready en la sesión (arrived)", async () => {
    const dirty = room({ housekeepingStatus: "dirty", status: "dirty" });
    const alsoDirty = room({ id: "room_102", number: "102", housekeepingStatus: "dirty", status: "dirty" });
    const eta = new Date("2026-10-02T16:30:00.000Z");
    const w = world({ rooms: [dirty, alsoDirty], candidates: ["room_102"], hkEta: eta });
    resetArrivalServiceForTests(depsFor(w));
    const details = await expectConflict(() => completeCheckIn({ actor: "guest", token: TOKEN, reservationId: "res_1" }), "ROOM_NOT_READY");
    assert.equal(details.etaReady, eta.toISOString());
    assert.equal(details.roomNumber, "101");
    assert.equal(details.handoffKind, "room_not_ready");
    assert.equal(w.session.status, "arrived");
    assert.equal(w.session.handoffKind, "room_not_ready");
    assert.equal(w.calls.checkIn.length, 0, "sin check-in");
    assert.equal(w.calls.audits.some((a) => a.action === "CheckInHandedOff"), true);
    // Sin cola de pisos: etaReady null.
    const w2 = world({ rooms: [dirty, alsoDirty], candidates: ["room_102"] });
    resetArrivalServiceForTests(depsFor(w2));
    const again = await expectConflict(() => completeCheckIn({ actor: "guest", token: TOKEN, reservationId: "res_1" }), "ROOM_NOT_READY");
    assert.equal(again.etaReady, null);
  });

  it("corrector REV3-01: un RoomBlock que solapa la estancia deja la asignada como NO lista y se reasigna a otra de la misma categoría", async () => {
    const blocked = room();
    const clean = room({ id: "room_102", number: "102" });
    const w = world({ rooms: [blocked, clean], candidates: ["room_102"], blocks: { room_101: { id: "rb_1", fromDate: "2026-10-02", toDate: "2026-10-03", reason: "maintenance" } } });
    resetArrivalServiceForTests(depsFor(w));
    assert.equal(isRoomReady(blocked, { propertyId: PROP, requireInspectedRoom: false, roomBlock: w.blocks!.room_101! }), false);
    assert.equal(isRoomReady(blocked, { propertyId: PROP, requireInspectedRoom: false, roomBlock: null }), true);
    const result = await completeCheckIn({ actor: "guest", token: TOKEN, reservationId: "res_1" });
    assert.equal(result.reassigned, true);
    assert.equal(result.room.number, "102");
    assert.deepEqual(w.calls.confirm, [{ suggestionId: "asg_1", roomId: "room_102" }]);
    assert.ok(result.warnings.some((line) => line.includes("bloqueada") && line.includes("maintenance")), result.warnings.join(" | "));
    // Recepción eligiendo a mano la bloqueada → 409 ROOM_BLOCKED con las fechas y el motivo, sin reasignar.
    const w2 = world({ rooms: [blocked, clean], candidates: ["room_102"], blocks: { room_101: { id: "rb_1", fromDate: "2026-10-02", toDate: "2026-10-03", reason: "maintenance" } } });
    resetArrivalServiceForTests(depsFor(w2));
    const details = await expectConflict(() => completeCheckIn({ actor: "user", context: serviceContext("usr_1"), reservationId: "res_1", roomId: "room_101" }), "ROOM_BLOCKED");
    assert.deepEqual({ blockId: details.blockId, fromDate: details.fromDate, toDate: details.toDate, reason: details.reason, roomNumber: details.roomNumber }, { blockId: "rb_1", fromDate: "2026-10-02", toDate: "2026-10-03", reason: "maintenance", roomNumber: "101" });
    assert.equal(w2.calls.suggest, 0);
    assert.equal(w2.calls.checkIn.length, 0);
    // Una candidata bloqueada también se descarta.
    const w3 = world({ rooms: [room({ housekeepingStatus: "dirty", status: "dirty" }), clean], candidates: ["room_102"], blocks: { room_102: { id: "rb_2", fromDate: "2026-10-01", toDate: "2026-10-05", reason: "event" } } });
    resetArrivalServiceForTests(depsFor(w3));
    await expectConflict(() => completeCheckIn({ actor: "guest", token: TOKEN, reservationId: "res_1" }), "ROOM_NOT_READY");
    assert.equal(w3.calls.confirm.length, 0);
  });

  it("corrector REV3-02: sin PSP (at_reception) el huésped NO se salta el depósito: 409 BALANCE_DUE y sesión handed_off payment_failed; con allowPayAtReception sí; recepción nunca bloqueada", async () => {
    const w = world({ session: session({ paymentStatus: "at_reception" }), folio: { balanceDue: 320, paymentsTotal: 100, currency: "EUR" } });
    resetArrivalServiceForTests(depsFor(w));
    const details = await expectConflict(() => completeCheckIn({ actor: "guest", token: TOKEN, reservationId: "res_1" }), "BALANCE_DUE");
    assert.deepEqual({ required: details.required, paid: details.paid, balanceDue: details.balanceDue, handoffKind: details.handoffKind, paymentStatus: details.paymentStatus }, { required: 320, paid: 100, balanceDue: 320, handoffKind: "payment_failed", paymentStatus: "at_reception" });
    assert.equal(w.session.status, "handed_off");
    assert.equal(w.session.handoffKind, "payment_failed");
    assert.equal(w.calls.checkIn.length, 0);
    assert.equal(w.calls.audits.filter((a) => a.action === "CheckInHandedOff").length, 1);
    // Sin enlace pedido (paymentStatus none): 409 sin derivar (el huésped aún puede pagar en línea).
    const w1 = world({ session: session({ paymentStatus: "none" }), folio: { balanceDue: 320, paymentsTotal: 100, currency: "EUR" } });
    resetArrivalServiceForTests(depsFor(w1));
    const plain = await expectConflict(() => completeCheckIn({ actor: "guest", token: TOKEN, reservationId: "res_1" }), "BALANCE_DUE");
    assert.equal(plain.handoffKind, undefined);
    assert.equal(w1.session.status, "ready_for_arrival");
    // La política admite el pago en recepción → check-in autónomo.
    const w2 = world({ session: session({ paymentStatus: "at_reception" }), policy: policy({ allowPayAtReception: true }), folio: { balanceDue: 320, paymentsTotal: 100, currency: "EUR" } });
    resetArrivalServiceForTests(depsFor(w2));
    const ok = await completeCheckIn({ actor: "guest", token: TOKEN, reservationId: "res_1" });
    assert.equal(ok.room.number, "101");
    // Recepción cobra en el mostrador: nunca bloqueada por saldo.
    const w3 = world({ session: session({ paymentStatus: "at_reception" }), folio: { balanceDue: 320, paymentsTotal: 100, currency: "EUR" } });
    resetArrivalServiceForTests(depsFor(w3));
    const desk = await completeCheckIn({ actor: "user", context: serviceContext("usr_1"), reservationId: "res_1" });
    assert.equal(desk.actor, "user");
  });

  it("corrector REV3-03: precheckCheckIn comprueba sesión, ventana, identidad, firmas y saldo SIN asignar, cobrar ni alojar", async () => {
    const w = world({ records: [record({ signedAt: null, signatureObjectKey: null })] });
    resetArrivalServiceForTests(depsFor(w));
    await expectConflict(() => precheckCheckIn({ actor: "user", context: serviceContext("usr_1"), reservationId: "res_1", roomId: "room_101" }), "GUEST_REGISTER_INCOMPLETE");
    assert.equal(w.calls.checkIn.length, 0);
    assert.equal(w.calls.suggest, 0);
    assert.equal(w.calls.sessionUpdates.length, 0);
    const w2 = world({ rooms: [room({ housekeepingStatus: "dirty", status: "dirty" })] });
    resetArrivalServiceForTests(depsFor(w2));
    // La habitación sucia NO es una precondición del precheck (se resuelve al completar, con reasignación o override).
    const ok = await precheckCheckIn({ actor: "user", context: serviceContext("usr_1"), reservationId: "res_1", roomId: "room_101" });
    assert.deepEqual({ ok: ok.ok, dryRun: ok.dryRun, actor: ok.actor, identityMethod: ok.identityMethod, recordsCreated: ok.recordsCreated }, { ok: true, dryRun: true, actor: "user", identityMethod: "mrz_checksum", recordsCreated: 0 });
    assert.equal(w2.calls.checkIn.length, 0);
    assert.equal(w2.calls.confirm.length, 0);
    assert.equal(w2.session.status, "ready_for_arrival");
  });

  it("corrector REV3-04: recepción cierra una sesión in_progress que el huésped no cerró: los partes se crean desde los viajeros con datos completos", async () => {
    const unsigned = guest({ guestRegisterRecordId: null, status: "data_complete" });
    let signedRecord: ArrivalRecordRow | null = null;
    const w = world({
      session: session({ status: "in_progress", guests: [unsigned] }),
      records: [],
      ensureRecords: (guests) => {
        signedRecord = record();
        w.records = [signedRecord];
        return guests.map((g) => ({ ...g, guestRegisterRecordId: "grr_1" }));
      }
    });
    resetArrivalServiceForTests(depsFor(w));
    // Huésped: la sesión no está cerrada → 409 CHECKIN_INCOMPLETE (sin crear partes).
    await expectConflict(() => completeCheckIn({ actor: "guest", token: TOKEN, reservationId: "res_1" }), "CHECKIN_INCOMPLETE");
    assert.equal(w.calls.ensureRecords, 0);
    // Recepción: crea los partes (aquí ya firmados por el pad del mostrador) y cierra.
    const result = await completeCheckIn({ actor: "user", context: serviceContext("usr_1"), reservationId: "res_1", roomId: "room_101" });
    assert.equal(w.calls.ensureRecords, 1);
    assert.equal(result.actor, "user");
    assert.equal(w.calls.checkIn[0]!.signatureObjectKey, "sgn_0123456789abcdef");
    assert.equal(w.calls.audits.some((a) => a.action === "GUEST_CHECKED_IN_ASSISTED"), true);
  });

  it("SES desactivado → check-in hecho, ses.status warning y aviso; nunca finge encolado", async () => {
    const w = world({ sesError: () => new ConflictError("SES desactivado", { code: "SES_DISABLED" }) });
    resetArrivalServiceForTests(depsFor(w));
    const result = await completeCheckIn({ actor: "guest", token: TOKEN, reservationId: "res_1" });
    assert.equal(w.calls.checkIn.length, 1);
    assert.equal(result.ses.status, "warning");
    assert.deepEqual(result.ses.submissions, [{ guestRegisterRecordId: "grr_1", submissionId: null, status: "not_queued", code: "SES_DISABLED" }]);
    assert.ok(result.warnings.some((line) => line.startsWith("SES:") && line.includes("SES_DISABLED")));
    assert.equal(w.session.status, "checked_in");
    assert.equal(result.welcome.status, "simulated");
    // Un 409 no tolerado tampoco rompe el check-in ya hecho, pero queda como error explícito.
    const w2 = world({ sesError: () => new ConflictError("otra cosa", { code: "RESERVATION_MISSING" }) });
    resetArrivalServiceForTests(depsFor(w2));
    const second = await completeCheckIn({ actor: "guest", token: TOKEN, reservationId: "res_1" });
    assert.equal(second.ses.submissions[0]!.code, "SES_QUEUE_FAILED");
  });

  it("firma fija sig_* nunca se usa: un parte con literal antiguo es 409 y el check-in solo lleva ids de Signature", async () => {
    const w = world({ records: [record({ signatureObjectKey: "sig_drawer_checkin" })] });
    resetArrivalServiceForTests(depsFor(w));
    const details = await expectConflict(() => completeCheckIn({ actor: "user", context: serviceContext("usr_recepcion"), reservationId: "res_1" }), "GUEST_REGISTER_INCOMPLETE");
    assert.deepEqual(details.missing, [{ checkInGuestId: "cg_1", ordinal: 0, reason: "legacy_signature" }]);
    assert.equal(w.calls.checkIn.length, 0);
    const ok = world();
    resetArrivalServiceForTests(depsFor(ok));
    await completeCheckIn({ actor: "user", context: serviceContext("usr_recepcion"), reservationId: "res_1" });
    assert.equal(ok.calls.checkIn.length, 1);
    assert.equal(String(ok.calls.checkIn[0]!.signatureObjectKey).startsWith("sig_"), false);
    assert.equal(ok.calls.checkIn[0]!.signatureObjectKey, "sgn_0123456789abcdef");
    assert.equal(ok.calls.audits.some((a) => a.action === "GUEST_CHECKED_IN_ASSISTED"), true);
  });

  it("guest/kiosk: sesión no cerrada → 409 CHECKIN_INCOMPLETE; token ajeno → 401; segunda llegada → 409", async () => {
    const w = world({ session: session({ status: "in_progress" }) });
    resetArrivalServiceForTests(depsFor(w));
    await expectConflict(() => completeCheckIn({ actor: "guest", token: TOKEN, reservationId: "res_1" }), "CHECKIN_INCOMPLETE");
    await assert.rejects(() => completeCheckIn({ actor: "guest", token: "otro", reservationId: "res_1" }), (error: Error & { statusCode?: number }) => error.statusCode === 401);
    const done = world({ session: session({ status: "checked_in" }), reservation: reservation({ status: "checked_in" }) });
    resetArrivalServiceForTests(depsFor(done));
    await expectConflict(() => completeCheckIn({ actor: "guest", token: TOKEN, reservationId: "res_1" }), "CHECKIN_ALREADY_DONE");
  });

  it("saldo pendiente con política balance → 409 BALANCE_DUE para el huésped; recepción no bloquea por saldo", async () => {
    const w = world({ session: session({ paymentStatus: "none" }), folio: { balanceDue: 200, paymentsTotal: 0, currency: "EUR" } });
    resetArrivalServiceForTests(depsFor(w));
    const details = await expectConflict(() => completeCheckIn({ actor: "guest", token: TOKEN, reservationId: "res_1" }), "BALANCE_DUE");
    assert.equal(details.balanceDue, 200);
    const reception = world({ session: session({ paymentStatus: "none" }), folio: { balanceDue: 200, paymentsTotal: 0, currency: "EUR" } });
    resetArrivalServiceForTests(depsFor(reception));
    const result = await completeCheckIn({ actor: "user", context: serviceContext("usr_recepcion"), reservationId: "res_1" });
    assert.equal(result.room.id, "room_101");
  });

  it("fuera de ventana → 409 CHECK_IN_DATE_OUT_OF_RANGE; recepción con allowEarlyCheckIn + motivo lo fuerza", async () => {
    const w = world({ reservation: reservation({ arrivalDate: new Date("2026-10-05T00:00:00.000Z") }) });
    resetArrivalServiceForTests(depsFor(w));
    const details = await expectConflict(() => completeCheckIn({ actor: "guest", token: TOKEN, reservationId: "res_1" }), "CHECK_IN_DATE_OUT_OF_RANGE");
    assert.equal(details.offsetDays, 3);
    const forced = world({ reservation: reservation({ arrivalDate: new Date("2026-10-05T00:00:00.000Z") }) });
    resetArrivalServiceForTests(depsFor(forced));
    await completeCheckIn({ actor: "user", context: serviceContext("usr_recepcion"), reservationId: "res_1", allowEarlyCheckIn: true, overrideReason: "llegada anticipada autorizada" });
    assert.equal(forced.calls.checkIn[0]!.allowEarlyCheckIn, true);
    assert.equal(forced.calls.checkIn[0]!.overrideReason, "llegada anticipada autorizada");
  });

  it("kiosco con cotejo visual obligatorio: mrz_checksum no basta; la llave sin certificado Apple se dice", async () => {
    const w = world();
    resetArrivalServiceForTests(depsFor(w));
    await expectConflict(() => completeCheckIn({ actor: "kiosk", token: TOKEN, reservationId: "res_1", verification: { kioskDeviceId: "kd_1" } }), "IDENTITY_NOT_VERIFIED");
    const relaxed = world({ policy: policy({ requireVisualCheckAtKiosk: false }) });
    resetArrivalServiceForTests(depsFor(relaxed));
    const result = await completeCheckIn({ actor: "kiosk", token: TOKEN, reservationId: "res_1", verification: { kioskDeviceId: "kd_1" } });
    assert.equal(result.key?.serialNumber, "abc123");
    assert.equal(result.key?.wallet.apple.signedByApple, false);
    assert.ok(result.warnings.some((line) => line.includes("sin firmar por Apple")));
    assert.equal(relaxed.session.kioskDeviceId, "kd_1");
    const audit = relaxed.calls.audits.find((a) => a.action === "GUEST_SELF_CHECKED_IN")!;
    assert.equal((audit.afterJson as { kioskDeviceId: string }).kioskDeviceId, "kd_1");
  });
});

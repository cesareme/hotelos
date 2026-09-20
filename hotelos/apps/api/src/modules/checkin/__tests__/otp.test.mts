// Tanda CHK · W3-A: OTP de verificación (TTL, intentos, hash) con dependencias
// inyectadas (sin Prisma ni dispatcher). From apps/api:
//   node --import tsx --test src/modules/checkin/__tests__/otp.test.mts
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import type { UserContext } from "../../../lib/demo-store.js";
import { ConflictError, HttpError } from "../../../lib/http-error.js";
import {
  OTP_LENGTH,
  OTP_RESEND_COOLDOWN_MS,
  evaluateOtp,
  generateOtpCode,
  hashOtp,
  isOtpExpired,
  otpStateFrom,
  requestOtp,
  resetOtpServiceForTests,
  verifyOtp,
  withOtpState,
  type OtpDeps,
  type OtpSessionRow,
  type OtpState
} from "../otp.service.js";

globalThis.fetch = (() => {
  throw new Error("red prohibida en los tests de OTP");
}) as typeof fetch;

const NOW = new Date("2026-10-02T15:00:00.000Z");
const TOKEN = "token-otp";
const SESSION_ID = "cis_otp";
const CODE = "482913";

function sessionRow(overrides: Partial<OtpSessionRow> = {}): OtpSessionRow {
  return {
    id: SESSION_ID,
    organizationId: "org_t",
    propertyId: "prop_t",
    reservationId: "res_1",
    status: "ready_for_arrival",
    consentJson: { gdprAt: "2026-10-01T10:00:00.000Z" },
    guests: [{ id: "cg_1", isPrimary: true, guestRegisterRecordId: "grr_1", status: "signed", firstName: "ANNA", email: "titular@chk.test", phoneMobile: "+34 600 000 001" }],
    ...overrides
  };
}

type World = {
  session: OtpSessionRow;
  allowed: string[];
  now: Date;
  nodeEnv: string | undefined;
  allowDemoAuth: boolean;
  dispatched: Array<{ channel: string; recipient: string; variables: Record<string, unknown>; templateCode: string }>;
  saved: Array<Record<string, unknown>>;
  verified: Array<{ id: string; data: Record<string, unknown> }>;
  records: Array<{ recordId: string; method: string }>;
  audits: Array<{ action: string; afterJson: Record<string, unknown> }>;
};

function world(overrides: Partial<World> = {}): World {
  return { session: sessionRow(), allowed: ["visual_reception", "mrz_checksum", "otp_email", "otp_phone"], now: NOW, nodeEnv: "test", allowDemoAuth: true, dispatched: [], saved: [], verified: [], records: [], audits: [], ...overrides };
}

function depsFor(w: World): Partial<OtpDeps> {
  return {
    now: () => w.now,
    createId: (prefix) => `${prefix}_fixed`,
    config: () => ({ otpTtlMs: 600_000, otpMaxAttempts: 3 }),
    generateCode: () => CODE,
    env: () => ({ nodeEnv: w.nodeEnv, allowDemoAuth: w.allowDemoAuth }),
    verifyGuestToken: async (token) => (token === TOKEN ? { reservationId: "res_1", propertyId: "prop_t" } : null),
    loadSession: async () => w.session,
    loadReservationContact: async () => ({ bookerEmail: "booker@chk.test" }),
    loadPropertyName: async () => "Hotel CHK (prueba)",
    loadAllowedMethods: async () => w.allowed,
    serviceContext: async (propertyId, sessionId): Promise<UserContext> => ({ organizationId: "org_t", propertyId, userId: `guest:${sessionId}`, fullName: "Check-in automatizado", deviceId: "checkin", permissions: ["guest_register.edit"] }),
    saveOtpState: async (_sessionId, consentJson) => {
      w.saved.push(consentJson);
      w.session = { ...w.session, consentJson };
    },
    dispatch: async (input) => {
      w.dispatched.push({ channel: input.channel, recipient: input.recipient, variables: input.variables, templateCode: input.templateCode });
      return { id: "nd_otp", status: "sent", errorMessage: "SIMULADO: sin proveedor" };
    },
    markGuestVerified: async (id, data) => {
      w.verified.push({ id, data: data as Record<string, unknown> });
    },
    markGuestRegisterIdentityVerified: (async (input: { recordId: string; method: string }) => {
      w.records.push({ recordId: input.recordId, method: input.method });
      return { id: input.recordId, status: "signed", identityVerified: true, identityVerificationMethod: input.method };
    }) as unknown as OtpDeps["markGuestRegisterIdentityVerified"],
    recordAuditEvent: ((input: { action: string; afterJson: Record<string, unknown> }) => {
      w.audits.push({ action: input.action, afterJson: input.afterJson });
      return {} as never;
    }) as unknown as OtpDeps["recordAuditEvent"]
  };
}

function state(overrides: Partial<OtpState> = {}): OtpState {
  return { channel: "email", hash: hashOtp(SESSION_ID, CODE), requestedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 600_000).toISOString(), attempts: 0, recipient: "t***@chk.test", ...overrides };
}

afterEach(() => resetOtpServiceForTests());

describe("W3-A · OTP · funciones puras (hash, TTL, intentos)", () => {
  it("generateOtpCode: 6 dígitos con ceros a la izquierda; el hash es sha256(sessionId:código) y depende de la sesión", () => {
    assert.equal(generateOtpCode(() => 7), "000007");
    assert.equal(generateOtpCode(() => 999_999), "999999");
    assert.match(generateOtpCode(), new RegExp(`^\\d{${OTP_LENGTH}}$`));
    assert.equal(hashOtp(SESSION_ID, CODE), createHash("sha256").update(`${SESSION_ID}:${CODE}`).digest("hex"));
    assert.equal(hashOtp(SESSION_ID, "482-913"), hashOtp(SESSION_ID, CODE), "solo cuentan los dígitos");
    assert.notEqual(hashOtp("otra_sesion", CODE), hashOtp(SESSION_ID, CODE));
  });

  it("otpStateFrom / withOtpState: el OTP vive bajo consentJson.otp sin tocar las demás claves; nunca el código en claro", () => {
    const json = withOtpState({ gdprAt: "x" }, state());
    assert.equal((json as { gdprAt: string }).gdprAt, "x");
    assert.equal(JSON.stringify(json).includes(CODE), false);
    assert.deepEqual(otpStateFrom(json), state());
    assert.equal(otpStateFrom({ gdprAt: "x" }), null);
    assert.equal(otpStateFrom({ otp: { channel: "fax", hash: "a", expiresAt: "b", requestedAt: "c" } }), null);
    assert.deepEqual(withOtpState(json, null), { gdprAt: "x" });
  });

  it("TTL: caducado en cuanto expiresAt ≤ ahora", () => {
    assert.equal(isOtpExpired(state(), NOW), false);
    assert.equal(isOtpExpired(state({ expiresAt: NOW.toISOString() }), NOW), true);
    assert.equal(isOtpExpired(state({ expiresAt: "no-es-fecha" }), NOW), true);
    assert.deepEqual(evaluateOtp({ state: state({ expiresAt: new Date(NOW.getTime() - 1).toISOString() }), sessionId: SESSION_ID, code: CODE, now: NOW, maxAttempts: 3 }), { ok: false, reason: "expired", attempts: 0 });
  });

  it("intentos: mismatch incrementa; al alcanzar el máximo es rate_limited incluso con el código correcto", () => {
    assert.deepEqual(evaluateOtp({ state: null, sessionId: SESSION_ID, code: CODE, now: NOW, maxAttempts: 3 }), { ok: false, reason: "not_requested", attempts: 0 });
    assert.deepEqual(evaluateOtp({ state: state(), sessionId: SESSION_ID, code: "000000", now: NOW, maxAttempts: 3 }), { ok: false, reason: "mismatch", attempts: 1 });
    assert.deepEqual(evaluateOtp({ state: state({ attempts: 2 }), sessionId: SESSION_ID, code: "000000", now: NOW, maxAttempts: 3 }), { ok: false, reason: "mismatch", attempts: 3 });
    assert.deepEqual(evaluateOtp({ state: state({ attempts: 3 }), sessionId: SESSION_ID, code: CODE, now: NOW, maxAttempts: 3 }), { ok: false, reason: "rate_limited", attempts: 3 });
    assert.deepEqual(evaluateOtp({ state: state({ attempts: 2 }), sessionId: SESSION_ID, code: CODE, now: NOW, maxAttempts: 3 }), { ok: true });
    assert.deepEqual(evaluateOtp({ state: state(), sessionId: "otra", code: CODE, now: NOW, maxAttempts: 3 }), { ok: false, reason: "mismatch", attempts: 1 }, "el hash está ligado a la sesión");
  });
});

describe("W3-A · requestOtp / verifyOtp con dobles", () => {
  it("request: guarda solo el hash con TTL, envía checkin_otp al correo del titular y devuelve debugCode fuera de producción con demo auth", async () => {
    const w = world();
    resetOtpServiceForTests(depsFor(w));
    const result = await requestOtp({ token: TOKEN, channel: "email" });
    assert.equal(result.method, "otp_email");
    assert.equal(result.recipient, "t***@chk.test");
    assert.equal(result.expiresAt, new Date(NOW.getTime() + 600_000).toISOString());
    assert.equal(result.dispatched, true);
    assert.equal(result.simulated, true);
    assert.equal(result.debugCode, CODE);
    const saved = otpStateFrom(w.saved[0])!;
    assert.equal(saved.hash, hashOtp(SESSION_ID, CODE));
    assert.equal(saved.attempts, 0);
    assert.equal(JSON.stringify(w.saved[0]).includes(CODE), false, "nunca el código en claro en la BD");
    assert.equal((w.saved[0] as { gdprAt?: string }).gdprAt, "2026-10-01T10:00:00.000Z", "no pisa el consentimiento");
    assert.deepEqual(w.dispatched.map((d) => [d.templateCode, d.channel, d.recipient]), [["checkin_otp", "email", "titular@chk.test"]]);
    assert.equal(w.dispatched[0]!.variables.otpCode, CODE);
    const audit = w.audits.find((a) => a.action === "CHECKIN_OTP_REQUESTED")!;
    assert.equal(JSON.stringify(audit.afterJson).includes(CODE), false);
    assert.equal(JSON.stringify(audit.afterJson).includes("titular@chk.test"), false);
  });

  it("request: sin debugCode en producción o sin HOTELOS_ALLOW_DEMO_AUTH; el móvil va por sms normalizado; método no admitido → 409", async () => {
    const prod = world({ nodeEnv: "production" });
    resetOtpServiceForTests(depsFor(prod));
    assert.equal((await requestOtp({ token: TOKEN, channel: "email" })).debugCode, undefined);
    const noDemo = world({ allowDemoAuth: false });
    resetOtpServiceForTests(depsFor(noDemo));
    assert.equal((await requestOtp({ token: TOKEN, channel: "email" })).debugCode, undefined);
    const phone = world();
    resetOtpServiceForTests(depsFor(phone));
    const result = await requestOtp({ token: TOKEN, channel: "phone" });
    assert.equal(result.method, "otp_phone");
    assert.deepEqual(phone.dispatched.map((d) => [d.channel, d.recipient]), [["sms", "+34600000001"]]);
    const forbidden = world({ allowed: ["visual_reception", "mrz_checksum"] });
    resetOtpServiceForTests(depsFor(forbidden));
    await assert.rejects(() => requestOtp({ token: TOKEN, channel: "email" }), (error: HttpError) => error instanceof ConflictError && (error.details as { code: string }).code === "OTP_METHOD_NOT_ALLOWED");
    assert.equal(forbidden.dispatched.length, 0);
    await assert.rejects(() => requestOtp({ token: "otro", channel: "email" }), (error: { statusCode?: number }) => error.statusCode === 401);
  });

  it("request: un segundo código antes del cooldown responde 429 OTP_RATE_LIMITED; después del cooldown se renueva", async () => {
    const w = world();
    resetOtpServiceForTests(depsFor(w));
    await requestOtp({ token: TOKEN, channel: "email" });
    await assert.rejects(() => requestOtp({ token: TOKEN, channel: "email" }), (error: HttpError) => error.statusCode === 429 && (error.details as { code: string }).code === "OTP_RATE_LIMITED");
    w.now = new Date(NOW.getTime() + OTP_RESEND_COOLDOWN_MS);
    const again = await requestOtp({ token: TOKEN, channel: "email" });
    assert.equal(again.expiresAt, new Date(w.now.getTime() + 600_000).toISOString());
    assert.equal(w.dispatched.length, 2);
  });

  it("verify: acierto marca al titular otp_email + identityVerifiedAt + verified, verifica el parte y borra el OTP", async () => {
    const w = world({ session: sessionRow({ consentJson: withOtpState({ gdprAt: "x" }, state()) }) });
    resetOtpServiceForTests(depsFor(w));
    const result = await verifyOtp({ token: TOKEN, code: "482 913" });
    assert.equal(result.method, "otp_email");
    assert.equal(result.policyAllowed, true);
    assert.equal(result.guestStatus, "verified");
    assert.equal(result.verifiedAt, NOW.toISOString());
    assert.deepEqual(w.verified, [{ id: "cg_1", data: { identityVerificationMethod: "otp_email", identityVerifiedAt: NOW, identityVerifiedBy: `guest:${SESSION_ID}`, status: "verified" } }]);
    assert.deepEqual(w.records, [{ recordId: "grr_1", method: "otp_email" }]);
    assert.equal(otpStateFrom(w.session.consentJson), null, "el OTP se consume");
    assert.equal((w.session.consentJson as { gdprAt: string }).gdprAt, "x");
    assert.equal(w.audits.some((a) => a.action === "CHECKIN_OTP_VERIFIED"), true);
  });

  it("verify: código erróneo 409 OTP_INVALID con attemptsLeft; al máximo 429 OTP_RATE_LIMITED y ya no entra ni el correcto; caducado 409; sin petición 409", async () => {
    const w = world({ session: sessionRow({ consentJson: withOtpState({}, state()) }) });
    resetOtpServiceForTests(depsFor(w));
    await assert.rejects(() => verifyOtp({ token: TOKEN, code: "000000" }), (error: HttpError) => error.statusCode === 409 && (error.details as { code: string; attemptsLeft: number }).code === "OTP_INVALID" && (error.details as { attemptsLeft: number }).attemptsLeft === 2);
    assert.equal(otpStateFrom(w.session.consentJson)!.attempts, 1, "el contador persiste");
    await assert.rejects(() => verifyOtp({ token: TOKEN, code: "111111" }), (error: HttpError) => error.statusCode === 409);
    await assert.rejects(() => verifyOtp({ token: TOKEN, code: "222222" }), (error: HttpError) => error.statusCode === 429 && (error.details as { code: string }).code === "OTP_RATE_LIMITED");
    await assert.rejects(() => verifyOtp({ token: TOKEN, code: CODE }), (error: HttpError) => error.statusCode === 429, "agotado: ni el correcto entra");
    assert.equal(w.verified.length, 0);

    const expired = world({ session: sessionRow({ consentJson: withOtpState({}, state({ expiresAt: new Date(NOW.getTime() - 1).toISOString() })) }) });
    resetOtpServiceForTests(depsFor(expired));
    await assert.rejects(() => verifyOtp({ token: TOKEN, code: CODE }), (error: HttpError) => error.statusCode === 409 && (error.details as { reason: string }).reason === "expired");

    const none = world();
    resetOtpServiceForTests(depsFor(none));
    await assert.rejects(() => verifyOtp({ token: TOKEN, code: CODE }), (error: HttpError) => error.statusCode === 409 && (error.details as { reason: string }).reason === "not_requested");
  });

  it("verify: si la política dejó de admitir el método, quedan método y fecha pero no el estado verified ni el parte", async () => {
    const w = world({ allowed: ["visual_reception"], session: sessionRow({ consentJson: withOtpState({}, state()) }) });
    resetOtpServiceForTests(depsFor(w));
    const result = await verifyOtp({ token: TOKEN, code: CODE });
    assert.equal(result.policyAllowed, false);
    assert.equal(result.guestStatus, "signed");
    assert.deepEqual(w.verified[0]!.data, { identityVerificationMethod: "otp_email", identityVerifiedAt: NOW, identityVerifiedBy: `guest:${SESSION_ID}` });
    assert.equal(w.records.length, 0);
  });
});

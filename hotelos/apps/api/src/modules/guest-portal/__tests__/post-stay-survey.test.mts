// Unit tests · Tanda L7 · lote L7-04 — encuesta post-estancia
// (modules/guest-portal/post-stay-survey.service.ts) con dobles: base de datos
// en memoria (política, reservas, titulares, sesiones de check-in, entregas,
// propiedades), sesión/dispatch/auditoría grabados en listas, reloj fijo en
// Europe/Madrid. Sin base de datos, sin red. Desde apps/api:
//   node --import tsx --test src/modules/guest-portal/__tests__/post-stay-survey.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_GUEST_SURVEY_NAME, DEFAULT_GUEST_SURVEY_QUESTIONS } from "@hotelos/shared";
import { ConflictError, NotFoundError } from "../../../lib/http-error.js";
import type { recordAuditEvent } from "../../audit/audit.service.js";
import { buildServiceContext, CHECKIN_SERVICE_PERMISSIONS } from "../../checkin/service-context.js";
import type { DispatchInput, NotificationDeliveryRecord } from "../../notifications/dispatcher.service.js";
import { POST_STAY_SURVEY_SESSION_TTL_MS, type IssuedGuestPortalSession, type VerifiedGuestSession } from "../guest-portal-auth.service.js";
import {
  POST_STAY_SURVEY_AUDIT_ACTION,
  POST_STAY_SURVEY_LOOKBACK_DAYS,
  POST_STAY_SURVEY_TEMPLATE,
  SURVEY_RESPONSE_AUDIT_ACTION,
  buildSurveyUrl,
  civilDate,
  getGuestSurveyView,
  invitePostStaySurvey,
  isDepartureDue,
  isSimulatedDelivery,
  normalizeSurveyQuestions,
  runPostStaySurveyStep,
  shiftDay,
  submitGuestSurvey,
  surveyConsentOf,
  surveyNotificationId,
  surveyOpenFor,
  surveyWindowFor,
  type GuestSurveyDeps,
  type PostStaySurveyDb,
  type PostStaySurveyDeps
} from "../post-stay-survey.service.js";

globalThis.fetch = (() => {
  throw new Error("red prohibida en los tests de la encuesta");
}) as typeof fetch;

// ── Reloj: 2026-09-20 10:00 Madrid (CEST = UTC+2) ────────────────────────────
const TODAY = "2026-09-20";
const NOW = new Date("2026-09-20T08:00:00.000Z");
const CLOCK = { day: TODAY, time: "10:00" };
const TZ = "Europe/Madrid";
const SIMULATED = "SIMULADO: proveedor no configurado; no se envió de verdad.";

// ── Base de datos en memoria ─────────────────────────────────────────────────

type PolicyRow = { propertyId: string; postStaySurveyEnabled: boolean; postStaySurveyDelayHours: number };
type ReservationRow = { id: string; propertyId: string; code: string; status: string; deletedAt: Date | null; departureDate: Date; bookerEmail: string | null; bookerName: string | null };
type LinkRow = { id: string; reservationId: string; guestId: string; isPrimary: boolean };
type GuestRow = { id: string; firstName: string; email: string | null; languagePreference: string | null; gdprConsentFlags: unknown; marketingConsent: boolean | null; deletedAt: Date | null };
type SessionRow = { reservationId: string; consentJson: unknown };
type DeliveryRow = { id: string; notificationId: string; recipient: string; errorMessage: string | null; status: string };
type PropertyRow = { id: string; organizationId: string; name: string };

type State = { policies: PolicyRow[]; reservations: ReservationRow[]; links: LinkRow[]; guests: GuestRow[]; sessions: SessionRow[]; deliveries: DeliveryRow[]; properties: PropertyRow[] };

function num(value: unknown): number {
  return value instanceof Date ? value.getTime() : typeof value === "number" ? value : Number.NaN;
}

/** Evaluador mínimo de `where` (igualdad, null, in, gte/lte) para las consultas del paso. */
function matches(row: Record<string, unknown>, where: Record<string, unknown> | undefined): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    const value = row[key];
    if (cond === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (cond instanceof Date) {
      if (!(value instanceof Date) || value.getTime() !== cond.getTime()) return false;
      continue;
    }
    if (cond && typeof cond === "object") {
      const c = cond as Record<string, unknown>;
      if ("in" in c && !(c.in as unknown[]).includes(value)) return false;
      if ("gte" in c && !(num(value) >= num(c.gte))) return false;
      if ("lte" in c && !(num(value) <= num(c.lte))) return false;
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

function stubDb(state: State, options: { failReservationsFor?: string } = {}): PostStaySurveyDb {
  const findMany = <T extends Record<string, unknown>>(rows: T[]) => async (args: { where?: Record<string, unknown> }) => rows.filter((row) => matches(row, args.where));
  const findFirst = <T extends Record<string, unknown>>(rows: T[]) => async (args: { where?: Record<string, unknown> }) => rows.find((row) => matches(row, args.where)) ?? null;
  return {
    propertyCheckInPolicy: { findMany: findMany(state.policies) },
    reservation: {
      findMany: async (args: { where?: Record<string, unknown>; orderBy?: unknown }) => {
        if (options.failReservationsFor && args.where?.propertyId === options.failReservationsFor) throw new Error("db down");
        const rows = state.reservations.filter((row) => matches(row, args.where));
        // El paso ordena por salida y código (como Prisma): el doble respeta ese orden.
        return args.orderBy ? [...rows].sort((a, b) => a.departureDate.getTime() - b.departureDate.getTime() || a.code.localeCompare(b.code)) : rows;
      },
      findFirst: findFirst(state.reservations)
    },
    reservationGuest: { findFirst: findFirst(state.links) },
    guest: { findFirst: findFirst(state.guests) },
    checkInSession: { findUnique: findFirst(state.sessions) },
    notificationDelivery: { findFirst: findFirst(state.deliveries) },
    property: { findUnique: async (args: { where: { id: string } }) => state.properties.find((row) => row.id === args.where.id) ?? null }
  } as unknown as PostStaySurveyDb;
}

// ── Dobles del resto de dependencias ─────────────────────────────────────────

type AuditCall = Parameters<typeof recordAuditEvent>[0];
type Harness = { deps: PostStaySurveyDeps; issued: Array<{ reservationId: string; ttlMs: number; purpose: "survey" }>; dispatched: DispatchInput[]; audits: AuditCall[] };

function harness(state: State, options: { failReservationsFor?: string; dispatchStatus?: "sent" | "failed"; simulated?: boolean; dispatchThrows?: string; issueNull?: boolean } = {}): Harness {
  const issued: Harness["issued"] = [];
  const dispatched: DispatchInput[] = [];
  const audits: AuditCall[] = [];
  let seq = 0;
  const deps: PostStaySurveyDeps = {
    db: stubDb(state, options),
    now: () => NOW,
    timeZone: TZ,
    createId: (prefix) => `${prefix}_${++seq}`,
    guestWebBaseUrl: () => "https://huesped.example.test/",
    issueSession: async (input) => {
      issued.push(input);
      if (options.issueNull) return null;
      const session: IssuedGuestPortalSession = { sessionId: `gps_${input.reservationId}`, token: `tok_${input.reservationId}_secreto`, reservationId: input.reservationId, propertyId: "prop_a", guestId: null, expiresAt: new Date(NOW.getTime() + input.ttlMs), purpose: input.purpose };
      return session;
    },
    dispatch: async (input) => {
      if (options.dispatchThrows) throw new Error(options.dispatchThrows);
      dispatched.push(input);
      const status = options.dispatchStatus ?? "sent";
      const simulated = options.simulated ?? true;
      const row: DeliveryRow = { id: `del_${dispatched.length}`, notificationId: input.notificationId ?? "", recipient: input.recipient, errorMessage: status === "sent" ? (simulated ? SIMULATED : null) : "Email provider not configured", status };
      state.deliveries.push(row);
      return { id: row.id, status: row.status, errorMessage: row.errorMessage, recipient: row.recipient, channel: input.channel } as unknown as NotificationDeliveryRecord;
    },
    audit: ((input: AuditCall) => {
      audits.push(input);
      return { id: `aud_${audits.length}` } as unknown as ReturnType<typeof recordAuditEvent>;
    }) as typeof recordAuditEvent
  };
  return { deps, issued, dispatched, audits };
}

const day = (offset: number): Date => civilDate(shiftDay(TODAY, offset));
const policy = (propertyId: string, enabled = true, delayHours = 24): PolicyRow => ({ propertyId, postStaySurveyEnabled: enabled, postStaySurveyDelayHours: delayHours });
const reservation = (id: string, propertyId: string, departureOffset: number, extra: Partial<ReservationRow> = {}): ReservationRow => ({
  id,
  propertyId,
  code: id.toUpperCase(),
  status: "checked_out",
  deletedAt: null,
  departureDate: day(departureOffset),
  bookerEmail: null,
  bookerName: null,
  ...extra
});
const link = (reservationId: string, guestId: string, isPrimary = true): LinkRow => ({ id: `rg_${reservationId}_${guestId}`, reservationId, guestId, isPrimary });
const guest = (id: string, extra: Partial<GuestRow> = {}): GuestRow => ({ id, firstName: "Prueba", email: `${id}@l7.test`, languagePreference: null, gdprConsentFlags: null, marketingConsent: null, deletedAt: null, ...extra });
const PROPERTIES: PropertyRow[] = [
  { id: "prop_a", organizationId: "org_a", name: "Hotel A (prueba)" },
  { id: "prop_b", organizationId: "org_b", name: "Hotel B (prueba)" }
];
function baseState(overrides: Partial<State> = {}): State {
  return { policies: [], reservations: [], links: [], guests: [], sessions: [], deliveries: [], properties: PROPERTIES, ...overrides };
}

// ── Puras ────────────────────────────────────────────────────────────────────

describe("puras: ventana, consentimiento, enlace, preguntas", () => {
  it("shiftDay / civilDate / surveyNotificationId", () => {
    assert.equal(shiftDay("2026-10-01", -1), "2026-09-30");
    assert.equal(shiftDay("2026-02-28", 1), "2026-03-01");
    assert.equal(civilDate("2026-09-19").toISOString(), "2026-09-19T00:00:00.000Z");
    assert.equal(surveyNotificationId("res_1"), "post_stay_survey:res_1");
    assert.equal(POST_STAY_SURVEY_LOOKBACK_DAYS, 3);
    assert.equal(POST_STAY_SURVEY_SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000);
  });

  it("surveyWindowFor: to = día local de (ahora − delay); from = hoy − 3 d; con 72 h la ventana es un solo día", () => {
    assert.deepEqual(surveyWindowFor(NOW, TODAY, 24, TZ), { from: "2026-09-17", to: "2026-09-19" });
    assert.deepEqual(surveyWindowFor(NOW, TODAY, 0, TZ), { from: "2026-09-17", to: "2026-09-20" });
    assert.deepEqual(surveyWindowFor(NOW, TODAY, 36, TZ), { from: "2026-09-17", to: "2026-09-18" });
    assert.deepEqual(surveyWindowFor(NOW, TODAY, 72, TZ), { from: "2026-09-17", to: "2026-09-17" });
    // 09:00 Madrid con 10 h de retraso → 23:00 del día anterior (hora local, no UTC).
    assert.equal(surveyWindowFor(new Date("2026-09-20T07:00:00.000Z"), TODAY, 10, TZ).to, "2026-09-19");
    assert.equal(surveyWindowFor(NOW, TODAY, Number.NaN, TZ).to, "2026-09-19", "delay no finito → 24 h");
    const window = surveyWindowFor(NOW, TODAY, 24, TZ);
    assert.equal(isDepartureDue("2026-09-19", window), true);
    assert.equal(isDepartureDue("2026-09-17", window), true);
    assert.equal(isDepartureDue("2026-09-16", window), false);
    assert.equal(isDepartureDue("2026-09-20", window), false);
  });

  it("surveyConsentOf: gdprAt del check-in basta; marketing negado (flags o columna) rechaza; sin datos no se rechaza", () => {
    assert.deepEqual(surveyConsentOf({ sessionConsentJson: { gdprAt: "2026-09-18T10:00:00.000Z" }, guestFlags: { marketing: false }, guestMarketingConsent: false }), { ok: true, basis: "gdpr_consent" });
    assert.deepEqual(surveyConsentOf({ sessionConsentJson: null, guestFlags: { marketing: false }, guestMarketingConsent: null }), { ok: false, basis: "refused" });
    assert.deepEqual(surveyConsentOf({ sessionConsentJson: {}, guestFlags: null, guestMarketingConsent: false }), { ok: false, basis: "refused" });
    assert.deepEqual(surveyConsentOf({ sessionConsentJson: null, guestFlags: null, guestMarketingConsent: null }), { ok: true, basis: "not_refused" });
    assert.deepEqual(surveyConsentOf({ sessionConsentJson: { gdprAt: "" }, guestFlags: { marketing: true }, guestMarketingConsent: undefined }), { ok: true, basis: "not_refused" });
  });

  it("buildSurveyUrl: ?survey=1&token&property sobre la base sin barra final, con escape", () => {
    assert.equal(buildSurveyUrl("https://huesped.example.test/", "a b&c", "prop_1"), "https://huesped.example.test/?survey=1&token=a%20b%26c&property=prop_1");
    assert.equal(buildSurveyUrl("http://localhost:5174", "t", "p"), "http://localhost:5174/?survey=1&token=t&property=p");
  });

  it("normalizeSurveyQuestions: acepta { id, text } del editor y { key, type, label, required }; vacío o malformado → cuestionario por defecto", () => {
    assert.deepEqual(normalizeSurveyQuestions([{ id: "q1", text: "¿Cómo valoras la limpieza?" }, { id: "nps", text: "¿Nos recomendarías?" }]), [
      { key: "q1", type: "text", label: "¿Cómo valoras la limpieza?", required: false },
      { key: "nps", type: "nps", label: "¿Nos recomendarías?", required: true }
    ]);
    assert.deepEqual(normalizeSurveyQuestions([{ key: "room", type: "scale", label: "Habitación", required: true }, { key: "room", type: "text", label: "duplicada" }, { key: "", label: "sin clave" }, { key: "x", type: "raro", label: "tipo desconocido" }, "basura", null]), [
      { key: "room", type: "scale", label: "Habitación", required: true },
      { key: "x", type: "text", label: "tipo desconocido", required: false }
    ]);
    assert.deepEqual(normalizeSurveyQuestions([]), [...DEFAULT_GUEST_SURVEY_QUESTIONS]);
    assert.deepEqual(normalizeSurveyQuestions("no"), [...DEFAULT_GUEST_SURVEY_QUESTIONS]);
    assert.equal(DEFAULT_GUEST_SURVEY_QUESTIONS[0]?.key, "nps");
    assert.equal(DEFAULT_GUEST_SURVEY_QUESTIONS[0]?.required, true);
    assert.equal(DEFAULT_GUEST_SURVEY_QUESTIONS[1]?.key, "comment");
    const copy = normalizeSurveyQuestions(null);
    copy[0]!.label = "mutada";
    assert.notEqual(DEFAULT_GUEST_SURVEY_QUESTIONS[0]?.label, "mutada", "el por defecto no se comparte por referencia");
  });

  it("isSimulatedDelivery lee el prefijo SIMULADO del dispatcher", () => {
    assert.equal(isSimulatedDelivery({ errorMessage: SIMULATED }), true);
    assert.equal(isSimulatedDelivery({ errorMessage: null }), false);
    assert.equal(isSimulatedDelivery({ errorMessage: "Email provider not configured" }), false);
  });
});

// ── Paso del tick ────────────────────────────────────────────────────────────

describe("paso del tick: política, ventana, titular, entrega simulada, idempotencia", () => {
  it("solo propiedades con postStaySurveyEnabled y reservas checked_out con salida en [hoy−3 d, ayer]; entrega SIMULADO con el token redactado; auditoría sin token", async () => {
    const state = baseState({
      policies: [policy("prop_a"), policy("prop_b", false)],
      reservations: [
        reservation("r_yesterday", "prop_a", -1),
        reservation("r_three", "prop_a", -3, { bookerEmail: "titular@l7.test", bookerName: "Titular" }),
        reservation("r_four", "prop_a", -4),
        reservation("r_today", "prop_a", 0),
        reservation("r_in_house", "prop_a", -1, { status: "checked_in" }),
        reservation("r_deleted", "prop_a", -1, { deletedAt: new Date("2026-09-01T00:00:00.000Z") }),
        reservation("r_b", "prop_b", -1)
      ],
      links: [link("r_yesterday", "g_1"), link("r_four", "g_1"), link("r_today", "g_1"), link("r_b", "g_1")],
      guests: [guest("g_1", { languagePreference: "en" })],
      sessions: [{ reservationId: "r_yesterday", consentJson: { gdprAt: "2026-09-17T09:00:00.000Z" } }]
    });
    const h = harness(state);
    const summary = await runPostStaySurveyStep(h.deps, CLOCK);
    assert.equal(summary.properties, 1);
    assert.equal(summary.invited, 2);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.failed, 0);
    assert.deepEqual(summary.outcomes.map((o) => [o.reservationId, o.status, o.simulated, o.recipient]), [
      ["r_three", "invited", true, "t***@l7.test"],
      ["r_yesterday", "invited", true, "g***@l7.test"]
    ]);
    // Corrector L7-REV-01: la sesión del enlace nace con ámbito `survey` (solo abre GET|POST /guest-portal/survey).
    assert.deepEqual(h.issued, [
      { reservationId: "r_three", ttlMs: POST_STAY_SURVEY_SESSION_TTL_MS, purpose: "survey" },
      { reservationId: "r_yesterday", ttlMs: POST_STAY_SURVEY_SESSION_TTL_MS, purpose: "survey" }
    ]);
    assert.equal(h.dispatched.length, 2);
    const first = h.dispatched.find((call) => call.notificationId === "post_stay_survey:r_yesterday")!;
    assert.equal(first.templateCode, POST_STAY_SURVEY_TEMPLATE);
    assert.equal(first.channel, "email");
    assert.equal(first.recipient, "g_1@l7.test");
    assert.equal(first.organizationId, "org_a");
    assert.equal(first.propertyId, "prop_a");
    assert.equal(first.language, "en", "idioma del titular");
    assert.equal(first.variables.guestFirstName, "Prueba");
    assert.equal(first.variables.propertyName, "Hotel A (prueba)");
    assert.equal(first.variables.surveyUrl, "https://huesped.example.test/?survey=1&token=tok_r_yesterday_secreto&property=prop_a");
    assert.deepEqual(first.redact, { variables: ["surveyUrl"], values: ["tok_r_yesterday_secreto"] });
    const fallback = h.dispatched.find((call) => call.notificationId === "post_stay_survey:r_three")!;
    assert.equal(fallback.recipient, "titular@l7.test", "sin titular enlazado cae al bookerEmail");
    assert.equal(fallback.variables.guestFirstName, "Titular");
    assert.equal(fallback.language, "es");
    // Auditoría: una por invitación, actor sintético del tick, destinatario enmascarado y sin token.
    const audits = h.audits.filter((event) => event.action === POST_STAY_SURVEY_AUDIT_ACTION);
    assert.equal(audits.length, 2);
    const audit = audits.find((event) => event.entityId === "r_yesterday")!;
    assert.equal(audit.actorType, "system");
    assert.equal(audit.actorUserId, "system:checkin:post_stay_survey");
    assert.equal(audit.entityType, "reservation");
    assert.equal(audit.organizationId, "org_a");
    assert.deepEqual(audit.afterJson, { reservationId: "r_yesterday", channel: "email", recipient: "g***@l7.test", dispatched: true, simulated: true, reason: null, deliveryId: "del_2", guestPortalSessionId: "gps_r_yesterday", consentBasis: "gdpr_consent", forced: false });
    assert.equal(JSON.stringify(h.audits).includes("secreto"), false, "el token nunca se audita");
    assert.equal(summary.outcomes.some((o) => "surveyUrl" in o), false, "el tick nunca devuelve el enlace");
  });

  it("segunda vuelta: la entrega existente → skipped already_invited sin sesión ni envío nuevos", async () => {
    const state = baseState({ policies: [policy("prop_a")], reservations: [reservation("r_1", "prop_a", -1)], links: [link("r_1", "g_1")], guests: [guest("g_1")] });
    const h = harness(state);
    const first = await runPostStaySurveyStep(h.deps, CLOCK);
    assert.equal(first.invited, 1);
    const second = await runPostStaySurveyStep(h.deps, CLOCK);
    assert.equal(second.invited, 0);
    assert.equal(second.skipped, 1);
    assert.deepEqual(second.outcomes.map((o) => [o.reservationId, o.status, o.reason, o.deliveryId, o.simulated]), [["r_1", "skipped", "already_invited", "del_1", true]]);
    assert.equal(h.issued.length, 1, "una sola sesión");
    assert.equal(h.dispatched.length, 1, "un solo envío");
    assert.equal(h.audits.length, 1, "la omisión por idempotencia no se audita");
  });

  it("sin correo → skipped no_recipient; marketing negado → skipped consent_refused; ninguna sesión ni envío", async () => {
    const state = baseState({
      policies: [policy("prop_a")],
      reservations: [reservation("r_no_mail", "prop_a", -1), reservation("r_refused", "prop_a", -1), reservation("r_no_guest", "prop_a", -2)],
      links: [link("r_no_mail", "g_sin"), link("r_refused", "g_no")],
      guests: [guest("g_sin", { email: null }), guest("g_no", { gdprConsentFlags: { marketing: false } })]
    });
    const h = harness(state);
    const summary = await runPostStaySurveyStep(h.deps, CLOCK);
    assert.equal(summary.invited, 0);
    assert.equal(summary.skipped, 3);
    assert.deepEqual(summary.outcomes.map((o) => [o.reservationId, o.reason, o.recipient]), [
      ["r_no_guest", "no_recipient", null],
      ["r_no_mail", "no_recipient", null],
      ["r_refused", "consent_refused", "g***@l7.test"]
    ]);
    assert.deepEqual(h.issued, []);
    assert.deepEqual(h.dispatched, []);
  });

  it("delayHours de la política manda: con 72 h solo entra la salida de hace 3 días", async () => {
    const state = baseState({
      policies: [policy("prop_a", true, 72)],
      reservations: [reservation("r_1", "prop_a", -1), reservation("r_2", "prop_a", -2), reservation("r_3", "prop_a", -3)],
      links: [link("r_1", "g"), link("r_2", "g"), link("r_3", "g")],
      guests: [guest("g")]
    });
    const h = harness(state);
    const summary = await runPostStaySurveyStep(h.deps, CLOCK);
    assert.deepEqual(summary.outcomes.map((o) => o.reservationId), ["r_3"]);
  });

  it("fallos: plantilla ausente → failed template_not_found; proveedor failed → failed con su motivo; sesión no emitida → failed; fallo de BD de una propiedad no detiene la otra", async () => {
    const mk = () => baseState({ policies: [policy("prop_a"), policy("prop_b")], reservations: [reservation("r_a", "prop_a", -1), reservation("r_b", "prop_b", -1)], links: [link("r_a", "g"), link("r_b", "g")], guests: [guest("g")] });
    const missing = harness(mk(), { dispatchThrows: "template_not_found" });
    const s1 = await runPostStaySurveyStep(missing.deps, CLOCK);
    assert.equal(s1.failed, 2);
    assert.deepEqual(s1.outcomes.map((o) => o.reason), ["template_not_found", "template_not_found"]);
    assert.equal(missing.audits.length, 2, "el fallo también se audita");

    const failed = harness(mk(), { dispatchStatus: "failed" });
    const s2 = await runPostStaySurveyStep(failed.deps, CLOCK);
    assert.deepEqual(s2.outcomes.map((o) => [o.status, o.reason, o.dispatched, o.simulated]), [["failed", "Email provider not configured", false, false], ["failed", "Email provider not configured", false, false]]);

    const noSession = harness(mk(), { issueNull: true });
    const s3 = await runPostStaySurveyStep(noSession.deps, CLOCK);
    assert.deepEqual(s3.outcomes.map((o) => [o.status, o.reason]), [["failed", "session_not_issued"], ["failed", "session_not_issued"]]);
    assert.deepEqual(noSession.dispatched, []);

    const dbDown = harness(mk(), { failReservationsFor: "prop_a" });
    const s4 = await runPostStaySurveyStep(dbDown.deps, CLOCK);
    assert.equal(s4.invited, 1);
    assert.equal(s4.failed, 1);
    assert.deepEqual(s4.outcomes.map((o) => [o.propertyId, o.reservationId, o.status, o.reason]), [["prop_a", "", "failed", "db down"], ["prop_b", "r_b", "invited", null]]);
  });
});

// ── Modo forzado (POST /reservations/:id/post-stay/survey-invite) ─────────────

describe("modo forzado: ignora política y ventana, exige checked_out, actor de personal, enlace solo si simulado", () => {
  const staff = buildServiceContext({ organizationId: "org_a", propertyId: "prop_a", actor: { kind: "system", job: "test" }, permissions: CHECKIN_SERVICE_PERMISSIONS });
  const context = { ...staff, userId: "usr_recepcion", deviceId: "dev_mostrador" };

  it("reserva checked_out fuera de la ventana y sin política → invited con surveyUrl (simulado) y auditoría actorType user", async () => {
    const state = baseState({ reservations: [reservation("r_old", "prop_a", -40)], links: [link("r_old", "g")], guests: [guest("g")] });
    const h = harness(state);
    const result = await invitePostStaySurvey({ reservationId: "r_old", context }, h.deps);
    assert.deepEqual(result, { reservationId: "r_old", status: "invited", reason: null, dispatched: true, simulated: true, channel: "email", recipient: "g***@l7.test", deliveryId: "del_1", surveyUrl: "https://huesped.example.test/?survey=1&token=tok_r_old_secreto&property=prop_a" });
    assert.equal(h.audits[0]?.actorType, "user");
    assert.equal(h.audits[0]?.actorUserId, "usr_recepcion");
    assert.equal(h.audits[0]?.deviceId, "dev_mostrador");
    assert.equal((h.audits[0]?.afterJson as { forced: boolean }).forced, true);
    // Segunda invitación manual: idempotente.
    const again = await invitePostStaySurvey({ reservationId: "r_old", context }, h.deps);
    assert.equal(again.status, "skipped");
    assert.equal(again.reason, "already_invited");
    assert.equal(again.deliveryId, "del_1");
    assert.equal("surveyUrl" in again, false);
  });

  it("con proveedor real (no simulado) el resultado NO lleva surveyUrl", async () => {
    const state = baseState({ reservations: [reservation("r_1", "prop_a", -1)], links: [link("r_1", "g")], guests: [guest("g")] });
    const h = harness(state, { simulated: false });
    const result = await invitePostStaySurvey({ reservationId: "r_1", context }, h.deps);
    assert.equal(result.dispatched, true);
    assert.equal(result.simulated, false);
    assert.equal("surveyUrl" in result, false);
  });

  it("no checked_out → ConflictError RESERVATION_NOT_CHECKED_OUT; desconocida o borrada → NotFoundError; nada emitido", async () => {
    const state = baseState({ reservations: [reservation("r_in", "prop_a", -1, { status: "checked_in" }), reservation("r_del", "prop_a", -1, { deletedAt: new Date() })] });
    const h = harness(state);
    await assert.rejects(invitePostStaySurvey({ reservationId: "r_in", context }, h.deps), (error: unknown) => error instanceof ConflictError && (error.details as { code: string }).code === "RESERVATION_NOT_CHECKED_OUT");
    await assert.rejects(invitePostStaySurvey({ reservationId: "r_del", context }, h.deps), NotFoundError);
    await assert.rejects(invitePostStaySurvey({ reservationId: "r_nope", context }, h.deps), NotFoundError);
    assert.deepEqual(h.issued, []);
    assert.deepEqual(h.dispatched, []);
  });
});

// ── Portal: GET/POST /guest-portal/survey ────────────────────────────────────

type SurveyState = { survey: { id: string; name: string; questionsJson: unknown } | null; responses: Array<{ id: string; reservationId: string; surveyId: string; guestId: string | null; score: number; responsesJson: Record<string, unknown>; createdAt: Date }> };

function surveyHarness(reservation: { status: string; arrivalDate: string; departureDate: string }, state: SurveyState): { deps: Partial<GuestSurveyDeps>; audits: AuditCall[]; created: string[] } {
  const audits: AuditCall[] = [];
  const created: string[] = [];
  const deps: Partial<GuestSurveyDeps> = {
    now: () => NOW,
    loadReservation: async (id) => (id === "res_l7" ? { id, code: "L7-0001", propertyId: "prop_a", ...reservation } : null),
    loadProperty: async () => ({ organizationId: "org_a", name: "Hotel L7 (prueba)", timezone: TZ }),
    findSurvey: async () => state.survey,
    createSurvey: async (propertyId) => {
      created.push(propertyId);
      state.survey = { id: "srv_default", name: DEFAULT_GUEST_SURVEY_NAME, questionsJson: [...DEFAULT_GUEST_SURVEY_QUESTIONS] };
      return state.survey;
    },
    findResponse: async (reservationId) => state.responses.find((row) => row.reservationId === reservationId) ?? null,
    createResponse: async (data) => {
      const row = { id: `sr_${state.responses.length + 1}`, ...data, createdAt: NOW };
      state.responses.push(row);
      return { id: row.id, createdAt: row.createdAt };
    },
    audit: ((input: AuditCall) => {
      audits.push(input);
      return { id: `aud_${audits.length}` } as unknown as ReturnType<typeof recordAuditEvent>;
    }) as typeof recordAuditEvent
  };
  return { deps, audits, created };
}

const SESSION: VerifiedGuestSession = { reservationId: "res_l7", propertyId: "prop_a", guestId: "guest_titular", purpose: "survey" };
const POST_STAY = { status: "checked_out", arrivalDate: "2026-09-16", departureDate: "2026-09-19" };

describe("portal: cuestionario, una respuesta por reserva, solo tras la salida", () => {
  it("GET sin Survey → cuestionario por defecto (id null), available true en post_stay; con Survey del editor → preguntas normalizadas", async () => {
    const state: SurveyState = { survey: null, responses: [] };
    const h = surveyHarness(POST_STAY, state);
    const view = await getGuestSurveyView(SESSION, h.deps);
    assert.deepEqual(view, {
      survey: { id: null, name: DEFAULT_GUEST_SURVEY_NAME, questions: [...DEFAULT_GUEST_SURVEY_QUESTIONS] },
      answered: false,
      answeredAt: null,
      available: true,
      stage: "post_stay",
      reservationStatus: "checked_out",
      // Cabecera mínima sin PII para la sesión `survey` del enlace (que no puede leer /guest-portal/reservation).
      reservation: { reservationId: "res_l7", reservationCode: "L7-0001", propertyId: "prop_a", propertyName: "Hotel L7 (prueba)" },
      sessionPurpose: "survey"
    });
    assert.equal((await getGuestSurveyView({ ...SESSION, purpose: "sign_in" }, h.deps)).sessionPurpose, "sign_in");

    state.survey = { id: "srv_1", name: "Encuesta del hotel", questionsJson: [{ id: "q1", text: "¿Limpieza?" }] };
    const custom = await getGuestSurveyView(SESSION, h.deps);
    assert.deepEqual(custom.survey, { id: "srv_1", name: "Encuesta del hotel", questions: [{ key: "q1", type: "text", label: "¿Limpieza?", required: false }] });
  });

  it("POST crea la Survey por defecto si falta, guarda score en columna y { ...answers, score, source } en JSON, audita sin texto libre; el segundo envío → 409 SURVEY_ALREADY_ANSWERED", async () => {
    const state: SurveyState = { survey: null, responses: [] };
    const h = surveyHarness(POST_STAY, state);
    const result = await submitGuestSurvey({ session: SESSION, body: { score: 9, answers: { comment: "Todo perfecto", nps: 9 } }, correlationId: "corr_1" }, h.deps);
    assert.deepEqual(result, { responseId: "sr_1", surveyId: "srv_default", score: 9, answeredAt: NOW.toISOString() });
    assert.deepEqual(h.created, ["prop_a"], "la Survey por defecto se crea al primer envío");
    assert.deepEqual(state.responses[0], { id: "sr_1", surveyId: "srv_default", reservationId: "res_l7", guestId: "guest_titular", score: 9, responsesJson: { comment: "Todo perfecto", nps: 9, score: 9, source: "guest_portal" }, createdAt: NOW });
    assert.equal(h.audits.length, 1);
    assert.equal(h.audits[0]?.action, SURVEY_RESPONSE_AUDIT_ACTION);
    assert.equal(h.audits[0]?.actorType, "system");
    assert.equal(h.audits[0]?.actorUserId, "guest:res_l7");
    assert.equal(h.audits[0]?.entityType, "survey_response");
    assert.deepEqual(h.audits[0]?.afterJson, { surveyId: "srv_default", reservationId: "res_l7", score: 9, answerKeys: ["comment", "nps"], source: "guest_portal" });
    assert.equal(JSON.stringify(h.audits).includes("Todo perfecto"), false, "la auditoría no lleva el texto libre");

    const view = await getGuestSurveyView(SESSION, h.deps);
    assert.equal(view.answered, true);
    assert.equal(view.answeredAt, NOW.toISOString());
    assert.equal(view.available, false);
    await assert.rejects(submitGuestSurvey({ session: SESSION, body: { score: 2 }, correlationId: "corr_2" }, h.deps), (error: unknown) => error instanceof ConflictError && (error.details as { code: string }).code === "SURVEY_ALREADY_ANSWERED");
    assert.equal(state.responses.length, 1);
  });

  it("fuera de post_stay (alojada) → GET available false y POST 409 SURVEY_NOT_AVAILABLE; reserva desconocida → 404", async () => {
    const state: SurveyState = { survey: null, responses: [] };
    const h = surveyHarness({ status: "checked_in", arrivalDate: "2026-09-19", departureDate: "2026-09-22" }, state);
    const view = await getGuestSurveyView(SESSION, h.deps);
    assert.equal(view.stage, "in_house");
    assert.equal(view.available, false);
    await assert.rejects(submitGuestSurvey({ session: SESSION, body: { score: 10 }, correlationId: "corr" }, h.deps), (error: unknown) => error instanceof ConflictError && (error.details as { code: string; stage: string }).code === "SURVEY_NOT_AVAILABLE" && (error.details as { stage: string }).stage === "in_house");
    assert.equal(state.responses.length, 0);
    assert.equal(h.created.length, 0, "sin respuesta no se crea la Survey");
    await assert.rejects(getGuestSurveyView({ ...SESSION, reservationId: "res_nope" }, h.deps), NotFoundError);
  });

  it("corrector REV-L7-02: confirmada con la salida pasada (nunca se alojó) → post_stay por fecha pero available false y POST 409 SURVEY_NOT_AVAILABLE { status: confirmed }; nada entra en el NPS", async () => {
    const state: SurveyState = { survey: null, responses: [] };
    const h = surveyHarness({ status: "confirmed", arrivalDate: "2026-09-16", departureDate: "2026-09-19" }, state);
    const view = await getGuestSurveyView(SESSION, h.deps);
    assert.equal(view.stage, "post_stay");
    assert.equal(view.reservationStatus, "confirmed");
    assert.equal(view.available, false);
    await assert.rejects(
      submitGuestSurvey({ session: SESSION, body: { score: 2, answers: { comment: "nunca fui" } }, correlationId: "corr_ns" }, h.deps),
      (error: unknown) => error instanceof ConflictError && (error.details as { code: string; stage: string; status: string }).code === "SURVEY_NOT_AVAILABLE" && (error.details as { stage: string }).stage === "post_stay" && (error.details as { status: string }).status === "confirmed"
    );
    assert.equal(state.responses.length, 0);
    assert.equal(h.created.length, 0);
    assert.equal(surveyOpenFor({ status: "checked_out" }, "post_stay"), true);
    assert.equal(surveyOpenFor({ status: "confirmed" }, "post_stay"), false);
    assert.equal(surveyOpenFor({ status: "checked_out" }, "in_house"), false);
  });
});

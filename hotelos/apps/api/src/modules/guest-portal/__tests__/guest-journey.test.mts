// Unit tests · Tanda L7 · lote L7-07 — recorrido del huésped en recepción
// (modules/guest-portal/guest-journey.service.ts) con dependencias inyectadas:
// clasificación de los avisos por notificationId (invitación y recordatorio por
// sesión del portal, bienvenida y encuesta por reserva), destinatario
// enmascarado, marca SIMULADO honesta, llave activa con serie, encuesta con
// puntuación (columna o responsesJson) y sesiones activas. Sin base de datos
// ni red. Desde apps/api:
//   node --import tsx --test src/modules/guest-portal/__tests__/guest-journey.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NotFoundError } from "../../../lib/http-error.js";
import type { CheckInSessionView } from "../../checkin/checkin-session.service.js";
import {
  getGuestJourney,
  isSimulatedDelivery,
  journeyNotificationIds,
  journeyNotificationKind,
  journeyNotificationsFrom,
  keyDtoFrom,
  portalSessionsDtoFrom,
  surveyDtoFrom,
  surveyScoreFrom,
  type GuestJourneyDeps,
  type JourneyDeliveryRow
} from "../guest-journey.service.js";

globalThis.fetch = (() => {
  throw new Error("red prohibida en los tests del recorrido");
}) as typeof fetch;

const RESERVATION_ID = "res_l707";
const PORTAL_OLD = "gps_old";
const PORTAL_NEW = "gps_new";
const NOW = new Date("2026-09-20T12:00:00.000Z");

function delivery(overrides: Partial<JourneyDeliveryRow> & { id: string; notificationId: string }): JourneyDeliveryRow {
  return {
    templateCode: "checkin_invitation",
    channel: "email",
    status: "sent",
    recipient: "titular.prueba@l7.test",
    errorMessage: "SIMULADO: proveedor no configurado; no se envió de verdad.",
    sentAt: new Date("2026-09-17T09:00:00.000Z"),
    failedAt: null,
    createdAt: new Date("2026-09-17T09:00:00.000Z"),
    ...overrides
  };
}

const SESSION: CheckInSessionView = {
  id: "cis_l707",
  propertyId: "prop_l7",
  reservationId: RESERVATION_ID,
  status: "in_progress",
  channel: "email",
  invitedAt: "2026-09-17T09:00:00.000Z",
  reminderAt: null,
  completedAt: null,
  arrivedAt: null,
  checkedInAt: null,
  etaDeclared: "17:30",
  preferences: [],
  consent: { gdprAt: null, aiDisclosureAt: null, marketing: null, whatsappOptInAt: null } as CheckInSessionView["consent"],
  paymentStatus: "none",
  handoffKind: null,
  handoffReason: null,
  kioskDeviceId: null,
  guests: [],
  createdAt: "2026-09-17T09:00:00.000Z",
  updatedAt: "2026-09-17T09:00:00.000Z",
  policy: {} as CheckInSessionView["policy"],
  steps: []
};

function fakeDeps(overrides: Partial<GuestJourneyDeps> = {}): { deps: Partial<GuestJourneyDeps>; calls: string[] } {
  const calls: string[] = [];
  const deps: Partial<GuestJourneyDeps> = {
    now: () => NOW,
    loadReservation: async (id) => {
      calls.push(`reservation:${id}`);
      return { id, propertyId: "prop_l7" };
    },
    loadCheckIn: async (id) => {
      calls.push(`checkIn:${id}`);
      return SESSION;
    },
    loadPortalSessions: async (id) => {
      calls.push(`portal:${id}`);
      return [
        { id: PORTAL_OLD, status: "revoked", expiresAt: new Date("2026-10-05T00:00:00.000Z"), createdAt: new Date("2026-09-17T09:00:00.000Z") },
        { id: PORTAL_NEW, status: "active", expiresAt: new Date("2026-10-05T00:00:00.000Z"), createdAt: new Date("2026-09-18T10:00:00.000Z") }
      ];
    },
    loadDeliveries: async ({ reservationId, portalSessionIds }) => {
      calls.push(`deliveries:${reservationId}:${portalSessionIds.join("+")}`);
      return [
        delivery({ id: "nd_inv_old", notificationId: `checkin_invitation:${PORTAL_OLD}` }),
        delivery({ id: "nd_inv_new", notificationId: `checkin_invitation:${PORTAL_NEW}`, createdAt: new Date("2026-09-18T10:00:00.000Z"), sentAt: new Date("2026-09-18T10:00:00.000Z") }),
        delivery({ id: "nd_rem", notificationId: `checkin_reminder:${PORTAL_NEW}`, templateCode: "checkin_reminder", createdAt: new Date("2026-09-19T08:00:00.000Z"), sentAt: new Date("2026-09-19T08:00:00.000Z") }),
        delivery({
          id: "nd_welcome",
          notificationId: `welcome:${RESERVATION_ID}:whatsapp`,
          templateCode: "guest_welcome",
          channel: "whatsapp",
          recipient: "+34600000101",
          status: "failed",
          errorMessage: "WhatsApp no configurado",
          sentAt: null,
          failedAt: new Date("2026-09-20T11:00:00.000Z"),
          createdAt: new Date("2026-09-20T11:00:00.000Z")
        }),
        delivery({ id: "nd_other", notificationId: "checkin_invitation:gps_de_otra_reserva", createdAt: new Date("2026-09-19T12:00:00.000Z") })
      ];
    },
    loadKey: async (id) => {
      calls.push(`key:${id}`);
      return {
        id: "mkey_ABC123",
        status: "active",
        createdAt: new Date("2026-09-20T11:30:00.000Z"),
        payloadJson: { serialNumber: "ABC123", validFrom: "2026-09-20", validUntil: "2026-09-22", issuedAt: "2026-09-20T11:30:00.000Z", signedByApple: false, secretHash: "nunca-viaja", qrPayload: "hotelos://unlock?…" }
      };
    },
    loadRequests: async (id) => {
      calls.push(`requests:${id}`);
      return [{ id: "srq_1", requestType: "late_checkout", status: "open", assignedDepartment: "front_office", createdAt: new Date("2026-09-20T09:00:00.000Z") }];
    },
    loadSurveyResponse: async (id) => {
      calls.push(`survey:${id}`);
      return null;
    },
    ...overrides
  };
  return { deps, calls };
}

describe("L7-07 · avisos por notificationId", () => {
  it("journeyNotificationIds: invitación y recordatorio por cada sesión del portal y la encuesta por IGUALDAD; la bienvenida es el único prefijo (REV-L7-01)", () => {
    assert.deepEqual(journeyNotificationIds(RESERVATION_ID, [PORTAL_OLD, PORTAL_NEW]), {
      exact: [`checkin_invitation:${PORTAL_OLD}`, `checkin_reminder:${PORTAL_OLD}`, `checkin_invitation:${PORTAL_NEW}`, `checkin_reminder:${PORTAL_NEW}`, `post_stay_survey:${RESERVATION_ID}`],
      prefixes: [`welcome:${RESERVATION_ID}:`]
    });
    assert.deepEqual(journeyNotificationIds(RESERVATION_ID, []).exact, [`post_stay_survey:${RESERVATION_ID}`], "sin sesiones del portal la consulta sigue teniendo un id exacto");
  });

  it("journeyNotificationKind clasifica los cuatro tipos y descarta lo ajeno (otra sesión, otra reserva, sin id)", () => {
    const ids = [PORTAL_OLD, PORTAL_NEW];
    assert.equal(journeyNotificationKind(`checkin_invitation:${PORTAL_OLD}`, RESERVATION_ID, ids), "checkin_invitation");
    assert.equal(journeyNotificationKind(`checkin_reminder:${PORTAL_NEW}`, RESERVATION_ID, ids), "checkin_reminder");
    assert.equal(journeyNotificationKind(`welcome:${RESERVATION_ID}:email`, RESERVATION_ID, ids), "welcome");
    assert.equal(journeyNotificationKind(`post_stay_survey:${RESERVATION_ID}`, RESERVATION_ID, ids), "post_stay_survey");
    assert.equal(journeyNotificationKind("checkin_invitation:gps_ajena", RESERVATION_ID, ids), null);
    assert.equal(journeyNotificationKind("welcome:res_otra:email", RESERVATION_ID, ids), null);
    // Corrector REV-L7-01: `post_stay_survey:res_07p` NO es de `res_07` (ids cortos del seed / importaciones).
    assert.equal(journeyNotificationKind(`post_stay_survey:${RESERVATION_ID}x`, RESERVATION_ID, ids), null, "otra reserva cuyo id empieza por el nuestro");
    assert.equal(journeyNotificationKind(`post_stay_survey:${RESERVATION_ID}:email`, RESERVATION_ID, ids), null, "sin sufijos: el id de la encuesta es exacto");
    assert.equal(journeyNotificationKind(`welcome:${RESERVATION_ID}x:email`, RESERVATION_ID, ids), null, "la bienvenida lleva separador: tampoco cruza reservas");
    assert.equal(journeyNotificationKind(null, RESERVATION_ID, ids), null);
  });

  it("corrector REV-L7-01: dos reservas `r1` y `r1x` no se mezclan (la invitación y el aviso de la encuesta van a la suya)", () => {
    const rows = [
      delivery({ id: "s_r1", notificationId: "post_stay_survey:r1", templateCode: "post_stay_survey", sentAt: new Date("2026-09-25T10:00:00.000Z"), createdAt: new Date("2026-09-25T10:00:00.000Z") }),
      delivery({ id: "s_r1x", notificationId: "post_stay_survey:r1x", templateCode: "post_stay_survey", sentAt: new Date("2026-09-26T10:00:00.000Z"), createdAt: new Date("2026-09-26T10:00:00.000Z") }),
      delivery({ id: "w_r1x", notificationId: "welcome:r1x:email", templateCode: "guest_welcome", createdAt: new Date("2026-09-24T10:00:00.000Z") })
    ];
    const r1 = journeyNotificationsFrom(rows, "r1", []);
    assert.deepEqual(r1.map((n) => [n.id, n.kind]), [["s_r1", "post_stay_survey"]]);
    assert.deepEqual(surveyDtoFrom(r1, null), { invitedAt: "2026-09-25T10:00:00.000Z", answeredAt: null, score: null });
    const r1x = journeyNotificationsFrom(rows, "r1x", []);
    assert.deepEqual(r1x.map((n) => [n.id, n.kind]), [["w_r1x", "welcome"], ["s_r1x", "post_stay_survey"]]);
    assert.equal(surveyDtoFrom(r1x, null).invitedAt, "2026-09-26T10:00:00.000Z");
    // Sin invitación propia el recorrido de r1 no hereda la de r1x aunque el otro id empiece igual.
    const onlyOther = journeyNotificationsFrom([rows[1]!, rows[2]!], "r1", []);
    assert.deepEqual(onlyOther, []);
    assert.equal(surveyDtoFrom(onlyOther, null).invitedAt, null);
  });

  it("isSimulatedDelivery: solo «sent» con errorMessage SIMULADO; un envío fallido o real no lo es", () => {
    assert.equal(isSimulatedDelivery({ status: "sent", errorMessage: "SIMULADO: proveedor no configurado; no se envió de verdad." }), true);
    assert.equal(isSimulatedDelivery({ status: "sent", errorMessage: null }), false);
    assert.equal(isSimulatedDelivery({ status: "failed", errorMessage: "SIMULADO…" }), false);
  });

  it("journeyNotificationsFrom: orden cronológico, destinatario enmascarado, motivo solo al fallar, filas ajenas fuera", () => {
    const rows = [
      delivery({ id: "b", notificationId: `checkin_invitation:${PORTAL_NEW}`, createdAt: new Date("2026-09-18T10:00:00.000Z") }),
      delivery({ id: "a", notificationId: `checkin_invitation:${PORTAL_OLD}`, createdAt: new Date("2026-09-17T09:00:00.000Z") }),
      delivery({ id: "w", notificationId: `welcome:${RESERVATION_ID}:sms`, channel: "sms", recipient: "+34600000101", status: "failed", errorMessage: "sin proveedor", sentAt: null, failedAt: new Date("2026-09-20T11:00:00.000Z"), createdAt: new Date("2026-09-20T11:00:00.000Z") }),
      delivery({ id: "x", notificationId: "checkin_invitation:gps_ajena" })
    ];
    const out = journeyNotificationsFrom(rows, RESERVATION_ID, [PORTAL_OLD, PORTAL_NEW]);
    assert.deepEqual(
      out.map((n) => n.id),
      ["a", "b", "w"]
    );
    assert.equal(out[0]!.recipient, "t***@l7.test");
    assert.equal(out[0]!.simulated, true);
    assert.equal(out[0]!.error, null, "un envío simulado no es un fallo");
    assert.equal(out[2]!.kind, "welcome");
    assert.equal(out[2]!.recipient, "***101");
    assert.equal(out[2]!.status, "failed");
    assert.equal(out[2]!.simulated, false);
    assert.equal(out[2]!.error, "sin proveedor");
    assert.equal(out[2]!.failedAt, "2026-09-20T11:00:00.000Z");
    const raw = JSON.stringify(out);
    assert.doesNotMatch(raw, /titular\.prueba|\+34600000101/, "ningún destinatario completo en la salida");
  });
});

describe("L7-07 · llave, encuesta y sesiones del portal", () => {
  it("keyDtoFrom: llave activa → serie y vigencia sin el hash del secreto ni el QR; revocada o sin serie → null", () => {
    const active = keyDtoFrom({ id: "mkey_S1", status: "active", createdAt: NOW, payloadJson: { serialNumber: "S1", validFrom: "2026-09-20", validUntil: "2026-09-22", issuedAt: "2026-09-20T11:30:00.000Z", signedByApple: false, secretHash: "x", qrPayload: "y" } });
    assert.deepEqual(active, { issued: true, serial: "S1", status: "active", validFrom: "2026-09-20", validUntil: "2026-09-22", issuedAt: "2026-09-20T11:30:00.000Z", signedByApple: false });
    assert.doesNotMatch(JSON.stringify(active), /secretHash|qrPayload/);
    assert.equal(keyDtoFrom({ id: "mkey_S2", status: "revoked", createdAt: NOW, payloadJson: { serialNumber: "S2" } }), null);
    assert.equal(keyDtoFrom(null), null);
    assert.equal(keyDtoFrom({ id: "mkey_S3", status: "active", createdAt: NOW, payloadJson: {} })?.serial, "S3", "sin serialNumber en el payload, la serie sale del id mkey_<serie>");
    assert.equal(keyDtoFrom({ id: "gpa_sin_serie", status: "active", createdAt: NOW, payloadJson: null }), null);
  });

  it("surveyScoreFrom: columna score (Decimal como string) o responsesJson.score | nps | rating; nada → null", () => {
    assert.equal(surveyScoreFrom({ score: "9.00", responsesJson: {} }), 9);
    assert.equal(surveyScoreFrom({ score: null, responsesJson: { nps: 8 } }), 8);
    assert.equal(surveyScoreFrom({ score: null, responsesJson: { rating: "7" } }), 7);
    assert.equal(surveyScoreFrom({ score: null, responsesJson: { comment: "bien" } }), null);
    assert.equal(surveyScoreFrom({ score: "no-numérico", responsesJson: null }), null);
  });

  it("surveyDtoFrom: invitedAt de la última entrega post_stay_survey (sentAt o createdAt) y respuesta con puntuación", () => {
    const notifications = journeyNotificationsFrom(
      [
        delivery({ id: "s1", notificationId: `post_stay_survey:${RESERVATION_ID}`, templateCode: "post_stay_survey", sentAt: null, status: "pending", errorMessage: null, createdAt: new Date("2026-09-25T09:00:00.000Z") }),
        delivery({ id: "s2", notificationId: `post_stay_survey:${RESERVATION_ID}`, templateCode: "post_stay_survey", sentAt: new Date("2026-09-25T10:00:00.000Z"), createdAt: new Date("2026-09-25T10:00:00.000Z") })
      ],
      RESERVATION_ID,
      []
    );
    assert.deepEqual(surveyDtoFrom(notifications, null), { invitedAt: "2026-09-25T10:00:00.000Z", answeredAt: null, score: null });
    assert.deepEqual(surveyDtoFrom(notifications, { createdAt: new Date("2026-09-26T08:00:00.000Z"), score: "9.00", responsesJson: {} }), { invitedAt: "2026-09-25T10:00:00.000Z", answeredAt: "2026-09-26T08:00:00.000Z", score: 9 });
    assert.deepEqual(surveyDtoFrom([], null), { invitedAt: null, answeredAt: null, score: null });
  });

  it("portalSessionsDtoFrom: solo las activas no caducadas cuentan; lastCreatedAt es la más reciente", () => {
    const rows = [
      { id: "a", status: "revoked", expiresAt: new Date("2026-10-05T00:00:00.000Z"), createdAt: new Date("2026-09-17T09:00:00.000Z") },
      { id: "b", status: "active", expiresAt: new Date("2026-09-19T00:00:00.000Z"), createdAt: new Date("2026-09-18T09:00:00.000Z") },
      { id: "c", status: "active", expiresAt: new Date("2026-10-05T00:00:00.000Z"), createdAt: new Date("2026-09-18T10:00:00.000Z") }
    ];
    assert.deepEqual(portalSessionsDtoFrom(rows, NOW), { active: 1, lastCreatedAt: "2026-09-18T10:00:00.000Z" });
    assert.deepEqual(portalSessionsDtoFrom([], NOW), { active: 0, lastCreatedAt: null });
  });
});

describe("L7-07 · getGuestJourney con dependencias inyectadas", () => {
  it("ensambla la vista: sesión, avisos (dos invitaciones + recordatorio + bienvenida fallida; la ajena fuera), llave, peticiones, encuesta vacía y sesiones", async () => {
    const { deps, calls } = fakeDeps();
    const view = await getGuestJourney(RESERVATION_ID, deps);
    assert.equal(view.reservationId, RESERVATION_ID);
    assert.equal(view.checkIn?.status, "in_progress");
    assert.equal(view.checkIn?.etaDeclared, "17:30");
    assert.deepEqual(
      view.notifications.map((n) => [n.kind, n.channel, n.status, n.simulated, n.recipient]),
      [
        ["checkin_invitation", "email", "sent", true, "t***@l7.test"],
        ["checkin_invitation", "email", "sent", true, "t***@l7.test"],
        ["checkin_reminder", "email", "sent", true, "t***@l7.test"],
        ["welcome", "whatsapp", "failed", false, "***101"]
      ]
    );
    assert.equal(view.notifications[3]!.error, "WhatsApp no configurado");
    assert.deepEqual(view.key, { issued: true, serial: "ABC123", status: "active", validFrom: "2026-09-20", validUntil: "2026-09-22", issuedAt: "2026-09-20T11:30:00.000Z", signedByApple: false });
    assert.deepEqual(view.requests, [{ id: "srq_1", kind: "late_checkout", status: "open", department: "front_office", createdAt: "2026-09-20T09:00:00.000Z" }]);
    assert.deepEqual(view.survey, { invitedAt: null, answeredAt: null, score: null });
    assert.deepEqual(view.portalSessions, { active: 1, lastCreatedAt: "2026-09-18T10:00:00.000Z" });
    // Las entregas se piden con TODAS las sesiones del portal de la reserva (la revocada incluida).
    assert.ok(calls.includes(`deliveries:${RESERVATION_ID}:${PORTAL_OLD}+${PORTAL_NEW}`), calls.join(" | "));
    const raw = JSON.stringify(view);
    assert.doesNotMatch(raw, /titular\.prueba|\+34600000101|secretHash|qrPayload|nunca-viaja/, "sin PII ni secretos");
  });

  it("sin sesión, sin avisos, sin llave: la vista es honesta (nulls y listas vacías) y no inventa nada", async () => {
    const { deps } = fakeDeps({
      loadCheckIn: async () => null,
      loadPortalSessions: async () => [],
      loadDeliveries: async () => [],
      loadKey: async () => null,
      loadRequests: async () => []
    });
    const view = await getGuestJourney(RESERVATION_ID, deps);
    assert.equal(view.checkIn, null);
    assert.deepEqual(view.notifications, []);
    assert.equal(view.key, null);
    assert.deepEqual(view.requests, []);
    assert.deepEqual(view.survey, { invitedAt: null, answeredAt: null, score: null });
    assert.deepEqual(view.portalSessions, { active: 0, lastCreatedAt: null });
  });

  it("encuesta enviada (simulada) y respondida con 9 → survey { invitedAt, answeredAt, score }", async () => {
    const { deps } = fakeDeps({
      loadDeliveries: async () => [delivery({ id: "s1", notificationId: `post_stay_survey:${RESERVATION_ID}`, templateCode: "post_stay_survey", sentAt: new Date("2026-09-25T10:00:00.000Z"), createdAt: new Date("2026-09-25T10:00:00.000Z") })],
      loadSurveyResponse: async () => ({ createdAt: new Date("2026-09-26T08:00:00.000Z"), score: "9.00", responsesJson: { comment: "Todo bien" } })
    });
    const view = await getGuestJourney(RESERVATION_ID, deps);
    assert.deepEqual(view.survey, { invitedAt: "2026-09-25T10:00:00.000Z", answeredAt: "2026-09-26T08:00:00.000Z", score: 9 });
    assert.equal(view.notifications[0]!.kind, "post_stay_survey");
    assert.equal(view.notifications[0]!.simulated, true);
  });

  it("reserva inexistente → 404 sin consultar nada más", async () => {
    const { deps, calls } = fakeDeps({ loadReservation: async () => null });
    await assert.rejects(getGuestJourney("res_no", deps), (error: unknown) => error instanceof NotFoundError);
    assert.deepEqual(calls, []);
  });
});

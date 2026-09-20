// Recorrido del huésped · Tanda L7 · lote L7-07 — computeJourney (../journey.ts)
// con el recorrido del API: sesión de check-in (canal, estado, firmados n/m),
// avisos con marca «simulado», llave móvil, peticiones abiertas y encuesta
// (enviada / respondida / puntuación); sin recorrido del API los pasos nuevos
// quedan «no disponibles» y nunca son la siguiente acción. Desde apps/admin-web:
//   corepack pnpm --filter @hotelos/admin-web test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdminReservation, FolioBalance } from "../../../services/pmsCommerceApi";
import type { GuestProfile } from "../../../services/guestsApi";
import type { GuestJourneyNotification, GuestJourneyView, JourneyCheckIn } from "../../../services/guestJourneyApi";
import {
  NEXT_ACTION_LABEL,
  NOTIFICATION_KIND_LABEL,
  completeCount,
  computeJourney,
  describeNotification,
  invitationAction,
  invitationChannel,
  journeyChannel,
  lastNotification,
  listStage,
  signedCount,
  surveyActionAvailable,
  type JourneyStepKey
} from "../journey";

const TODAY = "2026-09-20";

const RESERVATION: AdminReservation = {
  id: "res_l707",
  propertyId: "prop_l7",
  code: "L7-0007",
  channel: "direct",
  status: "confirmed",
  arrivalDate: "2026-09-22",
  departureDate: "2026-09-24",
  adults: 2,
  children: 0,
  roomTypeId: "rt_dbl",
  assignedRoomId: "room_101",
  bookerName: "Huésped Prueba"
} as AdminReservation;

const GUEST: GuestProfile = { id: "guest_1", organizationId: "org_l7", firstName: "Huésped", fullName: "Huésped Prueba", documentType: "DNI", documentNumber: "00000000T" } as GuestProfile;

const FOLIO: FolioBalance = {
  folio: { id: "folio_1", reservationId: "res_l707", status: "open", currency: "EUR" },
  lines: [],
  payments: [],
  chargesTotal: 200,
  paymentsTotal: 200,
  balanceDue: 0
} as unknown as FolioBalance;

function traveller(overrides: Partial<JourneyCheckIn["guests"][number]> & { id: string }): JourneyCheckIn["guests"][number] {
  return {
    sessionId: "cis_1",
    guestId: null,
    guestRegisterRecordId: null,
    isPrimary: false,
    ordinal: 1,
    status: "pending",
    ageAtArrival: 40,
    isMinor: false,
    providedByCheckInGuestId: null,
    kinship: null,
    guardianTitle: null,
    identityVerificationMethod: null,
    identityVerifiedAt: null,
    firstName: null,
    surname1: null,
    surname2: null,
    nationality: null,
    documentType: null,
    documentNumberLast3: null,
    hasEmail: false,
    hasPhoneMobile: false,
    createdAt: "2026-09-17T09:00:00.000Z",
    updatedAt: "2026-09-17T09:00:00.000Z",
    ...overrides
  };
}

function session(overrides: Partial<JourneyCheckIn> = {}): JourneyCheckIn {
  return {
    id: "cis_1",
    propertyId: "prop_l7",
    reservationId: "res_l707",
    status: "in_progress",
    channel: "email",
    invitedAt: "2026-09-17T09:00:00.000Z",
    reminderAt: null,
    completedAt: null,
    arrivedAt: null,
    checkedInAt: null,
    etaDeclared: "17:30",
    preferences: [],
    consent: { gdprAt: null, aiDisclosureAt: null, marketing: null, whatsappOptInAt: null } as JourneyCheckIn["consent"],
    paymentStatus: "none",
    handoffKind: null,
    handoffReason: null,
    kioskDeviceId: null,
    guests: [
      traveller({ id: "cg_1", isPrimary: true, ordinal: 0, status: "signed", documentNumberLast3: "00T" }),
      traveller({ id: "cg_2", ordinal: 1, status: "data_complete" })
    ],
    createdAt: "2026-09-17T09:00:00.000Z",
    updatedAt: "2026-09-18T09:00:00.000Z",
    policy: {} as JourneyCheckIn["policy"],
    steps: [],
    ...overrides
  };
}

function notification(overrides: Partial<GuestJourneyNotification> & { id: string; kind: GuestJourneyNotification["kind"] }): GuestJourneyNotification {
  return {
    templateCode: overrides.kind,
    channel: "email",
    status: "sent",
    simulated: true,
    recipient: "h***@l7.test",
    sentAt: "2026-09-17T09:00:00.000Z",
    failedAt: null,
    createdAt: "2026-09-17T09:00:00.000Z",
    error: null,
    ...overrides
  };
}

function journey(overrides: Partial<GuestJourneyView> = {}): GuestJourneyView {
  return {
    reservationId: "res_l707",
    checkIn: null,
    notifications: [],
    key: null,
    requests: [],
    survey: { invitedAt: null, answeredAt: null, score: null },
    portalSessions: { active: 0, lastCreatedAt: null },
    ...overrides
  };
}

function stepsByKey(result: ReturnType<typeof computeJourney>): Record<JourneyStepKey, ReturnType<typeof computeJourney>["steps"][number]> {
  return Object.fromEntries(result.steps.map((s) => [s.key, s])) as Record<JourneyStepKey, ReturnType<typeof computeJourney>["steps"][number]>;
}

describe("L7-07 · computeJourney: orden y pasos", () => {
  it("13 pasos en el orden del recorrido real; sin recorrido del API los nuevos quedan «no disponibles» y no son siguiente acción", () => {
    const result = computeJourney(RESERVATION, FOLIO, GUEST, "101", null, TODAY);
    assert.deepEqual(
      result.steps.map((s) => s.key),
      ["booked", "invitation", "precheckin", "identity", "payment", "room", "checkin", "key", "welcome", "stay", "requests", "checkout", "survey"]
    );
    const by = stepsByKey(result);
    for (const key of ["invitation", "precheckin", "key", "welcome", "requests", "survey"] as const) {
      assert.equal(by[key].state, "pending", key);
      assert.equal(by[key].unknown, true, key);
      assert.match(by[key].detail, /no disponible/);
    }
    assert.equal(result.next?.key, "checkin", "la siguiente acción salta los pasos desconocidos: booked, identidad, pago y habitación ya están hechos");
    assert.equal(result.cancelled, false);
  });

  it("sin sesión y reserva viva: invitación y pre-check-in pendientes; la invitación es la siguiente acción", () => {
    const result = computeJourney(RESERVATION, FOLIO, null, "101", journey(), TODAY);
    const by = stepsByKey(result);
    assert.equal(by.invitation.state, "pending");
    assert.match(by.invitation.detail, /sin invitar/);
    assert.equal(by.precheckin.state, "pending");
    assert.equal(result.next?.key, "invitation");
    assert.equal(NEXT_ACTION_LABEL[result.next!.key], "Invitar al check-in en línea");
    assert.equal(by.key.state, "pending");
    assert.match(by.key.detail, /Se emite en el check-in/);
    assert.equal(by.welcome.state, "pending");
    assert.match(by.welcome.detail, /tras el check-in/);
    assert.equal(by.requests.state, "skipped");
    assert.equal(by.requests.badge, "Ninguna");
    assert.equal(by.survey.state, "pending");
    assert.match(by.survey.detail, /tras la salida/);
  });

  it("sesión en curso con invitación simulada y recordatorio: invitación hecha (simulada, destinatario enmascarado), pre-check-in en curso con firmados 1/2", () => {
    const view = journey({
      checkIn: session(),
      notifications: [
        notification({ id: "n1", kind: "checkin_invitation" }),
        notification({ id: "n2", kind: "checkin_reminder", sentAt: "2026-09-19T08:00:00.000Z", createdAt: "2026-09-19T08:00:00.000Z" })
      ],
      portalSessions: { active: 1, lastCreatedAt: "2026-09-17T09:00:00.000Z" }
    });
    const result = computeJourney(RESERVATION, FOLIO, null, "101", view, TODAY);
    const by = stepsByKey(result);
    assert.equal(by.invitation.state, "done");
    assert.match(by.invitation.detail, /^Invitación: envío simulado por correo el .+ a h\*\*\*@l7\.test · recordatorio: envío simulado por correo/);
    assert.doesNotMatch(JSON.stringify(result.steps), /huesped\.prueba|@l7\.test"/, "solo el destinatario enmascarado");
    assert.equal(by.precheckin.state, "active");
    assert.equal(by.precheckin.badge, "En curso");
    assert.match(by.precheckin.detail, /viajeros completos 2\/2 · firmados 1\/2 · llegada prevista 17:30/);
    // Identidad: sin perfil con documento, pero el titular la capturó en el pre-check-in.
    assert.equal(by.identity.state, "done");
    assert.match(by.identity.detail, /Documento capturado en el pre-check-in \(…00T\) · pendiente de cotejo/);
    assert.equal(result.next?.key, "checkin");
  });

  it("invitación fallida → bloqueada y siguiente acción; sesión caducada → pre-check-in bloqueado", () => {
    const failed = journey({
      checkIn: session({ status: "invited" }),
      notifications: [notification({ id: "n1", kind: "checkin_invitation", status: "failed", simulated: false, sentAt: null, failedAt: "2026-09-17T09:00:00.000Z", error: "sin proveedor" })]
    });
    const result = computeJourney(RESERVATION, FOLIO, GUEST, "101", failed, TODAY);
    const by = stepsByKey(result);
    assert.equal(by.invitation.state, "blocked");
    assert.match(by.invitation.detail, /envío fallido por correo: sin proveedor/);
    assert.equal(result.next?.key, "invitation");

    const expired = computeJourney(RESERVATION, FOLIO, GUEST, "101", journey({ checkIn: session({ status: "expired" }) }), TODAY);
    assert.equal(stepsByKey(expired).precheckin.state, "blocked");
    assert.match(stepsByKey(expired).precheckin.detail, /caducado/);

    const handedOff = computeJourney(RESERVATION, FOLIO, GUEST, "101", journey({ checkIn: session({ status: "handed_off", handoffReason: "menor sin adulto" }) }), TODAY);
    assert.equal(stepsByKey(handedOff).precheckin.state, "blocked");
    assert.match(stepsByKey(handedOff).precheckin.detail, /Derivado a recepción: menor sin adulto/);
    assert.equal(handedOff.next?.key, "precheckin");
  });

  it("alojado con llave, bienvenida por WhatsApp y una petición abierta: llave y bienvenida hechas, peticiones en curso", () => {
    const view = journey({
      checkIn: session({ status: "checked_in", completedAt: "2026-09-21T10:00:00.000Z", checkedInAt: "2026-09-22T15:00:00.000Z", channel: "kiosk", guests: [traveller({ id: "cg_1", isPrimary: true, ordinal: 0, status: "verified", documentNumberLast3: "00T", identityVerifiedAt: "2026-09-22T15:00:00.000Z" })] }),
      notifications: [
        notification({ id: "n1", kind: "checkin_invitation" }),
        notification({ id: "n3", kind: "welcome", channel: "whatsapp", recipient: "***101", simulated: false, sentAt: "2026-09-22T15:01:00.000Z", createdAt: "2026-09-22T15:01:00.000Z" })
      ],
      key: { issued: true, serial: "ABC123", status: "active", validFrom: "2026-09-22", validUntil: "2026-09-24", issuedAt: "2026-09-22T15:00:00.000Z", signedByApple: false },
      requests: [
        { id: "srq_1", kind: "late_checkout", status: "open", department: "front_office", createdAt: "2026-09-23T08:00:00.000Z" },
        { id: "srq_2", kind: "luggage", status: "closed", department: "front_office", createdAt: "2026-09-22T16:00:00.000Z" }
      ]
    });
    const inHouse = { ...RESERVATION, status: "checked_in" };
    const result = computeJourney(inHouse, FOLIO, null, "101", view, "2026-09-23");
    const by = stepsByKey(result);
    assert.equal(by.precheckin.state, "done");
    assert.match(by.precheckin.detail, /^Alojado el .+ · viajeros completos 1\/1 · firmados 1\/1/);
    assert.equal(by.identity.state, "done");
    assert.match(by.identity.detail, /identidad verificada/);
    assert.equal(by.checkin.state, "done");
    assert.match(by.checkin.detail, /Huésped registrado el .+ · check-in autónomo en kiosco/);
    assert.equal(by.key.state, "done");
    assert.match(by.key.detail, /Llave móvil ABC123 · válida hasta el .+ · QR de demo/);
    assert.equal(by.welcome.state, "done");
    assert.match(by.welcome.detail, /^Mensaje de bienvenida: envío por WhatsApp el .+ a \*\*\*101\.$/);
    assert.equal(by.stay.state, "active");
    assert.equal(by.requests.state, "active");
    assert.equal(by.requests.badge, "1 abierta");
    assert.match(by.requests.detail, /1 de 2 sin atender/);
    assert.equal(result.next?.key, "checkout", "las peticiones abiertas no son la siguiente acción del recorrido");
    assert.equal(result.total, 13, "con peticiones registradas cuenta el paso");
  });

  it("alojado sin llave ni bienvenida: pendientes con la instrucción honesta (tarjeta en recepción; sin mensaje registrado)", () => {
    const result = computeJourney({ ...RESERVATION, status: "checked_in" }, FOLIO, GUEST, "101", journey({ checkIn: session({ status: "checked_in" }) }), "2026-09-23");
    const by = stepsByKey(result);
    assert.equal(by.key.state, "pending");
    assert.match(by.key.detail, /entregar la tarjeta en recepción/);
    assert.equal(by.welcome.state, "pending");
    assert.match(by.welcome.detail, /Sin mensaje de bienvenida registrado/);
    assert.equal(result.next?.key, "key");
  });

  it("salida hecha: encuesta pendiente → siguiente acción «Enviar la encuesta»; enviada sin respuesta → en curso; respondida → hecha con puntuación", () => {
    const out = { ...RESERVATION, status: "checked_out" };
    const pending = computeJourney(out, FOLIO, GUEST, "101", journey({ checkIn: session({ status: "checked_in" }) }), "2026-09-25");
    assert.equal(stepsByKey(pending).survey.state, "pending");
    assert.match(stepsByKey(pending).survey.detail, /Pendiente de envío/);
    assert.equal(pending.next?.key, "survey");
    assert.equal(NEXT_ACTION_LABEL.survey, "Enviar la encuesta post-estancia");
    assert.equal(stepsByKey(pending).key.state, "skipped", "sin llave tras la salida no hay nada que hacer");
    assert.equal(stepsByKey(pending).welcome.state, "skipped");

    const invited = computeJourney(
      out,
      FOLIO,
      GUEST,
      "101",
      journey({ checkIn: session({ status: "checked_in" }), notifications: [notification({ id: "s1", kind: "post_stay_survey", sentAt: "2026-09-25T10:00:00.000Z", createdAt: "2026-09-25T10:00:00.000Z" })], survey: { invitedAt: "2026-09-25T10:00:00.000Z", answeredAt: null, score: null } }),
      "2026-09-26"
    );
    assert.equal(stepsByKey(invited).survey.state, "active");
    assert.equal(stepsByKey(invited).survey.badge, "Enviada");
    assert.match(stepsByKey(invited).survey.detail, /Enviada \(envío simulado por correo el .+\) · sin respuesta/);
    assert.equal(invited.next, undefined, "todo hecho o en curso: ninguna siguiente acción");

    const answered = computeJourney(out, FOLIO, GUEST, "101", journey({ checkIn: session({ status: "checked_in" }), survey: { invitedAt: "2026-09-25T10:00:00.000Z", answeredAt: "2026-09-26T08:00:00.000Z", score: 9 } }), "2026-09-27");
    assert.equal(stepsByKey(answered).survey.state, "done");
    assert.equal(stepsByKey(answered).survey.badge, "9/10");
    assert.match(stepsByKey(answered).survey.detail, /Respondida el .+ · puntuación 9\/10/);
    assert.equal(answered.done, answered.total, "recorrido completo");
  });

  it("reserva cancelada: los 13 pasos omitidos, total 0, sin siguiente acción", () => {
    const result = computeJourney({ ...RESERVATION, status: "cancelled" }, FOLIO, GUEST, "101", journey({ checkIn: session() }), TODAY);
    assert.ok(result.steps.every((s) => s.state === "skipped"));
    assert.equal(result.total, 0);
    assert.equal(result.next, undefined);
    assert.equal(result.cancelled, true);
  });

  it("pago: la sesión añade el matiz honesto (se cobra en recepción / enlace enviado)", () => {
    const atReception = computeJourney(RESERVATION, { ...FOLIO, paymentsTotal: 0, balanceDue: 200 }, GUEST, "101", journey({ checkIn: session({ paymentStatus: "at_reception" }) }), TODAY);
    assert.match(stepsByKey(atReception).payment.detail, /Sin pagos · saldo .+ Se cobra en recepción \(sin pasarela\)\./);
    const linkSent = computeJourney(RESERVATION, { ...FOLIO, paymentsTotal: 0, balanceDue: 200 }, GUEST, "101", journey({ checkIn: session({ paymentStatus: "link_sent" }) }), TODAY);
    assert.match(stepsByKey(linkSent).payment.detail, /Enlace de pago enviado\./);
  });
});

describe("L7-07 · acciones y utilidades", () => {
  it("invitationAction: invite sin sesión; resend con sesión abierta; null alojado, cancelado, derivado o sin recorrido", () => {
    assert.equal(invitationAction(RESERVATION, null), null);
    assert.equal(invitationAction(RESERVATION, journey()), "invite");
    assert.equal(invitationAction(RESERVATION, journey({ checkIn: session({ status: "invited" }) })), "resend");
    assert.equal(invitationAction(RESERVATION, journey({ checkIn: session({ status: "expired" }) })), "resend");
    assert.equal(invitationAction(RESERVATION, journey({ checkIn: session({ status: "ready_for_arrival" }) })), "resend");
    assert.equal(invitationAction(RESERVATION, journey({ checkIn: session({ status: "handed_off" }) })), null);
    assert.equal(invitationAction({ status: "checked_in" }, journey()), null);
    assert.equal(invitationAction({ status: "cancelled" }, journey()), null);
  });

  it("invitationChannel: el de la sesión si es mensajería (whatsapp / sms); correo en el resto", () => {
    assert.equal(invitationChannel(null), "email");
    assert.equal(invitationChannel(journey({ checkIn: session({ channel: "whatsapp" }) })), "whatsapp");
    assert.equal(invitationChannel(journey({ checkIn: session({ channel: "sms" }) })), "sms");
    assert.equal(invitationChannel(journey({ checkIn: session({ channel: "kiosk" }) })), "email");
  });

  it("surveyActionAvailable: solo checked_out sin respuesta y con recorrido", () => {
    assert.equal(surveyActionAvailable({ status: "checked_out" }, journey()), true);
    assert.equal(surveyActionAvailable({ status: "checked_out" }, journey({ survey: { invitedAt: "2026-09-25T10:00:00.000Z", answeredAt: null, score: null } })), true, "reenviar sigue siendo posible");
    assert.equal(surveyActionAvailable({ status: "checked_out" }, journey({ survey: { invitedAt: "2026-09-25T10:00:00.000Z", answeredAt: "2026-09-26T08:00:00.000Z", score: 9 } })), false);
    assert.equal(surveyActionAvailable({ status: "checked_in" }, journey()), false);
    assert.equal(surveyActionAvailable({ status: "checked_out" }, null), false);
  });

  it("journeyChannel, describeNotification, lastNotification y etiquetas en español", () => {
    assert.equal(journeyChannel("email"), "correo");
    assert.equal(journeyChannel("whatsapp"), "WhatsApp");
    assert.equal(journeyChannel(null), "—");
    assert.equal(journeyChannel("paloma"), "paloma");
    assert.match(describeNotification(notification({ id: "a", kind: "welcome", simulated: false })), /^envío por correo el /);
    assert.match(describeNotification(notification({ id: "a2", kind: "welcome" })), /^envío simulado por correo el /);
    assert.match(describeNotification(notification({ id: "b", kind: "welcome", status: "failed", error: "sin proveedor" })), /^envío fallido por correo: sin proveedor$/);
    assert.equal(describeNotification(notification({ id: "c", kind: "welcome", status: "pending", channel: "sms" })), "envío pendiente por SMS");
    const view = journey({ notifications: [notification({ id: "n1", kind: "checkin_invitation" }), notification({ id: "n2", kind: "checkin_invitation", sentAt: "2026-09-18T10:00:00.000Z" })] });
    assert.equal(lastNotification(view, "checkin_invitation")?.id, "n2");
    assert.equal(lastNotification(view, "welcome"), null);
    assert.equal(lastNotification(null, "welcome"), null);
    assert.deepEqual(Object.values(NOTIFICATION_KIND_LABEL), ["Invitación al check-in en línea", "Recordatorio del check-in", "Mensaje de bienvenida", "Encuesta post-estancia"]);
  });

  it("signedCount / completeCount: los menores no firman; completos = data_complete · signed · verified", () => {
    const s = session({
      guests: [
        traveller({ id: "a", isPrimary: true, status: "signed" }),
        traveller({ id: "b", status: "data_complete" }),
        traveller({ id: "c", status: "data_complete", isMinor: true, ageAtArrival: 8 }),
        traveller({ id: "d", status: "pending" })
      ]
    });
    assert.deepEqual(signedCount(s), { signed: 1, signers: 3 });
    assert.deepEqual(completeCount(s), { complete: 3, total: 4 });
  });

  it("listStage sigue siendo la etapa ligera de la lista (4 banderas)", () => {
    assert.deepEqual(listStage(RESERVATION).done, 2);
    assert.equal(listStage({ ...RESERVATION, status: "checked_out" }).done, 4);
    assert.equal(listStage({ ...RESERVATION, status: "cancelled" }).done, 0);
  });
});

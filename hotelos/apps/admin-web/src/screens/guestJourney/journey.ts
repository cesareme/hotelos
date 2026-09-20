// Recorrido del huésped · cálculo puro de los pasos (Tanda L7 · lote L7-07).
//
// Separado de GuestJourneyWorkspace.tsx para poder probarlo con node --test
// (__tests__/journey.test.mts): las pantallas no cargan bajo node porque
// services/api-client.ts lee `import.meta.env` al importarse (misma razón que
// approvals/approvals-helpers.ts o documents/documents-helpers.ts). Solo tipos
// de los servicios (`import type`, borrados al compilar) y utilidades puras
// (lib/format, content/actions).
//
// Pasos, en el orden del recorrido real (pre-llegada → estancia → salida →
// post-estancia): reserva · invitación al check-in en línea · pre-check-in ·
// identidad (SES) · pago · habitación · check-in · llave · bienvenida ·
// estancia · peticiones · check-out · encuesta post-estancia. Los siete de
// siempre salen de reserva + folio + huésped (Cocoa 22 · lote 3-C); los seis
// nuevos, del recorrido del API (GET /reservations/:id/guest-journey): sesión
// de check-in (canal, estado, firmados n/m), avisos enviados (con su marca
// «simulada»), llave móvil, peticiones abiertas y encuesta (enviada /
// respondida / puntuación). Sin recorrido del API (`journey === null`) esos
// pasos quedan «pendientes» marcados `unknown` y nunca se proponen como
// siguiente acción: no se inventa nada.

import type { AdminReservation, FolioBalance } from "../../services/pmsCommerceApi";
import type { GuestProfile } from "../../services/guestsApi";
import type { GuestJourneyNotification, GuestJourneyView, JourneyCheckIn, JourneyNotificationKind } from "../../services/guestJourneyApi";
import { channelLabel, date, dateRange, dateTime, money } from "../../lib/format";
import { STATUS_LABELS } from "../../content/actions";
import { reservationStatus, type StatusEntry } from "../../content/status-dictionary";

export type StepState = "done" | "active" | "pending" | "blocked" | "skipped";

export type JourneyStepKey =
  | "booked"
  | "invitation"
  | "precheckin"
  | "identity"
  | "payment"
  | "room"
  | "checkin"
  | "key"
  | "welcome"
  | "stay"
  | "requests"
  | "checkout"
  | "survey";

export type JourneyStep = {
  key: JourneyStepKey;
  label: string;
  state: StepState;
  detail: string;
  /** Texto del distintivo cuando el estado no basta («2 abiertas», «Invitado»). */
  badge?: string;
  /** true cuando el recorrido del API no está disponible: el paso no se propone como siguiente acción. */
  unknown?: boolean;
};

export type JourneyResult = { steps: JourneyStep[]; done: number; total: number; next: JourneyStep | undefined; cancelled: boolean };

/** Siguiente mejor acción por paso (título del CocoaCallout). */
export const NEXT_ACTION_LABEL: Record<JourneyStepKey, string> = {
  booked: "Confirmar la reserva",
  invitation: "Invitar al check-in en línea",
  precheckin: "Atender el pre-check-in en recepción",
  identity: "Registrar la identidad del huésped",
  payment: "Cobrar el pago o el depósito",
  room: "Asignar habitación",
  checkin: "Hacer el check-in",
  key: "Emitir la llave o entregar la tarjeta",
  welcome: "Enviar el mensaje de bienvenida",
  stay: "Continuar el recorrido",
  requests: "Atender las peticiones abiertas",
  checkout: "Hacer el check-out",
  survey: "Enviar la encuesta post-estancia"
};

/** Pasos que nunca son «siguiente acción» de recepción (la estancia transcurre; las peticiones tienen su propia sección). */
const NOT_NEXT: readonly JourneyStepKey[] = ["stay", "requests"];

/** Canal de la sesión o del aviso, en español y en minúscula para frases («por correo»). */
const CHANNEL_LABEL: Record<string, string> = {
  email: "correo",
  whatsapp: "WhatsApp",
  sms: "SMS",
  kiosk: "kiosco",
  reception: "recepción",
  manual: "manual"
};

export function journeyChannel(code: string | null | undefined): string {
  if (!code) return "—";
  return CHANNEL_LABEL[code] ?? code;
}

/** Nombre del aviso para la lista «Avisos al huésped». */
export const NOTIFICATION_KIND_LABEL: Record<JourneyNotificationKind, string> = {
  checkin_invitation: "Invitación al check-in en línea",
  checkin_reminder: "Recordatorio del check-in",
  welcome: "Mensaje de bienvenida",
  post_stay_survey: "Encuesta post-estancia"
};

/** Estado de la sesión de check-in en línea, en español. */
export const SESSION_STATUS_LABEL: Record<string, string> = {
  invited: "Invitado",
  in_progress: STATUS_LABELS.inProgress,
  ready_for_arrival: "Listo para llegar",
  arrived: "Llegó",
  checked_in: "Alojado",
  handed_off: "Derivado a recepción",
  expired: STATUS_LABELS.expired,
  cancelled: STATUS_LABELS.cancelled
};

/** Estados de ServiceRequest que siguen abiertos. */
const OPEN_REQUEST_STATUSES: readonly string[] = ["open", "in_progress", "pending"];

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Último aviso de un tipo (el API los devuelve en orden cronológico). */
export function lastNotification(journey: GuestJourneyView | null, kind: JourneyNotificationKind): GuestJourneyNotification | null {
  if (!journey) return null;
  for (let i = journey.notifications.length - 1; i >= 0; i -= 1) {
    const item = journey.notifications[i]!;
    if (item.kind === kind) return item;
  }
  return null;
}

/**
 * «envío simulado por correo el 18 sept, 10:00» · «envío por WhatsApp el …» ·
 * «envío fallido por SMS: motivo» · «envío pendiente por correo». Sustantivo
 * («envío») para que la frase cuadre detrás de cualquier aviso (invitación,
 * recordatorio, mensaje, encuesta).
 */
export function describeNotification(item: GuestJourneyNotification): string {
  const channel = journeyChannel(item.channel);
  if (item.status === "sent") return `envío ${item.simulated ? "simulado " : ""}por ${channel} el ${dateTime(item.sentAt ?? item.createdAt, { style: "dayMonth" })}`;
  if (item.status === "failed") return `envío fallido por ${channel}${item.error ? `: ${item.error}` : ""}`;
  return `envío pendiente por ${channel}`;
}

/** Firmantes (viajeros no menores) y cuántos han firmado. */
export function signedCount(session: Pick<JourneyCheckIn, "guests">): { signed: number; signers: number } {
  const signers = session.guests.filter((guest) => !guest.isMinor);
  return { signed: signers.filter((guest) => guest.status === "signed" || guest.status === "verified").length, signers: signers.length };
}

/** Viajeros con los datos del parte completos (data_complete · signed · verified) sobre el total. */
export function completeCount(session: Pick<JourneyCheckIn, "guests">): { complete: number; total: number } {
  return { complete: session.guests.filter((guest) => ["data_complete", "signed", "verified"].includes(guest.status)).length, total: session.guests.length };
}

function unknownStep(key: JourneyStepKey, label: string): JourneyStep {
  return { key, label, state: "pending", detail: "Recorrido del check-in en línea no disponible.", unknown: true };
}

function progressDetail(session: JourneyCheckIn): string {
  const signatures = signedCount(session);
  const complete = completeCount(session);
  const parts = [`viajeros completos ${complete.complete}/${complete.total}`];
  if (signatures.signers > 0) parts.push(`firmados ${signatures.signed}/${signatures.signers}`);
  if (session.etaDeclared) parts.push(`llegada prevista ${session.etaDeclared}`);
  return parts.join(" · ");
}

/**
 * Deriva el recorrido de la reserva, el folio, el huésped, el número de la
 * habitación asignada y el recorrido del API (sesión de check-in, avisos, llave,
 * peticiones, encuesta). `today` se inyecta en los tests.
 */
export function computeJourney(
  res: AdminReservation,
  folio: FolioBalance | null,
  guest: GuestProfile | null,
  assignedRoomNumber: string | null,
  journey: GuestJourneyView | null,
  today: string = todayISO()
): JourneyResult {
  const cancelled = res.status === "cancelled" || res.status === "no_show";
  const checkedIn = res.status === "checked_in" || res.status === "checked_out";
  const checkedOut = res.status === "checked_out";
  const session = journey?.checkIn ?? null;
  const steps: JourneyStep[] = [];

  steps.push({
    key: "booked",
    label: "Reserva confirmada",
    state: cancelled ? "skipped" : res.status === "draft" ? "pending" : "done",
    detail: res.status === "draft" ? "La reserva sigue en borrador." : `${channelLabel(res.channel)} · ${dateRange(res.arrivalDate, res.departureDate)}`
  });

  // Invitación al check-in en línea: sesión + última invitación / recordatorio enviados.
  if (cancelled) {
    steps.push({ key: "invitation", label: "Invitación al check-in en línea", state: "skipped", detail: "Reserva cancelada." });
  } else if (!journey) {
    steps.push(unknownStep("invitation", "Invitación al check-in en línea"));
  } else if (!session) {
    steps.push({
      key: "invitation",
      label: "Invitación al check-in en línea",
      state: checkedIn ? "skipped" : "pending",
      detail: checkedIn ? "Sin invitación: el check-in se gestionó en recepción." : "Todavía sin invitar al check-in en línea."
    });
  } else {
    const invitation = lastNotification(journey, "checkin_invitation");
    const reminder = lastNotification(journey, "checkin_reminder");
    const reminderNote = reminder ? ` · recordatorio: ${describeNotification(reminder)}` : "";
    if (invitation) {
      steps.push({
        key: "invitation",
        label: "Invitación al check-in en línea",
        state: invitation.status === "failed" ? "blocked" : "done",
        detail: `Invitación: ${describeNotification(invitation)} a ${invitation.recipient}${reminderNote}.`
      });
    } else {
      steps.push({
        key: "invitation",
        label: "Invitación al check-in en línea",
        state: "done",
        detail: `Sesión abierta por ${journeyChannel(session.channel)}${session.invitedAt ? ` el ${dateTime(session.invitedAt, { style: "dayMonth" })}` : ""} sin aviso registrado${reminderNote}.`
      });
    }
  }

  // Pre-check-in del huésped: estado de la sesión y progreso de los viajeros.
  if (cancelled) {
    steps.push({ key: "precheckin", label: "Pre-check-in del huésped", state: "skipped", detail: "Reserva cancelada." });
  } else if (!journey) {
    steps.push(unknownStep("precheckin", "Pre-check-in del huésped"));
  } else if (!session) {
    steps.push({
      key: "precheckin",
      label: "Pre-check-in del huésped",
      state: checkedIn ? "skipped" : "pending",
      detail: checkedIn ? "Sin pre-check-in en línea." : "Pendiente de la invitación."
    });
  } else {
    const label = SESSION_STATUS_LABEL[session.status] ?? session.status;
    const progress = progressDetail(session);
    let state: StepState;
    let detail: string;
    switch (session.status) {
      case "invited":
        state = "active";
        detail = `Invitado, sin empezar · ${progress}.`;
        break;
      case "in_progress":
        state = "active";
        detail = `En curso · ${progress}.`;
        break;
      case "ready_for_arrival":
      case "arrived":
      case "checked_in":
        state = "done";
        detail = `${label}${session.completedAt ? ` el ${dateTime(session.completedAt, { style: "dayMonth" })}` : ""} · ${progress}.`;
        break;
      case "handed_off":
        state = "blocked";
        detail = `Derivado a recepción${session.handoffReason ? `: ${session.handoffReason}` : session.handoffKind ? ` (${session.handoffKind})` : ""} · ${progress}.`;
        break;
      case "expired":
        state = "blocked";
        detail = `Enlace caducado: reenviar la invitación · ${progress}.`;
        break;
      default:
        state = "skipped";
        detail = `${label}.`;
    }
    steps.push({ key: "precheckin", label: "Pre-check-in del huésped", state, detail, badge: state === "active" ? label : undefined });
  }

  // Identidad: documento en el perfil o capturado en el pre-check-in (últimos 3 caracteres).
  const primaryTraveller = session?.guests.find((g) => g.isPrimary) ?? null;
  const hasDoc = Boolean(guest?.documentNumber);
  const capturedDoc = Boolean(primaryTraveller?.documentNumberLast3);
  const verified = Boolean(primaryTraveller?.identityVerifiedAt);
  steps.push({
    key: "identity",
    label: "Identidad y parte de viajeros (SES)",
    state: cancelled ? "skipped" : hasDoc || capturedDoc ? "done" : checkedIn ? "blocked" : "pending",
    detail: hasDoc
      ? `Documento registrado${guest?.documentType ? ` (${guest.documentType})` : ""}${verified ? " · identidad verificada" : ""}.`
      : capturedDoc
        ? `Documento capturado en el pre-check-in (…${primaryTraveller!.documentNumberLast3})${verified ? " · identidad verificada" : " · pendiente de cotejo"}.`
        : "Sin documento de identidad: es obligatorio para el parte de viajeros."
  });

  let payState: StepState;
  let payDetail: string;
  if (!folio) {
    payState = "pending";
    payDetail = "Folio todavía no cargado.";
  } else {
    const bal = folio.balanceDue;
    const cur = folio.folio.currency;
    if (folio.chargesTotal > 0 && bal <= 0.005) {
      payState = "done";
      payDetail = `Saldo liquidado (${money(folio.paymentsTotal, cur)}).`;
    } else if (folio.paymentsTotal > 0) {
      payState = checkedOut && bal > 0.005 ? "blocked" : "active";
      payDetail = `Pago parcial · saldo ${money(bal, cur)}.`;
    } else {
      payState = checkedOut ? "blocked" : "pending";
      payDetail = `Sin pagos · saldo ${money(bal, cur)}.`;
    }
  }
  if (session?.paymentStatus === "at_reception") payDetail = `${payDetail} Se cobra en recepción (sin pasarela).`;
  else if (session?.paymentStatus === "link_sent") payDetail = `${payDetail} Enlace de pago enviado.`;
  else if (session?.paymentStatus === "failed") payDetail = `${payDetail} El pago del portal falló.`;
  steps.push({ key: "payment", label: "Pago", state: cancelled ? "skipped" : payState, detail: payDetail });

  const assigned = Boolean(res.assignedRoomId);
  steps.push({
    key: "room",
    label: "Habitación asignada",
    state: cancelled ? "skipped" : assigned ? "done" : checkedIn ? "blocked" : "pending",
    // The reservation only carries the room id: paint the number, never the id (qa#9).
    detail: assigned ? (assignedRoomNumber ? `Habitación ${assignedRoomNumber}.` : "Habitación asignada.") : "Todavía sin habitación asignada."
  });

  const arrivalPast = res.arrivalDate < today;
  const checkInWhen = session?.checkedInAt ? ` el ${dateTime(session.checkedInAt, { style: "dayMonth" })}` : "";
  const checkInHow = session?.channel === "kiosk" ? " · check-in autónomo en kiosco" : session?.kioskDeviceId ? " · en kiosco" : "";
  steps.push({
    key: "checkin",
    label: "Check-in",
    state: cancelled ? "skipped" : checkedIn ? "done" : arrivalPast && res.status === "confirmed" ? "blocked" : "pending",
    detail: checkedIn ? `Huésped registrado${checkInWhen}${checkInHow}.` : arrivalPast ? "La fecha de llegada ya pasó sin check-in." : `Prevista el ${date(res.arrivalDate, "medium")}.`
  });

  // Llave móvil (GuestPortalAction mobile_key activa).
  if (cancelled) {
    steps.push({ key: "key", label: "Llave", state: "skipped", detail: "Reserva cancelada." });
  } else if (!journey) {
    steps.push(unknownStep("key", "Llave"));
  } else if (journey.key) {
    const until = journey.key.validUntil ? ` · válida hasta el ${date(journey.key.validUntil, "medium")}` : "";
    steps.push({
      key: "key",
      label: "Llave",
      state: "done",
      detail: `Llave móvil ${journey.key.serial}${until}${journey.key.signedByApple ? "" : " · QR de demo (sin certificado de Apple)"}.`
    });
  } else {
    steps.push({
      key: "key",
      label: "Llave",
      state: checkedOut ? "skipped" : "pending",
      detail: checkedOut ? "Estancia terminada sin llave móvil." : checkedIn ? "Sin llave móvil: entregar la tarjeta en recepción." : "Se emite en el check-in."
    });
  }

  // Bienvenida (welcome:<reservationId>:<canal>).
  if (cancelled) {
    steps.push({ key: "welcome", label: "Bienvenida", state: "skipped", detail: "Reserva cancelada." });
  } else if (!journey) {
    steps.push(unknownStep("welcome", "Bienvenida"));
  } else {
    const welcome = lastNotification(journey, "welcome");
    if (welcome) {
      steps.push({
        key: "welcome",
        label: "Bienvenida",
        state: welcome.status === "failed" ? "blocked" : "done",
        detail: `Mensaje de bienvenida: ${describeNotification(welcome)} a ${welcome.recipient}.`
      });
    } else {
      steps.push({
        key: "welcome",
        label: "Bienvenida",
        state: checkedOut ? "skipped" : "pending",
        detail: checkedOut ? "Estancia terminada sin mensaje de bienvenida." : checkedIn ? "Sin mensaje de bienvenida registrado." : "Se envía tras el check-in."
      });
    }
  }

  steps.push({
    key: "stay",
    label: "Estancia",
    state: cancelled ? "skipped" : res.status === "checked_in" ? "active" : checkedOut ? "done" : "pending",
    detail: res.status === "checked_in" ? "El huésped está en casa." : checkedOut ? "Estancia completada." : "No ha empezado."
  });

  // Peticiones (ServiceRequest de la reserva): abiertas → en curso; todas atendidas → hecho; ninguna → «Ninguna» (no cuenta).
  if (cancelled) {
    steps.push({ key: "requests", label: "Peticiones del huésped", state: "skipped", detail: "Reserva cancelada." });
  } else if (!journey) {
    steps.push(unknownStep("requests", "Peticiones del huésped"));
  } else {
    const open = journey.requests.filter((item) => OPEN_REQUEST_STATUSES.includes(item.status)).length;
    const total = journey.requests.length;
    if (total === 0) {
      steps.push({ key: "requests", label: "Peticiones del huésped", state: "skipped", detail: "Sin peticiones desde el portal.", badge: "Ninguna" });
    } else if (open > 0) {
      steps.push({ key: "requests", label: "Peticiones del huésped", state: "active", detail: `${open} de ${total} sin atender.`, badge: open === 1 ? "1 abierta" : `${open} abiertas` });
    } else {
      steps.push({ key: "requests", label: "Peticiones del huésped", state: "done", detail: `${total} ${total === 1 ? "petición atendida" : "peticiones atendidas"}.` });
    }
  }

  steps.push({
    key: "checkout",
    label: "Check-out y factura",
    state: cancelled ? "skipped" : checkedOut ? "done" : "pending",
    detail: checkedOut ? "Salida hecha." : `Prevista el ${date(res.departureDate, "medium")}.`
  });

  // Encuesta post-estancia (invitación post_stay_survey + SurveyResponse).
  if (cancelled) {
    steps.push({ key: "survey", label: "Encuesta post-estancia", state: "skipped", detail: "Reserva cancelada." });
  } else if (!journey) {
    steps.push(unknownStep("survey", "Encuesta post-estancia"));
  } else if (journey.survey.answeredAt) {
    const score = journey.survey.score;
    steps.push({
      key: "survey",
      label: "Encuesta post-estancia",
      state: "done",
      detail: `Respondida el ${dateTime(journey.survey.answeredAt, { style: "dayMonth" })}${score === null ? "" : ` · puntuación ${score}/10`}.`,
      badge: score === null ? undefined : `${score}/10`
    });
  } else if (journey.survey.invitedAt) {
    const invitation = lastNotification(journey, "post_stay_survey");
    steps.push({
      key: "survey",
      label: "Encuesta post-estancia",
      state: "active",
      detail: `Enviada${invitation ? ` (${describeNotification(invitation)})` : ` el ${dateTime(journey.survey.invitedAt, { style: "dayMonth" })}`} · sin respuesta.`,
      badge: "Enviada"
    });
  } else {
    steps.push({
      key: "survey",
      label: "Encuesta post-estancia",
      state: "pending",
      detail: checkedOut ? "Pendiente de envío (automático tras la salida si la política lo activa, o ahora mismo)." : "Se envía tras la salida."
    });
  }

  const total = steps.filter((s) => s.state !== "skipped").length;
  const done = steps.filter((s) => s.state === "done").length;
  const next = steps.find((s) => s.state === "blocked" && !s.unknown) ?? steps.find((s) => s.state === "pending" && !s.unknown && !NOT_NEXT.includes(s.key));
  return { steps, done, total, next, cancelled };
}

/** Lightweight stage from the reservation alone (for the list, no extra fetch); the badge reads the common status dictionary (UX-1 · U2, D5). */
export function listStage(res: AdminReservation): { done: number; total: number; status: StatusEntry } {
  const status = reservationStatus(res.status);
  if (res.status === "cancelled" || res.status === "no_show") return { done: 0, total: 4, status };
  const flags = [res.status !== "draft", Boolean(res.assignedRoomId), res.status === "checked_in" || res.status === "checked_out", res.status === "checked_out"];
  return { done: flags.filter(Boolean).length, total: 4, status };
}

export type InvitationAction = "invite" | "resend" | null;

/**
 * Acción de invitación disponible: «invite» sin sesión (reserva viva y sin
 * check-in), «resend» con sesión abierta (invited · in_progress · expired ·
 * ready_for_arrival); null si la reserva está cancelada, alojada o el recorrido
 * no se pudo leer.
 */
export function invitationAction(res: Pick<AdminReservation, "status">, journey: GuestJourneyView | null): InvitationAction {
  if (!journey) return null;
  if (["cancelled", "no_show", "checked_in", "checked_out"].includes(res.status)) return null;
  const session = journey.checkIn;
  if (!session) return "invite";
  return ["invited", "in_progress", "expired", "ready_for_arrival"].includes(session.status) ? "resend" : null;
}

/** Canal del reenvío: el de la sesión si es un canal de mensajería; si no, correo. */
export function invitationChannel(journey: GuestJourneyView | null): "email" | "whatsapp" | "sms" {
  const channel = journey?.checkIn?.channel;
  return channel === "whatsapp" || channel === "sms" ? channel : "email";
}

/** «Enviar encuesta ahora» solo con la reserva checked_out y sin respuesta registrada. */
export function surveyActionAvailable(res: Pick<AdminReservation, "status">, journey: GuestJourneyView | null): boolean {
  return Boolean(journey) && res.status === "checked_out" && !journey!.survey.answeredAt;
}

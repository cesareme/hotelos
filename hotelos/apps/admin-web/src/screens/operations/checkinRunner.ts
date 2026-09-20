// Runner del check-in rápido (Tanda UX-1 · lote U6 · docs/design/UX-RECEPCION-FEEL.md
// §5.2 (1)-(2), §5.3 «runner compartido», §6.1 «Check-in / check-out»).
//
// Extraído de QuickCheckInDrawer (antes :425-500) para que lo compartan el
// cajón de check-in, el WalkInDrawer y la ficha (U7). Módulo sin React ni red
// propia: recibe las funciones de acceso al API por inyección (`deps`) y lo
// ejecuta `node --test` con un `request` simulado (__tests__/checkin-runner.test.mts).
//
// Pasos, en este orden y con progreso por paso («Cobro ✓ · Check-in ✓ · SES …»):
//   1. assign   POST /reservations/:id/assign-room   solo si la habitación cambia
//   2. payment  POST /folios/:id/payments            solo con cobro; un fallo ABORTA
//               (el check-in NO se hace; misma clave de idempotencia al reintentar)
//   3. checkin  POST /reservations/:id/check-in      con `overrideReason` si la
//               habitación no está limpia (F18: el API no exige limpieza,
//               pms.service.ts «la limpieza es de pisos y NO se fuerza a clean»;
//               el motivo queda auditado en `checkInWindow.overrideReason`)
//   4. partes   GET partes + PATCH identidad verificada (best-effort: un 403 no
//               bloquea; el check-in ya está hecho)
//   5. ses      POST /properties/:id/ses/submissions leído con honestidad
//               (`SesQueueOutcome`): nunca «enviado» en falso
// La reserva devuelta por POST check-in (server.ts: `{ ...reservation,
// guestRegister, folio }`) es la fuente de la reconciliación de la fila de Mi
// día: estado `checked_in` y `assignedRoomId` sin volver a pedir el dashboard.
//
// Tanda CHK · lote W4-A (docs/design/CHECKIN-AUTOMATIZADO-IA.md §7.2, §8): con
// `deps.completeCheckIn` definido, el paso 3 llama a POST
// /reservations/:id/check-in/complete (cuerpo `{ roomId, overrideReason?,
// allowEarlyCheckIn? }`, sin `signatureObjectKey`: la firma real ya vive en
// `signatures` y el API la exige) y el resultado (`completion`: habitación,
// llave, SES y avisos) sustituye al paso 5 — el API ya encoló el parte, así que
// `queueSes` no se llama y `ses` se lee de `completion.ses`. Un 409
// ROOM_NOT_READY aborta con el mensaje del API y `CheckinRunError.code` /
// `.details` (etaReady) para que el cajón ofrezca «Buscar alternativa». Sin
// `completeCheckIn` el runner sigue igual (check-in clásico con
// DEFAULT_SIGNATURE_KEY, marcado @deprecated).

import { money } from "../../lib/format";
import type { RequestOptions } from "../../services/api-client";
import type { CompleteCheckInBody, CompleteCheckInResult } from "../../services/checkinApi";
import type { SesQueueOutcome } from "../../services/complianceApi";
import type { GuestRegisterRecord } from "../../services/guestRegisterApi";
import { assertCheckinPaymentCaptured, buildCheckinPaymentBody, resolveQuickCheckinAttempt, type QuickCheckinPaymentAttempt, type QuickCheckinPaymentBody } from "./quickCheckinPayment";

export type CheckinStepId = "precheck" | "assign" | "payment" | "checkin" | "partes" | "ses";

export const CHECKIN_STEPS: readonly CheckinStepId[] = ["precheck", "assign", "payment", "checkin", "partes", "ses"];

export type CheckinStepState = "pending" | "running" | "done" | "skipped" | "failed";

export type CheckinProgress = Readonly<Record<CheckinStepId, CheckinStepState>>;

/** Etiquetas cortas del progreso del cajón («Cobro ✓ · Check-in ✓ · SES …»). */
export const CHECKIN_STEP_LABELS: Readonly<Record<CheckinStepId, string>> = Object.freeze({
  precheck: "Comprobación",
  assign: "Habitación",
  payment: "Cobro",
  checkin: "Check-in",
  partes: "Partes",
  ses: "SES"
});

const STEP_MARK: Readonly<Record<CheckinStepState, string>> = Object.freeze({ pending: "—", running: "…", done: "✓", failed: "✗", skipped: "" });

/**
 * Progreso inicial: los pasos que no aplican quedan `skipped` y no se pintan.
 * `willPrecheck` (corrector REV3-03): comprobación previa del check-in completo
 * antes de asignar o cobrar (solo con `deps.completeCheckIn` + `deps.precheckCheckIn`).
 */
export function initialCheckinProgress(input: { willAssign: boolean; willPay: boolean; willPrecheck?: boolean }): CheckinProgress {
  return {
    precheck: input.willPrecheck ? "pending" : "skipped",
    assign: input.willAssign ? "pending" : "skipped",
    payment: input.willPay ? "pending" : "skipped",
    checkin: "pending",
    partes: "pending",
    ses: "pending"
  };
}

/**
 * Sufijo del error del paso check-in cuando el cobro YA se registró (corrector
 * REV3-03): el operador ve el importe cobrado y que reintentar no lo repite
 * (misma clave de idempotencia, `previousAttempt`).
 */
export function paymentAlreadyTakenSuffix(payment: CheckinPaymentInput | null, currency: string, attempt: QuickCheckinPaymentAttempt | null, progress: CheckinProgress): string {
  if (!payment || progress.payment !== "done") return "";
  // La moneda es la del folio (money() cae a DEFAULT_CURRENCY si llega vacía).
  const amount = currency ? money(payment.amount, currency) : money(payment.amount);
  return ` El cobro de ${amount} ya está registrado en el folio${attempt ? ` (clave ${attempt.clientRequestId})` : ""}: al reintentar el check-in no se vuelve a cobrar.`;
}

/** «Cobro ✓ · Check-in ✓ · SES …» (los pasos omitidos no aparecen). */
export function progressLabel(progress: CheckinProgress): string {
  return CHECKIN_STEPS.filter((step) => progress[step] !== "skipped")
    .map((step) => `${CHECKIN_STEP_LABELS[step]} ${STEP_MARK[progress[step]]}`)
    .join(" · ");
}

export type CheckinBody = { roomId: string; signatureObjectKey: string; overrideReason?: string };

/**
 * @deprecated Sello del check-in clásico (POST /reservations/:id/check-in sin
 * firma real). Con `deps.completeCheckIn` (Tanda CHK) el runner NO lo envía:
 * la firma vive en `signatures` y POST …/check-in/complete la exige. Se
 * conserva exportado para el camino clásico y su test histórico.
 */
export const DEFAULT_SIGNATURE_KEY = "sig_drawer_checkin";

/**
 * Cuerpo de POST /reservations/:id/check-in/complete (CompleteCheckInSchema):
 * `overrideReason` solo con ≥ 3 caracteres y `allowEarlyCheckIn` solo junto a
 * un motivo (el esquema lo exige). Nunca lleva `signatureObjectKey`.
 */
export function buildCompleteCheckInBody(input: { roomId: string; overrideReason?: string | null; allowEarlyCheckIn?: boolean }): CompleteCheckInBody {
  const reason = typeof input.overrideReason === "string" ? input.overrideReason.trim() : "";
  const body: CompleteCheckInBody = { roomId: input.roomId };
  if (reason.length >= 3) {
    body.overrideReason = reason;
    if (input.allowEarlyCheckIn) body.allowEarlyCheckIn = true;
  }
  return body;
}

/** Cuerpo de POST /reservations/:id/check-in; `overrideReason` solo si hay motivo (mín. 3 caracteres, CheckInSchema). */
export function buildCheckinBody(input: { roomId: string; overrideReason?: string | null; signatureObjectKey?: string }): CheckinBody {
  const reason = typeof input.overrideReason === "string" ? input.overrideReason.trim() : "";
  const body: CheckinBody = { roomId: input.roomId, signatureObjectKey: input.signatureObjectKey ?? DEFAULT_SIGNATURE_KEY };
  if (reason.length >= 3) body.overrideReason = reason;
  return body;
}

/** Motivo del override tal y como se audita (F18): con la habitación y el texto del recepcionista. */
export function overrideReasonFor(reason: string, roomNumber?: string | null): string {
  const text = reason.trim();
  return roomNumber ? `Check-in con la ${roomNumber} sin limpiar: ${text}` : `Check-in con la habitación sin limpiar: ${text}`;
}

/** El motivo del override es válido cuando lo acepta el API (≥ 3 caracteres útiles). */
export function isOverrideReasonValid(reason: string | null | undefined): boolean {
  return typeof reason === "string" && reason.trim().length >= 3;
}

export type CheckinPaymentInput = { folioId: string; amount: number; method: string };

export type CheckinRunnerInput = {
  reservationId: string;
  propertyId: string;
  /** Habitación ya asignada (si coincide con `roomId` no se reasigna). */
  assignedRoomId?: string | null;
  roomId: string;
  currency: string;
  /** null = sin cobro. */
  payment: CheckinPaymentInput | null;
  overrideReason?: string | null;
  /** Solo con `deps.completeCheckIn`: fuera de la ventana ±1 día el API exige `allowEarlyCheckIn` + motivo (pms.reservation.modify). */
  allowEarlyCheckIn?: boolean;
  verifyIdentity?: boolean;
  /** Camino clásico únicamente; con `deps.completeCheckIn` no se envía ninguna clave de firma. */
  signatureObjectKey?: string;
};

export type CheckedInReservation = { id: string; status: string; assignedRoomId?: string | null } & Record<string, unknown>;

export type CheckinRunnerDeps = {
  /** `apiRequest` (o un doble en los tests). */
  request: <T>(path: string, options?: RequestOptions) => Promise<T>;
  /** `postFolioPayment`: el runner comprueba `kind: "payment"` y `status: "captured"`. */
  postPayment: (folioId: string, body: QuickCheckinPaymentBody) => Promise<{ kind: string; status?: string }>;
  /** Partes de viajeros de la reserva (GET); un fallo devuelve `[]` y se anota. */
  listPartes: () => Promise<GuestRegisterRecord[]>;
  /** PATCH …/mark-identity-verified de un parte. */
  markIdentity: (parteId: string) => Promise<unknown>;
  /** POST SES ya leído con honestidad (`sesQueueOutcomeFromResponse` / `…FromError`). No se llama con `completeCheckIn`. */
  queueSes: (propertyId: string, reservationId: string) => Promise<SesQueueOutcome>;
  /**
   * Tanda CHK: POST /reservations/:id/check-in/complete. Definido → el paso 3
   * lo usa en vez de POST …/check-in (sin `signatureObjectKey`) y el paso 5 lee
   * el SES de su resultado. Indefinido → check-in clásico.
   */
  completeCheckIn?: (reservationId: string, body: CompleteCheckInBody) => Promise<CompleteCheckInResult>;
  /**
   * Corrector REV3-03: POST /reservations/:id/check-in/complete con `dryRun: true`
   * ANTES de asignar y de cobrar: las precondiciones del check-in completo
   * (sesión, ventana, identidad, firmas) fallan sin dejar un cargo capturado ni
   * una habitación asignada. Solo se usa junto a `completeCheckIn`.
   */
  precheckCheckIn?: (reservationId: string, body: CompleteCheckInBody) => Promise<unknown>;
  newClientRequestId: () => string;
  /** Intento de cobro anterior (misma clave de idempotencia si el cobro no cambió). */
  previousAttempt?: QuickCheckinPaymentAttempt | null;
  /** `true` si el error es un 403 (sin permiso guest_register.edit). */
  isForbidden?: (error: unknown) => boolean;
  onProgress?: (progress: CheckinProgress) => void;
};

export type CheckinRunnerResult = {
  /** Reserva devuelta por POST check-in (estado `checked_in` + habitación): reconcilia la fila sin recargar. */
  reservation: CheckedInReservation | null;
  ses: SesQueueOutcome;
  partes: GuestRegisterRecord[];
  partesError: string | null;
  identityNote: string | null;
  paymentAttempt: QuickCheckinPaymentAttempt | null;
  progress: CheckinProgress;
  /** Resultado de POST …/check-in/complete (habitación, llave, SES, avisos); null en el camino clásico. */
  completion: CompleteCheckInResult | null;
};

/** Fallo en un paso anterior al check-in (o en el propio check-in): el check-in NO se ha hecho. */
export class CheckinRunError extends Error {
  readonly step: CheckinStepId;
  readonly paymentAttempt: QuickCheckinPaymentAttempt | null;
  readonly progress: CheckinProgress;
  readonly cause?: unknown;
  /** `details.code` del ApiError (ROOM_NOT_READY, GUEST_REGISTER_INCOMPLETE, IDENTITY_NOT_VERIFIED…) o null. */
  readonly code: string | null;
  /** `details` del ApiError tal cual (p. ej. { etaReady, roomNumber } de ROOM_NOT_READY). */
  readonly details: unknown;

  constructor(step: CheckinStepId, message: string, extra: { paymentAttempt: QuickCheckinPaymentAttempt | null; progress: CheckinProgress; cause?: unknown }) {
    super(message);
    this.name = "CheckinRunError";
    this.step = step;
    this.paymentAttempt = extra.paymentAttempt;
    this.progress = extra.progress;
    this.cause = extra.cause;
    const details = (extra.cause as ApiErrorLike | null | undefined)?.details ?? null;
    this.details = details;
    this.code = typeof details?.code === "string" ? details.code : null;
  }
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

type ApiErrorLike = { message?: string; details?: { code?: string; arrivalDate?: string; businessDate?: string } | null };

/**
 * Mensaje de mostrador del paso de check-in (corrector L-08): el 409
 * CHECK_IN_DATE_OUT_OF_RANGE del API habla de `allowEarlyCheckIn` y permisos;
 * al operador se le dice la fecha y qué hacer. El resto llega tal cual.
 */
export function checkinStepMessage(error: unknown, fallback: string): string {
  const details = (error as ApiErrorLike | null)?.details;
  if (details && details.code === "CHECK_IN_DATE_OUT_OF_RANGE") {
    const arrival = details.arrivalDate ? ` el ${details.arrivalDate}` : "";
    return `La reserva llega${arrival}: el check-in solo se admite con un día de margen. Si el huésped ya está aquí, adelanta la llegada desde la ficha.`;
  }
  return messageOf(error, fallback);
}

export const PAYMENT_ABORT_SUFFIX = "El check-in NO se ha realizado. Reintenta o selecciona «Sin cobro».";

/**
 * SES de POST …/check-in/complete leído con la misma honestidad que el paso 5
 * clásico: `queued` solo si todos los partes tienen envío; `partial` con los
 * partes sin encolar y su código; sin partes → `no_records`; ninguno encolado →
 * `error` con los avisos del API.
 */
export function sesOutcomeFromCompletion(ses: CompleteCheckInResult["ses"]): SesQueueOutcome {
  const queued = ses.submissions.filter((item) => item.submissionId).length;
  const failed = ses.submissions.filter((item) => !item.submissionId).map((item) => ({ guestRegisterRecordId: item.guestRegisterRecordId, code: item.code, message: ses.warnings.find((line) => line.startsWith(`parte ${item.guestRegisterRecordId}:`)) ?? null }));
  if (ses.status === "queued" && ses.submissions.length > 0) return { kind: "queued", queued };
  if (ses.submissions.length === 0) return { kind: "no_records" };
  if (queued > 0) return { kind: "partial", queued, failed, missing: [] };
  return { kind: "error", message: ses.warnings.join(" · ") || "Parte SES no encolado.", code: failed.find((item) => item.code)?.code ?? null, failed };
}

export async function runCheckin(input: CheckinRunnerInput, deps: CheckinRunnerDeps): Promise<CheckinRunnerResult> {
  const willAssign = input.roomId !== (input.assignedRoomId ?? null);
  const willPay = input.payment !== null;
  // La comprobación previa solo tiene sentido si después hay algo irreversible antes del check-in (asignar o cobrar).
  const willPrecheck = Boolean(deps.completeCheckIn && deps.precheckCheckIn && (willAssign || willPay));
  let progress: CheckinProgress = initialCheckinProgress({ willAssign, willPay, willPrecheck });
  let paymentAttempt: QuickCheckinPaymentAttempt | null = deps.previousAttempt ?? null;
  const set = (step: CheckinStepId, state: CheckinStepState) => {
    progress = { ...progress, [step]: state };
    deps.onProgress?.(progress);
  };
  deps.onProgress?.(progress);

  // 0 · Comprobación previa del check-in completo (corrector REV3-03): sin cobrar ni asignar.
  if (willPrecheck) {
    set("precheck", "running");
    try {
      await deps.precheckCheckIn!(input.reservationId, buildCompleteCheckInBody({ roomId: input.roomId, overrideReason: input.overrideReason, allowEarlyCheckIn: input.allowEarlyCheckIn }));
      set("precheck", "done");
    } catch (error) {
      set("precheck", "failed");
      throw new CheckinRunError("precheck", checkinStepMessage(error, "El check-in completo no puede hacerse todavía."), { paymentAttempt, progress, cause: error });
    }
  }

  // 1 · Habitación (solo si cambia).
  if (willAssign) {
    set("assign", "running");
    try {
      await deps.request(`/reservations/${encodeURIComponent(input.reservationId)}/assign-room`, { method: "POST", body: { roomId: input.roomId } });
      set("assign", "done");
    } catch (error) {
      set("assign", "failed");
      throw new CheckinRunError("assign", messageOf(error, "No se pudo asignar la habitación."), { paymentAttempt, progress, cause: error });
    }
  }

  // 2 · Cobro (saldo o depósito). Un fallo aborta: el check-in NO se hace.
  if (input.payment) {
    set("payment", "running");
    try {
      const attempt = resolveQuickCheckinAttempt(
        paymentAttempt,
        { folioId: input.payment.folioId, amount: input.payment.amount, currency: input.currency, method: input.payment.method },
        deps.newClientRequestId
      );
      paymentAttempt = attempt;
      const result = await deps.postPayment(
        input.payment.folioId,
        buildCheckinPaymentBody({ amount: input.payment.amount, currency: input.currency, method: input.payment.method, clientRequestId: attempt.clientRequestId })
      );
      assertCheckinPaymentCaptured(result);
      set("payment", "done");
    } catch (error) {
      set("payment", "failed");
      throw new CheckinRunError("payment", `No se pudo registrar el cobro (${messageOf(error, "error")}). ${PAYMENT_ABORT_SUFFIX}`, { paymentAttempt, progress, cause: error });
    }
  }

  // 3 · Check-in: completo (Tanda CHK, sin clave de firma) o clásico.
  set("checkin", "running");
  let reservation: CheckedInReservation | null = null;
  let completion: CompleteCheckInResult | null = null;
  try {
    if (deps.completeCheckIn) {
      completion = await deps.completeCheckIn(input.reservationId, buildCompleteCheckInBody({ roomId: input.roomId, overrideReason: input.overrideReason, allowEarlyCheckIn: input.allowEarlyCheckIn }));
      reservation = { id: completion.reservationId, status: "checked_in", assignedRoomId: completion.room.id };
    } else {
      const response = await deps.request<CheckedInReservation | null>(`/reservations/${encodeURIComponent(input.reservationId)}/check-in`, {
        method: "POST",
        body: buildCheckinBody({ roomId: input.roomId, overrideReason: input.overrideReason, signatureObjectKey: input.signatureObjectKey })
      });
      reservation = response && typeof response === "object" && typeof response.id === "string" ? response : null;
    }
    set("checkin", "done");
  } catch (error) {
    set("checkin", "failed");
    // Corrector REV3-03: si el cobro ya se registró, el mensaje lo dice (importe y clave) y avisa de que no se repite.
    throw new CheckinRunError("checkin", `${checkinStepMessage(error, "Error ejecutando check-in")}${paymentAlreadyTakenSuffix(input.payment, input.currency, paymentAttempt, progress)}`, { paymentAttempt, progress, cause: error });
  }

  // 4 · Partes de viajeros (creados por la ruta de check-in) e identidad verificada; nunca bloquean.
  set("partes", "running");
  let partes: GuestRegisterRecord[] = [];
  let partesError: string | null = null;
  let identityNote: string | null = null;
  try {
    partes = await deps.listPartes();
  } catch (error) {
    partesError = messageOf(error, "No se pudieron cargar los partes de viajeros.");
  }
  if (input.verifyIdentity && partes.length > 0) {
    const results = await Promise.allSettled(partes.map((parte) => (parte.identityVerified ? Promise.resolve(parte) : deps.markIdentity(parte.id))));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) {
      const forbidden = failures.some((failure) => deps.isForbidden?.(failure.reason) === true);
      identityNote = forbidden
        ? "Sin permiso para marcar la identidad verificada (guest_register.edit): el check-in y el parte siguen adelante."
        : `No se pudo marcar la identidad verificada en ${failures.length === 1 ? "1 parte" : `${failures.length} partes`}; el check-in sigue adelante.`;
    }
    try {
      partes = await deps.listPartes();
    } catch (error) {
      partesError = messageOf(error, "No se pudieron cargar los partes de viajeros.");
    }
  }
  set("partes", partesError ? "failed" : "done");

  // 5 · Parte SES (leído con honestidad; el check-in ya está hecho). Con el
  // check-in completo el API ya lo encoló: se lee de su resultado, sin otra llamada.
  set("ses", "running");
  const ses = completion ? sesOutcomeFromCompletion(completion.ses) : await deps.queueSes(input.propertyId, input.reservationId);
  set("ses", ses.kind === "queued" ? "done" : "failed");

  return { reservation, ses, partes, partesError, identityNote, paymentAttempt, progress, completion };
}

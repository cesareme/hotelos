// PMS commerce client (reservations, folios, invoices, reports).
//
// SECURITY (auditoría 2026-07): este módulo usaba `fetch` crudo SIN cabecera
// Authorization. Bajo el gate de auth de producción (sin HOTELOS_ALLOW_DEMO_AUTH)
// todas sus llamadas devolvían 401 — crear reserva, check-in/out, cancelar…— y,
// con el gate abierto, se ejecutaban como el super-usuario demo (traza de
// auditoría corrupta). Ahora TODO pasa por `apiRequest` (JWT + manejo de 401 +
// extracción de mensaje de error). No añadir `fetch` crudo aquí.
import type { InvoiceCancellationPayments, InvoiceEmailResponse, InvoiceSnapshotV1, PaymentIntentWire, PaymentLinkResponse, PaymentMethodCode, PspStatusWire, RefundResponse } from "@hotelos/shared";
import { apiRequest, apiRequestBlob, ApiError } from "./api-client";
import { downloadFilename, type FolioPaymentResult } from "./finance-contracts";

/** Legacy wire values of a payment method the API still normalises (LEGACY_PAYMENT_METHOD_ALIASES). */
export type LegacyPaymentMethodAlias = "card" | "ota_virtual_card" | "transfer" | "link" | "online";
export type { FolioPaymentResult, PaymentIntentWire, PaymentLinkResponse, PspStatusWire, RefundResponse };

// --- Cursor pagination contract (Tanda 2 · REC-05 / QC-04) ------------------
// Mirrors apps/api/src/lib/pagination.ts. List endpoints keep answering a bare
// array by default; sending `envelope=1` (or a cursor) switches the body to
// `{ items, nextCursor, total }`. The helpers below therefore keep two call
// shapes: legacy `fetchX(propertyId)` → array (still used by screens outside
// this refactor) and `fetchX(propertyId, query)` → Page (always enveloped).
export type Page<T> = {
  items: T[];
  nextCursor: string | null;
  total: number;
};

export type PageQuery = {
  /** Server clamps to its own max (500 for reservations). */
  limit?: number;
  /** Opaque cursor returned as `nextCursor`; malformed → 400 from the API. */
  cursor?: string;
  /** Forced to true whenever a query object is passed. */
  envelope?: boolean;
};

/** Serialize a list query for apiRequest: arrays → csv, booleans → "1", blanks dropped. */
function toListQuery(query: Record<string, unknown>): Record<string, string | number | undefined> {
  const out: Record<string, string | number | undefined> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      out[key] = value.join(",");
    } else if (typeof value === "boolean") {
      out[key] = value ? "1" : undefined;
    } else if (typeof value === "number" || typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

export type ReservationListQuery = PageQuery & {
  /** ReservationStatus values (csv or array). Unknown values → 400. */
  status?: string | string[];
  /** Stay overlap window: arrivalDate < to && departureDate > from (YYYY-MM-DD). */
  from?: string;
  to?: string;
  /** Arrival window (inclusive, YYYY-MM-DD). */
  arrivalFrom?: string;
  arrivalTo?: string;
  /** Free text over code, bookerName and primary guest name. */
  q?: string;
  /** Server default is arrival_desc (most recent arrivals first). */
  sort?: "arrival_desc" | "arrival_asc";
};

/** Operational tabs shared by the reservations list / workspace screens. */
export type ReservationOperationalTab =
  | "all"
  | "today_arrivals"
  | "in_house"
  | "today_departures"
  | "future"
  | "cancelled";

/** Local calendar date as YYYY-MM-DD (front-desk "today"). */
export function todayIsoLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Shift a YYYY-MM-DD date by `days` without timezone drift. */
export function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Server-side filter for an operational tab. Exact for every tab except
 * `today_departures`, which the API can only approximate with the overlap
 * window (arrival < today && departure >= today); refine those rows with
 * `matchesReservationTab` after loading.
 */
export function reservationTabQuery(tab: ReservationOperationalTab, today: string): ReservationListQuery {
  switch (tab) {
    case "today_arrivals":
      return { arrivalFrom: today, arrivalTo: today, status: ["confirmed", "checked_in"], sort: "arrival_asc" };
    case "in_house":
      return { status: ["checked_in"], sort: "arrival_desc" };
    case "today_departures":
      return { from: shiftIsoDate(today, -1), to: today, status: ["checked_in", "checked_out"], sort: "arrival_desc" };
    case "future":
      return { arrivalFrom: shiftIsoDate(today, 1), status: ["draft", "confirmed"], sort: "arrival_asc" };
    case "cancelled":
      return { status: ["cancelled", "no_show"], sort: "arrival_desc" };
    case "all":
    default:
      return { sort: "arrival_desc" };
  }
}

/** Client-side refinement of a loaded row against an operational tab. */
export function matchesReservationTab(reservation: AdminReservation, tab: ReservationOperationalTab, today: string): boolean {
  const closed = reservation.status === "cancelled" || reservation.status === "no_show";
  switch (tab) {
    case "today_arrivals":
      return reservation.arrivalDate === today && !closed;
    case "in_house":
      return reservation.status === "checked_in";
    case "today_departures":
      return reservation.departureDate === today && reservation.status !== "cancelled";
    case "future":
      return reservation.arrivalDate > today && !closed;
    case "cancelled":
      return closed;
    case "all":
    default:
      return true;
  }
}

/**
 * First reservation worth selecting by default in a workspace: today's arrival
 * (confirmed / checked-in) if there is one, otherwise the first row of the
 * server order (most recent arrival with the default `arrival_desc`).
 */
export function pickInitialReservation(items: AdminReservation[], today: string): AdminReservation | null {
  const arrivingToday = items.find(
    (r) => r.arrivalDate === today && (r.status === "confirmed" || r.status === "checked_in")
  );
  return arrivingToday ?? items[0] ?? null;
}

export type AdminReservation = {
  id: string;
  propertyId: string;
  code: string;
  channel: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
  infants?: number;
  childrenAges?: number[];
  roomsCount?: number;
  eta?: string;
  etd?: string;
  roomTypeId: string;
  assignedRoomId?: string;
  ratePlanId?: string;
  boardType?: string;
  marketSegment?: string;
  sourceCode?: string;
  purposeOfStay?: string;
  guaranteeType?: string;
  depositAmount?: number;
  cancellationPolicyCode?: string;
  billingInstruction?: string;
  companyName?: string;
  travelAgentName?: string;
  groupCode?: string;
  externalReference?: string;
  bookerName?: string;
  bookerEmail?: string;
  specialRequests?: string;
  notes?: string;
  totalAmount: number;
  currency: string;
  primaryGuestId?: string;
  /** Tanda L3 (lote A): origin of `totalAmount` (`price_source`; absent on legacy rows). */
  priceSource?: ReservationPriceSource | null;
  /** Tanda L3 (lote A): only on the creation response. */
  pricing?: ReservationPricing;
};

export type AdminRoomType = {
  id: string;
  propertyId: string;
  name: string;
  code: string;
  maxOccupancy: number;
  description?: string;
};

export type AvailabilityQuote = {
  roomTypeId: string;
  roomTypeName: string;
  availableRooms: number;
  currency: string;
  /** Stay total of ONE room of this type (multiply by the rooms booked). */
  totalAmount: number;
  cancellationPolicy: string;
  // Tanda L3 (lote A): where the quoted price comes from (pms.service
  // quoteAvailability REC-09). `fallback` = at least one night had no published
  // rate and was completed with `fallbackNightly` — a filler, NOT a tariff: the
  // screens must warn instead of presenting it as the published price.
  priceSource?: "rate_plan" | "fallback";
  nightsWithoutRate?: number;
  fallbackNightly?: number | null;
  // Corrector L3 (FUX-02): the quote is priced by the SAME canonical quoter
  // that fixes the reservation total on creation (plan → BAR → lowest
  // published). `quotedRatePlanId` is the plan that priced the stay;
  // `ratePlanSwitched` = a plan was requested and another one (BAR) priced it.
  quotedRatePlanId?: string | null;
  ratePlanSwitched?: boolean;
};

/** Tanda L3 (lote A): origin of `Reservation.totalAmount` as persisted by the API (`price_source`). */
export type ReservationPriceSource = "manual" | "rate_plan" | "partial" | "none" | "file" | "quoted";

/**
 * Tanda L3 (lote A): pricing block of `POST /properties/:id/reservations`.
 * `source` is the persisted price origin; `nightsWithoutRate` > 0 means the
 * grid did not price every night (total left at 0 with `none` / `partial`);
 * `ratePlanId` is the plan that actually priced the first night (it differs
 * from the requested plan when that plan publishes nothing and BAR priced it).
 */
export type ReservationPricing = {
  source: ReservationPriceSource;
  nights: number;
  nightsWithoutRate: number;
  ratePlanId: string | null;
  warning: string | null;
};

/**
 * Payment row of a folio balance (Finanzas · Tanda 6, folio.service
 * FolioPaymentRecord): `kind: "refund"` rows reverse a capture
 * (`reversalOfId`), `refundedAmount` is what has already been returned on a
 * capture, `methodCode` is the canonical method (legacy `method` label kept).
 */
export type FolioPaymentRow = {
  id: string;
  amount: number;
  currency: string;
  method: string;
  methodCode?: PaymentMethodCode | null;
  status: string;
  pspReference?: string;
  kind?: "capture" | "refund";
  refundedAmount?: number;
  reversalOfId?: string | null;
  invoiceId?: string | null;
  createdAt?: string;
  capturedAt?: string;
};

export type FolioBalance = {
  folio: { id: string; reservationId: string; guestId?: string | null; status: string; currency: string; label?: string | null; isPrimary?: boolean };
  lines: Array<{ id: string; type: string; description: string; quantity: number; unitPrice: number; taxCode?: string | null; taxCategory?: string | null; total: number; postedAt?: string }>;
  payments: FolioPaymentRow[];
  chargesTotal: number;
  paymentsTotal: number;
  /** Σ partial refunds already subtracted from paymentsTotal (informational). */
  refundsTotal?: number;
  balanceDue: number;
};

// Payment state of an invoice, derived server-side from captured payments
// linked through Payment.invoiceId (Tanda 2 · QC-03 / FISC-04). `not_applicable`
// covers cancelled / rectified invoices and negative rectifying totals. There
// is NO "paid" InvoiceStatus: never derive it locally.
export type InvoicePaymentStatus = "unpaid" | "partial" | "paid" | "not_applicable";

export type InvoiceDraft = {
  id: string;
  propertyId: string;
  status: "draft" | "issued" | "cancelled" | "rectified";
  invoiceNumber?: string;
  invoiceType: "full" | "simplified" | "rectifying" | "credit_note";
  customerType: "guest" | "company" | "agency";
  customerTaxId?: string;
  customerName?: string | null;
  currencyCode?: string;
  rectifyingForId?: string | null;
  rectifyingReasonCode?: RectifyingReasonCode | null;
  rectificationType?: "I" | "S" | null;
  cancelledAt?: string | null;
  total: number;
  taxTotal: number;
  issuedAt?: string;
  createdAt?: string;
  verifactuHash?: string;
  qrPayload?: string;
  // Listing enrichment (GET /properties/:id/invoices). Optional because the
  // create / issue responses may not carry them; the screens refetch the list
  // after every mutation instead of guessing.
  folioId?: string | null;
  reservationId?: string | null;
  paidAt?: string | null;
  paidTotal?: number;
  balanceDue?: number;
  paymentStatus?: InvoicePaymentStatus;
  /** Issuer NIF snapshot used for hash/QR; `issuerTaxIdPlaceholder` flags the sandbox placeholder. */
  issuerTaxId?: string | null;
  issuerTaxIdPlaceholder?: boolean;
};

/** Aggregate block returned with the enveloped invoice listing. */
export type InvoiceListSummary = {
  count: number;
  issued: number;
  paid: number;
  unpaid: number;
  totalDue: number;
};

export type InvoicePage = Page<InvoiceDraft> & { summary?: InvoiceListSummary };

export type InvoiceListQuery = PageQuery;

export function fetchReservations(propertyId: string): Promise<AdminReservation[]>;
export function fetchReservations(propertyId: string, query: ReservationListQuery): Promise<Page<AdminReservation>>;
export function fetchReservations(
  propertyId: string,
  query?: ReservationListQuery
): Promise<AdminReservation[] | Page<AdminReservation>> {
  if (!query) return apiRequest<AdminReservation[]>(`/properties/${propertyId}/reservations`);
  return apiRequest<Page<AdminReservation>>(`/properties/${propertyId}/reservations`, {
    query: toListQuery({ ...query, envelope: true })
  });
}

export function fetchReservation(reservationId: string): Promise<AdminReservation> {
  return apiRequest<AdminReservation>(`/reservations/${reservationId}`);
}

export function fetchRoomTypes(propertyId: string): Promise<AdminRoomType[]> {
  return apiRequest<AdminRoomType[]>(`/properties/${propertyId}/room-types`);
}

export function quoteAvailability(propertyId: string, payload: Record<string, unknown>): Promise<AvailabilityQuote[]> {
  return apiRequest<AvailabilityQuote[]>(`/properties/${propertyId}/availability/quote`, { method: "POST", body: payload });
}

export type ReservationDraft = {
  arrivalDate?: string;
  departureDate?: string;
  nights?: number;
  adults?: number;
  children?: number;
  roomTypeId?: string;
  roomTypeName?: string;
  boardType?: string;
  guestName?: string;
  email?: string;
  phone?: string;
  specialRequests?: string;
};

export type ReservationParseResult = {
  source: "ai" | "rules" | "none";
  modelVersion: string;
  confidence: number;
  message?: string;
  draft: ReservationDraft;
};

export type ActivityItem = {
  id: string;
  kind: "message" | "housekeeping" | "maintenance" | "service_request";
  department: string;
  title: string;
  detail?: string;
  status?: string;
  priority?: string;
  channel?: string;
  at: string;
  open: boolean;
  conversationId?: string;
};

export type GuestActivity = {
  reservationId: string;
  roomId?: string;
  guestId?: string;
  items: ActivityItem[];
  counts: { messages: number; housekeeping: number; maintenance: number; serviceRequests: number; openTotal: number; unreadGuest: number };
};

export function fetchGuestActivity(reservationId: string): Promise<GuestActivity> {
  return apiRequest<GuestActivity>(`/reservations/${reservationId}/activity`);
}

export function aiParseReservation(propertyId: string, text: string): Promise<ReservationParseResult> {
  return apiRequest<ReservationParseResult>(`/properties/${propertyId}/reservations/ai-parse`, { method: "POST", body: { text } });
}

export function createReservation(propertyId: string, payload: Record<string, unknown>): Promise<AdminReservation> {
  return apiRequest<AdminReservation>(`/properties/${propertyId}/reservations`, { method: "POST", body: payload });
}

export function fetchReservationFolio(reservationId: string): Promise<FolioBalance> {
  return apiRequest<FolioBalance>(`/reservations/${reservationId}/folio`);
}

// --- Front-desk actions (P1.10) -------------------------------------------

export type AdminRoom = {
  id: string;
  number: string;
  floor?: string;
  roomTypeId: string;
  status: string;
  housekeepingStatus?: string;
  maintenanceStatus?: string;
  sellable: boolean;
};

export function fetchRooms(propertyId: string): Promise<AdminRoom[]> {
  return apiRequest<AdminRoom[]>(`/properties/${propertyId}/rooms`);
}

export function assignReservationRoom(
  reservationId: string,
  body: { roomId?: string; roomNumber?: string }
): Promise<AdminReservation> {
  return apiRequest<AdminReservation>(`/reservations/${reservationId}/assign-room`, { method: "POST", body });
}

// PATCH /reservations/:id — strict allowlist mirrored from
// apps/api/src/schemas/reservations.schemas.ts UpdateReservationSchema (Tanda 2 ·
// REC-01). Unknown keys → 400. `status` is deliberately NOT accepted: state
// changes go through /check-in, /check-out, /cancel and /no-show. Passing
// `assignedRoomId` / `roomId` runs canAssignRoom and, for checked-in stays,
// delegates to the transactional room move.
export type ReservationPatch = Partial<{
  arrivalDate: string;
  departureDate: string;
  adults: number;
  children: number;
  infants: number;
  childrenAges: number[];
  roomsCount: number;
  /** "HH:MM" */
  eta: string;
  etd: string;
  roomTypeId: string;
  assignedRoomId: string | null;
  /** Alias of assignedRoomId. */
  roomId: string | null;
  ratePlanId: string | null;
  boardType: string | null;
  marketSegment: string | null;
  sourceCode: string | null;
  purposeOfStay: string | null;
  guaranteeType: string | null;
  depositAmount: number | null;
  cancellationPolicyCode: string | null;
  billingInstruction: string | null;
  companyName: string | null;
  travelAgentName: string | null;
  groupCode: string | null;
  externalReference: string | null;
  bookerName: string | null;
  bookerEmail: string | null;
  specialRequests: string | null;
  notes: string | null;
  internalNotes: string | null;
  estimatedArrivalTime: string | null;
  paymentMethod: string | null;
  depositPaid: number | null;
  /** YYYY-MM-DD */
  depositDueDate: string | null;
  vipFlag: boolean;
  accessibilityNeeds: string | null;
  dietaryRequirements: string | null;
  /** null / "" detaches the reservation from its group. */
  groupBookingId: string | null;
  totalAmount: number;
  currency: string;
}>;

export function updateReservation(reservationId: string, patch: ReservationPatch): Promise<AdminReservation> {
  return apiRequest<AdminReservation>(`/reservations/${reservationId}`, { method: "PATCH", body: patch });
}

export function checkInReservation(
  reservationId: string,
  body: { roomId: string; signatureObjectKey?: string }
): Promise<AdminReservation> {
  return apiRequest<AdminReservation>(`/reservations/${reservationId}/check-in`, { method: "POST", body });
}

export type CheckOutOptions = {
  /**
   * Tanda 2 · REC-08: the API answers 409 (details.code BALANCE_DUE) when the
   * folio still has a balance. The UI must show the amount and let the operator
   * either collect it or explicitly retry with `acknowledgeBalance: true`.
   */
  acknowledgeBalance?: boolean;
};

export function checkOutReservation(
  reservationId: string,
  options: CheckOutOptions = {}
): Promise<{ reservation: AdminReservation }> {
  // Nota: body {} explícito — el endpoint valida `request.body ?? {}` y apiRequest
  // solo fija Content-Type JSON cuando hay body. `undefined` keys are dropped by
  // JSON.stringify, so an empty options object still sends `{}`.
  return apiRequest<{ reservation: AdminReservation }>(`/reservations/${reservationId}/check-out`, {
    method: "POST",
    body: { acknowledgeBalance: options.acknowledgeBalance }
  });
}

export type BalanceDueConflict = {
  /** Outstanding balance as reported by the API; null when the payload omits it. */
  balanceDue: number | null;
  message: string;
};

/**
 * Recognize the REC-08 409 from /check-out. Prefers the typed `details.code`
 * (exposed once api-client forwards the error `details`); until then it falls
 * back to the API message ("Saldo pendiente de X €…"). Any other error → null.
 */
export function balanceDueConflict(err: unknown): BalanceDueConflict | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const details = (err as { details?: { code?: unknown; balanceDue?: unknown } }).details;
  if (details && details.code === "BALANCE_DUE") {
    return { balanceDue: typeof details.balanceDue === "number" ? details.balanceDue : null, message: err.message };
  }
  if (/saldo pendiente/i.test(err.message)) return { balanceDue: null, message: err.message };
  return null;
}

// Tanda L3 (lote A → B): `applyPolicy` travels in the body under that EXACT key
// (CancelReservationSchema / NoShowReservationSchema are not strict: a
// misspelled key would be dropped in silence). Omitted = the API applies the
// cancellation policy (penalty + folio close); `false` skips it.
// Corrector L3 (DS-02): waiving a penalty above the operative band answers 409
// APPROVAL_REQUIRED (kind discount); a supervisor PIN bound to
// `pms.reservation.override` on the reservation travels as
// `supervisorAuthorizationId` (CancelReservationSchema / NoShowReservationSchema).
export type ReservationLifecycleOptions = { applyPolicy?: boolean; supervisorAuthorizationId?: string | null };

function lifecycleBody(reason: string | undefined, options?: ReservationLifecycleOptions): Record<string, unknown> {
  return {
    reason,
    ...(options?.applyPolicy !== undefined ? { applyPolicy: options.applyPolicy } : {}),
    ...(options?.supervisorAuthorizationId ? { supervisorAuthorizationId: options.supervisorAuthorizationId } : {})
  };
}

export function cancelReservation(reservationId: string, reason?: string, options?: ReservationLifecycleOptions): Promise<AdminReservation> {
  return apiRequest<AdminReservation>(`/reservations/${reservationId}/cancel`, { method: "POST", body: lifecycleBody(reason, options) });
}

export function noShowReservation(reservationId: string, reason?: string, options?: ReservationLifecycleOptions): Promise<AdminReservation> {
  return apiRequest<AdminReservation>(`/reservations/${reservationId}/no-show`, { method: "POST", body: lifecycleBody(reason, options) });
}

export function postFolioLine(
  folioId: string,
  // Tanda L3 (lote A → F1/T): `taxCategory` is the explicit fiscal category of
  // the line (FolioLine.taxCategory); omitted → the API infers it from `type`.
  body: { type: string; description: string; quantity: number; unitPrice: number; taxCode?: string; taxCategory?: string }
): Promise<unknown> {
  return apiRequest<unknown>(`/folios/${folioId}/lines`, { method: "POST", body });
}

// --- cobros y devoluciones (Finanzas · Tanda 6) -----------------------------
// POST /folios/:id/payments is idempotent by `clientRequestId` (one uuid per
// attempt, reused on retries): cash · card_terminal · bank_transfer · other
// answer 201 (200 on replay) with `kind: "payment"`; card_online ·
// payment_link answer 202 with `kind: "payment_intent"` and the PSP redirect
// (GET url or POST fields) — nothing is «cobrado» until the PSP confirms.
// Without PSP credentials the API answers 409 PSP_NOT_CONFIGURED
// (`details.psp.message`, shown by financeErrorMessage). Legacy wire values of
// `method` ("card", "transfer", "link", "online", "ota_virtual_card") are still
// accepted and normalised by the API.
export type FolioPaymentMethod = PaymentMethodCode | LegacyPaymentMethodAlias;

export type FolioPaymentInput = {
  amount: number;
  currency?: string;
  method: FolioPaymentMethod;
  /** Bank / terminal / PSP reference of the collection. */
  reference?: string;
  /** @deprecated alias of `reference`. */
  pspReference?: string;
  /** Idempotency key of the attempt (finance-contracts.newClientRequestId). */
  clientRequestId?: string;
  /** Link the capture to an issued invoice of this folio. */
  invoiceId?: string;
  /** payment_link / card_online: where the customer lands afterwards. */
  returnUrl?: string;
};

/**
 * @deprecated Pre-Tanda 6 shape (free-text `method`, no idempotency key) still
 * used by ReservationWorkspaceScreen «Cobrar»; lot 6-A / reservations migrates
 * it to FolioPaymentInput (enum method + clientRequestId + reference) and
 * branches on `kind` (payment · payment_intent).
 */
export type LegacyFolioPaymentInput = { amount: number; currency?: string; method: string; pspReference?: string };

export function postFolioPayment(folioId: string, body: FolioPaymentInput): Promise<FolioPaymentResult>;
/** @deprecated see LegacyFolioPaymentInput. */
export function postFolioPayment(folioId: string, body: LegacyFolioPaymentInput): Promise<FolioPaymentResult>;
export function postFolioPayment(folioId: string, body: FolioPaymentInput | LegacyFolioPaymentInput): Promise<FolioPaymentResult> {
  return apiRequest<FolioPaymentResult>(`/folios/${folioId}/payments`, { method: "POST", body });
}

export type RefundFolioPaymentInput = {
  reason?: string;
  /** Partial refund; default: the remaining captured amount. */
  amount?: number;
  /** Idempotency key of the refund attempt. */
  clientRequestId?: string;
  /** How the money goes back (default: the original method). */
  refundMethod?: FolioPaymentMethod;
  /** Tanda 8a (§5.6): single-use supervisor PIN authorisation for payments.refund_approve (the alternative to an approved request). */
  supervisorAuthorizationId?: string;
};

/** Refund of a captured payment: a reversal Payment row (`reversal`, `kind: "refund"` in the folio); `idempotent` on replay. */
export function refundFolioPayment(paymentId: string, body: RefundFolioPaymentInput = {}): Promise<RefundResponse> {
  return apiRequest<RefundResponse>(`/payments/${paymentId}/refund`, { method: "POST", body });
}

/** 202: hosted-page intent for the guest (Stripe Checkout / Redsys); 409 PSP_NOT_CONFIGURED without credentials. */
export function createFolioPaymentLink(
  folioId: string,
  body: { amount?: number; currency?: string; method?: "card_online" | "payment_link"; clientRequestId?: string; returnUrl?: string } = {}
): Promise<PaymentLinkResponse> {
  return apiRequest<PaymentLinkResponse>(`/folios/${folioId}/payment-links`, { method: "POST", body });
}

/** Tenancy-gated: an intent of another organisation is an opaque 404. */
export function fetchPaymentIntent(intentId: string): Promise<PaymentIntentWire> {
  return apiRequest<PaymentIntentWire>(`/payment-intents/${encodeURIComponent(intentId)}`);
}

/** Whether card_online / payment_link can be taken (`configured`, `provider`, `mode`, honest `message`). */
export function fetchPspStatus(propertyId: string): Promise<PspStatusWire> {
  return apiRequest<PspStatusWire>(`/properties/${propertyId}/payments/psp-status`);
}

export type ScanIdResult = {
  configured: boolean;
  source: "ai" | "manual";
  message?: string;
  fields: {
    documentType?: string;
    documentNumber?: string;
    documentSupportNumber?: string;
    firstName?: string;
    surname1?: string;
    surname2?: string;
    dateOfBirth?: string;
    nationality?: string;
    sex?: string;
  };
};

export function scanIdDocument(imageDataUrl: string): Promise<ScanIdResult> {
  return apiRequest<ScanIdResult>(`/ai/commands/scan-id-document`, { method: "POST", body: { imageDataUrl } });
}

export function fetchInvoices(propertyId: string): Promise<InvoiceDraft[]>;
export function fetchInvoices(propertyId: string, query: InvoiceListQuery): Promise<InvoicePage>;
export function fetchInvoices(propertyId: string, query?: InvoiceListQuery): Promise<InvoiceDraft[] | InvoicePage> {
  if (!query) return apiRequest<InvoiceDraft[]>(`/properties/${propertyId}/invoices`);
  return apiRequest<InvoicePage>(`/properties/${propertyId}/invoices`, {
    query: toListQuery({ ...query, envelope: true })
  });
}

/** Manual draft line (POST /invoices/drafts · CreateInvoiceDraftSchema.lines[]). Prices are gross (tax included). */
export type CreateInvoiceDraftLine = {
  description: string;
  quantity: number;
  unitPrice: number;
  taxCode?: string;
  taxRate: number;
  total: number;
  /** Tanda 3: fiscal category the API resolves against the property's tax profile (contract A TaxCategory). */
  taxCategory?: string;
};

export type CreateInvoiceDraftPayload = Omit<InvoiceDraft, "id" | "status"> & {
  lines?: CreateInvoiceDraftLine[];
  currencyCode?: string;
};

export function createInvoiceDraft(payload: CreateInvoiceDraftPayload): Promise<InvoiceDraft> {
  return apiRequest<InvoiceDraft>(`/invoices/drafts`, { method: "POST", body: payload });
}

export function issueInvoice(invoiceId: string): Promise<InvoiceDraft> {
  return apiRequest<InvoiceDraft>(`/invoices/${invoiceId}/issue`, { method: "POST", body: {} });
}

export type RectifyingReasonCode = "R1" | "R2" | "R3" | "R4" | "R5";

export type InvoiceIssuer = {
  propertyName?: string;
  legalName?: string;
  taxId?: string;
  /** True when the sandbox placeholder NIF was used (no valid NIF configured). */
  taxIdPlaceholder?: boolean;
  address?: string;
  logoUrl?: string;
  legalFooter?: string;
};

export function fetchInvoiceBranding(propertyId: string): Promise<InvoiceIssuer> {
  return apiRequest<InvoiceIssuer>(`/properties/${propertyId}/invoice-branding`);
}

export function saveInvoiceBranding(
  propertyId: string,
  body: { logoUrl?: string | null; legalFooter?: string | null }
): Promise<InvoiceIssuer> {
  return apiRequest<InvoiceIssuer>(`/properties/${propertyId}/invoice-branding`, { method: "PATCH", body });
}

// Tanda 3 · indirect taxes: the per-line figure / category / calificación and
// the persisted breakdown (Invoice.taxBreakdownJson, contract B) — the ONLY
// source the XML, PDF and UI use for bases and quotas. Optional because
// invoices issued before Tanda 3 do not carry them.
export type InvoiceTaxFigure = "IVA" | "IGIC" | "IPSI";
export type InvoiceTaxCalificacion = "S1" | "N1";
export type InvoiceTaxBreakdownGroup = {
  figure: InvoiceTaxFigure;
  impuesto: "01" | "02" | "03";
  calificacion: InvoiceTaxCalificacion;
  ratePercent: number;
  base: number;
  quota: number;
};

export type InvoiceLineFull = {
  id?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxCode: string;
  taxRate: number;
  total: number;
  taxCategory?: string | null;
  taxCalificacion?: InvoiceTaxCalificacion | null;
  taxFigure?: InvoiceTaxFigure | null;
};

export type InvoiceFull = InvoiceDraft & {
  issuer?: InvoiceIssuer & { warnings?: string[] };
  /** Frozen document of an issued invoice (Invoice.snapshotJson); null on drafts and pre-Tanda 6 rows. */
  snapshot?: InvoiceSnapshotV1 | null;
  rectifyingForId?: string;
  rectifyingReasonCode?: RectifyingReasonCode;
  cancelledAt?: string;
  invoiceType: InvoiceDraft["invoiceType"] | RectifyingReasonCode;
  lines: InvoiceLineFull[];
  /** Persisted breakdown grouped by (impuesto, calificación, tipo); absent on pre-Tanda-3 invoices. */
  taxBreakdown?: InvoiceTaxBreakdownGroup[] | null;
  /** Non-blocking tax problems (lines without a configured rate, IPSI unconfirmed…). */
  warnings?: string[];
  rectificationType?: "I" | "S" | null;
};

export function fetchInvoice(invoiceId: string): Promise<InvoiceFull> {
  return apiRequest<InvoiceFull>(`/invoices/${invoiceId}`);
}

/**
 * Cancellation: the invoice is unlinked from its payments (they stay on the
 * folio); `refundPayments: true` also reverses them. Finanzas · Tanda 6: the
 * answer carries `payments` (unlinked / refunded ids, folio balance).
 */
export type CancelInvoiceOptions = { refundPayments?: boolean };

export type CancelInvoiceResponse = InvoiceFull & { payments?: InvoiceCancellationPayments };

export function cancelInvoice(invoiceId: string, reason?: string, options: CancelInvoiceOptions = {}): Promise<CancelInvoiceResponse> {
  return apiRequest<CancelInvoiceResponse>(`/invoices/${invoiceId}/cancel`, { method: "POST", body: { reason, ...options } });
}

/**
 * Real PDF of an issued invoice (QR VeriFactu included) as a Blob: the screen
 * opens an object URL or saves it — never `window.print()`. `download: true`
 * asks for `Content-Disposition: attachment`.
 */
export async function getInvoicePdf(invoiceId: string, options: { download?: boolean } = {}): Promise<{ blob: Blob; filename: string; contentType: string }> {
  const response = await apiRequestBlob(`/invoices/${invoiceId}/pdf`, { query: options.download ? { download: 1 } : undefined });
  return { blob: response.blob, filename: downloadFilename(response.contentDisposition, `factura-${invoiceId}.pdf`), contentType: response.contentType };
}

/** Substitute line of a rectificativa «S» (RectifyInvoiceSchema.substituteLines[]): gross unit price, folio convention. */
export type RectifySubstituteLine = { description: string; quantity: number; unitPrice: number; lineType?: string; taxCategory?: string };

/**
 * POST /invoices/:id/rectify (RectifyInvoiceSchema, strict): «I» (por
 * diferencias, default) with `fullReversal` or `lineAdjustments[{ lineId,
 * quantity?, unitPrice? }]`; «S» (sustitución) with `substituteLines`.
 */
export type RectifyInvoicePayload = {
  reasonCode: RectifyingReasonCode;
  rectificationType?: "I" | "S";
  lineAdjustments?: Array<{ lineId: string; quantity?: number; unitPrice?: number }>;
  substituteLines?: RectifySubstituteLine[];
  fullReversal?: boolean;
};

export function rectifyInvoice(invoiceId: string, payload: RectifyInvoicePayload): Promise<InvoiceFull> {
  return apiRequest<InvoiceFull>(`/invoices/${invoiceId}/rectify`, { method: "POST", body: payload });
}

export function fetchInvoiceRectifications(invoiceId: string): Promise<InvoiceFull[]> {
  return apiRequest<InvoiceFull[]>(`/invoices/${invoiceId}/rectifications`);
}

// --- invoice actions (mark paid / send by email) ---------------------------
// POST /invoices/:id/mark-paid and POST /invoices/:id/send-email.
// Finanzas · Tanda 6: «Marcar pagada» needs `method` (PaymentMethod enum;
// legacy aliases still normalised) AND `reference` — the API answers 400
// without them, so the screens ask for both in a dialog (the pre-Tanda 6 call
// without arguments is kept compilable for the billing screens until lot 6-A
// migrates them, but it is a 400 at runtime).
export type MarkInvoicePaidPayload = {
  method?: FolioPaymentMethod;
  /** Bank / terminal / PSP reference of the collection (required by the API). */
  reference?: string;
  /** @deprecated alias of `reference`. */
  pspReference?: string;
  amount?: number;
};

// Tanda 2 · FISC-04: the payment is written against invoice.folioId (409
// "La factura no está vinculada a ningún folio" for manual drafts) and
// idempotent per (invoiceId, pspReference) → alreadyPaid.
export type MarkInvoicePaidResponse = {
  invoiceId: string;
  paidAmount: number;
  invoiceTotal: number;
  alreadyPaid: boolean;
  balanceDue?: number;
  paymentStatus?: InvoicePaymentStatus;
  paidAt?: string | null;
  folioId?: string | null;
};

export function markInvoicePaid(invoiceId: string, payload: MarkInvoicePaidPayload = {}): Promise<MarkInvoicePaidResponse> {
  return apiRequest<MarkInvoicePaidResponse>(`/invoices/${invoiceId}/mark-paid`, { method: "POST", body: payload });
}

export type SendInvoiceEmailPayload = {
  recipient: string;
  subject?: string;
  message?: string;
};

/**
 * Finanzas · Tanda 6: the email carries the PDF; `status: "simulated"` /
 * `simulated: true` means no email provider is configured and nothing left the
 * box — the screen says «Simulado: proveedor de correo no configurado», never
 * «enviado». (`acknowledged` is the pre-Tanda 6 field, kept optional.)
 */
export type SendInvoiceEmailResponse = InvoiceEmailResponse & { acknowledged?: true };

export function sendInvoiceEmail(invoiceId: string, payload: SendInvoiceEmailPayload): Promise<SendInvoiceEmailResponse> {
  return apiRequest<SendInvoiceEmailResponse>(`/invoices/${invoiceId}/send-email`, { method: "POST", body: payload });
}

export function fetchReportCatalog(propertyId: string) {
  return apiRequest<unknown>(`/reports/properties/${propertyId}/catalog`);
}

export function fetchReservationReport(propertyId: string) {
  return apiRequest<unknown>(`/reports/properties/${propertyId}/reservations`);
}

export function fetchBillingReport(propertyId: string) {
  return apiRequest<unknown>(`/reports/properties/${propertyId}/billing`);
}

/**
 * POST /reports/properties/:id/export (FIX-1 · F5). `content` is the file body
 * for the inline download; `downloadUrl` is the authenticated route
 * (GET /reports/exports/:id/download) that serves the same artefact again until
 * `expiresAt` (15 min in the API's in-memory store).
 */
export type ReportExportResult = {
  export: { id: string; filename: string; contentType: string; downloadUrl: string; expiresAt: string };
  content: string;
};

export function exportOperationalReport(propertyId: string, payload: Record<string, unknown>) {
  return apiRequest<ReportExportResult>(`/reports/properties/${propertyId}/export`, { method: "POST", body: payload });
}

/** The stored artefact of a finished export (404 «Exportación no encontrada o caducada.» once expired). */
export function fetchReportExportFile(downloadUrl: string) {
  return apiRequestBlob(downloadUrl);
}

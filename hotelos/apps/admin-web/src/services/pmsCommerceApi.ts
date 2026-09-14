// PMS commerce client (reservations, folios, invoices, reports).
//
// SECURITY (auditoría 2026-07): este módulo usaba `fetch` crudo SIN cabecera
// Authorization. Bajo el gate de auth de producción (sin HOTELOS_ALLOW_DEMO_AUTH)
// todas sus llamadas devolvían 401 — crear reserva, check-in/out, cancelar…— y,
// con el gate abierto, se ejecutaban como el super-usuario demo (traza de
// auditoría corrupta). Ahora TODO pasa por `apiRequest` (JWT + manejo de 401 +
// extracción de mensaje de error). No añadir `fetch` crudo aquí.
import { apiRequest, ApiError } from "./api-client";

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
  totalAmount: number;
  cancellationPolicy: string;
};

export type FolioBalance = {
  folio: { id: string; reservationId: string; guestId?: string; status: string; currency: string };
  lines: Array<{ id: string; type: string; description: string; quantity: number; unitPrice: number; taxCode?: string; total: number }>;
  payments: Array<{ id: string; amount: number; currency: string; method: string; status: string; pspReference?: string }>;
  chargesTotal: number;
  paymentsTotal: number;
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

export function cancelReservation(reservationId: string, reason?: string): Promise<AdminReservation> {
  return apiRequest<AdminReservation>(`/reservations/${reservationId}/cancel`, { method: "POST", body: { reason } });
}

export function noShowReservation(reservationId: string, reason?: string): Promise<AdminReservation> {
  return apiRequest<AdminReservation>(`/reservations/${reservationId}/no-show`, { method: "POST", body: { reason } });
}

export function postFolioLine(
  folioId: string,
  body: { type: string; description: string; quantity: number; unitPrice: number; taxCode?: string }
): Promise<unknown> {
  return apiRequest<unknown>(`/folios/${folioId}/lines`, { method: "POST", body });
}

export function postFolioPayment(
  folioId: string,
  body: { amount: number; currency?: string; method: string; pspReference?: string }
): Promise<unknown> {
  return apiRequest<unknown>(`/folios/${folioId}/payments`, { method: "POST", body });
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

export function createInvoiceDraft(payload: Omit<InvoiceDraft, "id" | "status">): Promise<InvoiceDraft> {
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

export type InvoiceFull = InvoiceDraft & {
  issuer?: InvoiceIssuer;
  rectifyingForId?: string;
  rectifyingReasonCode?: RectifyingReasonCode;
  cancelledAt?: string;
  invoiceType: InvoiceDraft["invoiceType"] | RectifyingReasonCode;
  lines: Array<{
    id?: string;
    description: string;
    quantity: number;
    unitPrice: number;
    taxCode: string;
    taxRate: number;
    total: number;
  }>;
};

export function fetchInvoice(invoiceId: string): Promise<InvoiceFull> {
  return apiRequest<InvoiceFull>(`/invoices/${invoiceId}`);
}

export function cancelInvoice(invoiceId: string, reason?: string): Promise<InvoiceFull> {
  return apiRequest<InvoiceFull>(`/invoices/${invoiceId}/cancel`, { method: "POST", body: { reason } });
}

export function rectifyInvoice(
  invoiceId: string,
  payload: {
    reasonCode: RectifyingReasonCode;
    lineAdjustments?: Array<{ lineId: string; quantity?: number; unitPrice?: number }>;
    fullReversal?: boolean;
  }
): Promise<InvoiceFull> {
  return apiRequest<InvoiceFull>(`/invoices/${invoiceId}/rectify`, { method: "POST", body: payload });
}

export function fetchInvoiceRectifications(invoiceId: string): Promise<InvoiceFull[]> {
  return apiRequest<InvoiceFull[]>(`/invoices/${invoiceId}/rectifications`);
}

// --- invoice actions (mark paid / send by email) ---------------------------
// These call POST /invoices/:id/mark-paid and POST /invoices/:id/send-email
// (already implemented server-side in apps/api). They are designed so the
// UI can request the action with minimal arguments — the server fills the
// defaults (e.g. method=card, amount=invoiceTotal).
// `method` aligned with the API PaymentRecord.method union (the server stores
// the string as-is, so an off-union value would leak into the ledger).
export type MarkInvoicePaidPayload = {
  method?: "cash" | "card" | "bank_transfer" | "payment_link" | "ota_virtual_card";
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

export type SendInvoiceEmailResponse = {
  acknowledged: true;
  recipient: string;
  invoiceId: string;
  sentAt: string;
};

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

export function exportOperationalReport(propertyId: string, payload: Record<string, unknown>) {
  return apiRequest<unknown>(`/reports/properties/${propertyId}/export`, { method: "POST", body: payload });
}

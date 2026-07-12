// PMS commerce client (reservations, folios, invoices, reports).
//
// SECURITY (auditoría 2026-07): este módulo usaba `fetch` crudo SIN cabecera
// Authorization. Bajo el gate de auth de producción (sin HOTELOS_ALLOW_DEMO_AUTH)
// todas sus llamadas devolvían 401 — crear reserva, check-in/out, cancelar…— y,
// con el gate abierto, se ejecutaban como el super-usuario demo (traza de
// auditoría corrupta). Ahora TODO pasa por `apiRequest` (JWT + manejo de 401 +
// extracción de mensaje de error). No añadir `fetch` crudo aquí.
import { apiRequest } from "./api-client";

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
  verifactuHash?: string;
  qrPayload?: string;
};

export function fetchReservations(propertyId: string): Promise<AdminReservation[]> {
  return apiRequest<AdminReservation[]>(`/properties/${propertyId}/reservations`);
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

// PATCH /reservations/:id — server accepts arrivalDate/departureDate/adults/
// children/roomTypeId/totalAmount/status and runs availability/overlap checks.
// Used by the Live Timeline for drag-to-resize (change dates).
export function updateReservation(
  reservationId: string,
  patch: Partial<{ arrivalDate: string; departureDate: string; status: string; adults: number; children: number; roomTypeId: string; totalAmount: number }>
): Promise<AdminReservation> {
  return apiRequest<AdminReservation>(`/reservations/${reservationId}`, { method: "PATCH", body: patch });
}

export function checkInReservation(
  reservationId: string,
  body: { roomId: string; signatureObjectKey?: string }
): Promise<AdminReservation> {
  return apiRequest<AdminReservation>(`/reservations/${reservationId}/check-in`, { method: "POST", body });
}

export function checkOutReservation(reservationId: string): Promise<{ reservation: AdminReservation }> {
  // Nota: body {} explícito — el endpoint valida `request.body ?? {}` y apiRequest
  // solo fija Content-Type JSON cuando hay body.
  return apiRequest<{ reservation: AdminReservation }>(`/reservations/${reservationId}/check-out`, { method: "POST", body: {} });
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

export function fetchInvoices(propertyId: string): Promise<InvoiceDraft[]> {
  return apiRequest<InvoiceDraft[]>(`/properties/${propertyId}/invoices`);
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
export type MarkInvoicePaidPayload = {
  method?: "cash" | "card" | "transfer" | "applepay" | "googlepay" | "voucher" | "loyalty" | "deposit";
  pspReference?: string;
  amount?: number;
};

export type MarkInvoicePaidResponse = {
  invoiceId: string;
  paidAmount: number;
  invoiceTotal: number;
  alreadyPaid: boolean;
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

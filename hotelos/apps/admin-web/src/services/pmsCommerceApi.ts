const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

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

export async function fetchReservations(propertyId: string): Promise<AdminReservation[]> {
  const response = await fetch(`${API_BASE_URL}/properties/${propertyId}/reservations`);
  if (!response.ok) throw new Error("Unable to load reservations.");
  return response.json() as Promise<AdminReservation[]>;
}

export async function fetchReservation(reservationId: string): Promise<AdminReservation> {
  const response = await fetch(`${API_BASE_URL}/reservations/${reservationId}`);
  if (!response.ok) throw new Error("Unable to load reservation.");
  return response.json() as Promise<AdminReservation>;
}

export async function fetchRoomTypes(propertyId: string): Promise<AdminRoomType[]> {
  const response = await fetch(`${API_BASE_URL}/properties/${propertyId}/room-types`);
  if (!response.ok) throw new Error("Unable to load room types.");
  return response.json() as Promise<AdminRoomType[]>;
}

export async function quoteAvailability(propertyId: string, payload: Record<string, unknown>): Promise<AvailabilityQuote[]> {
  const response = await fetch(`${API_BASE_URL}/properties/${propertyId}/availability/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Unable to quote availability.");
  return response.json() as Promise<AvailabilityQuote[]>;
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

export async function fetchGuestActivity(reservationId: string): Promise<GuestActivity> {
  const response = await fetch(`${API_BASE_URL}/reservations/${reservationId}/activity`);
  if (!response.ok) throw new Error("Unable to load guest activity.");
  return response.json() as Promise<GuestActivity>;
}

export async function aiParseReservation(propertyId: string, text: string): Promise<ReservationParseResult> {
  const response = await fetch(`${API_BASE_URL}/properties/${propertyId}/reservations/ai-parse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!response.ok) throw new Error("Unable to parse the request.");
  return response.json() as Promise<ReservationParseResult>;
}

export async function createReservation(propertyId: string, payload: Record<string, unknown>): Promise<AdminReservation> {
  const response = await fetch(`${API_BASE_URL}/properties/${propertyId}/reservations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Unable to create reservation.");
  return response.json() as Promise<AdminReservation>;
}

export async function fetchReservationFolio(reservationId: string): Promise<FolioBalance> {
  const response = await fetch(`${API_BASE_URL}/reservations/${reservationId}/folio`);
  if (!response.ok) throw new Error("Unable to load folio.");
  return response.json() as Promise<FolioBalance>;
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

export async function fetchRooms(propertyId: string): Promise<AdminRoom[]> {
  const response = await fetch(`${API_BASE_URL}/properties/${propertyId}/rooms`);
  if (!response.ok) throw new Error("Unable to load rooms.");
  return response.json() as Promise<AdminRoom[]>;
}

async function postAction<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    // Only set a JSON content-type when there's actually a body — Fastify rejects
    // an empty body when Content-Type is application/json (e.g. check-out).
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = text;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      /* keep raw */
    }
    throw new Error(message || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function assignReservationRoom(
  reservationId: string,
  body: { roomId?: string; roomNumber?: string }
): Promise<AdminReservation> {
  return postAction<AdminReservation>(`/reservations/${reservationId}/assign-room`, body);
}

// PATCH /reservations/:id — server accepts arrivalDate/departureDate/adults/
// children/roomTypeId/totalAmount/status and runs availability/overlap checks.
// Used by the Live Timeline for drag-to-resize (change dates).
export async function updateReservation(
  reservationId: string,
  patch: Partial<{ arrivalDate: string; departureDate: string; status: string; adults: number; children: number; roomTypeId: string; totalAmount: number }>
): Promise<AdminReservation> {
  const response = await fetch(`${API_BASE_URL}/reservations/${reservationId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let message = text;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? text;
    } catch {
      /* keep raw */
    }
    throw new Error(message || `HTTP ${response.status}`);
  }
  return response.json() as Promise<AdminReservation>;
}

export function checkInReservation(
  reservationId: string,
  body: { roomId: string; signatureObjectKey?: string }
): Promise<AdminReservation> {
  return postAction<AdminReservation>(`/reservations/${reservationId}/check-in`, body);
}

export function checkOutReservation(reservationId: string): Promise<{ reservation: AdminReservation }> {
  return postAction<{ reservation: AdminReservation }>(`/reservations/${reservationId}/check-out`);
}

export function cancelReservation(reservationId: string, reason?: string): Promise<AdminReservation> {
  return postAction<AdminReservation>(`/reservations/${reservationId}/cancel`, { reason });
}

export function noShowReservation(reservationId: string, reason?: string): Promise<AdminReservation> {
  return postAction<AdminReservation>(`/reservations/${reservationId}/no-show`, { reason });
}

export function postFolioLine(
  folioId: string,
  body: { type: string; description: string; quantity: number; unitPrice: number; taxCode?: string }
): Promise<unknown> {
  return postAction(`/folios/${folioId}/lines`, body);
}

export function postFolioPayment(
  folioId: string,
  body: { amount: number; currency?: string; method: string; pspReference?: string }
): Promise<unknown> {
  return postAction(`/folios/${folioId}/payments`, body);
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

export async function scanIdDocument(imageDataUrl: string): Promise<ScanIdResult> {
  const response = await fetch(`${API_BASE_URL}/ai/commands/scan-id-document`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageDataUrl })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || "No se pudo escanear el documento.");
  }
  return response.json() as Promise<ScanIdResult>;
}

export async function fetchInvoices(propertyId: string): Promise<InvoiceDraft[]> {
  const response = await fetch(`${API_BASE_URL}/properties/${propertyId}/invoices`);
  if (!response.ok) throw new Error("Unable to load invoices.");
  return response.json() as Promise<InvoiceDraft[]>;
}

export async function createInvoiceDraft(payload: Omit<InvoiceDraft, "id" | "status">): Promise<InvoiceDraft> {
  const response = await fetch(`${API_BASE_URL}/invoices/drafts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Unable to create invoice draft.");
  return response.json() as Promise<InvoiceDraft>;
}

export async function issueInvoice(invoiceId: string): Promise<InvoiceDraft> {
  const response = await fetch(`${API_BASE_URL}/invoices/${invoiceId}/issue`, { method: "POST" });
  if (!response.ok) throw new Error("Unable to issue invoice.");
  return response.json() as Promise<InvoiceDraft>;
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

export async function fetchInvoiceBranding(propertyId: string): Promise<InvoiceIssuer> {
  const response = await fetch(`${API_BASE_URL}/properties/${propertyId}/invoice-branding`);
  if (!response.ok) throw new Error("Unable to load invoice branding.");
  return response.json() as Promise<InvoiceIssuer>;
}

export async function saveInvoiceBranding(
  propertyId: string,
  body: { logoUrl?: string | null; legalFooter?: string | null }
): Promise<InvoiceIssuer> {
  const response = await fetch(`${API_BASE_URL}/properties/${propertyId}/invoice-branding`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || "Unable to save invoice branding.");
  }
  return response.json() as Promise<InvoiceIssuer>;
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

export async function fetchInvoice(invoiceId: string): Promise<InvoiceFull> {
  const response = await fetch(`${API_BASE_URL}/invoices/${invoiceId}`);
  if (!response.ok) throw new Error("Unable to load invoice.");
  return response.json() as Promise<InvoiceFull>;
}

export async function cancelInvoice(invoiceId: string, reason?: string): Promise<InvoiceFull> {
  const response = await fetch(`${API_BASE_URL}/invoices/${invoiceId}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason })
  });
  if (!response.ok) throw new Error("Unable to cancel invoice.");
  return response.json() as Promise<InvoiceFull>;
}

export async function rectifyInvoice(
  invoiceId: string,
  payload: {
    reasonCode: RectifyingReasonCode;
    lineAdjustments?: Array<{ lineId: string; quantity?: number; unitPrice?: number }>;
    fullReversal?: boolean;
  }
): Promise<InvoiceFull> {
  const response = await fetch(`${API_BASE_URL}/invoices/${invoiceId}/rectify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || "Unable to create rectifying invoice.");
  }
  return response.json() as Promise<InvoiceFull>;
}

export async function fetchInvoiceRectifications(invoiceId: string): Promise<InvoiceFull[]> {
  const response = await fetch(`${API_BASE_URL}/invoices/${invoiceId}/rectifications`);
  if (!response.ok) throw new Error("Unable to load rectifications.");
  return response.json() as Promise<InvoiceFull[]>;
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

export async function markInvoicePaid(invoiceId: string, payload: MarkInvoicePaidPayload = {}): Promise<MarkInvoicePaidResponse> {
  const response = await fetch(`${API_BASE_URL}/invoices/${invoiceId}/mark-paid`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || "Unable to mark invoice as paid.");
  }
  return response.json() as Promise<MarkInvoicePaidResponse>;
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

export async function sendInvoiceEmail(invoiceId: string, payload: SendInvoiceEmailPayload): Promise<SendInvoiceEmailResponse> {
  const response = await fetch(`${API_BASE_URL}/invoices/${invoiceId}/send-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(text || "Unable to send invoice email.");
  }
  return response.json() as Promise<SendInvoiceEmailResponse>;
}

export async function fetchReportCatalog(propertyId: string) {
  const response = await fetch(`${API_BASE_URL}/reports/properties/${propertyId}/catalog`);
  if (!response.ok) throw new Error("Unable to load report catalog.");
  return response.json();
}

export async function fetchReservationReport(propertyId: string) {
  const response = await fetch(`${API_BASE_URL}/reports/properties/${propertyId}/reservations`);
  if (!response.ok) throw new Error("Unable to load reservation report.");
  return response.json();
}

export async function fetchBillingReport(propertyId: string) {
  const response = await fetch(`${API_BASE_URL}/reports/properties/${propertyId}/billing`);
  if (!response.ok) throw new Error("Unable to load billing report.");
  return response.json();
}

export async function exportOperationalReport(propertyId: string, payload: Record<string, unknown>) {
  const response = await fetch(`${API_BASE_URL}/reports/properties/${propertyId}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error("Unable to export report.");
  return response.json();
}

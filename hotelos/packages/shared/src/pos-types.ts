/**
 * TPV · arqueo · cierre del día — shared wire contract between the API
 * (`apps/api/src/modules/pos`, `modules/night-audit`) and admin-web.
 *
 * Finanzas (2026-09-15, lote «pos-noche»). Money on the wire is a plain
 * number with 2 decimals in the property currency EXCEPT the cash-closure
 * figures, which travel as decimal strings ("118.00"): a cash count is signed
 * by a person and must round-trip byte for byte. Dates are calendar days
 * `YYYY-MM-DD` in the property's time zone unless the field says ISO instant.
 *
 * Contract (docs/runbooks/finanzas-contabilidad.md §1.5):
 *   · a ticket settled `cash` | `card` becomes a simplified invoice (series FS,
 *     F2, no customer NIF up to 400 € — 3.000 € for hostelería, art. 4.2 RD
 *     1619/2012) + one journal entry D 570|5721 / H 705.x / H 477.tipo + one
 *     VAT-book row per rate; it never creates a `Payment` (no folio);
 *   · a ticket settled `room` posts one folio line per tax group (10 % food &
 *     beverage, 21 % alcoholic beverages / general services) and NO entry
 *     until the folio is invoiced;
 *   · a `CashClosure` is unique per (property, outlet, business day); once
 *     `closed` or `approved`, cash/card sales of that outlet and day are
 *     refused with 409 `CASH_CLOSURE_CLOSED`.
 */

export type PosSettlement = "room" | "cash" | "card";

/** Fiscal category of a POS line (subset of TaxCategory in @hotelos/compliance). */
export type PosLineTaxCategory = "food_beverage" | "general_services";

export type PosOutletWire = { id: string; name: string; category: string };

export type PosLineWire = {
  name: string;
  quantity: number;
  unitPrice: number;
  /** Gross line amount (tax included): quantity × unitPrice rounded to cents. */
  total: number;
  /** Catalogue product the line was matched to (PosProduct.id), when any. */
  productId?: string | null;
  /** Resolved when the ticket closes; absent on open tickets. */
  taxCategory?: PosLineTaxCategory;
  /** True when the catalogue marks the product as an alcoholic beverage (general rate). */
  alcohol?: boolean;
};

export type PosTicketStatus = "open" | "closed";

export type PosTicketWire = {
  id: string;
  propertyId: string;
  /** Board outlet id (`out_<outletType>`). */
  outletId: string;
  outletName: string;
  status: PosTicketStatus;
  roomNumber?: string;
  lines: PosLineWire[];
  /** Gross ticket total (tax included). */
  total: number;
  /** Tax included in `total`; 0 on open tickets and on legacy rows closed before this contract. */
  taxTotal: number;
  settlement?: PosSettlement;
  createdAt: string;
  closedAt?: string;
  closedByUserId?: string | null;
  /** Business day the sale belongs to (property-local calendar day of the close). */
  businessDate?: string | null;
  /** Simplified invoice of a cash/card sale (Invoice.id, series FS). */
  invoiceId?: string | null;
  invoiceNumber?: string | null;
  /** Journal entry of a cash/card sale. */
  journalEntryId?: string | null;
  /** Cash closure the sale was counted in, once the day is closed. */
  cashClosureId?: string | null;
};

export type PosTicketListStatus = "open" | "closed" | "all";

// ── Cash closure (arqueo) ────────────────────────────────────────────────────

export type CashClosureStatus = "open" | "closed" | "approved";

/** Canonical payment methods (PaymentMethod enum) as counted in a closure. */
export type CashMethod = "cash" | "card_terminal" | "card_online" | "bank_transfer" | "payment_link" | "other";

export const CASH_METHODS: readonly CashMethod[] = ["cash", "card_terminal", "card_online", "bank_transfer", "payment_link", "other"];

/** Figures of one method: decimal strings ("118.00"); counted/difference null until the closure is closed. */
export type CashMethodFigures = {
  expected: string;
  counted: string | null;
  difference: string | null;
};

export type CashDenominationCount = {
  /** Face value as a decimal string ("50", "0.20"). */
  denomination: string;
  quantity: number;
  /** denomination × quantity, decimal string. */
  amount: string;
};

/** Where the expected cash comes from (audit trail of the count). */
export type CashExpectationDetail = {
  openingFloat: string;
  /** Captured folio payments of the business day, by method. */
  payments: Record<CashMethod, string>;
  /** Refunds of the business day by method (negative contribution). */
  refunds: Record<CashMethod, string>;
  /** POS cash/card sales closed on the business day (no Payment row). */
  posSales: Record<CashMethod, string>;
  /** Petty-cash expenses paid in cash on the business day. */
  cashExpenses: string;
};

export type CashClosureWire = {
  id: string;
  propertyId: string;
  /** "*" = reception cash (whole property); otherwise the board outlet id (`out_<type>`). */
  outletId: string;
  /** Outlet row id (Outlet.id) behind `outletId`; "*" for the property-wide closure. */
  outletRowId: string;
  outletName: string | null;
  businessDate: string;
  status: CashClosureStatus;
  openedAt: string;
  closedAt: string | null;
  approvedAt: string | null;
  openedBy: string | null;
  closedBy: string | null;
  approvedBy: string | null;
  openingFloat: string;
  expectedCash: string;
  countedCash: string | null;
  /** countedCash − expectedCash (positive = sobrante, negative = faltante). */
  difference: string | null;
  byMethod: Record<CashMethod, CashMethodFigures>;
  expectation: CashExpectationDetail;
  counts: CashDenominationCount[];
  notes: string | null;
  /** Journal entry of the cash difference (D 659 / H 570 faltante · D 570 / H 759 sobrante); null when the cash squared. */
  journalEntryId: string | null;
  /** Closed POS tickets of the outlet/day linked to this closure at close time. */
  linkedTickets: number;
};

export type CashClosureOpenRequest = {
  /** "*" (default) or a board outlet id (`out_bar`) / Outlet row id. */
  outletId?: string;
  /** Business day; default = the property's current calendar day. */
  businessDate?: string;
  openingFloat?: number;
  notes?: string;
};

export type CashClosureCloseRequest = {
  /** Counted amount per method; a method not sent counts as 0. */
  countedByMethod: Partial<Record<CashMethod, number>>;
  /** Optional physical count by denomination; when sent its sum must equal countedByMethod.cash. */
  counts?: Array<{ denomination: string | number; quantity: number }>;
  notes?: string;
};

export type CashClosureApproveRequest = { notes?: string };

export type CashClosureListQuery = {
  status?: CashClosureStatus;
  outletId?: string;
  from?: string;
  to?: string;
  limit?: number;
};

// ── Night audit (cierre del día) ─────────────────────────────────────────────

export type NightAuditStatus = "not_started" | "in_progress" | "completed" | "failed";
export type NightAuditStepStatus = "ok" | "warning" | "skipped" | "failed";

export type NightAuditStepWire = {
  step: string;
  status: NightAuditStepStatus;
  detail?: string;
  metrics?: Record<string, number>;
  /** Actionable items (reservation codes without rate, folios skipped…). */
  items?: Array<{ ref: string; label: string; detail?: string }>;
};

export type NightAuditRoomChargeItem = {
  reservationId: string;
  reservationCode: string;
  folioId: string | null;
  outcome: "posted" | "already_posted" | "no_rate" | "no_open_folio";
  amount: string | null;
  /** Where the nightly price came from. */
  priceSource: "rate_plan" | "lowest_published" | "reservation_total" | "none";
  detail?: string;
};

export type NightAuditReportWire = {
  businessDate: string;
  nextBusinessDate: string;
  timeZone: string;
  inHouseReservations: number;
  roomCharges: { posted: number; alreadyPosted: number; withoutRate: number; withoutFolio: number; totalPosted: string; items: NightAuditRoomChargeItem[] };
  noShows: { processed: number; totalCharged: string };
  revenue: { total: string; lines: number; byType: Record<string, string> };
  payments: { total: string; count: number; byMethod: Record<string, string> };
  cashClosures: Array<{ outletId: string; status: CashClosureStatus; difference: string | null }>;
  warnings: string[];
};

export type NightAuditRunWire = {
  id: string;
  propertyId: string;
  businessDate: string;
  status: NightAuditStatus;
  startedAt?: string;
  completedAt?: string;
  startedBy?: string;
  stepResults: NightAuditStepWire[];
  report: NightAuditReportWire | null;
  errorMessage?: string;
  createdAt: string;
};

// ── Error codes (details.code on 4xx) ────────────────────────────────────────

export type PosErrorCode =
  | "POS_TICKET_CLOSED"
  | "POS_OUTLET_NOT_FOUND"
  | "POS_ROOM_NOT_OCCUPIED"
  | "CASH_CLOSURE_CLOSED"
  | "CASH_CLOSURE_EXISTS"
  | "CASH_CLOSURE_NOT_OPEN"
  | "CASH_CLOSURE_NOT_CLOSED"
  | "CASH_COUNT_MISMATCH"
  | "SIMPLIFIED_INVOICE_LIMIT"
  | "CHART_NOT_PROVISIONED"
  | "ACCOUNT_MISSING"
  | "FISCAL_PERIOD_CLOSED"
  | "INVALID_DATE"
  | "WINDOW_PARAMS_CONFLICT"
  | "NIGHT_AUDIT_ALREADY_COMPLETED"
  | "NIGHT_AUDIT_IN_PROGRESS";

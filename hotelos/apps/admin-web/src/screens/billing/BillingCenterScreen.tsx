// Facturación y cobros — Finanzas › Facturación y cobros (/finanzas/facturacion).
//
// Cocoa 22 · lote 6-A, archetype «dashboard alojado» (docs/design/COCOA-22.md
// §4): KPI strip of the invoice book, the folio of a reservation (balance,
// charges, collections) with «Cobrar» / «Devolver» through the Tanda 6
// dialogs, the invoice draft form (fiscal categories from the property's tax
// profile), the invoice list with its filters and the detail drawer where
// every fiscal action lives:
//   · Descargar PDF → GET /invoices/:id/pdf?download=1 as a Blob (never window.print)
//   · Marcar pagada → POST /invoices/:id/mark-paid { method, reference, amount? } (400 without them)
//   · Enviar por correo → POST /invoices/:id/send-email — `simulated: true` is
//     shown as «Simulado: proveedor de correo no configurado», never «enviado»
//   · Anular → POST /invoices/:id/cancel { reason, refundPayments } (payments unlinked / refunded)
//   · Rectificar → Rectificativas tab with the original preselected (?factura=)
// Issued invoices show the frozen `snapshot` lines when the API carries it.
// Reads GET /properties/:id/reservations, GET /reservations/:id/folio (payments
// with kind / refundedAmount), GET /properties/:id/invoices (enveloped, with
// `summary`), GET /properties/:id/invoice-branding and GET /backoffice/properties/:id/taxes.
// Hosted inside FacturacionTabs the container paints the head.
//
// Tanda L3 · lote F1 (2026-09-18, decisiones §6.13 / §6.14):
//   · the reservation picker is a search: free text (code, holder, primary
//     guest) → GET /properties/:id/reservations?q=…&limit=25&sort=arrival_desc
//     and «Más resultados» walks `nextCursor` (helpers in ./billingSearch.ts);
//   · «Registrar pago» is the visible label of the same PaymentDialog
//     (POST /folios/:id/payments, payment.capture);
//   · «Añadir cargo» lives here too: POST /folios/:id/lines with the type of
//     `MANUAL_CHARGE_TYPES` and an explicit `taxCategory` (folio.charge.post);
//   · Anular resends with `supervisorAuthorizationId` after a 409
//     APPROVAL_REQUIRED / RBAC_SOD_CONFLICT (SupervisorPinDialog, key
//     invoice.cancel_approve) — the separation of duties stays in the API.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  cancelInvoice,
  createInvoiceDraft,
  fetchInvoice,
  fetchInvoiceBranding,
  fetchInvoices,
  fetchReservationFolio,
  fetchReservations,
  getInvoicePdf,
  issueInvoice,
  markInvoicePaid,
  postFolioLine,
  saveInvoiceBranding,
  sendInvoiceEmail,
  type AdminReservation,
  type CancelInvoiceOptions,
  type CreateInvoiceDraftLine,
  type FolioBalance,
  type InvoiceDraft,
  type InvoiceFull,
  type InvoiceLineFull,
  type InvoiceListSummary,
  type InvoiceTaxBreakdownGroup
} from "../../services/pmsCommerceApi";
import type { InvoiceCancellationPayments, PaymentMethodCode, SupervisorAuthorizationDto } from "@hotelos/shared";
import { ApiError } from "../../services/api-client";
import { financeErrorCode, financeErrorMessage } from "../../services/finance-contracts";
import { TAX_CATEGORY_LABELS, TAX_CATEGORY_OPTIONS, buildTaxCodeClient, fetchPropertyTaxes, isSuspiciousTaxLine, rateForCategory, type PropertyTaxProfile, type TaxCategory } from "../../services/taxesApi";
import { chargeTypeLabel, defaultTaxCategoryForType, manualChargeTypeOptions, taxCategoryOptionsForType } from "../../components/billing/charge-types";
import { SupervisorPinDialog } from "../../components/SupervisorPinDialog";
import { buildReservationSearchQuery, mergeReservationPages, pickSearchSelection, reservationResultLabel, searchResultsSummary } from "./billingSearch";
import { FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { verifactuExclusionText } from "../../services/finance-contracts";
import { financeScopePolicy, useFinanceScope } from "../../services/financeScope";
import { toArray } from "../../utils/toArray";
import { navigateTo } from "../../lib/navigate";
import { useToast } from "../../components/Toast";
import { exportToCsv, type CsvColumn } from "../../lib/csv";
import { logBreadcrumb } from "../../lib/breadcrumb";
import { date, isoDate, money, plural } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS } from "../../content/actions";
import { fillParams, urlForScreen } from "../../navigation/nav-tree";
import { useTabHost } from "../tabs/TabHost";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance/CocoaScreenInstructionsCard";
import { BILLING_INSTRUCTIONS } from "../../content/screen-instructions/billing";
import { PaymentDialog } from "../../components/billing/PaymentDialog";
import { RefundDialog } from "../../components/billing/RefundDialog";
import { saveBlob } from "../../components/billing/download";
import { amountToInput, parseAmount, paymentKind, paymentKindLabel, paymentMethodLabel, paymentMethodOptions, refundablePayments } from "../../components/billing/payment-flow";
import { canMarkPaid, customerTypeLabel, deriveInvoiceUiStatus, invoiceStatusLabel, invoiceStatusTone, invoiceTypeLabel, isInvoicePaid } from "./invoiceStatus";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaLiveRegion,
  CocoaPage,
  CocoaSearchInput,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaStat,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  CocoaToolbar,
  openTabPath,
  type CocoaTableColumn
} from "../../components/cocoa";

type InvoiceTab = "draft" | "issued" | "pending" | "paid" | "cancelled";

const TAB_DEFS: Array<{ key: InvoiceTab; label: string }> = [
  { key: "draft", label: "Borradores" },
  { key: "issued", label: "Emitidas" },
  { key: "pending", label: "Pendientes" },
  { key: "paid", label: "Pagadas" },
  { key: "cancelled", label: "Anuladas" }
];

// Rows per page for the invoice listing (API caps at 500); «Cargar más» walks
// the cursor. The enveloped response also carries the aggregate `summary`.
const INVOICE_PAGE_SIZE = 200;
// The reservation picker searches the API (25 rows per page, cursor for the
// rest): see ./billingSearch.ts. The select only lists what the search found.
const MANUAL_CHARGE_OPTIONS = manualChargeTypeOptions();

// --- «Añadir cargo» on the selected folio (Tanda L3 · F1) -------------------
// Gross unit price like every folio line; `taxCategory` travels explicitly
// (preselected from the type, editable) so the line never reaches invoicing
// without a category.
type ChargeForm = { type: string; description: string; quantity: string; unitPrice: string; taxCategory: TaxCategory };

function newChargeForm(type: string = MANUAL_CHARGE_OPTIONS[0]?.value ?? "room"): ChargeForm {
  return { type, description: chargeTypeLabel(type), quantity: "1", unitPrice: "", taxCategory: defaultTaxCategoryForType(type) };
}

/** 409 of POST /invoices/:id/cancel that a present supervisor can lift with their PIN (or an approved request). */
type CancelApproval = { code: "APPROVAL_REQUIRED" | "RBAC_SOD_CONFLICT"; tier: string | null; message: string };

function readCancelApproval(error: unknown): CancelApproval | null {
  const code = financeErrorCode(error);
  if (code !== "APPROVAL_REQUIRED" && code !== "RBAC_SOD_CONFLICT") return null;
  const details = (error as { details?: { tier?: unknown } }).details;
  return { code, tier: typeof details?.tier === "string" ? details.tier : null, message: financeErrorMessage(error, "La anulación necesita autorización.") };
}

const FOLIO_URL = urlForScreen("FolioDetail") ?? "/finanzas/facturacion/folios/:id";
const ROUTING_URL = urlForScreen("FolioRouting") ?? "/finanzas/facturacion/enrutamiento";
const RECTIFICATIONS_URL = urlForScreen("InvoiceRectificationsScreen") ?? "/finanzas/facturacion/rectificativas";

// --- Manual draft lines (Tanda 3) -------------------------------------------
// Each line carries a fiscal category; the rate comes from the property's tax
// profile (GET /backoffice/properties/:id/taxes) so the draft never invents a
// percentage. Prices are GROSS (tax included), like folio lines.
type DraftLineInput = { key: string; description: string; quantity: string; unitPrice: string; taxCategory: TaxCategory };

function newDraftLine(category: TaxCategory = "accommodation"): DraftLineInput {
  return { key: `line-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, description: "", quantity: "1", unitPrice: "", taxCategory: category };
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

function resolveDraftLines(lines: DraftLineInput[], profile: PropertyTaxProfile | null): { lines: CreateInvoiceDraftLine[]; total: number; taxTotal: number; missing: TaxCategory[] } {
  const resolved: CreateInvoiceDraftLine[] = [];
  const missing = new Set<TaxCategory>();
  let total = 0;
  let taxTotal = 0;
  for (const line of lines) {
    const quantity = parseAmount(line.quantity);
    const unitPrice = parseAmount(line.unitPrice);
    if (!line.description.trim() || quantity === null || quantity <= 0 || unitPrice === null) continue;
    const rate = rateForCategory(profile, line.taxCategory);
    if (!rate || !profile) {
      missing.add(line.taxCategory);
      continue;
    }
    const lineTotal = round2(quantity * unitPrice);
    const percent = rate.calificacion === "N1" ? 0 : rate.ratePercent;
    const base = percent > 0 ? round2(lineTotal / (1 + percent / 100)) : lineTotal;
    resolved.push({
      description: line.description.trim(),
      quantity,
      unitPrice,
      taxCode: buildTaxCodeClient(profile.figure, percent, rate.calificacion),
      taxRate: percent,
      taxCategory: line.taxCategory,
      total: lineTotal
    });
    total = round2(total + lineTotal);
    taxTotal = round2(taxTotal + (lineTotal - base));
  }
  return { lines: resolved, total, taxTotal, missing: Array.from(missing) };
}

/** 409 TAX_NOT_CONFIGURED payload from POST /invoices/:id/issue (contract D · taxReadinessForInvoice). */
type IssueBlock = { code: string; message: string; lines: string[]; hint?: string };

function readIssueBlock(error: unknown): IssueBlock | null {
  if (!(error instanceof ApiError) || error.status !== 409) return null;
  const details = (error.details ?? {}) as { code?: unknown; lines?: unknown; blocking?: unknown; hint?: unknown };
  if (details.code !== "TAX_NOT_CONFIGURED") return null;
  const lines = toArray<unknown>(details.lines ?? details.blocking).map((entry) => (typeof entry === "string" ? entry : entry && typeof entry === "object" ? JSON.stringify(entry) : String(entry)));
  return { code: "TAX_NOT_CONFIGURED", message: error.message, lines, hint: typeof details.hint === "string" ? details.hint : undefined };
}

type MarkPaidForm = { invoice: InvoiceDraft; method: PaymentMethodCode; reference: string; amount: string };
type EmailForm = { invoice: InvoiceDraft; to: string; subject: string; body: string };
type CancelForm = { invoice: InvoiceDraft; reason: string; refundPayments: boolean };

/** Lines painted in the detail: the frozen snapshot of an issued invoice when the API carries it, else the live rows. */
type DetailLine = { key: string; description: string; quantity: number; unitPrice: number; taxLabel: string; suspicious: boolean; total: number };

function detailLines(invoice: InvoiceFull): { lines: DetailLine[]; frozen: boolean } {
  if (invoice.snapshot && invoice.snapshot.lines.length > 0) {
    return {
      frozen: true,
      lines: invoice.snapshot.lines.map((line, index) => ({
        key: line.folioLineId ?? `snap-${index}`,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        taxLabel: line.taxCalificacion === "N1" ? `${line.taxFigure ?? ""} no sujeta`.trim() : `${line.taxFigure ?? line.taxCode} ${line.taxRate} %`,
        suspicious: isSuspiciousTaxLine(line),
        total: line.total
      }))
    };
  }
  return {
    frozen: false,
    lines: toArray<InvoiceLineFull>(invoice.lines).map((line, index) => ({
      key: line.id ?? `line-${index}`,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      taxLabel: line.taxCalificacion === "N1" ? `${line.taxFigure ?? ""} no sujeta`.trim() : `${line.taxFigure ?? line.taxCode} ${line.taxRate} %`,
      suspicious: isSuspiciousTaxLine(line),
      total: line.total
    }))
  };
}

const DETAIL_COLUMNS: CocoaTableColumn<DetailLine>[] = [
  { key: "description", label: FIELD_LABELS.description, render: (line) => line.description },
  { key: "quantity", label: "Cantidad", align: "right", render: (line) => line.quantity, hideOnNarrow: true },
  { key: "unitPrice", label: "Precio", align: "right", render: (line) => money(line.unitPrice), hideOnNarrow: true },
  {
    key: "tax",
    label: "Impuesto",
    render: (line) => (
      <span className="cocoa-cluster">
        {line.taxLabel}
        {line.suspicious ? <CocoaBadge tone="warning" size="small">sin tipo</CocoaBadge> : null}
      </span>
    )
  },
  { key: "total", label: FIELD_LABELS.total, align: "right", render: (line) => <strong>{money(line.total)}</strong> }
];

/** Tanda 6b (L3): additive issuer fields of GET /invoices/:id — sociedad domicilio fiscal, establishment block, SII exclusion. */
type IssuerStructure = {
  fiscalAddress?: string;
  establishment?: { code: string | null; tradeName: string; addressLine: string | null } | null;
  verifactuExclusion?: { code?: string; motivo: string } | null;
};

function BillingSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton.Grid rows={[[7, 5], [12]]} height={260} />
    </div>
  );
}

export function BillingCenterScreen() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  // Tanda 6b · L7 (design §5.3): emission is operational — the «Ámbito» offers the centres that issue (hotel / other,
  // never the oficina central) and defaults to the active hotel; the issuer printed is ALWAYS the sociedad (R2).
  const finance = useFinanceScope(financeScopePolicy("BillingCenterScreen"), { excludeOffice: true });
  const propertyId = finance.propertyId ?? finance.active.propertyId;

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Reservation search (Tanda L3 · F1): `reservationSearch` is the debounced
  // text, `reservations` the pages loaded so far, `reservationsCursor` the
  // next page. A stale answer (the operator kept typing) is dropped by `searchSeq`.
  const [reservationSearch, setReservationSearch] = useState("");
  const [reservations, setReservations] = useState<AdminReservation[]>([]);
  const [reservationsCursor, setReservationsCursor] = useState<string | null>(null);
  const [reservationsTotal, setReservationsTotal] = useState<number | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingMoreReservations, setLoadingMoreReservations] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchSeq = useRef(0);
  const [selectedReservationId, setSelectedReservationId] = useState("");
  const [folio, setFolio] = useState<FolioBalance | null>(null);
  const [chargeForm, setChargeForm] = useState<ChargeForm>(() => newChargeForm());
  const [postingCharge, setPostingCharge] = useState(false);
  // Anulación with supervisor PIN: the 409 of the last attempt and the authorisation obtained.
  const [cancelApproval, setCancelApproval] = useState<CancelApproval | null>(null);
  const [cancelPinOpen, setCancelPinOpen] = useState(false);
  const [cancelAuthorization, setCancelAuthorization] = useState<SupervisorAuthorizationDto | null>(null);
  const [folioError, setFolioError] = useState<string | null>(null);
  const [folioView, setFolioView] = useState<"charges" | "payments">("charges");
  const [invoices, setInvoices] = useState<InvoiceDraft[]>([]);
  const [invoiceSummary, setInvoiceSummary] = useState<InvoiceListSummary | null>(null);
  const [invoicesNextCursor, setInvoicesNextCursor] = useState<string | null>(null);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [loadingMoreInvoices, setLoadingMoreInvoices] = useState(false);
  const [draftTotal, setDraftTotal] = useState("");
  const [draftTaxTotal, setDraftTaxTotal] = useState("");
  const [draftLines, setDraftLines] = useState<DraftLineInput[]>([]);
  const [taxProfile, setTaxProfile] = useState<PropertyTaxProfile | null>(null);
  const [taxProfileError, setTaxProfileError] = useState<string | null>(null);
  // Invoices whose issue was refused with 409 TAX_NOT_CONFIGURED: «Emitir» stays
  // disabled (with the reason) until the tax profile is fixed.
  const [issueBlocks, setIssueBlocks] = useState<Record<string, IssueBlock>>({});
  const [customerType, setCustomerType] = useState<InvoiceDraft["customerType"]>("guest");
  const [invoiceType, setInvoiceType] = useState<InvoiceDraft["invoiceType"]>("full");
  const [customerTaxId, setCustomerTaxId] = useState("");
  const [logoUrl, setLogoUrl] = useState("");
  const [legalFooter, setLegalFooter] = useState("");
  const [savingBranding, setSavingBranding] = useState(false);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<InvoiceTab>("draft");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const [detail, setDetail] = useState<InvoiceFull | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [emailNotice, setEmailNotice] = useState<{ tone: "success" | "warning"; title: string; message: string } | null>(null);
  const [cancelNotice, setCancelNotice] = useState<InvoiceCancellationPayments | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);
  const [markPaid, setMarkPaid] = useState<MarkPaidForm | null>(null);
  const [emailForm, setEmailForm] = useState<EmailForm | null>(null);
  const [cancelForm, setCancelForm] = useState<CancelForm | null>(null);
  const [issueConfirm, setIssueConfirm] = useState<InvoiceDraft | null>(null);

  // Enveloped listing: items carry paymentStatus/balanceDue, `summary` feeds the
  // KPIs across ALL invoices (not just the loaded page).
  async function loadInvoices() {
    setInvoicesError(null);
    try {
      const page = await fetchInvoices(propertyId, { limit: INVOICE_PAGE_SIZE });
      setInvoices(page.items);
      setInvoiceSummary(page.summary ?? null);
      setInvoicesNextCursor(page.nextCursor);
    } catch (error) {
      setInvoicesError(financeErrorMessage(error, "No se pudieron cargar las facturas."));
      throw error;
    }
  }

  async function loadMoreInvoices() {
    if (!invoicesNextCursor || loadingMoreInvoices) return;
    setLoadingMoreInvoices(true);
    try {
      const page = await fetchInvoices(propertyId, { limit: INVOICE_PAGE_SIZE, cursor: invoicesNextCursor });
      setInvoices((current) => {
        const seen = new Set(current.map((invoice) => invoice.id));
        return [...current, ...page.items.filter((invoice) => !seen.has(invoice.id))];
      });
      if (page.summary) setInvoiceSummary(page.summary);
      setInvoicesNextCursor(page.nextCursor);
    } catch (error) {
      showToast(financeErrorMessage(error, "No se pudieron cargar más facturas."), { variant: "error" });
    } finally {
      setLoadingMoreInvoices(false);
    }
  }

  async function loadFolio(reservationId: string) {
    setFolioError(null);
    try {
      const response = await fetchReservationFolio(reservationId);
      setFolio(response);
      if (draftLines.length === 0 && draftTotal === "") setDraftTotal(amountToInput(response.chargesTotal));
    } catch (error) {
      setFolio(null);
      setFolioError(financeErrorMessage(error, "No se pudo cargar el folio de la reserva."));
    }
  }

  async function refresh() {
    setLoading(true);
    setLoadError(null);
    const results = await Promise.allSettled([searchReservations(reservationSearch), loadInvoices()]);
    if (results.every((result) => result.status === "rejected")) {
      setLoadError("No se pudieron cargar los datos de facturación. Comprueba la conexión con el servidor.");
    }
    void fetchInvoiceBranding(propertyId)
      .then((branding) => {
        setLogoUrl(branding.logoUrl ?? "");
        setLegalFooter(branding.legalFooter ?? "");
      })
      .catch(() => undefined);
    void fetchPropertyTaxes(propertyId)
      .then((profile) => {
        setTaxProfile(profile);
        setTaxProfileError(null);
      })
      .catch((error: unknown) => {
        setTaxProfile(null);
        setTaxProfileError(financeErrorMessage(error, "Perfil fiscal no disponible."));
      });
    setLoading(false);
  }

  useEffect(() => {
    // The eligible centres come from the structure (fix:L7 qa#11): until it is known the scope would be
    // the active property even when that is the oficina central, so wait for it instead of loading twice.
    if (finance.loading) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [propertyId, finance.loading]);

  function handleReservationChange(reservationId: string) {
    setSelectedReservationId(reservationId);
    setFolio(null);
    void loadFolio(reservationId);
  }

  /**
   * First page of a search (Tanda L3 · F1): `q` over code / holder / primary
   * guest, 25 most recent arrivals. Keeps the selected reservation when it is
   * still in the page, otherwise selects the first row. Rethrows so
   * `refresh()` can tell a total failure from a partial one.
   */
  async function searchReservations(rawQuery: string): Promise<void> {
    const seq = ++searchSeq.current;
    setSearching(true);
    setSearchError(null);
    try {
      const page = await fetchReservations(propertyId, buildReservationSearchQuery(rawQuery));
      if (seq !== searchSeq.current) return;
      setReservations(page.items);
      setReservationsCursor(page.nextCursor);
      setReservationsTotal(page.total);
      const nextSelected = pickSearchSelection(page.items, selectedReservationId);
      if (nextSelected !== selectedReservationId) {
        setSelectedReservationId(nextSelected);
        setFolio(null);
        setFolioError(null);
      }
      if (nextSelected) await loadFolio(nextSelected);
      else setFolio(null);
    } catch (error) {
      if (seq === searchSeq.current) setSearchError(financeErrorMessage(error, "No se pudieron buscar las reservas."));
      throw error;
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }

  async function loadMoreReservations() {
    if (!reservationsCursor || loadingMoreReservations) return;
    setLoadingMoreReservations(true);
    try {
      const page = await fetchReservations(propertyId, buildReservationSearchQuery(reservationSearch, { cursor: reservationsCursor }));
      setReservations((current) => mergeReservationPages(current, page.items));
      setReservationsCursor(page.nextCursor);
      setReservationsTotal(page.total);
    } catch (error) {
      showToast(financeErrorMessage(error, "No se pudieron cargar más reservas."), { variant: "error" });
    } finally {
      setLoadingMoreReservations(false);
    }
  }

  // The debounced text drives the search; the first load belongs to refresh()
  // (skipped here while the page is still loading).
  useEffect(() => {
    if (finance.loading || loading) return;
    void searchReservations(reservationSearch).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservationSearch]);

  function updateChargeType(type: string) {
    setChargeForm((current) => ({
      ...current,
      type,
      // Keep a description the operator already edited; refresh the default one.
      description: current.description.trim() === "" || current.description === chargeTypeLabel(current.type) ? chargeTypeLabel(type) : current.description,
      taxCategory: defaultTaxCategoryForType(type)
    }));
  }

  /** POST /folios/:id/lines with the explicit fiscal category (folio.charge.post). */
  async function handleAddCharge() {
    if (!folio || folio.folio.status !== "open") return;
    const description = chargeForm.description.trim();
    const quantity = parseAmount(chargeForm.quantity);
    const unitPrice = parseAmount(chargeForm.unitPrice);
    if (!description) {
      showToast("Indica el concepto del cargo.", { variant: "error" });
      return;
    }
    if (quantity === null || quantity <= 0) {
      showToast("Indica una cantidad mayor que cero.", { variant: "error" });
      return;
    }
    if (unitPrice === null || unitPrice < 0) {
      showToast("Indica el precio bruto del cargo (0 o más).", { variant: "error" });
      return;
    }
    logBreadcrumb("folio.charge.post", "mutation", { folioId: folio.folio.id, type: chargeForm.type, taxCategory: chargeForm.taxCategory });
    setPostingCharge(true);
    try {
      await postFolioLine(folio.folio.id, { type: chargeForm.type, description, quantity, unitPrice, taxCategory: chargeForm.taxCategory });
      const message = `Cargo «${description}» añadido al folio (${money(round2(quantity * unitPrice), folio.folio.currency)} · ${TAX_CATEGORY_LABELS[chargeForm.taxCategory]}).`;
      setStatus(message);
      showToast(message, { variant: "success" });
      setChargeForm(newChargeForm(chargeForm.type));
      setFolioView("charges");
      await loadFolio(folio.folio.reservationId);
    } catch (error) {
      showToast(financeErrorMessage(error, "No se pudo añadir el cargo al folio."), { variant: "error" });
    } finally {
      setPostingCharge(false);
    }
  }

  async function handleCreateDraft() {
    // PII-safe: no customerTaxId in the breadcrumb, only the type and totals.
    logBreadcrumb("invoice.draft", "mutation", { invoiceType, customerType });
    const resolvedDraft = resolveDraftLines(draftLines, taxProfile);
    if (draftLines.length > 0 && resolvedDraft.missing.length > 0) {
      showToast(`Sin tipo impositivo para ${resolvedDraft.missing.map((category) => TAX_CATEGORY_LABELS[category].toLowerCase()).join(", ")}: configura Impuestos de la propiedad antes de crear el borrador.`, { variant: "error" });
      return;
    }
    if (draftLines.length > 0 && resolvedDraft.lines.length === 0) {
      showToast("Completa la descripción, la cantidad y el precio de al menos una línea.", { variant: "error" });
      return;
    }
    const useLines = resolvedDraft.lines.length > 0;
    const total = useLines ? resolvedDraft.total : parseAmount(draftTotal);
    const taxTotal = useLines ? resolvedDraft.taxTotal : parseAmount(draftTaxTotal);
    if (total === null || taxTotal === null) {
      showToast("Indica el total y la cuota de impuestos del borrador.", { variant: "error" });
      return;
    }
    setBusy(true);
    try {
      const draft = await createInvoiceDraft({
        propertyId,
        invoiceType,
        customerType,
        customerTaxId: customerTaxId.trim() || undefined,
        total,
        taxTotal,
        ...(useLines ? { lines: resolvedDraft.lines } : {})
      });
      setInvoices((current) => [draft, ...current]);
      setStatus(`Borrador ${draft.id} creado.`);
      showToast(`Borrador creado (${money(draft.total, draft.currencyCode)}). Emítelo desde su detalle.`, { variant: "success" });
      if (useLines) setDraftLines([]);
      setActiveTab("draft");
    } catch (error) {
      showToast(financeErrorMessage(error, "No se pudo crear el borrador."), { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function handleIssue(invoice: InvoiceDraft) {
    logBreadcrumb("invoice.issue", "mutation", { invoiceId: invoice.id });
    setBusy(true);
    try {
      const issued = await issueInvoice(invoice.id);
      setInvoices((current) => current.map((row) => (row.id === issued.id ? { ...row, ...issued } : row)));
      // The issue response has no payment enrichment: refetch the listing.
      void loadInvoices().catch(() => undefined);
      setStatus(`Factura ${issued.invoiceNumber ?? issued.id} emitida con huella VeriFactu.`);
      showToast(`Factura ${issued.invoiceNumber ?? issued.id} emitida.`, { variant: "success" });
      setIssueConfirm(null);
      if (detail?.id === invoice.id) void openDetail(invoice.id);
    } catch (error) {
      const block = readIssueBlock(error);
      if (block) {
        setIssueBlocks((current) => ({ ...current, [invoice.id]: block }));
        showToast(block.message, { variant: "error" });
      } else {
        showToast(financeErrorMessage(error, "No se pudo emitir la factura."), { variant: "error" });
      }
      setIssueConfirm(null);
    } finally {
      setBusy(false);
    }
  }

  async function handleSaveBranding() {
    setSavingBranding(true);
    try {
      const saved = await saveInvoiceBranding(propertyId, { logoUrl: logoUrl.trim() || null, legalFooter: legalFooter.trim() || null });
      setLogoUrl(saved.logoUrl ?? "");
      setLegalFooter(saved.legalFooter ?? "");
      showToast("Logo y avisos legales guardados.", { variant: "success" });
    } catch (error) {
      showToast(financeErrorMessage(error, "No se pudo guardar la personalización de la factura."), { variant: "error" });
    } finally {
      setSavingBranding(false);
    }
  }

  async function openDetail(invoiceId: string) {
    setDetailLoading(true);
    setEmailNotice(null);
    setCancelNotice(null);
    try {
      setDetail(await fetchInvoice(invoiceId));
    } catch (error) {
      showToast(financeErrorMessage(error, "No se pudo cargar la factura."), { variant: "error" });
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleDownloadPdf(invoice: Pick<InvoiceDraft, "id" | "invoiceNumber">) {
    setDownloading(true);
    try {
      const pdf = await getInvoicePdf(invoice.id, { download: true });
      saveBlob(pdf.blob, pdf.filename);
      logBreadcrumb("invoice.pdf", "ui", { invoiceId: invoice.id });
    } catch (error) {
      showToast(financeErrorMessage(error, "No se pudo descargar el PDF."), { variant: "error" });
    } finally {
      setDownloading(false);
    }
  }

  function openMarkPaid(invoice: InvoiceDraft) {
    setMarkPaid({ invoice, method: "card_terminal", reference: "", amount: amountToInput(invoice.balanceDue ?? invoice.total) });
  }

  async function handleMarkPaid() {
    if (!markPaid) return;
    const reference = markPaid.reference.trim();
    if (!reference) {
      showToast("Indica la referencia del cobro (operación del datáfono, transferencia…).", { variant: "error" });
      return;
    }
    const amount = markPaid.amount.trim() ? parseAmount(markPaid.amount) : null;
    if (markPaid.amount.trim() && (amount === null || amount <= 0)) {
      showToast("Indica un importe mayor que cero.", { variant: "error" });
      return;
    }
    logBreadcrumb("invoice.markPaid", "mutation", { invoiceId: markPaid.invoice.id });
    setBusy(true);
    try {
      const result = await markInvoicePaid(markPaid.invoice.id, { method: markPaid.method, reference, amount: amount ?? undefined });
      const fullyPaid = result.alreadyPaid || result.paidAmount >= result.invoiceTotal;
      setInvoices((current) =>
        current.map((invoice) =>
          invoice.id === markPaid.invoice.id
            ? { ...invoice, paymentStatus: result.paymentStatus ?? (fullyPaid ? "paid" : invoice.paymentStatus), balanceDue: result.balanceDue ?? (fullyPaid ? 0 : invoice.balanceDue), paidAt: result.paidAt ?? invoice.paidAt, folioId: result.folioId ?? invoice.folioId }
            : invoice
        )
      );
      void loadInvoices().catch(() => undefined);
      const message = result.alreadyPaid ? "La factura ya estaba pagada." : `Cobro registrado: ${money(result.paidAmount)} de ${money(result.invoiceTotal)}.`;
      setStatus(message);
      showToast(message, { variant: "success" });
      setMarkPaid(null);
      if (detail?.id === markPaid.invoice.id) void openDetail(markPaid.invoice.id);
    } catch (error) {
      // Never mark the invoice paid locally: the API decides (409 for manual drafts without folio).
      const hint = error instanceof ApiError && error.status === 409 ? " Emite la factura desde el folio de la reserva o registra el cobro en ese folio." : "";
      showToast(`${financeErrorMessage(error, "No se pudo marcar la factura como pagada.")}${hint}`, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  function openEmail(invoice: InvoiceDraft) {
    const number = invoice.invoiceNumber ?? invoice.id;
    setEmailForm({
      invoice,
      to: "",
      subject: `Factura ${number}`,
      body: `Estimado cliente,\n\nLe adjuntamos la factura ${number} por importe de ${money(invoice.total, invoice.currencyCode)}.\n\nGracias por su confianza.`
    });
  }

  async function handleSendEmail() {
    if (!emailForm) return;
    const to = emailForm.to.trim();
    if (!to) {
      showToast("Indica al menos un destinatario.", { variant: "error" });
      return;
    }
    logBreadcrumb("invoice.email", "mutation", { invoiceId: emailForm.invoice.id });
    setBusy(true);
    try {
      const result = await sendInvoiceEmail(emailForm.invoice.id, { recipient: to, subject: emailForm.subject, message: emailForm.body });
      if (result.simulated || result.status === "simulated") {
        const notice = { tone: "warning" as const, title: "Simulado: proveedor de correo no configurado", message: `No se ha enviado ningún correo a ${result.recipient}. Configura el proveedor de correo en Ajustes para enviar facturas.` };
        setEmailNotice(notice);
        showToast(notice.title, { variant: "warning" });
      } else {
        const notice = { tone: "success" as const, title: `Factura enviada a ${result.recipient}`, message: `Adjunto ${result.attachment.filename}.` };
        setEmailNotice(notice);
        showToast(notice.title, { variant: "success" });
      }
      setEmailForm(null);
    } catch (error) {
      showToast(financeErrorMessage(error, "No se pudo enviar la factura por correo."), { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  function openCancel(invoice: InvoiceDraft) {
    setCancelApproval(null);
    setCancelAuthorization(null);
    setCancelPinOpen(false);
    setCancelForm({ invoice, reason: "", refundPayments: false });
  }

  /**
   * POST /invoices/:id/cancel. A 409 APPROVAL_REQUIRED / RBAC_SOD_CONFLICT is
   * not a failure of the form: the dialog offers the supervisor PIN
   * (invoice.cancel_approve) and the same call is resent with
   * `supervisorAuthorizationId` (CancelInvoiceSchema admits it). The
   * separation of duties (issuer ≠ canceller, tiers) is decided by the API.
   */
  async function handleCancel(supervisorAuthorizationId?: string) {
    if (!cancelForm) return;
    logBreadcrumb("invoice.cancel", "mutation", { invoiceId: cancelForm.invoice.id, refundPayments: cancelForm.refundPayments, supervised: Boolean(supervisorAuthorizationId) });
    setBusy(true);
    try {
      // `CancelInvoiceOptions` (services/pmsCommerceApi, lot A) does not name the key yet; the API contract does.
      const options: CancelInvoiceOptions & { supervisorAuthorizationId?: string } = {
        refundPayments: cancelForm.refundPayments,
        ...(supervisorAuthorizationId ? { supervisorAuthorizationId } : {})
      };
      const result = await cancelInvoice(cancelForm.invoice.id, cancelForm.reason.trim() || undefined, options);
      setInvoices((current) => current.map((invoice) => (invoice.id === result.id ? { ...invoice, ...result, lines: undefined } as InvoiceDraft : invoice)));
      void loadInvoices().catch(() => undefined);
      setCancelNotice(result.payments ?? null);
      setDetail(result);
      const message = `Factura ${result.invoiceNumber ?? result.id} anulada.`;
      setStatus(message);
      showToast(message, { variant: "success" });
      setCancelForm(null);
      setCancelApproval(null);
      setCancelAuthorization(null);
      if (folio) void loadFolio(folio.folio.reservationId);
    } catch (error) {
      const approval = readCancelApproval(error);
      if (approval) {
        setCancelApproval(approval);
        setCancelAuthorization(null);
        showToast(approval.message, { variant: "warning" });
      } else {
        showToast(financeErrorMessage(error, "No se pudo anular la factura."), { variant: "error" });
      }
    } finally {
      setBusy(false);
    }
  }

  function openRectify(invoice: InvoiceDraft) {
    logBreadcrumb("invoice.rectify.intent", "ui", { invoiceId: invoice.id });
    setDetail(null);
    openTabPath(`${RECTIFICATIONS_URL}?factura=${encodeURIComponent(invoice.id)}`);
  }

  const kpis = useMemo(() => {
    const counts: Record<InvoiceTab, number> = { draft: 0, issued: 0, pending: 0, paid: 0, cancelled: 0 };
    const totals: Record<InvoiceTab, number> = { draft: 0, issued: 0, pending: 0, paid: 0, cancelled: 0 };
    for (const invoice of invoices) {
      const amount = Number(invoice.total) || 0;
      if (invoice.status === "draft") {
        counts.draft += 1;
        totals.draft += amount;
      } else if (invoice.status === "issued") {
        counts.issued += 1;
        totals.issued += amount;
        if (isInvoicePaid(invoice)) {
          counts.paid += 1;
          totals.paid += amount;
        } else if (invoice.paymentStatus !== "not_applicable") {
          counts.pending += 1;
          totals.pending += invoice.balanceDue ?? amount;
        }
      } else if (invoice.status === "cancelled" || invoice.status === "rectified") {
        counts.cancelled += 1;
        totals.cancelled += amount;
      }
    }
    // The server summary spans every invoice of the property (the page may be
    // partial), so it wins for the counts it covers and for the outstanding total.
    if (invoiceSummary) {
      counts.issued = invoiceSummary.issued;
      counts.paid = invoiceSummary.paid;
      counts.pending = invoiceSummary.unpaid;
      totals.pending = invoiceSummary.totalDue;
    }
    return { counts, totals, pagePartial: Boolean(invoicesNextCursor) };
  }, [invoices, invoiceSummary, invoicesNextCursor]);

  const filteredInvoices = useMemo(() => {
    const term = search.trim().toLowerCase();
    return invoices.filter((invoice) => {
      if (activeTab === "draft" && invoice.status !== "draft") return false;
      if (activeTab === "issued" && invoice.status !== "issued") return false;
      if (activeTab === "cancelled" && invoice.status !== "cancelled" && invoice.status !== "rectified") return false;
      if (activeTab === "pending" && !canMarkPaid(invoice)) return false;
      if (activeTab === "paid" && !isInvoicePaid(invoice)) return false;
      if (!term) return true;
      const haystack = [invoice.invoiceNumber ?? "", invoice.id, invoice.customerTaxId ?? "", invoice.customerName ?? "", invoice.invoiceType, invoice.customerType, String(invoice.total)].join(" ").toLowerCase();
      return haystack.includes(term);
    });
  }, [invoices, search, activeTab]);

  function handleExportInvoicesCsv() {
    if (invoices.length === 0) {
      showToast("No hay facturas para exportar.", { variant: "info" });
      return;
    }
    const columns: CsvColumn<InvoiceDraft>[] = [
      { key: "invoiceNumber", label: "Número", format: (value, row) => value ?? row.id },
      { key: "id", label: "Identificador" },
      { key: "invoiceType", label: "Tipo", format: (value) => invoiceTypeLabel(String(value)) },
      { key: "customerType", label: "Cliente", format: (value) => customerTypeLabel(String(value)) },
      { key: "customerName", label: "Nombre del cliente", format: (value) => (value ? String(value) : "") },
      { key: "customerTaxId", label: "NIF" },
      { key: "status", label: "Estado", format: (_value, row) => invoiceStatusLabel(deriveInvoiceUiStatus(row)) },
      { key: "paymentStatus", label: "Cobro", format: (value) => (value ? String(value) : "") },
      { key: "total", label: "Total" },
      { key: "taxTotal", label: "Impuestos" },
      { key: "balanceDue", label: "Pendiente", format: (value) => (value === undefined || value === null ? "" : String(value)) },
      { key: "issuedAt", label: "Emitida", format: (value) => isoDate(value ? String(value) : null) ?? "" }
    ];
    exportToCsv(invoices, `facturas-${isoDate(new Date()) ?? "hoy"}`, columns);
    showToast(`Exportadas ${plural(invoices.length, "factura", "facturas")} a CSV.`, { variant: "success" });
  }

  const reservationOptions = useMemo(
    () => reservations.map((reservation) => ({ value: reservation.id, label: reservationResultLabel(reservation, (iso) => date(iso, "dayMonth")) })),
    [reservations]
  );
  const reservationSummary = searchResultsSummary({ shown: reservations.length, total: reservationsTotal, hasMore: Boolean(reservationsCursor), q: reservationSearch });

  const invoiceColumns = useMemo<CocoaTableColumn<InvoiceDraft>[]>(
    () => [
      {
        key: "invoiceNumber",
        label: "Número",
        render: (row) => (
          <span className="cocoa-cluster">
            <strong>{row.invoiceNumber ?? row.id}</strong>
            {row.issuerTaxIdPlaceholder ? (
              <CocoaBadge tone="warning" size="small" title="Emitida con NIF emisor provisional (modo de pruebas): configura el NIF real en Perfil del establecimiento">
                NIF provisional
              </CocoaBadge>
            ) : null}
          </span>
        )
      },
      { key: "customer", label: "Cliente", render: (row) => `${row.customerName ?? customerTypeLabel(row.customerType)}${row.customerTaxId ? ` · ${row.customerTaxId}` : ""}` },
      { key: "invoiceType", label: FIELD_LABELS.type, render: (row) => invoiceTypeLabel(row.invoiceType), hideOnNarrow: true },
      { key: "issuedAt", label: FIELD_LABELS.date, render: (row) => (row.issuedAt ? date(row.issuedAt) : "—"), hideOnNarrow: true },
      { key: "total", label: FIELD_LABELS.total, align: "right", render: (row) => <strong>{money(row.total, row.currencyCode)}</strong> },
      {
        key: "status",
        label: FIELD_LABELS.status,
        render: (row) => {
          const uiStatus = deriveInvoiceUiStatus(row);
          return (
            <span className="cocoa-cluster">
              <CocoaBadge tone={invoiceStatusTone(uiStatus)}>{invoiceStatusLabel(uiStatus)}</CocoaBadge>
              {uiStatus === "partial" ? <CocoaBadge tone="warning" size="small">{`pendiente ${money(row.balanceDue, row.currencyCode)}`}</CocoaBadge> : null}
            </span>
          );
        }
      }
    ],
    []
  );

  const folioPayments = folio?.payments ?? [];
  const refundable = useMemo(() => refundablePayments(folioPayments), [folioPayments]);
  const folioOpen = folio?.folio.status === "open";
  const selectedReservation = reservations.find((reservation) => reservation.id === selectedReservationId) ?? null;
  const detailUi = detail ? deriveInvoiceUiStatus(detail) : null;
  const detailListRow = detail ? invoices.find((invoice) => invoice.id === detail.id) : undefined;
  const detailMarkable = detail ? canMarkPaid(detailListRow ?? detail) : false;
  const detailBlock = detail ? issueBlocks[detail.id] : undefined;
  const detailLinesView = detail ? detailLines(detail) : null;
  // Tanda 6b (additive on GET /invoices/:id): the sociedad's fiscal address, the establishment block and the SII exclusion.
  const detailStructure = detail ? (detail.issuer as (typeof detail.issuer & IssuerStructure) | undefined) : undefined;
  const detailExclusion = detail ? verifactuExclusionText({ warnings: toArray<string>(detail.warnings), verifactuExclusion: detailStructure?.verifactuExclusion ?? null }) : null;
  const invoicesReady = !invoicesError && filteredInvoices.length > 0;
  const draftPreview = draftLines.length > 0 ? resolveDraftLines(draftLines, taxProfile) : null;

  return (
    <CocoaPage
      eyebrow={finance.eyebrow("Finanzas")}
      title="Facturación y cobros"
      subtitle={hosted ? undefined : "Folios, cobros y devoluciones de las reservas; borradores, emisión, envío y anulación de facturas con VeriFactu. El emisor es siempre la sociedad; el centro aporta la serie y el bloque «Establecimiento»."}
      actions={
        <>
          <FinanceScopeSelector scope={finance} />
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void refresh()} disabled={loading}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="plain" tone="neutral" size="small" onClick={handleExportInvoicesCsv} disabled={invoices.length === 0}>
            Exportar CSV
          </CocoaButton>
        </>
      }
      state={loading && invoices.length === 0 && reservations.length === 0 ? "loading" : loadError && invoices.length === 0 && reservations.length === 0 ? "error" : "ready"}
      skeleton={<BillingSkeleton />}
      error={{ title: STATUS_LABELS.loadError, message: loadError ?? undefined, onRetry: () => void refresh() }}
      commands={[
        { id: "billing-export-csv", label: "Exportar facturas a CSV", run: handleExportInvoicesCsv },
        { id: "billing-cobrar", label: "Registrar pago en el folio seleccionado", run: () => setPaymentOpen(true) }
      ]}
    >
      <CocoaScreenInstructionsCard
        title="Centro de facturación"
        description={String(BILLING_INSTRUCTIONS.whatIsThis)}
        steps={BILLING_INSTRUCTIONS.howToUse.map((step) => String(step))}
        tip={BILLING_INSTRUCTIONS.tips && BILLING_INSTRUCTIONS.tips.length > 0 ? String(BILLING_INSTRUCTIONS.tips[0]) : undefined}
        dismissible
        persistKey="billing"
      />

      <CocoaKpiStrip stagger aria-label="Indicadores de facturación">
        <CocoaKpi label="Borradores" value={kpis.counts.draft} caption={money(kpis.totals.draft)} polarity="neutral" />
        <CocoaKpi label="Emitidas" value={kpis.counts.issued} caption={kpis.pagePartial ? undefined : money(kpis.totals.issued)} polarity="neutral" />
        <CocoaKpi label="Pendientes de cobro" value={money(kpis.totals.pending)} caption={plural(kpis.counts.pending, "factura", "facturas")} polarity="negative-good" status={kpis.counts.pending > 0 ? "warning" : "ok"} />
        <CocoaKpi label="Pagadas" value={kpis.counts.paid} caption={kpis.pagePartial ? undefined : money(kpis.totals.paid)} polarity="positive-good" status="ok" />
        <CocoaKpi label="Anuladas y rectificadas" value={kpis.counts.cancelled} caption={money(kpis.totals.cancelled)} polarity="neutral" />
      </CocoaKpiStrip>
      {kpis.pagePartial ? (
        <CocoaCallout tone="info">
          Los importes de borradores y anuladas se calculan sobre las {invoices.length} facturas cargadas; los recuentos y el pendiente de cobro provienen del resumen del servidor.
        </CocoaCallout>
      ) : null}

      <CocoaGrid align="start" aria-label="Folio y borrador de factura">
        <CocoaSpan cols={7} min={480}>
          <div className="cocoa-stack" data-gap="3">
          <CocoaSection
            title="Folio de la reserva"
            meta={folio ? `${folio.folio.status === "open" ? "abierto" : "cerrado"} · ${folio.folio.currency}` : undefined}
            action={
              folio ? (
                <CocoaButton variant="plain" size="small" onClick={() => openTabPath(fillParams(FOLIO_URL, { id: folio.folio.id }))}>
                  Abrir folio
                </CocoaButton>
              ) : undefined
            }
            footer={
              folio ? (
                <div className="cocoa-row" data-gap="2">
                  <CocoaButton variant="filled" tone="accent" size="small" disabled={busy || !folioOpen} title="Cobrar en el folio (efectivo, datáfono, transferencia, enlace de pago)" onClick={() => setPaymentOpen(true)}>
                    Registrar pago
                  </CocoaButton>
                  <CocoaButton variant="bordered" tone="neutral" size="small" disabled={busy || refundable.length === 0} onClick={() => setRefundOpen(true)}>
                    Devolver
                  </CocoaButton>
                  <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => openTabPath(`${ROUTING_URL}?reserva=${encodeURIComponent(folio.folio.reservationId)}`)}>
                    Enrutamiento
                  </CocoaButton>
                </div>
              ) : undefined
            }
          >
            <CocoaFormRow columns={2} min={220}>
              <CocoaField label={FIELD_LABELS.reservation} help="Busca por código, titular o huésped principal.">
                <CocoaSearchInput value={reservationSearch} onChange={setReservationSearch} debounceMs={300} placeholder="RES-00012, García…" aria-label="Buscar reserva" />
              </CocoaField>
              <CocoaField
                label="Resultados"
                help={searchError ?? (searching ? "Buscando…" : reservationSummary)}
                hint={
                  reservationsCursor ? (
                    <CocoaButton variant="plain" size="small" loading={loadingMoreReservations} disabled={searching} onClick={() => void loadMoreReservations()}>
                      Más resultados
                    </CocoaButton>
                  ) : undefined
                }
              >
                <CocoaSelect value={selectedReservationId} onChange={handleReservationChange} options={reservationOptions} placeholder={searching ? "Buscando…" : "Elige una reserva"} disabled={reservations.length === 0} />
              </CocoaField>
            </CocoaFormRow>
            {folioError ? (
              <CocoaState kind="error" inline title={folioError} onRetry={() => (selectedReservationId ? void loadFolio(selectedReservationId) : undefined)} />
            ) : !folio ? (
              selectedReservationId ? (
                <CocoaState kind="loading" inline title="Cargando folio…" />
              ) : (
                <CocoaState kind="empty" inline illustration={reservationSearch.trim() ? "search" : "box"} title={reservationSearch.trim() ? "Sin reservas para esa búsqueda." : "Elige una reserva para ver su folio."} />
              )
            ) : (
              <>
                <div className="cocoa-row" data-gap="4" data-align="start">
                  <CocoaStat label="Saldo pendiente" value={money(folio.balanceDue, folio.folio.currency)} tone={folio.balanceDue > 0 ? "warning" : folio.balanceDue < 0 ? "info" : "success"} size="large" />
                  <CocoaStat label="Cargos" value={money(folio.chargesTotal, folio.folio.currency)} hint={plural(folio.lines.length, "línea", "líneas")} />
                  <CocoaStat label="Cobrado neto" value={money(folio.paymentsTotal, folio.folio.currency)} hint={(folio.refundsTotal ?? 0) > 0 ? `Devuelto ${money(folio.refundsTotal, folio.folio.currency)}` : plural(folioPayments.length, "movimiento", "movimientos")} />
                </div>
                <CocoaSegmentedControl
                  aria-label="Secciones del folio"
                  size="small"
                  value={folioView}
                  onChange={(next) => setFolioView(next as "charges" | "payments")}
                  options={[
                    { value: "charges", label: `Cargos (${folio.lines.length})` },
                    { value: "payments", label: `Cobros (${folioPayments.length})` }
                  ]}
                />
                {folioView === "charges" ? (
                  folio.lines.length === 0 ? (
                    <CocoaState kind="empty" inline title="Sin cargos registrados." message={folioOpen ? "Añade el primero con «Añadir cargo»." : undefined} />
                  ) : (
                    <ul className="c22-section__list">
                      {folio.lines.map((line) => (
                        <li key={line.id}>
                          <span className="cocoa-cluster">
                            <strong>{line.description}</strong>
                            <CocoaBadge tone="neutral" size="small">
                              {chargeTypeLabel(line.type)}
                            </CocoaBadge>
                            {line.taxCategory && line.taxCategory in TAX_CATEGORY_LABELS ? (
                              <CocoaBadge tone={line.taxCategory === "not_subject" ? "info" : "neutral"} size="small" uppercase={false}>
                                {TAX_CATEGORY_LABELS[line.taxCategory as TaxCategory]}
                              </CocoaBadge>
                            ) : null}
                            {line.quantity} × {money(line.unitPrice, folio.folio.currency)}
                          </span>
                          <strong>{money(line.total, folio.folio.currency)}</strong>
                        </li>
                      ))}
                    </ul>
                  )
                ) : folioPayments.length === 0 ? (
                  <CocoaState kind="empty" inline title="Sin cobros registrados." message={folioOpen ? "Registra el primero con «Registrar pago»." : undefined} />
                ) : (
                  <ul className="c22-section__list">
                    {folioPayments.map((payment) => {
                      const kind = paymentKind(payment);
                      return (
                        <li key={payment.id}>
                          <span className="cocoa-cluster">
                            <CocoaBadge tone={kind === "refund" ? "info" : "success"} size="small">
                              {paymentKindLabel(kind)}
                            </CocoaBadge>
                            {paymentMethodLabel(payment.method, payment.methodCode)}
                            {payment.pspReference ? ` · ${payment.pspReference}` : ""}
                          </span>
                          <strong>{kind === "refund" ? `−${money(payment.amount, payment.currency || folio.folio.currency)}` : money(payment.amount, payment.currency || folio.folio.currency)}</strong>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </CocoaSection>

          {folio && folioOpen ? (
            <CocoaFormSection
              title="Añadir cargo"
              description={`Se registra en el folio de la reserva ${selectedReservation?.code ?? ""} con su categoría fiscal; el tipo impositivo lo aporta el perfil fiscal de la propiedad al facturar.`.replace("  ", " ")}
              actions={
                <CocoaButton variant="filled" tone="accent" size="small" loading={postingCharge} disabled={postingCharge || busy} onClick={() => void handleAddCharge()}>
                  Añadir cargo
                </CocoaButton>
              }
            >
              {/* Corrector L3 (FUX-06): two rows — the fiscal category sits next to the type it depends on, never alone on a wrapped line. */}
              <div className="cocoa-stack" data-gap="3">
                <CocoaFormRow columns={3} min={150}>
                  <CocoaField label={FIELD_LABELS.type} required>
                    <CocoaSelect value={chargeForm.type} onChange={updateChargeType} options={MANUAL_CHARGE_OPTIONS} disabled={postingCharge} />
                  </CocoaField>
                  <CocoaField label="Concepto" required>
                    <CocoaInput value={chargeForm.description} onChange={(value) => setChargeForm((current) => ({ ...current, description: value }))} placeholder="Minibar 14/09" maxLength={500} disabled={postingCharge} autoComplete="off" />
                  </CocoaField>
                  <CocoaField
                    label="Categoría fiscal"
                    required
                    help={(() => {
                      const rate = rateForCategory(taxProfile, chargeForm.taxCategory);
                      return `${rate ? (rate.calificacion === "N1" ? "no sujeta" : `${rate.ratePercent} %`) : "sin tipo configurado"} · solo las compatibles con el tipo`;
                    })()}
                  >
                    {/* Corrector L3 (FC-4): only the categories the API accepts for this type (no «Habitación» as «No sujeto» / «Tasa turística»). */}
                    <CocoaSelect
                      value={chargeForm.taxCategory}
                      onChange={(value) => setChargeForm((current) => ({ ...current, taxCategory: value as TaxCategory }))}
                      options={taxCategoryOptionsForType(chargeForm.type, TAX_CATEGORY_OPTIONS).map((option) => ({ value: option.value, label: option.label }))}
                      disabled={postingCharge}
                    />
                  </CocoaField>
                </CocoaFormRow>
                <CocoaFormRow columns={2} min={150}>
                  <CocoaField label="Cantidad" required>
                    <CocoaInput value={chargeForm.quantity} onChange={(value) => setChargeForm((current) => ({ ...current, quantity: value }))} inputMode="decimal" disabled={postingCharge} />
                  </CocoaField>
                  <CocoaField label="Precio bruto" required help="Con impuestos incluidos, como las líneas del folio.">
                    <CocoaInput value={chargeForm.unitPrice} onChange={(value) => setChargeForm((current) => ({ ...current, unitPrice: value }))} inputMode="decimal" placeholder="12,00" disabled={postingCharge} />
                  </CocoaField>
                </CocoaFormRow>
              </div>
            </CocoaFormSection>
          ) : null}
          </div>
        </CocoaSpan>

        <CocoaSpan cols={5} min={320}>
          <CocoaFormSection
            title="Borrador de factura"
            description={taxProfile ? `Perfil fiscal: ${taxProfile.figure}${taxProfile.taxRegion ? ` · ${taxProfile.taxRegion}` : ""}.` : (taxProfileError ?? "Perfil fiscal no disponible.")}
            actions={
              <>
                <CocoaButton variant="plain" size="small" disabled={busy} onClick={() => setDraftLines((current) => [...current, newDraftLine(current.length === 0 ? "accommodation" : "general_services")])}>
                  Añadir línea
                </CocoaButton>
                <CocoaButton variant="filled" tone="accent" size="small" loading={busy} disabled={busy} onClick={() => void handleCreateDraft()}>
                  Crear borrador
                </CocoaButton>
              </>
            }
          >
            <CocoaFormRow columns={2} min={160}>
              <CocoaField label="Tipo de factura" required>
                <CocoaSelect
                  value={invoiceType}
                  onChange={(value) => setInvoiceType(value as InvoiceDraft["invoiceType"])}
                  options={[
                    { value: "full", label: "Completa (F1)" },
                    { value: "simplified", label: "Simplificada (F2)" }
                  ]}
                />
              </CocoaField>
              <CocoaField label="Tipo de cliente" required>
                <CocoaSelect
                  value={customerType}
                  onChange={(value) => setCustomerType(value as InvoiceDraft["customerType"])}
                  options={[
                    { value: "guest", label: "Huésped" },
                    { value: "company", label: "Empresa" },
                    { value: "agency", label: "Agencia" }
                  ]}
                />
              </CocoaField>
              <CocoaField label="NIF del cliente" hint={invoiceType === "simplified" ? "opcional" : undefined} help="Obligatorio en la factura completa.">
                <CocoaInput value={customerTaxId} onChange={setCustomerTaxId} placeholder="B12345674" maxLength={40} autoComplete="off" />
              </CocoaField>
              {draftLines.length === 0 ? (
                <CocoaField label="Total con impuestos" required help={folio ? `Cargos del folio: ${money(folio.chargesTotal, folio.folio.currency)}` : undefined}>
                  <CocoaInput value={draftTotal} onChange={setDraftTotal} inputMode="decimal" placeholder="272,00" />
                </CocoaField>
              ) : null}
              {draftLines.length === 0 ? (
                <CocoaField label="Cuota de impuestos" required>
                  <CocoaInput value={draftTaxTotal} onChange={setDraftTaxTotal} inputMode="decimal" placeholder="24,73" />
                </CocoaField>
              ) : null}
            </CocoaFormRow>
            {draftLines.length === 0 ? (
              <p>Sin líneas, el borrador se crea con una línea resumen a partir del total y la cuota. Añade líneas para elegir la categoría fiscal de cada concepto.</p>
            ) : (
              <div className="cocoa-stack" data-gap="3">
                {draftLines.map((line) => {
                  const rate = rateForCategory(taxProfile, line.taxCategory);
                  return (
                    <CocoaFormRow key={line.key} columns={4} min={120}>
                      <CocoaField label="Concepto" required>
                        <CocoaInput value={line.description} onChange={(value) => setDraftLines((current) => current.map((row) => (row.key === line.key ? { ...row, description: value } : row)))} placeholder="Alojamiento 2 noches" />
                      </CocoaField>
                      <CocoaField label="Cantidad" required>
                        <CocoaInput value={line.quantity} onChange={(value) => setDraftLines((current) => current.map((row) => (row.key === line.key ? { ...row, quantity: value } : row)))} inputMode="decimal" />
                      </CocoaField>
                      <CocoaField label="Precio bruto" required>
                        <CocoaInput value={line.unitPrice} onChange={(value) => setDraftLines((current) => current.map((row) => (row.key === line.key ? { ...row, unitPrice: value } : row)))} inputMode="decimal" />
                      </CocoaField>
                      <CocoaField
                        label="Categoría fiscal"
                        help={rate ? (rate.calificacion === "N1" ? "no sujeta" : `${rate.ratePercent} %`) : "sin tipo configurado"}
                        hint={
                          <CocoaButton variant="plain" tone="destructive" size="small" onClick={() => setDraftLines((current) => current.filter((row) => row.key !== line.key))}>
                            {ACTIONS.remove}
                          </CocoaButton>
                        }
                      >
                        <CocoaSelect value={line.taxCategory} onChange={(value) => setDraftLines((current) => current.map((row) => (row.key === line.key ? { ...row, taxCategory: value as TaxCategory } : row)))} options={TAX_CATEGORY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} />
                      </CocoaField>
                    </CocoaFormRow>
                  );
                })}
                {draftPreview ? (
                  <CocoaCallout tone={draftPreview.missing.length > 0 ? "warning" : "neutral"}>
                    Total {money(draftPreview.total)} · cuota {money(draftPreview.taxTotal)}
                    {draftPreview.missing.length > 0 ? ` · sin tipo para ${draftPreview.missing.map((category) => TAX_CATEGORY_LABELS[category].toLowerCase()).join(", ")}` : ""}
                  </CocoaCallout>
                ) : null}
              </div>
            )}
            <div className="cocoa-row" data-gap="2">
              <CocoaButton variant="plain" size="small" onClick={() => navigateTo("BillingSettings")}>
                Series de facturación
              </CocoaButton>
              <CocoaButton variant="plain" size="small" onClick={() => navigateTo("PropertyTaxesScreen")}>
                Impuestos de la propiedad
              </CocoaButton>
            </div>
          </CocoaFormSection>
        </CocoaSpan>
      </CocoaGrid>

      <CocoaToolbar
        variant="content"
        aria-label="Filtros de facturas"
        leftSlot={<CocoaSearchInput value={search} onChange={setSearch} debounceMs={200} placeholder="Número, cliente, NIF…" aria-label="Buscar facturas" />}
        rightSlot={
          <CocoaSegmentedControl aria-label="Estado de las facturas" size="small" value={activeTab} onChange={(next) => setActiveTab(next as InvoiceTab)} options={TAB_DEFS.map((tab) => ({ value: tab.key, label: `${tab.label} (${kpis.counts[tab.key]})` }))} />
        }
      />

      <CocoaSection
        title="Facturas"
        meta={plural(invoices.length, "factura cargada", "facturas cargadas")}
        padding={invoicesReady ? "none" : "md"}
        style={{ overflow: "clip" }}
        footer={
          invoicesReady ? (
            <>
              <span>
                {filteredInvoices.length} de {invoices.length}
                {invoiceSummary && invoiceSummary.count > invoices.length ? ` (${invoiceSummary.count} en total)` : ""}
              </span>
              {invoicesNextCursor ? (
                <CocoaButton variant="bordered" tone="neutral" size="small" loading={loadingMoreInvoices} onClick={() => void loadMoreInvoices()}>
                  Cargar más
                </CocoaButton>
              ) : null}
            </>
          ) : undefined
        }
      >
        {invoicesError ? (
          <CocoaState kind="error" title="No se pudieron cargar las facturas" message={invoicesError} onRetry={() => void loadInvoices().catch(() => undefined)} />
        ) : loading && invoices.length === 0 ? (
          <CocoaTable columns={invoiceColumns} rows={[]} loading aria-label="Facturas" />
        ) : filteredInvoices.length === 0 ? (
          <CocoaState kind="empty" illustration={search ? "search" : "box"} title={search ? "Sin resultados" : "No hay facturas en este estado"} message={search ? "Ninguna factura coincide con la búsqueda." : "Cambia de pestaña o crea un borrador desde el formulario."} />
        ) : (
          <CocoaTable
            columns={invoiceColumns}
            rows={filteredInvoices}
            rowKey="id"
            selectedKey={detail?.id}
            onSelect={(row) => void openDetail(row.id)}
            caption="Facturas de la propiedad"
            aria-label="Facturas de la propiedad"
            rowActions={(row) => (
              <span className="cocoa-cluster">
                <CocoaButton
                  variant="plain"
                  size="small"
                  onClick={(event) => {
                    event.stopPropagation();
                    void openDetail(row.id);
                  }}
                >
                  {ACTIONS.viewDetail}
                </CocoaButton>
                {canMarkPaid(row) ? (
                  <CocoaButton
                    variant="tinted"
                    tone="accent"
                    size="small"
                    onClick={(event) => {
                      event.stopPropagation();
                      openMarkPaid(row);
                    }}
                  >
                    Marcar pagada
                  </CocoaButton>
                ) : null}
              </span>
            )}
          />
        )}
      </CocoaSection>

      <CocoaFormSection
        title="Logo y avisos legales de la factura"
        description="Se imprimen en todas las facturas de esta propiedad: datos registrales, aviso de privacidad, condiciones de pago."
        actions={
          <CocoaButton variant="filled" tone="accent" size="small" loading={savingBranding} disabled={savingBranding} onClick={() => void handleSaveBranding()}>
            {ACTIONS.save}
          </CocoaButton>
        }
      >
        <CocoaFormRow columns={2}>
          <CocoaField label="Dirección del logo" help="Una URL https o una imagen incrustada.">
            <CocoaInput value={logoUrl} onChange={setLogoUrl} placeholder="https://…/logo.png" autoComplete="off" />
          </CocoaField>
          <CocoaField label="Avisos legales" fullWidth>
            <CocoaInput value={legalFooter} onChange={setLegalFooter} multiline rows={4} placeholder={"Inscrita en el Registro Mercantil de…\nTratamos sus datos conforme al RGPD…\nForma de pago: …"} />
          </CocoaField>
        </CocoaFormRow>
        {logoUrl.trim() ? <img src={logoUrl} alt="Logo de la propiedad en la factura" style={{ maxHeight: 56, maxWidth: 220 }} /> : null}
      </CocoaFormSection>

      <CocoaLiveRegion message={status} />

      {folio ? (
        <>
          <PaymentDialog
            open={paymentOpen}
            onClose={() => setPaymentOpen(false)}
            folioId={folio.folio.id}
            propertyId={propertyId}
            currency={folio.folio.currency}
            balanceDue={folio.balanceDue}
            subject={selectedReservation ? `Reserva ${selectedReservation.code}` : undefined}
            onCaptured={() => {
              void loadFolio(folio.folio.reservationId);
              void loadInvoices().catch(() => undefined);
            }}
          />
          <RefundDialog
            open={refundOpen}
            onClose={() => setRefundOpen(false)}
            payments={folioPayments}
            currency={folio.folio.currency}
            onRefunded={() => {
              void loadFolio(folio.folio.reservationId);
              void loadInvoices().catch(() => undefined);
            }}
          />
        </>
      ) : null}

      <CocoaDrawer
        open={detail !== null || detailLoading}
        onClose={() => setDetail(null)}
        title={detail ? `Factura ${detail.invoiceNumber ?? detail.id}` : "Factura"}
        subtitle={detail ? `${invoiceTypeLabel(detail.invoiceType)} · ${detail.customerName ?? customerTypeLabel(detail.customerType)}${detail.customerTaxId ? ` · ${detail.customerTaxId}` : ""}` : undefined}
        side="right"
        size="lg"
        focusKey={detail?.id ?? ""}
        footer={
          detail ? (
            <>
              <CocoaButton variant="bordered" tone="neutral" onClick={() => setDetail(null)}>
                {ACTIONS.close}
              </CocoaButton>
              {detail.status === "draft" ? (
                <CocoaButton variant="filled" tone="accent" disabled={busy || Boolean(detailBlock)} title={detailBlock?.message} onClick={() => setIssueConfirm(detail)}>
                  Emitir factura
                </CocoaButton>
              ) : (
                <CocoaButton variant="filled" tone="accent" loading={downloading} onClick={() => void handleDownloadPdf(detail)}>
                  Descargar PDF
                </CocoaButton>
              )}
            </>
          ) : undefined
        }
      >
        {detailLoading && !detail ? (
          <CocoaSkeleton.Grid rows={[[12]]} height={240} />
        ) : detail && detailUi && detailLinesView ? (
          <div className="cocoa-stack" data-gap="4">
            <div className="cocoa-row" data-gap="2">
              <CocoaBadge tone={invoiceStatusTone(detailUi)}>{invoiceStatusLabel(detailUi)}</CocoaBadge>
              {detail.rectificationType ? <CocoaBadge tone="info">{detail.rectificationType === "S" ? "Rectificativa por sustitución" : "Rectificativa por diferencias"}</CocoaBadge> : null}
              {detailLinesView.frozen ? <CocoaBadge tone="success">Líneas congeladas al emitir</CocoaBadge> : null}
              {detail.issuer?.taxIdPlaceholder || detail.issuerTaxIdPlaceholder ? <CocoaBadge tone="warning">NIF emisor provisional</CocoaBadge> : null}
              {detailExclusion ? (
                <CocoaBadge tone="warning" uppercase={false} title={detailExclusion}>
                  VeriFactu no aplica (SII)
                </CocoaBadge>
              ) : null}
            </div>

            <div className="cocoa-row" data-gap="2">
              {detail.status === "issued" ? (
                <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => openEmail(detail)}>
                  Enviar por correo
                </CocoaButton>
              ) : null}
              {detailMarkable ? (
                <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => openMarkPaid(detailListRow ?? detail)}>
                  Marcar pagada
                </CocoaButton>
              ) : null}
              {detail.status === "issued" ? (
                <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => openRectify(detail)}>
                  Rectificar
                </CocoaButton>
              ) : null}
              {detail.status === "issued" ? (
                <CocoaButton variant="bordered" tone="destructive" size="small" onClick={() => openCancel(detail)}>
                  Anular
                </CocoaButton>
              ) : null}
            </div>

            {emailNotice ? (
              <CocoaCallout tone={emailNotice.tone} title={emailNotice.title} role="status">
                {emailNotice.message}
              </CocoaCallout>
            ) : null}
            {cancelNotice ? (
              <CocoaCallout tone="info" title="Cobros tras la anulación" role="status">
                {plural(cancelNotice.unlinkedPaymentIds.length, "cobro desvinculado", "cobros desvinculados")} · {plural(cancelNotice.refundedPaymentIds.length, "devolución registrada", "devoluciones registradas")}
                {cancelNotice.folioBalanceDue !== null ? ` · saldo del folio ${money(cancelNotice.folioBalanceDue, detail.currencyCode)}` : ""}
              </CocoaCallout>
            ) : null}
            {detailBlock ? (
              <CocoaCallout
                tone="danger"
                title="Emisión bloqueada: impuestos sin configurar"
                actions={
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("PropertyTaxesScreen")}>
                    Configurar impuestos
                  </CocoaButton>
                }
              >
                {detailBlock.message}
                {detailBlock.lines.length ? ` Líneas: ${detailBlock.lines.join("; ")}.` : ""}
                {detailBlock.hint ? ` ${detailBlock.hint}` : ""}
              </CocoaCallout>
            ) : null}
            {toArray<string>(detail.warnings).length > 0 ? (
              <CocoaCallout tone="warning" title="Avisos fiscales">
                {toArray<string>(detail.warnings).join(" · ")}
              </CocoaCallout>
            ) : null}

            <CocoaFormRow columns={2}>
              <CocoaStat label="Sociedad emisora" value={detail.issuer?.legalName ?? detail.issuer?.propertyName ?? "—"} hint={[detail.issuer?.taxId ? `NIF ${detail.issuer.taxId}` : null, detailStructure?.fiscalAddress ?? null].filter(Boolean).join(" · ") || undefined} tabular={false} />
              {detailStructure?.establishment ? <CocoaStat label="Establecimiento" value={`${detailStructure.establishment.tradeName}${detailStructure.establishment.code ? ` (${detailStructure.establishment.code})` : ""}`} hint={detailStructure.establishment.addressLine ?? undefined} tabular={false} /> : null}
              <CocoaStat label="Cliente" value={detail.customerName ?? customerTypeLabel(detail.customerType)} hint={detail.customerTaxId ? `NIF ${detail.customerTaxId}` : customerTypeLabel(detail.customerType)} tabular={false} />
              <CocoaStat label="Emitida" value={detail.issuedAt ? date(detail.issuedAt, "medium") : "—"} tabular={false} />
              <CocoaStat label={FIELD_LABELS.total} value={money(detail.total, detail.currencyCode)} hint={`Impuestos ${money(detail.taxTotal, detail.currencyCode)}`} />
            </CocoaFormRow>

            <CocoaSection title="Líneas" meta={detailLinesView.frozen ? "documento congelado" : plural(detailLinesView.lines.length, "línea", "líneas")} padding={detailLinesView.lines.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
              {detailLinesView.lines.length === 0 ? (
                <CocoaState kind="empty" inline title="La factura no tiene líneas." />
              ) : (
                <CocoaTable columns={DETAIL_COLUMNS} rows={detailLinesView.lines} rowKey="key" caption="Líneas de la factura" aria-label="Líneas de la factura" density="compact" />
              )}
            </CocoaSection>

            <CocoaSection title="Desglose de impuestos">
              <ul className="c22-section__list">
                {toArray<InvoiceTaxBreakdownGroup>(detail.taxBreakdown).map((group, index) => (
                  <li key={`${group.figure}-${group.calificacion}-${group.ratePercent}-${index}`}>
                    <span>
                      {group.figure} {group.calificacion === "N1" ? "no sujeta" : `${group.ratePercent} %`} · base {money(group.base, detail.currencyCode)}
                    </span>
                    <strong>{money(group.quota, detail.currencyCode)}</strong>
                  </li>
                ))}
                <li>
                  <span>Total impuestos</span>
                  <strong>{money(detail.taxTotal, detail.currencyCode)}</strong>
                </li>
                <li>
                  <span>Total factura</span>
                  <strong>{money(detail.total, detail.currencyCode)}</strong>
                </li>
              </ul>
            </CocoaSection>

            {detail.verifactuHash ? <CocoaStat label="Huella VeriFactu" value={detail.verifactuHash} tabular={false} /> : null}
            {detail.issuer?.legalFooter ? <p>{detail.issuer.legalFooter}</p> : null}
          </div>
        ) : null}
      </CocoaDrawer>

      <CocoaDialog
        open={issueConfirm !== null}
        onClose={() => setIssueConfirm(null)}
        title={issueConfirm ? `¿Emitir la factura ${issueConfirm.invoiceNumber ?? ""}?`.replace("  ", " ") : "¿Emitir la factura?"}
        description="La emisión asigna número de serie, congela las líneas del folio, calcula la huella VeriFactu y contabiliza el asiento. No se puede deshacer: después solo caben rectificativa o anulación."
        confirmLabel={busy ? "Emitiendo…" : "Emitir factura"}
        cancelLabel={ACTIONS.cancel}
        busy={busy}
        onConfirm={() => (issueConfirm ? handleIssue(issueConfirm) : undefined)}
      />

      <CocoaDialog
        open={markPaid !== null}
        onClose={() => setMarkPaid(null)}
        title={markPaid ? `Marcar pagada ${markPaid.invoice.invoiceNumber ?? ""}`.trim() : "Marcar pagada"}
        description="Registra un cobro ya recibido sobre el folio de la factura. Método y referencia son obligatorios."
        size="md"
        confirmLabel={busy ? "Registrando…" : "Marcar pagada"}
        cancelLabel={ACTIONS.cancel}
        busy={busy}
        onConfirm={handleMarkPaid}
        initialFocus={() => document.getElementById("mark-paid-reference")}
      >
        {markPaid ? (
          <div className="cocoa-stack" data-gap="3">
            <CocoaFormRow columns={2} min={200}>
              <CocoaField label="Método" required>
                <CocoaSelect value={markPaid.method} onChange={(value) => setMarkPaid({ ...markPaid, method: value as PaymentMethodCode })} options={paymentMethodOptions({ includePsp: false }).map((option) => ({ value: option.value, label: option.label }))} />
              </CocoaField>
              <CocoaField label="Importe" help={`Pendiente: ${money(markPaid.invoice.balanceDue ?? markPaid.invoice.total, markPaid.invoice.currencyCode)}`}>
                <CocoaInput value={markPaid.amount} onChange={(value) => setMarkPaid({ ...markPaid, amount: value })} inputMode="decimal" />
              </CocoaField>
            </CocoaFormRow>
            <CocoaField label="Referencia" required help="Número de operación del datáfono, referencia de la transferencia o del recibo.">
              <CocoaInput id="mark-paid-reference" value={markPaid.reference} onChange={(value) => setMarkPaid({ ...markPaid, reference: value })} placeholder="Operación 004512" maxLength={120} autoComplete="off" />
            </CocoaField>
          </div>
        ) : null}
      </CocoaDialog>

      <CocoaDialog
        open={emailForm !== null}
        onClose={() => setEmailForm(null)}
        title="Enviar factura por correo"
        description="El PDF con el QR VeriFactu va adjunto. Sin proveedor de correo configurado el envío se marca como simulado."
        size="md"
        confirmLabel={busy ? STATUS_LABELS.sending : ACTIONS.send}
        cancelLabel={ACTIONS.cancel}
        busy={busy}
        onConfirm={handleSendEmail}
        initialFocus={() => document.getElementById("invoice-email-to")}
      >
        {emailForm ? (
          <div className="cocoa-stack" data-gap="3">
            <CocoaField label="Destinatario" required>
              <CocoaInput id="invoice-email-to" type="email" inputMode="email" value={emailForm.to} onChange={(value) => setEmailForm({ ...emailForm, to: value })} placeholder="cliente@dominio.com" autoComplete="off" />
            </CocoaField>
            <CocoaField label="Asunto">
              <CocoaInput value={emailForm.subject} onChange={(value) => setEmailForm({ ...emailForm, subject: value })} maxLength={200} />
            </CocoaField>
            <CocoaField label="Mensaje">
              <CocoaInput value={emailForm.body} onChange={(value) => setEmailForm({ ...emailForm, body: value })} multiline rows={5} maxLength={2000} />
            </CocoaField>
          </div>
        ) : null}
      </CocoaDialog>

      <CocoaDialog
        open={cancelForm !== null}
        onClose={() => setCancelForm(null)}
        tone="destructive"
        title={cancelForm ? `¿Anular la factura ${cancelForm.invoice.invoiceNumber ?? ""}?`.replace("  ", " ") : "¿Anular la factura?"}
        description="La anulación entra en la cadena VeriFactu y contabiliza el asiento inverso. Los cobros vinculados se desvinculan y quedan en el folio; también pueden devolverse."
        size="md"
        confirmLabel={busy ? "Anulando…" : cancelAuthorization ? "Anular con autorización" : "Anular factura"}
        cancelLabel={ACTIONS.cancel}
        busy={busy}
        onConfirm={() => void handleCancel(cancelAuthorization?.id)}
      >
        {cancelForm ? (
          <div className="cocoa-stack" data-gap="3">
            <CocoaField label="Motivo" hint="opcional">
              <CocoaInput value={cancelForm.reason} onChange={(value) => setCancelForm({ ...cancelForm, reason: value })} placeholder="Error en los datos del cliente" maxLength={500} autoComplete="off" />
            </CocoaField>
            <CocoaField label="Devolver también los cobros vinculados" inline help="Crea una devolución por cada cobro capturado de la factura.">
              <CocoaSwitch checked={cancelForm.refundPayments} onChange={(value) => setCancelForm({ ...cancelForm, refundPayments: value })} size="small" />
            </CocoaField>
            {cancelApproval && !cancelAuthorization ? (
              <CocoaCallout
                tone="warning"
                title={cancelApproval.code === "RBAC_SOD_CONFLICT" ? "Separación de funciones" : "Esta anulación supera tu tramo"}
                role="alert"
                actions={
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setCancelPinOpen(true)} disabled={busy}>
                    Autorizar con PIN de supervisor
                  </CocoaButton>
                }
              >
                {cancelApproval.message}
                {cancelApproval.tier ? ` Tramo: ${cancelApproval.tier}.` : ""}
                {" "}
                Un supervisor presente puede autorizar solo esta anulación con su PIN; si no, quien tenga la clave de aprobación de anulaciones (jefatura o dirección) debe anularla desde su sesión: esta pantalla todavía no crea solicitudes de anulación para Hoy › Pendientes de aprobación. Si quien emitió la factura es quien la anula, la regla se mantiene y debe anularla otra persona.
              </CocoaCallout>
            ) : null}
            {cancelAuthorization ? (
              <CocoaCallout tone="success" title="Autorización de supervisor concedida" role="status">
                Válida hasta {date(cancelAuthorization.expiresAt, "medium")} y solo para esta factura. Pulsa «Anular con autorización».
              </CocoaCallout>
            ) : null}
          </div>
        ) : null}
      </CocoaDialog>

      {cancelForm ? (
        <SupervisorPinDialog
          open={cancelPinOpen}
          onClose={() => setCancelPinOpen(false)}
          permissionKey="invoice.cancel_approve"
          entityType="invoice"
          entityId={cancelForm.invoice.id}
          propertyId={propertyId}
          amount={Math.abs(Number(cancelForm.invoice.total) || 0).toFixed(2)}
          actionLabel={`Anular la factura ${cancelForm.invoice.invoiceNumber ?? cancelForm.invoice.id}`}
          onAuthorized={(granted) => {
            setCancelAuthorization(granted);
            setCancelPinOpen(false);
            setCancelApproval(null);
            showToast("Autorización de supervisor concedida: confirma la anulación", { variant: "success" });
          }}
        />
      ) : null}
    </CocoaPage>
  );
}

export default BillingCenterScreen;

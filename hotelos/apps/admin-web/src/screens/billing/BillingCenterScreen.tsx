import { getActivePropertyId } from "../../services/activeProperty";
import { useEffect, useMemo, useState } from "react";
import {
  createInvoiceDraft,
  fetchInvoice,
  fetchInvoiceBranding,
  fetchInvoices,
  fetchReservationFolio,
  fetchReservations,
  issueInvoice,
  markInvoicePaid,
  saveInvoiceBranding,
  sendInvoiceEmail,
  type AdminReservation,
  type CreateInvoiceDraftLine,
  type FolioBalance,
  type InvoiceDraft,
  type InvoiceFull,
  type InvoiceListSummary,
  type InvoiceTaxBreakdownGroup
} from "../../services/pmsCommerceApi";
import { ApiError } from "../../services/api-client";
import {
  TAX_CATEGORY_LABELS,
  TAX_CATEGORY_OPTIONS,
  buildTaxCodeClient,
  fetchPropertyTaxes,
  isSuspiciousTaxLine,
  rateForCategory,
  type PropertyTaxProfile,
  type TaxCategory
} from "../../services/taxesApi";
import { toArray } from "../../utils/toArray";
import { navigateTo } from "../../lib/navigate";
import { useToast } from "../../components/Toast";
import { exportToCsv, type CsvColumn } from "../../lib/csv";
import { logBreadcrumb } from "../../lib/breadcrumb";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { CocoaSearchInput } from "../../components/cocoa/CocoaSearchInput";
import { CocoaSegmentedControl } from "../../components/cocoa/CocoaSegmentedControl";
import { CocoaCard } from "../../components/cocoa/CocoaCard";
import { CocoaTable, type CocoaTableColumn } from "../../components/cocoa/CocoaTable";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaInput } from "../../components/cocoa/CocoaInput";
import { CocoaSelect } from "../../components/cocoa/CocoaSelect";
import { CocoaScreenInstructionsCard } from "../../components/cocoa-guidance/CocoaScreenInstructionsCard";
import { BILLING_INSTRUCTIONS } from "../../content/screen-instructions/billing";
// TODO(cocoa): need CocoaStatusBadge — fallback to Aurora v2 StatusBadge.
import { StatusBadge } from "../../components/v2/StatusBadge";
import {
  statusBadgeLabel,
  statusBadgeVariant,
  type InvoiceUiStatus
} from "./invoiceStatus";

const PROPERTY_ID = getActivePropertyId();

// Spanish money formatting — "272,00 €", never the Anglo "272.00 EUR".
// This is a VeriFactu product; the numbers must read as Spanish invoices.
function fmtMoney(value: number | string | null | undefined, currency = "EUR"): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: currency || "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(n);
}
const fmtEur = (value: number | string | null | undefined): string => fmtMoney(value, "EUR");

type InvoiceTab = "draft" | "issued" | "pending" | "paid" | "cancelled";

const TAB_DEFS: Array<{ key: InvoiceTab; label: string }> = [
  { key: "draft", label: "Borradores" },
  { key: "issued", label: "Emitidas" },
  { key: "pending", label: "Pendientes" },
  { key: "paid", label: "Pagadas" },
  { key: "cancelled", label: "Anuladas" }
];

// Rows per page for the invoice listing (API caps at 500); "Cargar más" walks
// the cursor. The enveloped response also carries the aggregate `summary`.
const INVOICE_PAGE_SIZE = 200;
// Reservations shown in the folio selector (most recent arrivals first).
const RESERVATION_PAGE_SIZE = 200;

// Tanda 2 · QC-03: the "paid" state comes ONLY from the API (`paymentStatus`,
// derived from captured payments linked to the invoice). The previous
// sessionStorage mark — which was even set when the backend call failed — is
// gone: an invoice reads as paid if and only if the server says so.
function isInvoicePaid(invoice: Pick<InvoiceDraft, "status" | "paymentStatus">): boolean {
  return invoice.status === "issued" && invoice.paymentStatus === "paid";
}

function canMarkPaid(invoice: Pick<InvoiceDraft, "status" | "paymentStatus">): boolean {
  return invoice.status === "issued" && invoice.paymentStatus !== "paid" && invoice.paymentStatus !== "not_applicable";
}

function deriveInvoiceUiStatus(invoice: InvoiceDraft): InvoiceUiStatus {
  if (invoice.status === "cancelled") return "cancelled";
  if (invoice.status === "rectified") return "rectified";
  if (invoice.status === "issued") return isInvoicePaid(invoice) ? "paid" : "issued";
  return "draft";
}

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
    const quantity = Number(line.quantity.replace(",", "."));
    const unitPrice = Number(line.unitPrice.replace(",", "."));
    if (!line.description.trim() || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice)) continue;
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
  const lines = toArray<unknown>(details.lines ?? details.blocking).map((entry) =>
    typeof entry === "string" ? entry : entry && typeof entry === "object" ? JSON.stringify(entry) : String(entry)
  );
  return { code: "TAX_NOT_CONFIGURED", message: error.message, lines, hint: typeof details.hint === "string" ? details.hint : undefined };
}

export function BillingCenterScreen() {
  const { showToast } = useToast();
  const [reservations, setReservations] = useState<AdminReservation[]>([]);
  const [selectedReservationId, setSelectedReservationId] = useState("res_18392");
  const [folio, setFolio] = useState<FolioBalance | null>(null);
  const [invoices, setInvoices] = useState<InvoiceDraft[]>([]);
  const [invoiceSummary, setInvoiceSummary] = useState<InvoiceListSummary | null>(null);
  const [invoicesNextCursor, setInvoicesNextCursor] = useState<string | null>(null);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [loadingMoreInvoices, setLoadingMoreInvoices] = useState(false);
  const [draftTotal, setDraftTotal] = useState("272");
  const [draftTaxTotal, setDraftTaxTotal] = useState("24.73");
  const [draftLines, setDraftLines] = useState<DraftLineInput[]>([]);
  const [taxProfile, setTaxProfile] = useState<PropertyTaxProfile | null>(null);
  const [taxProfileError, setTaxProfileError] = useState<string | null>(null);
  // Invoices whose issue was refused with 409 TAX_NOT_CONFIGURED: "Emitir" stays
  // disabled (with the reason as tooltip) until the tax profile is fixed.
  const [issueBlocks, setIssueBlocks] = useState<Record<string, IssueBlock>>({});
  const [customerType, setCustomerType] = useState<InvoiceDraft["customerType"]>("guest");
  const [invoiceType, setInvoiceType] = useState<InvoiceDraft["invoiceType"]>("full");
  const [customerTaxId, setCustomerTaxId] = useState("");
  const [status, setStatus] = useState("Centro de facturación listo.");
  const [logoUrl, setLogoUrl] = useState("");
  const [legalFooter, setLegalFooter] = useState("");
  const [brandingStatus, setBrandingStatus] = useState("");
  const [preview, setPreview] = useState<InvoiceFull | null>(null);
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<InvoiceTab>("draft");
  const [folioTab, setFolioTab] = useState<"charges" | "payments" | "routing" | "notes">("charges");
  const [folioNote, setFolioNote] = useState("");
  const [emailDraft, setEmailDraft] = useState<{ invoiceId: string; to: string; subject: string; body: string } | null>(null);

  // Enveloped listing: items carry paymentStatus/balanceDue, `summary` feeds the
  // KPIs across ALL invoices (not just the loaded page).
  async function loadInvoices() {
    setInvoicesError(null);
    try {
      const page = await fetchInvoices(PROPERTY_ID, { limit: INVOICE_PAGE_SIZE });
      setInvoices(page.items);
      setInvoiceSummary(page.summary ?? null);
      setInvoicesNextCursor(page.nextCursor);
    } catch (error) {
      setInvoicesError(error instanceof Error ? error.message : "No se pudieron cargar las facturas.");
      throw error;
    }
  }

  async function loadMoreInvoices() {
    if (!invoicesNextCursor || loadingMoreInvoices) return;
    setLoadingMoreInvoices(true);
    try {
      const page = await fetchInvoices(PROPERTY_ID, { limit: INVOICE_PAGE_SIZE, cursor: invoicesNextCursor });
      setInvoices((current) => {
        const seen = new Set(current.map((inv) => inv.id));
        return [...current, ...page.items.filter((inv) => !seen.has(inv.id))];
      });
      if (page.summary) setInvoiceSummary(page.summary);
      setInvoicesNextCursor(page.nextCursor);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "No se pudieron cargar más facturas.", { variant: "error" });
    } finally {
      setLoadingMoreInvoices(false);
    }
  }

  async function refresh() {
    const [reservationPage] = await Promise.all([
      fetchReservations(PROPERTY_ID, { limit: RESERVATION_PAGE_SIZE }),
      loadInvoices()
    ]);
    const reservationResponse = reservationPage.items;
    setReservations(reservationResponse);
    void fetchInvoiceBranding(PROPERTY_ID)
      .then((b) => {
        setLogoUrl(b.logoUrl ?? "");
        setLegalFooter(b.legalFooter ?? "");
      })
      .catch(() => undefined);
    void fetchPropertyTaxes(PROPERTY_ID)
      .then((profile) => {
        setTaxProfile(profile);
        setTaxProfileError(null);
      })
      .catch((error: unknown) => {
        setTaxProfile(null);
        setTaxProfileError(error instanceof Error ? error.message : "Perfil fiscal no disponible.");
      });
    const selected = reservationResponse.find((reservation) => reservation.id === selectedReservationId) ?? reservationResponse[0];
    if (selected) {
      setSelectedReservationId(selected.id);
      const folioResponse = await fetchReservationFolio(selected.id);
      setFolio(folioResponse);
      setDraftTotal(String(folioResponse.chargesTotal));
    }
  }

  useEffect(() => {
    void refresh().catch(() => setStatus("No se pudieron cargar los datos de facturación. Verifica el servidor de API."));
  }, []);

  async function handleReservationChange(reservationId: string) {
    setSelectedReservationId(reservationId);
    setFolio(await fetchReservationFolio(reservationId));
  }

  async function handleCreateDraft() {
    setStatus("Creando borrador de factura...");
    // PII-safe: no incluimos customerTaxId. Solo el tipo y los totales para
    // diagnosticar errores de borrador (p. ej. importe inválido).
    logBreadcrumb("invoice.draft", "mutation", {
      invoiceType,
      customerType,
      total: Number(draftTotal),
      taxTotal: Number(draftTaxTotal)
    });
    try {
      const resolvedDraft = resolveDraftLines(draftLines, taxProfile);
      if (draftLines.length > 0 && resolvedDraft.missing.length > 0) {
        const message = `Sin tipo impositivo para ${resolvedDraft.missing.map((category) => TAX_CATEGORY_LABELS[category].toLowerCase()).join(", ")}: configura Impuestos de la propiedad antes de crear el borrador.`;
        setStatus(message);
        showToast(message, { variant: "error" });
        return;
      }
      if (draftLines.length > 0 && resolvedDraft.lines.length === 0) {
        showToast("Completa la descripción, cantidad y precio de al menos una línea.", { variant: "error" });
        return;
      }
      const useLines = resolvedDraft.lines.length > 0;
      const draft = await createInvoiceDraft({
        propertyId: PROPERTY_ID,
        invoiceType,
        customerType,
        customerTaxId: customerTaxId || undefined,
        total: useLines ? resolvedDraft.total : Number(draftTotal),
        taxTotal: useLines ? resolvedDraft.taxTotal : Number(draftTaxTotal),
        ...(useLines ? { lines: resolvedDraft.lines } : {})
      });
      setInvoices((current) => [draft, ...current]);
      setStatus(`Borrador ${draft.id} creado. La emisión requiere permiso invoice.issue y confirmación.`);
      showToast(`Borrador ${draft.id} creado`, { variant: "success" });
      if (useLines) setDraftLines([]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo crear el borrador.";
      setStatus(message);
      showToast(message, { variant: "error" });
    }
  }

  async function handleIssue(invoiceId: string) {
    setStatus("Emitiendo factura...");
    logBreadcrumb("invoice.issue", "mutation", { invoiceId });
    try {
      const issued = await issueInvoice(invoiceId);
      setInvoices((current) => current.map((invoice) => (invoice.id === issued.id ? { ...invoice, ...issued } : invoice)));
      // The issue response has no payment enrichment: refetch the listing.
      void loadInvoices().catch(() => undefined);
      setStatus(`Factura ${issued.invoiceNumber ?? issued.id} emitida con huella VeriFactu.`);
      showToast(`Factura ${issued.invoiceNumber ?? issued.id} emitida`, { variant: "success" });
    } catch (error) {
      const block = readIssueBlock(error);
      if (block) {
        setIssueBlocks((current) => ({ ...current, [invoiceId]: block }));
        const detail = block.lines.length > 0 ? ` Líneas afectadas: ${block.lines.join("; ")}.` : "";
        const message = `${block.message}${detail}${block.hint ? ` ${block.hint}` : " Configura los tipos en Impuestos de la propiedad y vuelve a intentarlo."}`;
        setStatus(message);
        showToast(block.message, { variant: "error" });
        return;
      }
      const message = error instanceof Error ? error.message : "No se pudo emitir la factura.";
      setStatus(message);
      showToast(message, { variant: "error" });
    }
  }

  async function handleSaveBranding() {
    setBrandingStatus("Guardando branding…");
    try {
      const saved = await saveInvoiceBranding(PROPERTY_ID, {
        logoUrl: logoUrl.trim() || null,
        legalFooter: legalFooter.trim() || null
      });
      setLogoUrl(saved.logoUrl ?? "");
      setLegalFooter(saved.legalFooter ?? "");
      setBrandingStatus("Branding de factura guardado ✓");
    } catch (error) {
      setBrandingStatus(error instanceof Error ? error.message : "No se pudo guardar el branding");
    }
  }

  async function handlePreview(invoiceId: string) {
    setStatus("Cargando vista previa…");
    try {
      const full = await fetchInvoice(invoiceId);
      setPreview(full);
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "No se pudo cargar la factura.");
    }
  }

  async function handleMarkPaid(invoiceId: string) {
    logBreadcrumb("invoice.markPaid", "mutation", { invoiceId });
    setStatus(`Marcando factura ${invoiceId} como pagada...`);
    try {
      const result = await markInvoicePaid(invoiceId);
      // Reflect the server answer right away, then refetch the listing so tabs
      // and KPIs read the persisted payment state (never a local mark).
      const fullyPaid = result.alreadyPaid || result.paidAmount >= result.invoiceTotal;
      setInvoices((current) =>
        current.map((invoice) =>
          invoice.id === invoiceId
            ? {
                ...invoice,
                paymentStatus: result.paymentStatus ?? (fullyPaid ? "paid" : invoice.paymentStatus),
                balanceDue: result.balanceDue ?? (fullyPaid ? 0 : invoice.balanceDue),
                paidAt: result.paidAt ?? invoice.paidAt,
                folioId: result.folioId ?? invoice.folioId
              }
            : invoice
        )
      );
      void loadInvoices().catch(() => undefined);
      const message = result.alreadyPaid
        ? `Factura ${invoiceId} ya estaba pagada.`
        : `Factura ${invoiceId} marcada como pagada (${fmtEur(result.paidAmount)} / ${fmtEur(result.invoiceTotal)}).`;
      setStatus(message);
      showToast(message, { variant: "success" });
    } catch (error) {
      // Surface the API message as-is (e.g. 409 "La factura no está vinculada a
      // ningún folio" for manual drafts). NEVER mark the invoice paid locally.
      const message = error instanceof Error ? error.message : "No se pudo marcar como pagada.";
      const hint =
        error instanceof ApiError && error.status === 409
          ? " Emite la factura desde el folio de la reserva o registra el cobro en ese folio."
          : "";
      setStatus(`${message}${hint}`);
      showToast(message, { variant: "error" });
    }
  }

  function handleOpenEmail(invoice: InvoiceDraft) {
    const number = invoice.invoiceNumber ?? invoice.id;
    setEmailDraft({
      invoiceId: invoice.id,
      to: "",
      subject: `Factura ${number}`,
      body: `Estimado cliente,\n\nAdjuntamos la factura ${number} por importe de ${fmtEur(invoice.total)}.\n\nGracias por su confianza.`
    });
  }

  async function handleSendEmail() {
    if (!emailDraft) return;
    const to = emailDraft.to.trim();
    if (!to) {
      showToast("Indique al menos un destinatario.", { variant: "error" });
      return;
    }
    logBreadcrumb("invoice.email", "mutation", { invoiceId: emailDraft.invoiceId });
    try {
      await sendInvoiceEmail(emailDraft.invoiceId, {
        recipient: to,
        subject: emailDraft.subject,
        message: emailDraft.body
      });
      showToast(`Email enviado a ${to}`, { variant: "success" });
      setEmailDraft(null);
    } catch (error) {
      // Fallback: mailto: para que el operador pueda enviar desde su cliente
      // de correo sin perder el borrador si el endpoint backend falla.
      const url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(emailDraft.subject)}&body=${encodeURIComponent(emailDraft.body)}`;
      window.location.href = url;
      const message = error instanceof Error ? error.message : "Envío directo falló; abriendo cliente de correo.";
      showToast(message, { variant: "info" });
      setEmailDraft(null);
    }
  }

  function handleRectifyPlaceholder(invoice: InvoiceDraft) {
    logBreadcrumb("invoice.rectify.intent", "ui", { invoiceId: invoice.id });
    setStatus(
      `Generación de factura rectificativa para ${invoice.invoiceNumber ?? invoice.id} llega en Q3. Mientras tanto use el diálogo de rectificación en el centro de facturas.`
    );
    showToast("Factura rectificativa: disponible en Q3", { variant: "info" });
  }

  function handlePrint() {
    window.print();
  }

  const kpis = useMemo(() => {
    const counts: Record<InvoiceTab, number> = { draft: 0, issued: 0, pending: 0, paid: 0, cancelled: 0 };
    const totals: Record<InvoiceTab, number> = { draft: 0, issued: 0, pending: 0, paid: 0, cancelled: 0 };
    for (const inv of invoices) {
      const amount = Number(inv.total) || 0;
      if (inv.status === "draft") {
        counts.draft += 1;
        totals.draft += amount;
      } else if (inv.status === "issued") {
        counts.issued += 1;
        totals.issued += amount;
        if (isInvoicePaid(inv)) {
          counts.paid += 1;
          totals.paid += amount;
        } else if (inv.paymentStatus !== "not_applicable") {
          counts.pending += 1;
          totals.pending += inv.balanceDue ?? amount;
        }
      } else if (inv.status === "cancelled" || inv.status === "rectified") {
        // rectificadas se agrupan visualmente con anuladas
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
    return invoices.filter((inv) => {
      if (activeTab === "draft" && inv.status !== "draft") return false;
      if (activeTab === "issued" && inv.status !== "issued") return false;
      if (activeTab === "cancelled" && inv.status !== "cancelled" && inv.status !== "rectified") return false;
      if (activeTab === "pending" && !canMarkPaid(inv)) return false;
      if (activeTab === "paid" && !isInvoicePaid(inv)) return false;
      if (!term) return true;
      const haystack = [inv.invoiceNumber ?? "", inv.id, inv.customerTaxId ?? "", inv.invoiceType, inv.customerType, String(inv.total)]
        .join(" ")
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [invoices, search, activeTab]);

  function handleExportInvoicesCsv() {
    if (invoices.length === 0) {
      showToast("No hay facturas para exportar", { variant: "info" });
      return;
    }
    const columns: CsvColumn<InvoiceDraft>[] = [
      { key: "invoiceNumber", label: "Número", format: (v, r) => v ?? r.id },
      { key: "id", label: "ID interno" },
      { key: "invoiceType", label: "Tipo" },
      { key: "customerType", label: "Cliente" },
      { key: "customerTaxId", label: "NIF/CIF" },
      { key: "status", label: "Estado" },
      { key: "paymentStatus", label: "Cobro", format: (v) => (v ? String(v) : "") },
      { key: "total", label: "Total" },
      { key: "taxTotal", label: "IVA" },
      { key: "balanceDue", label: "Pendiente", format: (v) => (v === undefined || v === null ? "" : String(v)) },
      {
        key: "issuedAt",
        label: "Emitida",
        format: (v) => (v ? new Date(String(v)).toISOString().slice(0, 10) : "")
      }
    ];
    const stamp = new Date().toISOString().slice(0, 10);
    exportToCsv(invoices, `facturas-${stamp}`, columns);
    showToast(`Exportadas ${invoices.length} facturas a CSV`, { variant: "success" });
  }

  const reservationOptions = useMemo(
    () =>
      reservations.map((reservation) => ({
        value: reservation.id,
        label: `${reservation.code} · ${reservation.bookerName ?? reservation.primaryGuestId}`
      })),
    [reservations]
  );

  const invoiceColumns = useMemo<CocoaTableColumn<InvoiceDraft>[]>(
    () => [
      {
        key: "invoiceNumber",
        label: "N. Factura",
        render: (row) => (
          <span>
            <strong>{row.invoiceNumber ?? row.id}</strong>
            {row.issuerTaxIdPlaceholder ? (
              <span
                className="bo-status warn"
                style={{ marginLeft: "var(--cocoa-space-2)", textTransform: "none" }}
                title="Emitida con NIF emisor provisional (sandbox): configura el NIF real en Perfil del establecimiento"
              >
                NIF provisional
              </span>
            ) : null}
          </span>
        )
      },
      {
        key: "customer",
        label: "Cliente",
        render: (row) => (
          <span>
            {row.customerType}
            {row.customerTaxId ? ` · ${row.customerTaxId}` : ""}
          </span>
        )
      },
      {
        key: "issuedAt",
        label: "Fecha",
        render: (row) =>
          row.issuedAt
            ? new Date(row.issuedAt).toLocaleDateString("es-ES")
            : "—"
      },
      {
        key: "total",
        label: "Total",
        align: "right",
        render: (row) => fmtEur(row.total)
      },
      {
        key: "status",
        label: "Estado",
        render: (row) => {
          const uiStatus = deriveInvoiceUiStatus(row);
          return (
            <span style={{ display: "inline-flex", alignItems: "center", gap: "var(--cocoa-space-2)", flexWrap: "wrap" }}>
              <StatusBadge variant={statusBadgeVariant(uiStatus)} size="sm">
                {statusBadgeLabel(uiStatus)}
              </StatusBadge>
              {row.status === "issued" && row.paymentStatus === "partial" ? (
                <small style={{ color: "var(--cocoa-label-secondary)" }}>
                  Cobro parcial · pendiente {fmtEur(row.balanceDue)}
                </small>
              ) : null}
            </span>
          );
        }
      },
      {
        key: "actions",
        label: "Acciones",
        align: "right",
        render: (row) => {
          const markable = canMarkPaid(row);
          return (
            <span
              style={{
                display: "inline-flex",
                gap: "var(--cocoa-space-2)",
                justifyContent: "flex-end"
              }}
            >
              <CocoaButton
                variant="plain"
                size="small"
                onClick={() => void handlePreview(row.id)}
              >
                Ver detalle
              </CocoaButton>
              <CocoaButton
                variant="plain"
                size="small"
                onClick={() => handleOpenEmail(row)}
              >
                Enviar email
              </CocoaButton>
              {markable ? (
                <CocoaButton
                  variant="filled"
                  tone="accent"
                  size="small"
                  onClick={() => void handleMarkPaid(row.id)}
                >
                  Marcar pagada
                </CocoaButton>
              ) : null}
            </span>
          );
        }
      }
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // The preview is fetched with GET /invoices/:id; its payment state comes from
  // the listing row (the detail endpoint does not carry the enrichment yet).
  const previewListRow = preview ? invoices.find((inv) => inv.id === preview.id) : undefined;
  const previewMarkable = preview ? canMarkPaid(previewListRow ?? preview) : false;

  return (
    <section className="bo-card">
      <CocoaPageHeader
        eyebrow="Finanzas y cumplimiento"
        title="Centro de facturación"
        subtitle="Folios + facturas · cumplimiento VERI*FACTU"
        actions={
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--cocoa-space-2)"
            }}
          >
            <CocoaButton
              variant="plain"
              size="regular"
              onClick={handleExportInvoicesCsv}
            >
              Exportar CSV
            </CocoaButton>
          </span>
        }
      />

      <div style={{ marginTop: "var(--cocoa-space-4)" }}>
        <CocoaScreenInstructionsCard
          title="Centro de facturación"
          description={String(BILLING_INSTRUCTIONS.whatIsThis)}
          steps={BILLING_INSTRUCTIONS.howToUse.map((step) => String(step))}
          tip={
            BILLING_INSTRUCTIONS.tips && BILLING_INSTRUCTIONS.tips.length > 0
              ? String(BILLING_INSTRUCTIONS.tips[0])
              : undefined
          }
          dismissible
          persistKey="billing"
        />
      </div>

      <p style={{ marginTop: "var(--cocoa-space-4)" }}>
        Billing connects reservation folios, charges, captured payments, invoice drafts, invoice sequences and compliance workflows. Issued invoices cannot
        be silently edited; rectification and cancellation routes stay explicit.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "var(--cocoa-space-3)",
          marginTop: "var(--cocoa-space-4)"
        }}
      >
        <CocoaCard variant="elevated" padding="md">
          <span
            style={{
              color: "var(--cocoa-label-secondary)",
              fontSize: "var(--cocoa-fs-caption)",
              textTransform: "uppercase",
              letterSpacing: "var(--cocoa-tracking-wide)"
            }}
          >
            Folio charges
          </span>
          <div
            style={{
              fontSize: "var(--cocoa-fs-large-title)",
              fontWeight: 600,
              marginTop: "var(--cocoa-space-2)"
            }}
          >
            {folio?.chargesTotal ?? 0}
          </div>
          <p style={{ marginTop: "var(--cocoa-space-1)", color: "var(--cocoa-label-secondary)" }}>
            {folio?.folio.currency ?? "EUR"}
          </p>
        </CocoaCard>
        <CocoaCard variant="elevated" padding="md">
          <span
            style={{
              color: "var(--cocoa-label-secondary)",
              fontSize: "var(--cocoa-fs-caption)",
              textTransform: "uppercase",
              letterSpacing: "var(--cocoa-tracking-wide)"
            }}
          >
            Payments
          </span>
          <div
            style={{
              fontSize: "var(--cocoa-fs-large-title)",
              fontWeight: 600,
              marginTop: "var(--cocoa-space-2)"
            }}
          >
            {folio?.paymentsTotal ?? 0}
          </div>
          <p style={{ marginTop: "var(--cocoa-space-1)", color: "var(--cocoa-label-secondary)" }}>
            Captured payments only.
          </p>
        </CocoaCard>
        <CocoaCard variant="elevated" padding="md">
          <span
            style={{
              color: "var(--cocoa-label-secondary)",
              fontSize: "var(--cocoa-fs-caption)",
              textTransform: "uppercase",
              letterSpacing: "var(--cocoa-tracking-wide)"
            }}
          >
            Balance
          </span>
          <div
            style={{
              fontSize: "var(--cocoa-fs-large-title)",
              fontWeight: 600,
              marginTop: "var(--cocoa-space-2)"
            }}
          >
            {folio?.balanceDue ?? 0}
          </div>
          <p style={{ marginTop: "var(--cocoa-space-1)", color: "var(--cocoa-label-secondary)" }}>
            Zero balance can close folio.
          </p>
        </CocoaCard>
      </div>

      <div className="bo-grid two" style={{ marginTop: "var(--cocoa-space-4)" }}>
        <section className="bo-card">
          <div className="bo-card-head">
            <h3>Folio de la reserva</h3>
            <span className="bo-chip">GET /reservations/:id/folio</span>
          </div>
          <label className="bo-form-field">
            <span>Reserva</span>
            <CocoaSelect
              value={selectedReservationId}
              onChange={(value) => void handleReservationChange(value)}
              options={reservationOptions}
            />
          </label>
          {folio ? (
            <div>
              <CocoaCard variant="elevated" padding="lg">
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    flexWrap: "wrap",
                    gap: "var(--cocoa-space-3)"
                  }}
                >
                  <div>
                    <span
                      style={{
                        color: "var(--cocoa-label-secondary)",
                        fontSize: "var(--cocoa-fs-caption)",
                        textTransform: "uppercase",
                        letterSpacing: "var(--cocoa-tracking-wide)"
                      }}
                    >
                      Saldo pendiente
                    </span>
                    <div
                      style={{
                        fontSize: "var(--cocoa-fs-large-title)",
                        fontWeight: 700,
                        lineHeight: 1.1,
                        marginTop: "var(--cocoa-space-1)"
                      }}
                    >
                      {folio.balanceDue}{" "}
                      <small style={{ fontSize: "var(--cocoa-fs-body)", fontWeight: 500 }}>
                        {folio.folio.currency}
                      </small>
                    </div>
                  </div>
                  <div style={{ textAlign: "right", color: "var(--cocoa-label-secondary)" }}>
                    <div>
                      Cargos: <strong style={{ color: "var(--cocoa-label)" }}>{folio.chargesTotal}</strong>
                    </div>
                    <div>
                      Pagos: <strong style={{ color: "var(--cocoa-label)" }}>{folio.paymentsTotal}</strong>
                    </div>
                  </div>
                </div>
              </CocoaCard>

              <div style={{ marginTop: "var(--cocoa-space-3)", marginBottom: "var(--cocoa-space-3)" }}>
                <CocoaSegmentedControl
                  aria-label="Secciones del folio"
                  value={folioTab}
                  onChange={(next) =>
                    setFolioTab(next as "charges" | "payments" | "routing" | "notes")
                  }
                  options={[
                    { value: "charges", label: `Cargos (${folio.lines.length})` },
                    { value: "payments", label: `Pagos (${folio.payments.length})` },
                    { value: "routing", label: "Reglas de routing" },
                    { value: "notes", label: "Notas" }
                  ]}
                />
              </div>

              {folioTab === "charges" ? (
                <div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: "var(--cocoa-space-2)"
                    }}
                  >
                    <h4 style={{ margin: 0 }}>Cargos</h4>
                    <CocoaButton
                      variant="plain"
                      size="small"
                      onClick={() => {
                        logBreadcrumb("folio.addCharge.intent", "ui", { folioId: folio.folio.id });
                        showToast("Añadir cargo manual: formulario detallado disponible en Q3", { variant: "info" });
                      }}
                    >
                      + Añadir cargo
                    </CocoaButton>
                  </div>
                  {folio.lines.length ? folio.lines.map((line) => (
                    <div className="bo-row" key={line.id}>
                      <span>
                        <strong>{line.description}</strong>
                        <small>{line.type} · {line.quantity} × {line.unitPrice}{line.taxCode ? ` · ${line.taxCode}` : ""}</small>
                      </span>
                      <strong>{fmtMoney(line.total, folio.folio.currency)}</strong>
                    </div>
                  )) : <p className="bo-muted">Sin cargos registrados.</p>}
                </div>
              ) : null}

              {folioTab === "payments" ? (
                <div>
                  <h4 style={{ marginTop: 0 }}>Pagos</h4>
                  {folio.payments.length ? folio.payments.map((payment) => (
                    <div className="bo-row" key={payment.id}>
                      <span>
                        <strong>{payment.method}</strong>
                        <small>{payment.status}{payment.pspReference ? ` · ref ${payment.pspReference}` : ""}</small>
                      </span>
                      <strong>{fmtMoney(payment.amount, payment.currency)}</strong>
                    </div>
                  )) : <p className="bo-muted">Sin pagos registrados.</p>}
                </div>
              ) : null}

              {folioTab === "routing" ? (
                <div>
                  <h4 style={{ marginTop: 0 }}>Reglas de routing</h4>
                  <p className="bo-muted">
                    Las reglas de routing del folio (qué cargos van a qué pagador) se gestionan en la pantalla dedicada
                    de administración. Próximamente se embebe aquí el editor de reglas.
                  </p>
                  <div className="bo-actions">
                    <CocoaButton
                      variant="bordered"
                      tone="neutral"
                      onClick={() => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "FolioRouting" }))}
                    >
                      Abrir editor de routing
                    </CocoaButton>
                  </div>
                </div>
              ) : null}

              {folioTab === "notes" ? (
                <div>
                  <h4 style={{ marginTop: 0 }}>Notas</h4>
                  <label className="bo-form-field">
                    <span>Nota interna sobre este folio</span>
                    <textarea
                      rows={4}
                      value={folioNote}
                      onChange={(event) => setFolioNote(event.target.value)}
                      placeholder="Anotaciones para el equipo de facturación…"
                    />
                  </label>
                  <div className="bo-actions">
                    <CocoaButton
                      variant="filled"
                      tone="accent"
                      onClick={() => {
                        logBreadcrumb("folio.note.save", "mutation", { folioId: folio.folio.id });
                        showToast("Nota guardada localmente (persistencia backend en Q3)", { variant: "success" });
                      }}
                    >
                      Guardar nota
                    </CocoaButton>
                  </div>
                </div>
              ) : null}
            </div>
          ) : <p>Ningún folio seleccionado.</p>}
        </section>

        <section className="bo-card">
          <div className="bo-card-head">
            <h3>Borrador de factura</h3>
            <span className="bo-chip">POST /invoices/drafts</span>
          </div>
          <div className="bo-grid two">
            <label className="bo-form-field">
              <span>Tipo de factura</span>
              <CocoaSelect
                value={invoiceType}
                onChange={(value) => setInvoiceType(value as InvoiceDraft["invoiceType"])}
                options={[
                  { value: "full", label: "Full" },
                  { value: "simplified", label: "Simplified" },
                  { value: "rectifying", label: "Rectifying" },
                  { value: "credit_note", label: "Credit note" }
                ]}
              />
            </label>
            <label className="bo-form-field">
              <span>Tipo de cliente</span>
              <CocoaSelect
                value={customerType}
                onChange={(value) => setCustomerType(value as InvoiceDraft["customerType"])}
                options={[
                  { value: "guest", label: "Guest" },
                  { value: "company", label: "Company" },
                  { value: "agency", label: "Agency" }
                ]}
              />
            </label>
            {draftLines.length === 0 ? (
              <>
                <label className="bo-form-field">
                  <span>Total (impuesto incluido)</span>
                  <CocoaInput
                    value={draftTotal}
                    onChange={setDraftTotal}
                    type="number"
                    inputMode="decimal"
                  />
                </label>
                <label className="bo-form-field">
                  <span>Cuota de impuesto</span>
                  <CocoaInput
                    value={draftTaxTotal}
                    onChange={setDraftTaxTotal}
                    type="number"
                    inputMode="decimal"
                  />
                </label>
              </>
            ) : null}
          </div>
          <label className="bo-form-field">
            <span>NIF/CIF del cliente</span>
            <CocoaInput value={customerTaxId} onChange={setCustomerTaxId} />
          </label>

          <div className="bo-card-head" style={{ marginTop: "var(--cocoa-space-2)" }}>
            <h4 style={{ margin: 0 }}>Líneas del borrador</h4>
            <span className="bo-chip" title={taxProfileError ?? undefined}>
              {taxProfile ? `${taxProfile.figure} · ${taxProfile.taxRegion ?? "sin región"}` : "perfil fiscal no disponible"}
            </span>
          </div>
          {draftLines.length === 0 ? (
            <p className="bo-muted" style={{ marginTop: 0 }}>
              Sin líneas: el borrador se crea con una línea resumen a partir del total y la cuota. Añade líneas para elegir la categoría fiscal de cada concepto.
            </p>
          ) : null}
          {draftLines.map((line) => {
            const rate = rateForCategory(taxProfile, line.taxCategory);
            return (
              <div key={line.key} className="bo-grid" style={{ gridTemplateColumns: "2fr 70px 110px 1.4fr auto", gap: "var(--cocoa-space-2)", alignItems: "end", marginBottom: "var(--cocoa-space-2)" }}>
                <label className="bo-form-field">
                  <span>Concepto</span>
                  <CocoaInput value={line.description} onChange={(value) => setDraftLines((current) => current.map((row) => (row.key === line.key ? { ...row, description: value } : row)))} placeholder="Alojamiento 2 noches" />
                </label>
                <label className="bo-form-field">
                  <span>Cant.</span>
                  <CocoaInput value={line.quantity} onChange={(value) => setDraftLines((current) => current.map((row) => (row.key === line.key ? { ...row, quantity: value } : row)))} type="number" inputMode="decimal" />
                </label>
                <label className="bo-form-field">
                  <span>Precio (bruto)</span>
                  <CocoaInput value={line.unitPrice} onChange={(value) => setDraftLines((current) => current.map((row) => (row.key === line.key ? { ...row, unitPrice: value } : row)))} type="number" inputMode="decimal" />
                </label>
                <label className="bo-form-field">
                  <span>Categoría fiscal{rate ? ` · ${rate.calificacion === "N1" ? "no sujeta" : `${rate.ratePercent} %`}` : " · sin tipo"}</span>
                  <CocoaSelect
                    value={line.taxCategory}
                    onChange={(value) => setDraftLines((current) => current.map((row) => (row.key === line.key ? { ...row, taxCategory: value as TaxCategory } : row)))}
                    options={TAX_CATEGORY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))}
                  />
                </label>
                <CocoaButton variant="plain" size="small" tone="destructive" onClick={() => setDraftLines((current) => current.filter((row) => row.key !== line.key))}>
                  Quitar
                </CocoaButton>
              </div>
            );
          })}
          {draftLines.length > 0 ? (
            (() => {
              const resolved = resolveDraftLines(draftLines, taxProfile);
              return (
                <p className="bo-muted" style={{ marginTop: 0 }}>
                  Total {fmtEur(resolved.total)} · cuota {fmtEur(resolved.taxTotal)}
                  {resolved.missing.length > 0 ? (
                    <span className="bo-status warn" style={{ marginLeft: "var(--cocoa-space-2)", textTransform: "none" }}>
                      sin tipo para {resolved.missing.map((category) => TAX_CATEGORY_LABELS[category].toLowerCase()).join(", ")}
                    </span>
                  ) : null}
                </p>
              );
            })()
          ) : null}
          <div className="bo-actions">
            <CocoaButton variant="plain" size="small" onClick={() => setDraftLines((current) => [...current, newDraftLine(current.length === 0 ? "accommodation" : "general_services")])}>
              + Añadir línea
            </CocoaButton>
          </div>

          <div className="bo-actions">
            <CocoaButton variant="filled" tone="accent" onClick={handleCreateDraft}>
              Crear borrador
            </CocoaButton>
            <CocoaButton variant="plain" onClick={() => navigateTo("BillingSettings")}>
              Series de facturación
            </CocoaButton>
            <CocoaButton variant="plain" onClick={() => navigateTo("PropertyTaxesScreen")}>
              Impuestos de la propiedad
            </CocoaButton>
          </div>
        </section>
      </div>

      <section className="bo-card">
        <div className="bo-card-head">
          <div>
            <p className="bo-muted">Personalización legal</p>
            <h3 style={{ margin: 0 }}>Logo y avisos legales de la factura</h3>
          </div>
          <span className="bo-chip">por propiedad</span>
        </div>
        <p className="bo-muted" style={{ marginTop: 0 }}>
          El logo y el pie de avisos legales (datos registrales, aviso de privacidad, condiciones de pago) se imprimen en
          todas las facturas de esta propiedad.
        </p>
        <div className="bo-grid two">
          <label className="bo-form-field">
            <span>URL del logo <span className="bo-muted">(o data: URI)</span></span>
            <CocoaInput
              value={logoUrl}
              onChange={setLogoUrl}
              placeholder="https://…/logo.png"
            />
          </label>
          <div className="bo-form-field">
            <span>Vista previa del logo</span>
            {logoUrl.trim() ? (
              <img
                src={logoUrl}
                alt="Logo de la propiedad"
                style={{
                  maxHeight: 56,
                  maxWidth: 220,
                  objectFit: "contain",
                  borderRadius: "var(--cocoa-radius-sm)",
                  border: "1px solid var(--cocoa-separator)",
                  padding: "var(--cocoa-space-1)",
                  background: "var(--cocoa-background-content)"
                }}
              />
            ) : (
              <span className="bo-muted">Sin logo configurado.</span>
            )}
          </div>
        </div>
        <label className="bo-form-field">
          <span>Avisos legales / pie de factura</span>
          <textarea
            value={legalFooter}
            onChange={(event) => setLegalFooter(event.target.value)}
            rows={4}
            placeholder={"Inscrita en el Registro Mercantil de…\nTratamos sus datos conforme al RGPD…\nForma de pago: …"}
          />
        </label>
        <div className="bo-actions">
          <CocoaButton variant="filled" tone="accent" onClick={() => void handleSaveBranding()}>
            Guardar branding
          </CocoaButton>
        </div>
        {brandingStatus ? <p className="bo-muted">{brandingStatus}</p> : null}
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <h3>Facturas</h3>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--cocoa-space-2)"
            }}
          >
            <span className="bo-chip">{invoices.length} totales</span>
            <CocoaButton
              variant="plain"
              size="small"
              onClick={handleExportInvoicesCsv}
            >
              Exportar CSV
            </CocoaButton>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: "var(--cocoa-space-3)",
            margin: "var(--cocoa-space-3) 0"
          }}
        >
          <CocoaCard variant="elevated" padding="md">
            <span
              style={{
                color: "var(--cocoa-label-secondary)",
                fontSize: "var(--cocoa-fs-caption)",
                textTransform: "uppercase",
                letterSpacing: "var(--cocoa-tracking-wide)"
              }}
            >
              Borradores
            </span>
            <div
              style={{
                fontSize: "var(--cocoa-fs-title-1)",
                fontWeight: 600,
                marginTop: "var(--cocoa-space-1)"
              }}
            >
              {kpis.counts.draft}
            </div>
            <p style={{ marginTop: "var(--cocoa-space-1)", color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-caption)" }}>
              {fmtEur(kpis.totals.draft)}
            </p>
          </CocoaCard>
          <CocoaCard variant="elevated" padding="md">
            <span
              style={{
                color: "var(--cocoa-label-secondary)",
                fontSize: "var(--cocoa-fs-caption)",
                textTransform: "uppercase",
                letterSpacing: "var(--cocoa-tracking-wide)"
              }}
            >
              Emitidas
            </span>
            <div
              style={{
                fontSize: "var(--cocoa-fs-title-1)",
                fontWeight: 600,
                marginTop: "var(--cocoa-space-1)"
              }}
            >
              {kpis.counts.issued}
            </div>
            <p style={{ marginTop: "var(--cocoa-space-1)", color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-caption)" }}>
              {fmtEur(kpis.totals.issued)}
            </p>
          </CocoaCard>
          <CocoaCard variant="elevated" padding="md">
            <span
              style={{
                color: "var(--cocoa-label-secondary)",
                fontSize: "var(--cocoa-fs-caption)",
                textTransform: "uppercase",
                letterSpacing: "var(--cocoa-tracking-wide)"
              }}
            >
              Pendientes
            </span>
            <div
              style={{
                fontSize: "var(--cocoa-fs-title-1)",
                fontWeight: 600,
                marginTop: "var(--cocoa-space-1)"
              }}
            >
              {kpis.counts.pending}
            </div>
            <p style={{ marginTop: "var(--cocoa-space-1)", color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-caption)" }}>
              {fmtEur(kpis.totals.pending)}
            </p>
          </CocoaCard>
          <CocoaCard variant="elevated" padding="md">
            <span
              style={{
                color: "var(--cocoa-label-secondary)",
                fontSize: "var(--cocoa-fs-caption)",
                textTransform: "uppercase",
                letterSpacing: "var(--cocoa-tracking-wide)"
              }}
            >
              Pagadas
            </span>
            <div
              style={{
                fontSize: "var(--cocoa-fs-title-1)",
                fontWeight: 600,
                marginTop: "var(--cocoa-space-1)"
              }}
            >
              {kpis.counts.paid}
            </div>
            <p style={{ marginTop: "var(--cocoa-space-1)", color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-caption)" }}>
              {fmtEur(kpis.totals.paid)}
            </p>
          </CocoaCard>
          <CocoaCard variant="elevated" padding="md">
            <span
              style={{
                color: "var(--cocoa-label-secondary)",
                fontSize: "var(--cocoa-fs-caption)",
                textTransform: "uppercase",
                letterSpacing: "var(--cocoa-tracking-wide)"
              }}
            >
              Anuladas
            </span>
            <div
              style={{
                fontSize: "var(--cocoa-fs-title-1)",
                fontWeight: 600,
                marginTop: "var(--cocoa-space-1)"
              }}
            >
              {kpis.counts.cancelled}
            </div>
            <p style={{ marginTop: "var(--cocoa-space-1)", color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-caption)" }}>
              {fmtEur(kpis.totals.cancelled)}
            </p>
          </CocoaCard>
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "var(--cocoa-space-3)",
            alignItems: "center",
            margin: "var(--cocoa-space-3) 0"
          }}
        >
          <div style={{ flex: "1 1 240px", minWidth: 200 }}>
            <CocoaSearchInput
              value={search}
              onChange={setSearch}
              placeholder="Buscar por número, NIF, tipo…"
            />
          </div>
        </div>

        <div style={{ marginBottom: "var(--cocoa-space-3)" }}>
          <CocoaSegmentedControl
            aria-label="Filtros de facturas"
            value={activeTab}
            onChange={(next) => setActiveTab(next as InvoiceTab)}
            options={TAB_DEFS.map((tab) => ({
              value: tab.key,
              label: `${tab.label} (${kpis.counts[tab.key]})`
            }))}
          />
        </div>

        {invoicesError ? (
          <p className="bo-status error" style={{ textTransform: "none", marginBottom: "var(--cocoa-space-3)" }}>
            No se pudieron cargar las facturas: {invoicesError}{" "}
            <CocoaButton variant="plain" size="small" onClick={() => void loadInvoices().catch(() => undefined)}>
              Reintentar
            </CocoaButton>
          </p>
        ) : null}
        <CocoaTable<InvoiceDraft>
          columns={invoiceColumns}
          rows={filteredInvoices}
          rowKey="id"
          emptyState="No hay facturas que coincidan con el filtro o búsqueda."
        />
        {invoicesNextCursor ? (
          <div style={{ display: "flex", justifyContent: "center", marginTop: "var(--cocoa-space-3)" }}>
            <CocoaButton
              variant="bordered"
              tone="neutral"
              onClick={() => void loadMoreInvoices()}
              disabled={loadingMoreInvoices}
              loading={loadingMoreInvoices}
            >
              Cargar más facturas
            </CocoaButton>
          </div>
        ) : null}
        {kpis.pagePartial ? (
          <p className="bo-muted" style={{ marginTop: "var(--cocoa-space-2)" }}>
            Los importes de borradores, emitidas, pagadas y anuladas se calculan sobre las {invoices.length} facturas cargadas; los recuentos y el
            pendiente de cobro provienen del resumen del servidor.
          </p>
        ) : null}
      </section>

      {emailDraft ? (
        <section
          className="bo-card"
          style={{ background: "var(--cocoa-background-content)" }}
        >
          <div className="bo-card-head">
            <h3>Enviar factura por email</h3>
            <CocoaButton variant="plain" onClick={() => setEmailDraft(null)}>
              Cerrar
            </CocoaButton>
          </div>
          <label className="bo-form-field">
            <span>Destinatario</span>
            <CocoaInput
              type="email"
              inputMode="email"
              value={emailDraft.to}
              placeholder="cliente@dominio.com"
              onChange={(value) => setEmailDraft({ ...emailDraft, to: value })}
            />
          </label>
          <label className="bo-form-field">
            <span>Asunto</span>
            <CocoaInput
              value={emailDraft.subject}
              onChange={(value) => setEmailDraft({ ...emailDraft, subject: value })}
            />
          </label>
          <label className="bo-form-field">
            <span>Mensaje</span>
            <textarea
              rows={6}
              value={emailDraft.body}
              onChange={(event) => setEmailDraft({ ...emailDraft, body: event.target.value })}
            />
          </label>
          <div className="bo-actions">
            <CocoaButton variant="filled" tone="accent" onClick={handleSendEmail}>
              Enviar
            </CocoaButton>
            <CocoaButton variant="plain" onClick={() => setEmailDraft(null)}>
              Cancelar
            </CocoaButton>
          </div>
        </section>
      ) : null}

      {preview ? (
        <section
          className="bo-card"
          style={{ background: "var(--cocoa-background-content)" }}
        >
          <div className="bo-card-head">
            <h3>Vista previa de factura</h3>
            <div
              className="bo-page-head-actions"
              style={{ display: "inline-flex", gap: "var(--cocoa-space-2)", flexWrap: "wrap" }}
            >
              <CocoaButton variant="plain" onClick={handlePrint}>
                Imprimir / Descargar PDF
              </CocoaButton>
              <CocoaButton variant="plain" onClick={() => handleOpenEmail(preview)}>
                Enviar por email
              </CocoaButton>
              {preview.status === "draft" ? (
                <span
                  title={
                    issueBlocks[preview.id]
                      ? `${issueBlocks[preview.id].message}${issueBlocks[preview.id].lines.length ? ` · ${issueBlocks[preview.id].lines.join("; ")}` : ""}`
                      : undefined
                  }
                >
                  <CocoaButton
                    variant="filled"
                    tone="accent"
                    onClick={() => void handleIssue(preview.id)}
                    disabled={Boolean(issueBlocks[preview.id])}
                  >
                    Emitir factura
                  </CocoaButton>
                </span>
              ) : null}
              {previewMarkable ? (
                <CocoaButton
                  variant="filled"
                  tone="accent"
                  onClick={() => void handleMarkPaid(preview.id)}
                >
                  Marcar pagada
                </CocoaButton>
              ) : null}
              {preview.status === "issued" ? (
                <CocoaButton
                  variant="filled"
                  tone="destructive"
                  onClick={() => handleRectifyPlaceholder(preview)}
                  aria-label="Generar factura rectificativa (disponible en Q3)"
                >
                  Generar factura rectificativa
                </CocoaButton>
              ) : null}
              <CocoaButton variant="plain" onClick={() => setPreview(null)}>
                Cerrar
              </CocoaButton>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "flex-start",
              gap: "var(--cocoa-space-4)",
              flexWrap: "wrap"
            }}
          >
            <div>
              {preview.issuer?.logoUrl ? (
                <img
                  src={preview.issuer.logoUrl}
                  alt="Logo"
                  style={{
                    maxHeight: 64,
                    maxWidth: 240,
                    objectFit: "contain",
                    marginBottom: "var(--cocoa-space-2)"
                  }}
                />
              ) : null}
              <div><strong>{preview.issuer?.legalName ?? preview.issuer?.propertyName ?? "—"}</strong></div>
              {preview.issuer?.taxId ? <div className="bo-muted">NIF/CIF: {preview.issuer.taxId}</div> : null}
              {preview.issuer?.taxIdPlaceholder || preview.issuerTaxIdPlaceholder || previewListRow?.issuerTaxIdPlaceholder ? (
                <div className="bo-status warn" style={{ textTransform: "none", marginTop: "var(--cocoa-space-1)" }}>
                  NIF emisor provisional (sandbox): configura el NIF real en Perfil del establecimiento antes de facturar en modo fiscal.
                </div>
              ) : null}
              {preview.issuer?.address ? <div className="bo-muted">{preview.issuer.address}</div> : null}
            </div>
            <div style={{ textAlign: "right" }}>
              <div><strong>Factura {preview.invoiceNumber ?? preview.id}</strong></div>
              <div className="bo-muted">Tipo {preview.invoiceType} · {preview.customerType}</div>
              {preview.issuedAt ? <div className="bo-muted">Emitida: {new Date(preview.issuedAt).toLocaleDateString("es-ES")}</div> : null}
              {preview.customerTaxId ? <div className="bo-muted">Cliente NIF: {preview.customerTaxId}</div> : null}
            </div>
          </div>

          {issueBlocks[preview.id] ? (
            <div className="bo-status error" style={{ textTransform: "none", marginTop: "var(--cocoa-space-3)" }}>
              Emisión bloqueada (TAX_NOT_CONFIGURED): {issueBlocks[preview.id].message}
              {issueBlocks[preview.id].lines.length ? ` Líneas: ${issueBlocks[preview.id].lines.join("; ")}.` : ""}{" "}
              <CocoaButton variant="plain" size="small" onClick={() => navigateTo("PropertyTaxesScreen")}>
                Configurar impuestos
              </CocoaButton>
            </div>
          ) : null}
          {toArray<string>(preview.warnings).length > 0 ? (
            <div className="bo-status warn" style={{ textTransform: "none", marginTop: "var(--cocoa-space-3)", display: "grid", gap: 2 }}>
              {toArray<string>(preview.warnings).map((warning, index) => (
                <span key={`${index}-${warning}`}>{warning}</span>
              ))}
            </div>
          ) : null}

          <table className="bo-table" style={{ marginTop: "var(--cocoa-space-3)" }}>
            <thead><tr><th>Descripción</th><th style={{ textAlign: "right" }}>Cant.</th><th style={{ textAlign: "right" }}>Precio</th><th>Impuesto</th><th style={{ textAlign: "right" }}>Total</th></tr></thead>
            <tbody>
              {preview.lines.map((line, i) => (
                <tr key={line.id ?? i}>
                  <td>{line.description}</td>
                  <td style={{ textAlign: "right" }}>{line.quantity}</td>
                  <td style={{ textAlign: "right" }}>{line.unitPrice}</td>
                  <td>
                    {line.taxCalificacion === "N1" ? `${line.taxFigure ?? ""} no sujeta` : `${line.taxFigure ?? line.taxCode} ${line.taxRate}%`}
                    {isSuspiciousTaxLine(line) ? (
                      <span className="bo-status warn" style={{ marginLeft: 6, textTransform: "none" }} title={`Sin tipo impositivo configurado (${line.taxCode})`}>
                        sin tipo
                      </span>
                    ) : null}
                  </td>
                  <td style={{ textAlign: "right" }}>{line.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ textAlign: "right", marginTop: "var(--cocoa-space-2)" }}>
            {toArray<InvoiceTaxBreakdownGroup>(preview.taxBreakdown).map((group, index) => (
              <div className="bo-muted" key={`${group.figure}-${group.calificacion}-${group.ratePercent}-${index}`}>
                {group.figure} {group.calificacion === "N1" ? "no sujeta" : `${group.ratePercent}%`}: base {fmtEur(group.base)} · cuota {fmtEur(group.quota)}
              </div>
            ))}
            <div className="bo-muted">
              {preview.lines.find((line) => line.taxFigure)?.taxFigure ?? taxProfile?.figure ?? "Impuesto"}: {fmtEur(preview.taxTotal)}
            </div>
            <div><strong>Total: {fmtEur(preview.total)}</strong></div>
          </div>

          {preview.verifactuHash ? (
            <p
              className="bo-muted"
              style={{ marginTop: "var(--cocoa-space-2)", wordBreak: "break-all" }}
            >
              VERI*FACTU huella: {preview.verifactuHash}
            </p>
          ) : null}

          {preview.issuer?.legalFooter ? (
            <div
              style={{
                marginTop: "var(--cocoa-space-4)",
                paddingTop: "var(--cocoa-space-3)",
                borderTop: "1px solid var(--cocoa-separator)",
                whiteSpace: "pre-wrap",
                fontSize: "var(--cocoa-fs-caption)",
                color: "var(--cocoa-label-secondary)"
              }}
            >
              {preview.issuer.legalFooter}
            </div>
          ) : null}
        </section>
      ) : null}

      <p className="bo-muted">{status}</p>
    </section>
  );
}

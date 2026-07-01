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
  type FolioBalance,
  type InvoiceDraft,
  type InvoiceFull
} from "../../services/pmsCommerceApi";
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

// Local UI-only state of paid invoices (no backend "paid" status in InvoiceDraft yet).
// Persisted in sessionStorage so toggling tabs / refresh within a session keeps the mark.
const PAID_STORAGE_KEY = "hotelos.billing.paidInvoiceIds";

function readPaidIds(): Set<string> {
  try {
    const raw = sessionStorage.getItem(PAID_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as string[];
    return new Set(parsed);
  } catch {
    return new Set();
  }
}

function writePaidIds(ids: Set<string>) {
  try {
    sessionStorage.setItem(PAID_STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // ignore quota / private mode errors
  }
}

function deriveInvoiceUiStatus(invoice: InvoiceDraft, paidIds: Set<string>): InvoiceUiStatus {
  if (invoice.status === "cancelled") return "cancelled";
  if (invoice.status === "rectified") return "rectified";
  if (invoice.status === "issued") {
    return paidIds.has(invoice.id) ? "paid" : "issued";
  }
  return "draft";
}

export function BillingCenterScreen() {
  const { showToast } = useToast();
  const [reservations, setReservations] = useState<AdminReservation[]>([]);
  const [selectedReservationId, setSelectedReservationId] = useState("res_18392");
  const [folio, setFolio] = useState<FolioBalance | null>(null);
  const [invoices, setInvoices] = useState<InvoiceDraft[]>([]);
  const [draftTotal, setDraftTotal] = useState("272");
  const [draftTaxTotal, setDraftTaxTotal] = useState("24.73");
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
  const [paidIds, setPaidIds] = useState<Set<string>>(() => readPaidIds());
  const [folioTab, setFolioTab] = useState<"charges" | "payments" | "routing" | "notes">("charges");
  const [folioNote, setFolioNote] = useState("");
  const [emailDraft, setEmailDraft] = useState<{ invoiceId: string; to: string; subject: string; body: string } | null>(null);

  async function refresh() {
    const [reservationResponse, invoiceResponse] = await Promise.all([fetchReservations(PROPERTY_ID), fetchInvoices(PROPERTY_ID)]);
    setReservations(reservationResponse);
    setInvoices(invoiceResponse);
    void fetchInvoiceBranding(PROPERTY_ID)
      .then((b) => {
        setLogoUrl(b.logoUrl ?? "");
        setLegalFooter(b.legalFooter ?? "");
      })
      .catch(() => undefined);
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
      const draft = await createInvoiceDraft({
        propertyId: PROPERTY_ID,
        invoiceType,
        customerType,
        customerTaxId: customerTaxId || undefined,
        total: Number(draftTotal),
        taxTotal: Number(draftTaxTotal)
      });
      setInvoices((current) => [draft, ...current]);
      setStatus(`Borrador ${draft.id} creado. La emisión requiere permiso invoice.issue y confirmación.`);
      showToast(`Borrador ${draft.id} creado`, { variant: "success" });
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
      setInvoices((current) => current.map((invoice) => (invoice.id === issued.id ? issued : invoice)));
      setStatus(`Factura ${issued.invoiceNumber ?? issued.id} emitida con huella VeriFactu.`);
      showToast(`Factura ${issued.invoiceNumber ?? issued.id} emitida`, { variant: "success" });
    } catch (error) {
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
      // The backend does not yet expose a "paid" sub-state in InvoiceDraft.status,
      // so we keep a local set of paid ids to drive the KPIs and the tabs.
      setPaidIds((current) => {
        const next = new Set(current);
        next.add(invoiceId);
        writePaidIds(next);
        return next;
      });
      const message = result.alreadyPaid
        ? `Factura ${invoiceId} ya estaba pagada.`
        : `Factura ${invoiceId} marcada como pagada (${result.paidAmount} / ${result.invoiceTotal}).`;
      setStatus(message);
      showToast(message, { variant: "success" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "No se pudo marcar como pagada.";
      // Fallback: keep local UI mark so the operator can continue working even
      // if the backend endpoint is unreachable.
      setPaidIds((current) => {
        const next = new Set(current);
        next.add(invoiceId);
        writePaidIds(next);
        return next;
      });
      setStatus(message);
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
        if (paidIds.has(inv.id)) {
          counts.paid += 1;
          totals.paid += amount;
        } else {
          counts.pending += 1;
          totals.pending += amount;
        }
      } else if (inv.status === "cancelled" || inv.status === "rectified") {
        // rectificadas se agrupan visualmente con anuladas
        counts.cancelled += 1;
        totals.cancelled += amount;
      }
    }
    return { counts, totals };
  }, [invoices, paidIds]);

  const filteredInvoices = useMemo(() => {
    const term = search.trim().toLowerCase();
    return invoices.filter((inv) => {
      if (activeTab === "draft" && inv.status !== "draft") return false;
      if (activeTab === "issued" && inv.status !== "issued") return false;
      if (activeTab === "cancelled" && inv.status !== "cancelled" && inv.status !== "rectified") return false;
      if (activeTab === "pending" && !(inv.status === "issued" && !paidIds.has(inv.id))) return false;
      if (activeTab === "paid" && !(inv.status === "issued" && paidIds.has(inv.id))) return false;
      if (!term) return true;
      const haystack = [inv.invoiceNumber ?? "", inv.id, inv.customerTaxId ?? "", inv.invoiceType, inv.customerType, String(inv.total)]
        .join(" ")
        .toLowerCase();
      return haystack.includes(term);
    });
  }, [invoices, search, activeTab, paidIds]);

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
      { key: "total", label: "Total" },
      { key: "taxTotal", label: "IVA" },
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
        render: (row) => <strong>{row.invoiceNumber ?? row.id}</strong>
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
          const uiStatus = deriveInvoiceUiStatus(row, paidIds);
          return (
            <StatusBadge variant={statusBadgeVariant(uiStatus)} size="sm">
              {statusBadgeLabel(uiStatus)}
            </StatusBadge>
          );
        }
      },
      {
        key: "actions",
        label: "Acciones",
        align: "right",
        render: (row) => {
          const isPaid = row.status === "issued" && paidIds.has(row.id);
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
              {row.status === "issued" && !isPaid ? (
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
    [paidIds]
  );

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
                      onClick={() => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "FolioRoutingScreen" }))}
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
            <h3>Invoice draft</h3>
            <span className="bo-chip">POST /invoices/drafts</span>
          </div>
          <div className="bo-grid two">
            <label className="bo-form-field">
              <span>Invoice type</span>
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
              <span>Customer type</span>
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
            <label className="bo-form-field">
              <span>Total</span>
              <CocoaInput
                value={draftTotal}
                onChange={setDraftTotal}
                type="number"
                inputMode="decimal"
              />
            </label>
            <label className="bo-form-field">
              <span>Tax total</span>
              <CocoaInput
                value={draftTaxTotal}
                onChange={setDraftTaxTotal}
                type="number"
                inputMode="decimal"
              />
            </label>
          </div>
          <label className="bo-form-field">
            <span>Customer tax ID</span>
            <CocoaInput value={customerTaxId} onChange={setCustomerTaxId} />
          </label>
          <div className="bo-actions">
            <CocoaButton variant="filled" tone="accent" onClick={handleCreateDraft}>
              Create invoice draft
            </CocoaButton>
            <CocoaButton
              variant="plain"
              onClick={() => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "FinanceComplianceSetupForm" }))}
            >
              Configure invoice sequences
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

        <CocoaTable<InvoiceDraft>
          columns={invoiceColumns}
          rows={filteredInvoices}
          rowKey="id"
          emptyState="No hay facturas que coincidan con el filtro o búsqueda."
        />
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
                <CocoaButton
                  variant="filled"
                  tone="accent"
                  onClick={() => void handleIssue(preview.id)}
                >
                  Emitir factura
                </CocoaButton>
              ) : null}
              {preview.status === "issued" && !paidIds.has(preview.id) ? (
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
              {preview.issuer?.address ? <div className="bo-muted">{preview.issuer.address}</div> : null}
            </div>
            <div style={{ textAlign: "right" }}>
              <div><strong>Factura {preview.invoiceNumber ?? preview.id}</strong></div>
              <div className="bo-muted">Tipo {preview.invoiceType} · {preview.customerType}</div>
              {preview.issuedAt ? <div className="bo-muted">Emitida: {new Date(preview.issuedAt).toLocaleDateString("es-ES")}</div> : null}
              {preview.customerTaxId ? <div className="bo-muted">Cliente NIF: {preview.customerTaxId}</div> : null}
            </div>
          </div>

          <table className="bo-table" style={{ marginTop: "var(--cocoa-space-3)" }}>
            <thead><tr><th>Descripción</th><th style={{ textAlign: "right" }}>Cant.</th><th style={{ textAlign: "right" }}>Precio</th><th>Imp.</th><th style={{ textAlign: "right" }}>Total</th></tr></thead>
            <tbody>
              {preview.lines.map((line, i) => (
                <tr key={line.id ?? i}>
                  <td>{line.description}</td>
                  <td style={{ textAlign: "right" }}>{line.quantity}</td>
                  <td style={{ textAlign: "right" }}>{line.unitPrice}</td>
                  <td>{line.taxCode} ({line.taxRate}%)</td>
                  <td style={{ textAlign: "right" }}>{line.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ textAlign: "right", marginTop: "var(--cocoa-space-2)" }}>
            <div className="bo-muted">IVA: {fmtEur(preview.taxTotal)}</div>
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

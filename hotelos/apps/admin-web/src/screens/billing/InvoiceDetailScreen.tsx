import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchInvoice,
  markInvoicePaid,
  sendInvoiceEmail,
  type InvoiceFull
} from "../../services/pmsCommerceApi";
import { useToast } from "../../components/Toast";
import { logBreadcrumb } from "../../lib/breadcrumb";
// TODO(cocoa): need CocoaStatusBadge — fallback to Aurora v2 StatusBadge.
import { StatusBadge } from "../../components/v2/StatusBadge";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { CocoaCard } from "../../components/cocoa/CocoaCard";
import { CocoaTable, type CocoaTableColumn } from "../../components/cocoa/CocoaTable";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaInput } from "../../components/cocoa/CocoaInput";
import {
  statusBadgeLabel,
  statusBadgeVariant,
  type InvoiceUiStatus
} from "./invoiceStatus";

// --- helpers ---------------------------------------------------------------

// Money formatting: invoice totals are stored as numbers (EUR). Use Intl with
// es-ES to render "1.234,56 €" — keeps the UI consistent with the rest of the
// PMS (PropertyDetailScreen, FinancePositionDashboard).
function fmtMoney(value: number | null | undefined, currency = "EUR"): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

function fmtNumber(value: number | null | undefined, opts?: Intl.NumberFormatOptions): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("es-ES", { useGrouping: true, ...opts }).format(value);
}

function fmtDate(value?: string): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleDateString("es-ES");
  } catch {
    return value;
  }
}

// Reads the target invoice id from the current URL. We use the same convention
// as ReservationDetailWorkspaceScreen — last path segment, guarded by a regex
// so a misconfigured route never silently surfaces an unrelated invoice.
function readInvoiceIdFromUrl(): string {
  if (typeof window === "undefined") return "";
  const last = window.location.pathname.split("/").filter(Boolean).at(-1) ?? "";
  // accept "inv_…" or "invoice_…" or raw cuids — be permissive but skip
  // obviously non-id slugs ("detail", "billing", numerics with letters).
  if (/^(inv|invoice)_/.test(last)) return last;
  if (last.length >= 10 && /^[A-Za-z0-9_-]+$/.test(last)) return last;
  return "";
}

// Same persistence trick BillingCenterScreen uses for the UI-only "paid" mark.
// We import / write to the same session-storage key so toggling between the
// list and the detail keeps state consistent within a session.
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
    // ignore quota / private-mode errors
  }
}

// --- screen ----------------------------------------------------------------

type InvoiceLine = InvoiceFull["lines"][number];

type LineRow = InvoiceLine & {
  // CocoaTable needs a stable rowKey — fall back to index-based id if the
  // backend omits the line id (it is optional in the response shape).
  _rowKey: string;
  _subtotal: number;
};

export function InvoiceDetailScreen() {
  const { showToast } = useToast();
  const [invoiceId] = useState<string>(() => readInvoiceIdFromUrl());
  const [invoice, setInvoice] = useState<InvoiceFull | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(invoiceId));
  const [error, setError] = useState<string>("");
  const [paidIds, setPaidIds] = useState<Set<string>>(() => readPaidIds());
  const [emailDialog, setEmailDialog] = useState<{
    to: string;
    subject: string;
    body: string;
  } | null>(null);
  const [sending, setSending] = useState(false);
  const [markingPaid, setMarkingPaid] = useState(false);

  const refresh = useCallback(async () => {
    if (!invoiceId) return;
    setLoading(true);
    setError("");
    try {
      const full = await fetchInvoice(invoiceId);
      setInvoice(full);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar la factura.");
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Derived UI status combines server status with the session-local "paid" flag.
  // Order matters: cancelled / rectified take precedence over a stale paid mark.
  const uiStatus = useMemo<InvoiceUiStatus>(() => {
    if (!invoice) return "draft";
    if (invoice.status === "cancelled") return "cancelled";
    if (invoice.status === "rectified") return "rectified";
    if (invoice.status === "issued") return paidIds.has(invoice.id) ? "paid" : "issued";
    return "draft";
  }, [invoice, paidIds]);

  const currency = (invoice?.lines?.[0] as { currency?: string } | undefined)?.currency ?? "EUR";

  // Build the table rows once (lines are usually small but memoizing prevents
  // re-renders cascading from the email dialog state).
  const rows = useMemo<LineRow[]>(() => {
    if (!invoice?.lines) return [];
    return invoice.lines.map((line, idx) => ({
      ...line,
      _rowKey: line.id ?? `line-${idx}`,
      _subtotal: Number(line.quantity) * Number(line.unitPrice)
    }));
  }, [invoice]);

  // Tax breakdown: group lines by VAT rate and sum the taxable base + tax.
  // The backend already provides taxRate per line, so we don't need to read
  // tax-zone configuration here.
  const taxBreakdown = useMemo(() => {
    const map = new Map<string, { rate: number; base: number; tax: number; code: string }>();
    for (const line of rows) {
      const rate = Number(line.taxRate) || 0;
      const key = `${line.taxCode ?? ""}:${rate}`;
      const lineTotal = Number(line.total) || 0;
      // line.total includes tax — derive base & tax components from the rate.
      const base = rate > 0 ? lineTotal / (1 + rate / 100) : lineTotal;
      const tax = lineTotal - base;
      const current = map.get(key) ?? { rate, base: 0, tax: 0, code: line.taxCode ?? "" };
      current.base += base;
      current.tax += tax;
      map.set(key, current);
    }
    return Array.from(map.values()).sort((a, b) => a.rate - b.rate);
  }, [rows]);

  const subtotal = useMemo(() => {
    return taxBreakdown.reduce((sum, t) => sum + t.base, 0);
  }, [taxBreakdown]);

  // --- columns for the line items CocoaTable ------------------------------
  const columns = useMemo<CocoaTableColumn<LineRow>[]>(
    () => [
      {
        key: "description",
        label: "Descripción",
        render: (row) => <strong>{row.description}</strong>
      },
      {
        key: "quantity",
        label: "Cant.",
        align: "right",
        width: "80px",
        render: (row) => fmtNumber(row.quantity, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
      },
      {
        key: "unitPrice",
        label: "Precio",
        align: "right",
        width: "120px",
        render: (row) => fmtMoney(row.unitPrice, currency)
      },
      {
        key: "tax",
        label: "IVA",
        align: "right",
        width: "100px",
        render: (row) => `${row.taxCode ?? "—"} (${fmtNumber(row.taxRate, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%)`
      },
      {
        key: "subtotal",
        label: "Subtotal",
        align: "right",
        width: "140px",
        render: (row) => fmtMoney(row.total, currency)
      }
    ],
    [currency]
  );

  // Tax breakdown columns
  type TaxRow = { rate: number; base: number; tax: number; code: string; _key: string };
  const taxRows = useMemo<TaxRow[]>(
    () =>
      taxBreakdown.map((t, idx) => ({
        ...t,
        _key: `${t.code}-${t.rate}-${idx}`
      })),
    [taxBreakdown]
  );

  const taxColumns = useMemo<CocoaTableColumn<TaxRow>[]>(
    () => [
      {
        key: "code",
        label: "Código",
        render: (row) => row.code || "—"
      },
      {
        key: "rate",
        label: "Tipo",
        align: "right",
        render: (row) => `${fmtNumber(row.rate, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%`
      },
      {
        key: "base",
        label: "Base imponible",
        align: "right",
        render: (row) => fmtMoney(row.base, currency)
      },
      {
        key: "tax",
        label: "Importe IVA",
        align: "right",
        render: (row) => fmtMoney(row.tax, currency)
      }
    ],
    [currency]
  );

  // --- actions -----------------------------------------------------------

  function handlePrint() {
    logBreadcrumb("invoice.print", "ui", { invoiceId });
    window.print();
  }

  function handleOpenEmailDialog() {
    if (!invoice) return;
    const number = invoice.invoiceNumber ?? invoice.id;
    setEmailDialog({
      to: "",
      subject: `Factura ${number}`,
      body: `Estimado cliente,\n\nAdjuntamos la factura ${number} por importe de ${fmtMoney(invoice.total, currency)}.\n\nGracias por su confianza.`
    });
  }

  async function handleSendEmail() {
    if (!invoice || !emailDialog) return;
    const recipient = emailDialog.to.trim();
    if (!recipient) {
      showToast("Indique al menos un destinatario.", { variant: "error" });
      return;
    }
    setSending(true);
    logBreadcrumb("invoice.email.send", "mutation", { invoiceId: invoice.id });
    try {
      await sendInvoiceEmail(invoice.id, {
        recipient,
        subject: emailDialog.subject,
        message: emailDialog.body
      });
      showToast(`Email enviado a ${recipient}`, { variant: "success" });
      setEmailDialog(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "No se pudo enviar el email.";
      showToast(message, { variant: "error" });
    } finally {
      setSending(false);
    }
  }

  async function handleMarkPaid() {
    if (!invoice) return;
    setMarkingPaid(true);
    logBreadcrumb("invoice.markPaid", "mutation", { invoiceId: invoice.id });
    try {
      await markInvoicePaid(invoice.id);
      // server source of truth: the linked folio now has a captured payment.
      // Mirror the optimistic UI flag the BillingCenterScreen also uses so the
      // list view stays in sync within this session.
      setPaidIds((current) => {
        const next = new Set(current);
        next.add(invoice.id);
        writePaidIds(next);
        return next;
      });
      showToast(`Factura ${invoice.invoiceNumber ?? invoice.id} marcada como pagada`, { variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "No se pudo marcar la factura como pagada.";
      showToast(message, { variant: "error" });
    } finally {
      setMarkingPaid(false);
    }
  }

  function handleRectifyPlaceholder() {
    logBreadcrumb("invoice.rectify.intent", "ui", { invoiceId });
    showToast(
      "La generación de factura rectificativa estará disponible en Q3. Use el flujo de rectificación en el centro de facturas.",
      { variant: "info" }
    );
  }

  function handleBack() {
    window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "BillingCenter" }));
  }

  // --- empty / error states ---------------------------------------------

  if (!invoiceId) {
    return (
      <section className="bo-card">
        <CocoaPageHeader
          title="Detalle de factura"
          actions={
            <CocoaButton variant="plain" onClick={handleBack}>
              ← Volver al centro de facturas
            </CocoaButton>
          }
        />
        <p
          className="bo-muted"
          style={{ marginTop: "var(--cocoa-space-4)" }}
        >
          No se ha indicado ninguna factura en la URL. Abra una factura desde el centro de facturas para ver su detalle.
        </p>
      </section>
    );
  }

  if (loading && !invoice) {
    return (
      <section className="bo-card">
        <CocoaPageHeader
          title="Detalle de factura"
          actions={
            <CocoaButton variant="plain" onClick={handleBack}>
              ← Volver
            </CocoaButton>
          }
        />
        <p
          className="bo-muted"
          style={{ marginTop: "var(--cocoa-space-4)" }}
        >
          Cargando factura {invoiceId}…
        </p>
      </section>
    );
  }

  if (error && !invoice) {
    return (
      <section className="bo-card">
        <CocoaPageHeader
          title="Detalle de factura"
          actions={
            <CocoaButton variant="plain" onClick={handleBack}>
              ← Volver
            </CocoaButton>
          }
        />
        <p
          style={{
            color: "var(--cocoa-danger)",
            marginTop: "var(--cocoa-space-4)"
          }}
        >
          {error}
        </p>
        <div className="bo-actions">
          <CocoaButton variant="plain" onClick={() => void refresh()}>
            Reintentar
          </CocoaButton>
        </div>
      </section>
    );
  }

  if (!invoice) {
    return null;
  }

  // --- render ------------------------------------------------------------

  const number = invoice.invoiceNumber ?? invoice.id;
  const customerLabel = invoice.customerType === "guest"
    ? "Huésped"
    : invoice.customerType === "company"
    ? "Empresa"
    : invoice.customerType === "agency"
    ? "Agencia"
    : invoice.customerType;
  const issuerName = invoice.issuer?.legalName ?? invoice.issuer?.propertyName ?? "Emisor desconocido";

  return (
    <section
      className="bo-card"
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--cocoa-space-5)"
      }}
    >
      <div>
        <CocoaButton variant="plain" onClick={handleBack}>
          ← Volver al centro de facturas
        </CocoaButton>
      </div>

      <CocoaPageHeader
        eyebrow="Finanzas · Facturación"
        title={`Factura ${number}`}
        subtitle={`${issuerName} · Cliente: ${invoice.customerTaxId ?? "—"} (${customerLabel})`}
        actions={
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "var(--cocoa-space-2)"
            }}
          >
            <StatusBadge variant={statusBadgeVariant(uiStatus)} size="md">
              {statusBadgeLabel(uiStatus)}
            </StatusBadge>
            {invoice.status === "issued" && uiStatus !== "paid" ? (
              <CocoaButton
                variant="filled"
                tone="accent"
                onClick={() => void handleMarkPaid()}
                disabled={markingPaid}
                loading={markingPaid}
              >
                Marcar pagada
              </CocoaButton>
            ) : null}
            <CocoaButton
              variant="plain"
              onClick={handleOpenEmailDialog}
              disabled={invoice.status === "draft"}
            >
              Enviar por email
            </CocoaButton>
          </span>
        }
      />

      {/* --- Action toolbar (hidden in print via styles.css "button" rule) --- */}
      <div
        className="bo-actions"
        style={{ flexWrap: "wrap", display: "flex", gap: "var(--cocoa-space-2)" }}
      >
        <CocoaButton variant="plain" onClick={handlePrint}>
          Imprimir / Descargar PDF
        </CocoaButton>
        {invoice.status === "issued" ? (
          <CocoaButton
            variant="filled"
            tone="destructive"
            onClick={handleRectifyPlaceholder}
            aria-label="Generar rectificativa (disponible en Q3)"
          >
            Generar rectificativa
          </CocoaButton>
        ) : null}
        <CocoaButton variant="plain" onClick={() => void refresh()}>
          Refrescar
        </CocoaButton>
      </div>

      {/* --- Issuer / customer block (printable) --- */}
      <div className="bo-grid two">
        <CocoaCard variant="bordered" padding="md">
          <p
            style={{
              marginTop: 0,
              color: "var(--cocoa-label-secondary)",
              fontSize: "var(--cocoa-fs-caption)",
              textTransform: "uppercase",
              letterSpacing: "var(--cocoa-tracking-wide)"
            }}
          >
            Emisor
          </p>
          {invoice.issuer?.logoUrl ? (
            <img
              src={invoice.issuer.logoUrl}
              alt="Logo emisor"
              style={{
                maxHeight: 56,
                maxWidth: 220,
                objectFit: "contain",
                marginBottom: "var(--cocoa-space-2)"
              }}
            />
          ) : null}
          <div><strong>{issuerName}</strong></div>
          {invoice.issuer?.taxId ? (
            <div style={{ color: "var(--cocoa-label-secondary)" }}>
              NIF/CIF: {invoice.issuer.taxId}
            </div>
          ) : null}
          {invoice.issuer?.address ? (
            <div style={{ color: "var(--cocoa-label-secondary)" }}>
              {invoice.issuer.address}
            </div>
          ) : null}
        </CocoaCard>
        <CocoaCard variant="bordered" padding="md">
          <p
            style={{
              marginTop: 0,
              color: "var(--cocoa-label-secondary)",
              fontSize: "var(--cocoa-fs-caption)",
              textTransform: "uppercase",
              letterSpacing: "var(--cocoa-tracking-wide)"
            }}
          >
            Cliente y emisión
          </p>
          <div><strong>{customerLabel}</strong></div>
          {invoice.customerTaxId ? (
            <div style={{ color: "var(--cocoa-label-secondary)" }}>
              NIF/CIF cliente: {invoice.customerTaxId}
            </div>
          ) : null}
          <div style={{ color: "var(--cocoa-label-secondary)" }}>
            Tipo factura: {invoice.invoiceType}
          </div>
          {invoice.issuedAt ? (
            <div style={{ color: "var(--cocoa-label-secondary)" }}>
              Fecha emisión: {fmtDate(invoice.issuedAt)}
            </div>
          ) : null}
          {invoice.cancelledAt ? (
            <div style={{ color: "var(--cocoa-label-secondary)" }}>
              Anulada: {fmtDate(invoice.cancelledAt)}
            </div>
          ) : null}
        </CocoaCard>
      </div>

      {/* --- Body: line items CocoaTable --- */}
      <div>
        <h3 style={{ marginBottom: "var(--cocoa-space-3)" }}>Líneas de factura</h3>
        <CocoaTable<LineRow>
          columns={columns}
          rows={rows}
          rowKey="_rowKey"
          emptyState="Esta factura no tiene líneas registradas."
        />
      </div>

      {/* --- Tax breakdown CocoaTable --- */}
      {taxRows.length > 0 ? (
        <div>
          <h3 style={{ marginBottom: "var(--cocoa-space-3)" }}>Desglose de IVA</h3>
          <CocoaTable<TaxRow>
            columns={taxColumns}
            rows={taxRows}
            rowKey="_key"
            emptyState="Sin desglose de IVA."
          />
        </div>
      ) : null}

      {/* --- Totals footer: CocoaCard elevated --- */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: "var(--cocoa-space-4)",
          flexWrap: "wrap"
        }}
      >
        <div style={{ minWidth: 320, flex: "0 1 360px" }}>
          <div className="bo-row">
            <span>Subtotal (base imponible)</span>
            <strong style={{ fontVariantNumeric: "tabular-nums" }}>{fmtMoney(subtotal, currency)}</strong>
          </div>
          <div className="bo-row">
            <span>Total IVA</span>
            <strong style={{ fontVariantNumeric: "tabular-nums" }}>{fmtMoney(invoice.taxTotal, currency)}</strong>
          </div>
          <div className="bo-row">
            <span>Importe pagado</span>
            <strong style={{ fontVariantNumeric: "tabular-nums" }}>
              {fmtMoney(uiStatus === "paid" ? invoice.total : 0, currency)}
            </strong>
          </div>
          <div className="bo-row">
            <span>Saldo pendiente</span>
            <strong style={{ fontVariantNumeric: "tabular-nums" }}>
              {fmtMoney(uiStatus === "paid" ? 0 : invoice.total, currency)}
            </strong>
          </div>
        </div>
        <CocoaCard variant="elevated" padding="lg">
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: "var(--cocoa-space-1)",
              minWidth: 220
            }}
          >
            <span
              style={{
                color: "var(--cocoa-label-secondary)",
                textTransform: "uppercase",
                letterSpacing: "var(--cocoa-tracking-wide)",
                fontSize: "var(--cocoa-fs-caption)"
              }}
            >
              Total factura
            </span>
            <strong
              style={{
                fontSize: "var(--cocoa-fs-large-title)",
                lineHeight: 1,
                fontVariantNumeric: "tabular-nums",
                color: "var(--cocoa-accent)"
              }}
            >
              {fmtMoney(invoice.total, currency)}
            </strong>
            <span style={{ color: "var(--cocoa-label-secondary)" }}>{currency}</span>
          </div>
        </CocoaCard>
      </div>

      {invoice.verifactuHash ? (
        <p
          style={{
            wordBreak: "break-all",
            color: "var(--cocoa-label-secondary)",
            fontSize: "var(--cocoa-fs-caption)"
          }}
        >
          VERI*FACTU huella: {invoice.verifactuHash}
        </p>
      ) : null}

      {invoice.issuer?.legalFooter ? (
        <div
          style={{
            marginTop: "var(--cocoa-space-2)",
            paddingTop: "var(--cocoa-space-3)",
            borderTop: "1px solid var(--cocoa-separator)",
            whiteSpace: "pre-wrap",
            fontSize: "var(--cocoa-fs-caption)",
            color: "var(--cocoa-label-secondary)"
          }}
        >
          {invoice.issuer.legalFooter}
        </div>
      ) : null}

      {/* --- Send-by-email dialog --- */}
      {emailDialog ? (
        <section
          className="bo-card"
          style={{ background: "var(--cocoa-background-content)" }}
        >
          <div className="bo-card-head">
            <h3>Enviar factura por email</h3>
            <CocoaButton
              variant="plain"
              onClick={() => setEmailDialog(null)}
              disabled={sending}
            >
              Cerrar
            </CocoaButton>
          </div>
          <label className="bo-form-field">
            <span>Destinatario</span>
            <CocoaInput
              type="email"
              inputMode="email"
              value={emailDialog.to}
              placeholder="cliente@dominio.com"
              onChange={(value) => setEmailDialog({ ...emailDialog, to: value })}
              disabled={sending}
            />
          </label>
          <label className="bo-form-field">
            <span>Asunto</span>
            <CocoaInput
              value={emailDialog.subject}
              onChange={(value) => setEmailDialog({ ...emailDialog, subject: value })}
              disabled={sending}
            />
          </label>
          <label className="bo-form-field">
            <span>Mensaje</span>
            <textarea
              rows={6}
              value={emailDialog.body}
              onChange={(event) => setEmailDialog({ ...emailDialog, body: event.target.value })}
              disabled={sending}
            />
          </label>
          <div
            className="bo-actions"
            style={{ display: "flex", gap: "var(--cocoa-space-2)" }}
          >
            <CocoaButton
              variant="filled"
              tone="accent"
              onClick={() => void handleSendEmail()}
              disabled={sending}
              loading={sending}
            >
              Enviar
            </CocoaButton>
            <CocoaButton
              variant="plain"
              onClick={() => setEmailDialog(null)}
              disabled={sending}
            >
              Cancelar
            </CocoaButton>
          </div>
        </section>
      ) : null}
    </section>
  );
}

export default InvoiceDetailScreen;

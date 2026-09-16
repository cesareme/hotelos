// Rectificativas — Finanzas › Facturación y cobros › Rectificativas
// (/finanzas/facturacion/rectificativas). Cocoa 22 · lote 6-A, archetype
// «dashboard alojado» (docs/design/COCOA-22.md §4).
//
// Audit trail of the facturas rectificativas (RD 1619/2012 art. 15; VeriFactu
// TipoRectificativa I/S) issued by the property: KPI strip (this month, total,
// by reason R1–R5), the list linked to their originals with «Descargar PDF»
// (GET /invoices/:id/pdf as a Blob) and the drawer that issues a new one
// (InvoiceRectifyDialog → POST /invoices/:id/rectify). Reads the enveloped
// GET /properties/:id/invoices; `?factura=<id>` in the URL opens the drawer
// with that original preselected (BillingCenter links here).

import { useEffect, useMemo, useState } from "react";
import { fetchInvoices, getInvoicePdf, type InvoiceDraft, type InvoiceFull, type RectifyingReasonCode } from "../../services/pmsCommerceApi";
import { financeErrorMessage } from "../../services/finance-contracts";
import { getActiveProperty } from "../../services/activeProperty";
import { useToast } from "../../components/Toast";
import { saveBlob } from "../../components/billing/download";
import { date, isoDate, money, plural } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS } from "../../content/actions";
import { useTabHost } from "../tabs/TabHost";
import { deriveInvoiceUiStatus, invoiceStatusLabel, invoiceStatusTone } from "../billing/invoiceStatus";
import { InvoiceRectifyDialog, RECTIFYING_REASON_LABELS } from "./InvoiceRectifyDialog";
import {
  CocoaBadge,
  CocoaButton,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn
} from "../../components/cocoa";

// Rows per page (API caps at 500); «Cargar más» walks the cursor.
const PAGE_SIZE = 200;

const REASON_SHORT: Record<RectifyingReasonCode, string> = {
  R1: "Error en derecho",
  R2: "Concurso",
  R3: "Incobrables",
  R4: "Otras causas",
  R5: "Simplificadas"
};

const REASON_CODES: RectifyingReasonCode[] = ["R1", "R2", "R3", "R4", "R5"];

function isReasonCode(value: unknown): value is RectifyingReasonCode {
  return typeof value === "string" && (REASON_CODES as string[]).includes(value);
}

/** A rectificativa: it points at an original or its type is R1–R5. */
export function isRectifying(invoice: Pick<InvoiceDraft, "rectifyingForId" | "invoiceType">): boolean {
  return Boolean(invoice.rectifyingForId) || isReasonCode(invoice.invoiceType);
}

function reasonOf(invoice: InvoiceDraft): RectifyingReasonCode | null {
  if (isReasonCode(invoice.rectifyingReasonCode)) return invoice.rectifyingReasonCode;
  return isReasonCode(invoice.invoiceType) ? invoice.invoiceType : null;
}

function firstOfMonthIso(now = new Date()): string {
  return isoDate(new Date(now.getFullYear(), now.getMonth(), 1, 12)) ?? "";
}

/** `?factura=` of the current URL (BillingCenter links here with the original preselected). */
function invoiceFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("factura");
  return value && value.trim() ? value.trim() : null;
}

export function InvoiceRectificationsScreen() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const property = getActiveProperty();
  const [invoices, setInvoices] = useState<InvoiceDraft[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState<{ open: boolean; invoiceId?: string }>(() => {
    const preset = invoiceFromUrl();
    return preset ? { open: true, invoiceId: preset } : { open: false };
  });
  const [downloading, setDownloading] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const page = await fetchInvoices(property.propertyId, { limit: PAGE_SIZE });
      setInvoices(page.items);
      setNextCursor(page.nextCursor);
      setTotal(page.total);
    } catch (err) {
      setError(financeErrorMessage(err, "No se pudieron cargar las facturas."));
    } finally {
      setLoading(false);
    }
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchInvoices(property.propertyId, { limit: PAGE_SIZE, cursor: nextCursor });
      setInvoices((current) => {
        const seen = new Set(current.map((invoice) => invoice.id));
        return [...current, ...page.items.filter((invoice) => !seen.has(invoice.id))];
      });
      setNextCursor(page.nextCursor);
      setTotal(page.total);
    } catch (err) {
      showToast(financeErrorMessage(err, "No se pudieron cargar más facturas."), { variant: "error" });
    } finally {
      setLoadingMore(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [property.propertyId]);

  const rectifying = useMemo(() => invoices.filter(isRectifying), [invoices]);
  const originalsById = useMemo(() => new Map(invoices.map((invoice) => [invoice.id, invoice])), [invoices]);
  const candidates = useMemo(() => invoices.filter((invoice) => invoice.status === "issued" && !isRectifying(invoice)), [invoices]);
  const monthStart = useMemo(() => firstOfMonthIso(), []);
  const thisMonth = useMemo(() => rectifying.filter((invoice) => (isoDate(invoice.issuedAt) ?? "") >= monthStart), [rectifying, monthStart]);
  const byReason = useMemo(() => {
    const counts: Record<RectifyingReasonCode, number> = { R1: 0, R2: 0, R3: 0, R4: 0, R5: 0 };
    for (const invoice of rectifying) {
      const code = reasonOf(invoice);
      if (code) counts[code] += 1;
    }
    return counts;
  }, [rectifying]);
  const negativeTotal = useMemo(() => rectifying.reduce((sum, invoice) => sum + (Number(invoice.total) || 0), 0), [rectifying]);
  const topReason = useMemo(() => REASON_CODES.reduce<RectifyingReasonCode | null>((best, code) => (byReason[code] > 0 && (best === null || byReason[code] > byReason[best]) ? code : best), null), [byReason]);

  async function download(invoice: InvoiceDraft) {
    setDownloading(invoice.id);
    try {
      const pdf = await getInvoicePdf(invoice.id, { download: true });
      saveBlob(pdf.blob, pdf.filename);
    } catch (err) {
      showToast(financeErrorMessage(err, "No se pudo descargar el PDF."), { variant: "error" });
    } finally {
      setDownloading(null);
    }
  }

  const columns = useMemo<CocoaTableColumn<InvoiceDraft>[]>(
    () => [
      // qa#2: identifiers, dates, amounts and badges fit their content on one line;
      // «Motivo» keeps a floor and the secondary columns only show from 1200 px.
      { key: "invoiceNumber", label: "Rectificativa", fit: true, render: (invoice) => <strong>{invoice.invoiceNumber ?? invoice.id}</strong> },
      {
        key: "original",
        label: "Rectifica a",
        fit: true,
        render: (invoice) => {
          const original = invoice.rectifyingForId ? originalsById.get(invoice.rectifyingForId) : undefined;
          return original?.invoiceNumber ?? invoice.rectifyingForId ?? "—";
        }
      },
      {
        key: "reason",
        label: "Motivo",
        render: (invoice) => {
          const code = reasonOf(invoice);
          return code ? <span title={RECTIFYING_REASON_LABELS[code]}>{`${code} · ${REASON_SHORT[code]}`}</span> : "—";
        },
        minWidth: 160,
        hideOnNarrow: true
      },
      {
        key: "rectificationType",
        label: "Modalidad",
        fit: true,
        showFrom: "desktop",
        render: (invoice) => (invoice.rectificationType === "S" ? "Sustitución (S)" : invoice.rectificationType === "I" ? "Diferencias (I)" : "—")
      },
      { key: "issuedAt", label: FIELD_LABELS.date, fit: true, showFrom: "desktop", render: (invoice) => date(invoice.issuedAt, "medium") },
      { key: "customer", label: "Cliente", showFrom: "desktop", render: (invoice) => invoice.customerName ?? invoice.customerTaxId ?? "—" },
      { key: "total", label: FIELD_LABELS.total, align: "right", fit: true, render: (invoice) => <strong>{money(invoice.total, invoice.currencyCode)}</strong> },
      {
        key: "status",
        label: FIELD_LABELS.status,
        fit: true,
        render: (invoice) => {
          const status = deriveInvoiceUiStatus(invoice);
          return <CocoaBadge tone={invoiceStatusTone(status)}>{invoiceStatusLabel(status)}</CocoaBadge>;
        }
      }
    ],
    [originalsById]
  );

  const ready = !loading && !error;
  const newLabelText = "Nueva rectificativa";

  return (
    <CocoaPage
      eyebrow={`Finanzas · ${property.propertyName}`}
      title="Rectificativas"
      subtitle={hosted ? undefined : "Facturas rectificativas emitidas (motivo AEAT R1–R5, por diferencias o por sustitución), enlazadas a su original y con huella VeriFactu propia."}
      actions={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void load()} disabled={loading}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" disabled={loading || candidates.length === 0} title={candidates.length === 0 ? "No hay facturas emitidas que rectificar" : undefined} onClick={() => setDrawer({ open: true })}>
            {newLabelText}
          </CocoaButton>
        </>
      }
      state={loading && invoices.length === 0 ? "loading" : error && invoices.length === 0 ? "error" : "ready"}
      skeleton={
        <div className="cocoa-stack" data-gap="4" aria-hidden="true">
          <CocoaSkeleton.Strip count={4} />
          <CocoaSkeleton.Grid rows={[[12]]} height={240} />
        </div>
      }
      error={{ title: STATUS_LABELS.loadError, message: error ?? undefined, onRetry: () => void load() }}
      commands={[{ id: "rectificativas-nueva", label: newLabelText, run: () => setDrawer({ open: true }) }]}
    >
      <CocoaKpiStrip stagger aria-label="Indicadores de rectificativas">
        <CocoaKpi label="Este mes" value={thisMonth.length} unit={plural(thisMonth.length, "rectificativa", "rectificativas", { withCount: false })} polarity="neutral" />
        <CocoaKpi label="Total emitidas" value={rectifying.length} caption={total !== null && total > invoices.length ? `de ${invoices.length} facturas cargadas` : undefined} polarity="neutral" />
        <CocoaKpi label="Importe rectificado" value={money(negativeTotal)} polarity="neutral" status={negativeTotal < 0 ? "warning" : "ok"} />
        {/* The figure is the AEAT code alone (the 32 px value line is nowrap); the reason text travels in the caption so it never truncates the tile (qa#7). */}
        <CocoaKpi label="Motivo más frecuente" value={topReason ?? "—"} caption={topReason ? `${REASON_SHORT[topReason]} · ${plural(byReason[topReason], "factura", "facturas")}` : undefined} polarity="neutral" />
      </CocoaKpiStrip>

      <CocoaSection
        title="Rectificativas emitidas"
        meta={ready ? plural(rectifying.length, "factura", "facturas") : undefined}
        padding={ready && rectifying.length > 0 ? "none" : "md"}
        style={{ overflow: "clip" }}
        footer={
          ready && rectifying.length > 0 ? (
            <>
              <span>
                {rectifying.length} rectificativas sobre {invoices.length}
                {total !== null && total > invoices.length ? ` de ${total}` : ""} facturas
              </span>
              {nextCursor ? (
                <CocoaButton variant="bordered" tone="neutral" size="small" loading={loadingMore} onClick={() => void loadMore()}>
                  Cargar más
                </CocoaButton>
              ) : null}
            </>
          ) : undefined
        }
      >
        {error ? (
          <CocoaState kind="error" title="No se pudieron cargar las facturas" message={error} onRetry={() => void load()} />
        ) : loading ? (
          <CocoaTable columns={columns} rows={[]} loading aria-label="Rectificativas" />
        ) : rectifying.length === 0 ? (
          <CocoaState
            kind="empty"
            illustration="box"
            title="Sin rectificativas"
            message="Ninguna factura emitida ha sido rectificada todavía. Una rectificativa se emite siempre desde la factura original."
            primaryAction={candidates.length > 0 ? { label: newLabelText, onClick: () => setDrawer({ open: true }) } : undefined}
          />
        ) : (
          <CocoaTable
            columns={columns}
            rows={rectifying}
            rowKey="id"
            caption="Facturas rectificativas"
            aria-label="Facturas rectificativas"
            rowActions={(invoice) => (
              <CocoaButton
                variant="plain"
                size="small"
                loading={downloading === invoice.id}
                onClick={(event) => {
                  event.stopPropagation();
                  void download(invoice);
                }}
              >
                Descargar PDF
              </CocoaButton>
            )}
          />
        )}
      </CocoaSection>

      <CocoaSection title="Por motivo AEAT" meta="todas las rectificativas cargadas">
        <ul className="c22-section__list">
          {REASON_CODES.map((code) => (
            <li key={code}>
              <span title={RECTIFYING_REASON_LABELS[code]}>
                {code} · {REASON_SHORT[code]}
              </span>
              <strong>{byReason[code]}</strong>
            </li>
          ))}
        </ul>
      </CocoaSection>

      <InvoiceRectifyDialog
        open={drawer.open}
        onClose={() => setDrawer({ open: false })}
        candidates={candidates}
        initialInvoiceId={drawer.invoiceId}
        onRectified={(rectified: InvoiceFull) => {
          setInvoices((current) => [rectified, ...current.map((invoice) => (invoice.id === rectified.rectifyingForId ? { ...invoice, status: "rectified" as const } : invoice))]);
          void load();
        }}
      />
    </CocoaPage>
  );
}

export default InvoiceRectificationsScreen;

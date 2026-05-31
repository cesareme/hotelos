import { getActivePropertyId } from "../../services/activeProperty";
import { useEffect, useMemo, useState } from "react";
import {
  fetchInvoices,
  type InvoiceDraft,
  type InvoiceFull,
  type RectifyingReasonCode
} from "../../services/pmsCommerceApi";
import { InvoiceRectifyDialog } from "./InvoiceRectifyDialog";

const PROPERTY_ID = getActivePropertyId();

const REASON_LABEL: Record<RectifyingReasonCode, string> = {
  R1: "R1 · Error en derecho",
  R2: "R2 · Concurso",
  R3: "R3 · Incobrables",
  R4: "R4 · Otras causas",
  R5: "R5 · Rectif. simplificadas"
};

type RectifyingFlavour = InvoiceDraft & {
  rectifyingForId?: string;
  rectifyingReasonCode?: RectifyingReasonCode;
};

function isRectifying(invoice: InvoiceDraft & { rectifyingForId?: string; invoiceType?: string }): boolean {
  return Boolean((invoice as RectifyingFlavour).rectifyingForId) || /^R[1-5]$/.test(String(invoice.invoiceType ?? ""));
}

function startOfMonth(d = new Date()): Date {
  const m = new Date(d.getFullYear(), d.getMonth(), 1);
  return m;
}

export function InvoiceRectificationsScreen() {
  const [invoices, setInvoices] = useState<RectifyingFlavour[]>([]);
  const [dialogTargetId, setDialogTargetId] = useState<string | null>(null);
  const [status, setStatus] = useState("Loading invoices…");

  async function refresh() {
    try {
      const all = await fetchInvoices(PROPERTY_ID);
      setInvoices(all as RectifyingFlavour[]);
      setStatus(`Loaded ${all.length} invoices.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to load invoices.");
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const rectifying = useMemo(
    () => invoices.filter((i: RectifyingFlavour) => isRectifying(i)),
    [invoices]
  );
  const originalsById = useMemo(() => {
    const map = new Map<string, RectifyingFlavour>();
    for (const inv of invoices) map.set(inv.id, inv);
    return map;
  }, [invoices]);

  const monthStart = useMemo(() => startOfMonth(), []);
  const rectifyingMtd = useMemo(
    () => rectifying.filter((i: RectifyingFlavour) => i.issuedAt && new Date(i.issuedAt) >= monthStart),
    [rectifying, monthStart]
  );

  const countsByReason = useMemo(() => {
    const counts: Record<RectifyingReasonCode, number> = { R1: 0, R2: 0, R3: 0, R4: 0, R5: 0 };
    for (const inv of rectifyingMtd) {
      const code = (inv.rectifyingReasonCode ?? (inv.invoiceType as RectifyingReasonCode)) ?? null;
      if (code && code in counts) counts[code as RectifyingReasonCode] += 1;
    }
    return counts;
  }, [rectifyingMtd]);

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Finance & Compliance · Facturas rectificativas</div>
          <h1 className="bo-page-title">Rectifying invoices</h1>
          <p className="bo-page-subtitle">
            Audit trail and KPIs for *facturas rectificativas* issued under RD 1496/2003 (art. 13–15) and
            RD 87/2005. Every rectifying invoice carries an R1–R5 reason code, a link to the original
            invoice, and an independent VeriFactu hash in the chain.
          </p>
        </div>
      </div>

      <section className="bo-card">
        <div className="bo-card-head">
          <h2>KPIs · month-to-date</h2>
          <span className="bo-chip">Month to date</span>
        </div>
        <div className="bo-grid three">
          <article className="bo-card">
            <span className="bo-muted">Rectificativas MTD</span>
            <div className="bo-metric">{rectifyingMtd.length}</div>
            <p>Issued since {monthStart.toISOString().slice(0, 10)}</p>
          </article>
          <article className="bo-card">
            <span className="bo-muted">Total all-time</span>
            <div className="bo-metric">{rectifying.length}</div>
            <p>Includes rectified originals</p>
          </article>
          <article className="bo-card">
            <span className="bo-muted">By reason (MTD)</span>
            <ul style={{ margin: 0, paddingLeft: "1rem" }}>
              {(Object.keys(countsByReason) as RectifyingReasonCode[]).map((code) => (
                <li key={code}>
                  {REASON_LABEL[code]}: <strong>{countsByReason[code]}</strong>
                </li>
              ))}
            </ul>
          </article>
        </div>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <h2>Recent rectifying invoices</h2>
          <span className="bo-chip">link: original → rectifying</span>
        </div>
        {rectifying.length === 0 ? (
          <p className="bo-muted">No rectifying invoices yet. Start one from a previously issued invoice.</p>
        ) : (
          rectifying.map((inv) => {
            const orig = inv.rectifyingForId ? originalsById.get(inv.rectifyingForId) : undefined;
            return (
              <div className="bo-row" key={inv.id}>
                <span>
                  <strong>{inv.invoiceNumber ?? inv.id}</strong>
                  <small>
                    {" "}
                    {inv.rectifyingReasonCode ?? inv.invoiceType} · {inv.total} EUR · {inv.status}
                  </small>
                </span>
                <span className="bo-muted">
                  rectifies{" "}
                  <strong>{orig?.invoiceNumber ?? inv.rectifyingForId ?? "—"}</strong>
                </span>
              </div>
            );
          })
        )}
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <h2>Issue a new rectifying invoice</h2>
          <span className="bo-chip">R1–R5 supported</span>
        </div>
        <p>
          Pick an issued invoice by id and choose a reason (R1–R5). Full reversal negates every line for a
          credit-note style correction; line adjustments compute deltas.
        </p>
        <div className="bo-row" style={{ gap: "0.5rem", alignItems: "end" }}>
          <label className="bo-form-field" style={{ flex: 1 }}>
            <span>Pre-fill original invoice id</span>
            <select value={dialogTargetId ?? ""} onChange={(event) => setDialogTargetId(event.target.value || null)}>
              <option value="">— Select an issued invoice —</option>
              {invoices
                .filter((i: RectifyingFlavour) => i.status === "issued" && !isRectifying(i))
                .map((i: RectifyingFlavour) => (
                  <option key={i.id} value={i.id}>
                    {i.invoiceNumber ?? i.id} · {i.total} EUR
                  </option>
                ))}
            </select>
          </label>
        </div>
      </section>

      <InvoiceRectifyDialog
        initialInvoiceId={dialogTargetId ?? undefined}
        onRectified={(rectified) => {
          setInvoices((current) => [rectified as RectifyingFlavour, ...current]);
        }}
      />

      <p className="bo-muted">{status}</p>
    </>
  );
}

export default InvoiceRectificationsScreen;

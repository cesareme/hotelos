import { getActivePropertyId } from "../../services/activeProperty";
import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { SubmissionDetailPanel, type AuthorityKind } from "../../components/SubmissionDetailPanel";
import { useToast } from "../../components/Toast";

const PROPERTY_ID = getActivePropertyId();

type SubmissionRow = {
  id: string;
  status: string;
  endpoint?: string;
  attempts?: number;
  submittedAt?: string;
  acknowledgedAt?: string;
  errorCode?: string;
  errorMessage?: string;
  invoiceNumber?: string;
  invoiceId?: string;
  csvCode?: string;
  tbaiCode?: string;
  tbaiHash?: string;
  territory?: string;
  acknowledgementCode?: string;
  trackingNumber?: string;
  externalReference?: string;
  submissionType?: string;
};

function statusToClass(status: string, simulated = false): string {
  // Honestidad (auditoría 2026-07): un "accepted" SIMULADO (sandbox/stub, sin
  // envío real a la Administración) no debe pintarse en verde como si fuera un
  // acuse real de AEAT/MIR/Hacienda foral.
  if (status === "accepted" || status === "accepted_with_warnings") return simulated ? "warn" : "ok";
  if (status === "rejected") return "error";
  if (status === "retrying" || status === "queued" || status === "submitting" || status === "pending" || status === "network_error") return "warn";
  return "info";
}

/** Envío simulado: el submitter por defecto (sin VERIFACTU_MODE/SES_HOSPEDAJES_MODE
 *  de producción) persiste acuses con endpoint `stub://…` sin contactar a la
 *  Administración. Detectarlo para etiquetarlo SANDBOX en la UI. */
function isSimulated(row: SubmissionRow): boolean {
  return typeof row.endpoint === "string" && row.endpoint.startsWith("stub://");
}

function listPath(tab: AuthorityKind): string {
  switch (tab) {
    case "verifactu": return `/properties/${PROPERTY_ID}/verifactu/submissions`;
    case "tbai": return `/properties/${PROPERTY_ID}/tbai/submissions`;
    case "igic": return `/properties/${PROPERTY_ID}/igic/submissions`;
    case "ses": return `/properties/${PROPERTY_ID}/ses/submissions`;
  }
}

function retryPath(tab: AuthorityKind, id: string): string {
  switch (tab) {
    case "verifactu": return `/verifactu/submissions/${id}/retry`;
    case "tbai": return `/tbai/submissions/${id}/retry`;
    case "igic": return `/igic/submissions/${id}/retry`;
    case "ses": return `/ses/submissions/${id}/retry`;
  }
}

export function FiscalSubmissionsCenter() {
  const { showToast } = useToast();
  const [tab, setTab] = useState<AuthorityKind>("verifactu");
  const [selected, setSelected] = useState<string | null>(null);
  const [bulkRetrying, setBulkRetrying] = useState(false);
  const [bulkMessage, setBulkMessage] = useState<string | null>(null);

  const { data, loading, error, refresh } = useApiData<SubmissionRow[] | { items?: SubmissionRow[]; submissions?: SubmissionRow[] }>(listPath(tab), {
    pollIntervalMs: 12_000,
    pollWhile: (raw) => {
      const list = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { items?: SubmissionRow[] } | null)?.items)
          ? ((raw as { items: SubmissionRow[] }).items)
          : Array.isArray((raw as { submissions?: SubmissionRow[] } | null)?.submissions)
            ? ((raw as { submissions: SubmissionRow[] }).submissions)
            : [];
      return list.some((r) => ["retrying", "submitting", "queued", "network_error"].includes(r.status));
    }
  });

  // Defensive: accept array, { items: [] }, { submissions: [] }, null, undefined.
  // Some envelopes return an object wrapper instead of a raw array — coerce here so
  // the rest of the component can rely on rows being a real array.
  const rows: SubmissionRow[] = useMemo(() => {
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object") {
      const envelope = data as { items?: SubmissionRow[]; submissions?: SubmissionRow[] };
      if (Array.isArray(envelope.items)) return envelope.items;
      if (Array.isArray(envelope.submissions)) return envelope.submissions;
    }
    return [];
  }, [data]);
  const retryable = useMemo(() => rows.filter((r) => r.status === "rejected" || r.status === "retrying" || r.status === "network_error"), [rows]);

  async function handleBulkRetry() {
    if (retryable.length === 0) return;
    setBulkRetrying(true);
    setBulkMessage(null);
    let ok = 0;
    let fail = 0;
    for (const row of retryable) {
      try {
        await apiRequest(retryPath(tab, row.id), { method: "POST" });
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    setBulkRetrying(false);
    const summary = `Re-queued ${ok} submission${ok === 1 ? "" : "s"}.${fail > 0 ? ` ${fail} failed.` : ""}`;
    setBulkMessage(summary);
    if (fail === 0) {
      showToast(summary, { variant: "success" });
    } else if (ok === 0) {
      showToast(summary, { variant: "error" });
    } else {
      showToast(summary, { variant: "info" });
    }
    setTimeout(() => refresh(), 1500);
  }

  const tabs: Array<{ id: AuthorityKind; label: string; subtitle: string }> = [
    { id: "verifactu", label: "VeriFactu", subtitle: "AEAT mainland" },
    { id: "tbai", label: "TicketBAI", subtitle: "Bizkaia · Gipuzkoa · Araba" },
    { id: "igic", label: "IGIC", subtitle: "Canarias (ATC)" },
    { id: "ses", label: "SES.HOSPEDAJES", subtitle: "MIR · viajeros" }
  ];

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Compliance · Submissions</div>
          <h1 className="bo-page-title">Fiscal submissions</h1>
          <p className="bo-page-subtitle">
            Click cualquier fila para inspeccionar el XML canonical firmado, la respuesta de la autoridad y el historial de reintentos.
            La tabla se auto-refresca cada 12s mientras haya submissions pendientes.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" onClick={refresh}>↻ Refresh</button>
          {retryable.length > 0 ? (
            <button type="button" className="primary" disabled={bulkRetrying} onClick={handleBulkRetry}>
              {bulkRetrying ? "Retrying…" : `Retry ${retryable.length} failed`}
            </button>
          ) : null}
          <button type="button" className="ghost">Export CSV</button>
        </div>
      </div>

      <div className="bo-row" style={{ gap: 0, borderBottom: "1px solid var(--line)", paddingBottom: 0, marginBottom: 16 }}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => { setTab(t.id); setSelected(null); }}
            style={{
              border: "none",
              borderRadius: 0,
              borderBottom: t.id === tab ? "2px solid var(--accent)" : "2px solid transparent",
              background: "transparent",
              padding: "12px 18px",
              cursor: "pointer",
              color: t.id === tab ? "var(--ink)" : "var(--ink-muted)",
              fontWeight: t.id === tab ? 700 : 500
            }}
          >
            <div style={{ fontSize: 14 }}>{t.label}</div>
            <div style={{ fontSize: 11, color: "var(--ink-muted)", fontWeight: 500 }}>{t.subtitle}</div>
          </button>
        ))}
      </div>

      {bulkMessage ? (
        <div className="bo-card" style={{ background: "var(--accent-soft)", border: "1px solid var(--accent-line, transparent)", borderLeft: "3px solid var(--accent)", padding: 12, fontSize: 13 }}>
          {bulkMessage}
        </div>
      ) : null}

      {rows.some(isSimulated) ? (
        <div
          className="bo-card"
          role="status"
          style={{ borderLeft: "3px solid var(--warn-ink, #a16207)", padding: 12, fontSize: 13 }}
        >
          <strong>Modo sandbox:</strong> los envíos marcados como SANDBOX son simulados —{" "}
          <strong>no se han remitido a la Administración</strong>. El envío real requiere
          configurar el modo producción y el certificado del establecimiento.
        </div>
      ) : null}

      {loading && rows.length === 0 ? (
        <div className="bo-card" style={{ textAlign: "center", padding: 48, color: "var(--ink-muted)" }}>Loading submissions...</div>
      ) : error ? (
        <div className="bo-card" style={{ borderLeft: "3px solid var(--danger-ink)" }}>
          <h3>Error loading submissions</h3>
          <p className="bo-muted">Couldn't load this report right now. Refresh to retry.</p>
        </div>
      ) : rows.length === 0 ? (
        <div className="bo-card" style={{ textAlign: "center", padding: 48 }}>
          <h3 style={{ marginBottom: 8 }}>No submissions yet for this authority</h3>
          <p>Issue an invoice for a property that routes to this authority to see entries here.</p>
        </div>
      ) : (
        <div className="bo-card" style={{ padding: 0, overflow: "hidden" }}>
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>{tab === "ses" ? "Reference" : "Invoice"}</th>
                <th>Identifier</th>
                <th>Submitted</th>
                <th>Attempts</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => setSelected(row.id)}
                  style={{ cursor: "pointer", background: row.id === selected ? "var(--accent-soft)" : undefined }}
                >
                  <td>
                    <span className={`bo-status ${statusToClass(row.status, isSimulated(row))}`}>{row.status}</span>
                    {isSimulated(row) ? (
                      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, color: "var(--warn-ink, #a16207)", marginTop: 2 }}>
                        SANDBOX · no enviado
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <strong>{row.invoiceNumber ?? row.externalReference ?? "—"}</strong>
                    {row.submissionType ? <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>{row.submissionType}</div> : null}
                    {row.territory ? <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>{row.territory}</div> : null}
                  </td>
                  <td>
                    {row.csvCode ? (<><span style={{ fontFamily: "var(--font-mono)" }}>{row.csvCode}</span><div style={{ fontSize: 11, color: "var(--ink-muted)" }}>CSV</div></>) : null}
                    {row.tbaiCode ? (<><span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{row.tbaiCode}</span><div style={{ fontSize: 11, color: "var(--ink-muted)" }}>Código TBAI</div></>) : null}
                    {row.acknowledgementCode ? (<><span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{row.acknowledgementCode}</span><div style={{ fontSize: 11, color: "var(--ink-muted)" }}>ACK</div></>) : null}
                    {!row.csvCode && !row.tbaiCode && !row.acknowledgementCode ? <span style={{ color: "var(--ink-muted)" }}>—</span> : null}
                  </td>
                  <td style={{ fontSize: 12, color: "var(--ink-muted)" }}>{row.submittedAt ? new Date(row.submittedAt).toLocaleString() : "—"}</td>
                  <td style={{ fontSize: 12 }}>{row.attempts ?? 0}</td>
                  <td>
                    {row.errorCode ? (
                      <div>
                        <span className="cm-pill cm-pill-error">{row.errorCode}</span>
                        {row.errorMessage ? <div style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 4 }}>{row.errorMessage}</div> : null}
                      </div>
                    ) : row.trackingNumber ? (
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{row.trackingNumber}</span>
                    ) : row.tbaiHash ? (
                      <span style={{ fontFamily: "var(--font-mono)", fontSize: 11 }} title={row.tbaiHash}>{row.tbaiHash.slice(0, 16)}…</span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SubmissionDetailPanel
        open={selected !== null}
        authority={tab}
        submissionId={selected}
        onClose={() => setSelected(null)}
        onRetried={() => refresh()}
      />
    </>
  );
}

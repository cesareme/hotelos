import { getActivePropertyId } from "../../services/activeProperty";
import { useMemo, useState, type FormEvent } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";

const PROPERTY_ID = getActivePropertyId();

// --- types ---------------------------------------------------------------

type CommissionRule = {
  id: string;
  propertyId: string;
  channelId: string | null;
  channelCode: string | null;
  ratePct: string;
  appliesTo: string;
  ledgerAccountCode: string;
  active: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  createdAt: string;
};

type CommissionAccrual = {
  id: string;
  propertyId: string;
  reservationId: string | null;
  invoiceId: string | null;
  channelId: string | null;
  channelCode: string | null;
  baseAmount: string;
  ratePct: string;
  commissionAmount: string;
  currencyCode: string;
  accruedAt: string;
  journalEntryId: string | null;
  status: string;
};

type CommissionSummary = {
  propertyId: string;
  from: string | null;
  to: string | null;
  total: { commissionAmount: number; baseAmount: number; count: number };
  byChannel: Array<{ channelKey: string; commissionAmount: number; baseAmount: number; count: number }>;
  byStatus: Array<{ status: string; commissionAmount: number; count: number }>;
};

// --- helpers -------------------------------------------------------------

function fmtEur(amount: number | string): string {
  const value = typeof amount === "string" ? Number(amount) : amount;
  return new Intl.NumberFormat("es-ES", { useGrouping: true,
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2
  }).format(Number.isFinite(value) ? value : 0);
}

function fmtPct(value: number | string): string {
  const num = typeof value === "string" ? Number(value) : value;
  return `${(Number.isFinite(num) ? num : 0).toFixed(2)}%`;
}

function fmtDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("es-ES", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    return iso;
  }
}

function statusTone(status: string): "ok" | "warn" | "error" | "neutral" {
  switch (status) {
    case "paid":
      return "ok";
    case "invoiced":
      return "warn";
    case "reversed":
      return "error";
    case "accrued":
    default:
      return "neutral";
  }
}

function startOfMonthIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

// --- screen --------------------------------------------------------------

export function CommissionsScreen() {
  const fromMtd = useMemo(startOfMonthIso, []);

  const rulesState = useApiData<CommissionRule[]>("/commissions/rules", {
    query: { propertyId: PROPERTY_ID }
  });
  const accrualsState = useApiData<CommissionAccrual[]>("/commissions/accruals", {
    query: { propertyId: PROPERTY_ID }
  });
  const summaryState = useApiData<CommissionSummary>("/commissions/summary", {
    query: { propertyId: PROPERTY_ID, from: fromMtd }
  });

  // Form state for "Add rule".
  const [showAddForm, setShowAddForm] = useState(false);
  const [formChannelCode, setFormChannelCode] = useState("");
  const [formRatePct, setFormRatePct] = useState("15.00");
  const [formAppliesTo, setFormAppliesTo] = useState<"net_revenue" | "gross_revenue" | "total">("net_revenue");
  const [formSubmitting, setFormSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busyDeactivateId, setBusyDeactivateId] = useState<string | null>(null);

  const refreshAll = () => {
    rulesState.refresh();
    accrualsState.refresh();
    summaryState.refresh();
  };

  const handleAddRule = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!formChannelCode.trim()) {
      setFormError("Channel code is required.");
      return;
    }
    const rate = Number(formRatePct);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
      setFormError("Rate % must be between 0 and 100.");
      return;
    }
    setFormSubmitting(true);
    try {
      await apiRequest("/commissions/rules", {
        method: "POST",
        body: {
          propertyId: PROPERTY_ID,
          channelCode: formChannelCode.trim().toLowerCase(),
          ratePct: rate,
          appliesTo: formAppliesTo
        }
      });
      setShowAddForm(false);
      setFormChannelCode("");
      setFormRatePct("15.00");
      setFormAppliesTo("net_revenue");
      refreshAll();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setFormSubmitting(false);
    }
  };

  const handleDeactivate = async (id: string) => {
    setBusyDeactivateId(id);
    try {
      await apiRequest(`/commissions/rules/${id}/deactivate`, { method: "POST" });
      refreshAll();
    } catch (err) {
      console.error("Deactivate failed:", err);
    } finally {
      setBusyDeactivateId(null);
    }
  };

  const totalMtd = summaryState.data?.total.commissionAmount ?? 0;
  const baseMtd = summaryState.data?.total.baseAmount ?? 0;
  const percentOfRevenue = baseMtd > 0 ? (totalMtd / baseMtd) * 100 : 0;
  const topChannel = summaryState.data?.byChannel[0];

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Comisiones OTA</div>
          <h1 className="bo-page-title">OTA commission engine</h1>
          <p className="bo-page-subtitle">
            Define per-channel commission rates and review accruals (DR 6230 Comisiones / CR 4109 Acreedores OTA).
            Accruals are produced automatically on <strong>InvoiceIssued</strong> and{" "}
            <strong>ReservationCheckedOut</strong> events.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" onClick={refreshAll}>↻ Refresh</button>
        </div>
      </div>

      {/* KPI cards */}
      <section className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-warn">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Total accrued MTD</span>
          </div>
          <div className="rev-kpi-value">{fmtEur(totalMtd)}</div>
          <div className="rev-kpi-delta">{summaryState.data?.total.count ?? 0} accruals</div>
        </article>
        <article className="rev-kpi">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Revenue base MTD</span>
          </div>
          <div className="rev-kpi-value">{fmtEur(baseMtd)}</div>
          <div className="rev-kpi-delta">cumulative</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">% of revenue</span>
          </div>
          <div className="rev-kpi-value">{fmtPct(percentOfRevenue)}</div>
          <div className="rev-kpi-delta">commission / base</div>
        </article>
        <article className="rev-kpi">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Top channel</span>
          </div>
          <div className="rev-kpi-value" style={{ fontSize: 22 }}>
            {topChannel ? topChannel.channelKey : "—"}
          </div>
          <div className="rev-kpi-delta">{topChannel ? fmtEur(topChannel.commissionAmount) : "no data"}</div>
        </article>
      </section>

      {/* Channel breakdown */}
      {summaryState.data && summaryState.data.byChannel.length > 0 ? (
        <section className="bo-card">
          <div className="bo-card-head">
            <h2 style={{ fontSize: 18 }}>Breakdown by channel · MTD</h2>
            <span className="bo-chip">{summaryState.data.byChannel.length} channels</span>
          </div>
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Channel</th>
                  <th style={{ textAlign: "right" }}>Base amount</th>
                  <th style={{ textAlign: "right" }}>Commission</th>
                  <th style={{ textAlign: "right" }}>Count</th>
                </tr>
              </thead>
              <tbody>
                {summaryState.data.byChannel.map((c) => (
                  <tr key={c.channelKey}>
                    <td><strong>{c.channelKey}</strong></td>
                    <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmtEur(c.baseAmount)}</td>
                    <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmtEur(c.commissionAmount)}</td>
                    <td style={{ textAlign: "right" }}>{c.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* Side-by-side rules + accruals */}
      <div className="bo-grid two">
        {/* Commission rules */}
        <section className="bo-card">
          <div className="bo-card-head">
            <h2 style={{ fontSize: 18 }}>Commission rules</h2>
            <button
              type="button"
              className="primary"
              onClick={() => setShowAddForm((s) => !s)}
            >
              {showAddForm ? "Cancel" : "+ Add rule"}
            </button>
          </div>

          {showAddForm ? (
            <form
              onSubmit={handleAddRule}
              style={{
                display: "grid",
                gap: 12,
                padding: 16,
                background: "var(--surface)",
                border: "1px solid var(--line)",
                borderRadius: "var(--radius-md)",
                marginBottom: 16
              }}
            >
              <div style={{ display: "grid", gap: 6 }}>
                <label style={{ fontSize: 12, color: "var(--ink-muted)" }}>Channel code</label>
                <input
                  type="text"
                  placeholder="e.g. booking, expedia, hotelbeds"
                  value={formChannelCode}
                  onChange={(e) => setFormChannelCode(e.target.value)}
                />
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                <label style={{ fontSize: 12, color: "var(--ink-muted)" }}>Rate %</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={formRatePct}
                  onChange={(e) => setFormRatePct(e.target.value)}
                />
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                <label style={{ fontSize: 12, color: "var(--ink-muted)" }}>Applies to</label>
                <select
                  value={formAppliesTo}
                  onChange={(e) => setFormAppliesTo(e.target.value as typeof formAppliesTo)}
                >
                  <option value="net_revenue">Net revenue</option>
                  <option value="gross_revenue">Gross revenue</option>
                  <option value="total">Total</option>
                </select>
              </div>
              {formError ? (
                <div style={{ color: "var(--danger-ink)", fontSize: 12 }}>{formError}</div>
              ) : null}
              <div style={{ display: "flex", gap: 8 }}>
                <button type="submit" className="primary" disabled={formSubmitting}>
                  {formSubmitting ? "Saving…" : "Save rule"}
                </button>
                <button type="button" onClick={() => setShowAddForm(false)} disabled={formSubmitting}>
                  Cancel
                </button>
              </div>
            </form>
          ) : null}

          {rulesState.loading ? (
            <p style={{ color: "var(--ink-muted)" }}>Loading rules…</p>
          ) : rulesState.error ? (
            <p style={{ color: "var(--danger-ink)" }}>{rulesState.error}</p>
          ) : !rulesState.data || rulesState.data.length === 0 ? (
            <p style={{ color: "var(--ink-muted)" }}>No rules defined yet. Add one to start accruing commissions.</p>
          ) : (
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Channel</th>
                    <th style={{ textAlign: "right" }}>Rate</th>
                    <th>Applies to</th>
                    <th>Active</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rulesState.data.map((rule) => (
                    <tr key={rule.id} style={!rule.active ? { opacity: 0.55 } : undefined}>
                      <td><strong>{rule.channelCode ?? rule.channelId ?? "—"}</strong></td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmtPct(rule.ratePct)}</td>
                      <td>{rule.appliesTo.replace("_", " ")}</td>
                      <td>
                        <span className={`bo-status ${rule.active ? "ok" : "neutral"}`}>
                          {rule.active ? "active" : "inactive"}
                        </span>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {rule.active ? (
                          <button
                            type="button"
                            onClick={() => handleDeactivate(rule.id)}
                            disabled={busyDeactivateId === rule.id}
                          >
                            {busyDeactivateId === rule.id ? "…" : "Deactivate"}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Recent accruals */}
        <section className="bo-card">
          <div className="bo-card-head">
            <h2 style={{ fontSize: 18 }}>Recent accruals</h2>
            <span className="bo-chip">{accrualsState.data?.length ?? 0}</span>
          </div>

          {accrualsState.loading ? (
            <p style={{ color: "var(--ink-muted)" }}>Loading accruals…</p>
          ) : accrualsState.error ? (
            <p style={{ color: "var(--danger-ink)" }}>{accrualsState.error}</p>
          ) : !accrualsState.data || accrualsState.data.length === 0 ? (
            <p style={{ color: "var(--ink-muted)" }}>
              No accruals yet. They will appear here once invoices are issued for OTA reservations.
            </p>
          ) : (
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th>Channel</th>
                    <th style={{ textAlign: "right" }}>Base</th>
                    <th style={{ textAlign: "right" }}>Rate</th>
                    <th style={{ textAlign: "right" }}>Commission</th>
                    <th>Status</th>
                    <th>Accrued at</th>
                  </tr>
                </thead>
                <tbody>
                  {accrualsState.data.map((accrual) => (
                    <tr key={accrual.id}>
                      <td style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
                        {accrual.invoiceId
                          ? `inv:${accrual.invoiceId.slice(0, 10)}…`
                          : accrual.reservationId
                            ? `res:${accrual.reservationId.slice(0, 10)}…`
                            : "—"}
                      </td>
                      <td>{accrual.channelCode ?? accrual.channelId ?? "—"}</td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmtEur(accrual.baseAmount)}</td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmtPct(accrual.ratePct)}</td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 600 }}>
                        {fmtEur(accrual.commissionAmount)}
                      </td>
                      <td>
                        <span className={`bo-status ${statusTone(accrual.status)}`}>{accrual.status}</span>
                      </td>
                      <td style={{ fontSize: 11, color: "var(--ink-muted)" }}>{fmtDateTime(accrual.accruedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

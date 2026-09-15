import { getActivePropertyId } from "../../services/activeProperty";
import { useMemo, useState, type FormEvent } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { ACTIONS, STATUS_LABELS, loadingLabel, newLabel } from "../../content/actions";
import { dateTime, money, percent, plural } from "../../lib/format";

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
  return money(amount);
}

function fmtPct(value: number | string): string {
  return percent(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const APPLIES_TO_LABEL: Record<string, string> = {
  net_revenue: "Ingreso neto",
  gross_revenue: "Ingreso bruto",
  total: "Total"
};

const ACCRUAL_STATUS_LABEL: Record<string, string> = {
  accrued: "Devengada",
  invoiced: "Facturada",
  paid: "Pagada",
  reversed: "Anulada"
};

function fmtDateTime(iso: string): string {
  try {
    return dateTime(iso, { empty: iso });
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
      setFormError("El código del canal es obligatorio.");
      return;
    }
    const rate = Number(formRatePct);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
      setFormError("La comisión debe estar entre 0 y 100 %.");
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

  // Deactivation stops future accruals for the channel: it is confirmed in a
  // dialog (Tanda 5: every destructive action asks first).
  const [pendingDeactivate, setPendingDeactivate] = useState<{ id: string; label: string } | null>(null);
  const handleDeactivate = async (id: string) => {
    setBusyDeactivateId(id);
    try {
      await apiRequest(`/commissions/rules/${id}/deactivate`, { method: "POST" });
      refreshAll();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "No se pudo desactivar la regla.");
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
      <CocoaPageHeader
        eyebrow="Finanzas"
        title="Comisiones"
        subtitle="La comisión de cada canal de venta y su devengo: se contabiliza sola al emitir la factura o al hacer el check-out (cuenta 6230 Comisiones contra 4109 Acreedores)."
        actions={<button type="button" onClick={refreshAll}>↻ {ACTIONS.refresh}</button>}
      />
      <ConfirmDialog
        open={pendingDeactivate !== null}
        variant="danger"
        title={pendingDeactivate ? `¿Desactivar la regla de ${pendingDeactivate.label}?` : ""}
        description="Dejarán de devengarse comisiones para este canal a partir de ahora. Los devengos ya registrados no cambian."
        confirmLabel={ACTIONS.deactivate}
        cancelLabel={ACTIONS.cancel}
        onCancel={() => setPendingDeactivate(null)}
        onConfirm={() => {
          const target = pendingDeactivate;
          setPendingDeactivate(null);
          if (target) void handleDeactivate(target.id);
        }}
      />

      {/* KPI cards */}
      <section className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-warn">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Devengado este mes</span>
          </div>
          <div className="rev-kpi-value">{fmtEur(totalMtd)}</div>
          <div className="rev-kpi-delta">{plural(summaryState.data?.total.count ?? 0, "devengo", "devengos")}</div>
        </article>
        <article className="rev-kpi">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Base de ingresos del mes</span>
          </div>
          <div className="rev-kpi-value">{fmtEur(baseMtd)}</div>
          <div className="rev-kpi-delta">acumulado</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">% sobre ingresos</span>
          </div>
          <div className="rev-kpi-value">{fmtPct(percentOfRevenue)}</div>
          <div className="rev-kpi-delta">comisión sobre base</div>
        </article>
        <article className="rev-kpi">
          <div className="rev-kpi-head">
            <span className="rev-kpi-label">Canal con más comisión</span>
          </div>
          <div className="rev-kpi-value" style={{ fontSize: 22 }}>
            {topChannel ? topChannel.channelKey : "—"}
          </div>
          <div className="rev-kpi-delta">{topChannel ? fmtEur(topChannel.commissionAmount) : "sin datos"}</div>
        </article>
      </section>

      {/* Channel breakdown */}
      {summaryState.data && summaryState.data.byChannel.length > 0 ? (
        <section className="bo-card">
          <div className="bo-card-head">
            <h2 style={{ fontSize: 18 }}>Desglose por canal · este mes</h2>
            <span className="bo-chip">{summaryState.data.byChannel.length} channels</span>
          </div>
          <div className="rev-report-wrap">
            <table className="cm-table">
              <thead>
                <tr>
                  <th>Canal</th>
                  <th style={{ textAlign: "right" }}>Importe base</th>
                  <th style={{ textAlign: "right" }}>Comisión</th>
                  <th style={{ textAlign: "right" }}>Cantidad</th>
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
            <h2 style={{ fontSize: 18 }}>Reglas de comisión</h2>
            <button
              type="button"
              className="primary"
              onClick={() => setShowAddForm((s) => !s)}
            >
              {showAddForm ? ACTIONS.cancel : `+ ${newLabel("f", "regla")}`}
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
                <label style={{ fontSize: 12, color: "var(--ink-muted)" }}>Código del canal</label>
                <input
                  type="text"
                  placeholder="p. ej. booking, expedia, hotelbeds"
                  value={formChannelCode}
                  onChange={(e) => setFormChannelCode(e.target.value)}
                />
              </div>
              <div style={{ display: "grid", gap: 6 }}>
                <label style={{ fontSize: 12, color: "var(--ink-muted)" }}>Comisión (%)</label>
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
                <label style={{ fontSize: 12, color: "var(--ink-muted)" }}>Se aplica sobre</label>
                <select
                  value={formAppliesTo}
                  onChange={(e) => setFormAppliesTo(e.target.value as typeof formAppliesTo)}
                >
                  <option value="net_revenue">Ingreso neto</option>
                  <option value="gross_revenue">Ingreso bruto</option>
                  <option value="total">Total</option>
                </select>
              </div>
              {formError ? (
                <div style={{ color: "var(--danger-ink)", fontSize: 12 }}>{formError}</div>
              ) : null}
              <div style={{ display: "flex", gap: 8 }}>
                <button type="submit" className="primary" disabled={formSubmitting}>
                  {formSubmitting ? STATUS_LABELS.saving : "Guardar regla"}
                </button>
                <button type="button" onClick={() => setShowAddForm(false)} disabled={formSubmitting}>
                  {ACTIONS.cancel}
                </button>
              </div>
            </form>
          ) : null}

          {rulesState.loading ? (
            <p style={{ color: "var(--ink-muted)" }}>{loadingLabel("reglas")}</p>
          ) : rulesState.error ? (
            <p style={{ color: "var(--danger-ink)" }}>{rulesState.error}</p>
          ) : !rulesState.data || rulesState.data.length === 0 ? (
            <p style={{ color: "var(--ink-muted)" }}>Aún no hay reglas. Añade una para empezar a devengar comisiones.</p>
          ) : (
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Canal</th>
                    <th style={{ textAlign: "right" }}>Comisión</th>
                    <th>Se aplica sobre</th>
                    <th>Activa</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {rulesState.data.map((rule) => (
                    <tr key={rule.id} style={!rule.active ? { opacity: 0.55 } : undefined}>
                      <td><strong>{rule.channelCode ?? rule.channelId ?? "—"}</strong></td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmtPct(rule.ratePct)}</td>
                      <td>{APPLIES_TO_LABEL[rule.appliesTo] ?? rule.appliesTo}</td>
                      <td>
                        <span className={`bo-status ${rule.active ? "ok" : "neutral"}`}>
                          {rule.active ? STATUS_LABELS.active : STATUS_LABELS.inactive}
                        </span>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {rule.active ? (
                          <button
                            type="button"
                            onClick={() => setPendingDeactivate({ id: rule.id, label: rule.channelCode ?? rule.channelId ?? "este canal" })}
                            disabled={busyDeactivateId === rule.id}
                          >
                            {busyDeactivateId === rule.id ? "…" : ACTIONS.deactivate}
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
            <h2 style={{ fontSize: 18 }}>Devengos recientes</h2>
            <span className="bo-chip">{accrualsState.data?.length ?? 0}</span>
          </div>

          {accrualsState.loading ? (
            <p style={{ color: "var(--ink-muted)" }}>{loadingLabel("devengos")}</p>
          ) : accrualsState.error ? (
            <p style={{ color: "var(--danger-ink)" }}>{accrualsState.error}</p>
          ) : !accrualsState.data || accrualsState.data.length === 0 ? (
            <p style={{ color: "var(--ink-muted)" }}>
              Aún no hay devengos. Aparecerán al emitir facturas de reservas llegadas por canales de venta.
            </p>
          ) : (
            <div className="rev-report-wrap">
              <table className="cm-table">
                <thead>
                  <tr>
                    <th>Origen</th>
                    <th>Canal</th>
                    <th style={{ textAlign: "right" }}>Base</th>
                    <th style={{ textAlign: "right" }}>Comisión</th>
                    <th style={{ textAlign: "right" }}>Comisión</th>
                    <th>Estado</th>
                    <th>Devengada el</th>
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
                        <span className={`bo-status ${statusTone(accrual.status)}`}>{ACCRUAL_STATUS_LABEL[accrual.status] ?? accrual.status}</span>
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

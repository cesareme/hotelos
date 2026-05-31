import { getActivePropertyId } from "../../services/activeProperty";
import { useMemo, useState } from "react";
import { apiRequest } from "../../services/api-client";
import { useApiData } from "../../hooks/useApiData";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";

// ---- Sprint 23 / Track 5 — Payroll bridge a gestoría (UI) ----
//
// Three tabs: Contracts, Periods, Slips. The slip tab follows the period that
// the user opens via "View slips". KPI cards summarise periods that are still
// open, the most recent calculated period, and the gross MTD across slips in
// the current month.
//
// Both export buttons hit `/payroll/periods/:id/export?format=a3|sage`, which
// returns JSON with `{ filename, text, contentType }`. We then materialise the
// download client-side via Blob + URL.createObjectURL — that keeps apiRequest
// (which only knows JSON) usable.

const PROPERTY_ID = getActivePropertyId();
const ORG_ID = "org_demo";

type Contract = {
  id: string;
  staffProfileId: string;
  propertyId?: string;
  organizationId: string;
  contractType: string;
  startDate: string;
  endDate?: string;
  grossSalary: number;
  payFrequency: string;
  payCount: number;
  irpfRatePct?: number;
  socialSecurityCategory?: string;
  costCenterId?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

type Period = {
  id: string;
  organizationId: string;
  propertyId?: string;
  periodCode: string;
  startDate: string;
  endDate: string;
  status: "open" | "calculated" | "exported" | "closed";
  totalGross: number;
  totalNet: number;
  totalIrpf: number;
  totalSs: number;
  exportedAt?: string;
  createdAt: string;
};

type Slip = {
  id: string;
  periodId: string;
  staffProfileId: string;
  contractId?: string;
  grossSalary: number;
  irpfRetention: number;
  ssEmployee: number;
  ssEmployer: number;
  netSalary: number;
  daysWorked: number;
  documentObjectKey?: string;
  status: "draft" | "issued" | "paid";
  createdAt: string;
  lines: Array<{
    id: string;
    slipId: string;
    lineType: "earning" | "deduction" | "employer_cost";
    code: string;
    description?: string;
    amount: number;
  }>;
};

type ExportResult = {
  periodId: string;
  periodCode: string;
  format: "a3" | "sage";
  filename: string;
  contentType: string;
  text: string;
  slipCount: number;
  exportedAt: string;
};

const eur = new Intl.NumberFormat("es-ES", { useGrouping: true, style: "currency", currency: "EUR", minimumFractionDigits: 2 });

function fmt(n: number | undefined): string {
  return eur.format(n ?? 0);
}

function statusPillClass(status: Period["status"]): string {
  if (status === "open") return "bo-status warn";
  if (status === "calculated") return "bo-status ok";
  if (status === "exported") return "bo-status ok";
  return "bo-status";
}

function currentMonthCode(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function downloadText(filename: string, contentType: string, text: string) {
  const blob = new Blob([text], { type: contentType || "text/plain" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Defer the revoke so Safari has a chance to consume the URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type TabKey = "contracts" | "periods" | "slips";

export function PayrollScreen() {
  const { showToast } = useToast();
  const [tab, setTab] = useState<TabKey>("contracts");
  const [selectedPeriodId, setSelectedPeriodId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showNewContract, setShowNewContract] = useState(false);
  const [showNewPeriod, setShowNewPeriod] = useState(false);

  const contracts = useApiData<Contract[]>("/payroll/contracts", {
    query: { organizationId: ORG_ID, propertyId: PROPERTY_ID }
  });
  const periods = useApiData<Period[]>("/payroll/periods", {
    query: { organizationId: ORG_ID }
  });
  const slips = useApiData<Slip[]>(selectedPeriodId ? `/payroll/periods/${selectedPeriodId}/slips` : null);

  const periodsArr = useMemo(() => toArray<Period>(periods.data), [periods.data]);
  const contractsArr = useMemo(() => toArray<Contract>(contracts.data), [contracts.data]);

  const openPeriods = useMemo<number>(
    () => periodsArr.filter((p: Period) => p.status === "open").length,
    [periodsArr]
  );
  const lastCalculated = useMemo<Period | undefined>(() => {
    return periodsArr
      .filter((p: Period) => p.status === "calculated" || p.status === "exported")
      .sort((a: Period, b: Period) => (a.periodCode < b.periodCode ? 1 : -1))[0];
  }, [periodsArr]);

  const grossMTD = useMemo<number>(() => {
    const month = currentMonthCode();
    return periodsArr
      .filter((p: Period) => p.periodCode === month)
      .reduce((sum: number, p: Period) => sum + (p.totalGross ?? 0), 0);
  }, [periodsArr]);

  async function handleCalculate(periodId: string) {
    setBusy(`calc-${periodId}`);
    setError(null);
    try {
      await apiRequest(`/payroll/periods/${periodId}/calculate`, { method: "POST" });
      periods.refresh();
      if (selectedPeriodId === periodId) slips.refresh();
      showToast("Periodo calculado", { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  async function handleExport(periodId: string, format: "a3" | "sage") {
    setBusy(`export-${periodId}-${format}`);
    setError(null);
    try {
      const result = await apiRequest<ExportResult>(`/payroll/periods/${periodId}/export`, {
        query: { format }
      });
      downloadText(result.filename, result.contentType, result.text);
      periods.refresh();
      showToast(`Exportación ${format.toUpperCase()} lista`, { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(null);
    }
  }

  function openSlipsFor(periodId: string) {
    setSelectedPeriodId(periodId);
    setTab("slips");
  }

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Payroll bridge</div>
          <h1 className="bo-page-title">Nóminas → gestoría</h1>
          <p className="bo-page-subtitle">
            Contratos, periodos mensuales y exportación a A3 Nóminas / Sage Payroll / Holded. Cálculo simple
            (gross → IRPF → SS → net) para alimentar a la gestoría sin contabilizar todavía.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button
            type="button"
            className="ghost"
            onClick={() => {
              contracts.refresh();
              periods.refresh();
              if (selectedPeriodId) slips.refresh();
            }}
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      <section className="rev-kpi-grid">
        <article className={`rev-kpi ${openPeriods > 0 ? "rev-kpi-warn" : "rev-kpi-ok"}`}>
          <div className="rev-kpi-head"><span className="rev-kpi-label">Open periods</span></div>
          <div className="rev-kpi-value">{openPeriods}</div>
          <div className="rev-kpi-delta">awaiting calculation</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Last calculated</span></div>
          <div className="rev-kpi-value" style={{ fontSize: 24 }}>{lastCalculated?.periodCode ?? "—"}</div>
          <div className="rev-kpi-delta">{lastCalculated ? fmt(lastCalculated.totalGross) : "no periods yet"}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Gross MTD</span></div>
          <div className="rev-kpi-value">{fmt(grossMTD)}</div>
          <div className="rev-kpi-delta">period {currentMonthCode()}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Active contracts</span></div>
          <div className="rev-kpi-value">{contractsArr.filter((c) => c.active).length}</div>
          <div className="rev-kpi-delta">{contractsArr.length} total</div>
        </article>
      </section>

      {error ? (
        <div className="bo-card" style={{ borderLeft: "3px solid var(--danger-ink)", marginBottom: 16 }}>
          Couldn't load this view right now. Refresh to retry.
        </div>
      ) : null}

      <div className="rev-toolbar" style={{ gap: 8 }}>
        <button
          type="button"
          className={tab === "contracts" ? "primary" : "ghost"}
          onClick={() => setTab("contracts")}
        >
          Contracts ({contractsArr.length})
        </button>
        <button
          type="button"
          className={tab === "periods" ? "primary" : "ghost"}
          onClick={() => setTab("periods")}
        >
          Payroll periods ({periodsArr.length})
        </button>
        <button
          type="button"
          className={tab === "slips" ? "primary" : "ghost"}
          onClick={() => setTab("slips")}
          disabled={!selectedPeriodId}
        >
          Slips {slips.data ? `(${slips.data.length})` : ""}
        </button>
      </div>

      {tab === "contracts" ? (
        <ContractsTab
          contracts={contractsArr}
          loading={contracts.loading}
          fetchError={contracts.error}
          showForm={showNewContract}
          onToggleForm={() => setShowNewContract((v) => !v)}
          onCreated={() => {
            setShowNewContract(false);
            contracts.refresh();
          }}
          onDeactivate={async (id) => {
            setBusy(`deact-${id}`);
            setError(null);
            try {
              await apiRequest(`/payroll/contracts/${id}/deactivate`, { method: "POST" });
              contracts.refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(null);
            }
          }}
          busy={busy}
        />
      ) : null}

      {tab === "periods" ? (
        <PeriodsTab
          periods={periodsArr}
          loading={periods.loading}
          fetchError={periods.error}
          showForm={showNewPeriod}
          onToggleForm={() => setShowNewPeriod((v) => !v)}
          onCreated={() => {
            setShowNewPeriod(false);
            periods.refresh();
          }}
          onCalculate={handleCalculate}
          onExport={handleExport}
          onViewSlips={openSlipsFor}
          busy={busy}
        />
      ) : null}

      {tab === "slips" ? (
        <SlipsTab
          period={periodsArr.find((p) => p.id === selectedPeriodId) ?? null}
          slips={slips.data}
          loading={slips.loading}
          fetchError={slips.error}
          contractsById={new Map(contractsArr.map((c) => [c.id, c]))}
        />
      ) : null}
    </>
  );
}

// ---- Tab: Contracts ----

function ContractsTab(props: {
  contracts: Contract[] | null;
  loading: boolean;
  fetchError: string | null;
  showForm: boolean;
  onToggleForm: () => void;
  onCreated: () => void;
  onDeactivate: (id: string) => void;
  busy: string | null;
}) {
  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <h2 style={{ fontSize: 20 }}>Employment contracts</h2>
        <button type="button" className="primary" onClick={props.onToggleForm}>
          {props.showForm ? "Cancel" : "+ Add contract"}
        </button>
      </div>

      {props.showForm ? <NewContractForm onCreated={props.onCreated} /> : null}

      {props.loading ? (
        <p style={{ color: "var(--ink-muted)" }}>Loading contracts…</p>
      ) : props.fetchError ? (
        <p style={{ color: "var(--danger-ink)" }}>{props.fetchError}</p>
      ) : (props.contracts ?? []).length === 0 ? (
        <p style={{ color: "var(--ink-muted)" }}>No employment contracts yet. Add the first one above.</p>
      ) : (
        <div className="rev-report-wrap">
          <table className="cm-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Type</th>
                <th style={{ textAlign: "right" }}>Gross / month</th>
                <th style={{ textAlign: "right" }}>IRPF %</th>
                <th>Started</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(props.contracts ?? []).map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.staffProfileId}</strong></td>
                  <td>{c.contractType}</td>
                  <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(c.grossSalary)}</td>
                  <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>
                    {c.irpfRatePct === undefined ? <span style={{ color: "var(--ink-muted)" }}>auto</span> : `${c.irpfRatePct}%`}
                  </td>
                  <td>{c.startDate}</td>
                  <td>
                    <span className={c.active ? "bo-status ok" : "bo-status"}>
                      {c.active ? "active" : "inactive"}
                    </span>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {c.active ? (
                      <button
                        type="button"
                        className="ghost"
                        disabled={props.busy === `deact-${c.id}`}
                        onClick={() => props.onDeactivate(c.id)}
                      >
                        {props.busy === `deact-${c.id}` ? "…" : "Deactivate"}
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
  );
}

function NewContractForm(props: { onCreated: () => void }) {
  const [staffProfileId, setStaffProfileId] = useState("");
  const [contractType, setContractType] = useState("indefinido");
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [grossSalary, setGrossSalary] = useState<string>("1800");
  const [irpfRatePct, setIrpfRatePct] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit() {
    if (!staffProfileId.trim()) {
      setFormError("Staff profile id is required.");
      return;
    }
    const gross = Number(grossSalary);
    if (!Number.isFinite(gross) || gross < 0) {
      setFormError("Gross salary must be a number ≥ 0.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await apiRequest("/payroll/contracts", {
        method: "POST",
        body: {
          staffProfileId: staffProfileId.trim(),
          propertyId: PROPERTY_ID,
          contractType,
          startDate,
          grossSalary: gross,
          irpfRatePct: irpfRatePct.trim() === "" ? undefined : Number(irpfRatePct)
        }
      });
      props.onCreated();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="bo-card"
      style={{ background: "var(--surface)", marginBottom: 16, padding: 16, border: "1px solid var(--line)" }}
    >
      <h3 style={{ fontSize: 16, marginTop: 0 }}>New employment contract</h3>
      <div className="bo-grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        <label>
          Staff profile id
          <input value={staffProfileId} onChange={(e) => setStaffProfileId(e.target.value)} placeholder="staff_abc" />
        </label>
        <label>
          Contract type
          <select value={contractType} onChange={(e) => setContractType(e.target.value)}>
            <option value="indefinido">Indefinido</option>
            <option value="temporal">Temporal</option>
            <option value="practicas">Prácticas</option>
            <option value="formacion">Formación</option>
          </select>
        </label>
        <label>
          Start date
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </label>
        <label>
          Gross / month (€)
          <input type="number" min={0} step="0.01" value={grossSalary} onChange={(e) => setGrossSalary(e.target.value)} />
        </label>
        <label>
          IRPF % <span style={{ color: "var(--ink-muted)", fontWeight: "normal" }}>(blank = auto)</span>
          <input type="number" min={0} max={50} step="0.01" value={irpfRatePct} onChange={(e) => setIrpfRatePct(e.target.value)} />
        </label>
      </div>
      {formError ? <p style={{ color: "var(--danger-ink)", marginTop: 8 }}>{formError}</p> : null}
      <div style={{ marginTop: 12 }}>
        <button type="button" className="primary" disabled={submitting} onClick={submit}>
          {submitting ? "Saving…" : "Save contract"}
        </button>
      </div>
    </div>
  );
}

// ---- Tab: Periods ----

function PeriodsTab(props: {
  periods: Period[] | null;
  loading: boolean;
  fetchError: string | null;
  showForm: boolean;
  onToggleForm: () => void;
  onCreated: () => void;
  onCalculate: (id: string) => void;
  onExport: (id: string, format: "a3" | "sage") => void;
  onViewSlips: (id: string) => void;
  busy: string | null;
}) {
  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <h2 style={{ fontSize: 20 }}>Payroll periods</h2>
        <button type="button" className="primary" onClick={props.onToggleForm}>
          {props.showForm ? "Cancel" : "+ Open period"}
        </button>
      </div>

      {props.showForm ? <NewPeriodForm onCreated={props.onCreated} /> : null}

      {props.loading ? (
        <p style={{ color: "var(--ink-muted)" }}>Loading periods…</p>
      ) : props.fetchError ? (
        <p style={{ color: "var(--danger-ink)" }}>{props.fetchError}</p>
      ) : (props.periods ?? []).length === 0 ? (
        <p style={{ color: "var(--ink-muted)" }}>No payroll periods yet. Open one for the current month above.</p>
      ) : (
        <div className="rev-report-wrap">
          <table className="cm-table">
            <thead>
              <tr>
                <th>Period</th>
                <th>Status</th>
                <th style={{ textAlign: "right" }}>Gross</th>
                <th style={{ textAlign: "right" }}>Net</th>
                <th style={{ textAlign: "right" }}>IRPF</th>
                <th style={{ textAlign: "right" }}>SS</th>
                <th style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {(props.periods ?? []).map((p) => (
                <tr key={p.id}>
                  <td><strong>{p.periodCode}</strong></td>
                  <td><span className={statusPillClass(p.status)}>{p.status}</span></td>
                  <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(p.totalGross)}</td>
                  <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(p.totalNet)}</td>
                  <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(p.totalIrpf)}</td>
                  <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(p.totalSs)}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <button
                      type="button"
                      className="ghost"
                      disabled={props.busy === `calc-${p.id}` || p.status === "closed"}
                      onClick={() => props.onCalculate(p.id)}
                    >
                      {props.busy === `calc-${p.id}` ? "…" : "Calculate"}
                    </button>{" "}
                    <button
                      type="button"
                      className="ghost"
                      disabled={props.busy === `export-${p.id}-a3` || p.status === "open"}
                      onClick={() => props.onExport(p.id, "a3")}
                    >
                      {props.busy === `export-${p.id}-a3` ? "…" : "Export A3"}
                    </button>{" "}
                    <button
                      type="button"
                      className="ghost"
                      disabled={props.busy === `export-${p.id}-sage` || p.status === "open"}
                      onClick={() => props.onExport(p.id, "sage")}
                    >
                      {props.busy === `export-${p.id}-sage` ? "…" : "Export Sage"}
                    </button>{" "}
                    <button type="button" className="ghost" onClick={() => props.onViewSlips(p.id)}>
                      View slips →
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function NewPeriodForm(props: { onCreated: () => void }) {
  const [periodCode, setPeriodCode] = useState<string>(() => currentMonthCode());
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function submit() {
    if (!/^\d{4}-\d{2}$/.test(periodCode)) {
      setFormError("Period code must be YYYY-MM.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      await apiRequest("/payroll/periods", {
        method: "POST",
        body: { organizationId: ORG_ID, propertyId: PROPERTY_ID, periodCode }
      });
      props.onCreated();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="bo-card"
      style={{ background: "var(--surface)", marginBottom: 16, padding: 16, border: "1px solid var(--line)" }}
    >
      <h3 style={{ fontSize: 16, marginTop: 0 }}>Open new payroll period</h3>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
        <label>
          Period (YYYY-MM)
          <input value={periodCode} onChange={(e) => setPeriodCode(e.target.value)} placeholder="2026-05" />
        </label>
        <button type="button" className="primary" disabled={submitting} onClick={submit}>
          {submitting ? "Opening…" : "Open period"}
        </button>
      </div>
      {formError ? <p style={{ color: "var(--danger-ink)", marginTop: 8 }}>{formError}</p> : null}
    </div>
  );
}

// ---- Tab: Slips ----

function SlipsTab(props: {
  period: Period | null;
  slips: Slip[] | null;
  loading: boolean;
  fetchError: string | null;
  contractsById: Map<string, Contract>;
}) {
  if (!props.period) {
    return (
      <section className="bo-card">
        <p style={{ color: "var(--ink-muted)" }}>Pick a period in the “Payroll periods” tab to view slips.</p>
      </section>
    );
  }

  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <h2 style={{ fontSize: 20 }}>Slips · {props.period.periodCode}</h2>
        <span className={statusPillClass(props.period.status)}>{props.period.status}</span>
      </div>

      {props.loading ? (
        <p style={{ color: "var(--ink-muted)" }}>Loading slips…</p>
      ) : props.fetchError ? (
        <p style={{ color: "var(--danger-ink)" }}>{props.fetchError}</p>
      ) : (props.slips ?? []).length === 0 ? (
        <p style={{ color: "var(--ink-muted)" }}>
          No slips yet. Run “Calculate” on the period to generate one slip per active contract.
        </p>
      ) : (
        <div className="rev-report-wrap">
          <table className="cm-table">
            <thead>
              <tr>
                <th>Employee</th>
                <th style={{ textAlign: "right" }}>Gross</th>
                <th style={{ textAlign: "right" }}>IRPF</th>
                <th style={{ textAlign: "right" }}>SS (worker)</th>
                <th style={{ textAlign: "right" }}>SS (company)</th>
                <th style={{ textAlign: "right" }}>Net</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {(props.slips ?? []).map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.staffProfileId}</strong></td>
                  <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>{fmt(s.grossSalary)}</td>
                  <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", color: "var(--danger-ink)" }}>
                    -{fmt(s.irpfRetention)}
                  </td>
                  <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", color: "var(--danger-ink)" }}>
                    -{fmt(s.ssEmployee)}
                  </td>
                  <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", color: "var(--ink-muted)" }}>
                    {fmt(s.ssEmployer)}
                  </td>
                  <td style={{ textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 700 }}>
                    {fmt(s.netSalary)}
                  </td>
                  <td><span className="bo-status">{s.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

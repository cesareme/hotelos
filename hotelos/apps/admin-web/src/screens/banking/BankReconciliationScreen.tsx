import { getActivePropertyId } from "../../services/activeProperty";
import { useEffect, useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { LoadingBlock } from "../../components/States";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";

const PROPERTY_ID = getActivePropertyId();

// ---- Types matching the API contract ----

type BankAccountRow = {
  id: string;
  propertyId: string;
  organizationId: string;
  name: string;
  bankName: string | null;
  iban: string | null;
  bic: string | null;
  currencyCode: string;
  ledgerAccountCode: string | null;
  openingBalance: number;
  active: boolean;
  statementClosing: number | null;
  ledgerBalance: number;
  drift: number;
  latestStatementId: string | null;
  latestStatementPeriodEnd: string | null;
};

type StatementLine = {
  id: string;
  statementId: string;
  bankAccountId: string;
  txDate: string;
  valueDate: string | null;
  amount: number;
  currencyCode: string;
  description: string | null;
  reference: string | null;
  counterparty: string | null;
  matchedTo: string | null;
  match: null | {
    id: string;
    matchType: string;
    matchedEntityId: string;
    amount: number;
    matchedAt: string;
    confidence: string | null;
    notes: string | null;
  };
};

type Statement = {
  id: string;
  bankAccountId: string;
  propertyId: string;
  periodStart: string;
  periodEnd: string;
  openingBalance: number;
  closingBalance: number;
  source: string | null;
  status: string;
  importedAt: string;
  lines: StatementLine[];
};

type StatementSummary = Omit<Statement, "lines">;

type ReconciliationStatus = {
  bankAccountId: string;
  totalLines: number;
  matched: number;
  unmatched: number;
  percentage: number;
};

type AutoMatchResult = {
  statementId: string;
  scanned: number;
  matched: number;
  alreadyMatched: number;
};

// ---- Helpers ----

function fmt(amount: number, currency = "EUR"): string {
  return new Intl.NumberFormat("es-ES", { useGrouping: true,
    style: "currency",
    currency,
    minimumFractionDigits: 2
  }).format(amount);
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-ES");
}

function driftClass(drift: number): "ok" | "warn" | "error" {
  const abs = Math.abs(drift);
  if (abs < 0.01) return "ok";
  if (abs < 10) return "warn";
  return "error";
}

const CSV_PLACEHOLDER = `date,amount,description,reference,counterparty
2026-05-01,1250.00,Transfer in,REF-1001,Acme Corp
01/05/2026,-89.90,Office supplies,REF-1002,Papeleria
2026-05-02,-450,Cleaning supplier,SUP-77,LimpioSL`;

// ---- Component ----

export function BankReconciliationScreen() {
  const { showToast } = useToast();
  const accounts = useApiData<BankAccountRow[]>("/banking/accounts", { query: { propertyId: PROPERTY_ID } });
  const accountsArr = useMemo(() => toArray<BankAccountRow>(accounts.data), [accounts.data]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  // Auto-select the first account when the list arrives.
  useEffect(() => {
    if (!selectedAccountId && accountsArr.length > 0) {
      setSelectedAccountId(accountsArr[0].id);
    }
  }, [accountsArr, selectedAccountId]);

  const selectedAccount = useMemo(
    () => accountsArr.find((a) => a.id === selectedAccountId) ?? null,
    [accountsArr, selectedAccountId]
  );

  const statements = useApiData<StatementSummary[]>(
    selectedAccountId ? `/banking/accounts/${selectedAccountId}/statements` : null
  );

  const reconStatus = useApiData<ReconciliationStatus>(
    selectedAccountId ? `/banking/accounts/${selectedAccountId}/reconciliation-status` : null
  );

  // We always view the most recent statement (statements come desc by periodEnd).
  const latestStatementId = statements.data?.[0]?.id ?? null;
  const statement = useApiData<Statement>(latestStatementId ? `/banking/statements/${latestStatementId}` : null);

  // ---- New account form ----
  const [newAccount, setNewAccount] = useState({
    name: "",
    bankName: "",
    iban: "",
    ledgerAccountCode: "572",
    openingBalance: "0"
  });
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function handleCreateAccount() {
    if (!newAccount.name.trim()) {
      setCreateError("Name is required.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const opening = Number(newAccount.openingBalance);
      await apiRequest("/banking/accounts", {
        method: "POST",
        body: {
          propertyId: PROPERTY_ID,
          name: newAccount.name.trim(),
          bankName: newAccount.bankName || undefined,
          iban: newAccount.iban || undefined,
          ledgerAccountCode: newAccount.ledgerAccountCode || undefined,
          openingBalance: Number.isFinite(opening) ? opening : 0
        }
      });
      setNewAccount({ name: "", bankName: "", iban: "", ledgerAccountCode: "572", openingBalance: "0" });
      accounts.refresh();
      showToast("Cuenta bancaria creada", { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setCreateError(message);
      showToast(message, { variant: "error" });
    } finally {
      setCreating(false);
    }
  }

  // ---- CSV import ----
  const [csv, setCsv] = useState("");
  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  async function handleImportCsv() {
    if (!selectedAccountId) return;
    if (!csv.trim()) {
      setImportMsg("Paste CSV first.");
      return;
    }
    setImporting(true);
    setImportMsg(null);
    try {
      const result = await apiRequest<Statement>(
        `/banking/accounts/${selectedAccountId}/statements/import-csv`,
        { method: "POST", body: { csv } }
      );
      const okMessage = `Imported statement ${result.id} with ${result.lines.length} lines.`;
      setImportMsg(okMessage);
      setCsv("");
      statements.refresh();
      reconStatus.refresh();
      accounts.refresh();
      showToast(`Extracto importado · ${result.lines.length} líneas`, { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setImportMsg(`Import failed: ${message}`);
      showToast(message, { variant: "error" });
    } finally {
      setImporting(false);
    }
  }

  // ---- Auto-match ----
  const [autoBusy, setAutoBusy] = useState(false);
  const [autoMsg, setAutoMsg] = useState<string | null>(null);

  async function handleAutoMatch() {
    if (!latestStatementId) return;
    setAutoBusy(true);
    setAutoMsg(null);
    try {
      const result = await apiRequest<AutoMatchResult>(
        `/banking/statements/${latestStatementId}/auto-match`,
        { method: "POST" }
      );
      setAutoMsg(
        `Scanned ${result.scanned}; matched ${result.matched}; already matched ${result.alreadyMatched}.`
      );
      statement.refresh();
      reconStatus.refresh();
      accounts.refresh();
      showToast(`Auto-match · ${result.matched} líneas conciliadas`, { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setAutoMsg(`Auto-match failed: ${message}`);
      showToast(message, { variant: "error" });
    } finally {
      setAutoBusy(false);
    }
  }

  // ---- Per-line manual match ----
  const [matchDraft, setMatchDraft] = useState<
    Record<string, { matchType: "payment" | "supplier_bill" | "manual"; matchedEntityId: string }>
  >({});

  function updateDraft(lineId: string, patch: Partial<{ matchType: "payment" | "supplier_bill" | "manual"; matchedEntityId: string }>) {
    setMatchDraft((prev) => ({
      ...prev,
      [lineId]: {
        matchType: prev[lineId]?.matchType ?? "payment",
        matchedEntityId: prev[lineId]?.matchedEntityId ?? "",
        ...patch
      }
    }));
  }

  async function handleManualMatch(lineId: string) {
    const draft = matchDraft[lineId];
    if (!draft?.matchedEntityId?.trim()) return;
    try {
      await apiRequest(`/banking/lines/${lineId}/match`, {
        method: "POST",
        body: { matchType: draft.matchType, matchedEntityId: draft.matchedEntityId.trim() }
      });
      setMatchDraft((prev) => {
        const next = { ...prev };
        delete next[lineId];
        return next;
      });
      statement.refresh();
      reconStatus.refresh();
      accounts.refresh();
      showToast("Línea conciliada", { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setAutoMsg(`Manual match failed: ${message}`);
      showToast(message, { variant: "error" });
    }
  }

  async function handleUnmatch(lineId: string) {
    try {
      await apiRequest(`/banking/lines/${lineId}/match`, { method: "DELETE" });
      statement.refresh();
      reconStatus.refresh();
      accounts.refresh();
      showToast("Conciliación deshecha", { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setAutoMsg(`Unmatch failed: ${message}`);
      showToast(message, { variant: "error" });
    }
  }

  // ---- Render ----

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Treasury · Bank reconciliation</div>
          <h1 className="bo-page-title">Conciliación bancaria</h1>
          <p className="bo-page-subtitle">
            Importa extractos en CSV, ejecuta auto-match contra <strong>Payment</strong> y <strong>SupplierBill</strong>, y resuelve manualmente lo que falte.
            El drift compara el closing del extracto con la cuenta 572 del libro mayor.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" onClick={() => { accounts.refresh(); statements.refresh(); statement.refresh(); reconStatus.refresh(); }}>↻ Refresh</button>
        </div>
      </div>

      <div className="bo-grid" style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 16, alignItems: "start" }}>
        {/* Sidebar */}
        <aside className="bo-card" style={{ padding: 12 }}>
          <h3 style={{ marginTop: 0 }}>Cuentas bancarias</h3>
          {accounts.loading ? <LoadingBlock /> : null}
          {accounts.error ? <p style={{ color: "var(--danger-ink)" }}>{accounts.error}</p> : null}
          {accountsArr.length === 0 && !accounts.loading ? (
            <p className="bo-muted">Aún no hay cuentas. Crea una abajo.</p>
          ) : null}
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {accountsArr.map((account) => {
              const cls = driftClass(account.drift);
              const isSelected = account.id === selectedAccountId;
              return (
                <li key={account.id} style={{ marginBottom: 8 }}>
                  <button
                    type="button"
                    onClick={() => setSelectedAccountId(account.id)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: 10,
                      border: isSelected ? "2px solid var(--brand-ink)" : "1px solid var(--border)",
                      borderRadius: 8,
                      background: isSelected ? "var(--brand-soft, #eef)" : "transparent",
                      cursor: "pointer"
                    }}
                  >
                    <div style={{ fontWeight: 600 }}>{account.name}</div>
                    <div className="bo-muted" style={{ fontSize: 12 }}>
                      {account.bankName ?? "—"} · {account.iban ?? "sin IBAN"}
                    </div>
                    <div style={{ marginTop: 6, display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                      <span>Libro: {fmt(account.ledgerBalance, account.currencyCode)}</span>
                      <span>Extracto: {account.statementClosing == null ? "—" : fmt(account.statementClosing, account.currencyCode)}</span>
                    </div>
                    <div style={{ marginTop: 6 }}>
                      <span className={`bo-status ${cls}`}>
                        Drift {fmt(account.drift, account.currencyCode)}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>

          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>+ Crear cuenta</summary>
            <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
              <input
                placeholder="Nombre (p.ej. BBVA Cuenta principal)"
                value={newAccount.name}
                onChange={(e) => setNewAccount({ ...newAccount, name: e.target.value })}
              />
              <input
                placeholder="Banco"
                value={newAccount.bankName}
                onChange={(e) => setNewAccount({ ...newAccount, bankName: e.target.value })}
              />
              <input
                placeholder="IBAN"
                value={newAccount.iban}
                onChange={(e) => setNewAccount({ ...newAccount, iban: e.target.value })}
              />
              <input
                placeholder="Cuenta PGC (default 572)"
                value={newAccount.ledgerAccountCode}
                onChange={(e) => setNewAccount({ ...newAccount, ledgerAccountCode: e.target.value })}
              />
              <input
                type="number"
                step="0.01"
                placeholder="Saldo inicial"
                value={newAccount.openingBalance}
                onChange={(e) => setNewAccount({ ...newAccount, openingBalance: e.target.value })}
              />
              {createError ? <small style={{ color: "var(--danger-ink)" }}>{createError}</small> : null}
              <button type="button" className="primary" onClick={handleCreateAccount} disabled={creating}>
                {creating ? "Creando…" : "Crear cuenta"}
              </button>
            </div>
          </details>
        </aside>

        {/* Main pane */}
        <section>
          {!selectedAccount ? (
            <div className="bo-card">
              <p className="bo-muted">Selecciona una cuenta para ver el último extracto.</p>
            </div>
          ) : (
            <>
              {/* KPIs */}
              <section className="rev-kpi-grid" style={{ marginBottom: 16 }}>
                <article className={`rev-kpi rev-kpi-${driftClass(selectedAccount.drift) === "ok" ? "ok" : driftClass(selectedAccount.drift) === "warn" ? "warn" : "error"}`}>
                  <div className="rev-kpi-head"><span className="rev-kpi-label">Drift</span></div>
                  <div className="rev-kpi-value">{fmt(selectedAccount.drift, selectedAccount.currencyCode)}</div>
                  <div className="rev-kpi-delta">Extracto − libro</div>
                </article>
                <article className="rev-kpi rev-kpi-ok">
                  <div className="rev-kpi-head"><span className="rev-kpi-label">Saldo libro (572)</span></div>
                  <div className="rev-kpi-value">{fmt(selectedAccount.ledgerBalance, selectedAccount.currencyCode)}</div>
                  <div className="rev-kpi-delta">Sumando JournalLine · cuenta {selectedAccount.ledgerAccountCode ?? "—"}</div>
                </article>
                <article className="rev-kpi rev-kpi-ok">
                  <div className="rev-kpi-head"><span className="rev-kpi-label">Closing extracto</span></div>
                  <div className="rev-kpi-value">
                    {selectedAccount.statementClosing == null ? "—" : fmt(selectedAccount.statementClosing, selectedAccount.currencyCode)}
                  </div>
                  <div className="rev-kpi-delta">
                    {selectedAccount.latestStatementPeriodEnd ? `Hasta ${fmtDate(selectedAccount.latestStatementPeriodEnd)}` : "Sin extractos"}
                  </div>
                </article>
                <article className="rev-kpi rev-kpi-ok">
                  <div className="rev-kpi-head"><span className="rev-kpi-label">Conciliado</span></div>
                  <div className="rev-kpi-value">{reconStatus.data?.percentage ?? 0}%</div>
                  <div className="rev-kpi-delta">
                    {(reconStatus.data?.matched ?? 0)} / {(reconStatus.data?.totalLines ?? 0)} líneas
                  </div>
                </article>
              </section>

              {/* CSV import */}
              <div className="bo-card" style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                  <h3 style={{ margin: 0 }}>Importar extracto (CSV)</h3>
                  <small className="bo-muted">Header: <code>date,amount,description,reference,counterparty</code>. Soporta DD/MM/YYYY e ISO. Coma o punto decimal.</small>
                </div>
                <textarea
                  value={csv}
                  onChange={(e) => setCsv(e.target.value)}
                  placeholder={CSV_PLACEHOLDER}
                  rows={6}
                  style={{ width: "100%", marginTop: 8, fontFamily: "monospace", fontSize: 12 }}
                />
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
                  <button type="button" className="primary" onClick={handleImportCsv} disabled={importing}>
                    {importing ? "Importando…" : "Importar"}
                  </button>
                  {importMsg ? <small className="bo-muted">{importMsg}</small> : null}
                </div>
              </div>

              {/* Statement viewer */}
              {!latestStatementId ? (
                <div className="bo-card">
                  <p className="bo-muted">Aún no hay extractos para esta cuenta.</p>
                </div>
              ) : statement.loading ? (
                <div className="bo-card"><LoadingBlock label="Cargando extracto…" /></div>
              ) : statement.error ? (
                <div className="bo-card"><p style={{ color: "var(--danger-ink)" }}>{statement.error}</p></div>
              ) : statement.data ? (
                <div className="bo-card">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <h3 style={{ margin: 0 }}>
                        Extracto {fmtDate(statement.data.periodStart)} → {fmtDate(statement.data.periodEnd)}
                      </h3>
                      <small className="bo-muted">
                        Apertura {fmt(statement.data.openingBalance)} · Cierre {fmt(statement.data.closingBalance)} ·
                        Estado <strong>{statement.data.status}</strong>
                      </small>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" className="primary" onClick={handleAutoMatch} disabled={autoBusy}>
                        {autoBusy ? "Procesando…" : "Auto-match"}
                      </button>
                    </div>
                  </div>
                  {autoMsg ? <p className="bo-muted" style={{ marginTop: 8 }}>{autoMsg}</p> : null}

                  <table style={{ width: "100%", marginTop: 12, borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ textAlign: "left", borderBottom: "1px solid var(--border)" }}>
                        <th style={{ padding: 6 }}>Fecha</th>
                        <th style={{ padding: 6 }}>Descripción</th>
                        <th style={{ padding: 6 }}>Referencia</th>
                        <th style={{ padding: 6, textAlign: "right" }}>Importe</th>
                        <th style={{ padding: 6 }}>Estado</th>
                        <th style={{ padding: 6 }}>Acción</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statement.data.lines.map((line) => {
                        const matched = !!line.match;
                        const draft = matchDraft[line.id];
                        return (
                          <tr key={line.id} style={{ borderBottom: "1px solid var(--border)" }}>
                            <td style={{ padding: 6 }}>{fmtDate(line.txDate)}</td>
                            <td style={{ padding: 6 }}>
                              <div>{line.description ?? "—"}</div>
                              {line.counterparty ? <small className="bo-muted">{line.counterparty}</small> : null}
                            </td>
                            <td style={{ padding: 6 }}>{line.reference ?? "—"}</td>
                            <td style={{ padding: 6, textAlign: "right", color: line.amount < 0 ? "var(--danger-ink)" : "var(--success-ink, inherit)" }}>
                              {fmt(line.amount, line.currencyCode)}
                            </td>
                            <td style={{ padding: 6 }}>
                              {matched ? (
                                <span className="bo-status ok">
                                  {line.match!.matchType} · {line.match!.confidence ?? "manual"}
                                </span>
                              ) : (
                                <span className="bo-status warn">unmatched</span>
                              )}
                            </td>
                            <td style={{ padding: 6 }}>
                              {matched ? (
                                <button type="button" className="ghost" onClick={() => handleUnmatch(line.id)}>
                                  Unmatch
                                </button>
                              ) : (
                                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                                  <select
                                    value={draft?.matchType ?? "payment"}
                                    onChange={(e) => updateDraft(line.id, { matchType: e.target.value as "payment" | "supplier_bill" | "manual" })}
                                  >
                                    <option value="payment">Payment</option>
                                    <option value="supplier_bill">SupplierBill</option>
                                    <option value="manual">Manual</option>
                                  </select>
                                  <input
                                    placeholder="ID"
                                    value={draft?.matchedEntityId ?? ""}
                                    onChange={(e) => updateDraft(line.id, { matchedEntityId: e.target.value })}
                                    style={{ width: 140 }}
                                  />
                                  <button type="button" className="primary" onClick={() => handleManualMatch(line.id)}>
                                    Match
                                  </button>
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                      {statement.data.lines.length === 0 ? (
                        <tr><td colSpan={6} className="bo-muted" style={{ padding: 12, textAlign: "center" }}>Extracto vacío.</td></tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </>
  );
}

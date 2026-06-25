// Banking España — importador CSB-43 con matches sugeridos + generador SEPA Norma 19.
// 2 tabs en un solo screen para mantener la cohesión del módulo.

import { useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { importCsb43, generateSepaRemittance, validateIban, type Csb43ImportResult, type SepaResult } from "../../services/bankingApi";
import { Spinner } from "../../components/States";

const PROPERTY_ID = getActivePropertyId();

type Tab = "csb43" | "sepa";

function fmtMoney(n: number, currency = "EUR"): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}

export function BankingSpainScreen() {
  const [tab, setTab] = useState<Tab>("csb43");

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
            Finanzas · Banca española
          </p>
          <h2 style={{ color: "var(--ink)" }}>Conciliación CSB-43 + remesas SEPA</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Importa el extracto de tu banco en formato AEB <strong>Cuaderno 43</strong> y deja que el motor identifique los
            movimientos que coinciden con los pagos del PMS. Genera remesas <strong>SEPA Norma 19</strong> (pain.008.001.02)
            para domiciliaciones a empresas y huéspedes con mandato.
          </p>
        </div>
      </header>

      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" onClick={() => setTab("csb43")} className={tab === "csb43" ? "primary" : ""} style={{ padding: "8px 14px" }}>
          📥 Importar CSB-43 (extracto)
        </button>
        <button type="button" onClick={() => setTab("sepa")} className={tab === "sepa" ? "primary" : ""} style={{ padding: "8px 14px" }}>
          📤 Generar remesa SEPA (Norma 19)
        </button>
      </div>

      {tab === "csb43" ? <Csb43Tab /> : <SepaTab />}
    </section>
  );
}

// ---------------------------------------------------------------------------
// CSB-43 importer tab
// ---------------------------------------------------------------------------

function Csb43Tab() {
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Csb43ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setContent(text);
  }

  async function handleImport() {
    if (!content.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await importCsb43(PROPERTY_ID, content);
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Sube el extracto</h3></div>
        <p className="bo-muted" style={{ textTransform: "none", marginTop: 0 }}>
          Acepta cualquier fichero .txt/.csb en formato Cuaderno 43 (texto fijo, 80 columnas). Tu banco lo emite desde la web/SFTP.
        </p>
        <input type="file" accept=".txt,.csb,.dat,text/plain" onChange={handleFile} />
        {content ? (
          <p className="bo-status info" style={{ textTransform: "none", marginTop: 8 }}>
            Fichero cargado · {content.length.toLocaleString("es-ES")} caracteres
          </p>
        ) : null}
        <div style={{ marginTop: 8 }}>
          <button type="button" className="primary" onClick={handleImport} disabled={!content.trim() || busy}>
            {busy ? <Spinner size="sm" /> : "Importar y conciliar"}
          </button>
        </div>
        {error ? <p className="bo-status warn" style={{ textTransform: "none", marginTop: 8 }}>{error}</p> : null}
      </article>

      {result ? (
        <>
          {result.accounts.map((acc, ai) => (
            <article key={ai} className="bo-card" style={{ background: "var(--surface)" }}>
              <div className="bo-card-head">
                <h3 style={{ color: "var(--ink)" }}>
                  Banco {acc.bankCode} · Sucursal {acc.branchCode} · …{acc.accountNumber.slice(-4)}
                </h3>
                <span className="bo-chip">{acc.fromDate} → {acc.toDate}</span>
              </div>
              <div className="rev-kpi-grid">
                <article className="rev-kpi rev-kpi-ok">
                  <div className="rev-kpi-head"><span className="rev-kpi-label">Saldo inicial</span></div>
                  <div className="rev-kpi-value" style={{ fontSize: 18 }}>{fmtMoney(acc.initialBalance, acc.currency)}</div>
                </article>
                <article className="rev-kpi rev-kpi-ok">
                  <div className="rev-kpi-head"><span className="rev-kpi-label">Saldo final</span></div>
                  <div className="rev-kpi-value" style={{ fontSize: 18 }}>{fmtMoney(acc.finalBalance, acc.currency)}</div>
                </article>
                <article className="rev-kpi rev-kpi-ok">
                  <div className="rev-kpi-head"><span className="rev-kpi-label">Movimientos</span><span className="bo-status info">{acc.matches.length} matches</span></div>
                  <div className="rev-kpi-value" style={{ fontSize: 18 }}>{acc.movements.length}</div>
                </article>
              </div>

              <div className="rev-report-wrap" style={{ marginTop: 12 }}>
                <table className="cm-table">
                  <thead><tr><th>Fecha</th><th>Concepto</th><th>Importe</th><th>Saldo</th><th>Match</th></tr></thead>
                  <tbody>
                    {acc.movements.map((m, mi) => {
                      const match = acc.matches.find((x) => x.movementIndex === mi);
                      return (
                        <tr key={mi}>
                          <td className="mono" style={{ fontSize: 11 }}>{m.operationDate}</td>
                          <td style={{ fontSize: 12 }}>
                            {m.descriptions[0] ?? m.conceptCode}
                            {m.referenceA ? <small className="bo-muted" style={{ display: "block" }}>ref {m.referenceA}</small> : null}
                          </td>
                          <td className="mono" style={{ color: m.amount >= 0 ? "var(--accent)" : "var(--warn-ink)" }}>
                            {fmtMoney(m.amount, acc.currency)}
                          </td>
                          <td className="mono">{fmtMoney(m.runningBalance, acc.currency)}</td>
                          <td>
                            {match ? (
                              <span className={`bo-status ${match.confidence === "high" ? "ok" : "info"}`} style={{ fontSize: 10 }}>
                                {match.confidence} · {match.paymentId.slice(0, 12)}
                              </span>
                            ) : <span className="bo-muted">—</span>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </article>
          ))}
          {result.unmatchedPayments.length > 0 ? (
            <article className="bo-card" style={{ background: "var(--surface)" }}>
              <div className="bo-card-head">
                <h3 style={{ color: "var(--ink)" }}>Pagos sin conciliar</h3>
                <span className="bo-chip">{result.unmatchedPayments.length}</span>
              </div>
              <p className="bo-muted" style={{ textTransform: "none" }}>
                Capturados en el PMS pero no encontrados en el extracto. Revisa fechas de captura o referencias bancarias.
              </p>
              <ul className="mono" style={{ fontSize: 11, columnCount: 3 }}>
                {result.unmatchedPayments.map((p) => <li key={p}>{p}</li>)}
              </ul>
            </article>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SEPA Norma 19 generator tab
// ---------------------------------------------------------------------------

type Debtor = {
  mandateId: string;
  mandateSignedAt: string;
  name: string;
  iban: string;
  amount: number;
  description: string;
  endToEndId: string;
};

function SepaTab() {
  const [creditorName, setCreditorName] = useState("Anfitorio Madrid Centro SL");
  const [creditorId, setCreditorId] = useState("ES12345A12345678");
  const [creditorIban, setCreditorIban] = useState("ES7620770024003102575766");
  const [collectionDate, setCollectionDate] = useState(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10));
  const [schema, setSchema] = useState<"CORE" | "B2B">("CORE");
  const [sequenceType, setSequenceType] = useState<"FRST" | "RCUR" | "OOFF">("OOFF");
  const [debtors, setDebtors] = useState<Debtor[]>([
    {
      mandateId: "MND-001",
      mandateSignedAt: "2026-01-15",
      name: "Empresa Demo SL",
      iban: "ES9121000418450200051332",
      amount: 250.00,
      description: "Estancia corporativa abril 2026",
      endToEndId: "REF-001"
    }
  ]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SepaResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function updateDebtor(idx: number, patch: Partial<Debtor>) {
    setDebtors((prev) => prev.map((d, i) => (i === idx ? { ...d, ...patch } : d)));
  }
  function addDebtor() {
    setDebtors((prev) => [
      ...prev,
      {
        mandateId: `MND-${prev.length + 1}`.padStart(7, "0"),
        mandateSignedAt: "2026-01-15",
        name: "",
        iban: "",
        amount: 0,
        description: "",
        endToEndId: `REF-${String(prev.length + 1).padStart(3, "0")}`
      }
    ]);
  }
  function removeDebtor(idx: number) {
    setDebtors((prev) => prev.filter((_, i) => i !== idx));
  }

  async function handleGenerate() {
    setBusy(true);
    setError(null);
    try {
      // Validate creditor IBAN first.
      const valid = await validateIban(creditorIban);
      if (!valid.valid) throw new Error("IBAN del acreedor no válido (mod-97 falla).");
      const r = await generateSepaRemittance({
        schema,
        collectionDate,
        sequenceType,
        creditor: { name: creditorName, creditorId, iban: creditorIban },
        debtors
      });
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error.");
    } finally {
      setBusy(false);
    }
  }

  function downloadXml() {
    if (!result) return;
    const blob = new Blob([result.xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${result.messageId}.xml`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const total = debtors.reduce((s, d) => s + d.amount, 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Datos del acreedor (hotel)</h3></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          <label>Nombre comercial<input value={creditorName} onChange={(e) => setCreditorName(e.target.value)} /></label>
          <label>ID acreedor SEPA<input value={creditorId} onChange={(e) => setCreditorId(e.target.value)} className="mono" /></label>
          <label>IBAN acreedor<input value={creditorIban} onChange={(e) => setCreditorIban(e.target.value)} className="mono" /></label>
          <label>Esquema<select value={schema} onChange={(e) => setSchema(e.target.value as "CORE" | "B2B")}>
            <option value="CORE">CORE (consumidor)</option>
            <option value="B2B">B2B (empresa)</option>
          </select></label>
          <label>Secuencia<select value={sequenceType} onChange={(e) => setSequenceType(e.target.value as "FRST" | "RCUR" | "OOFF")}>
            <option value="OOFF">OOFF — pago único</option>
            <option value="FRST">FRST — primera de serie</option>
            <option value="RCUR">RCUR — recurrente</option>
          </select></label>
          <label>Fecha de cargo<input type="date" value={collectionDate} onChange={(e) => setCollectionDate(e.target.value)} /></label>
        </div>
      </article>

      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Deudores · Total {fmtMoney(total)}</h3>
          <button type="button" onClick={addDebtor}>+ Añadir deudor</button>
        </div>
        {debtors.map((d, i) => (
          <article key={i} className="bo-card" style={{ background: "var(--surface-2, var(--surface))", marginBottom: 8 }}>
            <div className="bo-card-head">
              <strong>Deudor #{i + 1}</strong>
              <button type="button" onClick={() => removeDebtor(i)} disabled={debtors.length === 1}>Eliminar</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 }}>
              <label>Nombre<input value={d.name} onChange={(e) => updateDebtor(i, { name: e.target.value })} /></label>
              <label>IBAN<input value={d.iban} onChange={(e) => updateDebtor(i, { iban: e.target.value })} className="mono" /></label>
              <label>Mandato ID<input value={d.mandateId} onChange={(e) => updateDebtor(i, { mandateId: e.target.value })} className="mono" /></label>
              <label>Firma mandato<input type="date" value={d.mandateSignedAt} onChange={(e) => updateDebtor(i, { mandateSignedAt: e.target.value })} /></label>
              <label>Importe<input type="number" step="0.01" value={d.amount} onChange={(e) => updateDebtor(i, { amount: Number(e.target.value) })} /></label>
              <label>Concepto<input value={d.description} onChange={(e) => updateDebtor(i, { description: e.target.value })} /></label>
              <label>End-to-End ID<input value={d.endToEndId} onChange={(e) => updateDebtor(i, { endToEndId: e.target.value })} className="mono" /></label>
            </div>
          </article>
        ))}
      </article>

      {error ? <p className="bo-status warn" style={{ textTransform: "none" }}>{error}</p> : null}

      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className="primary" onClick={handleGenerate} disabled={busy}>
          {busy ? <Spinner size="sm" /> : "Generar XML SEPA"}
        </button>
        {result ? <button type="button" onClick={downloadXml}>Descargar fichero</button> : null}
      </div>

      {result ? (
        <article className="bo-card" style={{ background: "var(--accent-soft, rgba(78,224,163,0.10))", border: "1px solid var(--accent)" }}>
          <p style={{ margin: 0, color: "var(--ink)" }}>
            ✓ Remesa generada · <strong>{result.transactions}</strong> transacciones por un total de <strong>{fmtMoney(result.totalAmount)}</strong>.
            Message ID: <code>{result.messageId}</code>
          </p>
          {result.warnings.length > 0 ? (
            <ul style={{ color: "var(--warn-ink)", fontSize: 12, marginTop: 8 }}>
              {result.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          ) : null}
          <details style={{ marginTop: 8 }}>
            <summary className="bo-muted" style={{ cursor: "pointer", fontSize: 12 }}>Ver XML generado</summary>
            <pre style={{ fontSize: 10, maxHeight: 260, overflow: "auto", background: "var(--surface-2)", padding: 8, marginTop: 6, borderRadius: 4 }}>{result.xml}</pre>
          </details>
        </article>
      ) : null}
    </div>
  );
}

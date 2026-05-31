import type { CSSProperties } from "react";
import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { LoadingBlock } from "../../components/States";
import { useToast } from "../../components/Toast";

// Demo single-property fallback. Multi-property selection lives in another track.
const PROPERTY_ID: string | undefined = undefined;

type FiscalYear = {
  id: string;
  organizationId: string;
  propertyId?: string;
  code: string;
  startDate: string;
  endDate: string;
  status: "open" | "closing" | "closed";
  closedAt?: string;
  closingEntryId?: string;
  openingEntryId?: string;
  netResult?: number;
};

type RegularizationLine = {
  accountCode: string;
  accountName: string;
  accountType: string;
  debit: number;
  credit: number;
};

type BlockingCheck = {
  code: string;
  message: string;
  severity: "error" | "warn";
};

type FiscalYearStatusReport = FiscalYear & {
  openPeriods: number;
  draftJournals: number;
  hasOpenJournals: boolean;
  blockingChecks: BlockingCheck[];
  netResultPreview?: number;
  regularizationLinePreview?: RegularizationLine[];
};

type CloseResult = {
  fiscalYear: FiscalYear;
  regularizationEntryId: string;
  closingEntryId: string;
  openingEntryId: string;
  nextFiscalYearId?: string;
  netResult: number;
  followUps: string[];
};

function fmt(amount: number | undefined | null): string {
  const v = typeof amount === "number" ? amount : 0;
  return new Intl.NumberFormat("es-ES", { useGrouping: true,
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2
  }).format(v);
}

function statusPillStyle(status: FiscalYear["status"]): CSSProperties {
  if (status === "closed") {
    return { background: "var(--success-bg)", color: "var(--success-ink)", fontWeight: 600 };
  }
  if (status === "closing") {
    return { background: "var(--warn-bg)", color: "var(--warn-ink)", fontWeight: 600 };
  }
  return { background: "var(--info-bg, #eef)", color: "var(--info-ink, #245)", fontWeight: 600 };
}

export function YearEndCloseScreen() {
  const { showToast } = useToast();
  const query = useMemo(() => {
    const q: Record<string, string> = {};
    if (PROPERTY_ID) q.propertyId = PROPERTY_ID;
    return q;
  }, []);

  const years = useApiData<FiscalYear[]>("/accounting/fiscal-years", { query, pollIntervalMs: 60000 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const effectiveSelectedId =
    selectedId ?? years.data?.find((y: FiscalYear) => y.status !== "closed")?.id ?? years.data?.[0]?.id ?? null;

  const status = useApiData<FiscalYearStatusReport>(
    effectiveSelectedId ? `/accounting/fiscal-years/${effectiveSelectedId}/status` : null,
    { pollIntervalMs: 60000 }
  );

  const [confirming, setConfirming] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [closeResult, setCloseResult] = useState<CloseResult | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [newCode, setNewCode] = useState<string>(String(new Date().getFullYear()));
  const [newStart, setNewStart] = useState<string>(`${new Date().getFullYear()}-01-01`);
  const [newEnd, setNewEnd] = useState<string>(`${new Date().getFullYear()}-12-31`);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    setCreateError(null);
    setCreating(true);
    try {
      await apiRequest("/accounting/fiscal-years", {
        method: "POST",
        body: { code: newCode, startDate: newStart, endDate: newEnd, propertyId: PROPERTY_ID }
      });
      setCreateOpen(false);
      years.refresh();
      showToast(`Ejercicio ${newCode} creado`, { variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setCreateError(message);
      showToast(message, { variant: "error" });
    } finally {
      setCreating(false);
    }
  }

  async function handleClose() {
    if (!effectiveSelectedId) return;
    setCloseError(null);
    setClosing(true);
    try {
      const result = await apiRequest<CloseResult>(
        `/accounting/fiscal-years/${effectiveSelectedId}/close`,
        { method: "POST", body: {} }
      );
      setCloseResult(result);
      setConfirming(false);
      years.refresh();
      status.refresh();
      showToast("Ejercicio cerrado", { variant: "success" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setCloseError(message);
      showToast(message, { variant: "error" });
    } finally {
      setClosing(false);
    }
  }

  const selected = status.data;
  const canClose =
    !!selected &&
    selected.status === "open" &&
    selected.blockingChecks.filter((c: BlockingCheck) => c.severity === "error").length === 0;

  return (
    <>
      <div className="bo-page-head">
        <div className="bo-page-head-text">
          <div className="bo-page-eyebrow">Contabilidad · Cierre del ejercicio</div>
          <h1 className="bo-page-title">Year-end close</h1>
          <p className="bo-page-subtitle">
            Cierre del ejercicio según PGC: <strong>asiento de regularización</strong> (6xx/7xx vs. 129),
            <strong> asiento de cierre</strong> al 31/12 y <strong>asiento de apertura</strong> al 1/1
            del año siguiente.
          </p>
        </div>
        <div className="bo-page-head-actions">
          <button type="button" onClick={() => setCreateOpen(true)}>+ Crear ejercicio</button>
          <button type="button" className="ghost" onClick={() => { years.refresh(); status.refresh(); }}>
            ↻ Refrescar
          </button>
        </div>
      </div>

      {createOpen && (
        <div className="bo-card" style={{ marginBottom: 16, borderLeft: "3px solid var(--accent, #357)" }}>
          <h3 style={{ marginTop: 0 }}>Nuevo ejercicio fiscal</h3>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
            <div>
              <label style={{ display: "block", fontSize: 12, color: "var(--ink-muted)" }}>Código</label>
              <input value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder="2026" />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, color: "var(--ink-muted)" }}>Inicio</label>
              <input type="date" value={newStart} onChange={(e) => setNewStart(e.target.value)} />
            </div>
            <div>
              <label style={{ display: "block", fontSize: 12, color: "var(--ink-muted)" }}>Fin</label>
              <input type="date" value={newEnd} onChange={(e) => setNewEnd(e.target.value)} />
            </div>
            <button type="button" onClick={handleCreate} disabled={creating}>
              {creating ? "Creando…" : "Crear"}
            </button>
            <button type="button" className="ghost" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancelar
            </button>
          </div>
          {createError && (
            <p style={{ color: "var(--danger-ink)", marginTop: 8 }}>{createError}</p>
          )}
        </div>
      )}

      <section className="bo-card" style={{ marginBottom: 16 }}>
        <div className="bo-card-head">
          <h2 style={{ fontSize: 20 }}>Ejercicios fiscales</h2>
          <span className="bo-chip">{years.data?.length ?? 0} años</span>
        </div>
        {years.loading ? (
          <LoadingBlock />
        ) : years.error ? (
          <p style={{ color: "var(--danger-ink)", padding: 12 }}>{years.error}</p>
        ) : !years.data || years.data.length === 0 ? (
          <p style={{ color: "var(--ink-muted)", padding: 12 }}>
            Aún no hay ejercicios fiscales. Crea el primero con el botón "Crear ejercicio".
          </p>
        ) : (
          <table className="cm-table">
            <thead>
              <tr>
                <th>Código</th>
                <th>Inicio</th>
                <th>Fin</th>
                <th>Estado</th>
                <th style={{ textAlign: "right" }}>Resultado del ejercicio</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {years.data.map((y: FiscalYear) => (
                <tr
                  key={y.id}
                  style={{ background: y.id === effectiveSelectedId ? "var(--row-hover, #f6f8fa)" : undefined }}
                >
                  <td><strong>{y.code}</strong></td>
                  <td>{y.startDate}</td>
                  <td>{y.endDate}</td>
                  <td>
                    <span className="bo-chip" style={statusPillStyle(y.status)}>{y.status}</span>
                  </td>
                  <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>
                    {y.netResult != null ? fmt(y.netResult) : "—"}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button type="button" className="ghost" onClick={() => setSelectedId(y.id)}>
                      Ver
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selected && (
        <section className="bo-card" style={{ marginBottom: 16 }}>
          <div className="bo-card-head">
            <h2 style={{ fontSize: 20 }}>Ejercicio {selected.code}</h2>
            <span className="bo-chip" style={statusPillStyle(selected.status)}>{selected.status}</span>
          </div>

          <div className="rev-kpi-grid" style={{ marginBottom: 16 }}>
            <article className={`rev-kpi ${selected.openPeriods === 0 ? "rev-kpi-ok" : "rev-kpi-warn"}`}>
              <div className="rev-kpi-head"><span className="rev-kpi-label">Periodos abiertos</span></div>
              <div className="rev-kpi-value">{selected.openPeriods}</div>
              <div className="rev-kpi-delta">
                {selected.openPeriods === 0 ? "Todos cerrados" : "Bloqueante"}
              </div>
            </article>
            <article className={`rev-kpi ${selected.draftJournals === 0 ? "rev-kpi-ok" : "rev-kpi-warn"}`}>
              <div className="rev-kpi-head"><span className="rev-kpi-label">Asientos en borrador</span></div>
              <div className="rev-kpi-value">{selected.draftJournals}</div>
              <div className="rev-kpi-delta">
                {selected.draftJournals === 0 ? "Sin pendientes" : "Bloqueante"}
              </div>
            </article>
            <article className="rev-kpi">
              <div className="rev-kpi-head"><span className="rev-kpi-label">Resultado previsto</span></div>
              <div className="rev-kpi-value">{fmt(selected.netResultPreview)}</div>
              <div className="rev-kpi-delta">
                {selected.netResultPreview != null && selected.netResultPreview >= 0 ? "Beneficio" : "Pérdida"}
              </div>
            </article>
          </div>

          {selected.blockingChecks.length > 0 && (
            <div className="bo-card" style={{ borderLeft: "3px solid var(--danger-ink)", marginBottom: 12 }}>
              <h4 style={{ marginTop: 0 }}>Comprobaciones</h4>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {selected.blockingChecks.map((c: BlockingCheck) => (
                  <li
                    key={c.code}
                    style={{ color: c.severity === "error" ? "var(--danger-ink)" : "var(--warn-ink)" }}
                  >
                    <strong>{c.code}</strong> · {c.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {selected.regularizationLinePreview && selected.regularizationLinePreview.length > 0 && (
            <details open style={{ marginBottom: 12 }}>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>
                Vista previa del asiento de regularización ({selected.regularizationLinePreview.length} líneas)
              </summary>
              <table className="cm-table" style={{ marginTop: 8 }}>
                <thead>
                  <tr>
                    <th>Cuenta</th>
                    <th>Nombre</th>
                    <th style={{ textAlign: "right" }}>Debe</th>
                    <th style={{ textAlign: "right" }}>Haber</th>
                  </tr>
                </thead>
                <tbody>
                  {selected.regularizationLinePreview.map((l: RegularizationLine, idx: number) => (
                    <tr key={`${l.accountCode}-${idx}`}>
                      <td><strong>{l.accountCode}</strong></td>
                      <td>{l.accountName}</td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>
                        {l.debit > 0 ? fmt(l.debit) : ""}
                      </td>
                      <td style={{ textAlign: "right", fontFamily: "var(--font-mono)" }}>
                        {l.credit > 0 ? fmt(l.credit) : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}

          {selected.status === "closed" ? (
            <div className="bo-card" style={{ borderLeft: "3px solid var(--success-ink)" }}>
              <h4 style={{ marginTop: 0 }}>Ejercicio cerrado</h4>
              <p style={{ margin: "4px 0" }}>Cerrado el: {selected.closedAt}</p>
              <p style={{ margin: "4px 0" }}>Resultado: <strong>{fmt(selected.netResult)}</strong></p>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                <li>
                  Asiento de cierre · <code>{selected.closingEntryId ?? "—"}</code>
                </li>
                <li>
                  Asiento de apertura (año siguiente) · <code>{selected.openingEntryId ?? "—"}</code>
                </li>
              </ul>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                disabled={!canClose}
                onClick={() => setConfirming(true)}
                title={canClose ? "" : "Resuelve las comprobaciones bloqueantes antes de cerrar."}
              >
                Cerrar ejercicio {selected.code}
              </button>
            </div>
          )}

          {confirming && (
            <div
              className="bo-card"
              style={{
                marginTop: 12,
                borderLeft: "3px solid var(--warn-ink)",
                background: "var(--warn-bg, #fff7e0)"
              }}
            >
              <h4 style={{ marginTop: 0 }}>Confirmar cierre de {selected.code}</h4>
              <p>
                Esta acción es <strong>crítica</strong> y creará 3 asientos contables irreversibles
                de forma automática:
              </p>
              <ol>
                <li>
                  <strong>Asiento de regularización</strong> · cierra 6xx/7xx contra la cuenta 129. Resultado
                  previsto <strong>{fmt(selected.netResultPreview)}</strong>.
                </li>
                <li>
                  <strong>Asiento de cierre</strong> · lleva a cero todas las cuentas patrimoniales al 31/12.
                </li>
                <li>
                  <strong>Asiento de apertura</strong> · replica los saldos al 1/1 del año siguiente.
                </li>
              </ol>
              <p style={{ fontSize: 13, color: "var(--ink-muted)" }}>
                Nota: el traspaso del resultado a reservas (113/1130) se realiza posteriormente como
                un asiento manual.
              </p>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" onClick={handleClose} disabled={closing}>
                  {closing ? "Cerrando…" : "Confirmar cierre"}
                </button>
                <button type="button" className="ghost" onClick={() => setConfirming(false)} disabled={closing}>
                  Cancelar
                </button>
              </div>
              {closeError && <p style={{ color: "var(--danger-ink)", marginTop: 8 }}>{closeError}</p>}
            </div>
          )}

          {closeResult && (
            <div className="bo-card" style={{ marginTop: 12, borderLeft: "3px solid var(--success-ink)" }}>
              <h4 style={{ marginTop: 0 }}>Cierre completado</h4>
              <p>Resultado del ejercicio: <strong>{fmt(closeResult.netResult)}</strong></p>
              <ul style={{ paddingLeft: 20 }}>
                <li>
                  Regularización · <code>{closeResult.regularizationEntryId}</code>
                </li>
                <li>
                  Cierre · <code>{closeResult.closingEntryId}</code>
                </li>
                <li>
                  Apertura · <code>{closeResult.openingEntryId}</code>
                </li>
              </ul>
              {closeResult.followUps.length > 0 && (
                <>
                  <p style={{ fontWeight: 600, marginBottom: 4 }}>Tareas pendientes:</p>
                  <ul style={{ paddingLeft: 20 }}>
                    {closeResult.followUps.map((f: string) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}

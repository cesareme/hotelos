import { useCallback, useEffect, useMemo, useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import {
  addPosLine,
  closePosTicket,
  fetchPosCashSummary,
  fetchPosOutlets,
  openPosTicket,
  type PosCashSummary,
  type PosOutlet,
  type PosTicket
} from "../../services/posApi";
import { todayIsoLocal } from "../../services/pmsCommerceApi";
import { LoadingBlock, ErrorState, EmptyState, Spinner } from "../../components/States";
import { SidePanel, DetailRow } from "../../components/SidePanel";
import { toArray } from "../../utils/toArray";
import { useTabHost } from "../tabs/TabHost";
import { date, money, time } from "../../lib/format";
import { cashSummaryWindow } from "./pos-cash-window";

const PROPERTY_ID = getActivePropertyId();

function eur(n: number): string {
  return money(n);
}
function fmtTime(iso?: string): string {
  return time(iso, { empty: "" });
}
/** True when the ISO timestamp falls on the given local calendar day. */
function isOnLocalDay(iso: string | undefined, dayIso: string): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return local === dayIso;
}
const SETTLE_LABEL: Record<string, string> = { room: "a la habitación", cash: "efectivo", card: "tarjeta" };

export function PosDashboard() {
  const hosted = useTabHost() !== null;
  const { data, loading, error, refresh } = useApiData<PosTicket[]>(
    `/properties/${PROPERTY_ID}/pos/tickets`,
    { pollIntervalMs: 20000 }
  );
  const tickets = useMemo(() => toArray<PosTicket>(data), [data]);

  const [outlets, setOutlets] = useState<PosOutlet[]>([]);
  const [outletsError, setOutletsError] = useState<string | null>(null);
  useEffect(() => {
    void fetchPosOutlets(PROPERTY_ID)
      .then((list) => {
        setOutlets(list);
        setOutletsError(null);
      })
      .catch((e: unknown) => {
        // QC-06: without outlets no ticket can be opened; say why.
        setOutlets([]);
        setOutletsError(e instanceof Error ? e.message : "No se pudieron cargar los puntos de venta.");
      });
  }, []);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = tickets.find((t) => t.id === selectedId) ?? null;
  const [outletId, setOutletId] = useState("");
  const [roomNumber, setRoomNumber] = useState("");
  // per-ticket add-line draft
  const [lineDraft, setLineDraft] = useState<Record<string, { name: string; qty: string; price: string }>>({});

  useEffect(() => {
    if (!outletId && outlets[0]) setOutletId(outlets[0].id);
  }, [outlets, outletId]);

  // ---- cash summary (arqueo) ------------------------------------------------
  // FISC-05: settlement / closedAt are persisted on PosOrder, so the summary is
  // computed server-side (GET /pos/cash-summary) over closed tickets in the
  // selected window, never from the in-memory board.
  const today = todayIsoLocal();
  const [csFrom, setCsFrom] = useState(today);
  const [csTo, setCsTo] = useState(today);
  const [csOutletId, setCsOutletId] = useState("");
  const [cashSummary, setCashSummary] = useState<PosCashSummary | null>(null);
  const [cashLoading, setCashLoading] = useState(false);
  const [cashError, setCashError] = useState<string | null>(null);
  // Outlet ids the cash-summary endpoint understands come from its own
  // unfiltered answer (board outlet ids are synthetic); cached so the selector
  // keeps its options while a single outlet is selected.
  const [cashOutlets, setCashOutlets] = useState<Array<{ id: string; name: string }>>([]);

  const loadCashSummary = useCallback(async () => {
    if (!csFrom || !csTo) return;
    setCashLoading(true);
    setCashError(null);
    try {
      const summary = await fetchPosCashSummary({ ...cashSummaryWindow(csFrom, csTo), outletId: csOutletId || undefined }, PROPERTY_ID);
      setCashSummary(summary);
      if (!csOutletId) setCashOutlets(summary.byOutlet.map((o) => ({ id: o.outletId, name: o.outletName })));
    } catch (e: unknown) {
      setCashSummary(null);
      setCashError(e instanceof Error ? e.message : "No se pudo calcular el arqueo.");
    } finally {
      setCashLoading(false);
    }
  }, [csFrom, csTo, csOutletId]);

  useEffect(() => {
    void loadCashSummary();
  }, [loadCashSummary]);

  const cashOutletOptions = cashOutlets.length > 0 ? cashOutlets : outlets.map((o) => ({ id: o.id, name: o.name }));

  const open = tickets.filter((t) => t.status === "open");
  const closed = tickets.filter((t) => t.status === "closed");
  const closedToday = closed.filter((t) => isOnLocalDay(t.closedAt, today));
  const openTotal = open.reduce((s, t) => s + t.total, 0);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      refresh();
      void loadCashSummary();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo completar la acción.");
    } finally {
      setBusy(false);
    }
  }

  function draftOf(id: string) {
    return lineDraft[id] ?? { name: "", qty: "1", price: "" };
  }
  function setDraft(id: string, patch: Partial<{ name: string; qty: string; price: string }>) {
    setLineDraft((prev) => ({ ...prev, [id]: { ...draftOf(id), ...patch } }));
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <header className="bo-card-head" style={hosted ? { justifyContent: "flex-end" } : undefined}>
        {hosted ? null : (
          <div>
            <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>Operaciones · TPV</p>
            <h2 style={{ color: "var(--ink)" }}>Punto de venta (TPV)</h2>
            <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
              Abre comandas en restaurante, bar o room service, añade consumos y cierra cobrando a la habitación, en efectivo o con tarjeta.
            </p>
          </div>
        )}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {busy ? <Spinner size="sm" /> : null}
          <button type="button" onClick={refresh} disabled={loading}>↻ Actualizar</button>
        </div>
      </header>

      {msg ? <p className="bo-status ok" style={{ textTransform: "none" }}>{msg}</p> : null}

      <div className="rev-kpi-grid">
        <article className={`rev-kpi rev-kpi-${open.length > 0 ? "warn" : "ok"}`}><div className="rev-kpi-head"><span className="rev-kpi-label">Comandas abiertas</span><span className={`bo-status ${open.length > 0 ? "warn" : "ok"}`}>{open.length > 0 ? "en curso" : "ninguna"}</span></div><div className="rev-kpi-value">{open.length}</div></article>
        <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Total abierto</span><span className="bo-status info">por cobrar</span></div><div className="rev-kpi-value" style={{ fontSize: 22 }}>{eur(openTotal)}</div></article>
        {/* Counted by real closedAt (persisted), not "every closed ticket in memory". */}
        <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Comandas cerradas</span><span className="bo-status ok">hoy</span></div><div className="rev-kpi-value">{closedToday.length}</div></article>
      </div>

      {/* Arqueo */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <div>
            <h3 style={{ color: "var(--ink)" }}>Arqueo de caja</h3>
            <p className="bo-muted" style={{ marginTop: 2, textTransform: "none", fontSize: 13 }}>
              Comandas cerradas en el rango, por punto de venta y medio de cobro (datos persistidos en BD).
            </p>
          </div>
          <button type="button" onClick={() => void loadCashSummary()} disabled={cashLoading}>↻</button>
        </div>
        <div className="bo-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
          <label style={{ display: "grid", gap: 2 }}>
            <span className="bo-muted" style={{ textTransform: "none", fontSize: 12 }}>Desde</span>
            <input type="date" value={csFrom} max={csTo || undefined} onChange={(e) => setCsFrom(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: 2 }}>
            <span className="bo-muted" style={{ textTransform: "none", fontSize: 12 }}>Hasta</span>
            <input type="date" value={csTo} min={csFrom || undefined} onChange={(e) => setCsTo(e.target.value)} />
          </label>
          <label style={{ display: "grid", gap: 2 }}>
            <span className="bo-muted" style={{ textTransform: "none", fontSize: 12 }}>Punto de venta</span>
            <select value={csOutletId} onChange={(e) => setCsOutletId(e.target.value)}>
              <option value="">Todos</option>
              {cashOutletOptions.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </label>
          <button type="button" className="ghost" onClick={() => { setCsFrom(today); setCsTo(today); }} style={{ alignSelf: "end" }}>Hoy</button>
        </div>
        {cashLoading && !cashSummary ? (
          <LoadingBlock label="Calculando arqueo…" />
        ) : cashError ? (
          <ErrorState title="No se pudo calcular el arqueo" message={cashError} onRetry={() => void loadCashSummary()} />
        ) : cashSummary ? (
          <>
            <div className="rev-kpi-grid">
              <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Efectivo</span></div><div className="rev-kpi-value" style={{ fontSize: 22 }}>{eur(cashSummary.totals.bySettlement.cash)}</div></article>
              <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Tarjeta</span></div><div className="rev-kpi-value" style={{ fontSize: 22 }}>{eur(cashSummary.totals.bySettlement.card)}</div></article>
              <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">A habitación</span></div><div className="rev-kpi-value" style={{ fontSize: 22 }}>{eur(cashSummary.totals.bySettlement.room)}</div></article>
              <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Total</span><span className="bo-chip">{cashSummary.totals.tickets} comandas</span></div><div className="rev-kpi-value" style={{ fontSize: 22 }}>{eur(cashSummary.totals.total)}</div></article>
            </div>
            {cashSummary.byOutlet.length === 0 ? (
              <p className="bo-muted" style={{ marginTop: 8, textTransform: "none" }}>Sin comandas cerradas en el rango seleccionado.</p>
            ) : (
              <table className="cm-table" style={{ marginTop: 12 }}>
                <thead><tr><th>Punto de venta</th><th>Comandas</th><th>Efectivo</th><th>Tarjeta</th><th>A habitación</th><th>Total</th></tr></thead>
                <tbody>
                  {cashSummary.byOutlet.map((o) => (
                    <tr key={o.outletId}>
                      <td>{o.outletName}</td>
                      <td>{o.tickets}</td>
                      <td>{eur(o.bySettlement.cash)}</td>
                      <td>{eur(o.bySettlement.card)}</td>
                      <td>{eur(o.bySettlement.room)}</td>
                      <td><strong>{eur(o.total)}</strong></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {cashLoading ? <p className="bo-muted" style={{ marginTop: 6, textTransform: "none", fontSize: 12 }}><Spinner size="sm" /> Actualizando…</p> : null}
          </>
        ) : null}
      </article>

      {/* Nueva comanda */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Abrir comanda</h3></div>
        {outletsError ? <p className="bo-status error" style={{ textTransform: "none" }}>{outletsError}</p> : null}
        <div className="bo-row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <select value={outletId} onChange={(e) => setOutletId(e.target.value)} disabled={busy}>
            {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <input value={roomNumber} onChange={(e) => setRoomNumber(e.target.value)} placeholder="Habitación (opcional)" disabled={busy} style={{ width: 180 }} />
          <button type="button" className="primary" disabled={busy || !outletId} onClick={() => run(async () => {
            await openPosTicket({ outletId, roomNumber: roomNumber || undefined });
            setRoomNumber("");
          }, "Comanda abierta.")}>Abrir comanda</button>
        </div>
      </article>

      {loading && tickets.length === 0 ? (
        <LoadingBlock label="Cargando comandas…" />
      ) : error ? (
        <ErrorState title="No se pudo cargar" message={error} onRetry={refresh} />
      ) : (
        <>
          {open.length === 0 ? (
            <EmptyState title="Sin comandas abiertas" message="Abre una comanda arriba para empezar a registrar consumos." />
          ) : (
            <div className="bo-grid two">
              {open.map((t) => {
                const d = draftOf(t.id);
                return (
                  <article key={t.id} className="bo-card" style={{ background: "var(--surface)" }}>
                    <div className="bo-card-head">
                      <h3 style={{ color: "var(--ink)" }}>{t.outletName}{t.roomNumber ? <span className="bo-muted" style={{ fontSize: 13 }}> · Hab. {t.roomNumber}</span> : null}</h3>
                      <span className="bo-chip">{fmtTime(t.createdAt)}</span>
                    </div>
                    {t.lines.length === 0 ? (
                      <p className="bo-muted" style={{ fontSize: 13 }}>Sin consumos todavía.</p>
                    ) : (
                      <table className="bo-table"><tbody>
                        {t.lines.map((l, i) => (
                          <tr key={i}><td>{l.quantity}× {l.name}</td><td style={{ textAlign: "right" }}>{eur(l.total)}</td></tr>
                        ))}
                        <tr><td><strong>Total</strong></td><td style={{ textAlign: "right" }}><strong>{eur(t.total)}</strong></td></tr>
                      </tbody></table>
                    )}

                    <div className="bo-row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <input value={d.name} onChange={(e) => setDraft(t.id, { name: e.target.value })} placeholder="Consumo" disabled={busy} style={{ flex: 1, minWidth: 120 }} />
                      <input value={d.qty} onChange={(e) => setDraft(t.id, { qty: e.target.value })} type="number" min="1" disabled={busy} style={{ width: 56 }} />
                      <input value={d.price} onChange={(e) => setDraft(t.id, { price: e.target.value })} type="number" min="0" step="0.5" placeholder="€" disabled={busy} style={{ width: 80 }} />
                      <button type="button" disabled={busy || !d.name.trim() || !Number(d.price)} onClick={() => run(async () => {
                        await addPosLine(t.id, { name: d.name.trim(), quantity: Number(d.qty) || 1, unitPrice: Number(d.price) });
                        setDraft(t.id, { name: "", qty: "1", price: "" });
                      }, "Consumo añadido.")}>Añadir</button>
                    </div>

                    <div className="bo-row" style={{ gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                      <button type="button" className="primary" disabled={busy || t.lines.length === 0} title={t.roomNumber ? "" : "Indica una habitación al abrir la comanda"} onClick={() => run(() => closePosTicket(t.id, "room"), "Cargado a la habitación.")}>Cargar a habitación</button>
                      <button type="button" disabled={busy || t.lines.length === 0} onClick={() => run(() => closePosTicket(t.id, "cash"), "Cobrado en efectivo.")}>Efectivo</button>
                      <button type="button" disabled={busy || t.lines.length === 0} onClick={() => run(() => closePosTicket(t.id, "card"), "Cobrado con tarjeta.")}>Tarjeta</button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {closed.length > 0 ? (
            <article className="bo-card" style={{ background: "var(--surface)" }}>
              <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Comandas cerradas</h3><span className="bo-chip">{closed.length}</span></div>
              <table className="cm-table">
                <thead><tr><th>Punto de venta</th><th>Habitación</th><th>Total</th><th>Cobro</th><th>Cierre</th></tr></thead>
                <tbody>
                  {closed.slice(0, 15).map((t) => (
                    <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => setSelectedId(t.id)} title="Ver ficha de la comanda">
                      <td>{t.outletName}</td>
                      <td>{t.roomNumber ? `Hab. ${t.roomNumber}` : "—"}</td>
                      <td>{eur(t.total)}</td>
                      <td>{t.settlement ? <span className="bo-status ok">{SETTLE_LABEL[t.settlement] ?? t.settlement}</span> : <span className="bo-muted">sin registrar</span>}</td>
                      <td>{t.closedAt ? `${isOnLocalDay(t.closedAt, today) ? "hoy" : date(t.closedAt)} ${fmtTime(t.closedAt)}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>
          ) : null}
        </>
      )}

      <SidePanel
        open={!!selected}
        title={selected ? `Comanda · ${selected.outletName}` : ""}
        subtitle={selected ? (selected.roomNumber ? `Hab. ${selected.roomNumber}` : "Sin habitación") : undefined}
        onClose={() => setSelectedId(null)}
      >
        {selected ? (
          <>
            <DetailRow label="Estado">{selected.status === "open" ? <span className="bo-status warn">Abierta</span> : <span className="bo-status ok">Cerrada</span>}</DetailRow>
            <DetailRow label="Punto de venta">{selected.outletName}</DetailRow>
            <DetailRow label="Habitación">{selected.roomNumber ? `Hab. ${selected.roomNumber}` : "—"}</DetailRow>
            <DetailRow label="Abierta">{fmtTime(selected.createdAt)}</DetailRow>
            {selected.closedAt ? <DetailRow label="Cerrada">{date(selected.closedAt)} {fmtTime(selected.closedAt)}</DetailRow> : null}
            {selected.settlement ? <DetailRow label="Cobro">{SETTLE_LABEL[selected.settlement] ?? selected.settlement}</DetailRow> : null}
            <div style={{ marginTop: 8 }}>
              <p className="bo-muted" style={{ fontSize: 12, textTransform: "none", marginBottom: 4 }}>Consumos</p>
              {selected.lines.length === 0 ? (
                <p className="bo-muted" style={{ fontSize: 13, margin: 0 }}>Sin consumos.</p>
              ) : (
                <table className="bo-table"><tbody>
                  {selected.lines.map((l, i) => (
                    <tr key={i}><td>{l.quantity}× {l.name}</td><td style={{ textAlign: "right" }}>{eur(l.total)}</td></tr>
                  ))}
                  <tr><td><strong>Total</strong></td><td style={{ textAlign: "right" }}><strong>{eur(selected.total)}</strong></td></tr>
                </tbody></table>
              )}
            </div>
          </>
        ) : null}
      </SidePanel>
    </section>
  );
}

import { useEffect, useMemo, useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import {
  addPosLine,
  closePosTicket,
  fetchPosOutlets,
  openPosTicket,
  type PosOutlet,
  type PosTicket
} from "../../services/posApi";
import { LoadingBlock, ErrorState, EmptyState, Spinner } from "../../components/States";
import { SidePanel, DetailRow } from "../../components/SidePanel";
import { toArray } from "../../utils/toArray";

const PROPERTY_ID = getActivePropertyId();

function eur(n: number): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", minimumFractionDigits: 2 }).format(n ?? 0);
}
function fmtTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}
const SETTLE_LABEL: Record<string, string> = { room: "a la habitación", cash: "efectivo", card: "tarjeta" };

export function PosDashboard() {
  const { data, loading, error, refresh } = useApiData<PosTicket[]>(
    `/properties/${PROPERTY_ID}/pos/tickets`,
    { pollIntervalMs: 20000 }
  );
  const tickets = useMemo(() => toArray<PosTicket>(data), [data]);

  const [outlets, setOutlets] = useState<PosOutlet[]>([]);
  useEffect(() => {
    void fetchPosOutlets(PROPERTY_ID).then(setOutlets).catch(() => setOutlets([]));
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

  const open = tickets.filter((t) => t.status === "open");
  const closed = tickets.filter((t) => t.status === "closed");
  const openTotal = open.reduce((s, t) => s + t.total, 0);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      refresh();
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
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>Operaciones · TPV</p>
          <h2 style={{ color: "var(--ink)" }}>Punto de venta (TPV)</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Abre comandas en restaurante, bar o room service, añade consumos y cierra cobrando a la habitación, en efectivo o con tarjeta.
          </p>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {busy ? <Spinner size="sm" /> : null}
          <button type="button" onClick={refresh} disabled={loading}>↻ Actualizar</button>
        </div>
      </header>

      {msg ? <p className="bo-status ok" style={{ textTransform: "none" }}>{msg}</p> : null}

      <div className="rev-kpi-grid">
        <article className={`rev-kpi rev-kpi-${open.length > 0 ? "warn" : "ok"}`}><div className="rev-kpi-head"><span className="rev-kpi-label">Comandas abiertas</span><span className={`bo-status ${open.length > 0 ? "warn" : "ok"}`}>{open.length > 0 ? "en curso" : "ninguna"}</span></div><div className="rev-kpi-value">{open.length}</div></article>
        <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Total abierto</span><span className="bo-status info">por cobrar</span></div><div className="rev-kpi-value" style={{ fontSize: 22 }}>{eur(openTotal)}</div></article>
        <article className="rev-kpi rev-kpi-ok"><div className="rev-kpi-head"><span className="rev-kpi-label">Comandas cerradas</span><span className="bo-status ok">hoy</span></div><div className="rev-kpi-value">{closed.length}</div></article>
      </div>

      {/* Nueva comanda */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Abrir comanda</h3></div>
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
                <thead><tr><th>Punto de venta</th><th>Habitación</th><th>Total</th><th>Cobro</th><th>Hora</th></tr></thead>
                <tbody>
                  {closed.slice(0, 15).map((t) => (
                    <tr key={t.id} style={{ cursor: "pointer" }} onClick={() => setSelectedId(t.id)} title="Ver ficha de la comanda">
                      <td>{t.outletName}</td>
                      <td>{t.roomNumber ? `Hab. ${t.roomNumber}` : "—"}</td>
                      <td>{eur(t.total)}</td>
                      <td><span className="bo-status ok">{SETTLE_LABEL[t.settlement ?? ""] ?? t.settlement}</span></td>
                      <td>{fmtTime(t.closedAt)}</td>
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
            {selected.closedAt ? <DetailRow label="Cerrada">{fmtTime(selected.closedAt)}</DetailRow> : null}
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

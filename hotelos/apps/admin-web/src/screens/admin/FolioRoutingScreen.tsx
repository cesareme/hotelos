// FolioRouting workspace — split folios + routing rules per reservation.
//
// Standard PMS feature. From this screen the user can:
//   1. Lookup a reservation by ID.
//   2. See its folios (primary + secondary). Open a secondary folio for the
//      same reservation (e.g. "company", "travel_agent").
//   3. Declare routing rules: "every line of type X goes to folio Y". When the
//      next FolioLine is posted on the primary folio, it is auto-moved.
//   4. Inspect each folio's lines and transfer a single line to another folio
//      manually (override).
//
// All endpoints already exist on the API (folio-routing.service.ts + folio
// service GET /folios/:id/balance). This is a read-write workspace; mutations
// trigger refresh of the affected queries.

import { useEffect, useMemo, useState } from "react";
import {
  fetchReservationFolios,
  createSecondaryFolio,
  fetchRoutingRules,
  createRoutingRule,
  deleteRoutingRule,
  transferFolioLine,
  fetchFolioLines,
  type Folio,
  type FolioLine,
  type FolioRoutingRule
} from "../../services/folioRoutingApi";
import { LoadingBlock, ErrorState, EmptyState, Spinner } from "../../components/States";

// Source types the auto-router can match on. "*" = catch-all.
const SOURCE_TYPES = [
  { code: "*", label: "Cualquier cargo (*)" },
  { code: "room", label: "Habitación (room)" },
  { code: "tax", label: "Impuestos (tax)" },
  { code: "city_tax", label: "Tasa turística (city_tax)" },
  { code: "f_and_b", label: "F&B (f_and_b)" },
  { code: "minibar", label: "Minibar (minibar)" },
  { code: "spa", label: "Spa / wellness (spa)" },
  { code: "laundry", label: "Lavandería (laundry)" },
  { code: "telephone", label: "Teléfono (telephone)" },
  { code: "parking", label: "Parking (parking)" },
  { code: "service_charge", label: "Cargo por servicio (service_charge)" },
  { code: "adjustment", label: "Ajuste (adjustment)" }
];

function fmtMoney(n: number, currency = "EUR"): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency, maximumFractionDigits: 2 }).format(n);
}
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function FolioRoutingScreen() {
  // Reservation lookup state
  const [reservationInput, setReservationInput] = useState<string>("");
  const [reservationId, setReservationId] = useState<string | null>(null);

  // Folios + rules state
  const [folios, setFolios] = useState<Folio[]>([]);
  const [rules, setRules] = useState<FolioRoutingRule[]>([]);
  const [linesByFolio, setLinesByFolio] = useState<Record<string, { lines: FolioLine[]; total: number; balanceDue: number }>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New secondary folio form
  const [newFolioLabel, setNewFolioLabel] = useState<string>("");
  const [newFolioCurrency, setNewFolioCurrency] = useState<string>("EUR");

  // New routing rule form
  const [newRuleSource, setNewRuleSource] = useState<string>("minibar");
  const [newRuleTarget, setNewRuleTarget] = useState<string>("");
  const [newRulePriority, setNewRulePriority] = useState<number>(100);
  const [newRuleNotes, setNewRuleNotes] = useState<string>("");

  // Transfer line modal-state (simple inline)
  const [transferring, setTransferring] = useState<string | null>(null);
  const [transferTarget, setTransferTarget] = useState<string>("");

  const [busy, setBusy] = useState<boolean>(false);
  const [msg, setMsg] = useState<string | null>(null);

  const primaryFolio = useMemo(() => folios.find((f) => f.isPrimary) ?? folios[0] ?? null, [folios]);

  async function loadAll(id: string) {
    setLoading(true);
    setError(null);
    setLinesByFolio({});
    try {
      const [fols, rls] = await Promise.all([fetchReservationFolios(id), fetchRoutingRules(id)]);
      setFolios(fols);
      setRules(rls);
      // Fetch lines per folio in parallel (best-effort, ignore individual errors)
      const lineResults = await Promise.all(
        fols.map((f) =>
          fetchFolioLines(f.id)
            .then((r) => ({ id: f.id, ok: true as const, value: r }))
            .catch((e) => ({ id: f.id, ok: false as const, error: e instanceof Error ? e.message : String(e) }))
        )
      );
      const map: Record<string, { lines: FolioLine[]; total: number; balanceDue: number }> = {};
      for (const r of lineResults) {
        if (r.ok) {
          map[r.id] = { lines: r.value.lines, total: r.value.total, balanceDue: r.value.balanceDue };
        }
      }
      setLinesByFolio(map);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudieron cargar los folios.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (reservationId) {
      void loadAll(reservationId);
    } else {
      setFolios([]);
      setRules([]);
      setLinesByFolio({});
    }
  }, [reservationId]);

  function lookup(e: React.FormEvent) {
    e.preventDefault();
    const id = reservationInput.trim();
    if (!id) return;
    setReservationId(id);
  }

  async function addSecondaryFolio(e: React.FormEvent) {
    e.preventDefault();
    if (!reservationId || !newFolioLabel.trim()) return;
    setBusy(true);
    setMsg(null);
    try {
      await createSecondaryFolio(reservationId, { label: newFolioLabel.trim(), currency: newFolioCurrency || undefined });
      setNewFolioLabel("");
      setMsg(`Folio «${newFolioLabel.trim()}» creado.`);
      await loadAll(reservationId);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo crear el folio.");
    } finally {
      setBusy(false);
    }
  }

  async function addRule(e: React.FormEvent) {
    e.preventDefault();
    if (!reservationId || !newRuleTarget) return;
    setBusy(true);
    setMsg(null);
    try {
      await createRoutingRule(reservationId, {
        sourceType: newRuleSource,
        targetFolioId: newRuleTarget,
        priority: newRulePriority,
        notes: newRuleNotes || undefined,
        active: true
      });
      setNewRuleNotes("");
      setMsg(`Regla añadida: ${newRuleSource} → folio destino.`);
      await loadAll(reservationId);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo crear la regla.");
    } finally {
      setBusy(false);
    }
  }

  async function removeRule(ruleId: string) {
    if (!reservationId) return;
    setBusy(true);
    setMsg(null);
    try {
      await deleteRoutingRule(ruleId);
      setMsg("Regla eliminada.");
      await loadAll(reservationId);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo eliminar la regla.");
    } finally {
      setBusy(false);
    }
  }

  async function doTransfer(lineId: string) {
    if (!transferTarget || !reservationId) return;
    setBusy(true);
    setMsg(null);
    try {
      await transferFolioLine(lineId, transferTarget);
      setMsg("Cargo transferido.");
      setTransferring(null);
      setTransferTarget("");
      await loadAll(reservationId);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "No se pudo transferir el cargo.");
    } finally {
      setBusy(false);
    }
  }

  // Helpers
  const folioLabel = (id: string | undefined | null): string => {
    if (!id) return "—";
    const f = folios.find((x) => x.id === id);
    return f ? `${f.label}${f.isPrimary ? " (principal)" : ""}` : id;
  };

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>Finanzas · Folios</p>
          <h2 style={{ color: "var(--ink)" }}>Folios divididos y enrutamiento</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Divide los cargos de una reserva entre el huésped, la empresa o la agencia de viajes. Las reglas envían automáticamente
            cada nuevo cargo (p. ej. <em>minibar → folio company</em>) al folio adecuado. Pulsa <strong>Transferir</strong> para mover
            un cargo concreto a otro folio.
          </p>
        </div>
      </header>

      {/* Reservation lookup */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Reserva</h3>
          {reservationId ? <span className="bo-chip">{reservationId}</span> : null}
        </div>
        <form className="bo-row" onSubmit={lookup} style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <label className="bo-muted" htmlFor="folio-routing-res" style={{ textTransform: "none" }}>ID de reserva:</label>
          <input
            id="folio-routing-res"
            type="text"
            value={reservationInput}
            onChange={(e) => setReservationInput(e.target.value)}
            placeholder="cmpl4k5hq00x0fyf1y4trooaq"
            className="mono"
            style={{ minWidth: 320 }}
          />
          <button type="submit" className="primary" disabled={!reservationInput.trim()}>Cargar</button>
          {reservationId ? (
            <button type="button" onClick={() => { setReservationId(null); setReservationInput(""); }}>Limpiar</button>
          ) : null}
          {reservationId ? (
            <button type="button" onClick={() => void loadAll(reservationId)} disabled={busy || loading}>↻ Actualizar</button>
          ) : null}
        </form>
      </article>

      {msg ? <p className="bo-status ok" style={{ textTransform: "none" }}>{msg}</p> : null}
      {error ? <ErrorState title="Error" message={error} /> : null}

      {!reservationId ? (
        <EmptyState title="Empieza por una reserva" message="Introduce el ID de una reserva para gestionar sus folios y reglas de enrutamiento." />
      ) : loading && folios.length === 0 ? (
        <LoadingBlock label="Cargando folios y reglas…" />
      ) : (
        <>
          {/* Folios list + create */}
          <article className="bo-card" style={{ background: "var(--surface)" }}>
            <div className="bo-card-head">
              <h3 style={{ color: "var(--ink)" }}>Folios de la reserva</h3>
              <span className="bo-chip">{folios.length}</span>
              {busy ? <Spinner size="sm" /> : null}
            </div>

            {folios.length === 0 ? (
              <EmptyState title="Sin folios" message="Esta reserva todavía no tiene folios. Crea el principal al postear el primer cargo." />
            ) : (
              <div className="rev-report-wrap">
                <table className="cm-table">
                  <thead>
                    <tr><th>Etiqueta</th><th>Tipo</th><th>Estado</th><th>Moneda</th><th>Cargos</th><th>Pendiente</th><th>ID</th></tr>
                  </thead>
                  <tbody>
                    {folios.map((f) => {
                      const bal = linesByFolio[f.id];
                      return (
                        <tr key={f.id}>
                          <td><strong>{f.label}</strong></td>
                          <td><span className={`bo-status ${f.isPrimary ? "info" : "ok"}`} style={{ fontSize: 10 }}>{f.isPrimary ? "principal" : "secundario"}</span></td>
                          <td><span className={`bo-status ${f.status === "open" ? "ok" : "info"}`} style={{ fontSize: 10 }}>{f.status}</span></td>
                          <td className="mono">{f.currency}</td>
                          <td className="mono">{bal ? fmtMoney(bal.total, f.currency) : "—"}</td>
                          <td className="mono">{bal ? fmtMoney(bal.balanceDue, f.currency) : "—"}</td>
                          <td className="mono" style={{ fontSize: 11 }}>{f.id}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <form className="bo-row" onSubmit={addSecondaryFolio} style={{ gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
              <label className="bo-muted" style={{ textTransform: "none" }}>Crear folio secundario:</label>
              <input
                type="text"
                value={newFolioLabel}
                onChange={(e) => setNewFolioLabel(e.target.value)}
                placeholder="company, travel_agent, group_master…"
                style={{ minWidth: 240 }}
              />
              <input
                type="text"
                value={newFolioCurrency}
                onChange={(e) => setNewFolioCurrency(e.target.value.toUpperCase())}
                placeholder="EUR"
                style={{ width: 80 }}
                maxLength={3}
                className="mono"
              />
              <button type="submit" disabled={busy || !newFolioLabel.trim()}>+ Añadir folio</button>
            </form>
          </article>

          {/* Routing rules */}
          <article className="bo-card" style={{ background: "var(--surface)" }}>
            <div className="bo-card-head">
              <h3 style={{ color: "var(--ink)" }}>Reglas de enrutamiento</h3>
              <span className="bo-chip">{rules.length}</span>
            </div>
            <p className="bo-muted" style={{ marginTop: 0, marginBottom: 12, textTransform: "none" }}>
              Cada regla mueve los nuevos cargos del folio principal al folio destino indicado. Si varias reglas coinciden, gana la de
              menor <strong>prioridad</strong>. <code>*</code> hace de comodín (todos los cargos).
            </p>

            {rules.length === 0 ? (
              <EmptyState title="Sin reglas" message="No hay reglas activas. Crea una para que los cargos de minibar/F&B vayan a la empresa, por ejemplo." />
            ) : (
              <div className="rev-report-wrap">
                <table className="cm-table">
                  <thead>
                    <tr><th>Origen</th><th>Folio destino</th><th>Prioridad</th><th>Activa</th><th>Notas</th><th>Creada</th><th></th></tr>
                  </thead>
                  <tbody>
                    {rules.map((r) => (
                      <tr key={r.id}>
                        <td className="mono"><strong>{r.sourceType}</strong></td>
                        <td>{folioLabel(r.targetFolioId)}</td>
                        <td className="mono">{r.priority}</td>
                        <td><span className={`bo-status ${r.active ? "ok" : "info"}`} style={{ fontSize: 10 }}>{r.active ? "activa" : "inactiva"}</span></td>
                        <td>{r.notes ?? "—"}</td>
                        <td className="mono" style={{ fontSize: 11 }}>{fmtDateTime(r.createdAt)}</td>
                        <td><button type="button" onClick={() => void removeRule(r.id)} disabled={busy}>Eliminar</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {folios.length >= 2 ? (
              <form className="bo-row" onSubmit={addRule} style={{ gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
                <label className="bo-muted" style={{ textTransform: "none" }}>Origen:</label>
                <select value={newRuleSource} onChange={(e) => setNewRuleSource(e.target.value)}>
                  {SOURCE_TYPES.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
                </select>
                <label className="bo-muted" style={{ textTransform: "none" }}>Destino:</label>
                <select value={newRuleTarget} onChange={(e) => setNewRuleTarget(e.target.value)}>
                  <option value="">— elige folio —</option>
                  {folios.filter((f) => !f.isPrimary).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                </select>
                <label className="bo-muted" style={{ textTransform: "none" }}>Prioridad:</label>
                <input type="number" value={newRulePriority} onChange={(e) => setNewRulePriority(Number(e.target.value))} style={{ width: 80 }} />
                <input type="text" value={newRuleNotes} onChange={(e) => setNewRuleNotes(e.target.value)} placeholder="notas (opcional)" style={{ minWidth: 200 }} />
                <button type="submit" className="primary" disabled={busy || !newRuleTarget}>+ Añadir regla</button>
              </form>
            ) : (
              <p className="bo-muted" style={{ textTransform: "none", marginTop: 8 }}>
                Necesitas al menos un folio secundario para crear reglas. Crea uno arriba (por ejemplo «company»).
              </p>
            )}
          </article>

          {/* Folio lines per folio */}
          {primaryFolio && folios.length >= 2 ? (
            <article className="bo-card" style={{ background: "var(--surface)" }}>
              <div className="bo-card-head">
                <h3 style={{ color: "var(--ink)" }}>Cargos por folio</h3>
                <span className="bo-chip">{folios.length} folios</span>
              </div>
              <p className="bo-muted" style={{ marginTop: 0, marginBottom: 12, textTransform: "none" }}>
                Pulsa <strong>Transferir</strong> en un cargo para moverlo manualmente a otro folio de la reserva.
              </p>
              <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
                {folios.map((f) => {
                  const bucket = linesByFolio[f.id];
                  const lines = bucket?.lines ?? [];
                  return (
                    <article key={f.id} className="bo-card" style={{ background: "var(--surface-2, var(--surface))" }}>
                      <div className="bo-card-head">
                        <h4 style={{ color: "var(--ink)" }}>{f.label}{f.isPrimary ? " (principal)" : ""}</h4>
                        <span className="bo-chip">{lines.length}</span>
                      </div>
                      {lines.length === 0 ? (
                        <p className="bo-muted" style={{ textTransform: "none" }}>Sin cargos.</p>
                      ) : (
                        <table className="cm-table">
                          <thead><tr><th>Tipo</th><th>Descripción</th><th>Total</th><th></th></tr></thead>
                          <tbody>
                            {lines.map((ln) => (
                              <tr key={ln.id}>
                                <td className="mono">{ln.type}</td>
                                <td>{ln.description}</td>
                                <td className="mono">{fmtMoney(ln.total, f.currency)}</td>
                                <td>
                                  {transferring === ln.id ? (
                                    <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                                      <select value={transferTarget} onChange={(e) => setTransferTarget(e.target.value)}>
                                        <option value="">→ folio…</option>
                                        {folios.filter((x) => x.id !== f.id).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                                      </select>
                                      <button type="button" onClick={() => void doTransfer(ln.id)} disabled={busy || !transferTarget}>OK</button>
                                      <button type="button" onClick={() => { setTransferring(null); setTransferTarget(""); }}>×</button>
                                    </span>
                                  ) : (
                                    <button type="button" onClick={() => { setTransferring(ln.id); setTransferTarget(""); }} disabled={busy}>Transferir</button>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {bucket ? (
                        <p className="bo-muted" style={{ textTransform: "none", marginTop: 8 }}>
                          Cargos: <strong>{fmtMoney(bucket.total, f.currency)}</strong> · Pendiente: <strong>{fmtMoney(bucket.balanceDue, f.currency)}</strong>
                        </p>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </article>
          ) : null}
        </>
      )}
    </section>
  );
}

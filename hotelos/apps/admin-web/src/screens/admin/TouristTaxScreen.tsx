// Tourist tax rates per CCAA (España).
//
// Real endpoints:
//   GET  /tourist-tax/rates[?ccaaCode=CAT]      — listar tarifas
//   POST /tourist-tax/rates                     — crear tarifa
//   POST /tourist-tax/seed                      — sembrar tarifas reales 2026
//
// Modelo: `TouristTaxRate` (packages/database/prisma/schema.prisma).
// Datos reales sembrados: Cataluña (Ley 2/2026), Baleares (Decreto 35/2016),
// País Vasco / Gipuzkoa (Norma Foral 2/2024). El motor calcula la tasa por
// noche · persona · clase, con recargo opcional de temporada alta y
// exenciones (menores, motivos médicos).

import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import {
  createTouristTaxRate, seedTouristTaxRates,
  type TouristTaxRate, type CreateTouristTaxRatePayload
} from "../../services/touristTaxApi";
import { LoadingBlock, ErrorState, EmptyState, Spinner } from "../../components/States";
import { useToast } from "../../components/Toast";

const CCAA_LABEL: Record<string, string> = {
  CAT: "Cataluña",
  BAL: "Baleares",
  EUSK: "País Vasco",
  CAN: "Canarias",
  MAD: "Madrid",
  VAL: "Valencia",
  AND: "Andalucía",
  GAL: "Galicia",
  NAV: "Navarra",
  AST: "Asturias",
  CANT: "Cantabria",
  ARA: "Aragón",
  MUR: "Murcia",
  RIO: "La Rioja",
  CYL: "Castilla y León",
  CLM: "Castilla-La Mancha",
  EXT: "Extremadura",
  CEU: "Ceuta",
  MEL: "Melilla"
};

const CLASS_LABEL: Record<string, string> = {
  lujo_5e: "Lujo / Gran lujo (5*GL)",
  "5_estrellas": "5 estrellas",
  "4_estrellas_sup": "4 estrellas superior",
  "4_estrellas": "4 estrellas",
  "3_estrellas": "3 estrellas",
  "2_estrellas": "2 estrellas",
  "2_o_menos": "2 estrellas o menos",
  "1_estrella": "1 estrella",
  apt_turistico: "Apartamento turístico",
  apt_4_4sup: "Apt. 4★ / 4★ sup",
  apt_3_2_1: "Apt. 1-3★",
  rural: "Turismo rural",
  camping: "Camping",
  hostel: "Hostel / albergue"
};

const EXEMPTION_LABEL: Record<string, { icon: string; label: string }> = {
  MENORES_16: { icon: "‹16", label: "Menores 16" },
  MENORES_18: { icon: "‹18", label: "Menores 18" },
  MEDICAL_TRIP: { icon: "Med", label: "Motivos médicos" },
  FORCED_BY_AUTHORITY: { icon: "Aut", label: "Estancia forzosa" },
  ARMED_FORCES: { icon: "FFAA", label: "Fuerzas armadas" }
};

const CLASS_OPTIONS = Object.keys(CLASS_LABEL);

function fmtMoney(n: number): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 2 }).format(n);
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
}

type Draft = {
  ccaaCode: string;
  municipality: string;
  establishmentClass: string;
  amountPerPersonNight: string;
  currency: string;
  validFrom: string;
  validUntil: string;
  maxNightsPerStay: string;
  highSeasonSurcharge: string;
  highSeasonFromMmdd: string;
  highSeasonUntilMmdd: string;
  taxableAgeFrom: string;
  legalSource: string;
};

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function emptyDraft(): Draft {
  return {
    ccaaCode: "CAT",
    municipality: "",
    establishmentClass: "4_estrellas",
    amountPerPersonNight: "",
    currency: "EUR",
    validFrom: todayIso(),
    validUntil: "",
    maxNightsPerStay: "7",
    highSeasonSurcharge: "",
    highSeasonFromMmdd: "",
    highSeasonUntilMmdd: "",
    taxableAgeFrom: "16",
    legalSource: ""
  };
}

export function TouristTaxScreen() {
  const { showToast } = useToast();
  const [filterCcaa, setFilterCcaa] = useState<string>("");
  const path = filterCcaa
    ? `/tourist-tax/rates?ccaaCode=${encodeURIComponent(filterCcaa)}`
    : `/tourist-tax/rates`;
  const { data, loading, error, refresh } = useApiData<{ items: TouristTaxRate[] }>(path, { pollIntervalMs: 0 });
  const rates = data?.items ?? [];

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft());

  // Agrupar por CCAA
  const byCcaa = useMemo(() => {
    const m = new Map<string, TouristTaxRate[]>();
    for (const r of rates) {
      const arr = m.get(r.ccaaCode) ?? [];
      arr.push(r);
      m.set(r.ccaaCode, arr);
    }
    // Ordenar cada grupo por municipio (null arriba) y luego por clase
    for (const [k, arr] of m.entries()) {
      arr.sort((a, b) => {
        if ((a.municipality ?? "") !== (b.municipality ?? "")) {
          return (a.municipality ?? "").localeCompare(b.municipality ?? "");
        }
        return a.establishmentClass.localeCompare(b.establishmentClass);
      });
      m.set(k, arr);
    }
    return m;
  }, [rates]);

  const kpis = useMemo(() => {
    const activeCcaa = new Set(rates.map((r) => r.ccaaCode));
    const munis = new Set(rates.filter((r) => r.municipality).map((r) => `${r.ccaaCode}:${r.municipality}`));
    const validNow = rates.filter((r) => {
      const now = Date.now();
      const from = new Date(r.validFrom).getTime();
      const until = r.validUntil ? new Date(r.validUntil).getTime() : Number.POSITIVE_INFINITY;
      return now >= from && now <= until;
    });
    return { totalRates: rates.length, ccaaCount: activeCcaa.size, muniCount: munis.size, validCount: validNow.length };
  }, [rates]);

  async function seed() {
    setBusy(true); setMsg(null);
    try {
      const r = await seedTouristTaxRates();
      setMsg(`Seed completado: ${r.rates} tarifas, ${r.exemptions} exenciones.`);
      showToast(`Sembrados ${r.rates} registros de tasa turística`, { variant: "success" });
      refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo sembrar.";
      setMsg(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!draft.ccaaCode.trim() || !draft.establishmentClass.trim()) {
      setMsg("CCAA y clase de establecimiento son obligatorios.");
      return;
    }
    const amount = Number(draft.amountPerPersonNight);
    if (!draft.amountPerPersonNight.trim() || Number.isNaN(amount) || amount < 0) {
      setMsg("La tarifa por persona/noche es obligatoria y no puede ser negativa.");
      return;
    }
    // FIX 10: tope superior razonable. Las tasas turísticas reales en España
    // van de 0,25 € (Asturias, etc.) hasta unos 7-8 €/persona/noche en
    // 5★ GL de Cataluña/Baleares. Si alguien introduce >100 € casi seguro
    // es un typo (€10000/noche habría que rechazar antes de guardar).
    if (amount > 100) {
      setMsg(`La tarifa parece desproporcionada (${amount} €/persona/noche). El máximo permitido es 100 €. Revisa el importe.`);
      return;
    }
    if (!draft.validFrom) { setMsg("La fecha de inicio de vigencia es obligatoria."); return; }
    // FIX 11: validar rango de maxNightsPerStay para evitar valores negativos.
    if (draft.maxNightsPerStay.trim()) {
      const maxNights = Number(draft.maxNightsPerStay);
      if (Number.isNaN(maxNights) || maxNights < 0 || maxNights > 365) {
        setMsg("Máx. noches debe estar entre 0 (sin límite) y 365.");
        return;
      }
    }

    setBusy(true); setMsg(null);
    try {
      const payload: CreateTouristTaxRatePayload = {
        ccaaCode: draft.ccaaCode.trim(),
        municipality: draft.municipality.trim() || null,
        establishmentClass: draft.establishmentClass.trim(),
        amountPerPersonNight: amount,
        currency: draft.currency || "EUR",
        validFrom: draft.validFrom,
        validUntil: draft.validUntil || null,
        maxNightsPerStay: draft.maxNightsPerStay ? Number(draft.maxNightsPerStay) : 0,
        highSeasonSurcharge: draft.highSeasonSurcharge ? Number(draft.highSeasonSurcharge) : null,
        highSeasonFromMmdd: draft.highSeasonFromMmdd.trim() || null,
        highSeasonUntilMmdd: draft.highSeasonUntilMmdd.trim() || null,
        taxableAgeFrom: draft.taxableAgeFrom ? Number(draft.taxableAgeFrom) : 16,
        legalSource: draft.legalSource.trim() || null
      };
      await createTouristTaxRate(payload);
      setMsg(`Tarifa creada en ${CCAA_LABEL[draft.ccaaCode] ?? draft.ccaaCode}.`);
      showToast(`Tarifa de ${CCAA_LABEL[draft.ccaaCode] ?? draft.ccaaCode} creada`, { variant: "success" });
      setShowForm(false);
      setDraft(emptyDraft());
      refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo crear la tarifa.";
      setMsg(message);
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>Compliance · Tasas autonómicas</p>
          <h2 style={{ color: "var(--ink)" }}>Tasa turística por CCAA</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Tarifas vigentes en España. El motor de tasa turística aplica la tarifa <strong>más específica</strong>
            (municipio + CCAA, o sólo CCAA), respetando recargos de temporada alta y exenciones
            (menores, motivos médicos, fuerzas armadas según jurisdicción).
          </p>
        </div>
        <div className="bo-row" style={{ gap: 8, alignItems: "center" }}>
          {busy ? <Spinner size="sm" /> : null}
          <button type="button" onClick={refresh} disabled={loading}>↻ Actualizar</button>
          <button type="button" onClick={seed} disabled={busy}>↻ Sembrar tarifas 2026</button>
          <button type="button" className="primary" onClick={() => { setDraft(emptyDraft()); setShowForm(true); setMsg(null); }} disabled={busy}>+ Nueva tarifa</button>
        </div>
      </header>

      {msg ? <p role="status" aria-live="polite" className="bo-status ok" style={{ textTransform: "none" }}>{msg}</p> : null}

      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Tarifas catalogadas</span><span className="bo-status info">total</span></div>
          <div className="rev-kpi-value">{kpis.totalRates}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Vigentes hoy</span><span className="bo-status ok">activas</span></div>
          <div className="rev-kpi-value">{kpis.validCount}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">CCAA cubiertas</span><span className="bo-status info">distintas</span></div>
          <div className="rev-kpi-value">{kpis.ccaaCount}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Tarifas municipales</span><span className="bo-status info">recargo local</span></div>
          <div className="rev-kpi-value">{kpis.muniCount}</div>
        </article>
      </div>

      <div className="bo-row" style={{ gap: 8, alignItems: "center" }}>
        <label className="bo-form-field" style={{ minWidth: 200 }}>
          <span>Filtrar por CCAA</span>
          <select value={filterCcaa} onChange={(e) => setFilterCcaa(e.target.value)} disabled={busy}>
            <option value="">Todas</option>
            {Object.keys(CCAA_LABEL).map((c) => <option key={c} value={c}>{CCAA_LABEL[c]} ({c})</option>)}
          </select>
        </label>
      </div>

      {loading && rates.length === 0 ? (
        <LoadingBlock label="Cargando tarifas…" />
      ) : error ? (
        <ErrorState title="No se pudieron cargar las tarifas" message={error} onRetry={refresh} />
      ) : rates.length === 0 ? (
        <EmptyState
          title="Sin tarifas catalogadas"
          message="Pulsa «Sembrar tarifas 2026» para cargar las tarifas reales vigentes en España (CAT, BAL, EUSK), o «Nueva tarifa» para crear una manual."
          actions={<button type="button" className="primary" onClick={seed} disabled={busy}>↻ Sembrar tarifas 2026</button>}
        />
      ) : (
        <div className="bo-stack" style={{ gap: 12 }}>
          {[...byCcaa.entries()].map(([ccaa, items]) => (
            <article key={ccaa} className="bo-card" style={{ background: "var(--surface)" }}>
              <div className="bo-card-head">
                <div>
                  <h3 style={{ color: "var(--ink)", margin: 0 }}>
                    {CCAA_LABEL[ccaa] ?? ccaa} <span className="mono bo-muted" style={{ fontSize: 12, fontWeight: 400 }}>({ccaa})</span>
                  </h3>
                  <p className="bo-muted" style={{ margin: "2px 0 0 0", fontSize: 12, textTransform: "none" }}>
                    {items.length} tarifa{items.length === 1 ? "" : "s"} catalogada{items.length === 1 ? "" : "s"}
                  </p>
                </div>
                <span className="bo-chip">{items.length}</span>
              </div>
              <div className="rev-report-wrap">
                <table className="cm-table">
                  <thead>
                    <tr>
                      <th>Municipio</th>
                      <th>Categoría</th>
                      <th style={{ textAlign: "right" }}>€/persona/noche</th>
                      <th>Máx. noches</th>
                      <th>Temp. alta</th>
                      <th>Exenciones</th>
                      <th>Vigencia</th>
                      <th>Fuente legal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((r) => (
                      <tr key={r.id}>
                        <td>{r.municipality ?? <span className="bo-muted" style={{ fontStyle: "italic" }}>Toda la CCAA</span>}</td>
                        <td>{CLASS_LABEL[r.establishmentClass] ?? r.establishmentClass}</td>
                        <td style={{ textAlign: "right" }}><strong>{fmtMoney(Number(r.amountPerPersonNight))}</strong></td>
                        <td>{r.maxNightsPerStay > 0 ? `${r.maxNightsPerStay} n.` : <span className="bo-muted">Sin límite</span>}</td>
                        <td>
                          {r.highSeasonSurcharge && r.highSeasonSurcharge > 0 ? (
                            <span className="bo-chip" style={{ fontSize: 11 }} title={`Recargo del ${(Number(r.highSeasonSurcharge) * 100).toFixed(0)}% entre ${r.highSeasonFromMmdd} y ${r.highSeasonUntilMmdd}`}>
                              +{(Number(r.highSeasonSurcharge) * 100).toFixed(0)}% · {r.highSeasonFromMmdd}→{r.highSeasonUntilMmdd}
                            </span>
                          ) : <span className="bo-muted" style={{ fontSize: 12 }}>—</span>}
                        </td>
                        <td>
                          <span style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                            {/* Exenciones del régimen: edad mínima de tributación. */}
                            <span className="bo-chip" style={{ fontSize: 11 }} title={`Menores de ${r.taxableAgeFrom} años exentos`}>
                              ‹{r.taxableAgeFrom}
                            </span>
                            {r.ccaaCode === "CAT" ? (
                              <>
                                <span className="bo-chip" style={{ fontSize: 11 }}>{EXEMPTION_LABEL.MEDICAL_TRIP.icon}</span>
                                <span className="bo-chip" style={{ fontSize: 11 }}>{EXEMPTION_LABEL.FORCED_BY_AUTHORITY.icon}</span>
                              </>
                            ) : null}
                          </span>
                        </td>
                        <td className="bo-muted" style={{ fontSize: 12 }}>
                          {fmtDate(r.validFrom)} → {r.validUntil ? fmtDate(r.validUntil) : "indef."}
                        </td>
                        <td className="bo-muted" style={{ fontSize: 11 }}>{r.legalSource ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          ))}
        </div>
      )}

      {showForm ? (
        <article className="bo-card" style={{ background: "var(--surface)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)", margin: 0 }}>Nueva tarifa</h3>
            <button type="button" onClick={() => setShowForm(false)} aria-label="Cerrar formulario de nueva tarifa" title="Cerrar">✕</button>
          </div>
          <div className="bo-grid two" style={{ gap: 10 }}>
            <label className="bo-form-field">
              <span>CCAA *</span>
              <select value={draft.ccaaCode} onChange={(e) => setDraft((d) => ({ ...d, ccaaCode: e.target.value }))} disabled={busy}>
                {Object.keys(CCAA_LABEL).map((c) => <option key={c} value={c}>{CCAA_LABEL[c]} ({c})</option>)}
              </select>
            </label>
            <label className="bo-form-field">
              <span>Municipio (vacío = toda la CCAA)</span>
              <input value={draft.municipality} onChange={(e) => setDraft((d) => ({ ...d, municipality: e.target.value }))} placeholder="Ej. Barcelona" disabled={busy} />
            </label>
            <label className="bo-form-field">
              <span>Categoría del establecimiento *</span>
              <select value={draft.establishmentClass} onChange={(e) => setDraft((d) => ({ ...d, establishmentClass: e.target.value }))} disabled={busy}>
                {CLASS_OPTIONS.map((c) => <option key={c} value={c}>{CLASS_LABEL[c]}</option>)}
              </select>
            </label>
            <label className="bo-form-field">
              <span>€ por persona y noche *</span>
              <input type="number" min={0} max={100} step={0.01} value={draft.amountPerPersonNight} onChange={(e) => setDraft((d) => ({ ...d, amountPerPersonNight: e.target.value }))} placeholder="3.50" disabled={busy} />
            </label>
            <label className="bo-form-field">
              <span>Vigente desde *</span>
              <input type="date" value={draft.validFrom} onChange={(e) => setDraft((d) => ({ ...d, validFrom: e.target.value }))} disabled={busy} />
            </label>
            <label className="bo-form-field">
              <span>Vigente hasta (opcional)</span>
              <input type="date" value={draft.validUntil} onChange={(e) => setDraft((d) => ({ ...d, validUntil: e.target.value }))} disabled={busy} />
            </label>
            <label className="bo-form-field">
              <span>Máx. noches por estancia (0 = sin límite)</span>
              <input type="number" min={0} step={1} value={draft.maxNightsPerStay} onChange={(e) => setDraft((d) => ({ ...d, maxNightsPerStay: e.target.value }))} disabled={busy} />
            </label>
            <label className="bo-form-field">
              <span>Edad mínima tributable</span>
              <input type="number" min={0} max={99} step={1} value={draft.taxableAgeFrom} onChange={(e) => setDraft((d) => ({ ...d, taxableAgeFrom: e.target.value }))} disabled={busy} />
            </label>
            <label className="bo-form-field">
              <span>Recargo temp. alta (0.25 = +25%)</span>
              <input type="number" min={0} max={1} step={0.01} value={draft.highSeasonSurcharge} onChange={(e) => setDraft((d) => ({ ...d, highSeasonSurcharge: e.target.value }))} placeholder="0.25" disabled={busy} />
            </label>
            <label className="bo-form-field">
              <span>Temp. alta desde (mm-dd)</span>
              <input value={draft.highSeasonFromMmdd} onChange={(e) => setDraft((d) => ({ ...d, highSeasonFromMmdd: e.target.value }))} placeholder="05-01" disabled={busy} />
            </label>
            <label className="bo-form-field">
              <span>Temp. alta hasta (mm-dd)</span>
              <input value={draft.highSeasonUntilMmdd} onChange={(e) => setDraft((d) => ({ ...d, highSeasonUntilMmdd: e.target.value }))} placeholder="10-31" disabled={busy} />
            </label>
            <label className="bo-form-field" style={{ gridColumn: "1 / -1" }}>
              <span>Fuente legal (DOGC, BOE, etc.)</span>
              <input value={draft.legalSource} onChange={(e) => setDraft((d) => ({ ...d, legalSource: e.target.value }))} placeholder="DOGC Ley 2/2026" disabled={busy} />
            </label>
          </div>
          <div className="bo-actions" style={{ marginTop: 10 }}>
            <button type="button" className="primary" onClick={save} disabled={busy}>Crear tarifa</button>
            <button type="button" onClick={() => setShowForm(false)} disabled={busy}>Cancelar</button>
          </div>
        </article>
      ) : null}
    </section>
  );
}

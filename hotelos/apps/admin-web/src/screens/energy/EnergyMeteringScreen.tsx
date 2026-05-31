// Energy metering — contadores eléctricos/gas/agua por zona del hotel.
// Alimenta los indicadores E1 y E3 del informe CSRD automáticamente.

import { useMemo, useState } from "react";

type EnergyMeter = {
  id: string;
  code: string;
  name: string;
  zone: string;
  type: "electricity" | "gas" | "water" | "heat" | "solar";
  unit: string;
  /** Cómo se obtiene la lectura: manual / iot / utility_api. */
  source: "manual" | "iot" | "utility_api";
  /** Tarifa contractada (eléctrica: 2.0TD, 3.0TD…). */
  tariff?: string;
  lastReadingValue: number;
  lastReadingAt: string;
  monthToDateConsumption: number;
  monthToDateCostEur: number;
  yoyChangePct: number;
  active: boolean;
};

const INITIAL_METERS: EnergyMeter[] = [
  {
    id: "m_main_electric",
    code: "ELEC-001",
    name: "Contador principal eléctrico",
    zone: "Edificio principal",
    type: "electricity",
    unit: "kWh",
    source: "iot",
    tariff: "3.0TD (Iberdrola)",
    lastReadingValue: 248_392,
    lastReadingAt: "2026-05-26T17:00:00Z",
    monthToDateConsumption: 18_420,
    monthToDateCostEur: 3_154,
    yoyChangePct: -7.4,
    active: true
  },
  {
    id: "m_kitchen_gas",
    code: "GAS-001",
    name: "Gas natural (cocina + caldera)",
    zone: "Cocina + sala calderas",
    type: "gas",
    unit: "m³",
    source: "iot",
    tariff: "Naturgy industrial",
    lastReadingValue: 84_201,
    lastReadingAt: "2026-05-26T17:00:00Z",
    monthToDateConsumption: 1_812,
    monthToDateCostEur: 1_392,
    yoyChangePct: 2.1,
    active: true
  },
  {
    id: "m_solar_rooftop",
    code: "SOLAR-001",
    name: "Placas solares cubierta",
    zone: "Cubierta",
    type: "solar",
    unit: "kWh",
    source: "iot",
    lastReadingValue: 42_180,
    lastReadingAt: "2026-05-26T17:00:00Z",
    monthToDateConsumption: 3_104,
    monthToDateCostEur: 0,
    yoyChangePct: 14.8,
    active: true
  },
  {
    id: "m_main_water",
    code: "WATER-001",
    name: "Contador principal agua",
    zone: "Acometida edificio",
    type: "water",
    unit: "m³",
    source: "manual",
    lastReadingValue: 12_402,
    lastReadingAt: "2026-05-15T10:00:00Z",
    monthToDateConsumption: 412,
    monthToDateCostEur: 891,
    yoyChangePct: -3.2,
    active: true
  },
  {
    id: "m_spa_heat",
    code: "HEAT-001",
    name: "Calor SPA + piscina",
    zone: "Sótano · SPA",
    type: "heat",
    unit: "kWh",
    source: "iot",
    lastReadingValue: 38_104,
    lastReadingAt: "2026-05-26T17:00:00Z",
    monthToDateConsumption: 2_840,
    monthToDateCostEur: 487,
    yoyChangePct: -1.8,
    active: true
  }
];

const TYPE_ICON: Record<string, string> = {
  electricity: "⚡",
  gas: "🔥",
  water: "💧",
  heat: "🌡",
  solar: "☀"
};
const TYPE_COLOR: Record<string, string> = {
  electricity: "#f0b46a",
  gas: "#ef6b6b",
  water: "#7aa9ff",
  heat: "#e8eef3",
  solar: "#4ee0a3"
};
const TYPE_LABEL: Record<string, string> = {
  electricity: "Electricidad",
  gas: "Gas",
  water: "Agua",
  heat: "Calor / climatización",
  solar: "Solar (generación)"
};

const SOURCE_LABEL: Record<string, string> = {
  manual: "Lectura manual",
  iot: "IoT (tiempo real)",
  utility_api: "API de la utility"
};

function fmtNum(n: number, decimals = 0): string {
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits: decimals }).format(n);
}
function fmtMoney(n: number): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
}
function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function EnergyMeteringScreen() {
  const [meters, setMeters] = useState<EnergyMeter[]>(INITIAL_METERS);
  const [editing, setEditing] = useState<EnergyMeter | null>(null);

  const stats = useMemo(() => {
    const consumed = meters.filter((m) => m.type !== "solar").reduce((s, m) => s + m.monthToDateConsumption, 0);
    const solarGen = meters.filter((m) => m.type === "solar").reduce((s, m) => s + m.monthToDateConsumption, 0);
    const totalCost = meters.reduce((s, m) => s + m.monthToDateCostEur, 0);
    const co2Tons = (consumed * 0.0002).toFixed(2); // factor demo: 0.2 kgCO2/kWh
    const ioted = meters.filter((m) => m.source === "iot").length;
    return { consumed, solarGen, totalCost, co2Tons, ioted, total: meters.length };
  }, [meters]);

  function patch(id: string, partial: Partial<EnergyMeter>) {
    setMeters((prev) => prev.map((m) => (m.id === id ? { ...m, ...partial } : m)));
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
            Sostenibilidad · Contadores
          </p>
          <h2 style={{ color: "var(--ink)" }}>Energía y agua</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Contadores conectados (IoT) y manuales por zona. Las lecturas alimentan automáticamente los indicadores
            <strong> E1 (clima)</strong> y <strong>E3 (agua)</strong> del informe CSRD, y disparan alertas si el consumo se desvía vs YoY.
          </p>
        </div>
      </header>

      {/* KPIs */}
      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Consumo total (mes)</span></div>
          <div className="rev-kpi-value">{fmtNum(stats.consumed)} kWh-eq</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Generación solar</span><span className="bo-status ok">autoconsumo</span></div>
          <div className="rev-kpi-value">{fmtNum(stats.solarGen)} kWh</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Coste energético</span></div>
          <div className="rev-kpi-value">{fmtMoney(stats.totalCost)}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">CO₂ estimado</span><span className="bo-status info">tCO₂e</span></div>
          <div className="rev-kpi-value">{stats.co2Tons}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Contadores IoT</span><span className="bo-status ok">{stats.ioted}/{stats.total}</span></div>
          <div className="rev-kpi-value">{Math.round((stats.ioted / Math.max(1, stats.total)) * 100)} %</div>
        </article>
      </div>

      {editing ? (
        <article className="bo-card" style={{ background: "var(--surface-2, var(--surface))", border: "1px solid var(--accent)" }}>
          <div className="bo-card-head">
            <h3 style={{ color: "var(--ink)" }}>Lectura manual · {editing.name}</h3>
            <button type="button" onClick={() => setEditing(null)}>Cancelar</button>
          </div>
          <p className="bo-muted" style={{ textTransform: "none", margin: 0 }}>
            Última lectura: {fmtNum(editing.lastReadingValue)} {editing.unit} ({fmtTime(editing.lastReadingAt)}).
          </p>
          <div className="bo-row" style={{ gap: 8, marginTop: 12 }}>
            <input
              type="number"
              defaultValue={editing.lastReadingValue}
              onChange={(e) => setEditing({ ...editing, lastReadingValue: Number(e.target.value) })}
              placeholder={`Nueva lectura en ${editing.unit}`}
              style={{ flex: "1 1 0%" }}
            />
            <button type="button" className="primary" onClick={() => {
              patch(editing.id, { lastReadingValue: editing.lastReadingValue, lastReadingAt: new Date().toISOString() });
              setEditing(null);
            }}>Guardar lectura</button>
          </div>
        </article>
      ) : null}

      {/* Meters table */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Contadores</h3>
          <span className="bo-chip">{meters.length}</span>
        </div>
        <div className="rev-report-wrap">
          <table className="cm-table">
            <thead>
              <tr>
                <th>Código</th><th>Nombre / zona</th><th>Tipo</th><th>Origen</th>
                <th>Última lectura</th><th>Consumo MTD</th><th>Coste MTD</th><th>YoY</th><th></th>
              </tr>
            </thead>
            <tbody>
              {meters.map((m) => (
                <tr key={m.id}>
                  <td className="mono"><strong>{m.code}</strong></td>
                  <td>
                    <strong>{m.name}</strong>
                    <small className="bo-muted" style={{ display: "block" }}>{m.zone}{m.tariff ? " · " + m.tariff : ""}</small>
                  </td>
                  <td>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <span style={{ background: TYPE_COLOR[m.type], width: 8, height: 8, borderRadius: 99 }} />
                      {TYPE_ICON[m.type]} {TYPE_LABEL[m.type]}
                    </span>
                  </td>
                  <td>
                    <span className={`bo-status ${m.source === "iot" ? "ok" : "info"}`} style={{ fontSize: 10 }}>
                      {SOURCE_LABEL[m.source]}
                    </span>
                  </td>
                  <td className="mono">
                    {fmtNum(m.lastReadingValue)} {m.unit}
                    <small className="bo-muted" style={{ display: "block", fontSize: 10 }}>{fmtTime(m.lastReadingAt)}</small>
                  </td>
                  <td className="mono">{fmtNum(m.monthToDateConsumption)} {m.unit}</td>
                  <td className="mono">{m.monthToDateCostEur > 0 ? fmtMoney(m.monthToDateCostEur) : "—"}</td>
                  <td className="mono" style={{ color: m.yoyChangePct < 0 ? "var(--accent)" : m.yoyChangePct > 5 ? "var(--warn-ink, #ef6b6b)" : undefined }}>
                    {m.yoyChangePct > 0 ? "+" : ""}{m.yoyChangePct.toFixed(1)} %
                  </td>
                  <td>
                    {m.source === "manual" ? (
                      <button type="button" onClick={() => setEditing(m)}>+ Lectura</button>
                    ) : (
                      <span className="bo-muted" style={{ fontSize: 11 }}>auto</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>

      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Conexión a CSRD / ESRS</h3></div>
        <p className="bo-muted" style={{ textTransform: "none", marginTop: 0 }}>
          Las lecturas de este módulo alimentan los siguientes disclosures del informe de sostenibilidad:
        </p>
        <ul style={{ fontSize: 13, color: "var(--ink)", marginTop: 4 }}>
          <li><strong>ESRS E1-5</strong> Consumo total de energía (electricidad + gas + calor) y % renovable (solar).</li>
          <li><strong>ESRS E1-6</strong> Emisiones GEI Scope 1 (gas) y Scope 2 (electricidad).</li>
          <li><strong>ESRS E3-4</strong> Consumo de agua absoluto + por noche ocupada.</li>
        </ul>
      </article>
    </section>
  );
}

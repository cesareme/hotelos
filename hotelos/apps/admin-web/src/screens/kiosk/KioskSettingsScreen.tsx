// Kiosco de self check-in — configuración del terminal físico de la entrada.
// Modo "huésped solo": el sistema verifica DNI por OCR, cobra saldo si queda,
// imprime tarjeta de llave y envía la digital al móvil.

import { useState } from "react";

type KioskTerminal = {
  id: string;
  code: string;
  location: string;
  status: "online" | "offline" | "maintenance";
  serialNumber: string;
  firmware: string;
  lastHeartbeat: string;
  checkInsToday: number;
  checkInsTotal: number;
  averageDurationSeconds: number;
};

type KioskConfig = {
  enabled: boolean;
  modes: { checkIn: boolean; checkOut: boolean; bookExtra: boolean; printReceipts: boolean };
  scanIdRequired: boolean;
  pricePreauthEur: number;
  languages: string[];
  brandingColor: string;
  printerConnected: boolean;
  keyCardEncoder: "salto" | "assa_abloy_vostio" | "dormakaba" | "none";
  fallbackToStaff: boolean;
  /** Cuántos segundos de inactividad antes de reiniciar la sesión. */
  inactivityTimeoutSec: number;
};

const INITIAL_TERMINALS: KioskTerminal[] = [
  { id: "k1", code: "KIOSK-LOBBY-01", location: "Lobby principal · entrada", status: "online", serialNumber: "DL7530-A8K3M", firmware: "v2.4.1", lastHeartbeat: "2026-05-26T19:45:00Z", checkInsToday: 12, checkInsTotal: 4_812, averageDurationSeconds: 168 },
  { id: "k2", code: "KIOSK-LOBBY-02", location: "Lobby principal · vestíbulo", status: "online", serialNumber: "DL7530-A8K3N", firmware: "v2.4.1", lastHeartbeat: "2026-05-26T19:46:00Z", checkInsToday: 8, checkInsTotal: 3_491, averageDurationSeconds: 182 },
  { id: "k3", code: "KIOSK-VIP", location: "Lounge VIP · 5ª planta", status: "maintenance", serialNumber: "DL7530-V01", firmware: "v2.3.8", lastHeartbeat: "2026-05-26T08:12:00Z", checkInsToday: 0, checkInsTotal: 642, averageDurationSeconds: 94 }
];

const INITIAL_CONFIG: KioskConfig = {
  enabled: true,
  modes: { checkIn: true, checkOut: true, bookExtra: true, printReceipts: true },
  scanIdRequired: true,
  pricePreauthEur: 50,
  languages: ["es", "en", "fr", "de"],
  brandingColor: "#4ee0a3",
  printerConnected: true,
  keyCardEncoder: "salto",
  fallbackToStaff: true,
  inactivityTimeoutSec: 90
};

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function KioskSettingsScreen() {
  const [terminals, setTerminals] = useState<KioskTerminal[]>(INITIAL_TERMINALS);
  const [config, setConfig] = useState<KioskConfig>(INITIAL_CONFIG);
  const [msg, setMsg] = useState<string | null>(null);

  const onlineCount = terminals.filter((t) => t.status === "online").length;
  const totalToday = terminals.reduce((s, t) => s + t.checkInsToday, 0);
  const avgDuration = terminals.reduce((s, t, _, arr) => s + t.averageDurationSeconds / arr.length, 0);

  function save() {
    setMsg("Configuración del kiosco guardada. Los terminales recogerán los cambios en el próximo heartbeat (≤30s).");
    setTimeout(() => setMsg(null), 4000);
  }

  function patchTerminalStatus(id: string, status: KioskTerminal["status"]) {
    setTerminals((prev) => prev.map((t) => (t.id === id ? { ...t, status } : t)));
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
            Experiencia del huésped · Kiosco
          </p>
          <h2 style={{ color: "var(--ink)" }}>Self check-in (kiosco)</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Terminales físicos en lobby que permiten al huésped completar check-in (OCR DNI + firma + pre-autorización tarjeta)
            y entregar la tarjeta de llave (codificada por la cerradura conectada). Reduce colas en horas punta.
          </p>
        </div>
        <button type="button" className="primary" onClick={save}>Guardar configuración</button>
      </header>

      {msg ? <p className="bo-status ok" style={{ textTransform: "none" }}>{msg}</p> : null}

      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Terminales online</span><span className="bo-status ok">de {terminals.length}</span></div>
          <div className="rev-kpi-value">{onlineCount}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Check-ins hoy</span></div>
          <div className="rev-kpi-value">{totalToday}</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Tiempo medio</span></div>
          <div className="rev-kpi-value">{Math.round(avgDuration)} s</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Servicio activo</span></div>
          <div className="rev-kpi-value">{config.enabled ? "✓" : "✗"}</div>
        </article>
      </div>

      {/* Config */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Configuración global del servicio</h3></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
          <fieldset style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
            <legend style={{ fontSize: 11, color: "var(--ink-muted)" }}>Modos habilitados</legend>
            {Object.entries({ checkIn: "Check-in", checkOut: "Check-out", bookExtra: "Reservar extras (parking, breakfast)", printReceipts: "Imprimir comprobantes" }).map(([k, label]) => (
              <label key={k} style={{ display: "flex", gap: 6, alignItems: "center", margin: "4px 0", cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={config.modes[k as keyof typeof config.modes]}
                  onChange={(e) => setConfig({ ...config, modes: { ...config.modes, [k]: e.target.checked } })}
                />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <fieldset style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
            <legend style={{ fontSize: 11, color: "var(--ink-muted)" }}>Identificación y pagos</legend>
            <label style={{ display: "flex", gap: 6, alignItems: "center", margin: "4px 0" }}>
              <input type="checkbox" checked={config.scanIdRequired} onChange={(e) => setConfig({ ...config, scanIdRequired: e.target.checked })} />
              <span>Escanear DNI/Pasaporte (OCR)</span>
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", margin: "4px 0" }}>
              <span>Pre-autorización tarjeta (€)</span>
              <input type="number" value={config.pricePreauthEur} onChange={(e) => setConfig({ ...config, pricePreauthEur: Number(e.target.value) })} style={{ width: 80 }} />
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", margin: "4px 0" }}>
              <input type="checkbox" checked={config.fallbackToStaff} onChange={(e) => setConfig({ ...config, fallbackToStaff: e.target.checked })} />
              <span>Llamar al staff si OCR falla</span>
            </label>
          </fieldset>
          <fieldset style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
            <legend style={{ fontSize: 11, color: "var(--ink-muted)" }}>Hardware</legend>
            <label style={{ display: "flex", gap: 6, alignItems: "center", margin: "4px 0" }}>
              <input type="checkbox" checked={config.printerConnected} onChange={(e) => setConfig({ ...config, printerConnected: e.target.checked })} />
              <span>Impresora ticket conectada</span>
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", margin: "4px 0" }}>
              <span>Codificador llave</span>
              <select value={config.keyCardEncoder} onChange={(e) => setConfig({ ...config, keyCardEncoder: e.target.value as KioskConfig["keyCardEncoder"] })} style={{ flex: "1 1 0%" }}>
                <option value="salto">SALTO KS</option>
                <option value="assa_abloy_vostio">ASSA ABLOY Vostio</option>
                <option value="dormakaba">dormakaba</option>
                <option value="none">Sin codificador (solo digital)</option>
              </select>
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", margin: "4px 0" }}>
              <span>Timeout inactividad (s)</span>
              <input type="number" value={config.inactivityTimeoutSec} onChange={(e) => setConfig({ ...config, inactivityTimeoutSec: Number(e.target.value) })} style={{ width: 80 }} />
            </label>
          </fieldset>
        </div>
      </article>

      {/* Terminals */}
      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Terminales</h3>
          <span className="bo-chip">{terminals.length}</span>
        </div>
        <div className="rev-report-wrap">
          <table className="cm-table">
            <thead><tr><th>Código</th><th>Ubicación</th><th>Estado</th><th>S/N · Firmware</th><th>Hoy</th><th>Total</th><th>Tiempo medio</th><th>Heartbeat</th><th></th></tr></thead>
            <tbody>
              {terminals.map((t) => (
                <tr key={t.id}>
                  <td className="mono"><strong>{t.code}</strong></td>
                  <td>{t.location}</td>
                  <td><span className={`bo-status ${t.status === "online" ? "ok" : t.status === "maintenance" ? "warn" : "info"}`} style={{ fontSize: 10 }}>{t.status}</span></td>
                  <td className="mono" style={{ fontSize: 11 }}>{t.serialNumber}<br />{t.firmware}</td>
                  <td className="mono">{t.checkInsToday}</td>
                  <td className="mono">{t.checkInsTotal.toLocaleString("es-ES")}</td>
                  <td className="mono">{t.averageDurationSeconds} s</td>
                  <td className="mono" style={{ fontSize: 11 }}>{fmtDateTime(t.lastHeartbeat)}</td>
                  <td>
                    {t.status === "online" ? (
                      <button type="button" onClick={() => patchTerminalStatus(t.id, "maintenance")}>Pausar</button>
                    ) : (
                      <button type="button" onClick={() => patchTerminalStatus(t.id, "online")}>Activar</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
    </section>
  );
}

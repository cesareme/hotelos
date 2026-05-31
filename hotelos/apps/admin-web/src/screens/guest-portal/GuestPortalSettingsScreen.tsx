// Portal del huésped — configuración de branding, idiomas, ventanas de
// pre-check-in/check-out online, y qué funciones se ofrecen al huésped.

import { useState } from "react";

type PortalConfig = {
  brandName: string;
  primaryColor: string;
  logoUrl: string;
  languages: string[];
  defaultLanguage: string;
  preCheckInOpensHours: number;
  preCheckInRequiresPayment: boolean;
  onlineCheckOutEnabled: boolean;
  onlineCheckOutClosesHours: number;
  guestMessagingEnabled: boolean;
  showFolioBalance: boolean;
  showInvoiceDownload: boolean;
  showUpsells: boolean;
  showLocalRecommendations: boolean;
  requireIdScan: boolean;
  requireSignature: boolean;
  customDomain: string | null;
};

const INITIAL_CONFIG: PortalConfig = {
  brandName: "HotelOS Madrid Centro",
  primaryColor: "#4ee0a3",
  logoUrl: "",
  languages: ["es", "en", "fr", "de"],
  defaultLanguage: "es",
  preCheckInOpensHours: 48,
  preCheckInRequiresPayment: false,
  onlineCheckOutEnabled: true,
  onlineCheckOutClosesHours: 0,
  guestMessagingEnabled: true,
  showFolioBalance: true,
  showInvoiceDownload: true,
  showUpsells: true,
  showLocalRecommendations: true,
  requireIdScan: true,
  requireSignature: true,
  customDomain: null
};

const AVAILABLE_LANGUAGES = [
  { code: "es", name: "Español" },
  { code: "en", name: "English" },
  { code: "fr", name: "Français" },
  { code: "de", name: "Deutsch" },
  { code: "it", name: "Italiano" },
  { code: "pt", name: "Português" },
  { code: "ca", name: "Català" },
  { code: "eu", name: "Euskera" },
  { code: "gl", name: "Galego" }
];

const FEATURE_KPIS = {
  preCheckInRate: 67.4,
  averageCompletionMinutes: 4.2,
  signatureUploadSuccessRate: 94.1,
  messagingResponseMinutes: 12,
  upsellConversionRate: 8.6,
  recommendationsViewsLast30d: 1842
};

export function GuestPortalSettingsScreen() {
  const [config, setConfig] = useState<PortalConfig>(INITIAL_CONFIG);
  const [msg, setMsg] = useState<string | null>(null);

  function toggleLanguage(code: string) {
    setConfig((prev) => ({
      ...prev,
      languages: prev.languages.includes(code) ? prev.languages.filter((l) => l !== code) : [...prev.languages, code]
    }));
  }

  function save() {
    setMsg("Configuración guardada. Los cambios se aplican en la próxima visita al portal.");
    setTimeout(() => setMsg(null), 4000);
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
            Experiencia del huésped · Portal
          </p>
          <h2 style={{ color: "var(--ink)" }}>Portal del huésped</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            URL pública: <code>{config.customDomain ?? "huesped.hotelos.app/" + config.brandName.toLowerCase().replace(/\s+/g, "-")}</code>. Recibe magic-link por email tras confirmar la reserva.
          </p>
        </div>
        <button type="button" className="primary" onClick={save}>Guardar configuración</button>
      </header>

      {msg ? <p className="bo-status ok" style={{ textTransform: "none" }}>{msg}</p> : null}

      {/* KPIs en vivo del portal */}
      <div className="rev-kpi-grid">
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">% pre-check-in online</span><span className="bo-status ok">últimos 30 d</span></div>
          <div className="rev-kpi-value">{FEATURE_KPIS.preCheckInRate.toFixed(1)} %</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Tiempo medio completar</span></div>
          <div className="rev-kpi-value">{FEATURE_KPIS.averageCompletionMinutes} min</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Conversión upsells</span><span className="bo-status info">RevPAR +</span></div>
          <div className="rev-kpi-value">{FEATURE_KPIS.upsellConversionRate.toFixed(1)} %</div>
        </article>
        <article className="rev-kpi rev-kpi-ok">
          <div className="rev-kpi-head"><span className="rev-kpi-label">Recomendaciones vistas</span></div>
          <div className="rev-kpi-value">{FEATURE_KPIS.recommendationsViewsLast30d.toLocaleString("es-ES")}</div>
        </article>
      </div>

      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Identidad de marca</h3></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
          <label>Nombre de marca<input value={config.brandName} onChange={(e) => setConfig({ ...config, brandName: e.target.value })} /></label>
          <label>Color primario<input type="color" value={config.primaryColor} onChange={(e) => setConfig({ ...config, primaryColor: e.target.value })} /></label>
          <label>URL del logo (PNG / SVG)<input value={config.logoUrl} onChange={(e) => setConfig({ ...config, logoUrl: e.target.value })} placeholder="https://…" /></label>
          <label>Dominio personalizado<input value={config.customDomain ?? ""} onChange={(e) => setConfig({ ...config, customDomain: e.target.value || null })} placeholder="huesped.mihotel.com" /></label>
        </div>
      </article>

      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Idiomas ({config.languages.length})</h3>
          <select value={config.defaultLanguage} onChange={(e) => setConfig({ ...config, defaultLanguage: e.target.value })}>
            {config.languages.map((l) => <option key={l} value={l}>Por defecto: {AVAILABLE_LANGUAGES.find((a) => a.code === l)?.name ?? l}</option>)}
          </select>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 6, marginTop: 8 }}>
          {AVAILABLE_LANGUAGES.map((l) => (
            <label key={l.code} style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input type="checkbox" checked={config.languages.includes(l.code)} onChange={() => toggleLanguage(l.code)} />
              <span>{l.name} <code className="mono" style={{ fontSize: 10, color: "var(--ink-muted)" }}>{l.code}</code></span>
            </label>
          ))}
        </div>
      </article>

      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Ventanas de check-in y check-out</h3></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
          <label>Pre check-in abre (h antes llegada)<input type="number" value={config.preCheckInOpensHours} onChange={(e) => setConfig({ ...config, preCheckInOpensHours: Number(e.target.value) })} /></label>
          <label style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 24 }}>
            <input type="checkbox" checked={config.preCheckInRequiresPayment} onChange={(e) => setConfig({ ...config, preCheckInRequiresPayment: e.target.checked })} />
            <span>Exigir pago en el pre-check-in</span>
          </label>
          <label style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 6, paddingTop: 24 }}>
            <input type="checkbox" checked={config.onlineCheckOutEnabled} onChange={(e) => setConfig({ ...config, onlineCheckOutEnabled: e.target.checked })} />
            <span>Check-out online activo</span>
          </label>
          <label>Check-out cierra (h después salida)<input type="number" value={config.onlineCheckOutClosesHours} onChange={(e) => setConfig({ ...config, onlineCheckOutClosesHours: Number(e.target.value) })} /></label>
        </div>
      </article>

      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Funciones visibles para el huésped</h3></div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 8 }}>
          {[
            { key: "guestMessagingEnabled", label: "💬 Chat con la recepción" },
            { key: "showFolioBalance", label: "💳 Ver saldo y cargos del folio" },
            { key: "showInvoiceDownload", label: "📄 Descargar factura PDF" },
            { key: "showUpsells", label: "⬆ Ofertas y upgrades" },
            { key: "showLocalRecommendations", label: "🗺 Recomendaciones locales (IA)" },
            { key: "requireIdScan", label: "🪪 Escanear DNI/Pasaporte (parte de viajeros)" },
            { key: "requireSignature", label: "✍ Firma electrónica del huésped" }
          ].map(({ key, label }) => (
            <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", padding: 8, background: "var(--surface-2)", borderRadius: 6 }}>
              <input
                type="checkbox"
                checked={(config[key as keyof PortalConfig] as boolean)}
                onChange={(e) => setConfig({ ...config, [key]: e.target.checked } as PortalConfig)}
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </article>

      <p className="bo-muted" style={{ fontSize: 11, textTransform: "none" }}>
        Los datos del huésped recogidos en el portal (DNI, firma) se cifran a nivel columna en Postgres con la extensión PII y solo
        son legibles desde el backend con el rol adecuado.
      </p>
    </section>
  );
}

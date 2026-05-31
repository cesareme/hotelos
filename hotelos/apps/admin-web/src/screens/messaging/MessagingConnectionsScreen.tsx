// Conexiones de mensajería omnichannel — WhatsApp Business, SMS (Twilio), Email (SendGrid).
// Aprovecha los adapters de @hotelos/integrations/messaging creados en P1-6.

import { useState } from "react";
import { Spinner } from "../../components/States";

type Channel = "whatsapp" | "sms" | "email";

type ChannelConfig = {
  channel: Channel;
  label: string;
  description: string;
  icon: string;
  fields: Array<{ key: string; label: string; type: "text" | "password" | "phone" }>;
  mode: "stub" | "production";
  testMessage: string;
};

const CHANNELS: ChannelConfig[] = [
  {
    channel: "whatsapp",
    label: "WhatsApp Business",
    description: "Canal preferido por el huésped europeo. Requiere phone number ID y access token de Meta Business Suite. Soporta plantillas pre-aprobadas (mandatorias fuera de la service window de 24 h).",
    icon: "💬",
    fields: [
      { key: "phoneNumberId", label: "Phone Number ID (Meta)", type: "text" },
      { key: "accessToken", label: "Permanent Access Token", type: "password" },
      { key: "webhookSecret", label: "Webhook Verify Token", type: "password" }
    ],
    mode: "stub",
    testMessage: "Hola, soy HotelOS — mensaje de prueba para verificar la conexión."
  },
  {
    channel: "sms",
    label: "SMS (Twilio)",
    description: "Canal universal de fallback. Confirmaciones críticas, OTP, alertas. Cobertura 200+ países.",
    icon: "📱",
    fields: [
      { key: "accountSid", label: "Account SID", type: "text" },
      { key: "authToken", label: "Auth Token", type: "password" },
      { key: "fromNumber", label: "Número de origen (E.164)", type: "phone" }
    ],
    mode: "stub",
    testMessage: "HotelOS · prueba SMS"
  },
  {
    channel: "email",
    label: "Email (SendGrid)",
    description: "Comunicaciones formales: confirmaciones, facturas, magic links. Plantillas dinámicas + tracking de aperturas.",
    icon: "📧",
    fields: [
      { key: "apiKey", label: "API Key (SG.xxxxx)", type: "password" },
      { key: "fromEmail", label: "Email remitente", type: "text" },
      { key: "fromName", label: "Nombre remitente", type: "text" }
    ],
    mode: "stub",
    testMessage: "Prueba — HotelOS está conectado."
  }
];

export function MessagingConnectionsScreen() {
  const [activeChannel, setActiveChannel] = useState<Channel>("whatsapp");
  const [configs, setConfigs] = useState<Record<Channel, Record<string, string>>>({
    whatsapp: {},
    sms: {},
    email: {}
  });
  const [modes, setModes] = useState<Record<Channel, "stub" | "production">>({
    whatsapp: "stub",
    sms: "stub",
    email: "stub"
  });
  const [busy, setBusy] = useState<Channel | null>(null);
  const [testResult, setTestResult] = useState<Record<Channel, string | null>>({
    whatsapp: null,
    sms: null,
    email: null
  });

  const config = CHANNELS.find((c) => c.channel === activeChannel)!;
  const values = configs[activeChannel];

  function update(key: string, val: string) {
    setConfigs((prev) => ({
      ...prev,
      [activeChannel]: { ...prev[activeChannel], [key]: val }
    }));
  }

  async function testConnection() {
    setBusy(activeChannel);
    setTestResult((prev) => ({ ...prev, [activeChannel]: null }));
    // En producción esto haría POST a /messaging/connections/test
    // Por ahora simulamos basándonos en el modo y campos rellenos.
    await new Promise((r) => setTimeout(r, 700));
    const allRequired = config.fields.every((f) => modes[activeChannel] === "stub" || (values[f.key]?.length ?? 0) > 0);
    const result = !allRequired
      ? "Faltan campos. En modo producción todos son obligatorios."
      : modes[activeChannel] === "stub"
        ? "Modo stub OK — la conexión funciona en local sin claves. Cambia a producción y rellena los campos para activar el envío real."
        : "Configuración válida. El envío real requiere webhook configurado en el panel del proveedor.";
    setTestResult((prev) => ({ ...prev, [activeChannel]: result }));
    setBusy(null);
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>
            Comunicación · Conexiones
          </p>
          <h2 style={{ color: "var(--ink)" }}>Mensajería omnichannel</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Configura los proveedores. El motor enruta automáticamente cada mensaje al canal preferido del huésped
            con fallback en cascada si el primario falla.
          </p>
        </div>
      </header>

      {/* Channel tabs */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {CHANNELS.map((c) => (
          <button
            key={c.channel}
            type="button"
            onClick={() => setActiveChannel(c.channel)}
            className={activeChannel === c.channel ? "primary" : ""}
            style={{ padding: "10px 16px" }}
          >
            {c.icon} {c.label}
          </button>
        ))}
      </div>

      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>{config.icon} {config.label}</h3>
          <select value={modes[activeChannel]} onChange={(e) => setModes((m) => ({ ...m, [activeChannel]: e.target.value as "stub" | "production" }))}>
            <option value="stub">Modo stub (sin claves)</option>
            <option value="production">Modo producción</option>
          </select>
        </div>
        <p className="bo-muted" style={{ marginTop: 0, textTransform: "none" }}>{config.description}</p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12, marginTop: 12 }}>
          {config.fields.map((f) => (
            <label key={f.key} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>{f.label}</span>
              <input
                type={f.type === "password" ? "password" : "text"}
                value={values[f.key] ?? ""}
                onChange={(e) => update(f.key, e.target.value)}
                placeholder={modes[activeChannel] === "stub" ? "(opcional en stub)" : "obligatorio"}
                disabled={modes[activeChannel] === "stub"}
              />
            </label>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 16, alignItems: "center" }}>
          <button type="button" className="primary" onClick={testConnection} disabled={busy === activeChannel}>
            {busy === activeChannel ? <Spinner size="sm" /> : "Probar conexión"}
          </button>
          <button type="button" disabled={busy === activeChannel}>Guardar configuración</button>
        </div>
        {testResult[activeChannel] ? (
          <p className="bo-status info" style={{ textTransform: "none", marginTop: 8 }}>{testResult[activeChannel]}</p>
        ) : null}
      </article>

      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head">
          <h3 style={{ color: "var(--ink)" }}>Cascada de fallback</h3>
        </div>
        <p className="bo-muted" style={{ marginTop: 0, textTransform: "none" }}>
          Cuando un mensaje no se entrega por el canal primario, el motor reintenta automáticamente con el siguiente canal disponible.
          La opinión por defecto del producto:
        </p>
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
          <span className="bo-chip">💬 WhatsApp</span>
          <span style={{ color: "var(--ink-muted)" }}>→</span>
          <span className="bo-chip">📱 SMS</span>
          <span style={{ color: "var(--ink-muted)" }}>→</span>
          <span className="bo-chip">📧 Email</span>
        </div>
        <p className="bo-muted" style={{ textTransform: "none", marginTop: 8, fontSize: 12 }}>
          Cada huésped puede tener una preferencia individual (campo <code>channelPreferred</code> en su perfil) que sobrescribe el orden por defecto.
        </p>
      </article>
    </section>
  );
}

// Portal del huésped — configuración de branding, idiomas, ventanas de
// pre-check-in/check-out online, y qué funciones se ofrecen al huésped.
//
// Cocoa 22 · ola 7 · lote 7-C (hosted in VentasAdicionalesTabs, tab «Portal del
// huésped»; pilot PropertySetupForms, template Formulario): a callout with the
// public address → the upsell conversion KPI (GET /dashboards/upsells, the
// only figure that comes from the API; opens the upsells panel) → four
// CocoaFormSection with string-controlled fields and switches → CocoaActionBar.
// As before, the settings live in the page state (there is no persistence
// endpoint for the portal yet): «Guardar configuración» confirms locally.

import { useState } from "react";
import { useTabHost } from "../tabs/TabHost";
import { useApiData } from "../../hooks/useApiData";
import { getActivePropertyName, useActiveProperty } from "../../services/activeProperty";
import type { UpsellsDashboardKpis } from "../../services/upsellsApi";
import { navigateTo } from "../../lib/navigate";
import { useToast } from "../../components/Toast";
import { number, percent, plural, time } from "../../lib/format";
import { STATUS_LABELS } from "../../content/actions";
import { LockIcon } from "../../components/cocoa-icons/StatusIcons";
import {
  CocoaActionBar,
  CocoaButton,
  CocoaCallout,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaPage,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaSwitch
} from "../../components/cocoa";
import { BRAND } from "../../config/brand";

// Hours travel as strings (Cocoa inputs are string-controlled).
type PortalConfig = {
  brandName: string;
  primaryColor: string;
  logoUrl: string;
  languages: string[];
  defaultLanguage: string;
  preCheckInOpensHours: string;
  preCheckInRequiresPayment: boolean;
  onlineCheckOutEnabled: boolean;
  onlineCheckOutClosesHours: string;
  guestMessagingEnabled: boolean;
  showFolioBalance: boolean;
  showInvoiceDownload: boolean;
  showUpsells: boolean;
  showLocalRecommendations: boolean;
  requireIdScan: boolean;
  requireSignature: boolean;
  customDomain: string;
};

type FeatureKey =
  | "guestMessagingEnabled"
  | "showFolioBalance"
  | "showInvoiceDownload"
  | "showUpsells"
  | "showLocalRecommendations"
  | "requireIdScan"
  | "requireSignature";

const FEATURES: Array<{ key: FeatureKey; label: string; help?: string }> = [
  { key: "guestMessagingEnabled", label: "Chat con la recepción" },
  { key: "showFolioBalance", label: "Ver saldo y cargos del folio" },
  { key: "showInvoiceDownload", label: "Descargar factura PDF" },
  { key: "showUpsells", label: "Ofertas y upgrades" },
  { key: "showLocalRecommendations", label: "Recomendaciones locales (IA)" },
  { key: "requireIdScan", label: "Escanear DNI/Pasaporte (parte de viajeros)" },
  { key: "requireSignature", label: "Firma electrónica del huésped" }
];

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

function languageName(code: string): string {
  return AVAILABLE_LANGUAGES.find((l) => l.code === code)?.name ?? code;
}

/** Default brand colour: the app accent as painted right now (no literal colour in the screen). */
function accentColor(): string {
  if (typeof window === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue("--cocoa-accent").trim();
}

function initialConfig(): PortalConfig {
  return {
    brandName: getActivePropertyName(),
    primaryColor: accentColor(),
    logoUrl: "",
    languages: ["es", "en", "fr", "de"],
    defaultLanguage: "es",
    preCheckInOpensHours: "48",
    preCheckInRequiresPayment: false,
    onlineCheckOutEnabled: true,
    onlineCheckOutClosesHours: "0",
    guestMessagingEnabled: true,
    showFolioBalance: true,
    showInvoiceDownload: true,
    showUpsells: true,
    showLocalRecommendations: true,
    requireIdScan: true,
    requireSignature: true,
    customDomain: ""
  };
}

function publicUrlOf(config: PortalConfig): string {
  const domain = config.customDomain.trim();
  return domain || `${BRAND.guestPortalHost}/${config.brandName.toLowerCase().replace(/\s+/g, "-")}`;
}

export function GuestPortalSettingsScreen() {
  // Hosted inside a routed tab container (Tanda 5): the container paints the page header.
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const { propertyId, propertyName } = useActiveProperty();
  const [config, setConfig] = useState<PortalConfig>(initialConfig);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  // Tanda 3 · CF-02: the upsell conversion KPI comes from the real dashboard
  // (Prisma UpsellImpression / GuestUpsellPurchase, last 30 days), not a constant.
  const upsells = useApiData<{ kpis: UpsellsDashboardKpis }>("/dashboards/upsells", { query: { propertyId } });
  const upsellKpis = upsells.data?.kpis ?? null;

  function set<K extends keyof PortalConfig>(key: K, value: PortalConfig[K]) {
    setConfig((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  }

  function toggleLanguage(code: string) {
    setConfig((prev) => {
      const languages = prev.languages.includes(code) ? prev.languages.filter((l) => l !== code) : [...prev.languages, code];
      const defaultLanguage = languages.includes(prev.defaultLanguage) ? prev.defaultLanguage : languages[0] ?? "";
      return { ...prev, languages, defaultLanguage };
    });
    setDirty(true);
  }

  function save() {
    setSavedAt(new Date().toISOString());
    setDirty(false);
    showToast("Configuración guardada. Los cambios se aplican en la próxima visita al portal.", { variant: "success" });
  }

  const openUpsells = () => navigateTo("UpsellsDashboard");
  const languageOptions = config.languages.map((code) => ({ value: code, label: languageName(code) }));

  return (
    <CocoaPage
      eyebrow={`Comercial · ${propertyName}`}
      title="Portal del huésped"
      subtitle={hosted ? undefined : "Marca, idiomas, ventanas de check-in y check-out online y funciones que ve el huésped en su portal."}
      commands={[
        { id: "portal-huesped-guardar", label: "Guardar la configuración del portal", run: save, shortcut: "⌘ Enter" },
        { id: "portal-huesped-ventas", label: "Abrir el panel de ventas adicionales", run: openUpsells }
      ]}
    >
      {/* Public address (8) + the only real portal KPI (4): the upsell conversion
          comes from the API. The old pre-check-in / completion-time /
          recommendations tiles were hardcoded demo numbers (L1c: no fabricated
          figures on a hotelier's screen). */}
      <CocoaGrid aria-label="Dirección pública y resultados del portal" align="start">
        <CocoaSpan cols={8} min={480}>
          <CocoaCallout tone="info" title="Dirección pública del portal">
            <code>{publicUrlOf(config)}</code> · El huésped recibe un enlace de acceso por correo tras confirmar la reserva.
          </CocoaCallout>
        </CocoaSpan>
        <CocoaSpan cols={4} min={240}>
          {upsells.loading && !upsellKpis ? (
            <CocoaSkeleton variant="kpi" />
          ) : (
            <CocoaKpi
              label="Conversión de ofertas"
              value={upsellKpis ? percent(upsellKpis.conversionRatePct, { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : "—"}
              caption={
                upsellKpis
                  ? `${plural(upsellKpis.conversions30d, "conversión", "conversiones")} de ${plural(upsellKpis.offersShown30d, "impresión", "impresiones")} · ${plural(upsellKpis.activeOffers, "oferta activa", "ofertas activas")}`
                  : upsells.error ?? undefined
              }
              deltaLabel="últimos 30 días"
              polarity="neutral"
              status={upsells.error ? "warning" : "ok"}
              degraded={!upsellKpis}
              onClick={openUpsells}
            />
          )}
        </CocoaSpan>
      </CocoaGrid>

      <CocoaFormSection title="Identidad de marca" description="Nombre, color y logotipo con los que el huésped reconoce el portal.">
        <CocoaFormRow columns={2}>
          <CocoaField label="Nombre de marca">
            <CocoaInput value={config.brandName} onChange={(v) => set("brandName", v)} autoComplete="organization" />
          </CocoaField>
          <CocoaField label="Color primario">
            <CocoaInput type="color" value={config.primaryColor} onChange={(v) => set("primaryColor", v)} />
          </CocoaField>
          <CocoaField label="URL del logo (PNG / SVG)">
            <CocoaInput value={config.logoUrl} onChange={(v) => set("logoUrl", v)} type="url" inputMode="url" placeholder="https://…" />
          </CocoaField>
          <CocoaField label="Dominio personalizado" hint={STATUS_LABELS.optional}>
            <CocoaInput value={config.customDomain} onChange={(v) => set("customDomain", v)} inputMode="url" placeholder="huesped.mihotel.com" />
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaFormSection title={`Idiomas (${number(config.languages.length)})`} description="Idiomas en los que se ofrece el portal y el que se muestra por defecto.">
        <CocoaFormRow columns={2}>
          <CocoaField label="Idiomas disponibles" fullWidth>
            <div className="cocoa-cluster" role="group" aria-label="Idiomas disponibles">
              {AVAILABLE_LANGUAGES.map((l) => {
                const selected = config.languages.includes(l.code);
                return (
                  <CocoaButton
                    key={l.code}
                    variant={selected ? "tinted" : "bordered"}
                    tone={selected ? "accent" : "neutral"}
                    size="small"
                    aria-pressed={selected}
                    onClick={() => toggleLanguage(l.code)}
                  >
                    {l.name} · {l.code}
                  </CocoaButton>
                );
              })}
            </div>
          </CocoaField>
          <CocoaField label="Idioma por defecto" help={config.languages.length === 0 ? "Selecciona al menos un idioma." : undefined}>
            <CocoaSelect value={config.defaultLanguage} onChange={(v) => set("defaultLanguage", v)} options={languageOptions} disabled={config.languages.length === 0} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaFormSection title="Ventanas de check-in y check-out" description="Cuándo puede el huésped hacer el pre check-in y el check-out online.">
        <CocoaFormRow columns={2}>
          <CocoaField label="Pre check-in abre (h antes llegada)">
            <CocoaInput value={config.preCheckInOpensHours} onChange={(v) => set("preCheckInOpensHours", v)} inputMode="numeric" />
          </CocoaField>
          <CocoaField label="Exigir pago en el pre-check-in" inline>
            <CocoaSwitch checked={config.preCheckInRequiresPayment} onChange={(v) => set("preCheckInRequiresPayment", v)} size="small" />
          </CocoaField>
          <CocoaField label="Check-out online activo" inline>
            <CocoaSwitch checked={config.onlineCheckOutEnabled} onChange={(v) => set("onlineCheckOutEnabled", v)} size="small" />
          </CocoaField>
          <CocoaField label="Check-out cierra (h después salida)">
            <CocoaInput value={config.onlineCheckOutClosesHours} onChange={(v) => set("onlineCheckOutClosesHours", v)} inputMode="numeric" disabled={!config.onlineCheckOutEnabled} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaFormSection title="Funciones visibles para el huésped" description="Qué puede hacer el huésped desde el portal.">
        <CocoaFormRow columns={2}>
          {FEATURES.map((feature) => (
            <CocoaField key={feature.key} label={feature.label} inline help={feature.help}>
              <CocoaSwitch checked={config[feature.key]} onChange={(v) => set(feature.key, v)} size="small" />
            </CocoaField>
          ))}
        </CocoaFormRow>
      </CocoaFormSection>

      <CocoaCallout tone="neutral" icon={<LockIcon size={16} aria-hidden="true" />}>
        Los datos del huésped recogidos en el portal (DNI, firma) se cifran a nivel columna en Postgres con la extensión PII y solo son legibles desde el
        backend con el rol adecuado.
      </CocoaCallout>

      <CocoaActionBar
        aria-label="Acciones del portal del huésped"
        status={dirty ? "Cambios sin guardar" : savedAt ? `${STATUS_LABELS.saved} a las ${time(savedAt)}` : undefined}
        primary={{ label: "Guardar configuración", onClick: save }}
        publishToastOffset
      />
    </CocoaPage>
  );
}

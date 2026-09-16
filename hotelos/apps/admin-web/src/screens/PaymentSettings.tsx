// Pagos — Configuración › Facturación y pagos › Pagos
// (/configuracion/facturacion-pagos/pagos, hosted in FacturacionPagosTabs).
// Cocoa 22 · ola 10 · lote 10-D, archetype «formulario / ajustes»
// (docs/design/COCOA-22.md §4): CocoaPage (hosted: the container paints eyebrow
// and title) → CocoaSection with the CocoaTable of the real integrations of
// the property (GET /backoffice/properties/:id/integrations) filtered to
// payment providers; without a connected PSP the gateway is declared «no
// configurada» (badge + callout) and the empty state links to the catalogue
// → two CocoaSection panels (refund policy · charges and reconciliation).
// Nothing is edited here: providers are connected from the catalogue.
import { useCallback, useEffect, useMemo, useState } from "react";
import { getActivePropertyId } from "../services/activeProperty";
import { fetchPropertyIntegrations, isPaymentIntegration, type PropertyIntegration } from "../services/billingApi";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaGrid,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../components/cocoa";
import { toArray } from "../utils/toArray";
import { navigateTo } from "../lib/navigate";
import { EMPTY, dateTime, plural } from "../lib/format";
import { treeHeaderFor } from "./tabs/tab-helpers";

const PROPERTY_ID = getActivePropertyId();

const STATUS_META: Record<PropertyIntegration["status"], { label: string; tone: CocoaTone }> = {
  connected: { label: "Conectado", tone: "success" },
  testing: { label: "En pruebas", tone: "warning" },
  error: { label: "Error", tone: "danger" },
  disconnected: { label: "Desconectado", tone: "neutral" }
};

const INTEGRATION_COLUMNS: CocoaTableColumn<PropertyIntegration>[] = [
  { key: "provider", label: "Proveedor", render: (row) => <strong>{row.provider?.name ?? row.providerId}</strong> },
  { key: "code", label: "Código", fit: true, hideOnNarrow: true, render: (row) => <span className="cocoa-mono">{row.provider?.code ?? EMPTY}</span> },
  {
    key: "status",
    label: "Estado",
    fit: true,
    render: (row) => {
      const meta = STATUS_META[row.status] ?? { label: row.status, tone: "neutral" as CocoaTone };
      return <CocoaBadge tone={meta.tone}>{meta.label}</CocoaBadge>;
    }
  },
  { key: "auth", label: "Autenticación", fit: true, hideOnNarrow: true, render: (row) => row.provider?.authType ?? EMPTY },
  { key: "lastSyncAt", label: "Última sincronización", fit: true, hideOnNarrow: true, render: (row) => dateTime(row.lastSyncAt) }
];

function openCatalog() {
  navigateTo("MarketplaceCatalog");
}

export function PaymentSettings() {
  const header = treeHeaderFor("PaymentSettings", { eyebrow: "Finanzas y cumplimiento", title: "Pagos" });
  const [integrations, setIntegrations] = useState<PropertyIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setIntegrations(toArray<PropertyIntegration>(await fetchPropertyIntegrations(PROPERTY_ID)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las integraciones de pago.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const paymentIntegrations = useMemo(() => integrations.filter(isPaymentIntegration), [integrations]);
  const otherCount = integrations.length - paymentIntegrations.length;
  const connectedCount = paymentIntegrations.filter((integration) => integration.status === "connected").length;
  const gatewayReady = connectedCount > 0;

  return (
    <CocoaPage
      eyebrow={header.eyebrow}
      title={header.title}
      subtitle="Proveedores de pago (PSP) conectados a la propiedad, tokenización y política de reembolsos"
      actions={
        <CocoaButton variant="filled" tone="accent" onClick={openCatalog}>
          Catálogo de integraciones
        </CocoaButton>
      }
      state={loading && integrations.length === 0 && !error ? "loading" : error && integrations.length === 0 ? "error" : "ready"}
      skeleton={<CocoaSkeleton.Grid rows={[[12], [6, 6]]} height={140} label="Cargando proveedores de pago…" />}
      error={{ title: "No se pudieron cargar las integraciones", message: error ?? undefined, onRetry: () => void load() }}
      commands={[
        { id: "payment-settings-catalog", label: "Abrir el catálogo de integraciones", run: openCatalog },
        { id: "payment-settings-refresh", label: "Actualizar los proveedores de pago", run: () => void load() }
      ]}
      id="payment-settings"
    >
      <CocoaSection
        title="Proveedores de pago"
        meta={<CocoaBadge tone={gatewayReady ? "success" : "warning"}>{gatewayReady ? plural(connectedCount, "conectado", "conectados") : "Pasarela no configurada"}</CocoaBadge>}
        padding={paymentIntegrations.length > 0 ? "none" : "md"}
        style={{ overflow: "clip" }}
      >
        {paymentIntegrations.length === 0 ? (
          <CocoaState
            kind="empty"
            dashed
            title="Ningún PSP conectado"
            message={`Esta propiedad no tiene ningún proveedor de pago conectado${otherCount > 0 ? ` (hay ${plural(otherCount, "integración", "integraciones")} de otras categorías)` : ""}. Los cobros con tarjeta, los enlaces de pago y las tarjetas virtuales de OTA requieren un PSP.`}
            primaryAction={{ label: "Conectar un proveedor", onClick: openCatalog }}
          />
        ) : (
          <CocoaTable<PropertyIntegration>
            columns={INTEGRATION_COLUMNS}
            rows={paymentIntegrations}
            rowKey="id"
            caption="Proveedores de pago de la propiedad"
            aria-label="Proveedores de pago de la propiedad"
            emptyState="Sin proveedores de pago."
          />
        )}
      </CocoaSection>

      {paymentIntegrations.length > 0 && !gatewayReady ? (
        <CocoaCallout
          tone="warning"
          title="Pasarela de pago no configurada"
          role="status"
          actions={
            <CocoaButton variant="plain" size="small" onClick={openCatalog}>
              Catálogo de integraciones
            </CocoaButton>
          }
        >
          Hay proveedores de pago dados de alta, pero ninguno está conectado: los cobros con tarjeta, los enlaces de pago y las tarjetas virtuales de OTA no
          están operativos hasta que uno pase a «Conectado».
        </CocoaCallout>
      ) : null}

      <CocoaGrid aria-label="Reembolsos, cobros y conciliación">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Política de reembolsos"
            action={
              <CocoaButton variant="plain" size="small" onClick={() => navigateTo("UserRoleManager")}>
                Usuarios y roles
              </CocoaButton>
            }
          >
            <p className="cocoa-note">
              Los reembolsos requieren aprobación de un responsable y nunca almacenan datos de tarjeta en claro: solo el token del PSP y la referencia del
              cobro. Los permisos de aprobación se gestionan en Usuarios y roles.
            </p>
          </CocoaSection>
        </CocoaSpan>
        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Cobros y conciliación"
            action={
              <CocoaButton variant="plain" size="small" onClick={() => navigateTo("BillingCenter")}>
                Centro de facturación
              </CocoaButton>
            }
          >
            <p className="cocoa-note">
              Los cobros capturados se registran en el folio de la reserva y se concilian con el banco desde el módulo de conciliación bancaria.
            </p>
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>
    </CocoaPage>
  );
}

export default PaymentSettings;

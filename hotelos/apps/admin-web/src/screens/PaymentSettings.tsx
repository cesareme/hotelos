// Ajustes de pagos (Tanda 3 · lote front-fiscal).
//
// Lista las integraciones reales de la propiedad (GET
// /backoffice/properties/:id/integrations) filtradas a proveedores de pago.
// Sin PSP conectado se muestra un estado vacío honesto con enlace al catálogo.
import { useCallback, useEffect, useMemo, useState } from "react";
import { getActivePropertyId } from "../services/activeProperty";
import { fetchPropertyIntegrations, isPaymentIntegration, type PropertyIntegration } from "../services/billingApi";
import { EmptyState, ErrorState, LoadingBlock } from "../components/States";
import { CocoaPageHeader } from "../components/cocoa/CocoaPageHeader";
import { CocoaCard } from "../components/cocoa/CocoaCard";
import { CocoaButton } from "../components/cocoa/CocoaButton";
import { CocoaTable, type CocoaTableColumn } from "../components/cocoa/CocoaTable";
import { toArray } from "../utils/toArray";
import { navigateTo } from "../lib/navigate";

const PROPERTY_ID = getActivePropertyId();

const STATUS_META: Record<PropertyIntegration["status"], { label: string; tone: string }> = {
  connected: { label: "Conectado", tone: "ok" },
  testing: { label: "En pruebas", tone: "warn" },
  error: { label: "Error", tone: "error" },
  disconnected: { label: "Desconectado", tone: "info" }
};

export function PaymentSettings() {
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

  const columns = useMemo<CocoaTableColumn<PropertyIntegration>[]>(
    () => [
      { key: "provider", label: "Proveedor", render: (row) => <strong>{row.provider?.name ?? row.providerId}</strong> },
      { key: "code", label: "Código", render: (row) => <code>{row.provider?.code ?? "—"}</code> },
      {
        key: "status",
        label: "Estado",
        width: "130px",
        render: (row) => {
          const meta = STATUS_META[row.status] ?? { label: row.status, tone: "info" };
          return <span className={`bo-status ${meta.tone}`} style={{ textTransform: "none" }}>{meta.label}</span>;
        }
      },
      { key: "auth", label: "Autenticación", width: "130px", render: (row) => row.provider?.authType ?? "—" },
      { key: "lastSyncAt", label: "Última sincronización", width: "170px", render: (row) => (row.lastSyncAt ? new Date(row.lastSyncAt).toLocaleString("es-ES") : "—") }
    ],
    []
  );

  if (loading && integrations.length === 0 && !error) {
    return (
      <section className="bo-card">
        <LoadingBlock label="Cargando proveedores de pago…" />
      </section>
    );
  }
  if (error && integrations.length === 0) {
    return (
      <section className="bo-card">
        <ErrorState title="No se pudieron cargar las integraciones" message={error} onRetry={() => void load()} />
      </section>
    );
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-5)" }}>
      <CocoaPageHeader
        eyebrow="Finanzas y cumplimiento"
        title="Pagos"
        subtitle="Proveedores de pago (PSP) conectados a la propiedad, tokenización y política de reembolsos"
        actions={
          <CocoaButton variant="filled" tone="accent" onClick={() => navigateTo("MarketplaceCatalog")}>
            Catálogo de integraciones
          </CocoaButton>
        }
      />

      <div>
        <div className="bo-card-head">
          <h3 style={{ margin: 0 }}>Proveedores de pago</h3>
          <span className={`bo-status ${paymentIntegrations.some((integration) => integration.status === "connected") ? "ok" : "warn"}`} style={{ textTransform: "none" }}>
            {paymentIntegrations.filter((integration) => integration.status === "connected").length} conectado
            {paymentIntegrations.filter((integration) => integration.status === "connected").length === 1 ? "" : "s"}
          </span>
        </div>
        {paymentIntegrations.length === 0 ? (
          <EmptyState
            title="Ningún PSP conectado"
            message={`Esta propiedad no tiene ningún proveedor de pago conectado${otherCount > 0 ? ` (hay ${otherCount} integración${otherCount === 1 ? "" : "es"} de otras categorías)` : ""}. Los cobros con tarjeta, los enlaces de pago y las tarjetas virtuales de OTA requieren un PSP.`}
            actions={
              <CocoaButton variant="filled" tone="accent" onClick={() => navigateTo("MarketplaceCatalog")}>
                Conectar un proveedor
              </CocoaButton>
            }
          />
        ) : (
          <CocoaTable<PropertyIntegration> columns={columns} rows={paymentIntegrations} rowKey="id" emptyState="Sin proveedores de pago." />
        )}
      </div>

      <div className="bo-grid two">
        <CocoaCard variant="bordered" padding="md">
          <h3 style={{ marginTop: 0 }}>Política de reembolsos</h3>
          <p className="bo-muted" style={{ margin: 0 }}>
            Los reembolsos requieren aprobación de un responsable y nunca almacenan datos de tarjeta en claro: solo el token del PSP y la
            referencia del cobro. Los permisos de aprobación se gestionan en Usuarios y roles.
          </p>
          <div className="bo-actions">
            <CocoaButton variant="plain" size="small" onClick={() => navigateTo("UserRoleManager")}>
              Usuarios y roles
            </CocoaButton>
          </div>
        </CocoaCard>
        <CocoaCard variant="bordered" padding="md">
          <h3 style={{ marginTop: 0 }}>Cobros y conciliación</h3>
          <p className="bo-muted" style={{ margin: 0 }}>
            Los cobros capturados se registran en el folio de la reserva y se concilian con el banco desde el módulo de conciliación bancaria.
          </p>
          <div className="bo-actions">
            <CocoaButton variant="plain" size="small" onClick={() => navigateTo("BillingCenter")}>
              Centro de facturación
            </CocoaButton>
          </div>
        </CocoaCard>
      </div>
    </section>
  );
}

export default PaymentSettings;

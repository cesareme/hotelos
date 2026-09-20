// Pagos — Configuración › Facturación y pagos › Pagos
// (/configuracion/facturacion-pagos/pagos, hosted in FacturacionPagosTabs).
// Cocoa 22 · ola 10 · lote 10-D, archetype «formulario / ajustes»
// (docs/design/COCOA-22.md §4): CocoaPage (hosted: the container paints eyebrow
// and title) → CocoaSection «Pasarela de pago (PSP)» → CocoaSection with the
// legacy hub connections → two CocoaSection panels (refund policy · charges
// and reconciliation). Nothing is edited here: PSP credentials live in the
// server contract (Stripe or Redsys variables), never in this screen.
//
// Tanda L8 · L8-07 (honest copy, audit A1): the gateway state comes from
// GET /integrations/status (services/integrationsApi.ts of L8-06; row `psp`,
// derived by the API from pspStatusFor: configured · mode `none | sandbox |
// real` · message · missingForReal) and never from the legacy hub. The hub rows (GET /backoffice/properties/:id/
// integrations, payment providers only) are a secondary section «Conexiones
// de demostración (catálogo heredado)»: demo providers that never charge.
// Only a real PSP without pending requirements paints a green badge; without
// a real PSP the section repeats the psp-status message and what is missing.
import { useCallback, useEffect, useMemo, useState } from "react";
import { INTEGRATION_MODE_LABELS_ES, type IntegrationMode, type IntegrationStatusDto } from "@hotelos/shared";
import { getActivePropertyId } from "../services/activeProperty";
import { fetchPropertyIntegrations, isPaymentIntegration, pspIntegrationStatus, type PropertyIntegration } from "../services/billingApi";
import { fetchIntegrationsStatus } from "../services/integrationsApi";
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

/** Hub statuses read as catalogue facts, never as a working gateway: no success tone here. */
const HUB_STATUS_META: Record<PropertyIntegration["status"], { label: string; tone: CocoaTone }> = {
  connected: { label: "Alta en el catálogo", tone: "neutral" },
  testing: { label: "En pruebas", tone: "warning" },
  error: { label: "Error", tone: "danger" },
  disconnected: { label: "Desconectada", tone: "neutral" }
};

/** Tone per declared mode: green only in `real` (contract integrations-status-types.ts). */
const MODE_TONE: Record<IntegrationMode, CocoaTone> = { none: "neutral", sandbox: "warning", real: "success" };

/** Badge of the gateway from the psp row; unknown state never reads as ready. */
function gatewayBadge(psp: IntegrationStatusDto | null, failed: boolean): { label: string; tone: CocoaTone } {
  if (!psp) return { label: failed ? "Estado no disponible" : "Comprobando…", tone: "neutral" };
  if (psp.mode === "real" && !psp.readyForReal) return { label: "Real · con requisitos pendientes", tone: "warning" };
  return { label: INTEGRATION_MODE_LABELS_ES[psp.mode], tone: MODE_TONE[psp.mode] };
}

const HUB_COLUMNS: CocoaTableColumn<PropertyIntegration>[] = [
  { key: "provider", label: "Proveedor", render: (row) => <strong>{row.provider?.name ?? row.providerId}</strong> },
  { key: "code", label: "Código", fit: true, hideOnNarrow: true, render: (row) => <span className="cocoa-mono">{row.provider?.code ?? EMPTY}</span> },
  {
    key: "status",
    label: "Estado en el catálogo",
    fit: true,
    render: (row) => {
      const meta = HUB_STATUS_META[row.status] ?? { label: row.status, tone: "neutral" as CocoaTone };
      if (!row.provider?.demo) return <CocoaBadge tone={meta.tone}>{meta.label}</CocoaBadge>;
      // A demo connection still shows its persisted state when it needs attention (corrector L8 · REV-04).
      const attention = row.status === "error" || row.status === "disconnected";
      return (
        <span className="cocoa-row" data-gap="1">
          <CocoaBadge tone="neutral">Demostración · no cobra</CocoaBadge>
          {attention ? (
            <CocoaBadge tone={meta.tone} size="small">
              {meta.label}
            </CocoaBadge>
          ) : null}
        </span>
      );
    }
  },
  { key: "auth", label: "Autenticación", fit: true, hideOnNarrow: true, render: (row) => row.provider?.authType ?? EMPTY },
  { key: "lastSyncAt", label: "Última sincronización", fit: true, hideOnNarrow: true, render: (row) => dateTime(row.lastSyncAt) }
];

function openIntegrations() {
  navigateTo("MarketplaceCatalog");
}

export function PaymentSettings() {
  const header = treeHeaderFor("PaymentSettings", { eyebrow: "Finanzas y cumplimiento", title: "Pagos" });
  const [psp, setPsp] = useState<IntegrationStatusDto | null>(null);
  const [pspError, setPspError] = useState<string | null>(null);
  const [integrations, setIntegrations] = useState<PropertyIntegration[]>([]);
  const [hubError, setHubError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [status, hub] = await Promise.allSettled([fetchIntegrationsStatus(PROPERTY_ID), fetchPropertyIntegrations(PROPERTY_ID)]);
    if (status.status === "fulfilled") {
      const row = pspIntegrationStatus(status.value);
      setPsp(row);
      setPspError(row ? null : "La respuesta del estado de integraciones no incluye la pasarela de pago.");
    } else {
      setPsp(null);
      setPspError(status.reason instanceof Error ? status.reason.message : "No se pudo leer el estado de la pasarela de pago.");
    }
    if (hub.status === "fulfilled") {
      setIntegrations(toArray<PropertyIntegration>(hub.value));
      setHubError(null);
    } else {
      setHubError(hub.reason instanceof Error ? hub.reason.message : "No se pudieron cargar las conexiones del catálogo heredado.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hubRows = useMemo(() => integrations.filter(isPaymentIntegration), [integrations]);
  const badge = gatewayBadge(psp, pspError !== null);
  const nothingLoaded = psp === null && integrations.length === 0;
  const bothFailed = pspError !== null && hubError !== null;

  return (
    <CocoaPage
      eyebrow={header.eyebrow}
      title={header.title}
      subtitle="Pasarela de cobro en línea (PSP) de la propiedad: estado real, modo y qué falta para cobrar; política de reembolsos y conciliación"
      actions={
        <CocoaButton variant="filled" tone="accent" onClick={openIntegrations}>
          Integraciones
        </CocoaButton>
      }
      state={loading && nothingLoaded ? "loading" : bothFailed && nothingLoaded ? "error" : "ready"}
      skeleton={<CocoaSkeleton.Grid rows={[[12], [12], [6, 6]]} height={140} label="Cargando el estado de la pasarela de pago…" />}
      error={{ title: "No se pudo cargar el estado de pagos", message: pspError ?? undefined, onRetry: () => void load() }}
      commands={[
        { id: "payment-settings-integrations", label: "Abrir Integraciones", run: openIntegrations },
        { id: "payment-settings-refresh", label: "Actualizar el estado de la pasarela de pago", run: () => void load() }
      ]}
      id="payment-settings"
    >
      <CocoaSection title="Pasarela de pago (PSP)" meta={<CocoaBadge tone={badge.tone}>{badge.label}</CocoaBadge>} aria-label="Estado de la pasarela de pago">
        {psp ? (
          <div className="cocoa-stack" data-gap="3">
            <p>{psp.message}</p>
            {psp.lastError ? (
              <CocoaCallout tone="danger" title="Último error registrado">
                {psp.lastError}
              </CocoaCallout>
            ) : null}
            {psp.missingForReal.length > 0 ? (
              <CocoaCallout tone={psp.mode === "none" ? "neutral" : "warning"} title="Qué falta para cobrar en real">
                <ul className="c22-section__list" aria-label="Requisitos pendientes">
                  {psp.missingForReal.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </CocoaCallout>
            ) : null}
            <p className="cocoa-note">
              Última actividad: {psp.lastActivityAt ? dateTime(psp.lastActivityAt) : "sin actividad registrada"}. Las credenciales del PSP (Stripe o Redsys) se
              configuran en el servidor y no se editan desde esta pantalla.
            </p>
          </div>
        ) : pspError ? (
          <CocoaState kind="error" inline title="Estado de la pasarela no disponible" message={pspError} onRetry={() => void load()} />
        ) : (
          <CocoaState kind="loading" inline />
        )}
      </CocoaSection>

      <CocoaSection
        title="Conexiones de demostración (catálogo heredado)"
        meta={hubRows.length > 0 ? plural(hubRows.length, "conexión", "conexiones") : undefined}
        action={
          <CocoaButton variant="plain" size="small" onClick={openIntegrations}>
            Integraciones
          </CocoaButton>
        }
        padding={hubRows.length > 0 ? "none" : "md"}
        style={{ overflow: "clip" }}
        footer={
          <p className="cocoa-note">
            Estas conexiones vienen del catálogo heredado de integraciones: son de demostración y no cobran. La pasarela real es la del bloque «Pasarela de pago
            (PSP)».
          </p>
        }
        aria-label="Conexiones de demostración del catálogo heredado"
      >
        {hubError ? (
          <CocoaState kind="error" inline title="No se pudieron cargar las conexiones del catálogo" message={hubError} onRetry={() => void load()} />
        ) : loading && integrations.length === 0 ? (
          <CocoaTable<PropertyIntegration> columns={HUB_COLUMNS} rows={[]} loading aria-label="Conexiones de demostración" />
        ) : hubRows.length === 0 ? (
          <CocoaState kind="empty" inline title="Sin conexiones de pago en el catálogo heredado" message="No hay proveedores de pago dados de alta en el catálogo; no afecta a la pasarela real." />
        ) : (
          <CocoaTable<PropertyIntegration>
            columns={HUB_COLUMNS}
            rows={hubRows}
            rowKey="id"
            caption="Conexiones de demostración del catálogo heredado"
            aria-label="Conexiones de demostración del catálogo heredado"
            emptyState="Sin conexiones de pago en el catálogo heredado."
          />
        )}
      </CocoaSection>

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

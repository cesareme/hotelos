// Checklist de puesta en marcha (Tanda 3 · lote front-fiscal).
//
// Readiness REAL: GET /backoffice/properties/:id/readiness (checks persistidos
// en Prisma) + POST …/readiness/recalculate. Cada check se pinta con su estado
// y severidad del servidor; los códigos nuevos de la Tanda 3 (impuestos, software
// VeriFactu, establecimiento SES…) caen en una etiqueta genérica hasta que se
// añadan aquí. Sin semáforos inventados.
import { useCallback, useEffect, useMemo, useState } from "react";
import { getActivePropertyId } from "../services/activeProperty";
import { ApiError } from "../services/api-client";
import { fetchPropertyReadiness, recalculatePropertyReadiness, type PropertyReadiness, type ReadinessCheck } from "../services/billingApi";
import { useToast } from "../components/Toast";
import { EmptyState, ErrorState, LoadingBlock } from "../components/States";
import { CocoaPageHeader } from "../components/cocoa/CocoaPageHeader";
import { CocoaButton } from "../components/cocoa/CocoaButton";
import { toArray } from "../utils/toArray";
import { navigateTo, type ScreenKey } from "../lib/navigate";

const PROPERTY_ID = getActivePropertyId();

const CHECK_META: Record<string, { label: string; screen?: ScreenKey }> = {
  legal_profile_complete: { label: "Perfil legal del establecimiento (razón social, NIF, dirección, región fiscal, zona horaria)", screen: "PropertyProfileSetupForm" },
  default_building_exists: { label: "Al menos un edificio activo", screen: "BuildingSetupForm" },
  room_type_exists: { label: "Al menos un tipo de habitación activo", screen: "RoomTypeSetupForm" },
  sellable_room_exists: { label: "Al menos una habitación vendible activa con tipo asignado", screen: "RoomSetupForm" },
  admin_user_exists: { label: "Al menos un usuario administrador o responsable activo", screen: "UserRoleManager" },
  invoice_sequence_configured: { label: "Serie de facturación activa (módulo Facturación y cumplimiento)", screen: "BillingSettings" },
  payment_provider_connected: { label: "Proveedor de pago conectado (módulo Payment Vault)", screen: "PaymentSettings" },
  ses_hospedajes_credentials: { label: "Credenciales SES.HOSPEDAJES (cumplimiento España activado)", screen: "SesHospedajesSettings" },
  ses_establishment_complete: { label: "Datos del establecimiento para SES.HOSPEDAJES (INE, código postal, registro turístico)", screen: "SesHospedajesSettings" },
  tax_region_configured: { label: "Región fiscal canónica y tipos de impuesto vigentes", screen: "TaxComplianceSettings" },
  taxes_configured: { label: "Tipos de impuesto vigentes para alojamiento, restauración y servicios", screen: "TaxComplianceSettings" },
  tax_catalog_provisioned: { label: "Catálogo fiscal provisionado", screen: "TaxComplianceSettings" },
  ipsi_ordinance_confirmed: { label: "Tipos IPSI confirmados con la ordenanza vigente", screen: "TaxComplianceSettings" },
  verifactu_software_configured: { label: "Bloque SistemaInformatico de VeriFactu (NIF del productor, versión, instalación)", screen: "FiscalDashboard" },
  issuer_tax_id_valid: { label: "NIF del emisor válido para VeriFactu", screen: "PropertyProfileSetupForm" }
};

function humanize(code: string): string {
  return code.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function statusMeta(check: ReadinessCheck): { label: string; tone: string } {
  if (check.status === "pass") return { label: "Correcto", tone: "ok" };
  if (check.status === "warning") return { label: "Atención", tone: "warn" };
  return check.severity === "blocking" ? { label: "Bloqueante", tone: "error" } : { label: "Pendiente", tone: "warn" };
}

export function GoLiveChecklist() {
  const { showToast } = useToast();
  const [readiness, setReadiness] = useState<PropertyReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recalculating, setRecalculating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReadiness(await fetchPropertyReadiness(PROPERTY_ID));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo cargar el estado de preparación.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRecalculate() {
    setRecalculating(true);
    try {
      const next = await recalculatePropertyReadiness(PROPERTY_ID);
      setReadiness(next);
      showToast(next.status === "ready" ? "Readiness recalculado: la propiedad está lista." : `Readiness recalculado: ${next.blockingCount} bloqueante${next.blockingCount === 1 ? "" : "s"}.`, {
        variant: next.status === "ready" ? "success" : "info"
      });
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 403
          ? "No tienes permiso para recalcular el readiness (property.configure)."
          : err instanceof Error
            ? err.message
            : "No se pudo recalcular.";
      showToast(message, { variant: "error" });
    } finally {
      setRecalculating(false);
    }
  }

  const checks = useMemo(() => toArray<ReadinessCheck>(readiness?.checks), [readiness]);
  const lastUpdated = useMemo(() => {
    const stamps = checks.map((check) => check.updatedAt ?? check.createdAt).filter((value): value is string => Boolean(value));
    if (stamps.length === 0) return null;
    return stamps.sort().at(-1) ?? null;
  }, [checks]);
  const blocking = checks.filter((check) => check.severity === "blocking" && check.status !== "pass");

  if (loading && !readiness) {
    return (
      <section className="bo-card">
        <LoadingBlock label="Cargando checklist de puesta en marcha…" />
      </section>
    );
  }
  if (error && !readiness) {
    return (
      <section className="bo-card">
        <ErrorState title="No se pudo cargar el readiness" message={error} onRetry={() => void load()} />
      </section>
    );
  }

  const headerTone = checks.length === 0 ? "info" : readiness?.status === "ready" ? "ok" : "error";
  const headerLabel =
    checks.length === 0 ? "Sin calcular" : readiness?.status === "ready" ? "Lista para go-live" : `${blocking.length} bloqueante${blocking.length === 1 ? "" : "s"}`;

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-5)" }}>
      <CocoaPageHeader
        eyebrow="Back Office · Puesta en marcha"
        title="Checklist de go-live"
        subtitle={lastUpdated ? `Última comprobación: ${new Date(lastUpdated).toLocaleString("es-ES")}` : "Aún no se ha calculado el readiness de esta propiedad"}
        actions={
          <span style={{ display: "inline-flex", gap: "var(--cocoa-space-2)", alignItems: "center", flexWrap: "wrap" }}>
            <span className={`bo-status ${headerTone}`} style={{ textTransform: "none" }}>
              {headerLabel}
            </span>
            <CocoaButton variant="filled" tone="accent" onClick={() => void handleRecalculate()} disabled={recalculating} loading={recalculating}>
              Recalcular readiness
            </CocoaButton>
            {/* OnboardingGoLiveReadiness now aliases this very screen, so the
                secondary action points at the cutover step that follows it. */}
            <CocoaButton variant="bordered" tone="neutral" onClick={() => navigateTo("CutoverAssistant")}>
              Asistente de cutover
            </CocoaButton>
          </span>
        }
      />

      {checks.length === 0 ? (
        <EmptyState
          title="Readiness sin calcular"
          message="La propiedad no tiene comprobaciones persistidas. Pulsa «Recalcular readiness» para evaluar perfil legal, estructura, usuarios, facturación, pagos y cumplimiento."
          actions={
            <CocoaButton variant="filled" tone="accent" onClick={() => void handleRecalculate()} disabled={recalculating} loading={recalculating}>
              Recalcular ahora
            </CocoaButton>
          }
        />
      ) : (
        <ul className="bo-list" style={{ margin: 0, padding: 0, listStyle: "none" }}>
          {checks.map((check) => {
            const meta = CHECK_META[check.checkCode];
            const status = statusMeta(check);
            return (
              <li className="bo-row" key={check.id ?? check.checkCode} style={{ gap: "var(--cocoa-space-3)", alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ flex: "1 1 320px", display: "grid", gap: 2 }}>
                  <strong>{meta?.label ?? humanize(check.checkCode)}</strong>
                  <small className="bo-muted" title={check.checkCode}>
                    {check.message}
                    {check.severity === "blocking" ? " · bloquea el go-live" : check.severity === "warning" ? " · recomendado" : ""}
                  </small>
                </span>
                <span className={`bo-status ${status.tone}`} style={{ textTransform: "none" }}>
                  {status.label}
                </span>
                {meta?.screen ? (
                  <CocoaButton variant="plain" size="small" onClick={() => navigateTo(meta.screen as ScreenKey)}>
                    {check.status === "pass" ? "Revisar" : "Configurar"}
                  </CocoaButton>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <p className="bo-muted" style={{ margin: 0 }}>
        La aprobación de go-live recalcula todos los checks y se bloquea si queda algún bloqueante; los checks de módulos desactivados pasan automáticamente.
      </p>
    </section>
  );
}

export default GoLiveChecklist;

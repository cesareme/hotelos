// Checklist de puesta en marcha (Tanda 3 · lote front-fiscal).
//
// Readiness REAL: GET /backoffice/properties/:id/readiness (checks persistidos
// en Prisma) + POST …/readiness/recalculate. Cada check se pinta con su estado
// y severidad del servidor; los códigos nuevos de la Tanda 3 (impuestos, software
// VeriFactu, establecimiento SES…) caen en una etiqueta genérica hasta que se
// añadan aquí. Sin semáforos inventados.
//
// Cocoa 22 · ola 10 · lote 10-C (wizard/checklist archetype): CocoaPage with the
// readiness badge and «Recalcular preparación» in the head → one section with a
// CocoaChart.Progress and the checks as an `ol.c22-section__list` (dot badge by
// state, the first pending check is `aria-current="step"`, «Configurar» per row).
// qa#14: every check message goes through lib/format readinessMessage() (the API
// still names environment variables, «sandbox» and «stub»); the raw text stays
// in `title` for support. Every current check code has a Spanish label and the
// screen that fixes it; environment-level checks offer «Ver estado» instead of
// «Configurar». The head button keeps «Recalcular preparación» («readiness» left the
// visible copy at the Tanda C close; tests/backoffice-contract.test.mjs pins the label).
import { useCallback, useEffect, useMemo, useState } from "react";
import { getActivePropertyId } from "../services/activeProperty";
import { ApiError } from "../services/api-client";
import { fetchPropertyReadiness, recalculatePropertyReadiness, type PropertyReadiness, type ReadinessCheck } from "../services/billingApi";
import { useToast } from "../components/Toast";
import { toArray } from "../utils/toArray";
import { navigateTo, type ScreenKey } from "../lib/navigate";
import { dateTime, plural, readinessMessage } from "../lib/format";
import { useTabHost } from "./tabs/TabHost";
import { treeHeaderFor } from "./tabs/tab-helpers";
import { CocoaBadge, CocoaButton, CocoaChart, CocoaPage, CocoaSection, CocoaSkeleton, CocoaState, type CocoaTone } from "../components/cocoa";

const PROPERTY_ID = getActivePropertyId();

const HEADER = treeHeaderFor("GoLiveChecklist", { eyebrow: "Configuración · Puesta en marcha", title: "Salida en vivo" });

type CheckMeta = {
  label: string;
  /** Screen that fixes (or shows the state of) the check. */
  screen?: ScreenKey;
  /** Row action when the check is not passing; default «Configurar». Environment-level checks say «Ver estado». */
  action?: string;
};

// Codes of computeReadiness (apps/api backoffice.service.ts), in the API's order.
const CHECK_META: Record<string, CheckMeta> = {
  // Issuer identity (Tanda 6b): the legal entity is the single source of the NIF and the razón social.
  issuer_legal_name_set: { label: "Razón social de la sociedad emisora", screen: "StructureScreen" },
  issuer_tax_id_valid: { label: "NIF de la sociedad emisora válido (facturas y VeriFactu)", screen: "StructureScreen" },
  property_fiscal_address_complete: { label: "Dirección fiscal del establecimiento (dirección, municipio, provincia y código postal)", screen: "PropertyProfileSetupForm" },
  timezone_configured: { label: "Zona horaria del establecimiento", screen: "PropertyProfileSetupForm" },
  tax_region_configured: { label: "Región fiscal canónica y tipos de impuesto vigentes", screen: "TaxComplianceSettings" },
  ipsi_ordinance_confirmed: { label: "Tipos IPSI confirmados con la ordenanza vigente", screen: "TaxComplianceSettings" },
  default_building_exists: { label: "Al menos un edificio activo", screen: "BuildingSetupForm" },
  room_type_exists: { label: "Al menos un tipo de habitación activo", screen: "RoomTypeSetupForm" },
  sellable_room_exists: { label: "Al menos una habitación vendible activa con tipo asignado", screen: "RoomSetupForm" },
  admin_user_exists: { label: "Al menos un usuario administrador o responsable activo", screen: "UserRoleManager" },
  invoice_sequence_configured: { label: "Serie de facturación activa (módulo Facturación y cumplimiento)", screen: "BillingSettings" },
  invoice_series_current_year: { label: "Serie de facturas del ejercicio en curso", screen: "BillingSettings" },
  payment_provider_connected: { label: "Proveedor de pago conectado (módulo Payment Vault)", screen: "PaymentSettings" },
  ses_establishment_profile: { label: "Datos del establecimiento para SES.HOSPEDAJES (registro, código INE, código postal)", screen: "SesHospedajesSettings" },
  ses_hospedajes_credentials: { label: "Modo de envío y certificado de SES.HOSPEDAJES", screen: "SesHospedajesSettings", action: "Ver estado" },
  verifactu_software_declared: { label: "Datos del software VeriFactu (productor, versión, instalación)", screen: "FiscalDashboard", action: "Ver estado" },
  platform_certificate_notice: { label: "Certificado de firma para la AEAT y el Ministerio del Interior", screen: "FiscalDashboard", action: "Ver estado" },
  // Codes of earlier readiness versions: rows persisted before the last recalculation still carry them.
  legal_profile_complete: { label: "Perfil legal del establecimiento (razón social, NIF, dirección, región fiscal, zona horaria)", screen: "PropertyProfileSetupForm" },
  ses_establishment_complete: { label: "Datos del establecimiento para SES.HOSPEDAJES (INE, código postal, registro turístico)", screen: "SesHospedajesSettings" },
  taxes_configured: { label: "Tipos de impuesto vigentes para alojamiento, restauración y servicios", screen: "TaxComplianceSettings" },
  tax_catalog_provisioned: { label: "Catálogo fiscal provisionado", screen: "TaxComplianceSettings" },
  verifactu_software_configured: { label: "Datos del software VeriFactu (NIF del productor, versión, instalación)", screen: "FiscalDashboard", action: "Ver estado" }
};

function humanize(code: string): string {
  return code.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function statusMeta(check: ReadinessCheck): { label: string; tone: CocoaTone } {
  if (check.status === "pass") return { label: "Correcto", tone: "success" };
  if (check.status === "warning") return { label: "Atención", tone: "warning" };
  return check.severity === "blocking" ? { label: "Bloqueante", tone: "danger" } : { label: "Pendiente", tone: "warning" };
}

function GoLivePage({ embedded }: { embedded: boolean }) {
  // The host context decides the head (CocoaPage reads it); `embedded` is the L1c bridge the loader still passes.
  const hosted = embedded || useTabHost() !== null;
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
      showToast(
        next.status === "ready"
          ? "Comprobaciones recalculadas: la propiedad está lista para salir en vivo."
          : `Comprobaciones recalculadas: ${plural(next.blockingCount, "bloqueante", "bloqueantes")}.`,
        { variant: next.status === "ready" ? "success" : "info" }
      );
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 403
          ? "No tienes permiso para recalcular las comprobaciones (property.configure)."
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
  const passed = checks.filter((check) => check.status === "pass").length;
  const nextPending = checks.find((check) => check.status !== "pass");

  const headerTone: CocoaTone = checks.length === 0 ? "info" : readiness?.status === "ready" ? "success" : "danger";
  const headerLabel = checks.length === 0 ? "Sin calcular" : readiness?.status === "ready" ? "Lista para salir en vivo" : plural(blocking.length, "bloqueante", "bloqueantes");
  const progressTone: CocoaTone = readiness?.status === "ready" ? "success" : blocking.length > 0 ? "danger" : "warning";

  return (
    <CocoaPage
      eyebrow={HEADER.eyebrow}
      title={HEADER.title}
      subtitle={lastUpdated ? `Última comprobación: ${dateTime(lastUpdated)}` : "Aún no se han calculado las comprobaciones de esta propiedad"}
      actions={
        <>
          <CocoaBadge tone={headerTone}>{headerLabel}</CocoaBadge>
          {hosted ? null : (
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("SetupCenterScreen")}>
              Puesta en marcha
            </CocoaButton>
          )}
          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => void handleRecalculate()} disabled={recalculating} loading={recalculating}>
            Recalcular preparación
          </CocoaButton>
        </>
      }
      state={loading && !readiness ? "loading" : error && !readiness ? "error" : "ready"}
      skeleton={<CocoaSkeleton variant="card" height={320} />}
      error={{ title: "No se pudo cargar la lista de comprobación", message: error ?? undefined, onRetry: () => void load() }}
      commands={[{ id: "go-live-recalculate", label: "Recalcular preparación", run: () => { void handleRecalculate(); } }]}
    >
      {checks.length === 0 ? (
        <CocoaSection aria-label="Comprobaciones sin calcular">
          <CocoaState
            kind="empty"
            illustration="box"
            title="Comprobaciones sin calcular"
            message="La propiedad no tiene comprobaciones guardadas. Pulsa «Recalcular ahora» para evaluar perfil legal, estructura, usuarios, facturación, pagos y cumplimiento."
            primaryAction={{ label: "Recalcular ahora", onClick: () => void handleRecalculate(), loading: recalculating }}
          />
        </CocoaSection>
      ) : (
        <CocoaSection title="Lista de comprobación" meta={`${passed} de ${checks.length} correctas`}>
          <CocoaChart.Progress
            value={(passed / checks.length) * 100}
            tone={progressTone}
            label="Comprobaciones superadas"
            valueLabel={`${passed} de ${checks.length}`}
            aria-label={`${passed} de ${checks.length} comprobaciones superadas`}
          />
          <ol className="c22-section__list" aria-label="Comprobaciones de salida en vivo">
            {checks.map((check) => {
              const meta = CHECK_META[check.checkCode];
              const status = statusMeta(check);
              // The API message names environment variables and test modes; the raw text stays in `title`.
              const message = readinessMessage(check.message);
              return (
                <li key={check.id ?? check.checkCode} aria-current={nextPending === check ? "step" : undefined}>
                  <CocoaBadge tone={status.tone} variant="dot" size="small">
                    {status.label}
                  </CocoaBadge>
                  <span className="cocoa-stack" data-gap="1" style={{ flex: "1 1 320px", minWidth: 0 }} title={check.checkCode}>
                    <span>{meta?.label ?? humanize(check.checkCode)}</span>
                    <span className="cocoa-note" title={message !== check.message ? check.message : undefined}>
                      {message}
                      {check.severity === "blocking" ? " · bloquea la salida en vivo" : check.severity === "warning" ? " · recomendado" : ""}
                    </span>
                  </span>
                  {meta?.screen ? (
                    <CocoaButton variant="plain" size="small" onClick={() => navigateTo(meta.screen as ScreenKey)}>
                      {check.status === "pass" ? "Revisar" : (meta.action ?? "Configurar")}
                    </CocoaButton>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </CocoaSection>
      )}

      <p className="cocoa-note">
        La aprobación de la salida en vivo recalcula todas las comprobaciones y se bloquea si queda alguna bloqueante; las comprobaciones de módulos desactivados pasan automáticamente.
      </p>
    </CocoaPage>
  );
}

// Bridge of L1c (TabHost.tsx): the loader may still pass `embedded`; the page reads the host context.
export function GoLiveChecklist({ embedded = false }: { embedded?: boolean } = {}) {
  return <GoLivePage embedded={embedded} />;
}

export default GoLiveChecklist;

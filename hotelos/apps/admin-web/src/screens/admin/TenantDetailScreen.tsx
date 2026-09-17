// Tenant Detail (platform console) — Configuración › Sistema › Organizaciones › :id
// (/configuracion/sistema/organizaciones/:id).
//
// Full view of one tenant organization. The host mounts it and passes
// `onClose` when a back affordance should be shown (SistemaTabs goes back to
// the Organizaciones tab).
//
// Inner views (`tabs` of CocoaPage; hosted, HostedHead paints them as a
// segmented control):
//   - General     → summary, sociedad + VeriFactu chain policy (Tanda 6b),
//                   quick module toggles, billing (honest «—»: the admin API
//                   exposes no billing aggregates).
//   - Centros     → CocoaTable of the properties (work centres).
//   - Usuarios    → CocoaTable of users with «Reenviar invitación» (POST
//                   /admin/tenants/:orgId/users/:userId/reissue-invite): a new
//                   single-use link that revokes the previous ones and whose
//                   real email delivery state is shown — never a clear-text
//                   temp password (Tanda 3 · CFG-P1-6).
//   - Módulos     → catalogue with CocoaSwitch calling `toggleModule`.
//   - Actividad   → CocoaTable of the recent tenant events (lazy, first open).
//
// Data: `fetchTenantDetail(orgId)` (full payload); `fetchTenantAuditLog(orgId)`
// only when the Actividad view is first opened.
//
// Cocoa 22 (lote 10-A · detalle): CocoaPage (tabs, actions, skeleton 8/4) →
// CocoaGrid align="start" 8/4 in General → CocoaSection padding="none" +
// CocoaTable in the list views → CocoaCallout / CocoaDialog for the chain
// policy (Tanda 6b, kept).

import { useCallback, useEffect, useMemo, useState } from "react";
import { useToast } from "../../components/Toast";
import { fetchTenantDetail, fetchTenantAuditLog, toggleModule, reissueTenantInvitation, type TenantDetail, type TenantStatus, type TenantUserSummary } from "../../services/tenantAdminApi";
import { copyText, describeDelivery, formatExpiry, type InvitationResult } from "../../services/authApi";
import { date, dateTime, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
// Tanda 6b (L6): the tenant's sociedad and its VeriFactu chain policy (platform console only, R7).
import { setVerifactuChainScope, type VerifactuChainScope } from "../../services/structureApi";
import { financeErrorMessage } from "../../services/finance-contracts";
import { CHAIN_SCOPE_LABELS, CHAIN_SCOPE_SHORT_LABELS, PGC_VARIANT_LABELS, propertyKindLabel } from "../structure/structure-ui";
import { useTabHost } from "../tabs/TabHost";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaGrid,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

/** Tanda 6b: `TenantDetail.legalEntity` of GET /admin/tenants/:orgId (tenant-admin.service TenantLegalEntitySummary); null before the backfill. */
type TenantLegalEntitySummary = {
  id: string;
  code: string;
  legalName: string;
  taxId: string | null;
  taxIdValid: boolean;
  verifactuChainScope: VerifactuChainScope;
  pgcVariant: "pymes" | "general";
  siiEnabled: boolean;
  largeCompany: boolean;
};

function legalEntityOf(tenant: TenantDetail | null): TenantLegalEntitySummary | null {
  const value = (tenant as (TenantDetail & { legalEntity?: TenantLegalEntitySummary | null }) | null)?.legalEntity;
  return value && typeof value === "object" && typeof value.id === "string" ? value : null;
}

const CHAIN_SCOPE_OPTIONS = (Object.keys(CHAIN_SCOPE_LABELS) as VerifactuChainScope[]).map((value) => ({ value, label: CHAIN_SCOPE_LABELS[value] }));

export interface TenantDetailScreenProps {
  orgId: string;
  onClose?: () => void;
}

type Tab = "general" | "properties" | "users" | "modules" | "audit";

// Catalog of modules a tenant can enable. Each entry is rendered as a switch
// in the General + Módulos views. The backend stores enabled modules as an
// array of these `code` strings on the tenant.
const MODULE_CATALOG: Array<{ code: string; label: string; description: string }> = [
  { code: "pms", label: "PMS", description: "Recepción, reservas y pisos." },
  { code: "channel_manager", label: "Channel Manager", description: "Distribución hacia OTA y GDS." },
  { code: "revenue", label: "Revenue", description: "Precios dinámicos y diario de tarifas." },
  { code: "crm", label: "CRM", description: "Perfiles de cliente, segmentación y campañas." },
  { code: "marketing", label: "Marketing", description: "Email, SMS, push y automatizaciones." },
  { code: "compliance", label: "Cumplimiento", description: "Centro de cumplimiento y carpeta de inspección." },
  { code: "fnb", label: "F&B", description: "Cartas, recetas e inventario." },
  { code: "fiscal", label: "Fiscal", description: "VeriFactu, SES, TicketBAI, IGIC." },
  { code: "banking", label: "Banca", description: "Conciliación y open banking." },
  { code: "esrs", label: "ESRS / Sostenibilidad", description: "Informes ESRS e indicadores de energía." },
  { code: "loyalty", label: "Fidelización", description: "Programa de fidelización." },
  { code: "kiosk", label: "Kiosco / auto check-in", description: "Pantallas de auto check-in." }
];

const STATUS_TONE: Record<string, CocoaTone> = {
  active: "success",
  trial: "info",
  suspended: "warning",
  archived: "danger"
};

const STATUS_LABEL: Record<string, string> = {
  active: STATUS_LABELS.active,
  trial: "Prueba",
  suspended: "Suspendida",
  archived: STATUS_LABELS.archived
};

const USER_STATUS_TONE: Record<string, CocoaTone> = {
  active: "success",
  invited: "warning",
  disabled: "danger"
};

const USER_STATUS_LABEL: Record<string, string> = {
  active: STATUS_LABELS.active,
  invited: "Invitado · pendiente",
  disabled: STATUS_LABELS.disabled
};

/** authApi delivery tone («ok» / «warn» / «error») → Cocoa tone. */
const DELIVERY_TONE: Record<"ok" | "warn" | "error", CocoaTone> = { ok: "success", warn: "warning", error: "danger" };

/** Read-only value + copy button (the invite link to hand over by another channel). */
function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    if (await copyText(value)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  };
  return (
    <div className="cocoa-stack" data-gap="1">
      <span className="cocoa-caption">{label}</span>
      <div className="cocoa-row" data-gap="2" data-wrap="nowrap">
        <CocoaInput value={value} onChange={() => undefined} readOnly aria-label={label} style={{ flex: "1 1 auto", minWidth: 0 }} />
        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void handleCopy()}>
          {copied ? "Copiado" : ACTIONS.copy}
        </CocoaButton>
      </div>
    </div>
  );
}

function fmtDate(v?: string | null): string {
  return dateTime(v, { style: "medium" });
}

function fmtDateShort(v?: string | null): string {
  return date(v, "medium");
}

function getString(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

function statusBadge(status: TenantStatus) {
  const key = String(status);
  return (
    <CocoaBadge tone={STATUS_TONE[key] ?? "info"} uppercase={false}>
      {STATUS_LABEL[key] ?? key}
    </CocoaBadge>
  );
}

const VIEWS_BASE: Array<{ value: Tab; label: string }> = [
  { value: "general", label: "General" },
  { value: "properties", label: "Centros" },
  { value: "users", label: "Usuarios" },
  { value: "modules", label: "Módulos" },
  { value: "audit", label: "Actividad" }
];

const AUDIT_COLUMNS: CocoaTableColumn<Record<string, unknown>>[] = [
  { key: "at", label: "Fecha", fit: true, render: (row) => fmtDate(getString(row, "createdAt") || getString(row, "at") || getString(row, "timestamp") || null) },
  { key: "actor", label: "Actor", hideOnNarrow: true, render: (row) => getString(row, "actorEmail") || getString(row, "actor") || getString(row, "userId") || "sistema" },
  { key: "action", label: "Acción", render: (row) => <strong>{getString(row, "action") || getString(row, "eventType") || "—"}</strong> },
  { key: "target", label: "Objetivo", showFrom: "laptop", render: (row) => getString(row, "target") || getString(row, "entity") || "—" },
  { key: "summary", label: "Resumen", hideOnNarrow: true, render: (row) => getString(row, "summary") || getString(row, "description") || "" }
];

export function TenantDetailScreen({ orgId, onClose }: TenantDetailScreenProps) {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();

  const [tenant, setTenant] = useState<TenantDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("general");

  const [auditLog, setAuditLog] = useState<Array<Record<string, unknown>>>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  // Per-module in-flight toggles so a row is disabled while the optimistic
  // patch round-trips to the backend.
  const [moduleBusy, setModuleBusy] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  // Last re-issued invitation (link + real delivery state), shown under the users table.
  const [inviteResult, setInviteResult] = useState<{ userId: string; email: string; invitation: InvitationResult } | null>(null);
  // Tanda 6b: VeriFactu chain policy of the sociedad (per_center · per_entity), confirmed before POST /admin/legal-entities/:id/verifactu-scope.
  const legalEntity = legalEntityOf(tenant);
  const [chainScopeDraft, setChainScopeDraft] = useState<VerifactuChainScope | null>(null);
  const [chainScopeConfirm, setChainScopeConfirm] = useState(false);
  const [chainScopeBusy, setChainScopeBusy] = useState(false);
  const [chainScopeError, setChainScopeError] = useState<string | null>(null);
  const chainScopeValue = chainScopeDraft ?? legalEntity?.verifactuChainScope ?? "per_center";
  const chainScopeDirty = legalEntity !== null && chainScopeValue !== legalEntity.verifactuChainScope;

  async function applyChainScope() {
    if (!legalEntity || !chainScopeDirty) return;
    setChainScopeBusy(true);
    setChainScopeError(null);
    try {
      const result = await setVerifactuChainScope(legalEntity.id, chainScopeValue);
      setTenant((prev) => (prev ? ({ ...prev, legalEntity: { ...legalEntity, verifactuChainScope: result.legalEntity.verifactuChainScope } } as TenantDetail) : prev));
      setChainScopeDraft(null);
      setChainScopeConfirm(false);
      showToast(result.changed ? `Política de cadena VeriFactu: ${CHAIN_SCOPE_SHORT_LABELS[result.legalEntity.verifactuChainScope].toLowerCase()}.` : "La política de cadena ya era esa.", { variant: "success" });
    } catch (e) {
      setChainScopeError(financeErrorMessage(e, "No se pudo cambiar la política de cadena."));
      setChainScopeConfirm(false);
    } finally {
      setChainScopeBusy(false);
    }
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const detail = await fetchTenantDetail(orgId);
      setTenant(detail);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const items = await fetchTenantAuditLog(orgId, 100);
      setAuditLog(items as Array<Record<string, unknown>>);
    } catch (e) {
      setAuditError(e instanceof Error ? e.message : String(e));
    } finally {
      setAuditLoading(false);
    }
  }, [orgId]);

  // Lazy-load the activity only when the user first opens that view.
  useEffect(() => {
    if (tab === "audit" && auditLog.length === 0 && !auditLoading && !auditError) {
      void loadAudit();
    }
    // Only on view change: including the audit state would re-fire right after a load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, loadAudit]);

  const enabledModules = useMemo(() => new Set(tenant?.modulesEnabled ?? []), [tenant]);

  async function handleToggleModule(code: string, enabled: boolean) {
    // Optimistic update — flip the local state first, revert on error.
    setModuleBusy((m) => ({ ...m, [code]: true }));
    const prev = tenant;
    if (prev) {
      const next: TenantDetail = {
        ...prev,
        modulesEnabled: enabled ? Array.from(new Set([...(prev.modulesEnabled ?? []), code])) : (prev.modulesEnabled ?? []).filter((m) => m !== code)
      };
      setTenant(next);
    }
    try {
      await toggleModule(orgId, code, enabled);
      showToast(`Módulo «${code}» ${enabled ? "activado" : "desactivado"}.`, { variant: "success" });
    } catch (e) {
      // Revert optimistic update.
      setTenant(prev);
      const message = e instanceof Error ? e.message : "No se pudo cambiar el módulo.";
      showToast(message, { variant: "error" });
    } finally {
      setModuleBusy((m) => {
        const copy = { ...m };
        delete copy[code];
        return copy;
      });
    }
  }

  async function handleReissueInvite(user: TenantUserSummary) {
    setBusy(true);
    try {
      const invitation = await reissueTenantInvitation(orgId, user.id);
      if (invitation.delivery?.status === "sent") {
        showToast(`Invitación enviada a ${user.email}`, { variant: "success" });
      } else {
        showToast(`${describeDelivery(invitation.delivery).title}.`, { variant: "info", duration: 6000 });
      }
      setInviteResult({ userId: user.id, email: user.email, invitation });
      void load();
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo reenviar la invitación.";
      showToast(message, { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  function handleInviteUser() {
    // Honest: there is no POST /admin/tenants/:orgId/users. Additional staff is
    // invited from the property's «Usuarios y roles» screen (UserRoleManager →
    // POST /backoffice/properties/:id/users/invite).
    showToast("Invita a más usuarios desde «Usuarios y roles» de la propiedad (con rol). Desde la consola solo se reenvía la invitación del propietario.", { variant: "info", duration: 7000 });
  }

  function handleAddProperty() {
    // Honest: the console has no endpoint to create a centre; the organization
    // does it from Configuración › Estructura societaria (Tanda 6b).
    showToast("Los centros de trabajo se dan de alta desde Configuración › Estructura societaria de la propia organización.", { variant: "info", duration: 7000 });
  }

  // -- Table columns (typed with the row; close over the busy flag) --------------

  const propertyColumns: CocoaTableColumn<Record<string, unknown>>[] = [
    { key: "name", label: "Nombre", render: (row) => <strong>{getString(row, "name") || getString(row, "id") || "—"}</strong> },
    // Tanda 6b: work-centre code and kind (hotel · oficina · otro) of every centre of the sociedad.
    { key: "code", label: "Código", fit: true, render: (row) => getString(row, "code") || "—" },
    {
      key: "kind",
      label: "Tipo de centro",
      fit: true,
      render: (row) => {
        const kind = getString(row, "kind") || "hotel";
        return <CocoaBadge tone={kind === "hotel" ? "accent" : kind === "office" ? "info" : "neutral"}>{propertyKindLabel(kind)}</CocoaBadge>;
      }
    },
    { key: "city", label: "Ciudad", hideOnNarrow: true, render: (row) => getString(row, "city") || getString(row, "municipality") || "—" },
    { key: "country", label: "País", showFrom: "laptop", render: (row) => getString(row, "country") || tenant?.country || "—" },
    {
      key: "rooms",
      label: "Habitaciones",
      align: "right",
      fit: true,
      render: (row) => {
        const v = row["roomsCount"] ?? row["rooms"];
        return typeof v === "number" ? v : "—";
      }
    },
    {
      key: "status",
      label: "Estado",
      fit: true,
      render: (row) => {
        const v = getString(row, "status");
        return v ? statusBadge(v) : "—";
      }
    }
  ];

  const userColumns: CocoaTableColumn<TenantUserSummary>[] = [
    { key: "fullName", label: "Nombre", render: (row) => <strong>{row.fullName || "—"}</strong> },
    { key: "email", label: "Correo", render: (row) => row.email || "—" },
    { key: "role", label: "Rol", hideOnNarrow: true, render: (row) => (row.roles.length > 0 ? row.roles.join(", ") : "—") },
    {
      key: "status",
      label: "Estado",
      fit: true,
      render: (row) => (
        <CocoaBadge tone={USER_STATUS_TONE[row.status] ?? "info"} uppercase={false}>
          {USER_STATUS_LABEL[row.status] ?? row.status}
        </CocoaBadge>
      )
    },
    { key: "lastLoginAt", label: "Último acceso", fit: true, hideOnNarrow: true, render: (row) => fmtDateShort(row.lastLoginAt ?? null) }
  ];

  const properties = Array.isArray(tenant?.properties) ? (tenant?.properties as Record<string, unknown>[]) : [];
  const users: TenantUserSummary[] = Array.isArray(tenant?.users) ? tenant!.users : [];
  const propertiesCount = tenant?.propertiesCount ?? properties.length;
  const usersCount = tenant?.usersCount ?? users.length;

  const views = VIEWS_BASE.map((view) => ({
    value: view.value,
    label: view.value === "properties" ? `${view.label} · ${propertiesCount}` : view.value === "users" ? `${view.label} · ${usersCount}` : view.label
  }));

  const state = loading && !tenant ? "loading" : error && !tenant ? "error" : !tenant ? "empty" : "ready";

  return (
    <CocoaPage
      eyebrow="Configuración · Sistema"
      title={tenant?.name ?? "Organización"}
      subtitle={hosted || !tenant ? undefined : `${tenant.country || "país desconocido"} · plan ${tenant.plan || "—"}`}
      tabs={tenant ? views : undefined}
      activeTab={tab}
      onTabChange={(v) => setTab(v as Tab)}
      actions={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void load()} disabled={loading}>
            {ACTIONS.refresh}
          </CocoaButton>
          {onClose ? (
            <CocoaButton variant="plain" tone="neutral" size="small" onClick={onClose}>
              {ACTIONS.close}
            </CocoaButton>
          ) : null}
        </>
      }
      state={state}
      skeleton={<CocoaSkeleton.Grid rows={[[8, 4]]} height={280} label="Cargando organización" />}
      error={{ title: "No se pudo cargar la organización", message: error ?? undefined, onRetry: () => void load() }}
      empty={{ title: "Organización no encontrada", message: `No existe ninguna organización con identificador ${orgId}.` }}
    >
      {tenant && tab === "general" ? (
        <CocoaGrid align="start">
          <CocoaSpan cols={8} min={480}>
            <div className="cocoa-stack" data-gap="4">
              <CocoaSection title="Resumen" meta={statusBadge(tenant.status)}>
                <ul className="c22-section__list" aria-label="Resumen de la organización">
                  <li>
                    <span>Plan</span>
                    <strong>{tenant.plan || "—"}</strong>
                  </li>
                  <li>
                    <span>Identificador</span>
                    <code className="cocoa-mono">{tenant.organizationId}</code>
                  </li>
                  <li>
                    <span>País</span>
                    <strong>{tenant.country || "—"}</strong>
                  </li>
                  <li>
                    <span>Centros de trabajo</span>
                    <strong>{propertiesCount}</strong>
                  </li>
                  <li>
                    <span>Usuarios</span>
                    <strong>{usersCount}</strong>
                  </li>
                  <li>
                    <span>Creada</span>
                    <strong>{fmtDateShort(tenant.createdAt)}</strong>
                  </li>
                  <li>
                    <span>Última actividad</span>
                    <strong>{fmtDateShort(tenant.lastActivityAt)}</strong>
                  </li>
                </ul>
              </CocoaSection>

              {/* Tanda 6b (L6): the tenant's sociedad and its VeriFactu chain policy (fixed here, never by the hotelier). */}
              <CocoaSection
                title="Sociedad"
                meta={legalEntity ? legalEntity.code : undefined}
                footer={<span className="cocoa-note">La política de cadena consta en la declaración responsable del productor y no se puede cambiar una vez remitidos registros reales a la AEAT (nunca se re-encadena).</span>}
              >
                {legalEntity ? (
                  <div className="cocoa-stack" data-gap="3">
                    <ul className="c22-section__list" aria-label="Datos de la sociedad">
                      <li>
                        <span>Razón social</span>
                        <strong>{legalEntity.legalName}</strong>
                      </li>
                      <li>
                        <span>NIF</span>
                        {legalEntity.taxId ? (
                          <span className="cocoa-cluster">
                            <strong className="cocoa-tabular">{legalEntity.taxId}</strong>
                            <CocoaBadge tone={legalEntity.taxIdValid ? "success" : "danger"} size="small">
                              {legalEntity.taxIdValid ? "válido" : "revisar"}
                            </CocoaBadge>
                          </span>
                        ) : (
                          <CocoaBadge tone="warning" size="small">
                            pendiente
                          </CocoaBadge>
                        )}
                      </li>
                      <li>
                        <span>Plan contable</span>
                        <strong>{PGC_VARIANT_LABELS[legalEntity.pgcVariant]}</strong>
                      </li>
                      <li>
                        <span>Régimen</span>
                        <span className="cocoa-cluster">
                          {legalEntity.siiEnabled ? (
                            <CocoaBadge tone="warning" size="small">
                              SII
                            </CocoaBadge>
                          ) : null}
                          {legalEntity.largeCompany ? (
                            <CocoaBadge tone="warning" size="small">
                              gran empresa
                            </CocoaBadge>
                          ) : null}
                          {!legalEntity.siiEnabled && !legalEntity.largeCompany ? <strong>General</strong> : null}
                        </span>
                      </li>
                    </ul>
                    {chainScopeError ? (
                      <CocoaCallout tone="danger" title="No se pudo cambiar la política de cadena" role="alert">
                        {chainScopeError}
                      </CocoaCallout>
                    ) : null}
                    <div className="cocoa-row" data-gap="2">
                      <CocoaSelect value={chainScopeValue} onChange={(v) => setChainScopeDraft(v as VerifactuChainScope)} options={CHAIN_SCOPE_OPTIONS} aria-label="Política de cadena VeriFactu" disabled={chainScopeBusy} inline />
                      <CocoaButton variant="filled" tone="accent" size="small" onClick={() => setChainScopeConfirm(true)} disabled={!chainScopeDirty || chainScopeBusy}>
                        Aplicar política de cadena
                      </CocoaButton>
                    </div>
                  </div>
                ) : (
                  <CocoaState kind="empty" inline title="Esta organización no tiene sociedad todavía (anterior a la estructura societaria): ejecuta el proceso de estructura del API para crearla." />
                )}
              </CocoaSection>
            </div>
          </CocoaSpan>

          <CocoaSpan cols={4} min={320}>
            <div className="cocoa-stack" data-gap="4">
              <CocoaSection title="Módulos activos" meta={`${enabledModules.size} de ${MODULE_CATALOG.length}`} action={<CocoaButton variant="plain" size="small" onClick={() => setTab("modules")}>{ACTIONS.viewDetail}</CocoaButton>}>
                <ul className="c22-section__list" aria-label="Módulos de la organización">
                  {MODULE_CATALOG.map((mod) => (
                    <li key={mod.code}>
                      <span>{mod.label}</span>
                      <CocoaSwitch size="small" checked={enabledModules.has(mod.code)} onChange={(next) => void handleToggleModule(mod.code, next)} disabled={!!moduleBusy[mod.code]} aria-label={`Módulo ${mod.label}`} />
                    </li>
                  ))}
                </ul>
              </CocoaSection>

              <CocoaSection title="Facturación" meta="resumen">
                <CocoaState kind="degraded" inline title="Sin datos de facturación" message="El API de administración no expone los agregados de facturación de este cliente (MRR, última factura, próximo cobro, estado del pago)." />
              </CocoaSection>
            </div>
          </CocoaSpan>
        </CocoaGrid>
      ) : null}

      {tenant && tab === "properties" ? (
        <CocoaSection
          title="Centros de trabajo"
          meta={plural(properties.length, "centro", "centros")}
          padding={properties.length > 0 ? "none" : "md"}
          style={{ overflow: "clip" }}
          action={
            <CocoaButton variant="plain" size="small" onClick={handleAddProperty}>
              Añadir centro
            </CocoaButton>
          }
        >
          {properties.length === 0 ? (
            <CocoaState kind="empty" inline title="Esta organización todavía no tiene centros de trabajo." />
          ) : (
            <CocoaTable<Record<string, unknown>> columns={propertyColumns} rows={properties} rowKey={(r) => getString(r, "id") || getString(r, "propertyId") || getString(r, "name")} caption="Centros de trabajo" aria-label="Centros de trabajo" />
          )}
        </CocoaSection>
      ) : null}

      {tenant && tab === "users" ? (
        <div className="cocoa-stack" data-gap="4">
          <CocoaSection
            title="Usuarios"
            meta={plural(users.length, "usuario", "usuarios")}
            padding={users.length > 0 ? "none" : "md"}
            style={{ overflow: "clip" }}
            action={
              <CocoaButton variant="plain" size="small" onClick={handleInviteUser}>
                Invitar usuario
              </CocoaButton>
            }
            footer={
              <span className="cocoa-note">
                «Reenviar invitación» genera un enlace de un solo uso (72 h) para que la persona cree su contraseña y anula los enlaces anteriores; también sirve para restaurar el acceso de un usuario activo.
              </span>
            }
          >
            {users.length === 0 ? (
              <CocoaState kind="empty" inline title="Esta organización todavía no tiene usuarios." />
            ) : (
              <CocoaTable<TenantUserSummary>
                columns={userColumns}
                rows={users}
                rowKey={(r) => r.id || r.email}
                rowActionsVisible="always"
                rowActions={(row) =>
                  row.id && row.status !== "disabled" ? (
                    <CocoaButton
                      size="small"
                      variant="plain"
                      disabled={busy}
                      onClick={(event) => {
                        event.stopPropagation();
                        void handleReissueInvite(row);
                      }}
                    >
                      {row.status === "invited" ? "Reenviar invitación" : "Nuevo enlace de acceso"}
                    </CocoaButton>
                  ) : null
                }
                caption="Usuarios de la organización"
                aria-label="Usuarios de la organización"
              />
            )}
          </CocoaSection>
          {inviteResult
            ? (() => {
                const delivery = describeDelivery(inviteResult.invitation.delivery, inviteResult.email);
                const showLink = inviteResult.invitation.delivery?.status !== "sent" && Boolean(inviteResult.invitation.inviteUrl);
                return (
                  <CocoaCallout tone={DELIVERY_TONE[delivery.tone]} title={delivery.title} role="status">
                    <div className="cocoa-stack" data-gap="2">
                      <span>{delivery.detail}</span>
                      {showLink ? <CopyRow label="Enlace de invitación (un solo uso)" value={inviteResult.invitation.inviteUrl} /> : null}
                      <span className="cocoa-note">Caduca el {formatExpiry(inviteResult.invitation.expiresAt)}.</span>
                    </div>
                  </CocoaCallout>
                );
              })()
            : null}
        </div>
      ) : null}

      {tenant && tab === "modules" ? (
        <CocoaSection title="Catálogo de módulos" meta={`${enabledModules.size} de ${MODULE_CATALOG.length} activos`}>
          <p className="cocoa-note">Activa o desactiva cada módulo del producto. El cambio se guarda de inmediato y queda en el registro de actividad.</p>
          <ul className="c22-section__list" aria-label="Catálogo de módulos">
            {MODULE_CATALOG.map((mod) => {
              const isOn = enabledModules.has(mod.code);
              const isBusy = !!moduleBusy[mod.code];
              return (
                <li key={mod.code}>
                  <div className="cocoa-stack" data-gap="1" style={{ minWidth: 0 }}>
                    <span className="cocoa-cluster">
                      <strong>{mod.label}</strong>
                      <code className="cocoa-mono cocoa-note">{mod.code}</code>
                    </span>
                    <span className="cocoa-note">{mod.description}</span>
                  </div>
                  <CocoaSwitch checked={isOn} onChange={(next) => void handleToggleModule(mod.code, next)} disabled={isBusy} label={isOn ? STATUS_LABELS.active : STATUS_LABELS.inactive} />
                </li>
              );
            })}
          </ul>
        </CocoaSection>
      ) : null}

      {tenant && tab === "audit" ? (
        <CocoaSection
          title="Actividad reciente"
          meta={auditLog.length > 0 ? plural(auditLog.length, "evento", "eventos") : undefined}
          padding={!auditError && auditLog.length > 0 ? "none" : "md"}
          style={{ overflow: "clip" }}
          action={
            <CocoaButton variant="plain" size="small" onClick={() => void loadAudit()} disabled={auditLoading}>
              {ACTIONS.refresh}
            </CocoaButton>
          }
          footer={<span className="cocoa-note">Últimos eventos de la organización: cambios de plan, módulos, altas y bajas de usuarios, accesos.</span>}
        >
          {auditLoading && auditLog.length === 0 ? (
            <CocoaTable columns={AUDIT_COLUMNS} rows={[]} loading aria-label="Actividad reciente" />
          ) : auditError ? (
            <CocoaState kind="error" title="No se pudo cargar la actividad" message={auditError} onRetry={() => void loadAudit()} />
          ) : auditLog.length === 0 ? (
            <CocoaState kind="empty" inline title="Sin eventos registrados todavía." />
          ) : (
            <CocoaTable<Record<string, unknown>>
              columns={AUDIT_COLUMNS}
              rows={auditLog}
              rowKey={(r) => getString(r, "id") || getString(r, "eventId") || `${getString(r, "createdAt")}-${getString(r, "action")}`}
              maxHeight={520}
              caption="Actividad reciente"
              aria-label="Actividad reciente"
            />
          )}
        </CocoaSection>
      ) : null}

      <CocoaDialog
        open={chainScopeConfirm}
        onClose={() => setChainScopeConfirm(false)}
        tone="destructive"
        title="Confirmar la política de cadena VeriFactu"
        description={`${CHAIN_SCOPE_LABELS[chainScopeValue]}. La decisión consta en la declaración responsable y no se puede deshacer una vez remitidos registros reales; cambiarla no re-encadena: se retiran las instalaciones y se abren otras con número nuevo.`}
        confirmLabel={ACTIONS.apply}
        cancelLabel={ACTIONS.cancel}
        busy={chainScopeBusy}
        onConfirm={applyChainScope}
      />
    </CocoaPage>
  );
}

export default TenantDetailScreen;

// Tenant Detail (superadmin) — full view of a single tenant org.
//
// Reachable from the Tenants list (TenantListScreen). Renders inside a drawer
// or as a full screen depending on the host; both cases work because we let
// the parent control mounting and pass `onClose` if a back/close affordance
// should be shown.
//
// Tabs:
//   - General      → plan / status / módulos activos (toggle) / properties
//                    count / users count / billing summary cards.
//   - Propiedades  → table of properties with "Añadir propiedad".
//   - Usuarios     → table of users (rol, estado) with "Reenviar invitación"
//                    (POST /admin/tenants/:orgId/users/:userId/reissue-invite):
//                    a new single-use link that revokes the previous ones and
//                    whose real email delivery state is shown — never a
//                    clear-text temp password (Tanda 3 · CFG-P1-6).
//   - Módulos      → checklist (CocoaSwitch) calling `toggleModule`.
//   - Audit log    → scrollable table of recent tenant events.
//
// Data source: `fetchTenantDetail(orgId)` (full payload). The audit log tab
// pulls separately from `fetchTenantAuditLog(orgId)` only when first opened
// to avoid an extra round-trip for users who never click that tab.

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { pageHead } from "../tabs/configuracion/tab-helpers";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaCard } from "../../components/cocoa/CocoaCard";
import { CocoaSwitch } from "../../components/cocoa/CocoaSwitch";
import { CocoaTable, type CocoaTableColumn } from "../../components/cocoa/CocoaTable";
import { CocoaInput } from "../../components/cocoa/CocoaInput";
import { LoadingBlock, ErrorState, EmptyState, Spinner } from "../../components/States";
import { useToast } from "../../components/Toast";
import {
  fetchTenantDetail,
  fetchTenantAuditLog,
  toggleModule,
  reissueTenantInvitation,
  type TenantDetail,
  type TenantStatus,
  type TenantUserSummary
} from "../../services/tenantAdminApi";
import { copyText, describeDelivery, formatExpiry, type InvitationResult } from "../../services/authApi";
import { date, dateTime } from "../../lib/format";
// Tanda 6b (L6): the tenant's sociedad and its VeriFactu chain policy (platform console only, R7).
import { CocoaSection } from "../../components/cocoa/CocoaSection";
import { CocoaBadge } from "../../components/cocoa/CocoaBadge";
import { CocoaSelect } from "../../components/cocoa/CocoaSelect";
import { CocoaDialog } from "../../components/cocoa/CocoaDialog";
import { CocoaCallout } from "../../components/cocoa/CocoaCallout";
import { setVerifactuChainScope, type VerifactuChainScope } from "../../services/structureApi";
import { financeErrorMessage } from "../../services/finance-contracts";
import { CHAIN_SCOPE_LABELS, CHAIN_SCOPE_SHORT_LABELS, PGC_VARIANT_LABELS, propertyKindLabel } from "../structure/structure-ui";

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
  /** Rendered as the «Organización» sub-URL of Configuración › Sistema (Tanda 5): section head instead of page header. */
  embedded?: boolean;
}

type Tab = "general" | "properties" | "users" | "modules" | "audit";

// Catalog of modules a tenant can enable. Each entry is rendered as a switch
// in the General + Modules tabs. The backend stores enabled modules as an
// array of these `code` strings on the tenant.
const MODULE_CATALOG: Array<{ code: string; label: string; description: string }> = [
  { code: "pms", label: "PMS", description: "Front-desk, reservas, housekeeping." },
  { code: "channel_manager", label: "Channel Manager", description: "Distribución hacia OTAs y GDS." },
  { code: "revenue", label: "Revenue", description: "Pricing dinámico y rate journal." },
  { code: "crm", label: "CRM", description: "Perfiles de cliente, segmentación y campañas." },
  { code: "marketing", label: "Marketing", description: "Email/SMS/Push y automatizaciones." },
  { code: "compliance", label: "Compliance", description: "Centro de cumplimiento + carpeta inspección." },
  { code: "fnb", label: "F&B", description: "Cartas, recetas e inventario." },
  { code: "fiscal", label: "Fiscal", description: "VeriFactu, SES, TBAI, IGIC." },
  { code: "banking", label: "Banking", description: "Conciliación + open banking." },
  { code: "esrs", label: "ESRS / Sostenibilidad", description: "Reportes ESRS, KPIs energía." },
  { code: "loyalty", label: "Loyalty", description: "Programa de fidelización." },
  { code: "kiosk", label: "Kiosk / Self check-in", description: "Pantallas de auto-check-in." }
];

const STATUS_TONE: Record<string, "ok" | "warn" | "info" | "error"> = {
  active: "ok",
  trial: "info",
  suspended: "warn",
  archived: "error"
};

const STATUS_LABEL: Record<string, string> = {
  active: "Activo",
  trial: "Trial",
  suspended: "Suspendido",
  archived: "Archivado"
};

const USER_STATUS_TONE: Record<string, "ok" | "warn" | "info" | "error"> = {
  active: "ok",
  invited: "warn",
  disabled: "error"
};

const USER_STATUS_LABEL: Record<string, string> = {
  active: "Activo",
  invited: "Invitado · pendiente",
  disabled: "Desactivado"
};

/** Read-only value + copy button (Cocoa styling). */
function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    if (await copyText(value)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" }}>{label}</span>
      <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
        <CocoaInput value={value} onChange={() => undefined} />
        <CocoaButton variant="bordered" tone="neutral" size="regular" onClick={handleCopy}>
          {copied ? "Copiado" : "Copiar"}
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

function statusBadge(status: TenantStatus): ReactNode {
  const tone = STATUS_TONE[String(status)] ?? "info";
  const label = STATUS_LABEL[String(status)] ?? String(status);
  return (
    <span className={`bo-status ${tone}`} style={{ fontSize: 11 }}>
      {label}
    </span>
  );
}

const sectionGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
  gap: 12
};

const labelStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)",
  textTransform: "uppercase",
  letterSpacing: "var(--cocoa-tracking-wide)",
  margin: 0
};

const valueStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-title-3)",
  fontWeight: 600,
  color: "var(--cocoa-label)",
  margin: 0
};

export function TenantDetailScreen({ orgId, onClose, embedded = false }: TenantDetailScreenProps) {
  // Inside a tab container (Tanda 5) the page header belongs to the container: render a section head instead.
  const Head = pageHead(embedded);
  const { showToast } = useToast();

  const [tenant, setTenant] = useState<TenantDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("general");

  const [auditLog, setAuditLog] = useState<Array<Record<string, unknown>>>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);

  // Track per-module in-flight toggles so we can disable a row while the
  // optimistic patch is round-tripping to the backend.
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

  // Lazy-load audit log only when the user first opens that tab.
  useEffect(() => {
    if (tab === "audit" && auditLog.length === 0 && !auditLoading && !auditError) {
      void loadAudit();
    }
    // We intentionally don't include auditLog.length / auditLoading / auditError
    // in deps — they'd cause the effect to fire again right after the load
    // completes. We only want this side effect on tab change.
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
        modulesEnabled: enabled
          ? Array.from(new Set([...(prev.modulesEnabled ?? []), code]))
          : (prev.modulesEnabled ?? []).filter((m) => m !== code)
      };
      setTenant(next);
    }
    try {
      await toggleModule(orgId, code, enabled);
      showToast(
        `Módulo «${code}» ${enabled ? "activado" : "desactivado"}.`,
        { variant: "success" }
      );
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
    // Honest: there is no POST /admin/tenants/:orgId/users yet. Additional
    // staff is invited from the property's "Usuarios y seguridad" screen
    // (UserRoleManager → POST /backoffice/properties/:id/users/invite).
    showToast("Invita a más usuarios desde «Usuarios y seguridad» de la propiedad (con rol). Desde la consola solo se reenvía la invitación del owner.", { variant: "info", duration: 7000 });
  }

  function handleAddProperty() {
    // TODO(backend): wire to /admin/tenants/:orgId/properties create endpoint.
    showToast("Añadir propiedad: flujo aún no implementado.", { variant: "info" });
  }

  // -- Render branches -------------------------------------------------------

  if (loading && !tenant) {
    return (
      <section style={{ display: "flex", flexDirection: "column", gap: 18, padding: 16 }}>
        {onClose ? (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <CocoaButton variant="plain" tone="neutral" onClick={onClose}>
              Cerrar
            </CocoaButton>
          </div>
        ) : null}
        <LoadingBlock label="Cargando tenant…" />
      </section>
    );
  }

  if (error && !tenant) {
    return (
      <section style={{ display: "flex", flexDirection: "column", gap: 18, padding: 16 }}>
        {onClose ? (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <CocoaButton variant="plain" tone="neutral" onClick={onClose}>
              Cerrar
            </CocoaButton>
          </div>
        ) : null}
        <ErrorState title="No se pudo cargar el tenant" message={error} onRetry={load} />
      </section>
    );
  }

  if (!tenant) {
    return (
      <section style={{ display: "flex", flexDirection: "column", gap: 18, padding: 16 }}>
        {onClose ? (
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <CocoaButton variant="plain" tone="neutral" onClick={onClose}>
              Cerrar
            </CocoaButton>
          </div>
        ) : null}
        <EmptyState title="Tenant no encontrado" message={`No existe ningún tenant con id ${orgId}.`} />
      </section>
    );
  }

  // -- Property table columns -----------------------------------------------

  const propertyColumns: CocoaTableColumn<Record<string, unknown>>[] = [
    {
      key: "name",
      label: "Nombre",
      render: (row) => <strong>{getString(row, "name") || (getString(row, "id") || "—")}</strong>
    },
    // Tanda 6b: work-centre code and kind (hotel · oficina · otro) of every centre of the sociedad.
    { key: "code", label: "Código", render: (row) => getString(row, "code") || "—" },
    {
      key: "kind",
      label: "Tipo de centro",
      render: (row) => {
        const kind = getString(row, "kind") || "hotel";
        return <CocoaBadge tone={kind === "hotel" ? "accent" : kind === "office" ? "info" : "neutral"}>{propertyKindLabel(kind)}</CocoaBadge>;
      }
    },
    { key: "city", label: "Ciudad", render: (row) => getString(row, "city") || getString(row, "municipality") || "—" },
    { key: "country", label: "País", render: (row) => getString(row, "country") || tenant.country || "—" },
    {
      key: "rooms",
      label: "Habitaciones",
      align: "right",
      render: (row) => {
        const v = row["roomsCount"] ?? row["rooms"];
        return typeof v === "number" ? v : "—";
      }
    },
    {
      key: "status",
      label: "Estado",
      render: (row) => {
        const v = getString(row, "status");
        return v ? <span className={`bo-status ${STATUS_TONE[v] ?? "info"}`} style={{ fontSize: 11 }}>{STATUS_LABEL[v] ?? v}</span> : "—";
      }
    }
  ];

  // -- User table columns ---------------------------------------------------

  const userColumns: CocoaTableColumn<TenantUserSummary>[] = [
    {
      key: "fullName",
      label: "Nombre",
      render: (row) => <strong>{row.fullName || "—"}</strong>
    },
    { key: "email", label: "Correo", render: (row) => row.email || "—" },
    { key: "role", label: "Rol", render: (row) => (row.roles.length > 0 ? row.roles.join(", ") : "—") },
    {
      key: "status",
      label: "Estado",
      render: (row) => (
        <span className={`bo-status ${USER_STATUS_TONE[row.status] ?? "info"}`} style={{ fontSize: 11, textTransform: "none" }}>
          {USER_STATUS_LABEL[row.status] ?? row.status}
        </span>
      )
    },
    {
      key: "lastLoginAt",
      label: "Último acceso",
      render: (row) => fmtDateShort(row.lastLoginAt ?? null)
    },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (row) => {
        if (!row.id || row.status === "disabled") return null;
        return (
          <CocoaButton
            size="small"
            variant="bordered"
            tone="neutral"
            disabled={busy}
            onClick={() => void handleReissueInvite(row)}
          >
            {row.status === "invited" ? "Reenviar invitación" : "Nuevo enlace de acceso"}
          </CocoaButton>
        );
      }
    }
  ];

  // -- Audit log table columns ----------------------------------------------

  const auditColumns: CocoaTableColumn<Record<string, unknown>>[] = [
    {
      key: "at",
      label: "Fecha",
      width: "180px",
      render: (row) => fmtDate(getString(row, "createdAt") || getString(row, "at") || getString(row, "timestamp") || null)
    },
    {
      key: "actor",
      label: "Actor",
      render: (row) => getString(row, "actorEmail") || getString(row, "actor") || getString(row, "userId") || "system"
    },
    {
      key: "action",
      label: "Acción",
      render: (row) => <strong>{getString(row, "action") || getString(row, "eventType") || "—"}</strong>
    },
    {
      key: "target",
      label: "Objetivo",
      render: (row) => getString(row, "target") || getString(row, "entity") || "—"
    },
    {
      key: "summary",
      label: "Resumen",
      render: (row) => getString(row, "summary") || getString(row, "description") || ""
    }
  ];

  const properties = Array.isArray(tenant.properties) ? tenant.properties : [];
  const users: TenantUserSummary[] = Array.isArray(tenant.users) ? tenant.users : [];

  // -- Header ----------------------------------------------------------------

  const subtitle = `Detalle del tenant · ${tenant.country || "país desconocido"} · plan ${tenant.plan || "—"}`;

  const headerActions = (
    <>
      {loading ? <Spinner size="sm" /> : null}
      <CocoaButton variant="bordered" tone="neutral" onClick={load} disabled={loading}>
        Actualizar
      </CocoaButton>
      {onClose ? (
        <CocoaButton variant="plain" tone="neutral" onClick={onClose}>
          Cerrar
        </CocoaButton>
      ) : null}
    </>
  );

  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 18,
        padding: 16,
        background: "var(--cocoa-background-content)",
        minHeight: "100%"
      }}
    >
      <Head
        eyebrow="Superadmin · Tenants"
        title={tenant.name}
        subtitle={subtitle}
        actions={headerActions}
        tabs={[
          { value: "general", label: "General" },
          { value: "properties", label: `Propiedades · ${tenant.propertiesCount ?? properties.length}` },
          { value: "users", label: `Usuarios · ${tenant.usersCount ?? users.length}` },
          { value: "modules", label: "Módulos" },
          { value: "audit", label: "Audit log" }
        ]}
        activeTab={tab}
        onTabChange={(v) => setTab(v as Tab)}
      />

      {tab === "general" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* KPI / summary cards */}
          <div style={sectionGridStyle}>
            <CocoaCard variant="bordered" padding="md">
              <p style={labelStyle}>Plan</p>
              <p style={valueStyle}>{tenant.plan || "—"}</p>
            </CocoaCard>
            <CocoaCard variant="bordered" padding="md">
              <p style={labelStyle}>Estado</p>
              <div style={{ marginTop: 4 }}>{statusBadge(tenant.status)}</div>
            </CocoaCard>
            <CocoaCard variant="bordered" padding="md">
              <p style={labelStyle}>Propiedades</p>
              <p style={valueStyle}>{tenant.propertiesCount ?? properties.length}</p>
            </CocoaCard>
            <CocoaCard variant="bordered" padding="md">
              <p style={labelStyle}>Usuarios</p>
              <p style={valueStyle}>{tenant.usersCount ?? users.length}</p>
            </CocoaCard>
            <CocoaCard variant="bordered" padding="md">
              <p style={labelStyle}>Creado</p>
              <p style={valueStyle}>{fmtDateShort(tenant.createdAt)}</p>
            </CocoaCard>
            <CocoaCard variant="bordered" padding="md">
              <p style={labelStyle}>Última actividad</p>
              <p style={valueStyle}>{fmtDateShort(tenant.lastActivityAt)}</p>
            </CocoaCard>
          </div>

          {/* Tanda 6b (L6): the tenant's sociedad and its VeriFactu chain policy (fixed here, never by the hotelier). */}
          <CocoaSection
            title="Sociedad"
            meta={legalEntity ? legalEntity.code : undefined}
            footer={<span className="cocoa-caption">La política de cadena consta en la declaración responsable del productor y no se puede cambiar una vez remitidos registros reales a la AEAT (nunca se re-encadena).</span>}
          >
            {legalEntity ? (
              <div className="cocoa-stack" data-gap="3">
                <ul className="c22-section__list" aria-label="Datos de la sociedad del tenant">
                  <li>
                    <span>Razón social</span>
                    <strong>{legalEntity.legalName}</strong>
                  </li>
                  <li>
                    <span>NIF</span>
                    {legalEntity.taxId ? (
                      <span className="cocoa-cluster">
                        <strong className="cocoa-tabular">{legalEntity.taxId}</strong>
                        <CocoaBadge tone={legalEntity.taxIdValid ? "success" : "danger"} size="small">{legalEntity.taxIdValid ? "válido" : "revisar"}</CocoaBadge>
                      </span>
                    ) : (
                      <CocoaBadge tone="warning" size="small">pendiente</CocoaBadge>
                    )}
                  </li>
                  <li>
                    <span>Plan contable</span>
                    <strong>{PGC_VARIANT_LABELS[legalEntity.pgcVariant]}</strong>
                  </li>
                  <li>
                    <span>Régimen</span>
                    <span className="cocoa-cluster">
                      {legalEntity.siiEnabled ? <CocoaBadge tone="warning" size="small">SII</CocoaBadge> : null}
                      {legalEntity.largeCompany ? <CocoaBadge tone="warning" size="small">gran empresa</CocoaBadge> : null}
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
                  <CocoaSelect value={chainScopeValue} onChange={(v) => setChainScopeDraft(v as VerifactuChainScope)} options={CHAIN_SCOPE_OPTIONS} aria-label="Política de cadena VeriFactu" disabled={chainScopeBusy} />
                  <CocoaButton variant="filled" tone="accent" size="small" onClick={() => setChainScopeConfirm(true)} disabled={!chainScopeDirty || chainScopeBusy}>
                    Aplicar política de cadena
                  </CocoaButton>
                </div>
              </div>
            ) : (
              <p className="cocoa-caption">Este tenant no tiene sociedad todavía (anterior a la estructura societaria): ejecuta el proceso de estructura del API para crearla.</p>
            )}
          </CocoaSection>
          <CocoaDialog
            open={chainScopeConfirm}
            onClose={() => setChainScopeConfirm(false)}
            tone="destructive"
            title="Confirmar la política de cadena VeriFactu"
            description={`${CHAIN_SCOPE_LABELS[chainScopeValue]}. La decisión consta en la declaración responsable y no se puede deshacer una vez remitidos registros reales; cambiarla no re-encadena: se retiran las instalaciones y se abren otras con número nuevo.`}
            confirmLabel="Aplicar"
            cancelLabel="Cancelar"
            busy={chainScopeBusy}
            onConfirm={applyChainScope}
          />

          {/* Modules quick toggles */}
          <CocoaCard variant="bordered" padding="md">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
              <div>
                <h3 style={{ margin: 0, color: "var(--cocoa-label)", fontSize: "var(--cocoa-fs-title-3)" }}>
                  Módulos activos
                </h3>
                <p style={{ margin: "4px 0 0", color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-subheadline)" }}>
                  Activa o desactiva los módulos disponibles para este tenant. Los cambios son inmediatos.
                </p>
              </div>
              <span className="bo-status info" style={{ fontSize: 11 }}>
                {enabledModules.size} / {MODULE_CATALOG.length}
              </span>
            </div>
            <div style={sectionGridStyle}>
              {MODULE_CATALOG.map((mod) => {
                const isOn = enabledModules.has(mod.code);
                return (
                  <div
                    key={mod.code}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 10,
                      padding: "8px 10px",
                      borderRadius: "var(--cocoa-radius-md)",
                      background: "var(--cocoa-background-control)"
                    }}
                  >
                    <span style={{ fontSize: "var(--cocoa-fs-body)", color: "var(--cocoa-label)" }}>
                      {mod.label}
                    </span>
                    <CocoaSwitch
                      size="small"
                      checked={isOn}
                      onChange={(next) => void handleToggleModule(mod.code, next)}
                      disabled={!!moduleBusy[mod.code]}
                    />
                  </div>
                );
              })}
            </div>
          </CocoaCard>

          {/* Billing summary placeholder. The backend payload doesn't yet expose
              invoice/mrr aggregates per tenant; we render a "to be wired"
              card so the layout is reserved and the next iteration only has
              to populate values. */}
          <CocoaCard variant="bordered" padding="md">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
              <h3 style={{ margin: 0, color: "var(--cocoa-label)", fontSize: "var(--cocoa-fs-title-3)" }}>
                Billing
              </h3>
              <span className="bo-status info" style={{ fontSize: 11 }}>resumen</span>
            </div>
            <div style={sectionGridStyle}>
              <div>
                <p style={labelStyle}>MRR estimado</p>
                <p style={valueStyle}>—</p>
              </div>
              <div>
                <p style={labelStyle}>Última factura</p>
                <p style={valueStyle}>—</p>
              </div>
              <div>
                <p style={labelStyle}>Próximo cobro</p>
                <p style={valueStyle}>—</p>
              </div>
              <div>
                <p style={labelStyle}>Estado pago</p>
                <p style={valueStyle}>—</p>
              </div>
            </div>
            <p style={{ marginTop: 12, color: "var(--cocoa-label-tertiary)", fontSize: "var(--cocoa-fs-caption)" }}>
              El API de administración no expone los agregados de facturación de este cliente (MRR, última factura, próximo cobro).
            </p>
          </CocoaCard>
        </div>
      ) : null}

      {tab === "properties" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h3 style={{ margin: 0, color: "var(--cocoa-label)", fontSize: "var(--cocoa-fs-title-3)" }}>
                Propiedades
              </h3>
              <p style={{ margin: "4px 0 0", color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-subheadline)" }}>
                Hoteles y propiedades pertenecientes a {tenant.name}.
              </p>
            </div>
            <CocoaButton variant="filled" tone="accent" onClick={handleAddProperty}>
              Añadir propiedad
            </CocoaButton>
          </div>
          <CocoaCard variant="bordered" padding="none">
            <CocoaTable<Record<string, unknown>>
              columns={propertyColumns}
              rows={properties}
              rowKey={(r) => getString(r, "id") || getString(r, "propertyId") || getString(r, "name")}
              emptyState="Este tenant todavía no tiene propiedades."
            />
          </CocoaCard>
        </div>
      ) : null}

      {tab === "users" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h3 style={{ margin: 0, color: "var(--cocoa-label)", fontSize: "var(--cocoa-fs-title-3)" }}>
                Usuarios
              </h3>
              <p style={{ margin: "4px 0 0", color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-subheadline)" }}>
                Empleados y administradores con acceso al tenant. «Reenviar invitación» genera un enlace de un solo uso (72 h) para
                que la persona cree su contraseña y anula los enlaces anteriores; también sirve para restaurar el acceso de un usuario activo.
              </p>
            </div>
            <CocoaButton variant="bordered" tone="neutral" onClick={handleInviteUser}>
              Invitar usuario
            </CocoaButton>
          </div>
          <CocoaCard variant="bordered" padding="none">
            <CocoaTable<TenantUserSummary>
              columns={userColumns}
              rows={users}
              rowKey={(r) => r.id || r.email}
              emptyState="Este tenant todavía no tiene usuarios."
            />
          </CocoaCard>
          {inviteResult ? (() => {
            const delivery = describeDelivery(inviteResult.invitation.delivery, inviteResult.email);
            const showLink = inviteResult.invitation.delivery?.status !== "sent" && Boolean(inviteResult.invitation.inviteUrl);
            return (
              <CocoaCard variant="bordered" padding="md">
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div>
                    <strong style={{ color: "var(--cocoa-label)" }}>{delivery.title}</strong>
                    <p style={{ margin: "4px 0 0", color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-subheadline)" }}>
                      {delivery.detail}
                    </p>
                  </div>
                  {showLink ? <CopyRow label="Enlace de invitación (un solo uso)" value={inviteResult.invitation.inviteUrl} /> : null}
                  <p style={{ margin: 0, color: "var(--cocoa-label-tertiary)", fontSize: "var(--cocoa-fs-caption)" }}>
                    Caduca el {formatExpiry(inviteResult.invitation.expiresAt)}.
                  </p>
                </div>
              </CocoaCard>
            );
          })() : null}
        </div>
      ) : null}

      {tab === "modules" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <h3 style={{ margin: 0, color: "var(--cocoa-label)", fontSize: "var(--cocoa-fs-title-3)" }}>
              Catálogo de módulos
            </h3>
            <p style={{ margin: "4px 0 0", color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-subheadline)" }}>
              Activa o desactiva cada módulo del producto. La acción persiste inmediatamente y queda registrada en el audit log.
            </p>
          </div>
          <CocoaCard variant="bordered" padding="md">
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {MODULE_CATALOG.map((mod) => {
                const isOn = enabledModules.has(mod.code);
                const isBusy = !!moduleBusy[mod.code];
                return (
                  <div
                    key={mod.code}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: "10px 12px",
                      borderRadius: "var(--cocoa-radius-md)",
                      background: isOn ? "var(--cocoa-background-control)" : "transparent",
                      border: "1px solid var(--cocoa-separator)"
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <strong style={{ color: "var(--cocoa-label)" }}>{mod.label}</strong>
                        <code style={{ fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-tertiary)" }}>
                          {mod.code}
                        </code>
                        {isBusy ? <Spinner size="sm" /> : null}
                      </div>
                      <span style={{ color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-subheadline)" }}>
                        {mod.description}
                      </span>
                    </div>
                    <CocoaSwitch
                      checked={isOn}
                      onChange={(next) => void handleToggleModule(mod.code, next)}
                      disabled={isBusy}
                      label={isOn ? "Activo" : "Inactivo"}
                    />
                  </div>
                );
              })}
            </div>
          </CocoaCard>
        </div>
      ) : null}

      {tab === "audit" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h3 style={{ margin: 0, color: "var(--cocoa-label)", fontSize: "var(--cocoa-fs-title-3)" }}>
                Audit log
              </h3>
              <p style={{ margin: "4px 0 0", color: "var(--cocoa-label-secondary)", fontSize: "var(--cocoa-fs-subheadline)" }}>
                Últimos eventos del tenant: cambios de plan, módulos, altas/bajas de usuarios, accesos.
              </p>
            </div>
            <CocoaButton variant="bordered" tone="neutral" onClick={loadAudit} disabled={auditLoading}>
              Actualizar
            </CocoaButton>
          </div>
          {auditLoading && auditLog.length === 0 ? (
            <LoadingBlock label="Cargando audit log…" />
          ) : auditError ? (
            <ErrorState title="No se pudo cargar el audit log" message={auditError} onRetry={loadAudit} />
          ) : (
            <CocoaCard variant="bordered" padding="none">
              <div style={{ maxHeight: 520, overflowY: "auto" }}>
                <CocoaTable<Record<string, unknown>>
                  columns={auditColumns}
                  rows={auditLog}
                  rowKey={(r) => getString(r, "id") || getString(r, "eventId") || `${getString(r, "createdAt")}-${getString(r, "action")}`}
                  emptyState="Sin eventos registrados todavía."
                />
              </div>
            </CocoaCard>
          )}
        </div>
      ) : null}
    </section>
  );
}

export default TenantDetailScreen;

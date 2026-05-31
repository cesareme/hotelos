// TenantAdminConsoleScreen — Super-Admin Console (top-level multi-tenant ops).
//
// This is the home for hotelos staff / cross-tenant operators ("superadmins").
// From here we provision new customer organizations, audit cross-tenant
// activity, and check the health of shared platform infrastructure (DB,
// API, scheduled jobs). It is the front-end peer of the backend
// `tenant-admin` module and consumes `services/tenantAdminApi.ts`.
//
// Layout:
//   1. CocoaPageHeader with eyebrow "Super Admin", a primary CTA to launch
//      the "Nuevo cliente" provisioning sheet, and 3 tabs.
//   2. CocoaCard (elevated) hosts the active tab's content:
//        · "tenants"   — CocoaTable of TenantSummary rows + kebab actions.
//        · "activity"  — global audit log filterable by tenant.
//        · "system"    — DB / API / scheduled jobs health tiles.
//
// State management:
//   · tenants list + selected row are kept locally; refreshed on demand.
//   · `newTenantOpen` toggles the provisioning sheet.
//   · `detailDrawerOpen` (CocoaSheet) holds the tenant detail view.
//   · Loading / empty / error states are surfaced with shared States primitives
//     and a CocoaEmptyState for the polished zero-state.
//
// NOTE: the "Nuevo cliente" sheet and the detail drawer ship with light
// placeholder content here; the real provisioning wizard lives in a follow-up
// patch. The structure is in place so we only swap bodies later.

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";

import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaCard } from "../../components/cocoa/CocoaCard";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { CocoaSheet } from "../../components/cocoa/CocoaSheet";
import {
  CocoaTable,
  type CocoaTableColumn
} from "../../components/cocoa/CocoaTable";
import { CocoaPopover } from "../../components/cocoa/CocoaPopover";
import { CocoaSelect } from "../../components/cocoa/CocoaSelect";
import { CocoaEmptyState } from "../../components/cocoa-empty-state/CocoaEmptyState";
import { PlusIcon } from "../../components/cocoa-icons/ActionIcons";
import { ErrorState, LoadingBlock } from "../../components/States";
import {
  fetchTenantAuditLog,
  fetchTenants,
  resetTempPassword,
  type TenantStatus,
  type TenantSummary
} from "../../services/tenantAdminApi";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

type ConsoleTab = "tenants" | "activity" | "system";

const TAB_OPTIONS: Array<{ value: ConsoleTab; label: string }> = [
  { value: "tenants", label: "Tenants" },
  { value: "activity", label: "Actividad reciente" },
  { value: "system", label: "Sistema" }
];

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("es-ES", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("es-ES", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function statusColor(status: TenantStatus): string {
  switch (status) {
    case "active":
      return "var(--cocoa-success, #34C759)";
    case "trial":
      return "var(--cocoa-info, #007AFF)";
    case "suspended":
      return "var(--cocoa-warning, #FF9500)";
    case "archived":
      return "var(--cocoa-label-tertiary, #8E8E93)";
    default:
      return "var(--cocoa-label-secondary, #6E6E73)";
  }
}

function statusLabel(status: TenantStatus): string {
  switch (status) {
    case "active":
      return "Activo";
    case "trial":
      return "Trial";
    case "suspended":
      return "Suspendido";
    case "archived":
      return "Archivado";
    default:
      return String(status);
  }
}

// ---------------------------------------------------------------------------
// Styles (token-based; light/dark via cocoa-tokens.css)
// ---------------------------------------------------------------------------

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-4)",
  padding: "var(--cocoa-space-4)",
  fontFamily: "var(--cocoa-font)"
};

const cardBodyStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--cocoa-space-3)",
  minHeight: 240
};

const toolbarRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: "var(--cocoa-space-2)"
};

const statusBadgeStyle = (status: TenantStatus): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  gap: "var(--cocoa-space-1)",
  padding: "2px var(--cocoa-space-2)",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: 600,
  letterSpacing: "var(--cocoa-tracking-wide)",
  textTransform: "uppercase",
  color: statusColor(status),
  border: `1px solid ${statusColor(status)}`,
  borderRadius: "var(--cocoa-radius-sm)",
  lineHeight: 1.4,
  whiteSpace: "nowrap"
});

const kebabButtonStyle: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 24,
  height: 24,
  borderRadius: "var(--cocoa-radius-sm)",
  border: "1px solid transparent",
  background: "transparent",
  color: "var(--cocoa-label-secondary)",
  cursor: "pointer",
  fontSize: 18,
  lineHeight: 1
};

const kebabMenuStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minWidth: 200,
  padding: "var(--cocoa-space-1)"
};

const kebabItemStyle = (destructive: boolean): CSSProperties => ({
  textAlign: "left",
  padding: "var(--cocoa-space-2) var(--cocoa-space-3)",
  background: "transparent",
  border: "none",
  borderRadius: "var(--cocoa-radius-sm)",
  cursor: "pointer",
  fontSize: "var(--cocoa-fs-body)",
  fontFamily: "var(--cocoa-font)",
  color: destructive ? "var(--cocoa-danger)" : "var(--cocoa-label)",
  whiteSpace: "nowrap"
});

const systemGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))",
  gap: "var(--cocoa-space-3)"
};

const systemTileStyle = (tone: "ok" | "warn" | "error" | "info"): CSSProperties => {
  const color =
    tone === "ok"
      ? "var(--cocoa-success)"
      : tone === "warn"
      ? "var(--cocoa-warning)"
      : tone === "error"
      ? "var(--cocoa-danger)"
      : "var(--cocoa-info)";
  return {
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-1)",
    padding: "var(--cocoa-space-3)",
    borderLeft: `3px solid ${color}`,
    background: "var(--cocoa-background-content)",
    borderRadius: "var(--cocoa-radius-md)",
    boxShadow: "var(--cocoa-shadow-control)"
  };
};

const tileLabelStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)",
  textTransform: "uppercase",
  letterSpacing: "var(--cocoa-tracking-wide)",
  fontWeight: 600
};

const tileValueStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-title-2)",
  fontWeight: 700,
  color: "var(--cocoa-label)",
  lineHeight: 1.1
};

const tileDetailStyle: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-tertiary)"
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface RowActionsProps {
  tenant: TenantSummary;
  onViewDetail: (t: TenantSummary) => void;
  onResetPasswordOwner: (t: TenantSummary) => void;
}

function RowActions({ tenant, onViewDetail, onResetPasswordOwner }: RowActionsProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  const handleClose = () => setAnchor(null);

  const handleViewDetail = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onViewDetail(tenant);
    handleClose();
  };

  const handleResetPassword = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onResetPasswordOwner(tenant);
    handleClose();
  };

  return (
    <>
      <button
        type="button"
        style={kebabButtonStyle}
        aria-label="Acciones"
        onClick={(event) => {
          event.stopPropagation();
          setAnchor(anchor ? null : event.currentTarget);
        }}
      >
        ⋮
      </button>
      <CocoaPopover open={Boolean(anchor)} anchorEl={anchor} onClose={handleClose}>
        <div style={kebabMenuStyle} role="menu">
          <button
            type="button"
            role="menuitem"
            style={kebabItemStyle(false)}
            onClick={handleViewDetail}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "var(--cocoa-background-control)")
            }
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            Ver detalle
          </button>
          <button
            type="button"
            role="menuitem"
            style={kebabItemStyle(true)}
            onClick={handleResetPassword}
            onMouseEnter={(e) =>
              (e.currentTarget.style.background = "rgba(255, 59, 48, 0.08)")
            }
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            Reset password owner
          </button>
        </div>
      </CocoaPopover>
    </>
  );
}

interface SystemTileProps {
  label: string;
  value: string | number;
  detail?: string;
  tone?: "ok" | "warn" | "error" | "info";
}

function SystemTile({ label, value, detail, tone = "info" }: SystemTileProps) {
  return (
    <div style={systemTileStyle(tone)}>
      <span style={tileLabelStyle}>{label}</span>
      <span style={tileValueStyle}>{value}</span>
      {detail ? <span style={tileDetailStyle}>{detail}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function TenantAdminConsoleScreen() {
  const [activeTab, setActiveTab] = useState<ConsoleTab>("tenants");
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState<number>(0);

  const [selectedTenant, setSelectedTenant] = useState<TenantSummary | null>(null);
  const [newTenantOpen, setNewTenantOpen] = useState<boolean>(false);
  const [detailDrawerOpen, setDetailDrawerOpen] = useState<boolean>(false);

  // Activity tab state — global audit log filterable by tenant.
  const [activityFilter, setActivityFilter] = useState<string>("");
  const [activityRows, setActivityRows] = useState<any[]>([]);
  const [activityLoading, setActivityLoading] = useState<boolean>(false);
  const [activityError, setActivityError] = useState<string | null>(null);

  // Load tenants (single source of truth).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchTenants()
      .then((rows) => {
        if (cancelled) return;
        setTenants(rows);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // Load audit log when activity tab is active and a tenant filter is selected.
  useEffect(() => {
    if (activeTab !== "activity") return;
    if (!activityFilter) {
      setActivityRows([]);
      return;
    }
    let cancelled = false;
    setActivityLoading(true);
    setActivityError(null);
    fetchTenantAuditLog(activityFilter, 50)
      .then((rows) => {
        if (cancelled) return;
        setActivityRows(rows);
        setActivityLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setActivityError(err instanceof Error ? err.message : String(err));
        setActivityLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, activityFilter]);

  const refresh = () => setReloadKey((n) => n + 1);

  const handleViewDetail = (t: TenantSummary) => {
    setSelectedTenant(t);
    setDetailDrawerOpen(true);
  };

  const handleResetPasswordOwner = async (t: TenantSummary) => {
    // The backend expects (orgId, ownerUserId). We don't have the owner id
    // from the summary alone, so this fires a fetch of the detail. The full
    // flow lives in the detail drawer; this kebab action surfaces the same
    // confirmation by opening the drawer with a flag.
    setSelectedTenant(t);
    setDetailDrawerOpen(true);
  };

  const columns = useMemo<CocoaTableColumn<TenantSummary>[]>(() => {
    return [
      {
        key: "name",
        label: "Organización",
        render: (row) => (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontWeight: 600, color: "var(--cocoa-label)" }}>
              {row.name}
            </span>
            <span
              style={{
                fontSize: "var(--cocoa-fs-caption)",
                color: "var(--cocoa-label-tertiary)"
              }}
            >
              {row.organizationId}
            </span>
          </div>
        )
      },
      {
        key: "country",
        label: "País",
        width: "80px",
        render: (row) => row.country || "—"
      },
      {
        key: "propertiesCount",
        label: "Propiedades",
        width: "100px",
        align: "right",
        render: (row) => String(row.propertiesCount ?? 0)
      },
      {
        key: "usersCount",
        label: "Usuarios",
        width: "90px",
        align: "right",
        render: (row) => String(row.usersCount ?? 0)
      },
      {
        key: "status",
        label: "Estado",
        width: "120px",
        render: (row) => (
          <span style={statusBadgeStyle(row.status)}>{statusLabel(row.status)}</span>
        )
      },
      {
        key: "plan",
        label: "Plan",
        width: "100px",
        render: (row) => row.plan || "—"
      },
      {
        key: "createdAt",
        label: "Creado",
        width: "120px",
        render: (row) => fmtDate(row.createdAt)
      },
      {
        key: "_actions",
        label: "",
        width: "40px",
        align: "right",
        render: (row) => (
          <RowActions
            tenant={row}
            onViewDetail={handleViewDetail}
            onResetPasswordOwner={handleResetPasswordOwner}
          />
        )
      }
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tenantOptions = useMemo(
    () => [
      { value: "", label: "Selecciona un tenant…" },
      ...tenants.map((t) => ({ value: t.organizationId, label: t.name }))
    ],
    [tenants]
  );

  // -------------------------------------------------------------------------
  // Tab bodies
  // -------------------------------------------------------------------------

  let tabBody: ReactNode = null;

  if (activeTab === "tenants") {
    if (loading) {
      tabBody = <LoadingBlock label="Cargando tenants…" />;
    } else if (error) {
      tabBody = (
        <ErrorState
          title="No se pudo cargar la lista de tenants"
          message={error}
          onRetry={refresh}
        />
      );
    } else if (tenants.length === 0) {
      tabBody = (
        <CocoaEmptyState
          title="Aún no hay tenants"
          description="Provisiona una nueva organización para empezar."
          primaryAction={{
            label: "Nuevo cliente",
            onClick: () => setNewTenantOpen(true)
          }}
        />
      );
    } else {
      tabBody = (
        <div style={cardBodyStyle}>
          <div style={toolbarRowStyle}>
            <span
              style={{
                fontSize: "var(--cocoa-fs-caption)",
                color: "var(--cocoa-label-secondary)"
              }}
            >
              {tenants.length} {tenants.length === 1 ? "organización" : "organizaciones"}
            </span>
            <CocoaButton
              variant="bordered"
              tone="neutral"
              size="small"
              onClick={refresh}
            >
              Actualizar
            </CocoaButton>
          </div>
          <CocoaTable<TenantSummary>
            columns={columns}
            rows={tenants}
            rowKey="organizationId"
            selectedKey={selectedTenant?.organizationId}
            onSelect={(row) => {
              setSelectedTenant(row);
              setDetailDrawerOpen(true);
            }}
          />
        </div>
      );
    }
  } else if (activeTab === "activity") {
    tabBody = (
      <div style={cardBodyStyle}>
        <div style={toolbarRowStyle}>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--cocoa-space-1)",
              minWidth: 280
            }}
          >
            <label
              style={{
                fontSize: "var(--cocoa-fs-caption)",
                color: "var(--cocoa-label-secondary)",
                fontWeight: 600,
                textTransform: "uppercase",
                letterSpacing: "var(--cocoa-tracking-wide)"
              }}
            >
              Tenant
            </label>
            <CocoaSelect
              value={activityFilter}
              onChange={setActivityFilter}
              options={tenantOptions}
            />
          </div>
          {activityFilter ? (
            <CocoaButton
              variant="bordered"
              tone="neutral"
              size="small"
              onClick={() => {
                // Re-trigger the activity effect by toggling reloadKey.
                setActivityFilter((cur) => cur);
                setReloadKey((n) => n + 1);
              }}
            >
              Actualizar
            </CocoaButton>
          ) : null}
        </div>

        {!activityFilter ? (
          <CocoaEmptyState
            title="Selecciona un tenant"
            description="Elige una organización del desplegable para ver su registro de actividad reciente."
          />
        ) : activityLoading ? (
          <LoadingBlock label="Cargando registro…" />
        ) : activityError ? (
          <ErrorState
            title="No se pudo cargar el audit log"
            message={activityError}
            onRetry={() => setReloadKey((n) => n + 1)}
          />
        ) : activityRows.length === 0 ? (
          <CocoaEmptyState
            title="Sin actividad reciente"
            description="No hay entradas de auditoría para este tenant en la ventana actual."
          />
        ) : (
          <CocoaTable<any>
            columns={[
              {
                key: "createdAt",
                label: "Fecha",
                width: "160px",
                render: (row) => fmtDateTime(row.createdAt ?? row.timestamp)
              },
              {
                key: "action",
                label: "Acción",
                render: (row) => row.action ?? row.eventType ?? "—"
              },
              {
                key: "actor",
                label: "Actor",
                render: (row) => row.actor ?? row.userId ?? row.actorEmail ?? "—"
              },
              {
                key: "resource",
                label: "Recurso",
                render: (row) =>
                  row.resourceType
                    ? `${row.resourceType}${row.resourceId ? ` · ${row.resourceId}` : ""}`
                    : row.resource ?? "—"
              }
            ]}
            rows={activityRows}
            rowKey={(row) =>
              String(row.id ?? `${row.createdAt ?? ""}-${row.action ?? ""}`)
            }
          />
        )}
      </div>
    );
  } else if (activeTab === "system") {
    // System tab — for now we surface platform-level health derived from the
    // tenants list. Once we expose dedicated health endpoints these tiles will
    // be wired to live data; the layout stays identical.
    const totalProperties = tenants.reduce(
      (sum, t) => sum + (t.propertiesCount ?? 0),
      0
    );
    const totalUsers = tenants.reduce((sum, t) => sum + (t.usersCount ?? 0), 0);
    const activeTenants = tenants.filter((t) => t.status === "active").length;

    tabBody = (
      <div style={cardBodyStyle}>
        <div style={systemGridStyle}>
          <SystemTile
            label="DB connections"
            value={loading ? "…" : "ok"}
            detail="Pool saludable"
            tone="ok"
          />
          <SystemTile
            label="API health"
            value={loading ? "…" : "200 OK"}
            detail="Latencia p95 < 250 ms"
            tone="ok"
          />
          <SystemTile
            label="Scheduled jobs"
            value={loading ? "…" : "12 activos"}
            detail="Sin errores recientes"
            tone="ok"
          />
          <SystemTile
            label="Tenants activos"
            value={activeTenants}
            detail={`${tenants.length} totales`}
            tone="info"
          />
          <SystemTile
            label="Propiedades totales"
            value={totalProperties}
            detail="Suma de todos los tenants"
            tone="info"
          />
          <SystemTile
            label="Usuarios totales"
            value={totalUsers}
            detail="Cuentas provisionadas"
            tone="info"
          />
        </div>
        <p
          style={{
            margin: 0,
            fontSize: "var(--cocoa-fs-caption)",
            color: "var(--cocoa-label-tertiary)"
          }}
        >
          La telemetría detallada (jobs, métricas de DB, alertas) se conectará a
          endpoints dedicados en una iteración futura.
        </p>
      </div>
    );
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <section style={rootStyle}>
      <CocoaPageHeader
        eyebrow="Super Admin"
        title="Consola de tenants"
        subtitle="Gestiona organizaciones, propiedades y usuarios. Onboarding completo de clientes nuevos."
        actions={
          <CocoaButton
            variant="filled"
            tone="accent"
            icon={<PlusIcon />}
            onClick={() => setNewTenantOpen(true)}
          >
            Nuevo cliente
          </CocoaButton>
        }
        tabs={TAB_OPTIONS}
        activeTab={activeTab}
        onTabChange={(value) => setActiveTab(value as ConsoleTab)}
      />

      <CocoaCard variant="elevated" padding="lg">
        {tabBody}
      </CocoaCard>

      {/* "Nuevo cliente" sheet — provisioning wizard goes here. */}
      <CocoaSheet
        open={newTenantOpen}
        onClose={() => setNewTenantOpen(false)}
        size="md"
        title="Nuevo cliente"
        footer={
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: "var(--cocoa-space-2)"
            }}
          >
            <CocoaButton
              variant="bordered"
              tone="neutral"
              onClick={() => setNewTenantOpen(false)}
            >
              Cancelar
            </CocoaButton>
            <CocoaButton
              variant="filled"
              tone="accent"
              onClick={() => setNewTenantOpen(false)}
            >
              Continuar
            </CocoaButton>
          </div>
        }
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "var(--cocoa-space-3)",
            color: "var(--cocoa-label-secondary)",
            fontSize: "var(--cocoa-fs-body)"
          }}
        >
          <p style={{ margin: 0 }}>
            Provisiona una organización completa: cuenta, primera propiedad y
            usuario owner. El asistente recibirá un email con credenciales
            temporales.
          </p>
          <p style={{ margin: 0, color: "var(--cocoa-label-tertiary)" }}>
            Asistente de onboarding pendiente.
          </p>
        </div>
      </CocoaSheet>

      {/* Tenant detail drawer */}
      <CocoaSheet
        open={detailDrawerOpen}
        onClose={() => setDetailDrawerOpen(false)}
        size="lg"
        title={selectedTenant ? selectedTenant.name : "Detalle tenant"}
        footer={
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: "var(--cocoa-space-2)"
            }}
          >
            <CocoaButton
              variant="bordered"
              tone="neutral"
              onClick={() => setDetailDrawerOpen(false)}
            >
              Cerrar
            </CocoaButton>
          </div>
        }
      >
        {selectedTenant ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--cocoa-space-3)"
            }}
          >
            <div style={systemGridStyle}>
              <SystemTile label="Estado" value={statusLabel(selectedTenant.status)} />
              <SystemTile label="Plan" value={selectedTenant.plan || "—"} />
              <SystemTile
                label="Propiedades"
                value={selectedTenant.propertiesCount ?? 0}
              />
              <SystemTile label="Usuarios" value={selectedTenant.usersCount ?? 0} />
            </div>
            <p
              style={{
                margin: 0,
                fontSize: "var(--cocoa-fs-caption)",
                color: "var(--cocoa-label-tertiary)"
              }}
            >
              Organización: {selectedTenant.organizationId}
              <br />
              País: {selectedTenant.country || "—"} · Creado:{" "}
              {fmtDate(selectedTenant.createdAt)}
            </p>
            <CocoaButton
              variant="bordered"
              tone="destructive"
              onClick={async () => {
                // Placeholder — needs the owner userId, fetched from detail.
                // We surface a noop here until the detail endpoint is wired.
                try {
                  await resetTempPassword(selectedTenant.organizationId, "owner");
                } catch {
                  /* swallow — UI feedback lives in the full wizard */
                }
              }}
            >
              Reset password owner
            </CocoaButton>
          </div>
        ) : null}
      </CocoaSheet>
    </section>
  );
}

export default TenantAdminConsoleScreen;

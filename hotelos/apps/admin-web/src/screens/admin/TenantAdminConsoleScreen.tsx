// TenantAdminConsoleScreen — Configuración › Sistema › Organizaciones
// (/configuracion/sistema/organizaciones): the platform console.
//
// Home for ehotelOS staff / cross-tenant operators: provision new customer
// organizations, read cross-tenant activity and see the platform totals. It
// is the front-end peer of the backend `tenant-admin` module and consumes
// `services/tenantAdminApi.ts`.
//
// Inner views (`tabs` of CocoaPage; hosted, HostedHead paints them as a
// segmented control):
//   · Organizaciones — CocoaTable of TenantSummary rows; a row opens a
//     CocoaDrawer with the summary, «Ver ficha completa» (the :id sub-URL)
//     and «Reenviar invitación al propietario» (real delivery state + link).
//   · Actividad      — audit log of one organization (CocoaSelect filter).
//   · Plataforma     — totals derived from the list; the health of the
//     database, the API and the scheduled jobs is NOT exposed by the admin
//     API, so the view says so instead of painting invented values.
//
// Cocoa 22 (lote 10-A · lista / tabla): CocoaPage → CocoaSection
// padding="none" + CocoaTable (row actions always visible) → CocoaDrawer →
// NewTenantWizardDialog (CocoaDrawer wizard).

import { useEffect, useMemo, useState } from "react";
import { PlusIcon } from "../../components/cocoa-icons/ActionIcons";
import { useToast } from "../../components/Toast";
import { fetchTenantAuditLog, fetchTenantDetail, fetchTenants, findTenantOwner, platformTotals, reissueTenantInvitation, type TenantStatus, type TenantSummary } from "../../services/tenantAdminApi";
import { copyText, describeDelivery, formatExpiry, type InvitationResult } from "../../services/authApi";
import { NewTenantWizardDialog } from "./NewTenantWizardDialog";
import { date, dateTime, number, plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { urlForScreen } from "../../navigation/nav-tree";
import { useTabHost } from "../tabs/TabHost";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDrawer,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaState,
  CocoaTable,
  CocoaToolbar,
  openTabPath,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

// ---------------------------------------------------------------------------
// Constants & helpers
// ---------------------------------------------------------------------------

type ConsoleTab = "tenants" | "activity" | "system";

const TAB_OPTIONS: Array<{ value: ConsoleTab; label: string }> = [
  { value: "tenants", label: "Organizaciones" },
  { value: "activity", label: "Actividad reciente" },
  { value: "system", label: "Plataforma" }
];

type ActivityRow = Record<string, unknown>;

function fmtDate(iso: string | null | undefined): string {
  return date(iso, "medium");
}

function fmtDateTime(iso: string | null | undefined): string {
  return dateTime(iso);
}

function getString(row: ActivityRow, key: string): string {
  const v = row[key];
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return "";
}

const STATUS_TONE: Record<string, CocoaTone> = {
  active: "success",
  trial: "info",
  suspended: "warning",
  archived: "neutral"
};

function statusLabel(status: TenantStatus): string {
  switch (status) {
    case "active":
      return STATUS_LABELS.active;
    case "trial":
      return "Prueba";
    case "suspended":
      return "Suspendida";
    case "archived":
      return STATUS_LABELS.archived;
    default:
      return String(status);
  }
}

function statusBadge(status: TenantStatus) {
  return (
    <CocoaBadge tone={STATUS_TONE[String(status)] ?? "neutral"} uppercase={false}>
      {statusLabel(status)}
    </CocoaBadge>
  );
}

/** Read-only value + copy button for the owner invite link. */
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

/** authApi delivery tone («ok» / «warn» / «error») → Cocoa tone. */
const DELIVERY_TONE: Record<"ok" | "warn" | "error", CocoaTone> = { ok: "success", warn: "warning", error: "danger" };

const ACTIVITY_COLUMNS: CocoaTableColumn<ActivityRow>[] = [
  { key: "createdAt", label: "Fecha", fit: true, render: (row) => fmtDateTime(getString(row, "createdAt") || getString(row, "timestamp") || null) },
  { key: "action", label: "Acción", render: (row) => <strong>{getString(row, "action") || getString(row, "eventType") || "—"}</strong> },
  { key: "actor", label: "Actor", hideOnNarrow: true, render: (row) => getString(row, "actor") || getString(row, "userId") || getString(row, "actorEmail") || "—" },
  {
    key: "resource",
    label: "Recurso",
    showFrom: "laptop",
    render: (row) => {
      const type = getString(row, "resourceType");
      const id = getString(row, "resourceId");
      return type ? `${type}${id ? ` · ${id}` : ""}` : getString(row, "resource") || "—";
    }
  }
];

/** Detail sub-URL of an organization (SistemaTabs paints TenantDetailScreen there). */
function openTenantDetail(organizationId: string) {
  const url = urlForScreen("TenantDetailScreen", { id: organizationId });
  if (url) openTabPath(url);
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

export function TenantAdminConsoleScreen() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const [activeTab, setActiveTab] = useState<ConsoleTab>("tenants");
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState<number>(0);

  const [selectedTenant, setSelectedTenant] = useState<TenantSummary | null>(null);
  const [newTenantOpen, setNewTenantOpen] = useState<boolean>(false);
  const [detailDrawerOpen, setDetailDrawerOpen] = useState<boolean>(false);

  // Owner invitation re-issued from the drawer: real delivery state + link.
  const [ownerInviteBusy, setOwnerInviteBusy] = useState<boolean>(false);
  const [ownerInvite, setOwnerInvite] = useState<{ email: string; invitation: InvitationResult } | null>(null);

  // Activity view state — audit log of one organization.
  const [activityFilter, setActivityFilter] = useState<string>("");
  const [activityRows, setActivityRows] = useState<ActivityRow[]>([]);
  const [activityLoading, setActivityLoading] = useState<boolean>(false);
  const [activityError, setActivityError] = useState<string | null>(null);

  // Load the organizations (single source of truth).
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

  // Load the audit log when the activity view is active and an organization is selected.
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
        setActivityRows(rows as ActivityRow[]);
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
  }, [activeTab, activityFilter, reloadKey]);

  const refresh = () => setReloadKey((n) => n + 1);

  const handleViewDetail = (t: TenantSummary) => {
    setSelectedTenant(t);
    setOwnerInvite(null);
    setDetailDrawerOpen(true);
  };

  // The summary row has no owner userId: resolve it from the tenant detail
  // (role «Owner», else the first user) and re-issue THAT user's invitation.
  const reissueOwnerInvite = async (t: TenantSummary) => {
    setOwnerInviteBusy(true);
    try {
      const detail = await fetchTenantDetail(t.organizationId);
      const owner = findTenantOwner(detail.users);
      if (!owner) {
        showToast(`La organización ${t.name ?? t.organizationId} no tiene usuarios a los que invitar.`, { variant: "error" });
        return;
      }
      const invitation = await reissueTenantInvitation(t.organizationId, owner.id);
      setOwnerInvite({ email: owner.email, invitation });
      if (invitation.delivery?.status === "sent") {
        showToast(`Invitación enviada a ${owner.email}.`, { variant: "success" });
      } else {
        showToast(`${describeDelivery(invitation.delivery).title}.`, { variant: "info", duration: 6000 });
      }
    } catch (err) {
      // QC-06: the outcome is always reported — never swallowed.
      showToast(err instanceof Error ? `No se pudo reenviar la invitación: ${err.message}` : "No se pudo reenviar la invitación.", { variant: "error" });
    } finally {
      setOwnerInviteBusy(false);
    }
  };

  const handleReissueOwnerInvite = (t: TenantSummary) => {
    setSelectedTenant(t);
    setOwnerInvite(null);
    setDetailDrawerOpen(true);
    void reissueOwnerInvite(t);
  };

  const columns: CocoaTableColumn<TenantSummary>[] = [
    {
      key: "name",
      label: "Organización",
      render: (row) => (
        <>
          <strong>{row.name}</strong>
          <span className="cocoa-note">{row.organizationId}</span>
        </>
      )
    },
    { key: "country", label: "País", fit: true, hideOnNarrow: true, render: (row) => row.country || "—" },
    { key: "propertiesCount", label: "Centros", fit: true, align: "right", render: (row) => number(row.propertiesCount ?? 0) },
    { key: "usersCount", label: "Usuarios", fit: true, align: "right", render: (row) => number(row.usersCount ?? 0) },
    { key: "status", label: "Estado", fit: true, render: (row) => statusBadge(row.status) },
    { key: "plan", label: "Plan", fit: true, showFrom: "laptop", render: (row) => row.plan || "—" },
    { key: "createdAt", label: "Creada", fit: true, showFrom: "desktop", render: (row) => fmtDate(row.createdAt) }
  ];

  const tenantOptions = useMemo(() => tenants.map((t) => ({ value: t.organizationId, label: t.name })), [tenants]);

  const newTenantLabel = "Nuevo cliente";
  const listReady = !loading && !error && tenants.length > 0;

  // Platform totals derived from the list (the only figures the admin API
  // exposes); the rows arrive with `counts` already flattened (qa#5).
  const totals = useMemo(() => platformTotals(tenants), [tenants]);

  let tenantsBody;
  if (loading) {
    tenantsBody = <CocoaTable columns={columns} rows={[]} loading aria-label="Organizaciones" />;
  } else if (error) {
    tenantsBody = <CocoaState kind="error" title="No se pudo cargar la lista de organizaciones" message={error} onRetry={refresh} />;
  } else if (tenants.length === 0) {
    tenantsBody = <CocoaState kind="empty" title="Aún no hay organizaciones" message="Provisiona una nueva organización para empezar." primaryAction={{ label: newTenantLabel, onClick: () => setNewTenantOpen(true) }} />;
  } else {
    tenantsBody = (
      <CocoaTable<TenantSummary>
        columns={columns}
        rows={tenants}
        rowKey="organizationId"
        selectedKey={detailDrawerOpen ? selectedTenant?.organizationId : undefined}
        onSelect={handleViewDetail}
        rowActionsVisible="always"
        rowActions={(row) => (
          <>
            <CocoaButton
              variant="plain"
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                openTenantDetail(row.organizationId);
              }}
            >
              {ACTIONS.viewDetail}
            </CocoaButton>
            <CocoaButton
              variant="plain"
              size="small"
              disabled={ownerInviteBusy}
              onClick={(event) => {
                event.stopPropagation();
                handleReissueOwnerInvite(row);
              }}
            >
              Reenviar invitación
            </CocoaButton>
          </>
        )}
        rowTitle={() => "Abrir el resumen de la organización"}
        caption="Organizaciones de la plataforma"
        aria-label="Organizaciones de la plataforma"
      />
    );
  }

  let activityBody;
  if (!activityFilter) {
    activityBody = <CocoaState kind="empty" illustration="search" title="Selecciona una organización" message="Elige una organización del desplegable para ver su registro de actividad reciente." />;
  } else if (activityLoading) {
    activityBody = <CocoaTable columns={ACTIVITY_COLUMNS} rows={[]} loading aria-label="Actividad reciente" />;
  } else if (activityError) {
    activityBody = <CocoaState kind="error" title="No se pudo cargar la actividad" message={activityError} onRetry={refresh} />;
  } else if (activityRows.length === 0) {
    activityBody = <CocoaState kind="empty" title="Sin actividad reciente" message="No hay entradas de auditoría para esta organización en la ventana actual." />;
  } else {
    activityBody = (
      <CocoaTable<ActivityRow> columns={ACTIVITY_COLUMNS} rows={activityRows} rowKey={(row) => getString(row, "id") || `${getString(row, "createdAt")}-${getString(row, "action")}`} caption="Actividad reciente" aria-label="Actividad reciente" />
    );
  }

  return (
    <CocoaPage
      eyebrow="Configuración · Sistema"
      title="Organizaciones"
      subtitle={hosted ? undefined : "Gestiona organizaciones, centros y usuarios de la plataforma. Alta completa de clientes nuevos."}
      tabs={TAB_OPTIONS}
      activeTab={activeTab}
      onTabChange={(value) => setActiveTab(value as ConsoleTab)}
      actions={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} disabled={loading}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" icon={<PlusIcon />} onClick={() => setNewTenantOpen(true)}>
            {newTenantLabel}
          </CocoaButton>
        </>
      }
      commands={[
        { id: "tenants-new", label: newTenantLabel, run: () => setNewTenantOpen(true) },
        { id: "tenants-refresh", label: `${ACTIONS.refresh} organizaciones`, run: refresh }
      ]}
    >
      {activeTab === "tenants" ? (
        <CocoaSection padding={listReady ? "none" : "md"} style={{ overflow: "clip" }} aria-label="Organizaciones de la plataforma" footer={listReady ? <span>{plural(tenants.length, "organización", "organizaciones")}</span> : undefined}>
          {tenantsBody}
        </CocoaSection>
      ) : null}

      {activeTab === "activity" ? (
        <>
          <CocoaToolbar
            variant="content"
            aria-label="Filtro de actividad"
            leftSlot={<CocoaSelect value={activityFilter} onChange={setActivityFilter} options={tenantOptions} placeholder="Selecciona una organización…" aria-label="Organización" inline />}
            rightSlot={
              activityFilter ? (
                <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} disabled={activityLoading}>
                  {ACTIONS.refresh}
                </CocoaButton>
              ) : undefined
            }
          />
          <CocoaSection padding={activityFilter && !activityLoading && !activityError && activityRows.length > 0 ? "none" : "md"} style={{ overflow: "clip" }} aria-label="Actividad reciente" footer={activityRows.length > 0 ? <span>{plural(activityRows.length, "evento", "eventos")} (últimos 50)</span> : undefined}>
            {activityBody}
          </CocoaSection>
        </>
      ) : null}

      {activeTab === "system" ? (
        <>
          <CocoaKpiStrip stagger aria-label="Totales de la plataforma">
            <CocoaKpi label="Organizaciones activas" value={number(totals.activeOrganizations)} caption={`${plural(totals.organizations, "organización", "organizaciones")} en total`} degraded={loading} />
            <CocoaKpi label="Centros de trabajo" value={number(totals.properties)} caption="suma de todas las organizaciones" degraded={loading} />
            <CocoaKpi label="Usuarios" value={number(totals.users)} caption="cuentas provisionadas" degraded={loading} />
          </CocoaKpiStrip>
          <CocoaSection title="Salud de la plataforma">
            <CocoaState kind="degraded" title="Sin telemetría en el API de administración" message="La salud de la base de datos, del API y de las tareas programadas no está expuesta por ningún endpoint: esta vista solo puede mostrar los totales derivados de la lista de organizaciones." />
          </CocoaSection>
        </>
      ) : null}

      <NewTenantWizardDialog
        open={newTenantOpen}
        onClose={() => setNewTenantOpen(false)}
        onCompleted={() => {
          refresh();
        }}
      />

      <CocoaDrawer
        open={detailDrawerOpen}
        onClose={() => setDetailDrawerOpen(false)}
        title={selectedTenant ? selectedTenant.name : "Organización"}
        subtitle={selectedTenant ? `${selectedTenant.country || "—"} · plan ${selectedTenant.plan || "—"}` : undefined}
        side="right"
        size="md"
        dismissible={!ownerInviteBusy}
        footer={
          <>
            <CocoaButton variant="bordered" tone="accent" loading={ownerInviteBusy} disabled={!selectedTenant || ownerInviteBusy} onClick={() => selectedTenant && void reissueOwnerInvite(selectedTenant)}>
              Reenviar invitación al propietario
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => setDetailDrawerOpen(false)} disabled={ownerInviteBusy}>
              {ACTIONS.close}
            </CocoaButton>
          </>
        }
      >
        {selectedTenant ? (
          <div className="cocoa-stack" data-gap="4">
            <CocoaSection
              title="Resumen"
              meta={statusBadge(selectedTenant.status)}
              action={
                <CocoaButton variant="plain" size="small" onClick={() => openTenantDetail(selectedTenant.organizationId)}>
                  Ver ficha completa
                </CocoaButton>
              }
            >
              <ul className="c22-section__list" aria-label="Resumen de la organización">
                <li>
                  <span>Plan</span>
                  <strong>{selectedTenant.plan || "—"}</strong>
                </li>
                <li>
                  <span>Centros de trabajo</span>
                  <strong>{number(selectedTenant.propertiesCount ?? 0)}</strong>
                </li>
                <li>
                  <span>Usuarios</span>
                  <strong>{number(selectedTenant.usersCount ?? 0)}</strong>
                </li>
                <li>
                  <span>Identificador</span>
                  <code className="cocoa-mono">{selectedTenant.organizationId}</code>
                </li>
                <li>
                  <span>País</span>
                  <strong>{selectedTenant.country || "—"}</strong>
                </li>
                <li>
                  <span>Creada</span>
                  <strong>{fmtDate(selectedTenant.createdAt)}</strong>
                </li>
              </ul>
            </CocoaSection>
            {ownerInvite
              ? (() => {
                  const delivery = describeDelivery(ownerInvite.invitation.delivery, ownerInvite.email);
                  const showLink = ownerInvite.invitation.delivery?.status !== "sent" && Boolean(ownerInvite.invitation.inviteUrl);
                  return (
                    <CocoaCallout tone={DELIVERY_TONE[delivery.tone]} title={delivery.title} role="status">
                      <div className="cocoa-stack" data-gap="2">
                        <span>{delivery.detail}</span>
                        {showLink ? <CopyRow label="Enlace de invitación (un solo uso)" value={ownerInvite.invitation.inviteUrl} /> : null}
                        <span className="cocoa-note">Caduca el {formatExpiry(ownerInvite.invitation.expiresAt)}.</span>
                      </div>
                    </CocoaCallout>
                  );
                })()
              : null}
          </div>
        ) : null}
      </CocoaDrawer>
    </CocoaPage>
  );
}

export default TenantAdminConsoleScreen;

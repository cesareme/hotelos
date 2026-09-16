// Developer Apps — Configuración › Sistema › Aplicaciones (/configuracion/sistema/aplicaciones).
//
// OAuth2 applications of the partner: create an app with its scopes, read the
// client_id, and rotate the client_secret (shown ONCE). Backed by
// apps/api/src/modules/marketplace/oauth.service (Authorization Code + PKCE
// S256 and Client Credentials; refresh tokens expire after 30 days).
//
// Cocoa 22 (lote 10-A · lista / tabla): CocoaPage → CocoaFormSection «Nueva
// aplicación» (name, type, scope chips with aria-pressed) → CocoaSection
// padding="none" with the CocoaTable (row action «Renovar secreto», always
// visible) → CocoaDialog destructive for the rotation. The issued credentials
// land in a CocoaCallout with copy buttons.

import { useEffect, useState } from "react";
import { fetchDeveloperApps, createDeveloperApp, rotateAppSecret, fetchOAuthScopes, type DeveloperApp } from "../../services/marketplaceApi";
import { copyText } from "../../services/authApi";
import { useToast } from "../../components/Toast";
import { plural } from "../../lib/format";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { useTabHost } from "../tabs/TabHost";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn
} from "../../components/cocoa";

const APP_TYPE_OPTIONS = [
  { value: "integration", label: "Integración servidor a servidor" },
  { value: "spa", label: "Aplicación web (con PKCE)" },
  { value: "mobile", label: "Aplicación móvil" },
  { value: "partner_app", label: "Socio del marketplace" }
];

function appTypeLabel(value: string): string {
  return APP_TYPE_OPTIONS.find((option) => option.value === value)?.label ?? value;
}

function appStatus(status: string): { tone: "success" | "neutral" | "danger"; label: string } {
  switch (status) {
    case "active":
      return { tone: "success", label: "Activa" };
    case "suspended":
      return { tone: "neutral", label: "Suspendida" };
    case "revoked":
      return { tone: "danger", label: "Revocada" };
    default:
      return { tone: "neutral", label: status };
  }
}

/** Read-only credential with a copy button (client_id / client_secret, shown once). */
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    if (await copyText(value)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  }
  return (
    <div className="cocoa-stack" data-gap="1">
      <span className="cocoa-caption">{label}</span>
      <div className="cocoa-row" data-gap="2" data-wrap="nowrap">
        <CocoaInput value={value} onChange={() => undefined} readOnly aria-label={label} className="cocoa-mono" style={{ flex: "1 1 auto", minWidth: 0 }} />
        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void handleCopy()}>
          {copied ? "Copiado" : ACTIONS.copy}
        </CocoaButton>
      </div>
    </div>
  );
}

const COLUMNS_BASE: CocoaTableColumn<DeveloperApp>[] = [
  { key: "name", label: "Nombre", render: (a) => <strong>{a.name}</strong> },
  { key: "appType", label: "Tipo", hideOnNarrow: true, render: (a) => appTypeLabel(a.appType) },
  {
    key: "status",
    label: "Estado",
    fit: true,
    render: (a) => {
      const s = appStatus(a.status);
      return (
        <CocoaBadge tone={s.tone} uppercase={false}>
          {s.label}
        </CocoaBadge>
      );
    }
  },
  { key: "clientId", label: "ID de cliente", showFrom: "laptop", render: (a) => <code className="cocoa-mono">{a.clientId}</code> },
  { key: "scopes", label: "Permisos", align: "right", fit: true, render: (a) => a.scopes.length }
];

export function DeveloperAppsScreen() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const [apps, setApps] = useState<DeveloperApp[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [appType, setAppType] = useState("integration");
  const [chosenScopes, setChosenScopes] = useState<Set<string>>(new Set());
  const [createdSecret, setCreatedSecret] = useState<{ clientId: string; clientSecret: string } | null>(null);
  const [pendingRotateId, setPendingRotateId] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const [list, sc] = await Promise.all([fetchDeveloperApps(), fetchOAuthScopes()]);
      setApps(list);
      setScopes(sc);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudieron cargar las aplicaciones.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  function toggleScope(s: string) {
    setChosenScopes((prev) => {
      const n = new Set(prev);
      if (n.has(s)) n.delete(s);
      else n.add(s);
      return n;
    });
  }

  const canCreate = !creating && name.trim() !== "" && chosenScopes.size > 0;

  async function handleCreate() {
    if (!canCreate) return;
    const appName = name.trim();
    setCreating(true);
    try {
      const result = await createDeveloperApp({
        name: appName,
        appType,
        scopes: Array.from(chosenScopes)
      });
      setCreatedSecret({ clientId: result.clientId, clientSecret: result.clientSecret });
      setName("");
      setChosenScopes(new Set());
      await refresh();
      showToast(`Aplicación «${appName}» creada`, { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se ha podido crear la aplicación.";
      setError(message);
      showToast(message, { variant: "error" });
    } finally {
      setCreating(false);
    }
  }

  async function confirmRotate() {
    const appId = pendingRotateId;
    if (!appId) return;
    const app = apps.find((a) => a.id === appId);
    setRotating(true);
    try {
      const r = await rotateAppSecret(appId);
      if (app) setCreatedSecret({ clientId: app.clientId, clientSecret: r.clientSecret });
      setPendingRotateId(null);
      await refresh();
      showToast(app ? `Secreto de «${app.name}» renovado` : "Secreto renovado", { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo renovar el secreto.";
      setError(message);
      showToast(message, { variant: "error" });
      setPendingRotateId(null);
    } finally {
      setRotating(false);
    }
  }

  const pendingApp = pendingRotateId ? (apps.find((a) => a.id === pendingRotateId) ?? null) : null;
  const ready = !loading && apps.length > 0;

  let listBody;
  if (loading && apps.length === 0) {
    listBody = <CocoaTable columns={COLUMNS_BASE} rows={[]} loading aria-label="Aplicaciones" />;
  } else if (apps.length === 0) {
    listBody = <CocoaState kind="empty" title="Sin aplicaciones" message="Crea la primera con el formulario de arriba: nombre, tipo y permisos." />;
  } else {
    listBody = (
      <CocoaTable
        columns={COLUMNS_BASE}
        rows={apps}
        rowKey="id"
        rowActionsVisible="always"
        rowActions={(a) => (
          <CocoaButton
            variant="plain"
            size="small"
            onClick={(event) => {
              event.stopPropagation();
              setPendingRotateId(a.id);
            }}
          >
            Renovar secreto
          </CocoaButton>
        )}
        caption="Aplicaciones OAuth2"
        aria-label="Aplicaciones OAuth2"
      />
    );
  }

  return (
    <CocoaPage
      eyebrow="Configuración · Sistema"
      title="Aplicaciones"
      subtitle={hosted ? undefined : "Aplicaciones OAuth2 del partner: identificador de cliente público y secreto que se muestra una sola vez."}
      actions={
        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void refresh()} disabled={loading}>
          {ACTIONS.refresh}
        </CocoaButton>
      }
      commands={[{ id: "developer-apps-refresh", label: `${ACTIONS.refresh} aplicaciones`, run: () => void refresh() }]}
    >
      <CocoaCallout tone="info" title="Cómo se autentican">
        Cada aplicación tiene un <code className="cocoa-mono">client_id</code> público y un <code className="cocoa-mono">client_secret</code> que se muestra una sola vez. El API admite Authorization Code con PKCE (S256) y Client
        Credentials (servidor a servidor); los refresh tokens caducan a los 30 días.
      </CocoaCallout>

      {error ? (
        <CocoaCallout tone="danger" title={STATUS_LABELS.loadError} role="alert">
          {error}
        </CocoaCallout>
      ) : null}

      {createdSecret ? (
        <CocoaCallout
          tone="success"
          title="Credenciales emitidas"
          role="status"
          actions={
            <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setCreatedSecret(null)}>
              {ACTIONS.close}
            </CocoaButton>
          }
        >
          <div className="cocoa-stack" data-gap="3">
            <span>Cópialas ahora: el secreto no se mostrará de nuevo.</span>
            <CopyField label="client_id" value={createdSecret.clientId} />
            <CopyField label="client_secret" value={createdSecret.clientSecret} />
          </div>
        </CocoaCallout>
      ) : null}

      <CocoaFormSection
        title="Nueva aplicación"
        description="Nombre, tipo de integración y permisos (scopes) que podrá pedir."
        actions={
          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => void handleCreate()} disabled={!canCreate} loading={creating}>
            Crear aplicación
          </CocoaButton>
        }
      >
        <div className="cocoa-stack" data-gap="3">
          <CocoaFormRow columns={2}>
            <CocoaField label="Nombre de la aplicación" required>
              <CocoaInput value={name} onChange={setName} placeholder="Mi conector con SAP" disabled={creating} autoComplete="off" />
            </CocoaField>
            <CocoaField label="Tipo" required>
              <CocoaSelect value={appType} onChange={setAppType} options={APP_TYPE_OPTIONS} disabled={creating} />
            </CocoaField>
          </CocoaFormRow>
          <div className="cocoa-stack" data-gap="2" role="group" aria-label="Permisos de la aplicación">
            <div className="cocoa-row" data-gap="2" data-justify="between">
              <span className="cocoa-caption">
                Permisos · {chosenScopes.size} de {scopes.length}
              </span>
              <span className="cocoa-cluster">
                <CocoaButton variant="plain" size="small" onClick={() => setChosenScopes(new Set(scopes))} disabled={creating || scopes.length === 0}>
                  {ACTIONS.selectAll}
                </CocoaButton>
                <CocoaButton variant="plain" size="small" onClick={() => setChosenScopes(new Set())} disabled={creating || chosenScopes.size === 0}>
                  {ACTIONS.clearSelection}
                </CocoaButton>
              </span>
            </div>
            {scopes.length === 0 ? (
              <CocoaState kind="empty" inline title={loading ? STATUS_LABELS.loading : "El API no expone permisos OAuth."} />
            ) : (
              <div className="cocoa-cluster">
                {scopes.map((s) => {
                  const active = chosenScopes.has(s);
                  return (
                    <CocoaButton key={s} size="small" variant={active ? "tinted" : "bordered"} tone={active ? "accent" : "neutral"} aria-pressed={active} disabled={creating} onClick={() => toggleScope(s)}>
                      {s}
                    </CocoaButton>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </CocoaFormSection>

      <CocoaSection padding={ready ? "none" : "md"} style={{ overflow: "clip" }} aria-label="Aplicaciones OAuth2" footer={ready ? <span>{plural(apps.length, "aplicación", "aplicaciones")}</span> : undefined}>
        {listBody}
      </CocoaSection>

      <CocoaDialog
        open={pendingRotateId !== null}
        onClose={() => (rotating ? undefined : setPendingRotateId(null))}
        tone="destructive"
        title={pendingApp ? `¿Renovar el secreto de «${pendingApp.name}»?` : "¿Renovar el secreto de cliente?"}
        description="El secreto anterior dejará de funcionar de inmediato. El nuevo se muestra una sola vez."
        confirmLabel="Renovar"
        cancelLabel={ACTIONS.cancel}
        busy={rotating}
        onConfirm={confirmRotate}
      />
    </CocoaPage>
  );
}

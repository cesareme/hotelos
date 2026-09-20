// Integraciones — pestaña Configuración › Módulos e integraciones › Integraciones
// (loader ModulosTabs.tsx:24; sin rutas nuevas). Tanda L8 · L8-06: ARRIBA, el
// panel de estado honesto de cada integración (IntegrationsStatusPanel sobre
// GET /integrations/status); DEBAJO, el catálogo de aplicaciones de terceros
// (marketplace P2-1, Apaleo-style: catálogo + instalación; llamadas intactas),
// hoy vacío y sin proceso de certificación: el badge «verificada» solo sale si
// el listado lo declara.
//
// Cocoa 22 · ola 10 · lote 10-C (list archetype): CocoaPage → content toolbar
// (category filter) → catalogue cards on the 12-column grid → installed apps in
// a CocoaTable → the install flow (permissions to grant) in a CocoaDrawer and
// the uninstall confirmation in a CocoaDialog. Calls are untouched.

import { useEffect, useMemo, useState } from "react";
import {
  fetchCategories,
  fetchListings,
  fetchInstallations,
  installListing,
  uninstallListing,
  fetchOAuthScopes,
  type MarketplaceListing,
  type AppInstallation
} from "../../services/marketplaceApi";
import { useToast } from "../../components/Toast";
import { date, plural } from "../../lib/format";
import { ACTIONS } from "../../content/actions";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { IntegrationsStatusPanel } from "../integrations/IntegrationsStatusPanel";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaCard,
  CocoaDialog,
  CocoaDrawer,
  CocoaGrid,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  CocoaToolbar,
  type CocoaTableColumn
} from "../../components/cocoa";

const CATEGORY_LABELS: Record<string, string> = {
  channel_manager: "Channel Manager",
  rate_management: "Revenue Management",
  payments: "Pagos",
  messaging: "Mensajería",
  smart_lock: "Cerraduras inteligentes",
  accounting: "Contabilidad",
  compliance: "Cumplimiento",
  energy: "Energía",
  marketing: "Marketing",
  crm: "CRM",
  operations: "Operaciones",
  analytics: "Analítica",
  ai_assistant: "Asistentes IA"
};

const HEADER = treeHeaderFor("MarketplaceCatalog", { eyebrow: "Configuración · Módulos e integraciones", title: "Integraciones" });

// Columns outside the component (§4.2 A5).
const INSTALLED_COLUMNS: CocoaTableColumn<AppInstallation>[] = [
  { key: "appId", label: "Aplicación", fit: true, render: (installation) => <strong>{installation.appId}</strong> },
  { key: "scopes", label: "Permisos", render: (installation) => installation.scopes.join(", ") },
  { key: "installedAt", label: "Instalada", fit: true, hideOnNarrow: true, render: (installation) => date(installation.installedAt) }
];

export function MarketplaceCatalogScreen() {
  const { showToast } = useToast();
  const [categories, setCategories] = useState<string[]>([]);
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [installations, setInstallations] = useState<AppInstallation[]>([]);
  const [scopes, setScopes] = useState<string[]>([]);
  const [category, setCategory] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MarketplaceListing | null>(null);
  const [installing, setInstalling] = useState(false);
  const [chosenScopes, setChosenScopes] = useState<Set<string>>(new Set());
  const [pendingUninstallId, setPendingUninstallId] = useState<string | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  // Header «Actualizar» reloads the catalogue AND the status panel (corrector L8 · REV-03): the panel re-reads on every bump.
  const [statusRefreshKey, setStatusRefreshKey] = useState(0);

  async function refresh() {
    setLoading(true);
    try {
      const [cats, items, installs, sc] = await Promise.all([
        fetchCategories(),
        fetchListings(category || undefined),
        fetchInstallations(),
        fetchOAuthScopes()
      ]);
      setCategories(cats);
      setListings(items);
      setInstallations(installs);
      setScopes(sc);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se ha podido cargar el catálogo.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void refresh(); }, [category]);

  function refreshAll() {
    setStatusRefreshKey((key) => key + 1);
    void refresh();
  }

  const installedAppIds = useMemo(() => new Set(installations.map((i) => i.appId)), [installations]);

  async function handleInstall() {
    if (!selected) return;
    const appId = selected.appId;
    setInstalling(true);
    try {
      await installListing(appId, { grantedScopes: Array.from(chosenScopes) });
      setSelected(null);
      setChosenScopes(new Set());
      await refresh();
      showToast(`Aplicación «${appId}» instalada`, { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se ha podido instalar la aplicación.";
      setError(message);
      showToast(message, { variant: "error" });
    } finally {
      setInstalling(false);
    }
  }

  async function confirmUninstall() {
    const appId = pendingUninstallId;
    if (!appId) return;
    setUninstalling(true);
    try {
      await uninstallListing(appId);
      await refresh();
      showToast(`Aplicación «${appId}» desinstalada`, { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se ha podido desinstalar la aplicación.";
      setError(message);
      showToast(message, { variant: "error" });
    } finally {
      setUninstalling(false);
      setPendingUninstallId(null);
    }
  }

  function toggleScope(s: string) {
    setChosenScopes((prev) => {
      const n = new Set(prev);
      if (n.has(s)) n.delete(s); else n.add(s);
      return n;
    });
  }

  // First paint only: later refreshes (a category change) keep the page and mark the sections.
  const initialLoading = loading && categories.length === 0 && listings.length === 0 && !error;
  const categoryOptions = [{ value: "", label: "Todas las categorías" }, ...categories.map((c) => ({ value: c, label: CATEGORY_LABELS[c] ?? c }))];

  return (
    <CocoaPage
      eyebrow={HEADER.eyebrow}
      title={HEADER.title}
      subtitle="Estado real de cada integración; debajo, el catálogo de aplicaciones de terceros, hoy vacío."
      actions={
        <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshAll} disabled={loading} loading={loading}>
          {`${ACTIONS.refresh} todo`}
        </CocoaButton>
      }
      state={initialLoading ? "loading" : "ready"}
      skeleton={
        <div className="cocoa-stack" data-gap="4" aria-hidden="true">
          <CocoaSkeleton variant="row" />
          <CocoaSkeleton.Grid rows={[[4, 4, 4]]} height={180} />
        </div>
      }
      commands={[{ id: "marketplace-refresh", label: "Actualizar el estado de las integraciones y el catálogo", run: refreshAll }]}
    >
      <IntegrationsStatusPanel refreshKey={statusRefreshKey} />

      <CocoaToolbar
        variant="content"
        aria-label="Filtro por categoría"
        leftSlot={<CocoaSelect inline value={category} onChange={setCategory} options={categoryOptions} aria-label="Categoría" />}
        rightSlot={<span className="cocoa-note">{plural(listings.length, "aplicación publicada", "aplicaciones publicadas")}</span>}
      />

      {error ? (
        <CocoaCallout tone="danger" role="alert">
          {error}
        </CocoaCallout>
      ) : null}

      <CocoaSection title="Catálogo de aplicaciones" meta={category ? CATEGORY_LABELS[category] ?? category : "Todas las categorías"}>
        {loading && listings.length === 0 ? (
          <CocoaState kind="loading" inline />
        ) : listings.length === 0 ? (
          <CocoaState
            kind="empty"
            illustration="box"
            title="Sin aplicaciones de terceros publicadas"
            message="Hoy no hay ninguna aplicación de terceros en el catálogo. Puedes crear tu propia aplicación en Configuración › Sistema › Aplicaciones."
          />
        ) : (
          <CocoaGrid aria-label="Aplicaciones del catálogo">
            {listings.map((l) => {
              const installed = installedAppIds.has(l.appId);
              return (
                <CocoaSpan cols={4} min={240} key={l.id}>
                  <CocoaCard variant="bordered" padding="md" role="group" aria-label={l.appId}>
                    <div className="cocoa-stack" data-gap="2">
                      <div className="cocoa-row" data-gap="2">
                        {l.iconUrl ? <img src={l.iconUrl} alt="" width={36} height={36} /> : null}
                        <span className="cocoa-stack" data-gap="1" style={{ flex: "1 1 auto", minWidth: 0 }}>
                          <strong>{l.appId}</strong>
                          <span className="cocoa-note">{CATEGORY_LABELS[l.category] ?? l.category}</span>
                        </span>
                        {l.verified ? (
                          <CocoaBadge tone="success" size="small">
                            verificada
                          </CocoaBadge>
                        ) : null}
                      </div>
                      <p className="cocoa-note">{l.tagline}</p>
                      <div className="cocoa-row" data-gap="2" data-justify="between">
                        <span className="cocoa-note">
                          {plural(l.installsCount, "instalación", "instalaciones")} · {l.pricing ?? "gratuita"}
                        </span>
                        {installed ? (
                          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setPendingUninstallId(l.appId)}>
                            Desinstalar
                          </CocoaButton>
                        ) : (
                          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => { setSelected(l); setChosenScopes(new Set()); }}>
                            Instalar
                          </CocoaButton>
                        )}
                      </div>
                    </div>
                  </CocoaCard>
                </CocoaSpan>
              );
            })}
          </CocoaGrid>
        )}
      </CocoaSection>

      {/* padding="none" + overflow clip: the table clips to the radius without creating a scroll container (§4.2 D26). */}
      <CocoaSection title="Aplicaciones instaladas" meta={plural(installations.length, "aplicación", "aplicaciones")} padding={installations.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
        {installations.length === 0 ? (
          <CocoaState kind="empty" inline title={listings.length === 0 ? "Ninguna aplicación instalada; el catálogo de terceros está vacío." : "Ninguna aplicación instalada. Instala una del catálogo para empezar."} />
        ) : (
          <CocoaTable
            columns={INSTALLED_COLUMNS}
            rows={installations}
            rowKey="id"
            rowActions={(installation) => (
              <CocoaButton
                variant="plain"
                tone="destructive"
                size="small"
                onClick={(event) => {
                  event.stopPropagation();
                  setPendingUninstallId(installation.appId);
                }}
              >
                Desinstalar
              </CocoaButton>
            )}
            rowActionsVisible="always"
            caption="Aplicaciones instaladas"
            aria-label="Aplicaciones instaladas"
          />
        )}
      </CocoaSection>

      <CocoaDrawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? `Instalar ${selected.appId}` : "Instalar aplicación"}
        subtitle={selected?.tagline}
        side="right"
        size="md"
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setSelected(null)} disabled={installing}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void handleInstall()} loading={installing} disabled={installing || chosenScopes.size === 0}>
              {`Instalar con ${plural(chosenScopes.size, "permiso", "permisos")}`}
            </CocoaButton>
          </>
        }
      >
        {selected ? (
          <div className="cocoa-stack" data-gap="3">
            <p style={{ margin: 0 }}>{selected.description}</p>
            <p className="cocoa-note">Esta aplicación puede pedir acceso a los siguientes permisos. Selecciona los que quieras conceder:</p>
            <div role="group" aria-label="Permisos a conceder" className="cocoa-cluster">
              {scopes.map((s) => {
                const on = chosenScopes.has(s);
                return (
                  <CocoaButton key={s} size="small" variant={on ? "tinted" : "bordered"} tone={on ? "accent" : "neutral"} aria-pressed={on} onClick={() => toggleScope(s)}>
                    {s}
                  </CocoaButton>
                );
              })}
            </div>
            <div className="cocoa-row" data-gap="2">
              <CocoaButton variant="plain" tone="accent" size="small" onClick={() => setChosenScopes(new Set(scopes))} disabled={installing}>
                Conceder todos
              </CocoaButton>
              <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setChosenScopes(new Set())} disabled={installing || chosenScopes.size === 0}>
                {ACTIONS.clearSelection}
              </CocoaButton>
            </div>
          </div>
        ) : null}
      </CocoaDrawer>

      <CocoaDialog
        open={pendingUninstallId !== null}
        onClose={() => setPendingUninstallId(null)}
        tone="destructive"
        title="¿Desinstalar esta aplicación?"
        description="Los tokens emitidos quedarán inactivos."
        confirmLabel="Desinstalar"
        cancelLabel={ACTIONS.cancel}
        onConfirm={confirmUninstall}
        busy={uninstalling}
      />
    </CocoaPage>
  );
}

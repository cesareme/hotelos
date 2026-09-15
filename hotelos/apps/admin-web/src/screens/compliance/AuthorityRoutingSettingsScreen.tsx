// Enrutamiento a autoridades (Tanda 3 · lote front-fiscal).
//
// Solo lectura sobre GET /compliance/spain/properties/:id/guest-register/settings
// (routingRules). Las reglas viven hoy en el servidor como política global
// (demoStore.authorityRoutingRules, sin PATCH por tenant): la pantalla lo dice
// en vez de fingir un editor.
import { useCallback, useEffect, useMemo, useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { fetchSesSettings } from "../../services/sesApi";
import { EmptyState, ErrorState, LoadingBlock } from "../../components/States";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { pageHead } from "../tabs/configuracion/tab-helpers";
import { CocoaCard } from "../../components/cocoa/CocoaCard";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { CocoaTable, type CocoaTableColumn } from "../../components/cocoa/CocoaTable";
import { toArray } from "../../utils/toArray";
import { navigateTo } from "../../lib/navigate";

const PROPERTY_ID = getActivePropertyId();

type RoutingRule = {
  id: string;
  propertyId?: string | null;
  country: string;
  regionCode?: string | null;
  authorityType: string;
  priority: number;
  active: boolean;
  configurationJson?: Record<string, unknown>;
};

const AUTHORITY_LABELS: Record<string, string> = {
  ses_hospedajes: "SES.HOSPEDAJES (Ministerio del Interior)",
  mossos: "Mossos d'Esquadra (Cataluña)",
  ertzaintza: "Ertzaintza (País Vasco)",
  manual: "Envío manual",
  other: "Otra autoridad"
};

const REGION_LABELS: Record<string, string> = {
  CT: "Cataluña",
  PV: "País Vasco",
  EUSK: "País Vasco"
};

export function AuthorityRoutingSettingsScreen({ embedded = false }: { embedded?: boolean } = {}) {
  // Inside a tab container (Tanda 5) the page header belongs to the container: render a section head instead.
  const Head = pageHead(embedded);
  const [rules, setRules] = useState<RoutingRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const settings = await fetchSesSettings(PROPERTY_ID);
      setRules(toArray<RoutingRule>(settings.routingRules));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar las reglas de enrutamiento.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rows = useMemo(() => [...rules].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id)), [rules]);

  const columns = useMemo<CocoaTableColumn<RoutingRule>[]>(
    () => [
      { key: "country", label: "País", width: "80px", render: (row) => row.country },
      { key: "regionCode", label: "Región", width: "140px", render: (row) => (row.regionCode ? (REGION_LABELS[row.regionCode] ?? row.regionCode) : <span className="bo-muted">todas</span>) },
      { key: "authorityType", label: "Autoridad", render: (row) => AUTHORITY_LABELS[row.authorityType] ?? row.authorityType },
      { key: "priority", label: "Prioridad", align: "right", width: "100px", render: (row) => String(row.priority) },
      {
        key: "scope",
        label: "Ámbito",
        width: "130px",
        render: (row) => (row.propertyId ? <span className="bo-chip">esta propiedad</span> : <span className="bo-chip">global</span>)
      },
      {
        key: "active",
        label: "Activa",
        width: "90px",
        render: (row) => <span className={`bo-status ${row.active ? "ok" : "warn"}`} style={{ textTransform: "none" }}>{row.active ? "sí" : "no"}</span>
      }
    ],
    []
  );

  if (loading && rules.length === 0 && !error) {
    return (
      <section className="bo-card">
        <LoadingBlock label="Cargando reglas de enrutamiento…" />
      </section>
    );
  }
  if (error && rules.length === 0) {
    return (
      <section className="bo-card">
        <ErrorState title="No se pudieron cargar las reglas" message={error} onRetry={() => void load()} />
      </section>
    );
  }

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-5)" }}>
      <Head
        eyebrow="Cumplimiento · Registro de viajeros"
        title="Enrutamiento a autoridades"
        subtitle="A qué autoridad se envían los partes de viajeros según país y región"
        actions={
          <span style={{ display: "inline-flex", gap: "var(--cocoa-space-2)", flexWrap: "wrap" }}>
            <CocoaButton variant="plain" onClick={() => navigateTo("SesHospedajesSettings")}>
              Conector SES.HOSPEDAJES
            </CocoaButton>
            <CocoaButton variant="plain" onClick={() => navigateTo("GuestRegisterSettings")}>
              Ajustes del registro
            </CocoaButton>
          </span>
        }
      />

      <CocoaCard variant="bordered" padding="md">
        <p style={{ margin: 0 }}>
          Las reglas se evalúan de mayor a menor prioridad: la primera regla activa cuyo país y región coinciden con el establecimiento decide la
          autoridad. La regla por defecto para España es SES.HOSPEDAJES (RD 933/2021).
        </p>
        <p className="bo-muted" style={{ margin: "var(--cocoa-space-2) 0 0" }}>
          Política fija, no configurable todavía: las reglas se gestionan por soporte. Contacta con soporte para añadir una autoridad regional.
        </p>
      </CocoaCard>

      {rows.length === 0 ? (
        <EmptyState title="Sin reglas de enrutamiento" message="El servidor no devolvió ninguna regla; los partes se enviarían por la ruta por defecto (SES.HOSPEDAJES)." />
      ) : (
        <CocoaTable<RoutingRule> columns={columns} rows={rows} rowKey="id" emptyState="Sin reglas." />
      )}
    </section>
  );
}

export default AuthorityRoutingSettingsScreen;

// Enrutamiento a autoridades — Cumplimiento › Registro de viajeros › Autoridades
// (/cumplimiento/registro-viajeros/autoridades, hosted in RegistroViajerosTabs).
// Cocoa 22 · ola 8 · lote 8-A, archetype «formulario / ajustes» (read only).
//
// Read only over GET /compliance/spain/properties/:id/guest-register/settings
// (routingRules). The rules live on the server as a global policy (no PATCH per
// tenant): the screen says so instead of faking an editor. The frame is
// CocoaPage on the host context (hosted, the container paints eyebrow and H1;
// the ⌘K command is the page's); the body is Cocoa 22: a callout and the table
// of rules, whose loading / error / empty states stay inside its section.

import { useCallback, useEffect, useMemo, useState } from "react";
import { getActivePropertyId } from "../../services/activeProperty";
import { fetchSesSettings } from "../../services/sesApi";
import { useTabHost } from "../tabs/TabHost";
import { toArray } from "../../utils/toArray";
import { navigateTo } from "../../lib/navigate";
import { number, plural } from "../../lib/format";
import { STATUS_LABELS } from "../../content/actions";
import { CocoaBadge, CocoaButton, CocoaCallout, CocoaPage, CocoaSection, CocoaState, CocoaTable, type CocoaTableColumn } from "../../components/cocoa";

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

const COLUMNS: CocoaTableColumn<RoutingRule>[] = [
  { key: "country", label: "País", fit: true, render: (row) => <span className="cocoa-mono">{row.country}</span> },
  { key: "regionCode", label: "Región", fit: true, render: (row) => (row.regionCode ? (REGION_LABELS[row.regionCode] ?? row.regionCode) : <CocoaBadge tone="neutral" size="small">todas</CocoaBadge>) },
  { key: "authorityType", label: "Autoridad", minWidth: 200, render: (row) => AUTHORITY_LABELS[row.authorityType] ?? row.authorityType },
  { key: "priority", label: "Prioridad", align: "right", fit: true, render: (row) => number(row.priority) },
  {
    key: "scope",
    label: "Ámbito",
    fit: true,
    hideOnNarrow: true,
    render: (row) => (row.propertyId ? <CocoaBadge tone="info" size="small">esta propiedad</CocoaBadge> : <CocoaBadge tone="neutral" size="small">global</CocoaBadge>)
  },
  {
    key: "active",
    label: "Activa",
    fit: true,
    render: (row) => <CocoaBadge tone={row.active ? "success" : "warning"}>{row.active ? STATUS_LABELS.yes : STATUS_LABELS.no}</CocoaBadge>
  }
];

export function AuthorityRoutingSettingsScreen() {
  // Inside a tab container the page header belongs to the container (CocoaPage reads the host context).
  const hosted = useTabHost() !== null;
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
  const showTable = (loading && rules.length === 0 && !error) || rows.length > 0;

  return (
    <CocoaPage
      eyebrow="Cumplimiento · Registro de viajeros"
      title="Enrutamiento a autoridades"
      subtitle={hosted ? undefined : "A qué autoridad se envían los partes de viajeros según país y región."}
      actions={
        <>
          <CocoaButton variant="plain" size="small" onClick={() => navigateTo("SesHospedajesSettings")}>
            Conector SES.HOSPEDAJES
          </CocoaButton>
          <CocoaButton variant="plain" size="small" onClick={() => navigateTo("GuestRegisterSettings")}>
            Ajustes del registro
          </CocoaButton>
        </>
      }
      commands={[{ id: "autoridades-actualizar", label: "Actualizar el enrutamiento", run: () => void load() }]}
    >
      <CocoaCallout tone="info" title="Política fija, no configurable todavía">
        Las reglas se evalúan de mayor a menor prioridad: la primera regla activa cuyo país y región coinciden con el establecimiento decide la autoridad. La regla
        por defecto para España es SES.HOSPEDAJES (RD 933/2021). Las reglas se gestionan por soporte: contacta con soporte para añadir una autoridad regional.
      </CocoaCallout>

      <CocoaSection
        title="Reglas de enrutamiento"
        meta={rows.length > 0 ? plural(rows.length, "regla", "reglas") : undefined}
        padding={showTable ? "none" : "md"}
        style={{ overflow: "clip" }}
      >
        {loading && rules.length === 0 && !error ? (
          <CocoaTable columns={COLUMNS} rows={[]} loading caption="Reglas de enrutamiento" aria-label="Reglas de enrutamiento" />
        ) : error && rules.length === 0 ? (
          <CocoaState kind="error" title="No se pudieron cargar las reglas" message={error} onRetry={() => void load()} />
        ) : rows.length === 0 ? (
          <CocoaState kind="empty" illustration="box" title="Sin reglas de enrutamiento" message="El servidor no devolvió ninguna regla; los partes se enviarían por la ruta por defecto (SES.HOSPEDAJES)." />
        ) : (
          <CocoaTable columns={COLUMNS} rows={rows} rowKey="id" density="compact" caption="Reglas de enrutamiento" aria-label="Reglas de enrutamiento" />
        )}
      </CocoaSection>
    </CocoaPage>
  );
}

export default AuthorityRoutingSettingsScreen;

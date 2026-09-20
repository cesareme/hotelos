// Integraciones · panel de estado honesto (Tanda L8 · L8-06). Vive ARRIBA de la
// pestaña Configuración › Módulos e integraciones › Integraciones
// (MarketplaceCatalogScreen, loader ModulosTabs.tsx:24; sin rutas nuevas) y lee
// GET /integrations/status?propertyId= (services/integrationsApi.ts, contrato
// L8-01). Una fila por integración con su modo none | sandbox | real, la frase
// de estado del API, qué falta para operar en real, la última actividad y el
// último error; «Configurar» abre la pantalla del DTO: cambio de pestaña dentro
// del contenedor (useTabHost + requestTabNavigation, sin viaje por el shell)
// cuando es una pestaña del mismo ítem (OPERA → Modo sombra) y, si no, por su
// clave del árbol. Contadores solo de filas recibidas (nunca inventados); las
// consultas degradadas se anuncian, no se maquillan. Cocoa 22: sin estilos en
// línea; la cabecera la pinta la página anfitriona (CocoaPage) o el contenedor.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { IntegrationStatusDto, IntegrationsStatusResponse } from "@hotelos/shared";
import { CocoaBadge, CocoaButton, CocoaCallout, CocoaKpi, CocoaKpiStrip, CocoaSection, CocoaState, CocoaTable, CocoaToolbar, requestTabNavigation, type CocoaTableColumn } from "../../components/cocoa";
import { ACTIONS } from "../../content/actions";
import { EMPTY, dateTime, plural } from "../../lib/format";
import { useActiveProperty } from "../../services/activeProperty";
import { fetchIntegrationsStatus } from "../../services/integrationsApi";
import { useTabHost, type TabHostInfo } from "../tabs/TabHost";
import { shellNavigate } from "../tabs/tab-helpers";
import { formatLastActivity, groupByArea, loadErrorMessage, missingSummary, modeKpis, modeLabel, modeNote, modeTone, screenKeyForRoute, tabSwitchFor, transportLabel } from "./integrations-status-helpers";

// Columns outside the component (§4.2 A5).
const COLUMNS: CocoaTableColumn<IntegrationStatusDto>[] = [
  {
    key: "label",
    label: "Integración",
    render: (row) => (
      <span className="cocoa-stack" data-gap="1">
        <strong>{row.label}</strong>
        <span className="cocoa-note">{transportLabel(row.transport)}</span>
      </span>
    )
  },
  {
    key: "mode",
    label: "Modo",
    fit: true,
    render: (row) => {
      const note = modeNote(row);
      return (
        <span className="cocoa-stack" data-gap="1">
          <CocoaBadge tone={modeTone(row.mode)} size="small">
            {modeLabel(row.mode)}
          </CocoaBadge>
          {note ? <span className="cocoa-note">{note}</span> : null}
        </span>
      );
    }
  },
  { key: "message", label: "Estado", render: (row) => row.message },
  { key: "missing", label: "Qué falta para real", hideOnNarrow: true, render: (row) => missingSummary(row) },
  { key: "lastActivityAt", label: "Última actividad", fit: true, hideOnNarrow: true, render: (row) => formatLastActivity(row.lastActivityAt) },
  {
    key: "lastError",
    label: "Último error",
    truncate: 260,
    showFrom: "laptop",
    render: (row) =>
      row.lastError ? (
        <span className="cocoa-row" data-gap="1">
          <CocoaBadge tone="danger" variant="dot" size="small">
            Error
          </CocoaBadge>
          <span>{row.lastError}</span>
        </span>
      ) : (
        EMPTY
      )
  }
];

function ConfigureAction({ row, host }: { row: IntegrationStatusDto; host: TabHostInfo | null }) {
  const screenKey = screenKeyForRoute(row.screen);
  if (!screenKey) return null;
  return (
    <CocoaButton
      variant="plain"
      tone="accent"
      size="small"
      aria-label={`Configurar ${row.label}`}
      onClick={(event) => {
        event.stopPropagation();
        const inContainer = tabSwitchFor(row.screen, host, typeof window === "undefined" ? null : window.location.pathname);
        if (inContainer) requestTabNavigation(inContainer);
        else shellNavigate(screenKey);
      }}
    >
      Configurar
    </CocoaButton>
  );
}

/** `refreshKey`: the host page bumps it to make the panel re-read the API (its own «Actualizar estado» button also does). */
export function IntegrationsStatusPanel({ refreshKey = 0 }: { refreshKey?: number } = {}) {
  const host = useTabHost();
  const { propertyId } = useActiveProperty();
  const [data, setData] = useState<IntegrationsStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!propertyId) return;
    setLoading(true);
    setError(null);
    try {
      setData(await fetchIntegrationsStatus(propertyId));
    } catch (err) {
      setError(loadErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const rows = useMemo(() => data?.integrations ?? [], [data]);
  const groups = useMemo(() => groupByArea(rows), [rows]);
  const kpis = useMemo(() => modeKpis(rows), [rows]);
  const degraded = data?.degraded ?? [];

  return (
    <div className="cocoa-stack" data-gap="4" role="region" aria-label="Estado de las integraciones" aria-busy={loading || undefined}>
      <CocoaToolbar
        variant="content"
        aria-label="Lectura del estado de las integraciones"
        leftSlot={<span className="cocoa-note">{data ? `Estado leído el ${dateTime(data.generatedAt)} · ${plural(rows.length, "integración", "integraciones")}` : "Estado real de cada integración, leído del API."}</span>}
        rightSlot={
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void load()} disabled={loading} loading={loading}>
            {`${ACTIONS.refresh} estado`}
          </CocoaButton>
        }
      />

      {data ? (
        <CocoaKpiStrip aria-label="Integraciones por modo">
          {kpis.map((kpi) => (
            <CocoaKpi key={kpi.mode} label={kpi.label} value={kpi.value} caption={kpi.caption} tone={kpi.tone} size="compact" />
          ))}
        </CocoaKpiStrip>
      ) : null}

      {error && data ? (
        <CocoaCallout tone="danger" role="alert" title="No se pudo actualizar el estado">
          {error}
        </CocoaCallout>
      ) : null}

      {degraded.length > 0 ? (
        <CocoaCallout tone="warning" role="status" title={`${plural(degraded.length, "consulta sin datos", "consultas sin datos")}`}>
          Estas lecturas fallaron y se muestran como «sin datos», nunca como un éxito: {degraded.join(", ")}.
        </CocoaCallout>
      ) : null}

      {loading && !data ? (
        <CocoaState kind="loading" inline title="Leyendo el estado de las integraciones…" />
      ) : error && !data ? (
        <CocoaState kind="error" title="No se pudo leer el estado de las integraciones" message={error} onRetry={() => void load()} />
      ) : data && rows.length === 0 ? (
        <CocoaState kind="empty" illustration="connection" title="El API no ha devuelto ninguna integración" message="La respuesta llegó vacía: no hay filas que mostrar para esta propiedad." />
      ) : (
        groups.map((group) => (
          <CocoaSection key={group.area} title={group.label} meta={plural(group.rows.length, "integración", "integraciones")} headingLevel={3}>
            <CocoaTable
              columns={COLUMNS}
              rows={group.rows}
              rowKey="key"
              density="compact"
              rowTone={(row) => (row.lastError ? "danger" : undefined)}
              rowActions={(row) => <ConfigureAction row={row} host={host} />}
              rowActionsVisible="always"
              caption={`Integraciones · ${group.label}`}
              aria-label={`Integraciones · ${group.label}`}
            />
          </CocoaSection>
        ))
      )}
    </div>
  );
}

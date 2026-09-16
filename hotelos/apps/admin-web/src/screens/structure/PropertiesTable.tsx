// Configuración › Estructura societaria › Centros —
// /configuracion/estructura-societaria/centros (Tanda 6b · L6; design §5.3).
// KPI strip (centros · hoteles · colisiones de serie, 0 in green) and the
// CocoaTable of work centres — código · centro · tipo · municipio · series ·
// VeriFactu · estado — grouped «Hoteles» / «Centros no alojativos»; a row opens
// the ficha (PropertyDrawer). Hotel individual: one section «Este hotel» and
// no word «centro» in the copy (design §5.6). The prefix clash count is
// computed from the series the structure already carries (same rule as the
// API's markSeriesClashes), so no extra permission is needed for the KPI.

import { useMemo, useState } from "react";
import { CocoaBadge, CocoaKbd, CocoaKpi, CocoaKpiStrip, CocoaPage, CocoaSection, CocoaState, CocoaTable, type CocoaTableColumn } from "../../components/cocoa";
import { STATUS_LABELS } from "../../content/actions";
import { number, plural } from "../../lib/format";
import type { StructureProperty } from "../../services/structureApi";
import { useTabHost } from "../tabs/TabHost";
import { PropertyDrawer } from "./PropertyDrawer";
import { StructureActions, StructureSplit, structurePageProps, useWizardState } from "./StructureScreen";
import { useStructureModel } from "./structure-model";
import { describeCentreCounts, findPrefixClashes, isOperationalKind, propertyKindLabel, seriesSummary } from "./structure-ui";

type Row = StructureProperty & { clashes: number };

function kindTone(kind: string): "accent" | "info" | "neutral" {
  return kind === "hotel" ? "accent" : kind === "office" ? "info" : "neutral";
}

const COLUMNS: CocoaTableColumn<Row>[] = [
  { key: "code", label: "Código", fit: true, render: (row) => (row.code ? <strong className="cocoa-tabular">{row.code}</strong> : "—") },
  { key: "name", label: "Centro", minWidth: 200, render: (row) => (row.tradeName && row.tradeName !== row.name ? `${row.tradeName} (${row.name})` : row.name) },
  { key: "kind", label: "Tipo", fit: true, render: (row) => <CocoaBadge tone={kindTone(row.kind)}>{propertyKindLabel(row.kind)}</CocoaBadge> },
  { key: "municipality", label: "Municipio", hideOnNarrow: true, render: (row) => row.municipality ?? "—" },
  {
    key: "series",
    label: "Series",
    showFrom: "laptop",
    render: (row) => (
      <span className="cocoa-cluster">
        <span>{seriesSummary(row.series)}</span>
        {row.clashes > 0 ? <CocoaBadge tone="danger" size="small">colisión</CocoaBadge> : null}
      </span>
    )
  },
  {
    key: "installation",
    label: "VeriFactu",
    showFrom: "laptop",
    render: (row) => (row.installation ? <CocoaKbd announce>{row.installation.numeroInstalacion}</CocoaKbd> : isOperationalKind(row.kind) ? "sin instalación" : "—")
  },
  { key: "status", label: "Estado", fit: true, render: (row) => <CocoaBadge tone={row.status === "open" ? "success" : "neutral"} variant="dot">{row.status === "open" ? STATUS_LABELS.active : row.status}</CocoaBadge> }
];

export function StructurePropertiesTab() {
  const hosted = useTabHost() !== null;
  const model = useStructureModel("properties");
  const wizard = useWizardState();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const rows = useMemo<Row[]>(() => {
    const allSeries = model.properties.flatMap((property) => property.series);
    const clashing = new Set(findPrefixClashes(allSeries).map((series) => series.id));
    return model.properties.map((property) => ({ ...property, clashes: property.series.filter((series) => clashing.has(series.id)).length }));
  }, [model.properties]);
  const hotels = rows.filter((row) => isOperationalKind(row.kind));
  const others = rows.filter((row) => !isOperationalKind(row.kind));
  const clashCount = rows.reduce((acc, row) => acc + row.clashes, 0);
  const selected = rows.find((row) => row.id === selectedId) ?? null;
  const counts = model.structure?.counts;

  const table = (list: Row[], label: string) => (
    <CocoaTable
      columns={COLUMNS}
      rows={list}
      rowKey="id"
      selectedKey={selectedId ?? undefined}
      onSelect={(row) => setSelectedId(row.id)}
      rowTitle={() => "Abrir la ficha del centro"}
      caption={label}
      aria-label={label}
      emptyState={<CocoaState kind="empty" inline title="Sin centros." />}
    />
  );

  return (
    <CocoaPage {...structurePageProps(model, hosted, "Los centros de trabajo de la sociedad: hoteles y centros no alojativos, con sus series y su instalación VeriFactu.")} actions={<StructureActions model={model} wizard={wizard} />}>
      <StructureSplit model={model} wizard={wizard}>
        {model.structure && counts ? (
          <>
            {!model.singleHotel ? (
              <CocoaKpiStrip aria-label="Resumen de centros">
                <CocoaKpi label="Centros" value={number(counts.properties)} caption={describeCentreCounts(counts)} polarity="neutral" />
                <CocoaKpi label="Hoteles abiertos" value={number(hotels.filter((row) => row.status === "open").length)} caption={`de ${plural(counts.hotels, "hotel", "hoteles")}`} polarity="neutral" />
                <CocoaKpi label="Colisiones de serie" value={number(clashCount)} caption={model.redacted ? "solo tus centros" : "prefijos repetidos entre centros"} polarity="negative-good" status={clashCount > 0 ? "critical" : "ok"} degraded={model.redacted} />
              </CocoaKpiStrip>
            ) : null}

            {rows.length === 0 ? (
              <CocoaSection aria-label="Sin centros">
                <CocoaState kind="empty" title={model.redacted ? "Sin centros asignados" : "Sin centros"} message={model.redacted ? "No tienes rol en ningún centro de esta sociedad." : "La sociedad aún no tiene centros de trabajo: añade el primero con «Añadir centro»."} illustration="box" />
              </CocoaSection>
            ) : (
              <>
                <CocoaSection
                  title={model.singleHotel ? "Este hotel" : "Hoteles"}
                  meta={model.singleHotel ? undefined : plural(hotels.length, "hotel", "hoteles")}
                  padding="none"
                  style={{ overflow: "clip" }}
                  footer={model.singleHotel ? "Añadir otro establecimiento abre la vista de sociedad con varios centros." : describeCentreCounts(counts)}
                >
                  {hotels.length > 0 ? table(hotels, model.singleHotel ? "Este hotel" : "Hoteles de la sociedad") : <CocoaState kind="empty" inline title="Sin hoteles." />}
                </CocoaSection>
                {others.length > 0 ? (
                  <CocoaSection title="Centros no alojativos" meta={plural(others.length, "centro", "centros")} padding="none" style={{ overflow: "clip" }}>
                    {table(others, "Centros no alojativos de la sociedad")}
                  </CocoaSection>
                ) : null}
              </>
            )}

            {model.legalEntity ? (
              <PropertyDrawer
                property={selected}
                legalEntity={model.legalEntity}
                canEdit={model.permissions.manage && !model.redacted}
                redacted={model.redacted}
                singleHotel={model.singleHotel}
                onClose={() => setSelectedId(null)}
                onSaved={model.refresh}
              />
            ) : null}
          </>
        ) : null}
      </StructureSplit>
    </CocoaPage>
  );
}

export default StructurePropertiesTab;

// Audit Log Viewer — Configuración › Sistema › Auditoría (/configuracion/sistema).
//
// Read-only window over the sealed audit chain (GET /audit-events, SHA-256
// chained). The backend does the filtering and the pagination from the
// Postgres mirror, so the screen only ships the visible page (50 rows) over
// the wire; the filter dropdowns come from /audit-events/facets so they
// reflect the whole organization, not just the current page. CSV export
// downloads the currently filtered page only (there is no «export everything
// matching» endpoint yet).
//
// Cocoa 22 (lote 10-A · lista / tabla): CocoaPage → CocoaSection «Filtros»
// (CocoaFormRow of CocoaField + CocoaDatePicker / CocoaSelect / CocoaInput)
// → CocoaSection padding="none" with the CocoaTable (a row opens its detail in
// a CocoaDrawer) and a footer with the page count and Anterior / Siguiente.
// Hosted in SistemaTabs the container paints the title; the actions row
// (Exportar CSV · Actualizar) is the page's own in both modes.

import { useEffect, useMemo, useState } from "react";
import type { AuditEvent } from "@hotelos/shared";
import { useApiData } from "../hooks/useApiData";
import { useToast } from "../components/Toast";
import { exportToCsv, type CsvColumn } from "../lib/csv";
import { dateTime, plural } from "../lib/format";
import { A11Y_LABELS, ACTIONS, PAGINATION, STATUS_LABELS } from "../content/actions";
import { useTabHost } from "./tabs/TabHost";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCard,
  CocoaDatePicker,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaState,
  CocoaTable,
  type CocoaSelectOption,
  type CocoaTableColumn
} from "../components/cocoa";

const PAGE_SIZE = 50;

type AuditListResponse = {
  items: AuditEvent[];
  total: number;
  limit: number;
  offset: number;
};

type AuditFacets = {
  actions: string[];
  entityTypes: string[];
  actors: string[];
};

function fmtDateTime(iso: string): string {
  return dateTime(iso, { style: "medium" });
}

function compact(value: unknown): string {
  // Short, human-friendly representation of a JSON blob for the CSV cell.
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Facet values as select options behind an explicit «all» choice (a real choice, not a placeholder). */
function facetOptions(values: string[] | undefined, allLabel: string): CocoaSelectOption[] {
  return [{ value: "", label: allLabel }, ...(values ?? []).map((value) => ({ value, label: value }))];
}

// Columns outside the component: the row type is the shared AuditEvent.
const COLUMNS: CocoaTableColumn<AuditEvent>[] = [
  { key: "createdAt", label: "Fecha", fit: true, render: (event) => <strong>{fmtDateTime(event.createdAt)}</strong> },
  {
    key: "actor",
    label: "Actor",
    render: (event) => (
      <>
        {event.actorUserId ?? "—"}
        <span className="cocoa-note">{event.actorType}</span>
      </>
    )
  },
  {
    key: "action",
    label: "Acción",
    render: (event) => (
      <CocoaBadge tone="info" uppercase={false}>
        {event.action}
      </CocoaBadge>
    )
  },
  { key: "entityType", label: "Entidad", hideOnNarrow: true },
  // qa#16 (1024 × 768): a 417 px column of cuids pushed the table 522 px past its wrap; desktop-only, fit and cut to 12 characters (the drawer shows the full id).
  { key: "entityId", label: "ID", fit: true, showFrom: "desktop", render: (event) => <code className="cocoa-mono" title={event.entityId ?? undefined}>{event.entityId ? `${event.entityId.slice(0, 12)}…` : "—"}</code> }
];

/** One JSON snapshot of the event («Antes» / «Después») as a collapsible block. */
function JsonBlock({ label, value, open }: { label: string; value: unknown; open?: boolean }) {
  return (
    <details open={open}>
      <summary className="cocoa-note">{label}</summary>
      <CocoaCard variant="bordered" padding="sm" style={{ marginTop: "var(--cocoa-space-2)" }}>
        <pre className="cocoa-mono" style={{ margin: 0, overflow: "auto", maxHeight: 240 }}>
          {JSON.stringify(value, null, 2)}
        </pre>
      </CocoaCard>
    </details>
  );
}

export function AuditLogViewer() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();

  // Filter state. The free-text box keeps a draft and debounces it into `q`
  // so we do not fire a request on every keystroke.
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [actionFilter, setActionFilter] = useState("");
  const [entityFilter, setEntityFilter] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    const handle = window.setTimeout(() => setSearch(searchDraft.trim()), 300);
    return () => window.clearTimeout(handle);
  }, [searchDraft]);

  // Back to the first page whenever a filter changes: paging through the old
  // result set's offset against a fresh predicate is almost always wrong.
  useEffect(() => {
    setPage(0);
  }, [fromDate, toDate, actionFilter, entityFilter, actorFilter, search]);

  const query = useMemo<Record<string, string | number | undefined>>(
    () => ({
      from: fromDate || undefined,
      to: toDate || undefined,
      action: actionFilter || undefined,
      entityType: entityFilter || undefined,
      actor: actorFilter || undefined,
      q: search || undefined,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE
    }),
    [fromDate, toDate, actionFilter, entityFilter, actorFilter, search, page]
  );

  const { data, loading, error, refresh } = useApiData<AuditListResponse>("/audit-events", { query });
  const { data: facets } = useApiData<AuditFacets>("/audit-events/facets");

  const items = useMemo<AuditEvent[]>(() => data?.items ?? [], [data]);
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const selected = selectedId ? (items.find((event) => event.id === selectedId) ?? null) : null;
  const filtersActive = Boolean(fromDate || toDate || actionFilter || entityFilter || actorFilter || search);

  function clearFilters() {
    setFromDate("");
    setToDate("");
    setActionFilter("");
    setEntityFilter("");
    setActorFilter("");
    setSearchDraft("");
    setSearch("");
    setPage(0);
  }

  function handleExportCsv() {
    if (items.length === 0) {
      showToast("No hay eventos para exportar", { variant: "info" });
      return;
    }
    const columns: CsvColumn<AuditEvent>[] = [
      { key: "createdAt", label: "Fecha", format: (v) => fmtDateTime(String(v ?? "")) },
      { key: "actorUserId", label: "Actor" },
      { key: "actorType", label: "Tipo de actor" },
      { key: "action", label: "Acción" },
      { key: "entityType", label: "Entidad" },
      { key: "entityId", label: "ID" },
      { key: "propertyId", label: "Propiedad" },
      { key: "correlationId", label: "Correlación" },
      { key: "beforeJson", label: "Antes", format: (v) => compact(v) },
      { key: "afterJson", label: "Después", format: (v) => compact(v) },
      { key: "currentHash", label: "Hash" }
    ];
    const stamp = new Date().toISOString().slice(0, 10);
    try {
      exportToCsv(items, `audit-events-${stamp}`, columns);
      showToast(`Exportados ${plural(items.length, "evento", "eventos")} a CSV (página actual)`, { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo exportar a CSV.";
      showToast(message, { variant: "error" });
    }
  }

  const actionOptions = useMemo(() => facetOptions(facets?.actions, "Todas"), [facets]);
  const entityOptions = useMemo(() => facetOptions(facets?.entityTypes, "Todas"), [facets]);
  const actorOptions = useMemo(() => facetOptions(facets?.actors, "Todos"), [facets]);

  const exportLabel = `${ACTIONS.export} CSV`;
  const ready = !error && items.length > 0;

  const footer = ready ? (
    <>
      <span>
        {PAGINATION.page(safePage + 1, pageCount)} · {items.length} de {plural(total, "evento", "eventos")}
      </span>
      {pageCount > 1 ? (
        <span className="cocoa-cluster">
          <CocoaButton variant="bordered" tone="neutral" size="small" disabled={safePage === 0 || loading} onClick={() => setPage(safePage - 1)} aria-label={A11Y_LABELS.previousPage}>
            {PAGINATION.previous}
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" disabled={safePage >= pageCount - 1 || loading} onClick={() => setPage(safePage + 1)} aria-label={A11Y_LABELS.nextPage}>
            {PAGINATION.next}
          </CocoaButton>
        </span>
      ) : null}
    </>
  ) : undefined;

  let body;
  if (error) {
    body = <CocoaState kind="error" title={STATUS_LABELS.loadError} message={error} onRetry={() => refresh()} />;
  } else if (!loading && items.length === 0) {
    body = (
      <CocoaState
        kind="empty"
        illustration={filtersActive ? "search" : "box"}
        title="Sin eventos"
        message={filtersActive ? "Ningún evento coincide con los filtros aplicados." : "Todavía no se ha registrado ninguna acción auditada."}
        primaryAction={filtersActive ? { label: ACTIONS.clearFilters, onClick: clearFilters } : undefined}
      />
    );
  } else {
    body = (
      <CocoaTable
        columns={COLUMNS}
        rows={items}
        rowKey="id"
        loading={loading && items.length === 0}
        selectedKey={selected?.id}
        onSelect={(event) => setSelectedId(event.id)}
        rowActions={(event) => (
          <CocoaButton
            variant="plain"
            size="small"
            onClick={(click) => {
              click.stopPropagation();
              setSelectedId(event.id);
            }}
          >
            {ACTIONS.view}
          </CocoaButton>
        )}
        caption="Eventos auditados"
        aria-label="Eventos auditados"
      />
    );
  }

  return (
    <CocoaPage
      eyebrow="Configuración · Sistema"
      title="Registro de auditoría"
      subtitle={hosted ? undefined : "Cadena sellada SHA-256 de eventos críticos: configuración, mapeo, módulos, integraciones, facturación, IA, QR, importaciones y puesta en marcha."}
      actions={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={handleExportCsv} disabled={loading || items.length === 0}>
            {exportLabel}
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => refresh()} disabled={loading}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      commands={[
        { id: "audit-export-csv", label: `${exportLabel}: registro de auditoría`, run: handleExportCsv },
        { id: "audit-refresh", label: `${ACTIONS.refresh} registro de auditoría`, run: () => refresh() }
      ]}
    >
      <CocoaSection
        title="Filtros"
        meta={data ? plural(total, "evento", "eventos") : undefined}
        action={
          <CocoaButton variant="plain" size="small" onClick={clearFilters} disabled={!filtersActive}>
            {ACTIONS.clearFilters}
          </CocoaButton>
        }
      >
        <CocoaFormRow columns={3} min={200} role="group" aria-label="Filtros del registro de auditoría">
          <CocoaField label="Desde">
            <CocoaDatePicker value={fromDate} onChange={setFromDate} />
          </CocoaField>
          <CocoaField label="Hasta">
            <CocoaDatePicker value={toDate} onChange={setToDate} min={fromDate || undefined} />
          </CocoaField>
          <CocoaField label="Acción">
            <CocoaSelect value={actionFilter} onChange={setActionFilter} options={actionOptions} />
          </CocoaField>
          <CocoaField label="Entidad">
            <CocoaSelect value={entityFilter} onChange={setEntityFilter} options={entityOptions} />
          </CocoaField>
          <CocoaField label="Actor">
            <CocoaSelect value={actorFilter} onChange={setActorFilter} options={actorOptions} />
          </CocoaField>
          <CocoaField label="Buscar por ID o correlación">
            <CocoaInput value={searchDraft} onChange={setSearchDraft} placeholder="res_… o corr_…" inputMode="search" autoComplete="off" />
          </CocoaField>
        </CocoaFormRow>
      </CocoaSection>

      <CocoaSection padding={ready ? "none" : "md"} style={{ overflow: "clip" }} aria-label="Eventos auditados" footer={footer}>
        {body}
      </CocoaSection>

      <CocoaDrawer
        open={selected !== null}
        onClose={() => setSelectedId(null)}
        title="Detalles del evento"
        subtitle={selected ? `${selected.action} · ${fmtDateTime(selected.createdAt)}` : undefined}
        side="right"
        size="md"
        footer={
          <CocoaButton variant="bordered" tone="neutral" onClick={() => setSelectedId(null)}>
            {ACTIONS.close}
          </CocoaButton>
        }
      >
        {selected ? (
          <div className="cocoa-stack" data-gap="4">
            <ul className="c22-section__list" aria-label="Datos del evento">
              <li>
                <span>Identificador</span>
                <code className="cocoa-mono">{selected.id}</code>
              </li>
              <li>
                <span>Actor</span>
                <strong>{selected.actorUserId ?? "—"}</strong>
              </li>
              <li>
                <span>Tipo de actor</span>
                <strong>{selected.actorType}</strong>
              </li>
              <li>
                <span>Entidad</span>
                <strong>{selected.entityType}</strong>
              </li>
              <li>
                <span>ID de la entidad</span>
                <code className="cocoa-mono">{selected.entityId ?? "—"}</code>
              </li>
              {selected.correlationId ? (
                <li>
                  <span>Correlación</span>
                  <code className="cocoa-mono">{selected.correlationId}</code>
                </li>
              ) : null}
              {selected.ipAddress ? (
                <li>
                  <span>IP</span>
                  <strong>{selected.ipAddress}</strong>
                </li>
              ) : null}
              <li>
                <span>Hash</span>
                <code className="cocoa-mono">{selected.currentHash.slice(0, 16)}…</code>
              </li>
            </ul>
            {selected.beforeJson !== undefined ? <JsonBlock label="Antes" value={selected.beforeJson} /> : null}
            {selected.afterJson !== undefined ? <JsonBlock label="Después" value={selected.afterJson} open /> : null}
          </div>
        ) : null}
      </CocoaDrawer>
    </CocoaPage>
  );
}

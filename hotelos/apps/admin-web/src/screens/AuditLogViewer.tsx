// Audit Log Viewer — read-only window over the sealed audit chain.
//
// Lists events returned by GET /audit-events (sealed via SHA-256 chain). The
// backend now does server-side filtering and pagination from the Postgres
// mirror, so this screen ships only the visible slice over the wire. Filter
// dropdowns are hydrated from /audit-events/facets so the lists reflect the
// full org-wide set rather than just the current page.
//
// The table uses a lightweight row windowing pass (render only the visible
// rows + a small overscan) so wider page sizes don't tank scroll perf. CSV
// export downloads the currently-filtered page only — exporting the entire
// chain would need an explicit "export all matching" backend endpoint we
// haven't built yet.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AuditEvent } from "@hotelos/shared";
import { useApiData } from "../hooks/useApiData";
import { LoadingBlock, ErrorState, EmptyState } from "../components/States";
import { useToast } from "../components/Toast";
import { exportToCsv, type CsvColumn } from "../lib/csv";

const PAGE_SIZE = 50;
const ROW_HEIGHT = 56; // matches `.cm-table tbody tr` baseline (kept in sync with styles.css)
const VIEWPORT_HEIGHT = 560;
const OVERSCAN = 6;

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
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("es-ES", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function compact(value: unknown): string {
  // Short, human-friendly representation of a JSON blob for the table cell.
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function AuditLogViewer() {
  const { showToast } = useToast();

  // Filter UI state. We hold separate "draft" state for the free-text box and
  // debounce it into `q` so we don't fire a request on every keystroke.
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

  // Reset to the first page whenever a filter changes — paging through the old
  // result set's offset against a fresh predicate is almost always wrong.
  useEffect(() => {
    setPage(0);
  }, [fromDate, toDate, actionFilter, entityFilter, actorFilter, search]);

  const query = useMemo<Record<string, string | number | undefined>>(() => ({
    from: fromDate || undefined,
    to: toDate || undefined,
    action: actionFilter || undefined,
    entityType: entityFilter || undefined,
    actor: actorFilter || undefined,
    q: search || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE
  }), [fromDate, toDate, actionFilter, entityFilter, actorFilter, search, page]);

  const { data, loading, error, refresh } = useApiData<AuditListResponse>("/audit-events", { query });
  const { data: facets } = useApiData<AuditFacets>("/audit-events/facets");

  const items = useMemo<AuditEvent[]>(() => data?.items ?? [], [data]);
  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const selected = selectedId ? items.find((event) => event.id === selectedId) ?? null : null;

  // Row windowing — we render only the rows currently visible in the scroll
  // viewport (plus a small overscan) and pad with spacer divs above/below so
  // the scrollbar geometry stays correct. Keeps DOM weight bounded for large
  // page sizes.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    setScrollTop(scrollRef.current.scrollTop);
  }, []);
  // Reset scroll position when the result set changes (filter / page / refresh).
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [items]);

  const visibleStart = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleEnd = Math.min(items.length, Math.ceil((scrollTop + VIEWPORT_HEIGHT) / ROW_HEIGHT) + OVERSCAN);
  const visibleRows = items.slice(visibleStart, visibleEnd);
  const padTop = visibleStart * ROW_HEIGHT;
  const padBottom = Math.max(0, (items.length - visibleEnd) * ROW_HEIGHT);

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
      showToast(`Exportados ${items.length} eventos a CSV (página actual)`, { variant: "success" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "No se pudo exportar a CSV.";
      showToast(message, { variant: "error" });
    }
  }

  const actionOptions = facets?.actions ?? [];
  const entityOptions = facets?.entityTypes ?? [];
  const actorOptions = facets?.actors ?? [];

  return (
    <section className="bo-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <header className="bo-card-head">
        <div>
          <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12 }}>Audit</p>
          <h2 style={{ color: "var(--ink)" }}>Audit Log Viewer</h2>
          <p className="bo-muted" style={{ marginTop: 4, textTransform: "none" }}>
            Cadena sellada SHA-256 de eventos críticos: setup, mapeo, módulos, integraciones, facturación, IA, QR, importaciones y go-live.
          </p>
        </div>
        <div className="bo-pill-row">
          <button type="button" className="bo-button" onClick={handleExportCsv} disabled={loading || items.length === 0}>Exportar CSV</button>
          <button type="button" onClick={() => refresh()} disabled={loading}>↻ Actualizar</button>
        </div>
      </header>

      <article className="bo-card" style={{ background: "var(--surface)" }}>
        <div className="bo-card-head"><h3 style={{ color: "var(--ink)" }}>Filtros</h3></div>
        <div className="bo-row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="bo-form-field" style={{ margin: 0, minWidth: 150 }}>
            <span>Desde</span>
            <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
          </label>
          <label className="bo-form-field" style={{ margin: 0, minWidth: 150 }}>
            <span>Hasta</span>
            <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </label>
          <label className="bo-form-field" style={{ margin: 0, minWidth: 180 }}>
            <span>Acción</span>
            <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
              <option value="">Todas</option>
              {actionOptions.map((action) => <option key={action} value={action}>{action}</option>)}
            </select>
          </label>
          <label className="bo-form-field" style={{ margin: 0, minWidth: 180 }}>
            <span>Entidad</span>
            <select value={entityFilter} onChange={(e) => setEntityFilter(e.target.value)}>
              <option value="">Todas</option>
              {entityOptions.map((entity) => <option key={entity} value={entity}>{entity}</option>)}
            </select>
          </label>
          <label className="bo-form-field" style={{ margin: 0, minWidth: 200 }}>
            <span>Actor</span>
            <select value={actorFilter} onChange={(e) => setActorFilter(e.target.value)}>
              <option value="">Todos</option>
              {actorOptions.map((actor) => <option key={actor} value={actor}>{actor}</option>)}
            </select>
          </label>
          <label className="bo-form-field" style={{ margin: 0, minWidth: 220 }}>
            <span>Buscar (ID/correlación)</span>
            <input
              type="search"
              value={searchDraft}
              placeholder="ej. res_… o corr_…"
              onChange={(e) => setSearchDraft(e.target.value)}
            />
          </label>
          <button type="button" className="bo-button-link" onClick={clearFilters}>Limpiar</button>
          <span className="bo-muted" style={{ marginLeft: "auto", textTransform: "none" }}>
            {total} {total === 1 ? "evento" : "eventos"}
          </span>
        </div>
      </article>

      {loading && !data ? (
        <LoadingBlock label="Cargando registro de auditoría…" />
      ) : error ? (
        <ErrorState title="No se pudo cargar" message={error} onRetry={() => refresh()} />
      ) : items.length === 0 ? (
        <EmptyState
          title="Sin eventos"
          message={total === 0 && !fromDate && !toDate && !actionFilter && !entityFilter && !actorFilter && !search
            ? "Todavía no se ha registrado ninguna acción auditada."
            : "Ningún evento coincide con los filtros aplicados."}
          actions={total > 0 ? <button type="button" onClick={clearFilters}>Limpiar filtros</button> : undefined}
        />
      ) : (
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Eventos auditados</h3>
            <span className="bo-chip">{total}</span>
          </div>
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="rev-report-wrap"
            style={{ maxHeight: VIEWPORT_HEIGHT, overflowY: "auto", position: "relative" }}
          >
            <table className="cm-table" style={{ tableLayout: "fixed", width: "100%" }}>
              <thead>
                <tr>
                  <th style={{ width: 180 }}>Fecha</th>
                  <th style={{ width: 200 }}>Actor</th>
                  <th>Acción</th>
                  <th style={{ width: 160 }}>Entidad</th>
                  <th>ID</th>
                  <th style={{ width: 90 }}>Detalles</th>
                </tr>
              </thead>
              <tbody>
                {padTop > 0 ? (
                  <tr aria-hidden style={{ height: padTop }}>
                    <td colSpan={6} style={{ padding: 0, border: 0 }} />
                  </tr>
                ) : null}
                {visibleRows.map((event) => (
                  <tr
                    key={event.id}
                    style={{ height: ROW_HEIGHT, cursor: "pointer" }}
                    onClick={() => setSelectedId(event.id === selectedId ? null : event.id)}
                  >
                    <td><strong>{fmtDateTime(event.createdAt)}</strong></td>
                    <td>
                      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        <span>{event.actorUserId ?? <span className="bo-muted">—</span>}</span>
                        <span className="bo-muted" style={{ fontSize: 11, textTransform: "none" }}>{event.actorType}</span>
                      </div>
                    </td>
                    <td><span className="bo-status info" style={{ textTransform: "none" }}>{event.action}</span></td>
                    <td>{event.entityType}</td>
                    <td><code style={{ fontSize: 11 }}>{event.entityId ?? "—"}</code></td>
                    <td>
                      <button
                        type="button"
                        className="bo-button-link"
                        onClick={(e) => { e.stopPropagation(); setSelectedId(event.id === selectedId ? null : event.id); }}
                      >
                        {event.id === selectedId ? "Ocultar" : "Ver"}
                      </button>
                    </td>
                  </tr>
                ))}
                {padBottom > 0 ? (
                  <tr aria-hidden style={{ height: padBottom }}>
                    <td colSpan={6} style={{ padding: 0, border: 0 }} />
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          {selected ? (
            <div style={{ marginTop: 12, padding: 12, background: "var(--surface-soft)", borderRadius: "var(--radius-md, 8px)", border: "1px solid var(--line-soft)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <strong>Detalles del evento</strong>
                <code style={{ fontSize: 11 }}>{selected.id}</code>
              </div>
              {selected.correlationId ? <p style={{ margin: "4px 0", fontSize: 12 }}><span className="bo-muted">Correlación · </span><code>{selected.correlationId}</code></p> : null}
              {selected.ipAddress ? <p style={{ margin: "4px 0", fontSize: 12 }}><span className="bo-muted">IP · </span>{selected.ipAddress}</p> : null}
              <p style={{ margin: "4px 0", fontSize: 12 }}><span className="bo-muted">Hash · </span><code style={{ fontSize: 11 }}>{selected.currentHash.slice(0, 16)}…</code></p>
              {selected.beforeJson !== undefined ? (
                <details style={{ marginTop: 6 }}>
                  <summary style={{ cursor: "pointer", fontSize: 12 }} className="bo-muted">Antes</summary>
                  <pre style={{ fontSize: 11, marginTop: 4, overflow: "auto", maxHeight: 200 }}>{JSON.stringify(selected.beforeJson, null, 2)}</pre>
                </details>
              ) : null}
              {selected.afterJson !== undefined ? (
                <details style={{ marginTop: 6 }} open>
                  <summary style={{ cursor: "pointer", fontSize: 12 }} className="bo-muted">Después</summary>
                  <pre style={{ fontSize: 11, marginTop: 4, overflow: "auto", maxHeight: 200 }}>{JSON.stringify(selected.afterJson, null, 2)}</pre>
                </details>
              ) : null}
            </div>
          ) : null}

          {pageCount > 1 ? (
            <div className="bo-row" style={{ justifyContent: "space-between", marginTop: 12, alignItems: "center" }}>
              <span className="bo-muted" style={{ fontSize: 12, textTransform: "none" }}>
                Página {safePage + 1} de {pageCount} · {items.length} de {total} mostrados
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" disabled={safePage === 0 || loading} onClick={() => setPage(safePage - 1)}>← Anterior</button>
                <button type="button" disabled={safePage >= pageCount - 1 || loading} onClick={() => setPage(safePage + 1)}>Siguiente →</button>
              </div>
            </div>
          ) : null}
        </article>
      )}
    </section>
  );
}

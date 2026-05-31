// RateJournalScreen — historial de cambios de tarifas (audit log).
//
// Vista de solo lectura sobre el journal que crea cada bulk-update del rate
// grid (`/properties/:id/rate-grid/journal`). Cada entrada captura quién hizo
// el cambio, cuántas celdas se tocaron, el motivo opcional, a qué canales se
// empujó y el estado del push (`draft`, `pushed`, `failed`). Permite filtrar
// por rango de fechas y por email del usuario, y al hacer click sobre una
// fila abre un drawer con el detalle completo formateado.
//
// Diseño: Cocoa Edition. Solo tokens `--cocoa-*` para mantener paridad
// light/dark. Comparte primitivas con el resto de pantallas (`CocoaPageHeader`,
// `CocoaTable`, `CocoaCard`, `CocoaSheet`, `CocoaInput`, `CocoaButton`).
//
// El endpoint acepta `limit` pero no rango de fechas, así que filtramos en
// cliente sobre la última ventana cargada (`JOURNAL_LIMIT` entradas). Es
// coherente con otras pantallas de auditoría (ver `AuditLogViewer`).

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { RateChangeJournalEntry } from "@hotelos/shared";
import { fetchRateJournal } from "../../services/rateGridApi";
import { getActivePropertyId } from "../../services/activeProperty";
import { CocoaPageHeader } from "../../components/cocoa/CocoaPageHeader";
import { CocoaTable, type CocoaTableColumn } from "../../components/cocoa/CocoaTable";
import { CocoaCard } from "../../components/cocoa/CocoaCard";
import { CocoaSheet } from "../../components/cocoa/CocoaSheet";
import { CocoaInput } from "../../components/cocoa/CocoaInput";
import { CocoaButton } from "../../components/cocoa/CocoaButton";
import { LoadingBlock, ErrorState } from "../../components/States";

const JOURNAL_LIMIT = 200;

// -----------------------------------------------------------------------------
// Date / time helpers — `Intl` formatters en es-ES para mantener paridad con el
// resto de pantallas. Las fechas vienen como ISO 8601 UTC desde el backend.
// -----------------------------------------------------------------------------

const RELATIVE_FORMATTER = new Intl.RelativeTimeFormat("es-ES", { numeric: "auto" });
const DATE_TIME_FORMATTER = new Intl.DateTimeFormat("es-ES", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit"
});

function parseIso(value: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtAbsoluteDateTime(iso: string): string {
  const d = parseIso(iso);
  return d ? DATE_TIME_FORMATTER.format(d) : iso;
}

function fmtRelative(iso: string, now: Date): string {
  const d = parseIso(iso);
  if (!d) return iso;
  const deltaMs = d.getTime() - now.getTime();
  const absMs = Math.abs(deltaMs);
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;
  const WEEK = 7 * DAY;
  if (absMs < MINUTE) return RELATIVE_FORMATTER.format(Math.round(deltaMs / 1000), "second");
  if (absMs < HOUR) return RELATIVE_FORMATTER.format(Math.round(deltaMs / MINUTE), "minute");
  if (absMs < DAY) return RELATIVE_FORMATTER.format(Math.round(deltaMs / HOUR), "hour");
  if (absMs < WEEK) return RELATIVE_FORMATTER.format(Math.round(deltaMs / DAY), "day");
  return RELATIVE_FORMATTER.format(Math.round(deltaMs / WEEK), "week");
}

// `<input type="date">` espera YYYY-MM-DD; la comparación con el ISO completo
// del backend funciona directamente porque ambos son lexicográficos.
function isoDate(iso: string): string {
  return iso.slice(0, 10);
}

// -----------------------------------------------------------------------------
// Inline Cocoa primitives — pequeños badges y status pills coherentes con el
// resto del Cocoa Edition. Vivirán inline hasta que el set primitivo cubra
// estos casos.
// -----------------------------------------------------------------------------

type PushStatus = RateChangeJournalEntry["pushStatus"];

const PUSH_STATUS_TONES: Record<PushStatus, { fg: string; bg: string; label: string }> = {
  draft: {
    fg: "var(--cocoa-label-secondary)",
    bg: "var(--cocoa-background-sidebar)",
    label: "Borrador"
  },
  pushed: {
    fg: "var(--cocoa-success)",
    bg: "rgb(48 209 88 / 0.18)",
    label: "Pusheado"
  },
  failed: {
    fg: "var(--cocoa-danger)",
    bg: "rgb(255 69 58 / 0.18)",
    label: "Fallido"
  }
};

function PushStatusPill({ status }: { status: PushStatus }) {
  const tone = PUSH_STATUS_TONES[status];
  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px var(--cocoa-space-2)",
    borderRadius: "var(--cocoa-radius-full)",
    background: tone.bg,
    color: tone.fg,
    fontSize: "var(--cocoa-fs-caption)",
    fontWeight: 600,
    fontFamily: "var(--cocoa-font)",
    lineHeight: 1.4,
    whiteSpace: "nowrap"
  };
  return <span style={style}>{tone.label}</span>;
}

function ChannelBadge({ children }: { children: ReactNode }) {
  const style: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    padding: "2px var(--cocoa-space-2)",
    borderRadius: "var(--cocoa-radius-full)",
    background: "var(--cocoa-background-sidebar)",
    color: "var(--cocoa-label-secondary)",
    fontSize: "var(--cocoa-fs-caption)",
    fontWeight: 600,
    fontFamily: "var(--cocoa-font)",
    lineHeight: 1.4
  };
  return <span style={style}>{children}</span>;
}

function ChannelBadgeRow({ channels }: { channels: string[] }) {
  if (channels.length === 0) {
    return (
      <span
        style={{
          color: "var(--cocoa-label-tertiary)",
          fontFamily: "var(--cocoa-font)",
          fontSize: "var(--cocoa-fs-callout)"
        }}
      >
        —
      </span>
    );
  }
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: 4 }}>
      {channels.map((channel) => (
        <ChannelBadge key={channel}>{channel}</ChannelBadge>
      ))}
    </span>
  );
}

// -----------------------------------------------------------------------------
// Detail drawer — muestra todos los campos disponibles de la entrada y un
// bloque `<pre>` JSON-formateado. El tipo `RateChangeJournalEntry` no expone
// hoy `changesJson` (solo `changesCount`), así que esta vista cubre el resto
// del payload conocido. Cuando el backend exponga el delta detallado, se
// inyecta aquí sin cambios estructurales.
// -----------------------------------------------------------------------------

interface DetailDrawerProps {
  entry: RateChangeJournalEntry | null;
  onClose: () => void;
}

function DetailDrawer({ entry, onClose }: DetailDrawerProps) {
  const open = entry !== null;
  // El cuerpo del drawer se renderiza solo cuando hay `entry`; CocoaSheet
  // gestiona el unmount con animación.
  return (
    <CocoaSheet open={open} onClose={onClose} size="lg" title="Detalle del cambio">
      {entry ? <DetailDrawerBody entry={entry} /> : null}
    </CocoaSheet>
  );
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  const rowStyle: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "160px 1fr",
    gap: "var(--cocoa-space-3)",
    paddingBlock: "var(--cocoa-space-2)",
    borderBottom: "1px solid var(--cocoa-separator)"
  };
  const labelStyle: CSSProperties = {
    color: "var(--cocoa-label-secondary)",
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-caption)",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "var(--cocoa-tracking-wide)",
    margin: 0
  };
  const valueStyle: CSSProperties = {
    color: "var(--cocoa-label)",
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-body)",
    margin: 0,
    minWidth: 0,
    overflowWrap: "anywhere"
  };
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <div style={valueStyle}>{value}</div>
    </div>
  );
}

function DetailDrawerBody({ entry }: { entry: RateChangeJournalEntry }) {
  // Pretty-print del payload conocido. Cuando el backend exponga
  // `changesJson` (delta celda a celda) se sustituye este bloque.
  const formatted = useMemo(() => JSON.stringify(entry, null, 2), [entry]);

  const preStyle: CSSProperties = {
    margin: 0,
    padding: "var(--cocoa-space-3)",
    background: "var(--cocoa-background-sidebar)",
    border: "1px solid var(--cocoa-separator)",
    borderRadius: "var(--cocoa-radius-md)",
    color: "var(--cocoa-label)",
    fontFamily: "var(--cocoa-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
    fontSize: "var(--cocoa-fs-callout)",
    lineHeight: 1.5,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    maxHeight: 360,
    overflow: "auto"
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--cocoa-space-4)" }}>
      <section>
        <DetailRow label="Fecha" value={fmtAbsoluteDateTime(entry.timestamp)} />
        <DetailRow label="Usuario" value={entry.userEmail ?? entry.userId} />
        <DetailRow label="User ID" value={<code>{entry.userId}</code>} />
        <DetailRow label="Celdas cambiadas" value={entry.changesCount.toLocaleString("es-ES")} />
        <DetailRow label="Motivo" value={entry.reason ?? "—"} />
        <DetailRow label="Estado" value={<PushStatusPill status={entry.pushStatus} />} />
        <DetailRow label="Canales" value={<ChannelBadgeRow channels={entry.pushedTo} />} />
        <DetailRow label="Property" value={<code>{entry.propertyId}</code>} />
        <DetailRow label="Entry ID" value={<code>{entry.id}</code>} />
      </section>

      <section>
        <h3
          style={{
            color: "var(--cocoa-label)",
            fontFamily: "var(--cocoa-font)",
            fontSize: "var(--cocoa-fs-subheadline)",
            fontWeight: 600,
            margin: "0 0 var(--cocoa-space-2) 0"
          }}
        >
          Payload JSON
        </h3>
        <pre style={preStyle}>{formatted}</pre>
      </section>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Inline icons — coherentes con el resto de pantallas Cocoa.
// -----------------------------------------------------------------------------

const ICON_SIZE = 14;

function IconRefresh() {
  return (
    <svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M13.5 8.5a5.5 5.5 0 1 1-1.6-3.9" />
      <path d="M13.5 2.5v3.5h-3.5" />
    </svg>
  );
}

function IconSearch() {
  return (
    <svg
      width={ICON_SIZE}
      height={ICON_SIZE}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </svg>
  );
}

// -----------------------------------------------------------------------------
// Filters bar — rango de fechas + búsqueda por email. La eliminación de los
// filtros se ofrece como un botón "plain" sólo cuando hay algún filtro activo.
// -----------------------------------------------------------------------------

interface FiltersBarProps {
  fromDate: string;
  toDate: string;
  emailQuery: string;
  filteredCount: number;
  totalCount: number;
  onFromDateChange: (value: string) => void;
  onToDateChange: (value: string) => void;
  onEmailQueryChange: (value: string) => void;
  onClear: () => void;
}

function FiltersBar({
  fromDate,
  toDate,
  emailQuery,
  filteredCount,
  totalCount,
  onFromDateChange,
  onToDateChange,
  onEmailQueryChange,
  onClear
}: FiltersBarProps) {
  const rowStyle: CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-end",
    gap: "var(--cocoa-space-3)"
  };
  const fieldStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-1)",
    minWidth: 160
  };
  const labelStyle: CSSProperties = {
    color: "var(--cocoa-label-secondary)",
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-caption)",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "var(--cocoa-tracking-wide)"
  };
  const nativeDateStyle: CSSProperties = {
    height: 28,
    padding: "0 8px",
    borderRadius: "var(--cocoa-radius-md)",
    border: "1px solid var(--cocoa-separator)",
    background: "var(--cocoa-background-control)",
    color: "var(--cocoa-label)",
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-body)"
  };
  const countStyle: CSSProperties = {
    marginLeft: "auto",
    color: "var(--cocoa-label-secondary)",
    fontFamily: "var(--cocoa-font)",
    fontSize: "var(--cocoa-fs-callout)"
  };

  const hasFilter = fromDate.length > 0 || toDate.length > 0 || emailQuery.length > 0;

  return (
    <div style={rowStyle}>
      <div style={fieldStyle}>
        <span style={labelStyle}>Desde</span>
        <input
          type="date"
          value={fromDate}
          onChange={(e) => onFromDateChange(e.target.value)}
          style={nativeDateStyle}
          aria-label="Fecha desde"
        />
      </div>
      <div style={fieldStyle}>
        <span style={labelStyle}>Hasta</span>
        <input
          type="date"
          value={toDate}
          onChange={(e) => onToDateChange(e.target.value)}
          style={nativeDateStyle}
          aria-label="Fecha hasta"
        />
      </div>
      <div style={{ ...fieldStyle, minWidth: 240, flex: 1 }}>
        <span style={labelStyle}>Email del usuario</span>
        <CocoaInput
          value={emailQuery}
          onChange={onEmailQueryChange}
          placeholder="Buscar por email…"
          icon={<IconSearch />}
          size="small"
        />
      </div>
      {hasFilter ? (
        <CocoaButton variant="plain" size="small" tone="neutral" onClick={onClear}>
          Limpiar filtros
        </CocoaButton>
      ) : null}
      <span style={countStyle}>
        {filteredCount === totalCount
          ? `${totalCount} entradas`
          : `${filteredCount} de ${totalCount} entradas`}
      </span>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Pantalla principal — carga el journal del propietario activo, expone los
// filtros y abre el drawer al hacer click sobre una fila.
// -----------------------------------------------------------------------------

export function RateJournalScreen() {
  const propertyId = useMemo(() => getActivePropertyId(), []);

  const [entries, setEntries] = useState<RateChangeJournalEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [emailQuery, setEmailQuery] = useState<string>("");

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // `now` se fija en el primer render para que el formateo relativo de cada
  // fila sea estable durante toda la sesión de la pantalla. Si quisiéramos
  // refrescar la etiqueta cada minuto, lo movemos a un `setInterval`.
  const now = useMemo(() => new Date(), []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await fetchRateJournal(propertyId, JOURNAL_LIMIT);
      setEntries(items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar el historial de cambios.");
    } finally {
      setLoading(false);
    }
  }, [propertyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(() => {
    const lowerEmail = emailQuery.trim().toLowerCase();
    return entries.filter((entry) => {
      const dateKey = isoDate(entry.timestamp);
      if (fromDate && dateKey < fromDate) return false;
      if (toDate && dateKey > toDate) return false;
      if (lowerEmail.length > 0) {
        const haystack = (entry.userEmail ?? "").toLowerCase();
        if (!haystack.includes(lowerEmail)) return false;
      }
      return true;
    });
  }, [entries, fromDate, toDate, emailQuery]);

  const selectedEntry = useMemo(
    () => (selectedId ? entries.find((entry) => entry.id === selectedId) ?? null : null),
    [entries, selectedId]
  );

  function handleClearFilters() {
    setFromDate("");
    setToDate("");
    setEmailQuery("");
  }

  // -----------------------------------------------------------------
  // Columnas de la tabla. Los `render` funcionan sobre
  // `RateChangeJournalEntry` para mantener type-safety con la API genérica
  // de `CocoaTable<Row>`.
  // -----------------------------------------------------------------
  const columns: CocoaTableColumn<RateChangeJournalEntry>[] = useMemo(
    () => [
      {
        key: "timestamp",
        label: "Cuándo",
        render: (entry) => (
          <span title={fmtAbsoluteDateTime(entry.timestamp)}>{fmtRelative(entry.timestamp, now)}</span>
        )
      },
      {
        key: "userEmail",
        label: "Usuario",
        render: (entry) => (
          <span style={{ color: "var(--cocoa-label)" }}>{entry.userEmail ?? entry.userId}</span>
        )
      },
      {
        key: "changesCount",
        label: "Celdas",
        align: "right",
        render: (entry) => entry.changesCount.toLocaleString("es-ES")
      },
      {
        key: "reason",
        label: "Motivo",
        render: (entry) => entry.reason ?? "—"
      },
      {
        key: "pushedTo",
        label: "Canales",
        render: (entry) => <ChannelBadgeRow channels={entry.pushedTo} />
      },
      {
        key: "pushStatus",
        label: "Estado",
        render: (entry) => <PushStatusPill status={entry.pushStatus} />
      }
    ],
    [now]
  );

  const screenStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: "var(--cocoa-space-4)",
    fontFamily: "var(--cocoa-font)"
  };

  const headerActions = (
    <CocoaButton
      variant="bordered"
      tone="neutral"
      icon={<IconRefresh />}
      onClick={() => void load()}
      loading={loading}
    >
      Actualizar
    </CocoaButton>
  );

  return (
    <div style={screenStyle}>
      <CocoaPageHeader
        eyebrow="Revenue"
        title="Historial de cambios de tarifas"
        subtitle="Audit log completo de cambios y push a canales."
        actions={headerActions}
      />

      <CocoaCard variant="bordered" padding="md">
        <FiltersBar
          fromDate={fromDate}
          toDate={toDate}
          emailQuery={emailQuery}
          filteredCount={filtered.length}
          totalCount={entries.length}
          onFromDateChange={setFromDate}
          onToDateChange={setToDate}
          onEmailQueryChange={setEmailQuery}
          onClear={handleClearFilters}
        />
      </CocoaCard>

      {loading && entries.length === 0 ? (
        <LoadingBlock label="Cargando historial…" />
      ) : error ? (
        <ErrorState title="No se pudo cargar" message={error} onRetry={() => void load()} />
      ) : (
        <CocoaCard variant="bordered" padding="none">
          <CocoaTable<RateChangeJournalEntry>
            columns={columns}
            rows={filtered}
            rowKey="id"
            selectedKey={selectedId ?? undefined}
            onSelect={(row) => setSelectedId(row.id)}
            emptyState={
              entries.length === 0
                ? "Todavía no hay cambios registrados para esta propiedad."
                : "Ninguna entrada coincide con los filtros aplicados."
            }
          />
        </CocoaCard>
      )}

      <DetailDrawer entry={selectedEntry} onClose={() => setSelectedId(null)} />
    </div>
  );
}

export default RateJournalScreen;

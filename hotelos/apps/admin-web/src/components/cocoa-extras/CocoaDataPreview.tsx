// CocoaDataPreview — read-only dump of an API object or of a list of records
// in Cocoa 22 (ola 11 · R2; replaces the `DataPreview` of the legacy
// components/forms kit, which painted `.dp-*`, `.cm-table` and `.bo-*`).
//
//   list of records   → CocoaTable compact: scalar columns in order of first
//                       appearance (`columnsForRecords`), ids and JSON blobs
//                       hidden, capped at RECORDS_TABLE_MAX_COLUMNS columns and
//                       RECORDS_TABLE_MAX_ROWS rows; a `cocoa-note` says how
//                       many records there are and how many are painted.
//   object            → `cocoa-stack` of key/value rows (`cocoa-row`): the key
//                       as `cocoa-caption` (Spanish label from content/data-labels,
//                       the screen's own field labels win) and the value as
//                       text, `cocoa-mono` (ids, numbers) or a CocoaBadge (Sí/No).
//   nested object     → <details open> with the key as summary and the object
//                       inside; a nested list of records shows a neutral badge
//                       with the count and starts collapsed.
//   list of primitives → cluster of neutral CocoaBadge.
//
// Layout comes only from the utilities of styles/cocoa-base.css and the
// primitives (no inline styles, no colours); `data-cocoa="data-preview*"` are
// the hooks for the css lot.

import type { ReactNode } from "react";
import { booleanLabel, dataKeyLabel } from "../../content/data-labels";
import { dateTime, plural } from "../../lib/format";
import { CocoaBadge } from "../cocoa/CocoaBadge";
import { CocoaTable, type CocoaTableColumn } from "../cocoa/CocoaTable";

type Labels = Record<string, string> | undefined;
type Record_ = Record<string, unknown>;

function isPlainObject(value: unknown): value is Record_ {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** True for an id-like or JSON-blob key: hidden from the compact records table (visible in the key/value view). */
export function isTechnicalKey(key: string): boolean {
  return key === "id" || /(^|[a-z])Id$/.test(key) || /Json$/.test(key);
}

/** Cap of columns in the compact records table (the widest useful row at 1280 px). */
export const RECORDS_TABLE_MAX_COLUMNS = 8;
/** Cap of rows painted by the compact records table. */
export const RECORDS_TABLE_MAX_ROWS = 200;

/**
 * Columns of a compact table for a list of records: scalar keys in order of
 * first appearance, without ids or JSON blobs, capped at RECORDS_TABLE_MAX_COLUMNS.
 */
export function columnsForRecords(rows: Array<Record_>): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (isTechnicalKey(key)) continue;
      if (value !== null && typeof value === "object") continue;
      columns.push(key);
    }
  }
  return columns.slice(0, RECORDS_TABLE_MAX_COLUMNS);
}

type Scalar = { display: string; state?: boolean; mono?: boolean };

/** Display of a scalar (pure): «—» for null, Sí/No for booleans (as a badge), local date-time for ISO stamps, mono for ids and numbers. */
export function formatScalar(value: unknown): Scalar {
  if (value === null || value === undefined) return { display: "—" };
  if (typeof value === "boolean") return { display: booleanLabel(value), state: value };
  if (typeof value === "number") return { display: String(value), mono: true };
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(new Date(value).getTime())) return { display: dateTime(value) };
    const isId = /^[a-z]+_[a-z0-9]+$/i.test(value) || /^[a-f0-9]{12,}$/i.test(value) || /^cm[a-z0-9]{20,}$/i.test(value);
    return { display: value, mono: isId };
  }
  return { display: String(value), mono: true };
}

function ScalarValue({ value }: { value: unknown }) {
  const fmt = formatScalar(value);
  if (fmt.state !== undefined) {
    return (
      <CocoaBadge tone={fmt.state ? "success" : "neutral"} size="small">
        {fmt.display}
      </CocoaBadge>
    );
  }
  return <span className={fmt.mono ? "cocoa-mono" : undefined} data-cocoa="data-preview-value">{fmt.display}</span>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="cocoa-row" data-gap="2" data-align="baseline" data-cocoa="data-preview-row">
      <span className="cocoa-caption">{label}</span>
      {children}
    </div>
  );
}

function Nested({ label, count, open, children }: { label: string; count?: number; open: boolean; children: ReactNode }) {
  return (
    <details open={open || undefined} data-cocoa="data-preview-nested">
      <summary>
        <span className="cocoa-caption">{label}</span>
        {count !== undefined ? (
          <>
            {" "}
            <CocoaBadge tone="neutral" size="small">{count}</CocoaBadge>
          </>
        ) : null}
      </summary>
      <div className="cocoa-stack" data-gap="2">{children}</div>
    </details>
  );
}

function DataField(props: { label: string; value: unknown; labels?: Labels }) {
  const { value } = props;
  const label = dataKeyLabel(props.label, props.labels);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return (
        <Row label={label}>
          <span className="cocoa-note">vacío</span>
        </Row>
      );
    }
    if (value.every((v) => typeof v === "string" || typeof v === "number")) {
      return (
        <Row label={label}>
          <span className="cocoa-cluster">
            {value.map((v, i) => (
              <CocoaBadge key={i} tone="neutral" size="small">{String(v)}</CocoaBadge>
            ))}
          </span>
        </Row>
      );
    }
    return (
      <Nested label={label} count={value.length} open={false}>
        <DataPreview data={value} labels={props.labels} />
      </Nested>
    );
  }
  if (isPlainObject(value)) {
    return (
      <Nested label={label} open>
        <DataPreview data={value} labels={props.labels} />
      </Nested>
    );
  }
  return (
    <Row label={label}>
      <ScalarValue value={value} />
    </Row>
  );
}

/** Compact table for a list of records (one row per record, scalar columns only). */
function RecordsTable(props: { rows: Array<Record_>; labels?: Labels }) {
  const columnKeys = columnsForRecords(props.rows);
  const visible = props.rows.slice(0, RECORDS_TABLE_MAX_ROWS);
  if (columnKeys.length === 0) {
    return (
      <div className="cocoa-stack" data-gap="3" data-cocoa="data-preview-list">
        {visible.map((row, i) => (
          <DataPreview key={i} data={row} labels={props.labels} />
        ))}
      </div>
    );
  }
  const columns: Array<CocoaTableColumn<Record_>> = columnKeys.map((key) => ({
    key,
    label: dataKeyLabel(key, props.labels),
    render: (row) => <ScalarValue value={row[key]} />
  }));
  const rows = visible.map((row, i) => ({ ...row, __key: typeof row.id === "string" ? row.id : String(i) }));
  const summary = plural(props.rows.length, "registro", "registros", { withCount: true });
  return (
    <div className="cocoa-stack" data-gap="2" data-cocoa="data-preview-records" data-records-table={props.rows.length}>
      <p className="cocoa-note">
        {summary}
        {props.rows.length > visible.length ? ` · se muestran los ${visible.length} primeros` : ""}
      </p>
      <CocoaTable columns={columns} rows={rows} rowKey="__key" density="compact" aria-label={summary} />
    </div>
  );
}

export function DataPreview(props: {
  data: Record_ | unknown[] | null | undefined;
  emptyMessage?: string;
  /** Field labels of the screen (key → label); they win over the shared dictionary. */
  labels?: Labels;
}) {
  const data = props.data ?? {};
  if (Array.isArray(data)) {
    if (data.length === 0) return <p className="cocoa-note">{props.emptyMessage ?? "Sin datos."}</p>;
    if (data.every(isPlainObject)) return <RecordsTable rows={data} labels={props.labels} />;
    return (
      <div className="cocoa-stack" data-gap="3" data-cocoa="data-preview-list">
        {data.map((item, i) =>
          isPlainObject(item) ? <DataPreview key={i} data={item} labels={props.labels} /> : <span key={i}>{String(item)}</span>
        )}
      </div>
    );
  }
  const entries = Object.entries(data);
  if (entries.length === 0) {
    return <p className="cocoa-note">{props.emptyMessage ?? "Sin datos."}</p>;
  }
  return (
    <div className="cocoa-stack" data-gap="2" data-cocoa="data-preview">
      {entries.map(([key, value]) => (
        <DataField key={key} label={key} value={value} labels={props.labels} />
      ))}
    </div>
  );
}

export default DataPreview;

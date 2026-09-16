// RoomingListImportDialog — import a group's rooming list from a CSV.
//
// Cocoa 22 (ola 3 · lote 3-B, archetype «diálogo / drawer»): a CocoaDrawer
// (right, lg; bottom sheet on phones) with three CocoaFormSections: the file
// (CocoaFileInput: the only native file control lives in the primitive), the
// downloadable template and the preview (CocoaTable with the first ten rows,
// tinted rows for the invalid ones, aggregated errors in a callout). The
// footer has two buttons: Cancelar and «Importar N filas».
// POST /groups/:id/rooming-list/import with the valid rows only; the CSV
// parser (delimiter detection, quotes, header aliases in Spanish and
// English, date normalisation) is unchanged.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { apiRequest } from "../../services/api-client";
import { fetchRoomTypes, type AdminRoomType } from "../../services/pmsCommerceApi";
import { getActivePropertyId } from "../../services/activeProperty";
import { EMPTY, date, dateRange, number, plural } from "../../lib/format";
import { ACTIONS } from "../../content/actions";
import { DownloadIcon } from "../../components/cocoa-icons/ActionIcons";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDrawer,
  CocoaField,
  CocoaFileInput,
  CocoaFormSection,
  CocoaTable,
  type CocoaTableColumn
} from "../../components/cocoa";

// ─── Rooming list rows (what we parse) ───────────────────────────────────

type RawRow = Record<string, string>;

type ParsedRow = {
  index: number; // 1-based row number in the file
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  arrivalDate: string; // YYYY-MM-DD (normalised)
  departureDate: string;
  roomTypeCode: string;
  roomTypeId: string; // resolved from roomTypeCode
  sharing: string;
  dietary: string;
  specialRequests: string;
  // Validation
  isValid: boolean;
  errors: string[];
};

type ImportPayloadEntry = {
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  arrivalDate: string;
  departureDate: string;
  roomTypeId?: string;
  sharing?: string;
  dietary?: string;
  specialRequests?: string;
};

type ImportResult = {
  imported: number;
  // The backend may return more; only the count is needed here.
};

// ─── Header mapping (case insensitive · substring match) ─────────────────

type FieldKey =
  | "firstName"
  | "lastName"
  | "email"
  | "phone"
  | "arrivalDate"
  | "departureDate"
  | "roomTypeCode"
  | "sharing"
  | "dietary"
  | "specialRequests";

// Aliases per field, matched by substring (case insensitive).
const FIELD_ALIASES: Record<FieldKey, string[]> = {
  firstName: ["firstname", "first_name", "first name", "nombre"],
  lastName: ["lastname", "last_name", "last name", "apellido", "apellidos", "surname"],
  email: ["email", "e-mail", "correo"],
  phone: ["phone", "teléfono", "telefono", "tel", "móvil", "movil", "mobile"],
  arrivalDate: ["arrivaldate", "arrival_date", "arrival date", "arrival", "llegada", "checkin", "check-in", "check in"],
  departureDate: ["departuredate", "departure_date", "departure date", "departure", "salida", "checkout", "check-out", "check out"],
  roomTypeCode: ["roomtypecode", "room_type_code", "room type code", "roomtype", "room type", "tipo", "habitación", "habitacion"],
  sharing: ["sharing", "compartir", "share", "shared"],
  dietary: ["dietary", "diet", "dieta", "alergia", "alergias", "allergies"],
  specialRequests: ["specialrequests", "special_requests", "special requests", "observaciones", "notas", "notes", "requests", "comentarios"]
};

function detectFieldKey(header: string): FieldKey | null {
  const norm = header.trim().toLowerCase();
  if (!norm) return null;
  for (const key of Object.keys(FIELD_ALIASES) as FieldKey[]) {
    const aliases = FIELD_ALIASES[key];
    for (const alias of aliases) {
      if (norm.includes(alias)) return key;
    }
  }
  return null;
}

// ─── Small CSV parser without dependencies ───────────────────────────────
// Supports double quotes (escaped as "" inside quoted strings) and picks
// the delimiter (, or ;) by frequency in the header line.

function detectDelimiter(headerLine: string): "," | ";" {
  const commas = (headerLine.match(/,/g) ?? []).length;
  const semis = (headerLine.match(/;/g) ?? []).length;
  return semis > commas ? ";" : ",";
}

function splitCsvLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === "\"") {
        if (line[i + 1] === "\"") {
          cur += "\"";
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === "\"") {
        inQuotes = true;
      } else if (ch === delimiter) {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function parseCsv(text: string): RawRow[] {
  // Normalise line breaks (Windows / classic Mac) and drop the BOM.
  const cleaned = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = cleaned.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const delimiter = detectDelimiter(lines[0]);
  const headers = splitCsvLine(lines[0], delimiter);
  // Map every header to a known FieldKey (or null when unknown).
  const headerKeys: (FieldKey | null)[] = headers.map(detectFieldKey);
  const rows: RawRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i], delimiter);
    const row: RawRow = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headerKeys[c];
      if (!key) continue;
      const value = cells[c] ?? "";
      // A duplicated header never overwrites a value with an empty one.
      if (row[key] && !value) continue;
      row[key] = value;
    }
    // Keep rows with at least one useful field.
    if (Object.values(row).some((v) => v && v.length > 0)) rows.push(row);
  }
  return rows;
}

// ─── Date normalisation (YYYY-MM-DD) ─────────────────────────────────────
// Accepts YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, MM/DD/YYYY.

function toIsoDate(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m1 = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m1) {
    const dd = m1[1].padStart(2, "0");
    const mm = m1[2].padStart(2, "0");
    const yyyy = m1[3];
    return `${yyyy}-${mm}-${dd}`;
  }
  // Fallback: parse with Date and serialise again.
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  return "";
}

// ─── Row validation ──────────────────────────────────────────────────────

function validateRow(
  raw: RawRow,
  index: number,
  roomTypeMap: Map<string, string>,
  groupArrival: string,
  groupDeparture: string
): ParsedRow {
  const errors: string[] = [];
  const firstName = (raw.firstName ?? "").trim();
  const lastName = (raw.lastName ?? "").trim();
  const email = (raw.email ?? "").trim();
  const phone = (raw.phone ?? "").trim();
  const arrivalRaw = (raw.arrivalDate ?? "").trim();
  const departureRaw = (raw.departureDate ?? "").trim();
  const roomTypeCode = (raw.roomTypeCode ?? "").trim();
  const sharing = (raw.sharing ?? "").trim();
  const dietary = (raw.dietary ?? "").trim();
  const specialRequests = (raw.specialRequests ?? "").trim();

  if (!firstName) errors.push("nombre (firstName) obligatorio");
  if (!lastName) errors.push("apellidos (lastName) obligatorios");

  // Dates: validated when present in the file; otherwise inherited from the group.
  const arrivalDate = arrivalRaw ? toIsoDate(arrivalRaw) : groupArrival;
  const departureDate = departureRaw ? toIsoDate(departureRaw) : groupDeparture;
  if (arrivalRaw && !arrivalDate) errors.push(`llegada (arrivalDate) no válida: "${arrivalRaw}"`);
  if (departureRaw && !departureDate) errors.push(`salida (departureDate) no válida: "${departureRaw}"`);
  if (arrivalDate && departureDate && departureDate <= arrivalDate) {
    errors.push("la salida debe ser posterior a la llegada");
  }

  // Room type: a code, when given, must exist in the catalogue.
  let roomTypeId = "";
  if (roomTypeCode) {
    const found = roomTypeMap.get(roomTypeCode.toUpperCase());
    if (!found) errors.push(`el tipo de habitación "${roomTypeCode}" no existe`);
    else roomTypeId = found;
  }

  return {
    index,
    firstName,
    lastName,
    email,
    phone,
    arrivalDate,
    departureDate,
    roomTypeCode,
    roomTypeId,
    sharing,
    dietary,
    specialRequests,
    isValid: errors.length === 0,
    errors
  };
}

// ─── Downloadable template ───────────────────────────────────────────────

const TEMPLATE_HEADERS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "arrivalDate",
  "departureDate",
  "roomTypeCode",
  "sharing",
  "dietary",
  "specialRequests"
];

function buildTemplateCsv(arrivalDate: string, departureDate: string): string {
  const demo1 = [
    "María",
    "García",
    "maria@example.com",
    "+34 600 000 001",
    arrivalDate,
    departureDate,
    "DBL",
    "share-with-juan",
    "vegetarian",
    "Llegada tarde · planta alta"
  ];
  const demo2 = [
    "Juan",
    "López",
    "juan@example.com",
    "+34 600 000 002",
    arrivalDate,
    departureDate,
    "SUITE",
    "",
    "",
    "Aniversario · botella de cava"
  ];
  // Escape fields with commas or quotes.
  const escape = (v: string) => {
    if (v.includes(",") || v.includes("\"") || v.includes("\n")) {
      return `"${v.replace(/"/g, "\"\"")}"`;
    }
    return v;
  };
  const rows = [TEMPLATE_HEADERS, demo1, demo2].map((cols) => cols.map(escape).join(","));
  return rows.join("\n") + "\n";
}

function downloadTemplate(arrivalDate: string, departureDate: string, groupName: string) {
  const csv = buildTemplateCsv(arrivalDate, departureDate);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  // Simple slug of the group name.
  const slug = groupName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "group";
  a.href = url;
  a.download = `rooming-list-template-${slug}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Preview table ───────────────────────────────────────────────────────

const PREVIEW_COLUMNS: CocoaTableColumn<ParsedRow>[] = [
  { key: "index", label: "Fila", fit: true, align: "right", render: (r) => number(r.index) },
  { key: "firstName", label: "Nombre", minWidth: 120, render: (r) => r.firstName || EMPTY },
  { key: "lastName", label: "Apellidos", minWidth: 120, render: (r) => r.lastName || EMPTY },
  { key: "email", label: "Correo", hideOnNarrow: true, render: (r) => r.email || EMPTY },
  { key: "arrivalDate", label: "Llegada", fit: true, hideOnNarrow: true, render: (r) => date(r.arrivalDate) },
  { key: "departureDate", label: "Salida", fit: true, hideOnNarrow: true, render: (r) => date(r.departureDate) },
  {
    key: "roomTypeCode",
    label: "Tipo",
    fit: true,
    render: (r) =>
      r.roomTypeCode ? (
        <span className="cocoa-row" data-gap="1" data-wrap="nowrap">
          <span className="cocoa-mono">{r.roomTypeCode}</span>
          {r.roomTypeId ? null : (
            <CocoaBadge tone="danger" size="small">
              no existe
            </CocoaBadge>
          )}
        </span>
      ) : (
        EMPTY
      )
  },
  {
    key: "status",
    label: "Validación",
    fit: true,
    render: (r) =>
      r.isValid ? (
        <CocoaBadge tone="success" size="small">
          Correcta
        </CocoaBadge>
      ) : (
        <CocoaBadge tone="danger" size="small" title={r.errors.join("; ")}>
          Con errores
        </CocoaBadge>
      )
  }
];

// Secondary notes (captions under a control): identity from the system.
const NOTE_STYLE: CSSProperties = {
  margin: 0,
  color: "var(--cocoa-label-secondary)",
  fontSize: "var(--cocoa-fs-callout)"
};

// ─── Main component ──────────────────────────────────────────────────────

export function RoomingListImportDialog(props: {
  groupBookingId: string;
  groupName: string;
  arrivalDate: string;
  departureDate: string;
  onClose: () => void;
  onImported: (count: number) => void;
  onError: (msg: string) => void;
}) {
  const propertyId = useMemo(() => getActivePropertyId(), []);
  const [roomTypes, setRoomTypes] = useState<AdminRoomType[]>([]);
  const [loadingRoomTypes, setLoadingRoomTypes] = useState(true);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsedRows, setParsedRows] = useState<ParsedRow[] | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Latest error callback without re-running the catalogue fetch on every render.
  const onErrorRef = useRef(props.onError);
  onErrorRef.current = props.onError;

  // Room types on mount: builds the code → id map.
  useEffect(() => {
    let cancelled = false;
    setLoadingRoomTypes(true);
    fetchRoomTypes(propertyId)
      .then((rts) => {
        if (cancelled) return;
        setRoomTypes(rts);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        onErrorRef.current(`No se pudo cargar el catálogo de habitaciones: ${msg}`);
      })
      .finally(() => {
        if (!cancelled) setLoadingRoomTypes(false);
      });
    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  const roomTypeMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const rt of roomTypes) {
      if (rt.code) m.set(rt.code.toUpperCase(), rt.id);
    }
    return m;
  }, [roomTypes]);

  // Derived counts (valid / invalid / total).
  const stats = useMemo(() => {
    if (!parsedRows) return null;
    const total = parsedRows.length;
    const valid = parsedRows.filter((r) => r.isValid).length;
    const invalid = total - valid;
    return { total, valid, invalid };
  }, [parsedRows]);

  async function handleFile(file: File) {
    setFileName(file.name);
    setParseError(null);
    setParsedRows(null);
    try {
      const text = await file.text();
      const raw = parseCsv(text);
      if (raw.length === 0) {
        setParseError("El archivo no contiene filas de datos.");
        return;
      }
      // i + 2: row 1 is the header, so the first data row is row 2 of the file.
      const parsed: ParsedRow[] = raw.map((r, i) => validateRow(r, i + 2, roomTypeMap, props.arrivalDate, props.departureDate));
      setParsedRows(parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setParseError(`No se pudo leer el archivo: ${msg}`);
    }
  }

  function reset() {
    setFileName(null);
    setParsedRows(null);
    setParseError(null);
  }

  async function handleImport() {
    if (!parsedRows || !stats || stats.valid === 0) return;
    setSubmitting(true);
    try {
      const entries: ImportPayloadEntry[] = parsedRows
        .filter((r) => r.isValid)
        .map((r) => ({
          firstName: r.firstName,
          lastName: r.lastName,
          email: r.email || undefined,
          phone: r.phone || undefined,
          arrivalDate: r.arrivalDate,
          departureDate: r.departureDate,
          roomTypeId: r.roomTypeId || undefined,
          sharing: r.sharing || undefined,
          dietary: r.dietary || undefined,
          specialRequests: r.specialRequests || undefined
        }));
      const result = await apiRequest<ImportResult>(`/groups/${props.groupBookingId}/rooming-list/import`, { method: "POST", body: { entries } });
      props.onImported(result.imported ?? entries.length);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      props.onError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  // Aggregated errors (row + message).
  const aggregatedErrors = useMemo(() => {
    if (!parsedRows) return [];
    const out: { row: number; message: string }[] = [];
    for (const r of parsedRows) {
      if (r.errors.length === 0) continue;
      for (const e of r.errors) out.push({ row: r.index, message: e });
    }
    return out;
  }, [parsedRows]);

  const previewRows = useMemo(() => parsedRows?.slice(0, 10) ?? [], [parsedRows]);
  const stay = dateRange(props.arrivalDate, props.departureDate);

  return (
    <CocoaDrawer
      open
      onClose={props.onClose}
      title="Importar rooming list"
      subtitle={`${props.groupName} · ${stay}`}
      side="right"
      size="lg"
      footer={
        <>
          <CocoaButton variant="bordered" tone="neutral" onClick={props.onClose} disabled={submitting}>
            {ACTIONS.cancel}
          </CocoaButton>
          <CocoaButton
            variant="filled"
            tone="accent"
            onClick={() => void handleImport()}
            loading={submitting}
            disabled={submitting || !stats || stats.valid === 0}
          >
            {stats ? `Importar ${plural(stats.valid, "fila", "filas")}` : ACTIONS.import}
          </CocoaButton>
        </>
      }
    >
      <div className="cocoa-stack" data-gap="4">
        <p style={NOTE_STYLE}>
          Sube un CSV con los huéspedes del grupo. Las cabeceras se admiten en inglés (firstName, lastName, arrivalDate…) y en español (nombre, apellido,
          llegada, salida, observaciones…). Las fechas que falten en el archivo heredan las del grupo ({stay}).
        </p>

        <CocoaFormSection title="1 · Selecciona el archivo">
          <div className="cocoa-row" data-gap="2" data-align="end">
            <CocoaField label="Archivo CSV" required help="Delimitador detectado automáticamente (coma o punto y coma).">
              <CocoaFileInput
                accept=".csv,text/csv,application/vnd.ms-excel"
                label="Elegir CSV"
                fileName={fileName}
                onPick={(file) => void handleFile(file)}
                onReject={(message) => setParseError(message)}
                disabled={loadingRoomTypes || submitting}
              />
            </CocoaField>
            {fileName ? (
              <CocoaButton variant="plain" tone="neutral" size="small" onClick={reset} disabled={submitting}>
                Quitar archivo
              </CocoaButton>
            ) : null}
          </div>
          <p style={NOTE_STYLE}>
            {loadingRoomTypes ? "Cargando tipos de habitación…" : plural(roomTypes.length, "tipo de habitación disponible", "tipos de habitación disponibles")}
          </p>
          {parseError ? (
            <CocoaCallout tone="danger" title={parseError} role="alert">
              {null}
            </CocoaCallout>
          ) : null}
        </CocoaFormSection>

        <CocoaFormSection
          title="2 · Plantilla (opcional)"
          description="Si no tienes un CSV preparado, descarga la plantilla (cabeceras y dos huéspedes de ejemplo con las fechas del grupo), edítala con tu hoja de cálculo y súbela aquí."
          actions={
            <CocoaButton
              variant="bordered"
              tone="neutral"
              size="small"
              icon={<DownloadIcon size={14} />}
              onClick={() => downloadTemplate(props.arrivalDate, props.departureDate, props.groupName)}
            >
              Descargar plantilla CSV
            </CocoaButton>
          }
        >
          <p style={NOTE_STYLE}>Cabeceras: {TEMPLATE_HEADERS.join(", ")}</p>
        </CocoaFormSection>

        {parsedRows && stats ? (
          <CocoaFormSection title="3 · Vista previa y validación">
            <div className="cocoa-cluster">
              <CocoaBadge tone="neutral">Total {number(stats.total)}</CocoaBadge>
              <CocoaBadge tone="success">Válidas {number(stats.valid)}</CocoaBadge>
              {stats.invalid > 0 ? <CocoaBadge tone="danger">Con errores {number(stats.invalid)}</CocoaBadge> : null}
            </div>

            <CocoaTable<ParsedRow>
              columns={PREVIEW_COLUMNS}
              rows={previewRows}
              rowKey={(r) => String(r.index)}
              rowTone={(r) => (r.isValid ? undefined : "danger")}
              density="compact"
              caption="Vista previa de la rooming list"
              aria-label="Vista previa de la rooming list"
            />

            {parsedRows.length > 10 ? <p style={NOTE_STYLE}>Mostrando 10 de {plural(parsedRows.length, "fila", "filas")}.</p> : null}

            {aggregatedErrors.length > 0 ? (
              <CocoaCallout tone="danger" title={`${plural(aggregatedErrors.length, "error detectado", "errores detectados")}`}>
                <ul style={{ margin: 0, paddingLeft: "var(--cocoa-space-4)", maxHeight: 140, overflowY: "auto" }}>
                  {aggregatedErrors.slice(0, 20).map((e, idx) => (
                    <li key={idx}>
                      Fila {number(e.row)}: {e.message}
                    </li>
                  ))}
                  {aggregatedErrors.length > 20 ? <li>…y {plural(aggregatedErrors.length - 20, "más", "más")}.</li> : null}
                </ul>
              </CocoaCallout>
            ) : null}
          </CocoaFormSection>
        ) : null}

        <p style={NOTE_STYLE}>{stats ? `Se importarán ${number(stats.valid)} de ${plural(stats.total, "fila", "filas")}.` : "Sube un archivo para ver la vista previa."}</p>
      </div>
    </CocoaDrawer>
  );
}

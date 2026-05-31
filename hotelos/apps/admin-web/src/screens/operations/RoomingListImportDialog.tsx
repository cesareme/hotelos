import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from "react";
import { apiRequest } from "../../services/api-client";
import { fetchRoomTypes, type AdminRoomType } from "../../services/pmsCommerceApi";
import { getActivePropertyId } from "../../services/activeProperty";

// ─── Styles compartidos con NewGroupDialog ───────────────────────────────

const fieldsetStyle: CSSProperties = {
  border: "1px solid var(--border, #e5e7eb)",
  borderRadius: "var(--radius-sm, 6px)",
  padding: 12,
  margin: 0
};

const legendStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--ink-soft, #555)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  padding: "0 6px"
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid var(--border, #d1d5db)",
  borderRadius: "var(--radius-sm, 6px)",
  background: "var(--surface, white)",
  color: "var(--ink, #1a1a1a)",
  fontSize: 14,
  fontFamily: "inherit"
};

function Field(props: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13, color: "var(--ink)" }}>
      <span style={{ fontWeight: 500 }}>{props.label}</span>
      {props.children}
      {props.hint ? <span className="bo-muted" style={{ fontSize: 11 }}>{props.hint}</span> : null}
    </label>
  );
}

// ─── Tipos de entrada del rooming list (lo que parseamos) ────────────────

type RawRow = Record<string, string>;

type ParsedRow = {
  index: number;        // 1-based row number en el archivo
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  arrivalDate: string;  // YYYY-MM-DD (normalizado)
  departureDate: string;
  roomTypeCode: string;
  roomTypeId: string;   // resuelto a partir de roomTypeCode
  sharing: string;
  dietary: string;
  specialRequests: string;
  // Validación
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
  // El backend podría devolver más cosas, pero solo necesitamos el conteo.
};

// ─── Mapeo de cabeceras (case insensitive · substring match) ─────────────

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

// Lista de aliases por campo. Buscamos por substring (case insensitive).
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

// ─── Parser CSV simple sin dependencias ──────────────────────────────────
// Soporta comilla doble (escape "" dentro de cadenas entrecomilladas)
// y detecta delimitador (, o ;) según frecuencia en la primera línea.

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
  // Normaliza saltos de línea (Windows / Mac classic) y elimina BOM.
  const cleaned = text.replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = cleaned.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const delimiter = detectDelimiter(lines[0]);
  const headers = splitCsvLine(lines[0], delimiter);
  // Mapea cada cabecera a una FieldKey conocida (o null si no se reconoce).
  const headerKeys: (FieldKey | null)[] = headers.map(detectFieldKey);
  const rows: RawRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i], delimiter);
    const row: RawRow = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headerKeys[c];
      if (!key) continue;
      const value = cells[c] ?? "";
      // Si ya tenemos valor (cabecera duplicada), no sobrescribir si nuevo está vacío.
      if (row[key] && !value) continue;
      row[key] = value;
    }
    // Solo añadir filas con al menos un campo útil.
    if (Object.values(row).some((v) => v && v.length > 0)) rows.push(row);
  }
  return rows;
}

// ─── Normalización de fechas (YYYY-MM-DD) ────────────────────────────────
// Acepta formatos comunes: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, MM/DD/YYYY.

function toIsoDate(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  // Ya viene en YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  // DD/MM/YYYY o DD-MM-YYYY
  const m1 = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m1) {
    const dd = m1[1].padStart(2, "0");
    const mm = m1[2].padStart(2, "0");
    const yyyy = m1[3];
    return `${yyyy}-${mm}-${dd}`;
  }
  // Fallback: parsear con Date y volver a serializar.
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }
  return "";
}

// ─── Validación de fila ──────────────────────────────────────────────────

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

  if (!firstName) errors.push("firstName obligatorio");
  if (!lastName) errors.push("lastName obligatorio");

  // Fechas: si vienen en el archivo se validan; si no, heredan del grupo.
  const arrivalDate = arrivalRaw ? toIsoDate(arrivalRaw) : groupArrival;
  const departureDate = departureRaw ? toIsoDate(departureRaw) : groupDeparture;
  if (arrivalRaw && !arrivalDate) errors.push(`arrivalDate inválida: "${arrivalRaw}"`);
  if (departureRaw && !departureDate) errors.push(`departureDate inválida: "${departureRaw}"`);
  if (arrivalDate && departureDate && departureDate <= arrivalDate) {
    errors.push("departure debe ser posterior a arrival");
  }

  // Room type: si viene código se exige que exista en el catálogo.
  let roomTypeId = "";
  if (roomTypeCode) {
    const found = roomTypeMap.get(roomTypeCode.toUpperCase());
    if (!found) errors.push(`roomTypeCode "${roomTypeCode}" no existe`);
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

// ─── Template descargable ────────────────────────────────────────────────

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
  // Escapamos campos con comas o comillas
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
  // Slugificación sencilla del nombre de grupo
  const slug = groupName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "group";
  a.href = url;
  a.download = `rooming-list-template-${slug}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Componente principal ────────────────────────────────────────────────

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
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Cargar room types al montar para construir mapping code → id.
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
        props.onError(`No se pudo cargar el catálogo de habitaciones: ${msg}`);
      })
      .finally(() => {
        if (!cancelled) setLoadingRoomTypes(false);
      });
    return () => { cancelled = true; };
  }, [propertyId, props]);

  const roomTypeMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const rt of roomTypes) {
      if (rt.code) m.set(rt.code.toUpperCase(), rt.id);
    }
    return m;
  }, [roomTypes]);

  // Stats derivadas (válidas / inválidas / total)
  const stats = useMemo(() => {
    if (!parsedRows) return null;
    const total = parsedRows.length;
    const valid = parsedRows.filter((r) => r.isValid).length;
    const invalid = total - valid;
    return { total, valid, invalid };
  }, [parsedRows]);

  async function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
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
      const parsed: ParsedRow[] = raw.map((r, i) =>
        validateRow(r, i + 2, roomTypeMap, props.arrivalDate, props.departureDate)
        // i + 2 porque la fila 1 es la cabecera y la primera fila de datos es la fila 2 del archivo.
      );
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
    if (fileInputRef.current) fileInputRef.current.value = "";
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
      const result = await apiRequest<ImportResult>(
        `/groups/${props.groupBookingId}/rooming-list/import`,
        { method: "POST", body: { entries } }
      );
      props.onImported(result.imported ?? entries.length);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      props.onError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  // Errores agregados (para chip rojo)
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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="rooming-import-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.55)",
        backdropFilter: "blur(2px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16
      }}
      onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}
      onKeyDown={(e) => { if (e.key === "Escape") props.onClose(); }}
    >
      <div
        className="bo-card"
        style={{
          width: "100%",
          maxWidth: 760,
          maxHeight: "92vh",
          overflow: "auto",
          background: "var(--surface-1, var(--surface))",
          padding: "var(--space-5, 20px)",
          borderRadius: "var(--radius-md, 12px)",
          display: "flex",
          flexDirection: "column",
          gap: 12
        }}
      >
        {/* Header */}
        <div className="bo-card-head" style={{ marginBottom: 4 }}>
          <div>
            <p
              className="bo-muted"
              style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 11, margin: 0 }}
            >
              Operaciones · Groups &amp; Events
            </p>
            <h3 id="rooming-import-title" style={{ margin: "2px 0 0 0" }}>
              Importar rooming list · {props.groupName}
            </h3>
          </div>
          <div className="bo-row" style={{ gap: 8 }}>
            <button
              type="button"
              onClick={() => downloadTemplate(props.arrivalDate, props.departureDate, props.groupName)}
              title="Descarga un CSV de ejemplo con cabeceras y 2 filas demo."
            >
              Descargar template
            </button>
            <button
              type="button"
              onClick={props.onClose}
              aria-label="Cerrar"
              style={{ background: "transparent", border: "none", fontSize: 20, cursor: "pointer", color: "var(--ink)" }}
            >×</button>
          </div>
        </div>

        <p className="bo-muted" style={{ margin: 0, fontSize: 13 }}>
          Sube un CSV con los huéspedes del grupo. Las cabeceras admitidas son
          tanto en inglés (firstName, lastName, arrivalDate, …) como en español
          (nombre, apellido, llegada, salida, observaciones…). Las fechas
          ausentes en el archivo heredan las del grupo
          ({props.arrivalDate} → {props.departureDate}).
        </p>

        {/* 1. Uploader */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>1 · Selecciona archivo</legend>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, alignItems: "end" }}>
            <Field label="Archivo CSV *" hint="Delimitador autodetectado (coma o punto y coma).">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,text/csv,application/vnd.ms-excel"
                onChange={handleFileChange}
                disabled={loadingRoomTypes || submitting}
                style={inputStyle}
              />
            </Field>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {fileName ? (
                <button type="button" onClick={reset} disabled={submitting}>
                  Quitar archivo
                </button>
              ) : null}
              {loadingRoomTypes ? (
                <p className="bo-muted" style={{ fontSize: 12, margin: 0 }}>Cargando tipos de habitación…</p>
              ) : (
                <p className="bo-muted" style={{ fontSize: 12, margin: 0 }}>
                  {roomTypes.length} tipos de habitación disponibles
                </p>
              )}
            </div>
          </div>
          {fileName ? (
            <p className="bo-muted" style={{ margin: "8px 0 0 0", fontSize: 12 }}>
              Archivo: <strong>{fileName}</strong>
            </p>
          ) : null}
          {parseError ? (
            <p className="bo-status error" style={{ textTransform: "none", margin: "8px 0 0 0" }}>{parseError}</p>
          ) : null}
        </fieldset>

        {/* 2. Template */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>2 · Template (opcional)</legend>
          <p className="bo-muted" style={{ fontSize: 12, margin: 0 }}>
            Si no tienes un CSV preparado, descarga el template de ejemplo
            (cabeceras + 2 huéspedes demo con las fechas del grupo). Edítalo
            con tu hoja de cálculo preferida y vuelve a subirlo aquí.
          </p>
          <div className="bo-row" style={{ gap: 8, marginTop: 8 }}>
            <button
              type="button"
              onClick={() => downloadTemplate(props.arrivalDate, props.departureDate, props.groupName)}
            >
              Descargar template CSV
            </button>
            <p className="bo-muted" style={{ fontSize: 11, margin: "auto 0" }}>
              Cabeceras: {TEMPLATE_HEADERS.join(", ")}
            </p>
          </div>
        </fieldset>

        {/* 3. Preview */}
        {parsedRows && stats ? (
          <fieldset style={fieldsetStyle}>
            <legend style={legendStyle}>3 · Preview &amp; validación</legend>

            {/* Conteos */}
            <div className="bo-row" style={{ gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <span
                style={{
                  display: "inline-block",
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: "var(--surface-2, #f3f4f6)",
                  color: "var(--ink, #111)",
                  fontSize: 12
                }}
              >
                Total: <strong>{stats.total}</strong>
              </span>
              <span
                style={{
                  display: "inline-block",
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: "rgba(34,197,94,0.15)",
                  color: "#15803d",
                  fontSize: 12
                }}
              >
                Válidas: <strong>{stats.valid}</strong>
              </span>
              {stats.invalid > 0 ? (
                <span
                  style={{
                    display: "inline-block",
                    padding: "2px 8px",
                    borderRadius: 999,
                    background: "rgba(239,68,68,0.15)",
                    color: "#b91c1c",
                    fontSize: 12
                  }}
                >
                  Inválidas: <strong>{stats.invalid}</strong>
                </span>
              ) : null}
            </div>

            {/* Tabla preview · primeras 10 filas */}
            <div style={{ overflowX: "auto", border: "1px solid var(--border, #e5e7eb)", borderRadius: 6 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ background: "var(--surface-2, #f9fafb)", textAlign: "left" }}>
                    <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border, #e5e7eb)" }}>#</th>
                    <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border, #e5e7eb)" }}>Nombre</th>
                    <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border, #e5e7eb)" }}>Apellido</th>
                    <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border, #e5e7eb)" }}>Email</th>
                    <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border, #e5e7eb)" }}>Llegada</th>
                    <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border, #e5e7eb)" }}>Salida</th>
                    <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border, #e5e7eb)" }}>Tipo</th>
                    <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border, #e5e7eb)" }}>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {previewRows.map((r) => (
                    <tr key={r.index} style={{ background: r.isValid ? "transparent" : "rgba(239,68,68,0.05)" }}>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border, #f1f5f9)" }}>{r.index}</td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border, #f1f5f9)" }}>{r.firstName || "—"}</td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border, #f1f5f9)" }}>{r.lastName || "—"}</td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border, #f1f5f9)" }}>{r.email || "—"}</td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border, #f1f5f9)" }}>{r.arrivalDate || "—"}</td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border, #f1f5f9)" }}>{r.departureDate || "—"}</td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border, #f1f5f9)" }}>
                        {r.roomTypeCode ? `${r.roomTypeCode}${r.roomTypeId ? "" : " (✗)"}` : "—"}
                      </td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border, #f1f5f9)" }}>
                        {r.isValid ? (
                          <span style={{ color: "#15803d" }}>OK</span>
                        ) : (
                          <span style={{ color: "#b91c1c" }} title={r.errors.join("; ")}>Error</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {parsedRows.length > 10 ? (
              <p className="bo-muted" style={{ fontSize: 11, margin: "6px 0 0 0" }}>
                Mostrando 10 de {parsedRows.length} filas.
              </p>
            ) : null}

            {/* Chip rojo agregando errores */}
            {aggregatedErrors.length > 0 ? (
              <div
                style={{
                  marginTop: 10,
                  padding: 10,
                  borderRadius: 8,
                  background: "rgba(239,68,68,0.08)",
                  border: "1px solid rgba(239,68,68,0.3)",
                  color: "#7f1d1d",
                  fontSize: 12,
                  maxHeight: 140,
                  overflowY: "auto"
                }}
              >
                <strong>{aggregatedErrors.length} error(es) detectados:</strong>
                <ul style={{ margin: "6px 0 0 16px", padding: 0 }}>
                  {aggregatedErrors.slice(0, 20).map((e, idx) => (
                    <li key={idx}>Fila {e.row}: {e.message}</li>
                  ))}
                  {aggregatedErrors.length > 20 ? (
                    <li>…y {aggregatedErrors.length - 20} más.</li>
                  ) : null}
                </ul>
              </div>
            ) : null}
          </fieldset>
        ) : null}

        {/* Footer */}
        <div className="bo-row" style={{ gap: 8, justifyContent: "space-between", marginTop: 4 }}>
          <p className="bo-muted" style={{ fontSize: 12, margin: 0 }}>
            {stats ? `Importarán ${stats.valid} de ${stats.total} filas.` : "Sube un archivo para previsualizar."}
          </p>
          <div className="bo-row" style={{ gap: 8 }}>
            <button type="button" onClick={props.onClose} disabled={submitting}>
              Cancelar
            </button>
            <button
              type="button"
              className="primary"
              onClick={handleImport}
              disabled={submitting || !stats || stats.valid === 0}
            >
              {submitting
                ? "Importando…"
                : stats
                  ? `Importar ${stats.valid} fila(s)`
                  : "Importar todas"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

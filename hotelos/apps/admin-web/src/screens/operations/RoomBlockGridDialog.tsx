import { useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { apiRequest } from "../../services/api-client";
import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { LoadingBlock, EmptyState, ErrorState } from "../../components/States";

// ─── Tipos locales ───────────────────────────────────────────────────────

type RoomType = { id: string; code: string; name: string; baseOccupancy?: number };
type RoomBlockEntry = { roomTypeId: string; date: string; blockedCount: number };

// ─── Helpers de estilo (replicados de NewGroupDialog) ────────────────────

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

// Estilo específico de celda del grid: compacto.
const cellInputStyle: CSSProperties = {
  width: 50,
  height: 32,
  padding: "4px 6px",
  border: "1px solid var(--border, #d1d5db)",
  borderRadius: "var(--radius-sm, 6px)",
  background: "var(--surface, white)",
  color: "var(--ink, #1a1a1a)",
  fontSize: 13,
  fontFamily: "inherit",
  textAlign: "center"
};

const thStyle: CSSProperties = {
  background: "var(--surface-2, #f3f4f6)",
  color: "var(--ink-soft, #4b5563)",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  padding: "8px 6px",
  border: "1px solid var(--border, #e5e7eb)",
  position: "sticky",
  top: 0,
  zIndex: 2,
  whiteSpace: "nowrap"
};

const tdStyle: CSSProperties = {
  padding: "6px",
  border: "1px solid var(--border, #e5e7eb)",
  background: "var(--surface, white)",
  textAlign: "center",
  verticalAlign: "middle"
};

const rowHeaderStyle: CSSProperties = {
  ...tdStyle,
  background: "var(--surface-2, #f9fafb)",
  textAlign: "left",
  position: "sticky",
  left: 0,
  zIndex: 1,
  minWidth: 180
};

const totalCellStyle: CSSProperties = {
  ...tdStyle,
  background: "var(--surface-2, #f3f4f6)",
  fontWeight: 600,
  color: "var(--ink, #1f2937)"
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

// ─── Helpers de fechas ────────────────────────────────────────────────────

// Calcula array de fechas YYYY-MM-DD entre arrival (inclusive) y departure (exclusive).
// Esto es lo correcto en hospitality: no se bloquea la noche de check-out.
function nightsBetween(arrivalDate: string, departureDate: string): string[] {
  if (!arrivalDate || !departureDate) return [];
  const start = new Date(`${arrivalDate}T00:00:00`);
  const end = new Date(`${departureDate}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];
  if (end <= start) return [];
  const out: string[] = [];
  const cursor = new Date(start);
  while (cursor < end) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, "0");
    const d = String(cursor.getDate()).padStart(2, "0");
    out.push(`${y}-${m}-${d}`);
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function fmtDayLabel(iso: string): string {
  if (!iso) return "—";
  const [, m, d] = iso.split("-");
  if (!m || !d) return iso;
  return `${d}/${m}`;
}

function dayOfWeekShort(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("es-ES", { weekday: "short" });
}

// ─── Componente principal ────────────────────────────────────────────────

export function RoomBlockGridDialog(props: {
  groupBookingId: string;
  groupName: string;
  arrivalDate: string;
  departureDate: string;
  onClose: () => void;
  onSaved: (count: number) => void;
  onError: (msg: string) => void;
}) {
  const propertyId = getActivePropertyId();
  const roomTypesState = useApiData<{ items: RoomType[] }>(
    `/properties/${propertyId}/room-types`,
    { pollIntervalMs: 0 }
  );
  const roomTypes = roomTypesState.data?.items ?? [];

  const nights = useMemo(
    () => nightsBetween(props.arrivalDate, props.departureDate),
    [props.arrivalDate, props.departureDate]
  );

  // Matriz: clave "roomTypeId|date" → blockedCount (string para input controlado).
  const [matrix, setMatrix] = useState<Record<string, string>>({});

  // "Apply to row" mini-form: cada fila tiene su propio buffer de input.
  const [rowApplyValue, setRowApplyValue] = useState<Record<string, string>>({});
  // "Apply to column": idem por columna.
  const [colApplyValue, setColApplyValue] = useState<Record<string, string>>({});

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function cellKey(roomTypeId: string, date: string): string {
    return `${roomTypeId}|${date}`;
  }

  function getCell(roomTypeId: string, date: string): string {
    return matrix[cellKey(roomTypeId, date)] ?? "";
  }

  function setCell(roomTypeId: string, date: string, value: string) {
    // Sanea: solo enteros no negativos. Vacío permitido.
    const cleaned = value.replace(/[^0-9]/g, "");
    setMatrix((m) => ({ ...m, [cellKey(roomTypeId, date)]: cleaned }));
  }

  // Aplica el mismo valor a toda una fila (todas las noches del roomType).
  // Comportamiento defensivo: si la celda ya tiene un valor > 0, lo respeta;
  // sólo rellena las vacías. Esto evita pisar trabajo manual ya hecho.
  function applyToRow(roomTypeId: string) {
    const raw = (rowApplyValue[roomTypeId] ?? "").trim();
    const n = Number(raw);
    if (!raw || Number.isNaN(n) || n < 0) return;
    setMatrix((m) => {
      const next = { ...m };
      for (const date of nights) {
        const k = cellKey(roomTypeId, date);
        const current = next[k] ?? "";
        if (!current || current === "0") {
          next[k] = String(n);
        }
      }
      return next;
    });
  }

  // Aplica el mismo valor a toda una columna (todos los roomTypes en esa noche).
  function applyToColumn(date: string) {
    const raw = (colApplyValue[date] ?? "").trim();
    const n = Number(raw);
    if (!raw || Number.isNaN(n) || n < 0) return;
    setMatrix((m) => {
      const next = { ...m };
      for (const rt of roomTypes) {
        const k = cellKey(rt.id, date);
        const current = next[k] ?? "";
        if (!current || current === "0") {
          next[k] = String(n);
        }
      }
      return next;
    });
  }

  // Totales — derivados, no estado.
  const rowTotals = useMemo(() => {
    const out: Record<string, number> = {};
    for (const rt of roomTypes) {
      let sum = 0;
      for (const date of nights) {
        const v = Number(matrix[cellKey(rt.id, date)] ?? 0);
        if (!Number.isNaN(v)) sum += v;
      }
      out[rt.id] = sum;
    }
    return out;
  }, [matrix, roomTypes, nights]);

  const colTotals = useMemo(() => {
    const out: Record<string, number> = {};
    for (const date of nights) {
      let sum = 0;
      for (const rt of roomTypes) {
        const v = Number(matrix[cellKey(rt.id, date)] ?? 0);
        if (!Number.isNaN(v)) sum += v;
      }
      out[date] = sum;
    }
    return out;
  }, [matrix, roomTypes, nights]);

  const grandTotal = useMemo(
    () => Object.values(rowTotals).reduce((a, b) => a + b, 0),
    [rowTotals]
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!roomTypes.length) {
      return setError("No hay tipos de habitación disponibles.");
    }
    if (!nights.length) {
      return setError("El rango de fechas no contiene noches válidas.");
    }

    // Construye payload sólo con celdas > 0.
    const blocks: RoomBlockEntry[] = [];
    for (const rt of roomTypes) {
      for (const date of nights) {
        const raw = matrix[cellKey(rt.id, date)];
        if (!raw) continue;
        const n = Number(raw);
        if (Number.isNaN(n) || n <= 0) continue;
        blocks.push({ roomTypeId: rt.id, date, blockedCount: n });
      }
    }

    if (!blocks.length) {
      return setError("No hay cantidades a bloquear. Introduce al menos una celda > 0.");
    }

    setSubmitting(true);
    try {
      await apiRequest<{ ok: boolean; count?: number }>(
        `/groups/${props.groupBookingId}/room-blocks/bulk`,
        { method: "POST", body: { blocks } }
      );
      props.onSaved(blocks.length);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      props.onError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  // ─── Estados de carga / vacío / error ─────────────────────────────────

  let body: ReactNode;
  if (roomTypesState.loading) {
    body = <LoadingBlock label="Cargando tipos de habitación…" />;
  } else if (roomTypesState.error) {
    body = (
      <ErrorState
        message={roomTypesState.error}
        onRetry={() => roomTypesState.refresh()}
      />
    );
  } else if (!roomTypes.length) {
    body = (
      <EmptyState
        title="No hay tipos de habitación"
        message="Para poder bloquear inventario por grupo necesitas dar de alta tipos de habitación en el panel de Property Setup."
      />
    );
  } else if (!nights.length) {
    body = (
      <EmptyState
        title="Rango de fechas inválido"
        message="La fecha de salida debe ser posterior a la de llegada para poder bloquear noches."
      />
    );
  } else {
    body = (
      <>
        {/* Resumen contextual del bloqueo */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Bloqueo</legend>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
            <Field label="Grupo">
              <input type="text" value={props.groupName} disabled style={{ ...inputStyle, opacity: 0.85 }} />
            </Field>
            <Field label="Llegada">
              <input type="text" value={fmtDayLabel(props.arrivalDate)} disabled style={{ ...inputStyle, opacity: 0.85 }} />
            </Field>
            <Field label="Salida">
              <input type="text" value={fmtDayLabel(props.departureDate)} disabled style={{ ...inputStyle, opacity: 0.85 }} />
            </Field>
            <Field label="Noches">
              <input type="text" value={String(nights.length)} disabled style={{ ...inputStyle, opacity: 0.85 }} />
            </Field>
          </div>
        </fieldset>

        {/* Matriz noche × roomType */}
        <fieldset style={fieldsetStyle}>
          <legend style={legendStyle}>Matriz de bloqueo (habitaciones por noche)</legend>
          <p className="bo-muted" style={{ fontSize: 12, margin: "0 0 8px 0" }}>
            Introduce la cantidad de habitaciones a bloquear por tipo y noche. Sólo se enviarán
            celdas con cantidad mayor que 0. Usa los atajos por fila o columna para rellenar más rápido.
          </p>
          <div style={{ overflow: "auto", maxHeight: "55vh", border: "1px solid var(--border, #e5e7eb)", borderRadius: "var(--radius-sm, 6px)" }}>
            <table style={{ borderCollapse: "collapse", width: "auto", minWidth: "100%", fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ ...thStyle, position: "sticky", left: 0, zIndex: 3, minWidth: 180 }}>
                    Tipo de habitación
                  </th>
                  {nights.map((date) => (
                    <th key={date} style={thStyle} title={date}>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                        <span style={{ fontWeight: 700 }}>{fmtDayLabel(date)}</span>
                        <span style={{ fontWeight: 400, fontSize: 10, opacity: 0.7 }}>
                          {dayOfWeekShort(date)}
                        </span>
                      </div>
                    </th>
                  ))}
                  <th style={{ ...thStyle, minWidth: 70 }}>Total</th>
                  <th style={{ ...thStyle, minWidth: 160 }}>Aplicar a fila</th>
                </tr>
              </thead>
              <tbody>
                {roomTypes.map((rt) => (
                  <tr key={rt.id}>
                    <td style={rowHeaderStyle}>
                      <div style={{ display: "flex", flexDirection: "column" }}>
                        <span style={{ fontFamily: "monospace", fontSize: 11, color: "var(--ink-soft, #6b7280)" }}>
                          {rt.code}
                        </span>
                        <span style={{ fontWeight: 500 }}>{rt.name}</span>
                      </div>
                    </td>
                    {nights.map((date) => (
                      <td key={date} style={tdStyle}>
                        <input
                          type="text"
                          inputMode="numeric"
                          aria-label={`Bloqueo ${rt.code} ${fmtDayLabel(date)}`}
                          value={getCell(rt.id, date)}
                          onChange={(e) => setCell(rt.id, date, e.target.value)}
                          style={cellInputStyle}
                          placeholder="0"
                        />
                      </td>
                    ))}
                    <td style={totalCellStyle}>{rowTotals[rt.id] ?? 0}</td>
                    <td style={tdStyle}>
                      <div style={{ display: "flex", gap: 4, justifyContent: "center" }}>
                        <input
                          type="text"
                          inputMode="numeric"
                          aria-label={`Aplicar valor a toda la fila ${rt.code}`}
                          value={rowApplyValue[rt.id] ?? ""}
                          onChange={(e) =>
                            setRowApplyValue((v) => ({
                              ...v,
                              [rt.id]: e.target.value.replace(/[^0-9]/g, "")
                            }))
                          }
                          style={{ ...cellInputStyle, width: 60 }}
                          placeholder="N"
                        />
                        <button
                          type="button"
                          onClick={() => applyToRow(rt.id)}
                          title="Rellenar las celdas vacías de la fila con este valor"
                          style={{
                            padding: "4px 10px",
                            fontSize: 14,
                            lineHeight: 1,
                            cursor: "pointer",
                            border: "1px solid var(--border, #d1d5db)",
                            borderRadius: "var(--radius-sm, 6px)",
                            background: "var(--surface, white)",
                            color: "var(--ink)"
                          }}
                          aria-label={`Aplicar valor a fila ${rt.code}`}
                        >→</button>
                      </div>
                    </td>
                  </tr>
                ))}
                {/* Footer: totales por columna + atajo "aplicar a toda la columna" */}
                <tr>
                  <td style={{ ...rowHeaderStyle, fontWeight: 600 }}>Total por noche</td>
                  {nights.map((date) => (
                    <td key={date} style={totalCellStyle}>{colTotals[date] ?? 0}</td>
                  ))}
                  <td style={{ ...totalCellStyle, fontSize: 14, color: "var(--accent, #2563eb)" }}>
                    {grandTotal}
                  </td>
                  <td style={tdStyle} aria-hidden></td>
                </tr>
                <tr>
                  <td style={{ ...rowHeaderStyle, fontSize: 11, color: "var(--ink-soft, #6b7280)" }}>
                    Aplicar a columna ↓
                  </td>
                  {nights.map((date) => (
                    <td key={date} style={tdStyle}>
                      <div style={{ display: "flex", gap: 2, alignItems: "center", justifyContent: "center" }}>
                        <input
                          type="text"
                          inputMode="numeric"
                          aria-label={`Aplicar valor a columna ${fmtDayLabel(date)}`}
                          value={colApplyValue[date] ?? ""}
                          onChange={(e) =>
                            setColApplyValue((v) => ({
                              ...v,
                              [date]: e.target.value.replace(/[^0-9]/g, "")
                            }))
                          }
                          style={{ ...cellInputStyle, width: 38 }}
                          placeholder="N"
                        />
                        <button
                          type="button"
                          onClick={() => applyToColumn(date)}
                          title={`Rellenar las celdas vacías de ${fmtDayLabel(date)} con este valor`}
                          style={{
                            padding: "2px 6px",
                            fontSize: 12,
                            lineHeight: 1,
                            cursor: "pointer",
                            border: "1px solid var(--border, #d1d5db)",
                            borderRadius: "var(--radius-sm, 6px)",
                            background: "var(--surface, white)",
                            color: "var(--ink)"
                          }}
                          aria-label={`Aplicar valor a columna ${fmtDayLabel(date)}`}
                        >↓</button>
                      </div>
                    </td>
                  ))}
                  <td style={tdStyle} aria-hidden></td>
                  <td style={tdStyle} aria-hidden></td>
                </tr>
              </tbody>
            </table>
          </div>
        </fieldset>
      </>
    );
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="room-block-grid-title"
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
      <form
        onSubmit={submit}
        className="bo-card"
        style={{
          width: "100%",
          maxWidth: 920,
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
        <div className="bo-card-head" style={{ marginBottom: 4 }}>
          <div>
            <p className="bo-muted" style={{ textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 11, margin: 0 }}>
              Comercial · Groups &amp; Events
            </p>
            <h3 id="room-block-grid-title" style={{ margin: "2px 0 0 0" }}>
              Bloqueo de habitaciones · {props.groupName}
            </h3>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            aria-label="Cerrar"
            style={{ background: "transparent", border: "none", fontSize: 20, cursor: "pointer", color: "var(--ink)" }}
          >×</button>
        </div>

        <p className="bo-muted" style={{ margin: 0, fontSize: 13 }}>
          Edita el bloqueo de inventario noche × tipo de habitación para este grupo.
          Solo se enviarán celdas con cantidad mayor que 0.
        </p>

        {body}

        {error ? (
          <p className="bo-status error" style={{ textTransform: "none", margin: 0 }}>{error}</p>
        ) : null}

        <div className="bo-row" style={{ gap: 8, justifyContent: "space-between", marginTop: 4 }}>
          <p className="bo-muted" style={{ fontSize: 12, margin: 0 }}>
            Total bloqueado: <strong style={{ color: "var(--ink)" }}>{grandTotal}</strong> habitaciones-noche
          </p>
          <div className="bo-row" style={{ gap: 8 }}>
            <button type="button" onClick={props.onClose} disabled={submitting}>Cancelar</button>
            <button
              type="submit"
              className="primary"
              disabled={submitting || !roomTypes.length || !nights.length}
            >
              {submitting ? "Guardando…" : "Guardar bloqueo"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

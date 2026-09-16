// RoomBlockGridDialog — room block matrix (room type × night) of a group.
//
// Cocoa 22 (ola 3 · lote 3-B, archetype «diálogo / drawer»): a CocoaDrawer
// (right, lg; bottom sheet on phones) whose body is a <form> with the stay
// summary (CocoaStat), the matrix inside a CocoaScrollArea (the only place a
// raw table element is allowed: `data-cocoa-grid-table`, sticky header and first
// column, own scroll) and the total. Every cell is a small CocoaInput; the
// row and column shortcuts fill the empty cells with one value. The footer
// has two buttons: Cancelar and «Guardar bloqueo» (submits the form).
// POST /groups/:id/room-blocks/bulk with the cells above zero only.
import { useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { apiRequest } from "../../services/api-client";
import { getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import { toArray } from "../../utils/toArray";
import { date, dateRange, number, plural } from "../../lib/format";
import { ACTIONS } from "../../content/actions";
import { CheckIcon } from "../../components/cocoa-icons/ActionIcons";
import {
  CocoaButton,
  CocoaCallout,
  CocoaDrawer,
  CocoaFormSection,
  CocoaInput,
  CocoaScrollArea,
  CocoaSkeleton,
  CocoaStat,
  CocoaState
} from "../../components/cocoa";

// ─── Local types ─────────────────────────────────────────────────────────

type RoomType = { id: string; code: string; name: string; baseOccupancy?: number };
type RoomBlockEntry = { roomTypeId: string; date: string; blockedCount: number };

const FORM_ID = "room-block-form";

// ─── Date helpers ────────────────────────────────────────────────────────

// Nights between arrival (inclusive) and departure (exclusive): the check-out
// night is never blocked.
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

// ─── Grid cells (one style each, identity from the system) ───────────────

const TABLE_STYLE: CSSProperties = { borderSpacing: 0 };

const HEAD_STYLE: CSSProperties = {
  padding: "var(--cocoa-space-2)",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label-secondary)",
  textAlign: "center",
  verticalAlign: "middle",
  whiteSpace: "nowrap",
  borderBottom: "1px solid var(--cocoa-separator)",
  borderRight: "1px solid var(--cocoa-separator)"
};

const ROW_HEAD_STYLE: CSSProperties = {
  padding: "var(--cocoa-space-2) var(--cocoa-space-3)",
  minWidth: 180,
  textAlign: "left",
  verticalAlign: "middle",
  whiteSpace: "nowrap",
  fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"],
  borderBottom: "1px solid var(--cocoa-separator)",
  borderRight: "1px solid var(--cocoa-separator)"
};

const CELL_STYLE: CSSProperties = {
  padding: "var(--cocoa-space-1)",
  textAlign: "center",
  verticalAlign: "middle",
  borderBottom: "1px solid var(--cocoa-separator)",
  borderRight: "1px solid var(--cocoa-separator)"
};

const TOTAL_STYLE: CSSProperties = {
  padding: "var(--cocoa-space-2)",
  textAlign: "center",
  verticalAlign: "middle",
  fontWeight: "var(--cocoa-fw-semibold)" as CSSProperties["fontWeight"],
  background: "var(--cocoa-background-sidebar)",
  borderBottom: "1px solid var(--cocoa-separator)",
  borderRight: "1px solid var(--cocoa-separator)"
};

const CODE_STYLE: CSSProperties = {
  fontSize: "var(--cocoa-fs-caption)",
  color: "var(--cocoa-label-secondary)"
};

function Head(props: { children: ReactNode; colSpan?: number; title?: string }) {
  return (
    <th scope="col" colSpan={props.colSpan} title={props.title} style={HEAD_STYLE}>
      {props.children}
    </th>
  );
}

function RowHead(props: { children: ReactNode }) {
  return (
    <th scope="row" style={ROW_HEAD_STYLE}>
      {props.children}
    </th>
  );
}

function Cell(props: { children?: ReactNode; colSpan?: number }) {
  return (
    <td colSpan={props.colSpan} style={CELL_STYLE}>
      {props.children}
    </td>
  );
}

function TotalCell(props: { children?: ReactNode }) {
  return <td style={TOTAL_STYLE}>{props.children}</td>;
}

// ─── Main component ──────────────────────────────────────────────────────

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
  const roomTypesState = useApiData<RoomType[]>(`/properties/${propertyId}/room-types`, { pollIntervalMs: 0 });
  const roomTypes = toArray<RoomType>(roomTypesState.data);

  const nights = useMemo(() => nightsBetween(props.arrivalDate, props.departureDate), [props.arrivalDate, props.departureDate]);

  // Matrix: "roomTypeId|date" → blockedCount (string, controlled inputs).
  const [matrix, setMatrix] = useState<Record<string, string>>({});
  // «Apply to row» / «apply to column» buffers.
  const [rowApplyValue, setRowApplyValue] = useState<Record<string, string>>({});
  const [colApplyValue, setColApplyValue] = useState<Record<string, string>>({});

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function cellKey(roomTypeId: string, night: string): string {
    return `${roomTypeId}|${night}`;
  }

  function getCell(roomTypeId: string, night: string): string {
    return matrix[cellKey(roomTypeId, night)] ?? "";
  }

  function setCell(roomTypeId: string, night: string, value: string) {
    // Non-negative integers only; empty allowed.
    const cleaned = value.replace(/[^0-9]/g, "");
    setMatrix((m) => ({ ...m, [cellKey(roomTypeId, night)]: cleaned }));
  }

  // Same value on every night of a room type; cells already above zero are kept.
  function applyToRow(roomTypeId: string) {
    const raw = (rowApplyValue[roomTypeId] ?? "").trim();
    const n = Number(raw);
    if (!raw || Number.isNaN(n) || n < 0) return;
    setMatrix((m) => {
      const next = { ...m };
      for (const night of nights) {
        const k = cellKey(roomTypeId, night);
        const current = next[k] ?? "";
        if (!current || current === "0") next[k] = String(n);
      }
      return next;
    });
  }

  // Same value on every room type of a night; cells already above zero are kept.
  function applyToColumn(night: string) {
    const raw = (colApplyValue[night] ?? "").trim();
    const n = Number(raw);
    if (!raw || Number.isNaN(n) || n < 0) return;
    setMatrix((m) => {
      const next = { ...m };
      for (const rt of roomTypes) {
        const k = cellKey(rt.id, night);
        const current = next[k] ?? "";
        if (!current || current === "0") next[k] = String(n);
      }
      return next;
    });
  }

  // Totals are derived, never state.
  const rowTotals = useMemo(() => {
    const out: Record<string, number> = {};
    for (const rt of roomTypes) {
      let sum = 0;
      for (const night of nights) {
        const v = Number(matrix[cellKey(rt.id, night)] ?? 0);
        if (!Number.isNaN(v)) sum += v;
      }
      out[rt.id] = sum;
    }
    return out;
  }, [matrix, roomTypes, nights]);

  const colTotals = useMemo(() => {
    const out: Record<string, number> = {};
    for (const night of nights) {
      let sum = 0;
      for (const rt of roomTypes) {
        const v = Number(matrix[cellKey(rt.id, night)] ?? 0);
        if (!Number.isNaN(v)) sum += v;
      }
      out[night] = sum;
    }
    return out;
  }, [matrix, roomTypes, nights]);

  const grandTotal = useMemo(() => Object.values(rowTotals).reduce((a, b) => a + b, 0), [rowTotals]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!roomTypes.length) return setError("No hay tipos de habitación disponibles.");
    if (!nights.length) return setError("El rango de fechas no contiene noches válidas.");

    // Only the cells above zero travel.
    const blocks: RoomBlockEntry[] = [];
    for (const rt of roomTypes) {
      for (const night of nights) {
        const raw = matrix[cellKey(rt.id, night)];
        if (!raw) continue;
        const n = Number(raw);
        if (Number.isNaN(n) || n <= 0) continue;
        blocks.push({ roomTypeId: rt.id, date: night, blockedCount: n });
      }
    }

    if (!blocks.length) return setError("No hay cantidades a bloquear. Introduce al menos una celda mayor que 0.");

    setSubmitting(true);
    try {
      await apiRequest<{ ok: boolean; count?: number }>(`/groups/${props.groupBookingId}/room-blocks/bulk`, { method: "POST", body: { blocks } });
      props.onSaved(blocks.length);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      props.onError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  // ─── Loading / empty / error ───────────────────────────────────────────

  let body: ReactNode;
  if (roomTypesState.loading && !roomTypesState.data) {
    body = <CocoaSkeleton variant="chart" height={200} />;
  } else if (roomTypesState.error) {
    body = <CocoaState kind="error" inline title={roomTypesState.error} onRetry={() => roomTypesState.refresh()} />;
  } else if (!roomTypes.length) {
    body = (
      <CocoaState
        kind="empty"
        title="No hay tipos de habitación"
        message="Para bloquear inventario por grupo necesitas dar de alta tipos de habitación en la configuración de la propiedad."
      />
    );
  } else if (!nights.length) {
    body = (
      <CocoaState
        kind="empty"
        title="Rango de fechas no válido"
        message="La fecha de salida debe ser posterior a la de llegada para poder bloquear noches."
      />
    );
  } else {
    body = (
      <CocoaScrollArea axis="both" stickyFirstColumn maxHeight="min(55vh, 520px)" aria-label="Matriz de bloqueo por tipo de habitación y noche">
        <table data-cocoa-grid-table className="cocoa-tabular" style={TABLE_STYLE}>
          <thead>
            <tr>
              <Head>Tipo de habitación</Head>
              {nights.map((night) => (
                <Head key={night} title={date(night, "long")}>
                  <span className="cocoa-stack" data-gap="1">
                    <span>{date(night, "dayMonth")}</span>
                    <span>{date(night, "weekdayOnly")}</span>
                  </span>
                </Head>
              ))}
              <Head>Total</Head>
              <Head>Aplicar a la fila</Head>
            </tr>
          </thead>
          <tbody>
            {roomTypes.map((rt) => (
              <tr key={rt.id}>
                <RowHead>
                  <span className="cocoa-stack" data-gap="1">
                    <span className="cocoa-mono" style={CODE_STYLE}>
                      {rt.code}
                    </span>
                    <span>{rt.name}</span>
                  </span>
                </RowHead>
                {nights.map((night) => (
                  <Cell key={night}>
                    <CocoaInput
                      value={getCell(rt.id, night)}
                      onChange={(value) => setCell(rt.id, night, value)}
                      size="small"
                      inputMode="numeric"
                      placeholder="0"
                      aria-label={`Bloqueo ${rt.code} ${date(night, "dayMonth")}`}
                      style={{ width: 56 }}
                    />
                  </Cell>
                ))}
                <TotalCell>{number(rowTotals[rt.id] ?? 0)}</TotalCell>
                <Cell>
                  <div className="cocoa-row" data-gap="1" data-wrap="nowrap">
                    <CocoaInput
                      value={rowApplyValue[rt.id] ?? ""}
                      onChange={(value) => setRowApplyValue((v) => ({ ...v, [rt.id]: value.replace(/[^0-9]/g, "") }))}
                      size="small"
                      inputMode="numeric"
                      placeholder="N"
                      aria-label={`Valor a aplicar a toda la fila ${rt.code}`}
                      style={{ width: 56 }}
                    />
                    <CocoaButton
                      variant="plain"
                      tone="neutral"
                      size="small"
                      icon={<CheckIcon size={14} />}
                      aria-label={`Aplicar el valor a la fila ${rt.code}`}
                      title="Rellena las celdas vacías de la fila con este valor"
                      onClick={() => applyToRow(rt.id)}
                    />
                  </div>
                </Cell>
              </tr>
            ))}
            {/* Column totals and the «apply to column» shortcut. */}
            <tr>
              <RowHead>
                <strong>Total por noche</strong>
              </RowHead>
              {nights.map((night) => (
                <TotalCell key={night}>{number(colTotals[night] ?? 0)}</TotalCell>
              ))}
              <TotalCell>
                <strong>{number(grandTotal)}</strong>
              </TotalCell>
              <Cell />
            </tr>
            <tr>
              <RowHead>
                <span style={CODE_STYLE}>Aplicar a la columna</span>
              </RowHead>
              {nights.map((night) => (
                <Cell key={night}>
                  <div className="cocoa-row" data-gap="1" data-wrap="nowrap">
                    <CocoaInput
                      value={colApplyValue[night] ?? ""}
                      onChange={(value) => setColApplyValue((v) => ({ ...v, [night]: value.replace(/[^0-9]/g, "") }))}
                      size="small"
                      inputMode="numeric"
                      placeholder="N"
                      aria-label={`Valor a aplicar a la columna ${date(night, "dayMonth")}`}
                      style={{ width: 56 }}
                    />
                    <CocoaButton
                      variant="plain"
                      tone="neutral"
                      size="small"
                      icon={<CheckIcon size={14} />}
                      aria-label={`Aplicar el valor a la columna ${date(night, "dayMonth")}`}
                      title={`Rellena las celdas vacías del ${date(night, "dayMonth")} con este valor`}
                      onClick={() => applyToColumn(night)}
                    />
                  </div>
                </Cell>
              ))}
              <Cell colSpan={2} />
            </tr>
          </tbody>
        </table>
      </CocoaScrollArea>
    );
  }

  const canSave = !submitting && roomTypes.length > 0 && nights.length > 0;

  return (
    <CocoaDrawer
      open
      onClose={props.onClose}
      title="Bloqueo de habitaciones"
      subtitle={`${props.groupName} · ${dateRange(props.arrivalDate, props.departureDate)} · ${plural(nights.length, "noche", "noches")}`}
      side="right"
      size="lg"
      focusKey={roomTypes.length}
      footer={
        <>
          <CocoaButton variant="bordered" tone="neutral" onClick={props.onClose} disabled={submitting}>
            {ACTIONS.cancel}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" type="submit" form={FORM_ID} loading={submitting} disabled={!canSave}>
            Guardar bloqueo
          </CocoaButton>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={submit} className="cocoa-stack" data-gap="4" noValidate>
        <div className="cocoa-row" data-gap="4" data-align="start">
          <CocoaStat label="Grupo" value={props.groupName} tabular={false} />
          <CocoaStat label="Llegada" value={date(props.arrivalDate)} />
          <CocoaStat label="Salida" value={date(props.departureDate)} />
          <CocoaStat label="Noches" value={number(nights.length)} />
        </div>

        <CocoaFormSection
          title="Matriz de bloqueo (habitaciones por noche)"
          description="Introduce la cantidad de habitaciones a bloquear por tipo y noche. Solo se envían las celdas con cantidad mayor que 0. Usa los atajos por fila o columna para rellenar más rápido."
        >
          {body}
          <CocoaStat label="Total bloqueado" value={number(grandTotal)} suffix=" habitaciones-noche" tone="accent" />
        </CocoaFormSection>

        {error ? (
          <CocoaCallout tone="danger" title={error} role="alert">
            {null}
          </CocoaCallout>
        ) : null}
      </form>
    </CocoaDrawer>
  );
}

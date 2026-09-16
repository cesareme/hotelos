// POS board — Operaciones › Punto de venta › Comandas (/operaciones/tpv).
//
// Cocoa 22 (docs/design/COCOA-22.md §4, «workspace» archetype): CocoaPage →
// KPI strip (open tickets, open total, closed today) → «Arqueo de caja»
// (day window + outlet filter + «Hoy»/«Actualizar» in ONE CocoaFormRow — the
// section head keeps only the title and a short meta so it never overflows a
// 390 px viewport; QA #1 — settlement KPIs, per-outlet CocoaTable with a
// totals row) → «Abrir comanda» form row → open tickets as
// a CocoaGrid of CocoaSection cards (lines list, add-line row with a
// CocoaStepper for the quantity, settlement buttons) → closed tickets in a
// CocoaTable whose row opens the ticket in a CocoaDrawer (bottom sheet on
// phones). Endpoints, polling (20 s) and actions are the legacy ones.
//
// Tanda 6 · lote 6-E (contract packages/shared/src/pos-types.ts): the board
// asks GET …/pos/tickets?status=open|closed|all through a segmented view
// (KPIs only paint what the view fetched); closed tickets show their
// simplified invoice (FS series), tax included, business day, journal entry
// and cash closure; a cash/card sale refused with 409 CASH_CLOSURE_CLOSED is
// explained by posErrorMessage and offers the jump to Cierre de caja.
//
// Hosted inside PuntoVentaTabs the container paints the title and the
// subtitle; standalone the page paints eyebrow · h1 · subtitle.

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import { useApiData } from "../../hooks/useApiData";
import {
  addPosLine,
  closePosTicket,
  fetchPosCashSummary,
  fetchPosOutlets,
  openPosTicket,
  posErrorMessage,
  type PosCashSummary,
  type PosCashSummaryOutlet,
  type PosOutlet,
  type PosTicket,
  type PosTicketsInput
} from "../../services/posApi";
import { financeErrorCode } from "../../services/finance-contracts";
import { todayIsoLocal } from "../../services/pmsCommerceApi";
import { toArray } from "../../utils/toArray";
import { useTabHost } from "../tabs/TabHost";
import { navigateTo } from "../../lib/navigate";
import { date, money, number, plural, time } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS, TIME_LABELS } from "../../content/actions";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaStepper,
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";
import { cashSummaryWindow } from "./pos-cash-window";

const PROPERTY_ID = getActivePropertyId();

type TicketView = NonNullable<PosTicketsInput["status"]>;
const VIEW_OPTIONS: Array<{ value: TicketView; label: string }> = [
  { value: "all", label: "Todas" },
  { value: "open", label: "Abiertas" },
  { value: "closed", label: "Cerradas" }
];
function isTicketView(value: string): value is TicketView {
  return value === "all" || value === "open" || value === "closed";
}

/** Closed tickets painted in the board (the rest stay reachable through the cash summary). */
const CLOSED_LIMIT = 15;

function fmtTime(iso?: string): string {
  return time(iso, { empty: "" });
}
/** True when the ISO timestamp falls on the given local calendar day. */
function isOnLocalDay(iso: string | undefined, dayIso: string): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return local === dayIso;
}
/** «hoy 13:05» for today's closings, «12/09/2026 13:05» otherwise. */
function closedAtLabel(iso: string | undefined, todayIso: string): string {
  if (!iso) return "—";
  return `${isOnLocalDay(iso, todayIso) ? "hoy" : date(iso)} ${fmtTime(iso)}`;
}
const SETTLE_LABEL: Record<string, string> = { room: "a la habitación", cash: "efectivo", card: "tarjeta" };

type Draft = { name: string; qty: string; price: string };
type Message = { text: string; tone: CocoaTone; action?: { label: string; onClick: () => void } };

// Secondary text in tables and lists (never inside a `style={{…}}` literal, rule 6).
const mutedStyle: CSSProperties = { color: "var(--cocoa-label-secondary)" };
// Add-line row: the description grows, quantity and price keep a compact basis.
const lineNameField: CSSProperties = { flex: "2 1 160px", minWidth: 0 };
const lineQtyField: CSSProperties = { flex: "0 1 120px", minWidth: 0 };
const linePriceField: CSSProperties = { flex: "0 1 120px", minWidth: 0 };
// Grid cells of a form row align to `start`: the cell itself must sit at the
// end of the track so the buttons share the inputs' baseline (measured: 18 px
// above them otherwise).
const bottomAligned: CSSProperties = { display: "flex", alignItems: "flex-end", alignSelf: "end", minWidth: 0 };

const CASH_COLUMNS: CocoaTableColumn<PosCashSummaryOutlet>[] = [
  { key: "outletName", label: "Punto de venta" },
  { key: "tickets", label: "Comandas", align: "right", render: (o) => number(o.tickets) },
  { key: "cash", label: "Efectivo", align: "right", hideOnNarrow: true, render: (o) => money(o.bySettlement.cash) },
  { key: "card", label: "Tarjeta", align: "right", hideOnNarrow: true, render: (o) => money(o.bySettlement.card) },
  { key: "room", label: "A habitación", align: "right", hideOnNarrow: true, render: (o) => money(o.bySettlement.room) },
  { key: "total", label: FIELD_LABELS.total, align: "right", render: (o) => <strong>{money(o.total)}</strong> }
];

function closedColumns(todayIso: string): CocoaTableColumn<PosTicket>[] {
  return [
    { key: "outletName", label: "Punto de venta" },
    { key: "roomNumber", label: FIELD_LABELS.room, render: (t) => (t.roomNumber ? `Hab. ${t.roomNumber}` : "—") },
    { key: "total", label: FIELD_LABELS.total, align: "right", render: (t) => money(t.total) },
    {
      key: "settlement",
      label: "Cobro",
      render: (t) => (t.settlement ? <CocoaBadge tone="success">{SETTLE_LABEL[t.settlement] ?? t.settlement}</CocoaBadge> : <span style={mutedStyle}>sin registrar</span>)
    },
    // Simplified invoice (series FS) of a cash/card sale; a room charge has none (the folio invoices it).
    { key: "invoiceNumber", label: "Factura", hideOnNarrow: true, render: (t) => (t.invoiceNumber ? <span className="cocoa-tabular">{t.invoiceNumber}</span> : t.settlement === "room" ? "en el folio" : "—") },
    { key: "closedAt", label: "Cierre", hideOnNarrow: true, render: (t) => closedAtLabel(t.closedAt, todayIso) }
  ];
}

/** Ticket lines with the total (and the tax it includes, when known) as the last rows (board cards and the drawer). */
function TicketLines({ ticket, label }: { ticket: PosTicket; label: string }) {
  if (ticket.lines.length === 0) return <CocoaState kind="empty" inline title="Sin consumos todavía." />;
  return (
    <ul className="c22-section__list" aria-label={label}>
      {ticket.lines.map((l, i) => (
        <li key={i}>
          <span>
            {number(l.quantity)} × {l.name}
          </span>
          <strong>{money(l.total)}</strong>
        </li>
      ))}
      <li>
        <span>{FIELD_LABELS.total}</span>
        <strong>{money(ticket.total)}</strong>
      </li>
      {ticket.taxTotal > 0 ? (
        <li>
          <span>IVA incluido</span>
          <strong>{money(ticket.taxTotal)}</strong>
        </li>
      ) : null}
    </ul>
  );
}

// Mirror skeleton of the open-ticket board (two cards per row on desktop).
function BoardSkeleton() {
  return <CocoaSkeleton.Grid rows={[[6, 6]]} height={220} label="Cargando comandas…" />;
}

export function PosDashboard() {
  const hosted = useTabHost() !== null;
  const propertyName = getActiveProperty().propertyName;
  // View of the board = `?status=` of the API (open · closed · all); the
  // closed half is bounded by the API to the current business day.
  const [view, setView] = useState<TicketView>("all");
  const { data, loading, error, refresh } = useApiData<PosTicket[]>(
    `/properties/${PROPERTY_ID}/pos/tickets`,
    { pollIntervalMs: 20000, query: { status: view } }
  );
  const tickets = useMemo(() => toArray<PosTicket>(data), [data]);

  const [outlets, setOutlets] = useState<PosOutlet[]>([]);
  const [outletsError, setOutletsError] = useState<string | null>(null);
  useEffect(() => {
    void fetchPosOutlets(PROPERTY_ID)
      .then((list) => {
        setOutlets(list);
        setOutletsError(null);
      })
      .catch((e: unknown) => {
        // QC-06: without outlets no ticket can be opened; say why.
        setOutlets([]);
        setOutletsError(e instanceof Error ? e.message : "No se pudieron cargar los puntos de venta.");
      });
  }, []);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Message | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = tickets.find((t) => t.id === selectedId) ?? null;
  const [outletId, setOutletId] = useState("");
  const [roomNumber, setRoomNumber] = useState("");
  // per-ticket add-line draft
  const [lineDraft, setLineDraft] = useState<Record<string, Draft>>({});

  useEffect(() => {
    if (!outletId && outlets[0]) setOutletId(outlets[0].id);
  }, [outlets, outletId]);

  // ---- cash summary (arqueo) ------------------------------------------------
  // FISC-05: settlement / closedAt are persisted on PosOrder, so the summary is
  // computed server-side (GET /pos/cash-summary) over closed tickets in the
  // selected window, never from the in-memory board.
  const today = todayIsoLocal();
  const [csFrom, setCsFrom] = useState(today);
  const [csTo, setCsTo] = useState(today);
  const [csOutletId, setCsOutletId] = useState("");
  const [cashSummary, setCashSummary] = useState<PosCashSummary | null>(null);
  const [cashLoading, setCashLoading] = useState(false);
  const [cashError, setCashError] = useState<string | null>(null);
  // Outlet ids the cash-summary endpoint understands come from its own
  // unfiltered answer (board outlet ids are synthetic); cached so the selector
  // keeps its options while a single outlet is selected.
  const [cashOutlets, setCashOutlets] = useState<Array<{ id: string; name: string }>>([]);

  const loadCashSummary = useCallback(async () => {
    if (!csFrom || !csTo) return;
    setCashLoading(true);
    setCashError(null);
    try {
      const summary = await fetchPosCashSummary({ ...cashSummaryWindow(csFrom, csTo), outletId: csOutletId || undefined }, PROPERTY_ID);
      setCashSummary(summary);
      if (!csOutletId) setCashOutlets(summary.byOutlet.map((o) => ({ id: o.outletId, name: o.outletName })));
    } catch (e: unknown) {
      setCashSummary(null);
      setCashError(e instanceof Error ? e.message : "No se pudo calcular el arqueo.");
    } finally {
      setCashLoading(false);
    }
  }, [csFrom, csTo, csOutletId]);

  useEffect(() => {
    void loadCashSummary();
  }, [loadCashSummary]);

  const cashOutletOptions = cashOutlets.length > 0 ? cashOutlets : outlets.map((o) => ({ id: o.id, name: o.name }));

  const open = tickets.filter((t) => t.status === "open");
  const closed = tickets.filter((t) => t.status === "closed");
  const closedToday = closed.filter((t) => isOnLocalDay(t.closedAt, today));
  const openTotal = open.reduce((s, t) => s + t.total, 0);
  const closedColumnsToday = useMemo(() => closedColumns(today), [today]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ text: ok, tone: "success" });
      refresh();
      void loadCashSummary();
    } catch (e) {
      // details.code → Spanish (CASH_CLOSURE_CLOSED, POS_TICKET_CLOSED,
      // POS_ROOM_NOT_OCCUPIED, SIMPLIFIED_INVOICE_LIMIT…); a closed cash offers
      // the jump to the closure so the cashier sees who closed it and when.
      const closedCash = financeErrorCode(e) === "CASH_CLOSURE_CLOSED";
      setMsg({
        text: posErrorMessage(e, "No se pudo completar la acción."),
        tone: closedCash ? "warning" : "danger",
        action: closedCash ? { label: "Ir al cierre de caja", onClick: () => navigateTo("CashClosureScreen") } : undefined
      });
    } finally {
      setBusy(false);
    }
  }

  function draftOf(id: string): Draft {
    return lineDraft[id] ?? { name: "", qty: "1", price: "" };
  }
  function setDraft(id: string, patch: Partial<Draft>) {
    setLineDraft((prev) => ({ ...prev, [id]: { ...draftOf(id), ...patch } }));
  }

  const cashTotals = cashSummary?.totals;

  return (
    <CocoaPage
      eyebrow={`Operaciones · ${propertyName}`}
      title="Punto de venta (TPV)"
      subtitle={hosted ? undefined : "Abre comandas en restaurante, bar o room service, añade consumos y cierra cobrando a la habitación, en efectivo o con tarjeta."}
      actions={
        <>
          {busy ? <CocoaBadge tone="info">{STATUS_LABELS.inProgress}</CocoaBadge> : null}
          {error && tickets.length > 0 ? <CocoaBadge tone="danger">{STATUS_LABELS.loadError}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refresh} loading={loading && tickets.length > 0} title={ACTIONS.refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      commands={[
        { id: "pos-refresh", label: "Actualizar comandas", run: refresh },
        { id: "pos-cash-refresh", label: "Recalcular el arqueo de caja", run: () => void loadCashSummary() },
        { id: "pos-cash-closure", label: "Ir al cierre de caja", run: () => navigateTo("CashClosureScreen") }
      ]}
    >
      {msg ? (
        <CocoaCallout
          tone={msg.tone}
          role="status"
          actions={
            msg.action ? (
              <CocoaButton variant="tinted" tone="accent" size="small" onClick={msg.action.onClick}>
                {msg.action.label}
              </CocoaButton>
            ) : undefined
          }
        >
          {msg.text}
        </CocoaCallout>
      ) : null}

      <div className="cocoa-row" data-gap="2" data-justify="between">
        <CocoaSegmentedControl value={view} onChange={(v) => setView(isTicketView(v) ? v : "all")} options={VIEW_OPTIONS} size="small" aria-label="Comandas que se muestran" />
        <CocoaButton variant="plain" tone="accent" size="small" onClick={() => navigateTo("CashClosureScreen")}>
          Ir al cierre de caja
        </CocoaButton>
      </div>

      {/* Only the half the view fetched is counted: with `?status=closed` the open board is not in the payload. */}
      <CocoaKpiStrip stagger aria-label="Comandas de hoy">
        {view !== "closed" ? <CocoaKpi label="Comandas abiertas" value={open.length} deltaLabel={open.length > 0 ? "en curso" : "ninguna"} polarity="neutral" status={open.length > 0 ? "warning" : "ok"} /> : null}
        {view !== "closed" ? <CocoaKpi label="Total abierto" value={money(openTotal)} deltaLabel="por cobrar" polarity="neutral" status="ok" /> : null}
        {/* Counted by real closedAt (persisted), not "every closed ticket in memory". */}
        {view !== "open" ? <CocoaKpi label="Comandas cerradas" value={closedToday.length} deltaLabel="hoy" polarity="neutral" status="ok" /> : null}
        {view !== "open" ? <CocoaKpi label="IVA de las ventas al contado" value={money(closedToday.reduce((s, t) => s + (t.settlement === "room" ? 0 : t.taxTotal), 0))} deltaLabel="incluido en las facturas simplificadas de hoy" polarity="neutral" status="ok" /> : null}
      </CocoaKpiStrip>

      {/* Arqueo */}
      <CocoaSection title="Arqueo de caja" meta="Comandas cerradas en el rango seleccionado">
        {/* Window + outlet + the two actions in one row: on phones the row is a
            single column, so «Hoy» / «Actualizar» stay inside the viewport. */}
        <CocoaFormRow columns={4} min={160}>
          <CocoaField label={FIELD_LABELS.from}>
            <CocoaDatePicker value={csFrom} max={csTo || undefined} onChange={setCsFrom} />
          </CocoaField>
          <CocoaField label={FIELD_LABELS.to}>
            <CocoaDatePicker value={csTo} min={csFrom || undefined} onChange={setCsTo} />
          </CocoaField>
          <CocoaField label="Punto de venta">
            <CocoaSelect value={csOutletId} onChange={setCsOutletId} options={[{ value: "", label: STATUS_LABELS.all }, ...cashOutletOptions.map((o) => ({ value: o.id, label: o.name }))]} />
          </CocoaField>
          <div style={bottomAligned}>
            <span className="cocoa-cluster">
              <CocoaButton
                variant="bordered"
                tone="neutral"
                onClick={() => {
                  setCsFrom(today);
                  setCsTo(today);
                }}
              >
                {TIME_LABELS.today}
              </CocoaButton>
              <CocoaButton variant="tinted" tone="accent" loading={cashLoading} onClick={() => void loadCashSummary()}>
                {ACTIONS.refresh}
              </CocoaButton>
            </span>
          </div>
        </CocoaFormRow>
        {cashLoading && !cashSummary ? (
          <CocoaSkeleton.Strip count={4} min={200} label="Calculando arqueo…" />
        ) : cashError ? (
          <CocoaState kind="error" title="No se pudo calcular el arqueo" message={cashError} onRetry={() => void loadCashSummary()} />
        ) : cashSummary && cashTotals ? (
          <>
            <CocoaKpiStrip min={200} aria-label="Totales del arqueo">
              <CocoaKpi label="Efectivo" value={money(cashTotals.bySettlement.cash)} status="ok" />
              <CocoaKpi label="Tarjeta" value={money(cashTotals.bySettlement.card)} status="ok" />
              <CocoaKpi label="A habitación" value={money(cashTotals.bySettlement.room)} status="ok" />
              <CocoaKpi label={FIELD_LABELS.total} value={money(cashTotals.total)} deltaLabel={plural(cashTotals.tickets, "comanda", "comandas")} polarity="neutral" status="ok" />
            </CocoaKpiStrip>
            {cashSummary.byOutlet.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin comandas cerradas en el rango seleccionado." />
            ) : (
              <CocoaTable
                columns={CASH_COLUMNS}
                rows={cashSummary.byOutlet}
                rowKey="outletId"
                density="compact"
                caption="Arqueo por punto de venta"
                aria-label="Arqueo por punto de venta"
                footer={{
                  outletName: FIELD_LABELS.total,
                  tickets: number(cashTotals.tickets),
                  cash: money(cashTotals.bySettlement.cash),
                  card: money(cashTotals.bySettlement.card),
                  room: money(cashTotals.bySettlement.room),
                  total: <strong>{money(cashTotals.total)}</strong>
                }}
              />
            )}
          </>
        ) : null}
      </CocoaSection>

      {/* Nueva comanda */}
      <CocoaSection title="Abrir comanda">
        {outletsError ? (
          <CocoaCallout tone="danger" role="alert">
            {outletsError}
          </CocoaCallout>
        ) : null}
        <CocoaFormRow columns={3} min={200}>
          <CocoaField label="Punto de venta">
            <CocoaSelect value={outletId} onChange={setOutletId} options={outlets.map((o) => ({ value: o.id, label: o.name }))} disabled={busy || outlets.length === 0} />
          </CocoaField>
          <CocoaField label={FIELD_LABELS.room} hint={STATUS_LABELS.optional.toLowerCase()}>
            <CocoaInput value={roomNumber} onChange={setRoomNumber} placeholder="Ej. 204" disabled={busy} inputMode="numeric" />
          </CocoaField>
          <div style={bottomAligned}>
            <CocoaButton
              variant="filled"
              tone="accent"
              disabled={busy || !outletId}
              onClick={() =>
                run(async () => {
                  await openPosTicket({ outletId, roomNumber: roomNumber || undefined });
                  setRoomNumber("");
                }, "Comanda abierta.")
              }
            >
              Abrir comanda
            </CocoaButton>
          </div>
        </CocoaFormRow>
      </CocoaSection>

      {loading && tickets.length === 0 ? (
        <BoardSkeleton />
      ) : error && tickets.length === 0 ? (
        <CocoaSection aria-label="Comandas">
          <CocoaState kind="error" title="No se pudo cargar" message={error} onRetry={refresh} />
        </CocoaSection>
      ) : (
        <>
          {view === "closed" ? null : open.length === 0 ? (
            <CocoaSection aria-label="Comandas abiertas">
              <CocoaState kind="empty" illustration="box" title="Sin comandas abiertas" message="Abre una comanda arriba para empezar a registrar consumos." />
            </CocoaSection>
          ) : (
            <CocoaGrid align="start" aria-label="Comandas abiertas">
              {open.map((t) => {
                const d = draftOf(t.id);
                return (
                  <CocoaSpan key={t.id} cols={6} min={320}>
                    <CocoaSection title={t.outletName} meta={`${t.roomNumber ? `Hab. ${t.roomNumber} · ` : ""}${fmtTime(t.createdAt)}`}>
                      <TicketLines ticket={t} label={`Consumos de ${t.outletName}`} />

                      <div className="cocoa-row" data-gap="2" data-align="end">
                        <CocoaField label="Consumo" style={lineNameField}>
                          <CocoaInput value={d.name} onChange={(v) => setDraft(t.id, { name: v })} placeholder="Ej. Café con leche" disabled={busy} />
                        </CocoaField>
                        <CocoaField label={FIELD_LABELS.quantity} style={lineQtyField}>
                          <CocoaStepper value={Number(d.qty) || 1} onChange={(v) => setDraft(t.id, { qty: String(v) })} min={1} disabled={busy} />
                        </CocoaField>
                        <CocoaField label={FIELD_LABELS.price} style={linePriceField}>
                          <CocoaInput value={d.price} onChange={(v) => setDraft(t.id, { price: v })} type="number" min={0} step={0.5} inputMode="decimal" placeholder="€" disabled={busy} />
                        </CocoaField>
                        <CocoaButton
                          variant="tinted"
                          tone="accent"
                          disabled={busy || !d.name.trim() || !Number(d.price)}
                          onClick={() =>
                            run(async () => {
                              await addPosLine(t.id, { name: d.name.trim(), quantity: Number(d.qty) || 1, unitPrice: Number(d.price) });
                              setDraft(t.id, { name: "", qty: "1", price: "" });
                            }, "Consumo añadido.")
                          }
                        >
                          {ACTIONS.add}
                        </CocoaButton>
                      </div>

                      <div className="cocoa-row" data-gap="2">
                        <CocoaButton
                          variant="filled"
                          tone="accent"
                          disabled={busy || t.lines.length === 0}
                          title={t.roomNumber ? undefined : "Indica una habitación al abrir la comanda"}
                          onClick={() => run(() => closePosTicket(t.id, "room"), "Cargado a la habitación.")}
                        >
                          Cargar a habitación
                        </CocoaButton>
                        <CocoaButton variant="bordered" tone="neutral" disabled={busy || t.lines.length === 0} onClick={() => run(() => closePosTicket(t.id, "cash"), "Cobrado en efectivo.")}>
                          Efectivo
                        </CocoaButton>
                        <CocoaButton variant="bordered" tone="neutral" disabled={busy || t.lines.length === 0} onClick={() => run(() => closePosTicket(t.id, "card"), "Cobrado con tarjeta.")}>
                          Tarjeta
                        </CocoaButton>
                      </div>
                    </CocoaSection>
                  </CocoaSpan>
                );
              })}
            </CocoaGrid>
          )}

          {view === "closed" && closed.length === 0 ? (
            <CocoaSection aria-label="Comandas cerradas">
              <CocoaState kind="empty" inline title="Sin comandas cerradas en el día de negocio actual." />
            </CocoaSection>
          ) : null}
          {closed.length > 0 ? (
            <CocoaSection
              title="Comandas cerradas"
              meta={closed.length > CLOSED_LIMIT ? `Últimas ${CLOSED_LIMIT} de ${closed.length}` : plural(closed.length, "comanda", "comandas")}
              padding="none"
              style={{ overflow: "clip" }}
              aria-label="Comandas cerradas"
            >
              <CocoaTable
                columns={closedColumnsToday}
                rows={closed.slice(0, CLOSED_LIMIT)}
                rowKey="id"
                selectedKey={selectedId ?? undefined}
                onSelect={(t) => setSelectedId(t.id)}
                caption="Comandas cerradas"
                aria-label="Comandas cerradas"
              />
            </CocoaSection>
          ) : null}
        </>
      )}

      <CocoaDrawer
        open={selected !== null}
        onClose={() => setSelectedId(null)}
        title={selected ? `Comanda · ${selected.outletName}` : "Comanda"}
        subtitle={selected ? (selected.roomNumber ? `Hab. ${selected.roomNumber}` : "Sin habitación") : undefined}
        side="right"
        size="md"
      >
        {selected ? (
          <div className="cocoa-stack" data-gap="4">
            <ul className="c22-section__list" aria-label="Datos de la comanda">
              <li>
                <span>{FIELD_LABELS.status}</span>
                {selected.status === "open" ? <CocoaBadge tone="warning">Abierta</CocoaBadge> : <CocoaBadge tone="success">Cerrada</CocoaBadge>}
              </li>
              <li>
                <span>Punto de venta</span>
                <strong>{selected.outletName}</strong>
              </li>
              <li>
                <span>{FIELD_LABELS.room}</span>
                <strong>{selected.roomNumber ? `Hab. ${selected.roomNumber}` : "—"}</strong>
              </li>
              <li>
                <span>Abierta</span>
                <strong>{fmtTime(selected.createdAt)}</strong>
              </li>
              {selected.closedAt ? (
                <li>
                  <span>Cerrada</span>
                  <strong>
                    {date(selected.closedAt)} {fmtTime(selected.closedAt)}
                  </strong>
                </li>
              ) : null}
              {selected.businessDate ? (
                <li>
                  <span>Día de negocio</span>
                  <strong>{date(selected.businessDate, "short")}</strong>
                </li>
              ) : null}
              {selected.settlement ? (
                <li>
                  <span>Cobro</span>
                  <strong>{SETTLE_LABEL[selected.settlement] ?? selected.settlement}</strong>
                </li>
              ) : null}
              {selected.status === "closed" && selected.settlement !== "room" ? (
                <li>
                  <span>Factura simplificada</span>
                  <strong>{selected.invoiceNumber ?? "sin emitir"}</strong>
                </li>
              ) : null}
              {selected.status === "closed" && selected.settlement !== "room" ? (
                <li>
                  <span>Asiento contable</span>
                  {selected.journalEntryId ? (
                    <CocoaButton variant="plain" tone="accent" size="small" onClick={() => navigateTo("JournalScreen", selected.journalEntryId ?? undefined)}>
                      Ver en el diario
                    </CocoaButton>
                  ) : (
                    <strong>sin asiento</strong>
                  )}
                </li>
              ) : null}
              {selected.status === "closed" && selected.settlement !== "room" ? (
                <li>
                  <span>Cierre de caja</span>
                  {selected.cashClosureId ? (
                    <CocoaButton variant="plain" tone="accent" size="small" onClick={() => navigateTo("CashClosureScreen")}>
                      Contada en el cierre del día
                    </CocoaButton>
                  ) : (
                    <strong>caja aún abierta</strong>
                  )}
                </li>
              ) : null}
            </ul>
            <CocoaSection title="Consumos" meta={plural(selected.lines.length, "línea", "líneas")}>
              <TicketLines ticket={selected} label="Consumos de la comanda" />
            </CocoaSection>
          </div>
        ) : null}
      </CocoaDrawer>
    </CocoaPage>
  );
}

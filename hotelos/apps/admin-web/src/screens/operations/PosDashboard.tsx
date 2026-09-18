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
// simplified invoice with its REAL series (the prefix of the number the API
// returns — SIM today; the UI never hard-codes one, decision L3 §6.15), tax
// included, business day, journal entry and cash closure; a cash/card sale
// refused with 409 CASH_CLOSURE_CLOSED is explained by posErrorMessage and
// offers the jump to Cierre de caja.
//
// Tanda L3 · lote P1 «POS front honesto»: the hotel is the ONE «Ámbito» of
// services/financeScope.ts read INSIDE the component (policy centre_default,
// never the oficina central, like the sibling «Cierre de caja» tab of the same
// NavItemTabs group), so a change of hotel reloads outlets, tickets and arqueo
// without a page reload; the arqueo paints the side counters of
// GET /pos/cash-summary as notices (open tickets are not revenue; rows without
// settlement or without closedAt; counters that failed → «—», never a green
// zero; a property without time zone) through the pure helpers of
// ./posSummaryView.ts.
//
// Hosted inside PuntoVentaTabs the container paints the title and the
// subtitle; standalone the page paints eyebrow · h1 · subtitle.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useFinanceScope } from "../../services/financeScope";
import { FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
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
import { cashSummaryOutletOptions, countLabel, degradedCounters, invoiceSeries, invoiceSeriesLabel, outletRowLabel, posCashWarnings, timeZoneLabel, UTC_FALLBACK_LABEL } from "./posSummaryView";

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

/** «importe (nº)» of the rows closed without a settlement: in the total, in no method. */
function unsettledLabel(unsettled: PosCashSummaryOutlet["unsettled"]): string {
  return unsettled.tickets > 0 ? `${money(unsettled.total)} (${number(unsettled.tickets)})` : "—";
}

/** Per-outlet arqueo columns; the «Sin forma de cobro» column only exists while some row needs it. */
function cashColumns(showUnsettled: boolean): CocoaTableColumn<PosCashSummaryOutlet>[] {
  const columns: CocoaTableColumn<PosCashSummaryOutlet>[] = [
    // An orphan Outlet FK has no name: named as such, never a blank cell.
    { key: "outletName", label: "Punto de venta", render: (o) => outletRowLabel(o) },
    { key: "tickets", label: "Comandas", align: "right", render: (o) => number(o.tickets) },
    { key: "cash", label: "Efectivo", align: "right", hideOnNarrow: true, render: (o) => money(o.bySettlement.cash) },
    { key: "card", label: "Tarjeta", align: "right", hideOnNarrow: true, render: (o) => money(o.bySettlement.card) },
    { key: "room", label: "A habitación", align: "right", hideOnNarrow: true, render: (o) => money(o.bySettlement.room) }
  ];
  if (showUnsettled) columns.push({ key: "unsettled", label: "Sin forma de cobro", align: "right", hideOnNarrow: true, render: (o) => unsettledLabel(o.unsettled) });
  columns.push({ key: "total", label: FIELD_LABELS.total, align: "right", render: (o) => <strong>{money(o.total)}</strong> });
  return columns;
}

/** Number of a simplified invoice with its real series as a chip: the series is whatever the API allocated, never a constant of the UI. */
function InvoiceNumberCell({ value }: { value: string }) {
  const series = invoiceSeries(value);
  return (
    <span className="cocoa-cluster">
      <span className="cocoa-tabular">{value}</span>
      {series ? (
        <CocoaBadge size="small" tone="neutral" title="Serie de la factura simplificada">
          {series}
        </CocoaBadge>
      ) : null}
    </span>
  );
}

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
    // Simplified invoice of a cash/card sale, with the series of the number the API returns; a room charge has none (the folio invoices it).
    { key: "invoiceNumber", label: "Factura", hideOnNarrow: true, render: (t) => (t.invoiceNumber ? <InvoiceNumberCell value={t.invoiceNumber} /> : t.settlement === "room" ? "en el folio" : "—") },
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

/** A per-hotel selection: a change of scope drops it instead of carrying an id of another property into the API. */
type ScopedChoice = { propertyId: string; id: string };

export function PosDashboard() {
  const hosted = useTabHost() !== null;
  // Tanda L3 · P1: the board is per hotel, like the sibling «Cierre de caja»
  // tab — ONE «Ámbito» read inside the component so a change of hotel reloads
  // outlets, tickets and arqueo without a page reload. `PosDashboard` has no
  // key in FINANCE_SCOPE_POLICIES (owner: services/financeScope.ts), hence the
  // literal policy of CashClosureScreen (`centre_default`, no oficina central).
  const finance = useFinanceScope("centre_default", { excludeOffice: true });
  const propertyId = finance.propertyId ?? finance.active.propertyId;
  // View of the board = `?status=` of the API (open · closed · all); the
  // closed half is bounded by the API to the current business day. Until the
  // structure is known the scope could be the active oficina (fix:L7 qa#11):
  // no reader asks before that.
  const [view, setView] = useState<TicketView>("all");
  const { data, loading, error, refresh } = useApiData<PosTicket[]>(
    finance.loading ? null : `/properties/${propertyId}/pos/tickets`,
    { pollIntervalMs: 20000, query: { status: view } }
  );
  const tickets = useMemo(() => toArray<PosTicket>(data), [data]);

  // Outlets of the hotel in scope (an answer of another hotel is never shown).
  const [outletsOf, setOutletsOf] = useState<{ propertyId: string; list: PosOutlet[] }>({ propertyId: "", list: [] });
  const outlets = outletsOf.propertyId === propertyId ? outletsOf.list : [];
  const [outletsError, setOutletsError] = useState<string | null>(null);
  useEffect(() => {
    if (finance.loading) return;
    let alive = true;
    void fetchPosOutlets(propertyId)
      .then((list) => {
        if (!alive) return;
        setOutletsOf({ propertyId, list });
        setOutletsError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        // QC-06: without outlets no ticket can be opened; say why.
        setOutletsOf({ propertyId, list: [] });
        setOutletsError(e instanceof Error ? e.message : "No se pudieron cargar los puntos de venta.");
      });
    return () => {
      alive = false;
    };
  }, [propertyId, finance.loading]);

  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Message | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = tickets.find((t) => t.id === selectedId) ?? null;
  const [outletChoice, setOutletChoice] = useState<ScopedChoice | null>(null);
  const outletId = outletChoice?.propertyId === propertyId ? outletChoice.id : "";
  const [roomNumber, setRoomNumber] = useState("");
  // per-ticket add-line draft
  const [lineDraft, setLineDraft] = useState<Record<string, Draft>>({});

  useEffect(() => {
    if (!outletId && outlets[0]) setOutletChoice({ propertyId, id: outlets[0].id });
  }, [outlets, outletId, propertyId]);

  // ---- cash summary (arqueo) ------------------------------------------------
  // FISC-05: settlement / closedAt are persisted on PosOrder, so the summary is
  // computed server-side (GET /pos/cash-summary) over closed tickets in the
  // selected window, never from the in-memory board.
  const today = todayIsoLocal();
  const [csFrom, setCsFrom] = useState(today);
  const [csTo, setCsTo] = useState(today);
  const [csOutletChoice, setCsOutletChoice] = useState<ScopedChoice | null>(null);
  const csOutletId = csOutletChoice?.propertyId === propertyId ? csOutletChoice.id : "";
  const [cashSummary, setCashSummary] = useState<PosCashSummary | null>(null);
  const [cashLoading, setCashLoading] = useState(false);
  const [cashError, setCashError] = useState<string | null>(null);
  // Outlet ids the cash-summary endpoint understands come from its own
  // unfiltered answer (board outlet ids are synthetic; orphan rows skipped);
  // cached per hotel so the selector keeps its options while one is selected.
  const [cashOutlets, setCashOutlets] = useState<{ propertyId: string; options: Array<{ value: string; label: string }> }>({ propertyId: "", options: [] });
  // An answer that arrives after a newer request (scope or filter changed while
  // it was in flight) never overwrites the latest count.
  const cashRequest = useRef(0);

  const loadCashSummary = useCallback(async () => {
    if (finance.loading) return;
    if (!csFrom || !csTo) return;
    const seq = ++cashRequest.current;
    setCashLoading(true);
    setCashError(null);
    try {
      const summary = await fetchPosCashSummary({ ...cashSummaryWindow(csFrom, csTo), outletId: csOutletId || undefined }, propertyId);
      if (seq !== cashRequest.current) return;
      setCashSummary(summary);
      if (!csOutletId) setCashOutlets({ propertyId, options: cashSummaryOutletOptions(summary.byOutlet) });
    } catch (e: unknown) {
      if (seq !== cashRequest.current) return;
      setCashSummary(null);
      setCashError(e instanceof Error ? e.message : "No se pudo calcular el arqueo.");
    } finally {
      if (seq === cashRequest.current) setCashLoading(false);
    }
  }, [csFrom, csTo, csOutletId, propertyId, finance.loading]);

  useEffect(() => {
    void loadCashSummary();
  }, [loadCashSummary]);

  // The count of the hotel in scope only (the payload names its property).
  const scopedSummary = cashSummary && cashSummary.propertyId === propertyId ? cashSummary : null;
  const cashOutletOptions = cashOutlets.propertyId === propertyId && cashOutlets.options.length > 0 ? cashOutlets.options : outlets.map((o) => ({ value: o.id, label: o.name }));
  const cashWarnings = useMemo(() => (scopedSummary ? posCashWarnings(scopedSummary) : []), [scopedSummary]);
  const cashDegraded = scopedSummary ? degradedCounters(scopedSummary) : { openTickets: false, unplaceable: false };
  const showUnsettled = (scopedSummary?.totals.unsettled.tickets ?? 0) > 0;
  const cashColumnsNow = useMemo(() => cashColumns(showUnsettled), [showUnsettled]);
  const selectedSeries = selected ? invoiceSeriesLabel(selected.invoiceNumber) : null;

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

  const cashTotals = scopedSummary?.totals;

  return (
    <CocoaPage
      eyebrow={finance.eyebrow("Operaciones")}
      title="Punto de venta (TPV)"
      subtitle={hosted ? undefined : "Abre comandas en restaurante, bar o room service, añade consumos y cierra cobrando a la habitación, en efectivo o con tarjeta."}
      actions={
        <>
          {busy ? <CocoaBadge tone="info">{STATUS_LABELS.inProgress}</CocoaBadge> : null}
          {error && tickets.length > 0 ? <CocoaBadge tone="danger">{STATUS_LABELS.loadError}</CocoaBadge> : null}
          <FinanceScopeSelector scope={finance} />
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
      <CocoaSection
        title="Arqueo de caja"
        meta={
          scopedSummary ? (
            <>
              Comandas cerradas en el rango ·{" "}
              {scopedSummary.timeZoneSource === "utc_fallback" ? (
                <CocoaBadge tone="warning" variant="tinted" size="small">
                  {UTC_FALLBACK_LABEL}
                </CocoaBadge>
              ) : (
                timeZoneLabel(scopedSummary)
              )}
            </>
          ) : (
            "Comandas cerradas en el rango seleccionado"
          )
        }
      >
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
            <CocoaSelect value={csOutletId} onChange={(v) => setCsOutletChoice({ propertyId, id: v })} options={[{ value: "", label: STATUS_LABELS.all }, ...cashOutletOptions]} />
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
        {(cashLoading || finance.loading) && !scopedSummary ? (
          <CocoaSkeleton.Strip count={5} min={200} label="Calculando arqueo…" />
        ) : cashError ? (
          <CocoaState kind="error" title="No se pudo calcular el arqueo" message={cashError} onRetry={() => void loadCashSummary()} />
        ) : scopedSummary && cashTotals ? (
          <>
            <CocoaKpiStrip min={200} aria-label="Totales del arqueo">
              <CocoaKpi label="Efectivo" value={money(cashTotals.bySettlement.cash)} status="ok" />
              <CocoaKpi label="Tarjeta" value={money(cashTotals.bySettlement.card)} status="ok" />
              <CocoaKpi label="A habitación" value={money(cashTotals.bySettlement.room)} status="ok" />
              <CocoaKpi label={FIELD_LABELS.total} value={money(cashTotals.total)} deltaLabel={plural(cashTotals.tickets, "comanda", "comandas")} polarity="neutral" status="ok" />
              {/* Tickets of the window still open: pending, NOT revenue (outside every total); «—» when the counter failed (QC-06). */}
              <CocoaKpi
                label="Comandas abiertas"
                value={countLabel(scopedSummary.openTickets.count)}
                caption={`${money(scopedSummary.openTickets.total)} · no son ingreso`}
                status={scopedSummary.openTickets.count > 0 ? "warning" : "ok"}
                degraded={cashDegraded.openTickets}
              />
            </CocoaKpiStrip>
            {/* What the count does NOT contain (posSummaryView): failed counters as the
                degraded state, the rest as tinted notices; nothing when the count is clean. */}
            {cashWarnings.length > 0 ? (
              <div className="cocoa-stack" data-gap="2" aria-label="Avisos del arqueo">
                {cashWarnings.map((w) =>
                  w.kind === "degraded" ? (
                    <CocoaState key={w.kind} kind="degraded" inline title={w.title} message={w.message} />
                  ) : (
                    <CocoaCallout key={w.kind} tone={w.tone} title={w.title}>
                      {w.message}
                    </CocoaCallout>
                  )
                )}
              </div>
            ) : null}
            {scopedSummary.byOutlet.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin comandas cerradas en el rango seleccionado." />
            ) : (
              <CocoaTable
                columns={cashColumnsNow}
                rows={scopedSummary.byOutlet}
                rowKey="outletRowId"
                density="compact"
                caption="Arqueo por punto de venta"
                aria-label="Arqueo por punto de venta"
                footer={{
                  outletName: FIELD_LABELS.total,
                  tickets: number(cashTotals.tickets),
                  cash: money(cashTotals.bySettlement.cash),
                  card: money(cashTotals.bySettlement.card),
                  room: money(cashTotals.bySettlement.room),
                  unsettled: showUnsettled ? unsettledLabel(cashTotals.unsettled) : undefined,
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
            <CocoaSelect value={outletId} onChange={(v) => setOutletChoice({ propertyId, id: v })} options={outlets.map((o) => ({ value: o.id, label: o.name }))} disabled={busy || outlets.length === 0} />
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
                  // The ticket opens in the hotel in scope, never in the operational active property.
                  await openPosTicket({ outletId, roomNumber: roomNumber || undefined }, propertyId);
                  setRoomNumber("");
                }, "Comanda abierta.")
              }
            >
              Abrir comanda
            </CocoaButton>
          </div>
        </CocoaFormRow>
      </CocoaSection>

      {(loading || finance.loading) && tickets.length === 0 ? (
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
                  {/* The series is the one the API allocated (prefix of the number), never a constant of the UI. */}
                  <strong className="cocoa-cluster">
                    {selected.invoiceNumber ?? "sin emitir"}
                    {selectedSeries ? (
                      <CocoaBadge size="small" tone="neutral" title="Serie real de la factura que devuelve el API">
                        {selectedSeries}
                      </CocoaBadge>
                    ) : null}
                  </strong>
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

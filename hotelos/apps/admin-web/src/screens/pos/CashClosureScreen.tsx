// Cierre de caja — Operaciones › Punto de venta › Cierre de caja
// (/operaciones/tpv/cierre-de-caja; Tanda 6 · lote 6-E, hosted in
// PuntoVentaTabs; module outlet_pos; recepción closes the reception cash
// «*», F&B its outlets).
//
// Cocoa 22 (docs/design/COCOA-22.md §4, «workspace» archetype): CocoaPage →
// content toolbar (status segmented · outlet · day range) → KPI strip (open
// counts, pending sign-off, accumulated difference, cash counted) →
// CocoaGrid 4/8: closures list (CocoaTable, row = select) + detail; under
// 900 px the list is the page and the detail opens in a CocoaDrawer (bottom
// sheet on phones). The detail walks the real flow of the API
// (services/cashClosureApi.ts, packages/shared/src/pos-types.ts):
//   abrir con fondo (POST …/cash-closures, dialog) → recuento por método y,
//   opcionalmente, por denominaciones (CocoaStepper) → cerrar (POST …/close,
//   confirmation dialog with the differences the API will sign; a cash
//   difference posts D 659 / H 570 or D 570 / H 759) → aprobar (POST
//   …/approve, accounting.journal.post).
// Every `details.code` (CASH_CLOSURE_EXISTS · CASH_CLOSURE_NOT_OPEN ·
// CASH_CLOSURE_NOT_CLOSED · CASH_COUNT_MISMATCH · POS_OUTLET_NOT_FOUND) is
// mapped to Spanish by cashClosureErrorMessage; amounts are decimal strings
// on the wire and only become numbers to be painted (lib/format).

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { getActiveProperty } from "../../services/activeProperty";
import { fetchPosOutlets, type PosOutlet } from "../../services/posApi";
import {
  approveCashClosure,
  cashClosureErrorMessage,
  closeCashClosure,
  getCashClosure,
  listCashClosures,
  openCashClosure,
  type CashClosureWire
} from "../../services/cashClosureApi";
import { financeErrorCode, financeErrorDetails } from "../../services/finance-contracts";
import { todayIsoLocal } from "../../services/pmsCommerceApi";
import { useNavGate } from "../../navigation/useEnabledModules";
import { useToast } from "../../components/Toast";
import { navigateTo } from "../../lib/navigate";
import { date, dateTime, money, number, plural, toNumber } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS } from "../../content/actions";
import { useTabHost } from "../tabs/TabHost";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDialog,
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
  CocoaSwitch,
  CocoaTable,
  CocoaToolbar,
  useViewportTier,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";
import {
  CASH_METHODS,
  CASH_METHOD_LABELS,
  CLOSURE_PERMISSIONS,
  DIFFERENCE_LABELS,
  EUR_DENOMINATIONS,
  RECEPTION_OUTLET,
  buildCloseRequest,
  canDo,
  closureOutletLabel,
  closureStatusLabel,
  closureStatusTone,
  differenceKind,
  differenceTone,
  emptyCounted,
  methodPreview,
  parseCountedAmount,
  relevantMethods,
  sumDenominations,
  sumPreview,
  toCents,
  type CountedByMethod,
  type DenominationQuantities,
  type MethodPreview
} from "./cash-closure-helpers";

type Message = { text: string; tone: CocoaTone; closureId?: string };
type StatusFilter = "" | "open" | "closed" | "approved";

const LIST_LIMIT = 200;
const STATUS_OPTIONS = [
  { value: "", label: STATUS_LABELS.all },
  { value: "open", label: "Abiertas" },
  { value: "closed", label: "Cerradas" },
  { value: "approved", label: "Aprobadas" }
];

function isStatusFilter(value: string): value is StatusFilter {
  return value === "" || value === "open" || value === "closed" || value === "approved";
}

/** Money of a decimal string, «—» for null (a count that has not happened yet). */
function amount(value: string | null | undefined): string {
  return money(value ?? null);
}

function DifferenceBadge({ difference, size = "regular" }: { difference: string | null | undefined; size?: "small" | "regular" }) {
  const kind = differenceKind(difference);
  return (
    <CocoaBadge tone={differenceTone(difference)} variant="tinted" size={size}>
      {kind === "pending" ? DIFFERENCE_LABELS.pending : `${DIFFERENCE_LABELS[kind]} · ${amount(difference)}`}
    </CocoaBadge>
  );
}

const LIST_COLUMNS: CocoaTableColumn<CashClosureWire>[] = [
  { key: "businessDate", label: "Día", render: (c) => <strong>{date(c.businessDate, "short")}</strong> },
  { key: "outlet", label: "Caja", render: (c) => closureOutletLabel(c) },
  {
    key: "status",
    label: FIELD_LABELS.status,
    render: (c) => (
      <CocoaBadge tone={closureStatusTone(c.status)} size="small">
        {closureStatusLabel(c.status)}
      </CocoaBadge>
    )
  },
  { key: "difference", label: "Diferencia", align: "right", hideOnNarrow: true, render: (c) => (c.difference === null ? "—" : amount(c.difference)) }
];

const PREVIEW_COLUMNS: CocoaTableColumn<MethodPreview>[] = [
  { key: "method", label: "Método", render: (r) => CASH_METHOD_LABELS[r.method] },
  { key: "expected", label: "Previsto", align: "right", render: (r) => amount(r.expected) },
  { key: "counted", label: "Contado", align: "right", render: (r) => amount(r.counted) },
  { key: "difference", label: "Diferencia", align: "right", render: (r) => (r.difference === null ? "—" : <DifferenceBadge difference={r.difference} size="small" />) }
];

/** Mirror skeleton of the workspace: toolbar row, four KPI tiles, list + detail. */
function ClosureSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton variant="row" height={28} />
      <CocoaSkeleton.Strip count={4} min={180} />
      <CocoaSkeleton.Grid rows={[[4, 8]]} height={320} label="Cargando cierres de caja…" />
    </div>
  );
}

export function CashClosureScreen() {
  const hosted = useTabHost() !== null;
  const propertyName = getActiveProperty().propertyName;
  const tier = useViewportTier();
  const compact = tier === "phone" || tier === "tablet";
  const { showToast } = useToast();
  const gate = useNavGate();
  const granted = gate.grantedPermissions;
  const canOpen = canDo(granted, CLOSURE_PERMISSIONS.open);
  const canClose = canDo(granted, CLOSURE_PERMISSIONS.close);
  const canApprove = canDo(granted, CLOSURE_PERMISSIONS.approve);
  const today = todayIsoLocal();

  // ---- filters --------------------------------------------------------------
  const [status, setStatus] = useState<StatusFilter>("");
  const [outletFilter, setOutletFilter] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  // ---- data -----------------------------------------------------------------
  const [closures, setClosures] = useState<CashClosureWire[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [outlets, setOutlets] = useState<PosOutlet[]>([]);
  const [outletsError, setOutletsError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Message | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const rows = await listCashClosures({ status: status || undefined, outletId: outletFilter || undefined, from: from || undefined, to: to || undefined, limit: LIST_LIMIT });
      setClosures(rows);
    } catch (e: unknown) {
      setError(cashClosureErrorMessage(e, "No se pudieron cargar los cierres de caja."));
    } finally {
      setLoading(false);
    }
  }, [status, outletFilter, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void fetchPosOutlets()
      .then((list) => {
        setOutlets(list);
        setOutletsError(null);
      })
      .catch((e: unknown) => {
        setOutlets([]);
        setOutletsError(cashClosureErrorMessage(e, "No se pudieron cargar los puntos de venta: solo se puede abrir la caja de recepción."));
      });
  }, []);

  /** Replace (or prepend) a closure the API just returned, and select it. */
  function upsert(record: CashClosureWire) {
    setClosures((prev) => (prev.some((c) => c.id === record.id) ? prev.map((c) => (c.id === record.id ? record : c)) : [record, ...prev]));
    setSelectedId(record.id);
  }

  const selected = useMemo(() => closures.find((c) => c.id === selectedId) ?? null, [closures, selectedId]);

  // ---- derived KPIs (over the painted list) ----------------------------------
  const openCount = closures.filter((c) => c.status === "open").length;
  const pendingApproval = closures.filter((c) => c.status === "closed").length;
  const signed = closures.filter((c) => c.status !== "open");
  const differenceCents = signed.reduce((sum, c) => sum + (toCents(c.difference) ?? 0), 0);
  const countedCents = signed.reduce((sum, c) => sum + (toCents(c.countedCash) ?? 0), 0);

  // ---- open dialog -----------------------------------------------------------
  const [openDialog, setOpenDialog] = useState(false);
  const [openOutlet, setOpenOutlet] = useState(RECEPTION_OUTLET);
  const [openDate, setOpenDate] = useState(today);
  const [openFloat, setOpenFloat] = useState("");
  const [openNotes, setOpenNotes] = useState("");
  const openOutletId = useId();
  const openFloatParsed = parseCountedAmount(openFloat);

  async function submitOpen() {
    if (openFloatParsed === null) return;
    setBusy(true);
    setMsg(null);
    try {
      const created = await openCashClosure({
        outletId: openOutlet,
        businessDate: openDate || undefined,
        openingFloat: (toCents(openFloatParsed) ?? 0) / 100,
        notes: openNotes.trim() || undefined
      });
      setOpenDialog(false);
      setOpenFloat("");
      setOpenNotes("");
      showToast(`Caja abierta: ${closureOutletLabel(created)} · ${date(created.businessDate, "short")}.`, { variant: "success" });
      upsert(created);
      void load();
    } catch (e: unknown) {
      const code = financeErrorCode(e);
      const existingId = financeErrorDetails(e)?.cashClosureId;
      setOpenDialog(false);
      setMsg({ text: cashClosureErrorMessage(e, "No se pudo abrir la caja."), tone: code === "CASH_CLOSURE_EXISTS" ? "warning" : "danger", closureId: typeof existingId === "string" ? existingId : undefined });
    } finally {
      setBusy(false);
    }
  }

  /** «Ver la existente» after 409 CASH_CLOSURE_EXISTS: select it, fetching it when the filters hide it. */
  async function showClosure(closureId: string) {
    if (closures.some((c) => c.id === closureId)) {
      setSelectedId(closureId);
      return;
    }
    try {
      upsert(await getCashClosure(closureId));
    } catch (e: unknown) {
      setMsg({ text: cashClosureErrorMessage(e, "No se pudo cargar el cierre de caja."), tone: "danger" });
    }
  }

  // ---- close draft (reset when the selection changes) ------------------------
  const [counted, setCounted] = useState<Record<string, string>>(() => emptyCounted());
  const [useDenominations, setUseDenominations] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [closeNotes, setCloseNotes] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [approveDialog, setApproveDialog] = useState(false);
  const [approveNotes, setApproveNotes] = useState("");
  const approveNotesId = useId();

  useEffect(() => {
    setCounted(emptyCounted());
    setUseDenominations(false);
    setQuantities({});
    setCloseNotes("");
    setConfirmClose(false);
    setApproveDialog(false);
    setApproveNotes("");
  }, [selectedId]);

  const denominationsTotal = sumDenominations(quantities);
  const typed: CountedByMethod = useMemo(() => {
    const out = { ...emptyCounted(), ...counted } as Record<string, string>;
    if (useDenominations) out.cash = denominationsTotal;
    return out as CountedByMethod;
  }, [counted, useDenominations, denominationsTotal]);
  const preview = useMemo(() => (selected ? methodPreview(selected, typed) : []), [selected, typed]);
  const previewRows = useMemo(() => relevantMethods(preview), [preview]);
  const closeRequest = useMemo(
    () => buildCloseRequest({ counted: typed, useDenominations, quantities: quantities as DenominationQuantities, notes: closeNotes }),
    [typed, useDenominations, quantities, closeNotes]
  );
  const cashPreview = preview.find((r) => r.method === "cash") ?? null;

  async function submitClose() {
    if (!selected || !closeRequest.ok) return;
    setBusy(true);
    setMsg(null);
    try {
      const closed = await closeCashClosure(selected.id, closeRequest.body);
      setConfirmClose(false);
      const kind = differenceKind(closed.difference);
      showToast(
        kind === "balanced"
          ? "Caja cerrada: el efectivo cuadra."
          : `Caja cerrada con ${DIFFERENCE_LABELS[kind].toLowerCase()} de ${amount(closed.difference)}${closed.journalEntryId ? " (asiento contabilizado)" : ""}.`,
        { variant: kind === "balanced" ? "success" : "warning" }
      );
      upsert(closed);
      void load();
    } catch (e: unknown) {
      setConfirmClose(false);
      setMsg({ text: cashClosureErrorMessage(e, "No se pudo cerrar la caja."), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  async function submitApprove() {
    if (!selected) return;
    setBusy(true);
    setMsg(null);
    try {
      const approved = await approveCashClosure(selected.id, approveNotes.trim() ? { notes: approveNotes.trim() } : {});
      setApproveDialog(false);
      showToast("Cierre de caja aprobado.", { variant: "success" });
      upsert(approved);
      void load();
    } catch (e: unknown) {
      setApproveDialog(false);
      setMsg({ text: cashClosureErrorMessage(e, "No se pudo aprobar el cierre de caja."), tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  // ---- render helpers ---------------------------------------------------------
  const outletOptions = [{ value: RECEPTION_OUTLET, label: "Recepción (toda la propiedad)" }, ...outlets.map((o) => ({ value: o.id, label: o.name }))];

  const openButton = canOpen ? (
    <CocoaButton variant="filled" tone="accent" size="small" disabled={busy} onClick={() => setOpenDialog(true)}>
      Abrir caja
    </CocoaButton>
  ) : null;

  const list = (
    <CocoaSection
      title="Cierres"
      meta={loading ? STATUS_LABELS.loading : plural(closures.length, "cierre", "cierres")}
      padding="none"
      scroll={compact ? undefined : "y"}
      maxHeight={compact ? undefined : 640}
      style={{ overflow: "clip" }}
    >
      {error ? (
        <CocoaState kind="error" title="No se pudieron cargar los cierres" message={error} onRetry={() => void load()} />
      ) : closures.length === 0 && !loading ? (
        <CocoaState
          kind="empty"
          illustration="box"
          title="Sin cierres de caja"
          message={status || outletFilter || from || to ? "Ningún cierre coincide con los filtros." : "Abre la caja con su fondo para empezar el arqueo del día."}
          primaryAction={canOpen ? { label: "Abrir caja", onClick: () => setOpenDialog(true) } : undefined}
        />
      ) : (
        <CocoaTable
          columns={LIST_COLUMNS}
          rows={closures}
          rowKey="id"
          density="compact"
          loading={loading && closures.length === 0}
          selectedKey={selectedId ?? undefined}
          onSelect={(c) => setSelectedId(c.id)}
          rowTitle={() => "Abrir el detalle del cierre"}
          caption="Cierres de caja"
          aria-label="Cierres de caja"
        />
      )}
    </CocoaSection>
  );

  const detail = selected ? (
    <ClosureDetail
      closure={selected}
      busy={busy}
      canClose={canClose}
      canApprove={canApprove}
      counted={counted}
      onCounted={(method, value) => setCounted((prev) => ({ ...prev, [method]: value }))}
      useDenominations={useDenominations}
      onUseDenominations={setUseDenominations}
      quantities={quantities}
      onQuantity={(denomination, quantity) => setQuantities((prev) => ({ ...prev, [denomination]: quantity }))}
      denominationsTotal={denominationsTotal}
      closeNotes={closeNotes}
      onCloseNotes={setCloseNotes}
      preview={previewRows}
      closeError={closeRequest.ok ? null : closeRequest.error}
      onRequestClose={() => setConfirmClose(true)}
      onRequestApprove={() => setApproveDialog(true)}
    />
  ) : (
    <CocoaSection aria-label="Sin selección">
      <CocoaState kind="empty" illustration="box" title="Elige un cierre" message="El detalle del arqueo, el recuento y la aprobación aparecen aquí." />
    </CocoaSection>
  );

  return (
    <CocoaPage
      eyebrow={`Operaciones · ${propertyName}`}
      title="Cierre de caja"
      subtitle={hosted ? undefined : "Arqueo del día por punto de venta: fondo de apertura, recuento por método y denominaciones, diferencias y aprobación."}
      actions={
        <>
          {busy ? <CocoaBadge tone="info">{STATUS_LABELS.inProgress}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void load()} loading={loading && closures.length > 0} title={ACTIONS.refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
          {openButton}
        </>
      }
      state={loading && closures.length === 0 && !error ? "loading" : "ready"}
      skeleton={<ClosureSkeleton />}
      commands={[
        { id: "cash-closure-refresh", label: "Actualizar cierres de caja", run: () => void load() },
        { id: "cash-closure-open", label: "Abrir caja", run: () => setOpenDialog(true) }
      ]}
    >
      {msg ? (
        <CocoaCallout
          tone={msg.tone}
          role="status"
          actions={
            msg.closureId ? (
              <CocoaButton variant="tinted" tone="accent" size="small" onClick={() => void showClosure(msg.closureId as string)}>
                Ver el cierre existente
              </CocoaButton>
            ) : undefined
          }
        >
          {msg.text}
        </CocoaCallout>
      ) : null}
      {outletsError ? <CocoaCallout tone="warning">{outletsError}</CocoaCallout> : null}

      <CocoaToolbar
        variant="content"
        aria-label="Filtros de los cierres de caja"
        leftSlot={<CocoaSegmentedControl value={status} onChange={(v) => setStatus(isStatusFilter(v) ? v : "")} options={STATUS_OPTIONS} size="small" aria-label="Estado del cierre" />}
        rightSlot={
          <span className="cocoa-cluster">
            <CocoaSelect
              value={outletFilter}
              onChange={setOutletFilter}
              size="small"
              aria-label="Caja"
              options={[{ value: "", label: "Todas las cajas" }, { value: RECEPTION_OUTLET, label: "Recepción" }, ...outlets.map((o) => ({ value: o.id, label: o.name }))]}
            />
            <CocoaDatePicker value={from} max={to || undefined} onChange={setFrom} size="small" aria-label={FIELD_LABELS.from} />
            <CocoaDatePicker value={to} min={from || undefined} onChange={setTo} size="small" aria-label={FIELD_LABELS.to} />
            {from || to || status || outletFilter ? (
              <CocoaButton
                variant="plain"
                tone="neutral"
                size="small"
                onClick={() => {
                  setStatus("");
                  setOutletFilter("");
                  setFrom("");
                  setTo("");
                }}
              >
                {ACTIONS.clearFilters}
              </CocoaButton>
            ) : null}
          </span>
        }
      />

      <CocoaKpiStrip stagger aria-label="Resumen de los cierres listados">
        <CocoaKpi label="Cajas abiertas" value={openCount} deltaLabel={openCount > 0 ? "recuento pendiente" : "ninguna"} polarity="neutral" status={openCount > 0 ? "warning" : "ok"} />
        <CocoaKpi label="Pendientes de aprobar" value={pendingApproval} deltaLabel="cerradas sin aprobar" polarity="neutral" status={pendingApproval > 0 ? "warning" : "ok"} />
        <CocoaKpi
          label="Diferencia acumulada"
          value={signed.length > 0 ? money(differenceCents / 100, { signDisplay: "exceptZero" }) : "—"}
          deltaLabel={signed.length > 0 ? plural(signed.length, "cierre firmado", "cierres firmados") : "sin cierres firmados"}
          polarity="neutral"
          status={differenceCents === 0 ? "ok" : differenceCents > 0 ? "warning" : "critical"}
        />
        <CocoaKpi label="Efectivo contado" value={signed.length > 0 ? money(countedCents / 100) : "—"} deltaLabel="en los cierres listados" polarity="neutral" status="ok" />
      </CocoaKpiStrip>

      {compact ? (
        <>
          {list}
          <CocoaDrawer
            open={selected !== null}
            onClose={() => setSelectedId(null)}
            title={selected ? `${closureOutletLabel(selected)} · ${date(selected.businessDate, "short")}` : "Cierre de caja"}
            subtitle={selected ? closureStatusLabel(selected.status) : undefined}
            side="right"
            size="lg"
          >
            {selected ? detail : null}
          </CocoaDrawer>
        </>
      ) : (
        <CocoaGrid align="start" aria-label="Cierres de caja y detalle">
          <CocoaSpan cols={4} min={320}>
            {list}
          </CocoaSpan>
          <CocoaSpan cols={8} min={480}>
            {detail}
          </CocoaSpan>
        </CocoaGrid>
      )}

      {/* Abrir caja */}
      <CocoaDialog
        open={openDialog}
        onClose={() => setOpenDialog(false)}
        title="Abrir caja"
        description="Indica la caja, el día de negocio y el fondo con el que empieza. El previsto se calcula con los cobros, las ventas al contado y los gastos de caja del día."
        confirmLabel="Abrir caja"
        onConfirm={submitOpen}
        busy={busy}
        size="md"
        initialFocus={() => document.getElementById(openOutletId)}
      >
        <CocoaFormRow columns={2} min={200}>
          <CocoaField label="Caja" htmlFor={openOutletId}>
            <CocoaSelect id={openOutletId} value={openOutlet} onChange={setOpenOutlet} options={outletOptions} disabled={busy} />
          </CocoaField>
          <CocoaField label="Día de negocio">
            <CocoaDatePicker value={openDate} onChange={setOpenDate} max={today} disabled={busy} />
          </CocoaField>
          <CocoaField label="Fondo de apertura" hint="en euros" error={openFloatParsed === null ? "Escribe un importe igual o mayor que cero." : undefined}>
            <CocoaInput value={openFloat} onChange={setOpenFloat} inputMode="decimal" placeholder="0,00" disabled={busy} />
          </CocoaField>
          <CocoaField label={FIELD_LABELS.notes} hint={STATUS_LABELS.optional.toLowerCase()}>
            <CocoaInput value={openNotes} onChange={setOpenNotes} disabled={busy} maxLength={2000} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaDialog>

      {/* Cerrar caja (alto riesgo: irreversible, puede asentar la diferencia) */}
      <CocoaDialog
        open={confirmClose && selected !== null}
        onClose={() => setConfirmClose(false)}
        tone="destructive"
        title="¿Cerrar la caja?"
        description="Se firma el recuento y la caja no admitirá más ventas al contado de ese día. El previsto se recalcula en este momento con los movimientos reales."
        confirmLabel="Cerrar caja"
        onConfirm={submitClose}
        busy={busy}
        size="md"
      >
        {cashPreview ? (
          <ul className="c22-section__list" aria-label="Resumen del recuento">
            <li>
              <span>Efectivo previsto al abrir</span>
              <strong>{amount(cashPreview.expected)}</strong>
            </li>
            <li>
              <span>Efectivo contado</span>
              <strong>{amount(cashPreview.counted)}</strong>
            </li>
            <li>
              <span>Diferencia</span>
              <DifferenceBadge difference={cashPreview.difference} size="small" />
            </li>
          </ul>
        ) : null}
        <p>Si la diferencia en efectivo no es cero se contabiliza: faltante en la cuenta 659 contra 570, sobrante en 570 contra 759. Las diferencias de tarjeta no generan asiento: se concilian con la liquidación del banco.</p>
      </CocoaDialog>

      {/* Aprobar */}
      <CocoaDialog
        open={approveDialog && selected !== null}
        onClose={() => setApproveDialog(false)}
        title="Aprobar el cierre de caja"
        description="La aprobación es la firma de dirección o contabilidad sobre el recuento ya cerrado. Las notas se añaden al cierre."
        confirmLabel={ACTIONS.approve}
        onConfirm={submitApprove}
        busy={busy}
        initialFocus={() => document.getElementById(approveNotesId)}
      >
        <CocoaField label={FIELD_LABELS.notes} htmlFor={approveNotesId} hint={STATUS_LABELS.optional.toLowerCase()}>
          <CocoaInput id={approveNotesId} value={approveNotes} onChange={setApproveNotes} multiline rows={3} maxLength={2000} disabled={busy} />
        </CocoaField>
      </CocoaDialog>
    </CocoaPage>
  );
}

// ── detail panel ──────────────────────────────────────────────────────────────

type ClosureDetailProps = {
  closure: CashClosureWire;
  busy: boolean;
  canClose: boolean;
  canApprove: boolean;
  counted: Record<string, string>;
  onCounted: (method: string, value: string) => void;
  useDenominations: boolean;
  onUseDenominations: (value: boolean) => void;
  quantities: Record<string, number>;
  onQuantity: (denomination: string, quantity: number) => void;
  denominationsTotal: string;
  closeNotes: string;
  onCloseNotes: (value: string) => void;
  preview: MethodPreview[];
  closeError: string | null;
  onRequestClose: () => void;
  onRequestApprove: () => void;
};

/** Methods with money in a record (`Record<CashMethod, string>`), for the expectation lists. */
function nonZeroMethods(amounts: Record<string, string>): Array<[string, string]> {
  return CASH_METHODS.filter((m) => (toCents(amounts[m]) ?? 0) !== 0).map((m) => [CASH_METHOD_LABELS[m], amounts[m]]);
}

function ClosureDetail(props: ClosureDetailProps) {
  const { closure, busy, preview } = props;
  const isOpen = closure.status === "open";
  const expectation = closure.expectation;
  const payments = nonZeroMethods(expectation.payments);
  const refunds = nonZeroMethods(expectation.refunds);
  const posSales = nonZeroMethods(expectation.posSales);
  const expensesCents = toCents(expectation.cashExpenses) ?? 0;
  const hasMovements = payments.length + refunds.length + posSales.length > 0 || expensesCents !== 0;
  const linkedTickets = number(closure.linkedTickets);

  return (
    <div className="cocoa-stack" data-gap="4">
      <CocoaSection
        title={`${closureOutletLabel(closure)} · ${date(closure.businessDate, "medium")}`}
        meta={
          <CocoaBadge tone={closureStatusTone(closure.status)} variant="tinted">
            {closureStatusLabel(closure.status)}
          </CocoaBadge>
        }
      >
        <CocoaKpiStrip min={200} aria-label="Cifras del cierre">
          <CocoaKpi label="Fondo de apertura" value={amount(closure.openingFloat)} polarity="neutral" status="ok" />
          <CocoaKpi label={isOpen ? "Efectivo previsto al abrir" : "Efectivo previsto"} value={amount(closure.expectedCash)} deltaLabel={isOpen ? "se recalcula al cerrar" : "movimientos del día"} polarity="neutral" status="ok" />
          <CocoaKpi label="Efectivo contado" value={closure.countedCash === null ? "—" : amount(closure.countedCash)} deltaLabel={closure.countedCash === null ? "sin recuento" : undefined} polarity="neutral" status="ok" />
          <CocoaKpi
            label="Diferencia"
            value={closure.difference === null ? "—" : money(closure.difference, { signDisplay: "exceptZero" })}
            deltaLabel={DIFFERENCE_LABELS[differenceKind(closure.difference)]}
            polarity="neutral"
            status={differenceKind(closure.difference) === "shortage" ? "critical" : differenceKind(closure.difference) === "surplus" ? "warning" : "ok"}
          />
        </CocoaKpiStrip>

        <ul className="c22-section__list" aria-label="Datos del cierre">
          <li>
            <span>Abierta</span>
            <strong>{dateTime(closure.openedAt)}</strong>
          </li>
          {closure.closedAt ? (
            <li>
              <span>Cerrada</span>
              <strong>{dateTime(closure.closedAt)}</strong>
            </li>
          ) : null}
          {closure.approvedAt ? (
            <li>
              <span>Aprobada</span>
              <strong>{dateTime(closure.approvedAt)}</strong>
            </li>
          ) : null}
          {!isOpen ? (
            <li>
              <span>Comandas al contado vinculadas</span>
              <strong>{linkedTickets}</strong>
            </li>
          ) : null}
          {!isOpen ? (
            <li>
              <span>Asiento de la diferencia</span>
              {closure.journalEntryId ? (
                <CocoaButton variant="plain" tone="accent" size="small" onClick={() => navigateTo("JournalScreen", closure.journalEntryId ?? undefined)}>
                  Ver en el diario
                </CocoaButton>
              ) : (
                <strong>Sin asiento: la caja cuadra</strong>
              )}
            </li>
          ) : null}
          {closure.notes ? (
            <li>
              <span>{FIELD_LABELS.notes}</span>
              <strong>{closure.notes}</strong>
            </li>
          ) : null}
        </ul>
      </CocoaSection>

      <CocoaSection title={isOpen ? "Previsto al abrir la caja" : "Movimientos del día"} meta={isOpen ? "Se recalcula al cerrar" : undefined}>
        {!hasMovements ? (
          <CocoaState kind="empty" inline title={isOpen ? "Sin cobros ni ventas al contado registrados cuando se abrió la caja." : "Sin cobros, ventas al contado ni gastos de caja ese día."} />
        ) : (
          <ul className="c22-section__list" aria-label="Movimientos que forman el previsto">
            <li>
              <span>Fondo de apertura</span>
              <strong>{amount(expectation.openingFloat)}</strong>
            </li>
            {payments.map(([label, value]) => (
              <li key={`p-${label}`}>
                <span>Cobros de folios · {label}</span>
                <strong>{amount(value)}</strong>
              </li>
            ))}
            {refunds.map(([label, value]) => (
              <li key={`r-${label}`}>
                <span>Devoluciones · {label}</span>
                <strong>−{amount(value)}</strong>
              </li>
            ))}
            {posSales.map(([label, value]) => (
              <li key={`s-${label}`}>
                <span>Ventas del punto de venta · {label}</span>
                <strong>{amount(value)}</strong>
              </li>
            ))}
            {expensesCents !== 0 ? (
              <li>
                <span>Gastos pagados en efectivo</span>
                <strong>−{amount(expectation.cashExpenses)}</strong>
              </li>
            ) : null}
          </ul>
        )}
      </CocoaSection>

      {isOpen ? (
        <CountForm {...props} />
      ) : (
        <CocoaSection title="Recuento firmado" meta={closure.counts.length > 0 ? `${plural(closure.counts.length, "denominación", "denominaciones")} contadas` : undefined}>
          <CocoaTable
            columns={PREVIEW_COLUMNS}
            rows={preview}
            rowKey="method"
            density="compact"
            caption="Recuento por método"
            aria-label="Recuento por método"
            footer={{ method: FIELD_LABELS.total, expected: amount(sumPreview(preview, "expected")), counted: amount(sumPreview(preview, "counted")), difference: <strong>{money(sumPreview(preview, "difference"), { signDisplay: "exceptZero" })}</strong> }}
          />
        </CocoaSection>
      )}

      {!isOpen && closure.counts.length > 0 ? (
        <CocoaSection title="Recuento por denominaciones" meta={amount(closure.countedCash)}>
          <ul className="c22-section__list" aria-label="Denominaciones contadas">
            {closure.counts.map((row) => (
              <li key={row.denomination}>
                <span>
                  {number(row.quantity)} × {money(row.denomination, { decimals: "auto" })}
                </span>
                <strong>{amount(row.amount)}</strong>
              </li>
            ))}
          </ul>
        </CocoaSection>
      ) : null}

      {closure.status === "closed" ? (
        <CocoaSection title="Aprobación" meta="Firma de dirección o contabilidad">
          {props.canApprove ? (
            <div className="cocoa-row" data-gap="2" data-justify="end">
              <CocoaButton variant="filled" tone="accent" disabled={busy} onClick={props.onRequestApprove}>
                {ACTIONS.approve}
              </CocoaButton>
            </div>
          ) : (
            <CocoaCallout tone="neutral">La aprobación requiere el permiso de contabilidad para asentar (dirección o finanzas).</CocoaCallout>
          )}
        </CocoaSection>
      ) : null}
    </div>
  );
}

// ── count form (open closure) ────────────────────────────────────────────────

function CountForm({ closure, busy, canClose, counted, onCounted, useDenominations, onUseDenominations, quantities, onQuantity, denominationsTotal, closeNotes, onCloseNotes, preview, closeError, onRequestClose }: ClosureDetailProps) {
  const totalDifference = sumPreview(preview, "difference");
  if (!canClose) {
    return (
      <CocoaSection title="Recuento" meta="Caja abierta">
        <CocoaCallout tone="neutral">Cerrar la caja requiere el permiso de cobro del punto de venta (recepción, restauración o dirección).</CocoaCallout>
      </CocoaSection>
    );
  }
  return (
    <CocoaSection title="Recuento" meta={`Previsto al abrir: ${amount(closure.expectedCash)} en efectivo`}>
      <CocoaFormRow columns={3} min={180}>
        {CASH_METHODS.map((method) => {
          const value = method === "cash" && useDenominations ? denominationsTotal : (counted[method] ?? "");
          const invalid = parseCountedAmount(value) === null;
          return (
            <CocoaField key={method} label={CASH_METHOD_LABELS[method]} hint={`previsto ${amount(closure.byMethod[method]?.expected ?? "0.00")}`} error={invalid ? "Importe no válido." : undefined}>
              <CocoaInput
                value={value}
                onChange={(v) => onCounted(method, v)}
                inputMode="decimal"
                placeholder="0,00"
                readOnly={method === "cash" && useDenominations}
                disabled={busy}
                error={invalid}
              />
            </CocoaField>
          );
        })}
      </CocoaFormRow>

      <div className="cocoa-row" data-gap="2" data-justify="between">
        <CocoaSwitch checked={useDenominations} onChange={onUseDenominations} size="small" label="Recuento físico del efectivo por denominaciones" disabled={busy} />
        {useDenominations ? <CocoaBadge tone="info" variant="tinted">Suma del recuento: {amount(denominationsTotal)}</CocoaBadge> : null}
      </div>

      {useDenominations ? (
        <CocoaFormRow columns={4} min={140}>
          {EUR_DENOMINATIONS.map((denomination) => (
            <CocoaField key={denomination} label={money(denomination, { decimals: "auto" })}>
              <CocoaStepper value={quantities[denomination] ?? 0} onChange={(v) => onQuantity(denomination, v)} min={0} max={100000} size="small" disabled={busy} aria-label={`Unidades de ${money(denomination, { decimals: "auto" })}`} />
            </CocoaField>
          ))}
        </CocoaFormRow>
      ) : null}

      <CocoaField label={FIELD_LABELS.notes} hint={STATUS_LABELS.optional.toLowerCase()} fullWidth>
        <CocoaInput value={closeNotes} onChange={onCloseNotes} multiline rows={2} maxLength={2000} disabled={busy} placeholder="Incidencias del turno, cambio retirado, vales…" />
      </CocoaField>

      <CocoaTable
        columns={PREVIEW_COLUMNS}
        rows={preview}
        rowKey="method"
        density="compact"
        caption="Vista previa del recuento"
        aria-label="Vista previa del recuento"
        footer={{ method: FIELD_LABELS.total, expected: amount(sumPreview(preview, "expected")), counted: amount(sumPreview(preview, "counted")), difference: <strong>{money(totalDifference, { signDisplay: "exceptZero" })}</strong> }}
      />

      {closeError ? <CocoaCallout tone="danger">{closeError}</CocoaCallout> : null}

      <div className="cocoa-row" data-gap="2" data-justify="end">
        <CocoaButton variant="filled" tone="accent" disabled={busy || closeError !== null} onClick={onRequestClose}>
          Cerrar caja
        </CocoaButton>
      </div>
    </CocoaSection>
  );
}

export default CashClosureScreen;

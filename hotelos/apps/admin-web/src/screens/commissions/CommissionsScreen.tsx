// Comisiones — Finanzas › Comisiones (/finanzas/comisiones, standalone).
//
// Cocoa 22 (docs/design/COCOA-22.md §4, «DashboardStandalone»): KPI strip →
// «Desglose por canal» → grid 6/6 (reglas por canal · devengos). The rules
// drawer creates a rule (strict body: the API answers 400 in Spanish naming
// the rejected key); a rule is deactivated after a destructive dialog. The
// accruals post by themselves at invoice issue / check-out (D 629.1 / H 410);
// «Devengar una reserva» calls POST /commissions/accrue and shows the base the
// API used and its warnings («base estimada»); «Liquidar» (D 410 / H 572) and
// «Anular» go through dialogs because both write journal entries.
// Data: GET /commissions/rules · /commissions/accruals · /commissions/summary
// (commissions.read); writes through services/commissionsApi.ts.

import { useMemo, useState, type CSSProperties } from "react";
import { useApiData } from "../../hooks/useApiData";
import { getActiveProperty, getActivePropertyId } from "../../services/activeProperty";
import {
  COMMISSION_APPLIES_TO,
  COMMISSION_APPLIES_TO_LABELS_ES,
  accrueCommission,
  commissionsErrorMessage,
  createCommissionRule,
  deactivateCommissionRule,
  reverseCommissionAccrual,
  settleCommissionAccrual,
  type AccrueCommissionResult,
  type CommissionAccrualRecord,
  type CommissionAppliesTo,
  type CommissionRuleRecord,
  type CommissionSummary
} from "../../services/commissionsApi";
import { useToast } from "../../components/Toast";
import { toArray } from "../../utils/toArray";
import { ACTIONS, STATUS_LABELS, newLabel } from "../../content/actions";
import { date, dateTime, isoDate, money, number, percent, plural, toNumber } from "../../lib/format";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";

type Summary = CommissionSummary & { outstanding?: { commissionAmount: number; count: number } };

const ACCRUAL_STATUS_LABEL: Record<string, string> = {
  accrued: "Devengada",
  settled: "Liquidada",
  reversed: "Anulada",
  invoiced: "Facturada",
  paid: "Pagada"
};

function accrualTone(status: string): CocoaTone {
  switch (status) {
    case "settled":
    case "paid":
      return "success";
    case "reversed":
      return "neutral";
    case "invoiced":
      return "info";
    default:
      return "warning";
  }
}

const DEFAULT_LEDGER_ACCOUNT = "629.1";
const DEFAULT_RATE = "15.00";
const DEFAULT_BANK_ACCOUNT = "572";

function startOfMonthIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function fmtPct(value: number | string): string {
  return percent(value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Text styles (tokens only).
const captionStyle: CSSProperties = { display: "block", fontSize: "var(--cocoa-fs-caption)", color: "var(--cocoa-label-secondary)" };
const secondaryStyle: CSSProperties = { color: "var(--cocoa-label-secondary)" };

const CHANNEL_COLUMNS: CocoaTableColumn<Summary["byChannel"][number]>[] = [
  { key: "channelKey", label: "Canal", render: (c) => <strong>{c.channelKey}</strong> },
  { key: "baseAmount", label: "Base", align: "right", hideOnNarrow: true, render: (c) => money(c.baseAmount) },
  { key: "commissionAmount", label: "Comisión", align: "right", render: (c) => <strong>{money(c.commissionAmount)}</strong> },
  { key: "count", label: "Devengos", align: "right", render: (c) => number(c.count) }
];

const RULE_COLUMNS: CocoaTableColumn<CommissionRuleRecord>[] = [
  { key: "channel", label: "Canal", render: (r) => <strong>{r.channelCode ?? r.channelId ?? "—"}</strong> },
  { key: "ratePct", label: "Comisión", align: "right", render: (r) => fmtPct(r.ratePct) },
  { key: "appliesTo", label: "Se aplica sobre", hideOnNarrow: true, render: (r) => COMMISSION_APPLIES_TO_LABELS_ES[r.appliesTo as CommissionAppliesTo] ?? r.appliesTo },
  { key: "ledgerAccountCode", label: "Cuenta", hideOnNarrow: true, render: (r) => r.ledgerAccountCode },
  {
    key: "validity",
    label: "Vigencia",
    hideOnNarrow: true,
    render: (r) => (r.effectiveFrom || r.effectiveTo ? `${r.effectiveFrom ? date(r.effectiveFrom, "short") : "…"} – ${r.effectiveTo ? date(r.effectiveTo, "short") : "…"}` : "Sin límite")
  },
  {
    key: "active",
    label: "Estado",
    render: (r) => (
      <CocoaBadge tone={r.active ? "success" : "neutral"} size="small">
        {r.active ? STATUS_LABELS.active : STATUS_LABELS.inactive}
      </CocoaBadge>
    )
  }
];

const ACCRUAL_COLUMNS: CocoaTableColumn<CommissionAccrualRecord>[] = [
  {
    key: "origin",
    label: "Origen",
    render: (a) => (
      <>
        <strong>{a.invoiceId ? "Factura" : a.reservationId ? "Reserva" : "—"}</strong>
        <span style={captionStyle} title={a.invoiceId ?? a.reservationId ?? undefined}>
          {a.channelCode ?? a.channelId ?? "canal sin identificar"} · {dateTime(a.accruedAt)}
        </span>
      </>
    )
  },
  { key: "baseAmount", label: "Base", align: "right", hideOnNarrow: true, render: (a) => money(a.baseAmount, a.currencyCode) },
  { key: "ratePct", label: "Tipo", align: "right", hideOnNarrow: true, render: (a) => fmtPct(a.ratePct) },
  { key: "commissionAmount", label: "Comisión", align: "right", render: (a) => <strong>{money(a.commissionAmount, a.currencyCode)}</strong> },
  {
    key: "status",
    label: "Estado",
    render: (a) => (
      <CocoaBadge tone={accrualTone(a.status)} size="small" title={a.settledAt ? `Liquidada el ${date(a.settledAt, "short")}` : undefined}>
        {ACCRUAL_STATUS_LABEL[a.status] ?? a.status}
      </CocoaBadge>
    )
  }
];

// Mirror skeleton: strip, channel table and the 6/6 row.
function CommissionsSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton variant="card" height={160} />
      <CocoaSkeleton.Grid rows={[[6, 6]]} height={280} />
    </div>
  );
}

export function CommissionsScreen() {
  const propertyId = getActivePropertyId();
  const propertyName = getActiveProperty().propertyName;
  const { showToast } = useToast();
  const fromMtd = useMemo(startOfMonthIso, []);

  const rulesState = useApiData<CommissionRuleRecord[]>("/commissions/rules", { query: { propertyId } });
  const accrualsState = useApiData<CommissionAccrualRecord[]>("/commissions/accruals", { query: { propertyId } });
  const summaryState = useApiData<Summary>("/commissions/summary", { query: { propertyId, from: fromMtd } });

  const rules = toArray<CommissionRuleRecord>(rulesState.data);
  const accruals = toArray<CommissionAccrualRecord>(accrualsState.data);
  const summary = summaryState.data;
  const byChannel = toArray<Summary["byChannel"][number]>(summary?.byChannel);

  const refreshAll = () => {
    rulesState.refresh();
    accrualsState.refresh();
    summaryState.refresh();
  };

  // ---- new rule (drawer) ----
  const [ruleOpen, setRuleOpen] = useState(false);
  const [channelCode, setChannelCode] = useState("");
  const [ratePct, setRatePct] = useState(DEFAULT_RATE);
  const [appliesTo, setAppliesTo] = useState<string>("net_revenue");
  const [ledgerAccountCode, setLedgerAccountCode] = useState(DEFAULT_LEDGER_ACCOUNT);
  const [ruleError, setRuleError] = useState<string | null>(null);
  const [ruleSaving, setRuleSaving] = useState(false);

  const channelError = channelCode.trim() === "" ? "El código del canal es obligatorio." : /^[a-z0-9][a-z0-9_.-]*$/i.test(channelCode.trim()) ? undefined : "Solo letras, números, punto, guion y guion bajo.";
  const rateValue = toNumber(ratePct);
  const rateError = rateValue === null || rateValue <= 0 || rateValue > 100 ? "La comisión debe estar entre 0 y 100 %." : undefined;
  const ruleValid = !channelError && !rateError;

  function resetRuleForm() {
    setChannelCode("");
    setRatePct(DEFAULT_RATE);
    setAppliesTo("net_revenue");
    setLedgerAccountCode(DEFAULT_LEDGER_ACCOUNT);
    setRuleError(null);
  }

  async function saveRule() {
    if (!ruleValid || ruleSaving) return;
    setRuleSaving(true);
    setRuleError(null);
    try {
      await createCommissionRule({
        channelCode: channelCode.trim().toLowerCase(),
        ratePct: ratePct.trim(),
        appliesTo: appliesTo as CommissionAppliesTo,
        ledgerAccountCode: ledgerAccountCode.trim() || undefined
      });
      showToast("Regla de comisión guardada", { variant: "success" });
      setRuleOpen(false);
      resetRuleForm();
      refreshAll();
    } catch (err) {
      setRuleError(commissionsErrorMessage(err, "No se pudo guardar la regla."));
    } finally {
      setRuleSaving(false);
    }
  }

  // ---- deactivate rule (destructive dialog) ----
  const [pendingDeactivate, setPendingDeactivate] = useState<CommissionRuleRecord | null>(null);
  const [busy, setBusy] = useState(false);

  async function deactivate() {
    if (!pendingDeactivate) return;
    setBusy(true);
    try {
      await deactivateCommissionRule(pendingDeactivate.id);
      showToast("Regla desactivada: el canal deja de devengar comisiones", { variant: "success" });
      setPendingDeactivate(null);
      refreshAll();
    } catch (err) {
      showToast(commissionsErrorMessage(err, "No se pudo desactivar la regla."), { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  // ---- manual accrual (drawer) ----
  const [accrueOpen, setAccrueOpen] = useState(false);
  const [reservationId, setReservationId] = useState("");
  const [accrueChannel, setAccrueChannel] = useState("");
  const [accrueBase, setAccrueBase] = useState("");
  const [accrueDate, setAccrueDate] = useState("");
  const [accrueError, setAccrueError] = useState<string | null>(null);
  const [accrueResult, setAccrueResult] = useState<AccrueCommissionResult | null>(null);
  const [accruing, setAccruing] = useState(false);
  const accrueBaseValue = accrueBase.trim() === "" ? null : toNumber(accrueBase);
  const accrueBaseError = accrueBase.trim() !== "" && (accrueBaseValue === null || accrueBaseValue <= 0) ? "La base debe ser un importe positivo." : undefined;

  async function accrue() {
    if (reservationId.trim() === "" || accrueBaseError || accruing) return;
    setAccruing(true);
    setAccrueError(null);
    setAccrueResult(null);
    try {
      const result = await accrueCommission({
        reservationId: reservationId.trim(),
        channelCode: accrueChannel.trim() || undefined,
        baseAmount: accrueBase.trim() === "" ? undefined : accrueBase.trim().replace(",", "."),
        accruedAt: accrueDate || undefined
      });
      setAccrueResult(result);
      if (result.created) {
        showToast("Comisión devengada y contabilizada", { variant: "success" });
        refreshAll();
      }
    } catch (err) {
      setAccrueError(commissionsErrorMessage(err, "No se pudo devengar la comisión."));
    } finally {
      setAccruing(false);
    }
  }

  // ---- settle / reverse (dialogs with fields) ----
  const [settleTarget, setSettleTarget] = useState<CommissionAccrualRecord | null>(null);
  const [paidAt, setPaidAt] = useState("");
  const [bankLedgerCode, setBankLedgerCode] = useState(DEFAULT_BANK_ACCOUNT);
  const [reference, setReference] = useState("");
  const [reverseTarget, setReverseTarget] = useState<CommissionAccrualRecord | null>(null);
  const [reverseReason, setReverseReason] = useState("");

  function openSettle(accrual: CommissionAccrualRecord) {
    setPaidAt(isoDate(new Date()) ?? "");
    setBankLedgerCode(DEFAULT_BANK_ACCOUNT);
    setReference("");
    setSettleTarget(accrual);
  }

  async function settle() {
    if (!settleTarget) return;
    setBusy(true);
    try {
      await settleCommissionAccrual(settleTarget.id, {
        paidAt: paidAt || undefined,
        bankLedgerCode: bankLedgerCode.trim() || undefined,
        reference: reference.trim() || undefined
      });
      showToast("Comisión liquidada y contabilizada", { variant: "success" });
      setSettleTarget(null);
      refreshAll();
    } catch (err) {
      showToast(commissionsErrorMessage(err, "No se pudo liquidar la comisión."), { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function reverse() {
    if (!reverseTarget) return;
    setBusy(true);
    try {
      await reverseCommissionAccrual(reverseTarget.id, { reason: reverseReason.trim() || undefined });
      showToast("Devengo anulado con asiento de anulación", { variant: "success" });
      setReverseTarget(null);
      setReverseReason("");
      refreshAll();
    } catch (err) {
      showToast(commissionsErrorMessage(err, "No se pudo anular el devengo."), { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  // ---- derived figures ----
  const totalMtd = summary?.total.commissionAmount ?? 0;
  const baseMtd = summary?.total.baseAmount ?? 0;
  const percentOfRevenue = baseMtd > 0 ? (totalMtd / baseMtd) * 100 : 0;
  const topChannel = byChannel[0];
  const outstanding = summary?.outstanding;
  const newRuleLabel = newLabel("f", "regla");
  const anyLoading = rulesState.loading || accrualsState.loading || summaryState.loading;
  const nothingLoaded = !rulesState.data && !accrualsState.data && !summary;
  const state = nothingLoaded ? (anyLoading ? "loading" : "error") : "ready";
  const accrueBaseWarnings = toArray<string>(accrueResult?.base?.warnings);

  return (
    <CocoaPage
      eyebrow={`Finanzas · ${propertyName}`}
      title="Comisiones"
      subtitle="La comisión de cada canal de venta y su devengo: se contabiliza sola al emitir la factura o al hacer el check-out (cuenta 629.1 Comisiones de canales contra 410 Acreedores)."
      actions={
        <>
          {anyLoading ? <CocoaBadge tone="info">{STATUS_LABELS.loading}</CocoaBadge> : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshAll}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setAccrueOpen(true)}>
            Devengar una reserva
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => setRuleOpen(true)}>
            {newRuleLabel}
          </CocoaButton>
        </>
      }
      state={state}
      skeleton={<CommissionsSkeleton />}
      error={{ title: "No se pudieron cargar las comisiones", message: rulesState.error ?? summaryState.error ?? undefined, onRetry: refreshAll }}
      commands={[
        { id: "commissions-refresh", label: "Actualizar comisiones", run: refreshAll },
        { id: "commissions-new-rule", label: newRuleLabel, run: () => setRuleOpen(true) },
        { id: "commissions-accrue", label: "Devengar la comisión de una reserva", run: () => setAccrueOpen(true) }
      ]}
    >
      <CocoaKpiStrip stagger aria-label="Indicadores de comisiones del mes">
        <CocoaKpi label="Devengado este mes" value={money(totalMtd)} polarity="negative-good" status={totalMtd > 0 ? "warning" : "ok"} degraded={!summary} deltaLabel={summary ? plural(summary.total.count, "devengo", "devengos") : undefined} />
        <CocoaKpi label="Base de ingresos del mes" value={money(baseMtd)} polarity="neutral" degraded={!summary} />
        <CocoaKpi label="Comisión sobre ingresos" value={fmtPct(percentOfRevenue)} polarity="negative-good" degraded={!summary} />
        <CocoaKpi
          label="Pendiente de liquidar"
          value={money(outstanding?.commissionAmount)}
          polarity="negative-good"
          status={(outstanding?.commissionAmount ?? 0) > 0 ? "warning" : "ok"}
          degraded={!outstanding}
          deltaLabel={outstanding ? plural(outstanding.count, "devengo", "devengos") : undefined}
        />
        <CocoaKpi label="Canal con más comisión" value={topChannel ? topChannel.channelKey : "—"} polarity="neutral" deltaLabel={topChannel ? money(topChannel.commissionAmount) : "sin devengos"} degraded={!summary} />
      </CocoaKpiStrip>

      <CocoaSection title="Desglose por canal" meta="devengado este mes" headingLevel={2} padding={byChannel.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
        {summaryState.error && !summary ? (
          <CocoaState kind="error" inline title="No se pudo cargar el resumen." message={summaryState.error} onRetry={summaryState.refresh} />
        ) : byChannel.length === 0 ? (
          <CocoaState kind="empty" inline title="Ningún canal ha devengado comisiones este mes." />
        ) : (
          <CocoaTable columns={CHANNEL_COLUMNS} rows={byChannel} rowKey="channelKey" caption="Comisiones por canal" aria-label="Comisiones por canal" />
        )}
      </CocoaSection>

      <CocoaGrid align="start" aria-label="Reglas y devengos">
        <CocoaSpan cols={6} min={320}>
          <CocoaSection
            title="Reglas de comisión"
            meta={plural(rules.length, "regla", "reglas")}
            headingLevel={2}
            action={
              <CocoaButton variant="plain" tone="accent" size="small" onClick={() => setRuleOpen(true)}>
                {newRuleLabel}
              </CocoaButton>
            }
            padding={rules.length > 0 ? "none" : "md"}
            style={{ overflow: "clip" }}
          >
            {rulesState.error && !rulesState.data ? (
              <CocoaState kind="error" inline title="No se pudieron cargar las reglas." message={rulesState.error} onRetry={rulesState.refresh} />
            ) : rulesState.loading && !rulesState.data ? (
              <CocoaTable columns={RULE_COLUMNS} rows={[]} loading aria-label="Reglas de comisión" />
            ) : rules.length === 0 ? (
              <CocoaState kind="empty" title="Aún no hay reglas" message="Añade una regla por canal para empezar a devengar comisiones al facturar." primaryAction={{ label: newRuleLabel, onClick: () => setRuleOpen(true) }} />
            ) : (
              <CocoaTable
                columns={RULE_COLUMNS}
                rows={rules}
                rowKey="id"
                rowTone={(r) => (r.active ? undefined : "neutral")}
                rowActions={(r) =>
                  r.active ? (
                    <CocoaButton
                      variant="plain"
                      tone="destructive"
                      size="small"
                      onClick={(event) => {
                        event.stopPropagation();
                        setPendingDeactivate(r);
                      }}
                    >
                      {ACTIONS.deactivate}
                    </CocoaButton>
                  ) : null
                }
                caption="Reglas de comisión"
                aria-label="Reglas de comisión"
              />
            )}
          </CocoaSection>
        </CocoaSpan>

        <CocoaSpan cols={6} min={320}>
          <CocoaSection title="Devengos" meta={plural(accruals.length, "devengo", "devengos")} headingLevel={2} padding={accruals.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
            {accrualsState.error && !accrualsState.data ? (
              <CocoaState kind="error" inline title="No se pudieron cargar los devengos." message={accrualsState.error} onRetry={accrualsState.refresh} />
            ) : accrualsState.loading && !accrualsState.data ? (
              <CocoaTable columns={ACCRUAL_COLUMNS} rows={[]} loading aria-label="Devengos de comisión" />
            ) : accruals.length === 0 ? (
              <CocoaState kind="empty" title="Aún no hay devengos" message="Aparecerán al emitir facturas o cerrar estancias de reservas llegadas por canales con regla de comisión." />
            ) : (
              <CocoaTable
                columns={ACCRUAL_COLUMNS}
                rows={accruals}
                rowKey="id"
                rowActions={(a) =>
                  a.status === "accrued" ? (
                    <span className="cocoa-cluster">
                      <CocoaButton
                        variant="plain"
                        tone="accent"
                        size="small"
                        onClick={(event) => {
                          event.stopPropagation();
                          openSettle(a);
                        }}
                      >
                        Liquidar
                      </CocoaButton>
                      <CocoaButton
                        variant="plain"
                        tone="destructive"
                        size="small"
                        onClick={(event) => {
                          event.stopPropagation();
                          setReverseTarget(a);
                        }}
                      >
                        Anular
                      </CocoaButton>
                    </span>
                  ) : null
                }
                caption="Devengos de comisión"
                aria-label="Devengos de comisión"
              />
            )}
          </CocoaSection>
        </CocoaSpan>
      </CocoaGrid>

      {/* Nueva regla */}
      <CocoaDrawer
        open={ruleOpen}
        onClose={() => setRuleOpen(false)}
        title={newRuleLabel}
        subtitle="La regla se aplica a las reservas del canal desde ahora; los devengos ya registrados no cambian."
        side="right"
        size="md"
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setRuleOpen(false)} disabled={ruleSaving}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void saveRule()} loading={ruleSaving} disabled={!ruleValid || ruleSaving}>
              {ruleSaving ? STATUS_LABELS.saving : "Guardar regla"}
            </CocoaButton>
          </>
        }
      >
        <CocoaFormSection title="Canal y tipo">
          <CocoaFormRow columns={2}>
            <CocoaField label="Código del canal" required error={channelCode === "" ? undefined : channelError} help="En minúsculas, como llega en la reserva: booking, expedia, hotelbeds…">
              <CocoaInput value={channelCode} onChange={setChannelCode} placeholder="booking" maxLength={64} autoFocus />
            </CocoaField>
            <CocoaField label="Comisión (%)" required error={rateError}>
              <CocoaInput value={ratePct} onChange={setRatePct} type="number" inputMode="decimal" min={0} max={100} step="0.01" />
            </CocoaField>
            <CocoaField label="Se aplica sobre" required>
              <CocoaSelect value={appliesTo} onChange={setAppliesTo} options={COMMISSION_APPLIES_TO.map((key) => ({ value: key, label: COMMISSION_APPLIES_TO_LABELS_ES[key] }))} />
            </CocoaField>
            <CocoaField label="Cuenta de gasto" help="Subcuenta del PGC donde se contabiliza la comisión (629.1 por defecto).">
              <CocoaInput value={ledgerAccountCode} onChange={setLedgerAccountCode} placeholder={DEFAULT_LEDGER_ACCOUNT} maxLength={12} />
            </CocoaField>
          </CocoaFormRow>
        </CocoaFormSection>
        {ruleError ? (
          <CocoaCallout tone="danger" title="No se pudo guardar" role="alert">
            {ruleError}
          </CocoaCallout>
        ) : null}
      </CocoaDrawer>

      {/* Devengo manual */}
      <CocoaDrawer
        open={accrueOpen}
        onClose={() => {
          setAccrueOpen(false);
          setAccrueResult(null);
          setAccrueError(null);
        }}
        title="Devengar la comisión de una reserva"
        subtitle="Para reservas de canal que no devengaron solas. La base se toma de la factura o del folio; si falta, se estima y se avisa."
        side="right"
        size="md"
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setAccrueOpen(false)} disabled={accruing}>
              {ACTIONS.close}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void accrue()} loading={accruing} disabled={reservationId.trim() === "" || Boolean(accrueBaseError) || accruing}>
              Devengar y contabilizar
            </CocoaButton>
          </>
        }
      >
        <CocoaFormSection title="Reserva">
          <CocoaFormRow columns={2}>
            <CocoaField label="Identificador de la reserva" required help="El identificador interno de la reserva (no el código público).">
              <CocoaInput value={reservationId} onChange={setReservationId} placeholder="cm…" maxLength={64} autoFocus />
            </CocoaField>
            <CocoaField label="Canal" hint="opcional" help="Si se deja vacío se usa el canal de la reserva.">
              <CocoaInput value={accrueChannel} onChange={setAccrueChannel} placeholder="booking" maxLength={60} />
            </CocoaField>
            <CocoaField label="Base (€)" hint="opcional" error={accrueBaseError} help="Fuerza la base de cálculo en vez de la factura o el folio.">
              <CocoaInput value={accrueBase} onChange={setAccrueBase} type="number" inputMode="decimal" min={0} step="0.01" />
            </CocoaField>
            <CocoaField label="Fecha de devengo" hint="opcional" help="Por defecto, la salida de la reserva.">
              <CocoaInput value={accrueDate} onChange={setAccrueDate} type="date" />
            </CocoaField>
          </CocoaFormRow>
        </CocoaFormSection>
        {accrueError ? (
          <CocoaCallout tone="danger" title="No se pudo devengar" role="alert">
            {accrueError}
          </CocoaCallout>
        ) : null}
        {accrueResult ? (
          <div className="cocoa-stack" data-gap="3">
            <CocoaCallout tone={accrueResult.created ? "success" : "info"} title={accrueResult.created ? "Comisión devengada" : "No se ha creado ningún devengo"} role="status">
              {accrueResult.created && accrueResult.accrual
                ? `${money(accrueResult.accrual.commissionAmount, accrueResult.accrual.currencyCode)} (${fmtPct(accrueResult.accrual.ratePct)} sobre ${money(accrueResult.accrual.baseAmount, accrueResult.accrual.currencyCode)}).`
                : accrueResult.skippedReason ?? "La reserva no cumple las condiciones de ninguna regla."}
              {accrueResult.base ? <span style={captionStyle}>Base {money(String(accrueResult.base.base))} · origen: {accrueResult.base.source}</span> : null}
            </CocoaCallout>
            {accrueBaseWarnings.length > 0 ? (
              <CocoaCallout tone="warning" title="Base estimada">
                <ul className="c22-section__list">
                  {accrueBaseWarnings.map((warning, index) => (
                    <li key={index}>
                      <span>{warning}</span>
                    </li>
                  ))}
                </ul>
              </CocoaCallout>
            ) : null}
          </div>
        ) : null}
      </CocoaDrawer>

      {/* Desactivar regla */}
      <CocoaDialog
        open={pendingDeactivate !== null}
        onClose={() => setPendingDeactivate(null)}
        tone="destructive"
        title={pendingDeactivate ? `¿Desactivar la regla de ${pendingDeactivate.channelCode ?? pendingDeactivate.channelId ?? "este canal"}?` : "Desactivar regla"}
        description="Dejarán de devengarse comisiones para este canal a partir de ahora. Los devengos ya registrados no cambian."
        confirmLabel={ACTIONS.deactivate}
        cancelLabel={ACTIONS.cancel}
        busy={busy}
        onConfirm={deactivate}
      />

      {/* Liquidar devengo */}
      <CocoaDialog
        open={settleTarget !== null}
        onClose={() => setSettleTarget(null)}
        title="Liquidar la comisión"
        description={settleTarget ? `Asiento D 410 Acreedores / H ${bankLedgerCode.trim() || DEFAULT_BANK_ACCOUNT} por ${money(settleTarget.commissionAmount, settleTarget.currencyCode)}. Se contabiliza al confirmar.` : undefined}
        confirmLabel="Liquidar"
        cancelLabel={ACTIONS.cancel}
        busy={busy}
        size="md"
        onConfirm={settle}
      >
        <CocoaFormRow columns={2}>
          <CocoaField label="Fecha de pago">
            <CocoaInput value={paidAt} onChange={setPaidAt} type="date" />
          </CocoaField>
          <CocoaField label="Cuenta de tesorería" help="572 Bancos por defecto; una subcuenta 572x o 570 Caja.">
            <CocoaInput value={bankLedgerCode} onChange={setBankLedgerCode} maxLength={12} />
          </CocoaField>
          <CocoaField label="Referencia" hint="opcional" fullWidth>
            <CocoaInput value={reference} onChange={setReference} placeholder="Número de transferencia o liquidación" maxLength={120} />
          </CocoaField>
        </CocoaFormRow>
      </CocoaDialog>

      {/* Anular devengo */}
      <CocoaDialog
        open={reverseTarget !== null}
        onClose={() => setReverseTarget(null)}
        tone="destructive"
        title="¿Anular el devengo?"
        description={reverseTarget ? `Se contabiliza un asiento de anulación por ${money(reverseTarget.commissionAmount, reverseTarget.currencyCode)}; el devengo original se conserva marcado como anulado.` : undefined}
        confirmLabel="Anular"
        cancelLabel={ACTIONS.cancel}
        busy={busy}
        onConfirm={reverse}
      >
        <CocoaField label="Motivo" hint="opcional">
          <CocoaInput value={reverseReason} onChange={setReverseReason} placeholder="Reserva cancelada, comisión duplicada…" maxLength={240} />
        </CocoaField>
        <span style={secondaryStyle}>El motivo queda en el asiento de anulación.</span>
      </CocoaDialog>
    </CocoaPage>
  );
}

export default CommissionsScreen;

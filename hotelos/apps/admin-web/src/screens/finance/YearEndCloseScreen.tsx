// Cierre de ejercicio — Finanzas › Contabilidad › Cierre de ejercicio
// (/finanzas/contabilidad/cierre-ejercicio, hosted in ContabilidadTabs; the
// legacy /backoffice/finance/year-end-close still redirects here). Cocoa 22 ·
// lote 6-C (migrated from the legacy `.bo-*` screen), archetype «dashboard».
//
// GET /accounting/fiscal-years lists the years; the selected one loads GET
// …/:id/status (open periods, drafts, blocking checks, result preview and the
// regularisation entry preview). Actions, every one behind a CocoaDialog:
// «Crear ejercicio» (POST /accounting/fiscal-years), «Cerrar ejercicio» (POST
// …/:id/close — regularisation 6xx/7xx → 129, closing and opening entries;
// critical, disabled while a blocking check remains) and «Reabrir» (POST
// …/:id/reopen with a reason — marked reversal entries, nothing deleted).
// Typed 4xx go through financeErrorMessage. Legacy amounts arrive as numbers.

import { useMemo, useState } from "react";
import { useApiData } from "../../hooks/useApiData";
import { apiRequest } from "../../services/api-client";
import { financeErrorMessage } from "../../services/finance-contracts";
import { useNavGate } from "../../navigation/useEnabledModules";
import { urlForScreen } from "../../navigation/nav-tree";
import { useToast } from "../../components/Toast";
import { ACTIONS } from "../../content/actions";
import { date, dateTime, money, number, plural } from "../../lib/format";
import { PlusIcon } from "../../components/cocoa-icons/ActionIcons";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { FinanceEntityNote, FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { financeScopePolicy, useFinanceScope } from "../../services/financeScope";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDialog,
  CocoaField,
  CocoaFormRow,
  CocoaGrid,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSkeleton,
  CocoaSpan,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  openTabPath,
  type CocoaTableColumn,
  type CocoaTone
} from "../../components/cocoa";
import { canDo, signTone, withQuery } from "../accounting/accounting-ui";

type FiscalYearStatus = "open" | "closing" | "closed";

type FiscalYear = {
  id: string;
  organizationId: string;
  propertyId?: string;
  code: string;
  startDate: string;
  endDate: string;
  status: FiscalYearStatus;
  closedAt?: string;
  closingEntryId?: string;
  openingEntryId?: string;
  netResult?: number;
};

type RegularizationLine = { accountCode: string; accountName: string; accountType: string; debit: number; credit: number };

type BlockingCheck = { code: string; message: string; severity: "error" | "warn" };

type FiscalYearStatusReport = FiscalYear & {
  openPeriods: number;
  draftJournals: number;
  hasOpenJournals: boolean;
  blockingChecks: BlockingCheck[];
  netResultPreview?: number;
  regularizationLinePreview?: RegularizationLine[];
};

type CloseResult = {
  fiscalYear: FiscalYear;
  regularizationEntryId: string | null;
  closingEntryId: string;
  openingEntryId: string;
  nextFiscalYearId?: string;
  netResult: number;
  followUps: string[];
};

const STATUS_LABEL: Record<FiscalYearStatus, string> = { open: "Abierto", closing: "En cierre", closed: "Cerrado" };
const STATUS_TONE: Record<FiscalYearStatus, CocoaTone> = { open: "success", closing: "warning", closed: "neutral" };

const YEAR_COLUMNS: CocoaTableColumn<FiscalYear>[] = [
  { key: "code", label: "Ejercicio", width: "12ch", render: (year) => <strong>{year.code}</strong> },
  { key: "startDate", label: "Inicio", render: (year) => date(year.startDate, "short"), hideOnNarrow: true },
  { key: "endDate", label: "Fin", render: (year) => date(year.endDate, "short") },
  { key: "status", label: "Estado", render: (year) => <CocoaBadge tone={STATUS_TONE[year.status]}>{STATUS_LABEL[year.status]}</CocoaBadge> },
  { key: "netResult", label: "Resultado", align: "right", render: (year) => (year.netResult !== undefined && year.netResult !== null ? money(year.netResult) : "—") }
];

const PREVIEW_COLUMNS: CocoaTableColumn<RegularizationLine>[] = [
  { key: "accountCode", label: "Cuenta", width: "10ch", render: (line) => <strong>{line.accountCode}</strong> },
  { key: "accountName", label: "Nombre", render: (line) => line.accountName },
  { key: "debit", label: "Debe", align: "right", render: (line) => (line.debit > 0 ? money(line.debit) : "") },
  { key: "credit", label: "Haber", align: "right", render: (line) => (line.credit > 0 ? money(line.credit) : "") }
];

function YearEndSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Grid rows={[[12]]} height={160} />
      <CocoaSkeleton.Strip count={3} />
      <CocoaSkeleton.Grid rows={[[6, 6]]} height={240} />
    </div>
  );
}

export function YearEndCloseScreen() {
  const header = treeHeaderFor("YearEndCloseScreen", { eyebrow: "Finanzas · Contabilidad", title: "Cierre de ejercicio" });
  const { showToast } = useToast();
  // Tanda 6b · L7: fiscal years belong to the sociedad (R4, 400 FISCAL_YEAR_IS_ENTITY_SCOPED): forced scope.
  const finance = useFinanceScope(financeScopePolicy("YearEndCloseScreen"));
  const gate = useNavGate();
  const canPost = canDo(gate, "accounting.journal.post");

  const years = useApiData<FiscalYear[]>("/accounting/fiscal-years", { pollIntervalMs: 60_000 });
  const yearRows = useMemo(() => [...(years.data ?? [])].sort((a, b) => b.startDate.localeCompare(a.startDate)), [years.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const effectiveId = selectedId ?? yearRows.find((year) => year.status !== "closed")?.id ?? yearRows[0]?.id ?? null;
  const status = useApiData<FiscalYearStatusReport>(effectiveId ? `/accounting/fiscal-years/${effectiveId}/status` : null, { pollIntervalMs: 60_000 });
  const selected = status.data && status.data.id === effectiveId ? status.data : null;

  // ---- create ---------------------------------------------------------------------
  const currentYear = new Date().getFullYear();
  const [createOpen, setCreateOpen] = useState(false);
  const [newCode, setNewCode] = useState(String(currentYear));
  const [newStart, setNewStart] = useState(`${currentYear}-01-01`);
  const [newEnd, setNewEnd] = useState(`${currentYear}-12-31`);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const createValid = newCode.trim() !== "" && /^\d{4}-\d{2}-\d{2}$/.test(newStart) && /^\d{4}-\d{2}-\d{2}$/.test(newEnd) && newStart <= newEnd;

  async function createYear() {
    if (!createValid) return;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await apiRequest<FiscalYear>("/accounting/fiscal-years", { method: "POST", body: { code: newCode.trim(), startDate: newStart, endDate: newEnd } });
      setCreateOpen(false);
      years.refresh();
      setSelectedId(created.id);
      showToast(`Ejercicio ${created.code} creado.`, { variant: "success" });
    } catch (err) {
      setCreateError(err);
    } finally {
      setCreating(false);
    }
  }

  // ---- close ------------------------------------------------------------------------
  const [confirmClose, setConfirmClose] = useState(false);
  const [createNextYear, setCreateNextYear] = useState(true);
  const [closing, setClosing] = useState(false);
  const [closeError, setCloseError] = useState<unknown>(null);
  const [closeResult, setCloseResult] = useState<CloseResult | null>(null);

  async function closeYear() {
    if (!effectiveId) return;
    setClosing(true);
    setCloseError(null);
    try {
      const result = await apiRequest<CloseResult>(`/accounting/fiscal-years/${effectiveId}/close`, { method: "POST", body: createNextYear ? { createNextYear: true } : {} });
      setCloseResult(result);
      setConfirmClose(false);
      years.refresh();
      status.refresh();
      showToast(`Ejercicio ${result.fiscalYear.code} cerrado con resultado ${money(result.netResult)}.`, { variant: "success" });
    } catch (err) {
      setCloseError(err);
    } finally {
      setClosing(false);
    }
  }

  // ---- reopen -----------------------------------------------------------------------
  const [reopenOpen, setReopenOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [reopening, setReopening] = useState(false);
  const [reopenError, setReopenError] = useState<unknown>(null);

  async function reopenYear() {
    if (!effectiveId) return;
    if (reopenReason.trim() === "") {
      setReopenError(new Error("Indica el motivo de la reapertura."));
      return;
    }
    setReopening(true);
    setReopenError(null);
    try {
      await apiRequest(`/accounting/fiscal-years/${effectiveId}/reopen`, { method: "POST", body: { reason: reopenReason.trim() } });
      setReopenOpen(false);
      setReopenReason("");
      setCloseResult(null);
      years.refresh();
      status.refresh();
      showToast("Ejercicio reabierto: los asientos de cierre y apertura quedan anulados con su reverso.", { variant: "success" });
    } catch (err) {
      setReopenError(err);
    } finally {
      setReopening(false);
    }
  }

  const blocking = selected ? selected.blockingChecks.filter((check) => check.severity === "error") : [];
  const resultValue = selected ? (selected.status === "closed" ? selected.netResult : selected.netResultPreview) : undefined;
  const canClose = !!selected && selected.status === "open" && blocking.length === 0 && canPost;
  const journalUrl = urlForScreen("JournalScreen");
  const preview = selected?.regularizationLinePreview ?? [];
  const previewDebit = preview.reduce((sum, line) => sum + line.debit, 0);
  const previewCredit = preview.reduce((sum, line) => sum + line.credit, 0);

  const pageState = years.loading && !years.data ? "loading" : years.error && !years.data ? "error" : "ready";

  return (
    <CocoaPage
      eyebrow={finance.eyebrow("Finanzas")}
      title={header.title}
      subtitle="Cierre según el PGC: asiento de regularización (6xx y 7xx contra 129), asiento de cierre al último día y asiento de apertura al primer día del ejercicio siguiente. Nada se borra: reabrir genera reversos."
      actions={
        <>
          <FinanceScopeSelector scope={finance} />
          {canPost ? (
            <CocoaButton variant="filled" tone="accent" size="small" icon={<PlusIcon size={14} aria-hidden="true" />} onClick={() => setCreateOpen(true)}>
              Crear ejercicio
            </CocoaButton>
          ) : null}
        </>
      }
      state={pageState}
      skeleton={<YearEndSkeleton />}
      error={{ title: "No se pudieron cargar los ejercicios", message: years.error ?? undefined, onRetry: years.refresh }}
      commands={[
        ...(canPost ? [{ id: "year-end-create", label: "Crear ejercicio fiscal", run: () => setCreateOpen(true) }] : []),
        {
          id: "year-end-refresh",
          label: "Actualizar los ejercicios",
          run: () => {
            years.refresh();
            status.refresh();
          }
        }
      ]}
      id="year-end-close-screen"
    >
      <FinanceEntityNote scope={finance} subject="El ejercicio contable y su cierre" />
      <CocoaSection title="Ejercicios fiscales" meta={yearRows.length > 0 ? plural(yearRows.length, "ejercicio", "ejercicios") : undefined} padding={yearRows.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
        {yearRows.length === 0 ? (
          <CocoaState
            kind="empty"
            illustration="box"
            title="Aún no hay ejercicios fiscales"
            message="Sin ejercicio, los asientos se numeran por año natural y no se puede cerrar ni regularizar. Crea el primero con su código y sus fechas."
            primaryAction={canPost ? { label: "Crear ejercicio", onClick: () => setCreateOpen(true) } : undefined}
          />
        ) : (
          <CocoaTable columns={YEAR_COLUMNS} rows={yearRows} rowKey="id" selectedKey={effectiveId ?? undefined} onSelect={(year) => setSelectedId(year.id)} rowTitle={() => "Ver el estado del ejercicio"} caption="Ejercicios fiscales" aria-label="Ejercicios fiscales" />
        )}
      </CocoaSection>

      {effectiveId && status.loading && !selected ? <CocoaSkeleton.Strip count={3} label="Cargando el estado del ejercicio…" /> : null}
      {effectiveId && status.error && !selected ? <CocoaState kind="error" title="No se pudo cargar el estado del ejercicio" message={status.error} onRetry={status.refresh} /> : null}

      {selected ? (
        <>
          <CocoaKpiStrip stagger aria-label={`Estado del ejercicio ${selected.code}`}>
            <CocoaKpi label="Estado" value={STATUS_LABEL[selected.status]} deltaLabel={`${date(selected.startDate, "short")} – ${date(selected.endDate, "short")}`} polarity="neutral" status={selected.status === "closed" ? "ok" : selected.status === "closing" ? "warning" : undefined} />
            <CocoaKpi label="Periodos abiertos" value={number(selected.openPeriods)} deltaLabel={selected.openPeriods === 0 ? "todos cerrados" : "bloquea el cierre"} polarity="negative-good" status={selected.openPeriods === 0 ? "ok" : "warning"} />
            <CocoaKpi label="Asientos en borrador" value={number(selected.draftJournals)} deltaLabel={selected.draftJournals === 0 ? "sin pendientes" : "bloquea el cierre"} polarity="negative-good" status={selected.draftJournals === 0 ? "ok" : "warning"} />
            <CocoaKpi label={selected.status === "closed" ? "Resultado del ejercicio" : "Resultado previsto"} value={money(resultValue)} deltaLabel={resultValue === undefined || resultValue === null ? "sin ingresos ni gastos" : resultValue < 0 ? "pérdida" : "beneficio"} polarity="neutral" tone={signTone(resultValue)} />
          </CocoaKpiStrip>

          <CocoaGrid align="start" aria-label="Comprobaciones y regularización">
            <CocoaSpan cols={5} min={320}>
              <CocoaSection title="Comprobaciones" meta={selected.blockingChecks.length > 0 ? `${number(blocking.length)} bloqueantes` : "sin incidencias"}>
                {selected.blockingChecks.length === 0 ? (
                  <CocoaState kind="empty" inline title="Ninguna comprobación pendiente: el ejercicio puede cerrarse." />
                ) : (
                  <ul className="c22-section__list">
                    {selected.blockingChecks.map((check) => (
                      <li key={check.code}>
                        <span>{check.message}</span>
                        <CocoaBadge tone={check.severity === "error" ? "danger" : "warning"}>{check.severity === "error" ? "Bloqueante" : "Aviso"}</CocoaBadge>
                      </li>
                    ))}
                  </ul>
                )}
                {selected.status === "closed" ? (
                  <CocoaCallout
                    tone="success"
                    title={`Cerrado ${selected.closedAt ? dateTime(selected.closedAt) : ""}`}
                    role="status"
                    actions={
                      journalUrl && selected.closingEntryId ? (
                        <CocoaButton variant="plain" size="small" onClick={() => openTabPath(withQuery(journalUrl, { asiento: selected.closingEntryId }))}>
                          Ver asiento de cierre
                        </CocoaButton>
                      ) : undefined
                    }
                  >
                    Resultado {money(selected.netResult)}. El asiento de apertura del ejercicio siguiente replica los saldos patrimoniales.
                  </CocoaCallout>
                ) : null}
                <div className="cocoa-row" data-gap="2" data-justify="end">
                  {selected.status === "closed" && canPost ? (
                    <CocoaButton variant="bordered" tone="destructive" size="small" onClick={() => setReopenOpen(true)}>
                      {ACTIONS.reopen}
                    </CocoaButton>
                  ) : null}
                  {selected.status !== "closed" ? (
                    <CocoaButton variant="filled" tone="accent" size="small" disabled={!canClose} title={canClose ? undefined : "Resuelve las comprobaciones bloqueantes antes de cerrar."} onClick={() => setConfirmClose(true)}>
                      Cerrar ejercicio {selected.code}
                    </CocoaButton>
                  ) : null}
                </div>
              </CocoaSection>
            </CocoaSpan>
            <CocoaSpan cols={7} min={320}>
              <CocoaSection title="Vista previa de la regularización" meta={preview.length > 0 ? plural(preview.length, "línea", "líneas") : undefined} padding={preview.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
                {preview.length > 0 ? (
                  <CocoaTable columns={PREVIEW_COLUMNS} rows={preview} rowKey="accountCode" density="compact" footer={{ accountName: "Totales", debit: money(previewDebit), credit: money(previewCredit) }} caption="Asiento de regularización previsto" aria-label="Asiento de regularización previsto" />
                ) : (
                  <CocoaState kind="empty" inline title={selected.status === "closed" ? "El ejercicio ya está regularizado." : "Sin ingresos ni gastos que regularizar en el ejercicio."} />
                )}
              </CocoaSection>
            </CocoaSpan>
          </CocoaGrid>

          {closeResult ? (
            <CocoaCallout
              tone="success"
              title={`Cierre completado · resultado ${money(closeResult.netResult)}`}
              role="status"
              actions={
                journalUrl ? (
                  <CocoaButton variant="plain" size="small" onClick={() => openTabPath(withQuery(journalUrl, { asiento: closeResult.closingEntryId }))}>
                    Ver asiento de cierre
                  </CocoaButton>
                ) : undefined
              }
            >
              <ul className="c22-section__list">
                <li>
                  <span>Regularización</span>
                  <strong>{closeResult.regularizationEntryId ?? "sin ingresos ni gastos"}</strong>
                </li>
                <li>
                  <span>Cierre</span>
                  <strong>{closeResult.closingEntryId}</strong>
                </li>
                <li>
                  <span>Apertura</span>
                  <strong>{closeResult.openingEntryId}</strong>
                </li>
                {closeResult.followUps.map((followUp) => (
                  <li key={followUp}>
                    <span>{followUp}</span>
                    <CocoaBadge tone="warning">Pendiente</CocoaBadge>
                  </li>
                ))}
              </ul>
            </CocoaCallout>
          ) : null}
        </>
      ) : null}

      {/* ---- Create -------------------------------------------------------- */}
      <CocoaDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Nuevo ejercicio fiscal"
        description="El código nombra el ejercicio (normalmente el año); los asientos fechados entre el inicio y el fin se numeran en él."
        confirmLabel={ACTIONS.create}
        cancelLabel={ACTIONS.cancel}
        busy={creating}
        onConfirm={createYear}
        size="md"
      >
        <div className="cocoa-stack" data-gap="3">
          <CocoaFormRow columns={3} min={120}>
            <CocoaField label="Código" required>
              <CocoaInput value={newCode} onChange={setNewCode} placeholder={String(currentYear)} maxLength={40} />
            </CocoaField>
            <CocoaField label="Inicio" required>
              <CocoaDatePicker value={newStart} onChange={setNewStart} />
            </CocoaField>
            <CocoaField label="Fin" required error={newStart > newEnd ? "El fin no puede ser anterior al inicio." : undefined}>
              <CocoaDatePicker value={newEnd} onChange={setNewEnd} />
            </CocoaField>
          </CocoaFormRow>
          {createError ? (
            <CocoaCallout tone="danger" title="No se pudo crear el ejercicio" role="alert">
              {financeErrorMessage(createError)}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaDialog>

      {/* ---- Close (critical) -------------------------------------------------- */}
      <CocoaDialog
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        tone="destructive"
        title={selected ? `¿Cerrar el ejercicio ${selected.code}?` : "¿Cerrar el ejercicio?"}
        description={`Operación crítica: se contabilizan el asiento de regularización (resultado previsto ${money(selected?.netResultPreview)}), el de cierre a ${selected ? date(selected.endDate, "long") : "la fecha de fin"} y el de apertura del ejercicio siguiente. Después, ningún asiento admite fechas dentro del ejercicio salvo que lo reabras.`}
        confirmLabel="Confirmar cierre"
        cancelLabel={ACTIONS.cancel}
        busy={closing}
        onConfirm={closeYear}
        size="md"
      >
        <div className="cocoa-stack" data-gap="3">
          <CocoaField label="Crear el ejercicio siguiente si no existe" inline help="La apertura necesita un ejercicio destino.">
            <CocoaSwitch checked={createNextYear} onChange={setCreateNextYear} size="small" />
          </CocoaField>
          <p className="cocoa-caption">El traspaso del resultado a reservas (113 / 1130) se hace después con un asiento manual en el diario.</p>
          {closeError ? (
            <CocoaCallout tone="danger" title="No se pudo cerrar" role="alert">
              {financeErrorMessage(closeError)}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaDialog>

      {/* ---- Reopen -------------------------------------------------------- */}
      <CocoaDialog
        open={reopenOpen}
        onClose={() => setReopenOpen(false)}
        tone="destructive"
        title={selected ? `¿Reabrir el ejercicio ${selected.code}?` : "¿Reabrir el ejercicio?"}
        description="Los asientos de regularización, cierre y apertura se anulan con reversos marcados (nunca se borran) y el ejercicio vuelve a admitir asientos."
        confirmLabel={ACTIONS.reopen}
        cancelLabel={ACTIONS.cancel}
        busy={reopening}
        onConfirm={reopenYear}
        size="md"
      >
        <div className="cocoa-stack" data-gap="3">
          <CocoaField label="Motivo" required error={reopenError && reopenReason.trim() === "" ? "Indica el motivo de la reapertura." : undefined}>
            <CocoaInput value={reopenReason} onChange={setReopenReason} multiline rows={3} placeholder="Factura de diciembre recibida tras el cierre…" maxLength={1000} />
          </CocoaField>
          {reopenError && reopenReason.trim() !== "" ? (
            <CocoaCallout tone="danger" title="No se pudo reabrir" role="alert">
              {financeErrorMessage(reopenError)}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaDialog>
    </CocoaPage>
  );
}

export default YearEndCloseScreen;

// Liquidación de IVA — /cumplimiento/modelos-aeat/liquidacion-iva (Tanda 6 ·
// Cumplimiento; Cocoa 22 · ola 8 · lote 8-B, plantilla Formulario + rejilla
// 8/4, hosted in ModelosAeatTabs).
//
// Preview of the settlement entry of a period (GET /fiscal/vat-settlement?
// period=): result to_pay / to_offset / zero, compensation carried, balanced
// lines D 477.x / H 472.x / H 4750 or D 4700 and the embedded Modelo 303
// (summary boxes and the ledger cross-check with its differences). The
// «Contabilizar» primary (POST /fiscal/vat-settlement, accounting.journal.post,
// critical) and the «Anular» secondary (POST /fiscal/vat-settlement/reverse,
// reason kept in the reversal) both go through a CocoaDialog; the API's
// 409s (PERIOD_NOT_ENDED · ALREADY_SETTLED · NOTHING_TO_SETTLE ·
// FISCAL_YEAR_CLOSED …) are mapped by fiscalErrorText and the fiscal-year one
// offers the year-end screen. The period follows the VAT periodicity of the
// organisation (GET /fiscal/vat-settings).

import { useMemo, useRef, useState } from "react";
import type { FiscalBox, VatSettlementLineDto, VatSettlementPreview } from "@hotelos/shared";
import { useToast } from "../../components/Toast";
import { ACTIONS, UI_STATES } from "../../content/actions";
import { date, isoDate, money, number, plural } from "../../lib/format";
import { urlForScreen } from "../../navigation/nav-tree";
import { getActiveProperty } from "../../services/activeProperty";
import { FINANCE_ERROR_MESSAGES } from "../../services/finance-contracts";
import { getVatSettings, postVatSettlement, previewVatSettlement, reverseVatSettlement } from "../../services/fiscalApi";
import { useTabHost } from "../tabs/TabHost";
import {
  CocoaActionBar,
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDialog,
  CocoaField,
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
  openTabPath,
  type CocoaTableColumn
} from "../../components/cocoa";
import { LedgerCrossCheckView } from "./FiscalModelReport";
import { ReportErrorCard } from "./ReportErrorCard";
import { MONTH_OPTIONS, QUARTER_OPTIONS, currentMonth, currentQuarter, describePeriod, fiscalErrorText, isFiscalYearClosed, periodCodeOf, periodHasEnded, settlementEntryLabel, yearOptions } from "./fiscal-shared";
import { useFiscalResource } from "./useFiscalResource";

type KeyedLine = VatSettlementLineDto & { rowId: string };

/** Keys (`clave`) of the 303 boxes summarised next to the entry, in form order. */
export const SUMMARY_BOX_KEYS: readonly string[] = ["DEV_TOTAL_CUOTA", "DED_TOTAL", "RESULTADO_REGIMEN_GENERAL", "COMPENSACION_PENDIENTE_INICIAL", "COMPENSACION_APLICADA", "COMPENSACION_PENDIENTE_POSTERIOR", "RESULTADO_LIQUIDACION"];

export const RESULT_LABELS: Readonly<Record<VatSettlementPreview["resultado"], string>> = Object.freeze({
  to_pay: "A ingresar (H 4750)",
  to_offset: "A compensar (D 4700)",
  zero: "Sin cuotas que liquidar"
});

const AVISOS_PREVIEW = 6;

const LINE_COLUMNS: CocoaTableColumn<KeyedLine>[] = [
  { key: "accountCode", label: "Cuenta", width: "10ch", render: (line) => <strong>{line.accountCode}</strong> },
  { key: "description", label: "Concepto" },
  { key: "taxRateCode", label: "Tipo", align: "right", width: "8ch", hideOnNarrow: true, render: (line) => (line.taxRateCode ? `${line.taxRateCode} %` : "—") },
  { key: "taxBase", label: "Base", align: "right", hideOnNarrow: true, render: (line) => (line.taxBase === null ? "—" : money(line.taxBase)) },
  { key: "debit", label: "Debe", align: "right", render: (line) => (line.debit === 0 ? "—" : money(line.debit)) },
  { key: "credit", label: "Haber", align: "right", render: (line) => (line.credit === 0 ? "—" : money(line.credit)) }
];

/** State of the period for the KPI strip and the action bar (pure). */
export function settlementStatus(preview: Pick<VatSettlementPreview, "existing" | "resultado" | "lines" | "balanced" | "periodo">, today: string): { label: string; tone: "success" | "info" | "neutral" | "warning" | "danger"; canPost: boolean; reason: string } {
  if (preview.existing) return { label: "Liquidado", tone: "success", canPost: false, reason: `Liquidado: ${settlementEntryLabel(preview.existing)}.` };
  if (!periodHasEnded(preview.periodo, today)) return { label: "Periodo en curso", tone: "info", canPost: false, reason: `El periodo termina el ${date(preview.periodo.to, "short")}: la liquidación se contabiliza al cierre.` };
  if (preview.resultado === "zero" || preview.lines.length === 0) return { label: "Sin cuotas", tone: "neutral", canPost: false, reason: "Sin cuotas de IVA en el periodo: nada que liquidar." };
  if (!preview.balanced) return { label: "No cuadra", tone: "danger", canPost: false, reason: "La vista previa no cuadra: revisa los avisos antes de contabilizar." };
  return { label: "Pendiente de contabilizar", tone: "warning", canPost: true, reason: "Vista previa cuadrada: la liquidación se puede contabilizar." };
}

/** Distinct warnings of the preview and of its embedded 303, in order. */
export function mergeAvisos(preview: Pick<VatSettlementPreview, "avisos" | "modelo303">): string[] {
  return [...new Set([...preview.avisos, ...preview.modelo303.avisos])];
}

function SettlementSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={5} />
      <CocoaSkeleton.Grid rows={[[8, 4]]} />
    </div>
  );
}

export function VatSettlementScreen() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const property = getActiveProperty();
  const today = isoDate(new Date()) ?? "";

  const settings = useFiscalResource("vat-settings", getVatSettings);
  const periodicity = settings.data?.periodicity ?? "quarterly";
  const settingsPending = settings.data === null && settings.error === null;

  const years = useMemo(() => yearOptions(), []);
  const [year, setYear] = useState(() => years[0]?.value ?? String(new Date().getUTCFullYear()));
  const [quarter, setQuarter] = useState(() => currentQuarter());
  const [month, setMonth] = useState(() => currentMonth());
  const period = periodCodeOf({ kind: periodicity, year, quarter, month });

  const resource = useFiscalResource<VatSettlementPreview>(settingsPending ? null : `settlement|${period}`, () => previewVatSettlement(period));
  const preview = resource.data;
  const errorText = resource.error ? fiscalErrorText(resource.error, "No hemos podido cargar la vista previa de la liquidación.") : null;

  const [askPost, setAskPost] = useState(false);
  const [askReverse, setAskReverse] = useState(false);
  const [entryDate, setEntryDate] = useState("");
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [yearClosed, setYearClosed] = useState(false);
  const [allAvisos, setAllAvisos] = useState(false);
  const dateRef = useRef<HTMLDivElement | null>(null);

  const status = preview ? settlementStatus(preview, today) : null;
  const lines = useMemo<KeyedLine[]>(() => (preview?.lines ?? []).map((line, index) => ({ ...line, rowId: `${line.accountCode}-${index}` })), [preview]);
  const avisos = useMemo(() => (preview ? mergeAvisos(preview) : []), [preview]);
  const summaryBoxes = useMemo<FiscalBox[]>(() => {
    const byKey = new Map((preview?.modelo303.casillas ?? []).map((box) => [box.clave, box] as const));
    return SUMMARY_BOX_KEYS.map((clave) => byKey.get(clave)).filter((box): box is FiscalBox => Boolean(box));
  }, [preview]);
  const diario = preview?.modelo303.fuentes.diario;
  const modelo303Url = urlForScreen("Modelo303Screen");
  const yearEndUrl = urlForScreen("YearEndCloseScreen");

  function openPost() {
    if (!preview) return;
    setEntryDate(preview.periodo.to);
    setAskPost(true);
  }

  async function post() {
    if (!preview || busy) return;
    setBusy(true);
    try {
      const result = await postVatSettlement({ period: preview.periodo.code, entryDate: entryDate || undefined });
      showToast(`Liquidación de ${preview.periodo.code} contabilizada: ${settlementEntryLabel(result)}.`, { variant: "success", duration: 8000 });
      setAskPost(false);
      setYearClosed(false);
      resource.refresh();
    } catch (err) {
      if (isFiscalYearClosed(err)) setYearClosed(true);
      showToast(fiscalErrorText(err, "No se pudo contabilizar la liquidación."), { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function reverse() {
    if (!preview || busy) return;
    const trimmed = reason.trim();
    if (trimmed.length < 3) {
      setReasonError("Indica el motivo de la anulación (quedará en el concepto del asiento).");
      return;
    }
    setBusy(true);
    try {
      const result = await reverseVatSettlement({ period: preview.periodo.code, reason: trimmed });
      showToast(`Liquidación de ${preview.periodo.code} anulada: ${settlementEntryLabel({ entryNumber: result.entryNumber, journalEntryId: result.reversalJournalEntryId, entryDate: result.entryDate })}.`, { variant: "success", duration: 8000 });
      setAskReverse(false);
      setReason("");
      setReasonError(undefined);
      setYearClosed(false);
      resource.refresh();
    } catch (err) {
      if (isFiscalYearClosed(err)) setYearClosed(true);
      showToast(fiscalErrorText(err, "No se pudo anular la liquidación."), { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const actions = (
    <>
      {status ? (
        <CocoaBadge tone={status.tone} variant="dot">
          {status.label}
        </CocoaBadge>
      ) : null}
      {periodicity === "monthly" ? <CocoaSelect size="small" aria-label="Mes" value={month} onChange={setMonth} options={[...MONTH_OPTIONS]} /> : <CocoaSelect size="small" aria-label="Trimestre" value={quarter} onChange={setQuarter} options={[...QUARTER_OPTIONS]} />}
      <CocoaSelect size="small" aria-label="Ejercicio" value={year} onChange={setYear} options={years} />
      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={resource.refresh} loading={resource.refreshing && !resource.loading} disabled={resource.loading}>
        {ACTIONS.refresh}
      </CocoaButton>
    </>
  );

  return (
    <CocoaPage
      eyebrow={`Cumplimiento · ${preview?.modelo303.declarante.nombre ?? property.propertyName}`}
      title="Liquidación de IVA"
      subtitle={hosted ? undefined : "Vista previa del asiento de liquidación del periodo (D 477 / H 472 / H 4750 o D 4700), contabilización y anulación."}
      actions={actions}
      state={resource.loading || settingsPending ? "loading" : "ready"}
      skeleton={<SettlementSkeleton />}
      commands={[
        { id: "liquidacion-iva-refresh", label: "Actualizar la liquidación de IVA", run: resource.refresh },
        { id: "liquidacion-iva-post", label: "Contabilizar la liquidación de IVA", run: openPost }
      ]}
    >
      {!preview ? (
        errorText ? <ReportErrorCard message={errorText} onRetry={resource.refresh} /> : null
      ) : (
        <>
          {errorText ? (
            <CocoaCallout
              tone="danger"
              title={UI_STATES.error.title}
              role="alert"
              actions={
                <CocoaButton variant="bordered" tone="neutral" size="small" onClick={resource.refresh}>
                  {ACTIONS.retry}
                </CocoaButton>
              }
            >
              {errorText} Se muestra la última vista previa cargada.
            </CocoaCallout>
          ) : null}
          {yearClosed ? (
            <CocoaCallout
              tone="danger"
              title="Ejercicio cerrado"
              role="alert"
              actions={
                yearEndUrl ? (
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => openTabPath(yearEndUrl)}>
                    Abrir Cierre de ejercicio
                  </CocoaButton>
                ) : undefined
              }
            >
              {FINANCE_ERROR_MESSAGES.FISCAL_YEAR_CLOSED}
            </CocoaCallout>
          ) : null}

          <CocoaKpiStrip stagger aria-label={`Liquidación de ${preview.periodo.code}`}>
            <CocoaKpi label="Resultado" value={money(preview.importe)} polarity="neutral" deltaLabel={RESULT_LABELS[preview.resultado]} status={preview.resultado === "to_pay" ? "warning" : "ok"} />
            <CocoaKpi label="Cuota devengada" value={money(preview.modelo303.totales.cuotaDevengada ?? 0)} polarity="neutral" deltaLabel="casilla 27" />
            <CocoaKpi label="Cuota deducible" value={money(preview.modelo303.totales.cuotaDeducible ?? 0)} polarity="neutral" deltaLabel="casilla 45" />
            <CocoaKpi label="Compensación aplicada" value={money(preview.compensacionAplicada)} polarity="neutral" deltaLabel={`pendiente inicial ${money(preview.compensacionPendienteInicial)}`} />
            <CocoaKpi label="Compensación pendiente" value={money(preview.compensacionPendienteFinal)} polarity="neutral" deltaLabel="para periodos posteriores" />
            {diario ? <CocoaKpi label="Cotejo con el diario" value={diario.cuadra ? "Cuadra" : "No cuadra"} status={diario.cuadra ? "ok" : "critical"} polarity="neutral" deltaLabel={plural(diario.apuntes, "apunte", "apuntes")} /> : null}
          </CocoaKpiStrip>

          <CocoaGrid align="start" aria-label="Asiento, casillas y cotejo">
            <CocoaSpan cols={8} min={480}>
              <CocoaSection
                title="Asiento de liquidación"
                meta={describePeriod(preview.periodo)}
                padding={lines.length > 0 ? "none" : "md"}
                style={{ overflow: "clip" }}
                footer={
                  lines.length > 0 ? (
                    <div className="cocoa-row" data-gap="2" data-justify="between">
                      <span>
                        Debe {money(preview.totalDebit)} · Haber {money(preview.totalCredit)}
                      </span>
                      <CocoaBadge tone={preview.balanced ? "success" : "danger"} variant="dot">
                        {preview.balanced ? "Cuadrado" : "Descuadrado"}
                      </CocoaBadge>
                    </div>
                  ) : undefined
                }
              >
                {lines.length > 0 ? (
                  <CocoaTable columns={LINE_COLUMNS} rows={lines} rowKey="rowId" density="compact" footer={{ description: <strong>Total</strong>, debit: <strong>{money(preview.totalDebit)}</strong>, credit: <strong>{money(preview.totalCredit)}</strong> }} caption={`Asiento de liquidación del IVA de ${preview.periodo.code}`} aria-label={`Asiento de liquidación del IVA de ${preview.periodo.code}`} />
                ) : (
                  <CocoaState kind="empty" title="Sin cuotas de IVA en el periodo" message="No hay IVA repercutido ni soportado que liquidar: el asiento no se genera." />
                )}
              </CocoaSection>
            </CocoaSpan>

            <CocoaSpan cols={4} min={320}>
              <div className="cocoa-stack" data-gap="3">
                <CocoaSection
                  title="Casillas del Modelo 303"
                  action={
                    modelo303Url ? (
                      <CocoaButton variant="plain" size="small" onClick={() => openTabPath(modelo303Url)}>
                        Ver el modelo completo
                      </CocoaButton>
                    ) : undefined
                  }
                >
                  {summaryBoxes.length > 0 ? (
                    <ul className="c22-section__list" aria-label="Casillas resumidas del Modelo 303">
                      {summaryBoxes.map((box) => (
                        <li key={box.clave}>
                          <span>
                            <CocoaBadge tone="neutral" variant="outline">
                              {box.casilla ?? "—"}
                            </CocoaBadge>{" "}
                            {box.descripcion}
                          </span>
                          <span>{box.tipo === "resultado" ? <strong>{money(box.importe)}</strong> : money(box.importe)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <CocoaState kind="empty" inline title="El modelo no devolvió casillas para este periodo." />
                  )}
                </CocoaSection>

                <CocoaSection title="Cotejo del diario con los libros">
                  {diario ? <LedgerCrossCheckView diario={diario} /> : <CocoaState kind="empty" inline title="El modelo no incluye cotejo con el diario para este periodo." />}
                </CocoaSection>
              </div>
            </CocoaSpan>
          </CocoaGrid>

          <CocoaSection
            title="Avisos"
            meta={plural(avisos.length, "aviso", "avisos")}
            action={
              avisos.length > AVISOS_PREVIEW ? (
                <CocoaButton variant="plain" size="small" onClick={() => setAllAvisos((value) => !value)} aria-expanded={allAvisos}>
                  {allAvisos ? "Mostrar menos" : `Mostrar los ${number(avisos.length, { maximumFractionDigits: 0 })} avisos`}
                </CocoaButton>
              ) : undefined
            }
          >
            {avisos.length === 0 ? (
              <CocoaState kind="empty" inline title="Sin avisos en la vista previa ni en el Modelo 303." />
            ) : (
              <ul className="c22-section__list">
                {(allAvisos ? avisos : avisos.slice(0, AVISOS_PREVIEW)).map((aviso, index) => (
                  <li key={`${index}-${aviso.slice(0, 24)}`}>
                    <span>{aviso}</span>
                  </li>
                ))}
              </ul>
            )}
          </CocoaSection>

          <CocoaActionBar
            aria-label="Acciones de la liquidación"
            status={status?.reason}
            secondary={
              preview.existing
                ? { label: "Anular la liquidación", variant: "bordered", tone: "destructive", disabled: busy, onClick: () => setAskReverse(true) }
                : modelo303Url
                  ? { label: "Ver el Modelo 303", variant: "bordered", tone: "neutral", onClick: () => openTabPath(modelo303Url) }
                  : undefined
            }
            primary={{ label: "Contabilizar la liquidación", disabled: !status?.canPost || busy, loading: busy && askPost, onClick: openPost }}
            publishToastOffset
          />

          <CocoaDialog
            open={askPost}
            onClose={() => setAskPost(false)}
            title={`¿Contabilizar la liquidación de ${preview.periodo.code}?`}
            description={`Se asienta ${plural(lines.length, "línea", "líneas")} por ${money(preview.importe)} (${RESULT_LABELS[preview.resultado].toLowerCase()}). El asiento es definitivo: solo se corrige con un asiento de anulación.`}
            confirmLabel="Contabilizar"
            busy={busy}
            onConfirm={post}
            initialFocus={() => dateRef.current?.querySelector("input")}
          >
            <div ref={dateRef}>
              <CocoaField label="Fecha del asiento" help={`Por defecto, el último día del periodo (${date(preview.periodo.to, "short")}). Debe caer en un ejercicio y un periodo contable abiertos.`}>
                <CocoaDatePicker value={entryDate} onChange={setEntryDate} min={preview.periodo.from} />
              </CocoaField>
            </div>
          </CocoaDialog>

          <CocoaDialog
            open={askReverse}
            onClose={() => {
              setAskReverse(false);
              setReasonError(undefined);
            }}
            tone="destructive"
            title={`¿Anular la liquidación de ${preview.periodo.code}?`}
            description={preview.existing ? `Se contabiliza un asiento de anulación de «${settlementEntryLabel(preview.existing)}» con los importes en sentido contrario. El asiento original se conserva marcado como anulado.` : undefined}
            confirmLabel="Anular la liquidación"
            busy={busy}
            confirmDisabled={reason.trim().length < 3}
            onConfirm={reverse}
          >
            <CocoaField label="Motivo" required error={reasonError} help="Se guarda en el concepto del asiento de anulación.">
              <CocoaInput value={reason} onChange={(value) => { setReason(value); if (reasonError) setReasonError(undefined); }} multiline rows={3} maxLength={500} placeholder="Por ejemplo: rectificativa recibida tras la liquidación." />
            </CocoaField>
          </CocoaDialog>
        </>
      )}
    </CocoaPage>
  );
}

export default VatSettlementScreen;

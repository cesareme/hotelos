// Cumplimiento › Modelos AEAT — ONE screen body for the six models (303 · 390
// · 347 · 111 · 115 · 180), Cocoa 22 · ola 8 · lote 8-B (plantilla
// DashboardAlojado: hosted in ModelosAeatTabs, standalone on its legacy URL).
//
// Contract: FiscalModelReport (packages/shared/src/fiscal-types.ts) read with
// services/fiscalApi.ts getFiscalModel(modelo, { period | year, propertyId })
// and the «Descargar resumen» PDF with downloadFiscalModelPdf. The page paints
// the headline totals as KPIs, every `casilla` grouped by form section
// (`casilla: null` → «sin casilla (validar)»), the whole `totales` table, the
// `fuentes` (origin of the figures, book totals, ledger cross-check with its
// differences, settlement entry), the `detalle[]` rows and the `avisos`, and
// says in a callout that filing is manual (`presentacion.modo = manual`). The
// pickers (year · quarter or month · desglose) live in the actions row so they
// stay usable while an error is on screen, sized to their widest option
// (`inline`, fix:L7 qa#6: a full-width select stacks the row); the 303
// follows the VAT periodicity of the sociedad (GET /fiscal/vat-settings).
//
// Tanda 6b · L7 (design §5.3): the models are FORCED to the sociedad — the
// «Ámbito» selector (services/financeScope.ts, entity_forced) paints the
// sociedad disabled; the badge «Declarante: <razón social> · <NIF>» comes from
// `report.sociedad`; a centre can still be picked as «Desglose por centro»
// (informative partial view, «no liquidable»); `presentacion.noSePresenta` and
// the SII / gran empresa regime paint a warning callout.
//
// FIX-1 · F3: the 303 opens on the last period with materialised books (GET
// /fiscal/vat-books/periods → `initialPeriodPicker`, E-04); a quarterly
// sociedad can read one month of the quarter as an INFORMATIVE view («Mes
// (vista informativa)» → `informativo=1`, callout, E-02); a centre breakdown
// over a Sage period (rows without centre) paints the `SAGE_NO_CENTRE_AVISO`
// callout and an empty state instead of zeros (E-03); the settlement entries
// imported from Sage are listed under «Liquidaciones históricas» (B-2).

import { useEffect, useMemo, useState } from "react";
import { SAGE_NO_CENTRE_AVISO, type FiscalBox, type FiscalHistoricalSettlementDto, type FiscalLedgerCrossCheck, type FiscalModelCode, type FiscalModelReport as FiscalModelReportDto, type VatBookName, type VatPeriodicityCode } from "@hotelos/shared";
import { useToast } from "../../components/Toast";
import { BRAND } from "../../config/brand";
import { ACTIONS, UI_STATES } from "../../content/actions";
import { date, money, number, percent, plural } from "../../lib/format";
import { urlForScreen } from "../../navigation/nav-tree";
import { FinanceDeclaranteBadge, FinanceRegimeCallout, FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { downloadFiscalModelPdf, getFiscalModel, getVatBookPeriods, getVatSettings, type FiscalModelParams } from "../../services/fiscalApi";
import { centreNameFor, centreSelectOptions, financeScopePolicy, useFinanceScope } from "../../services/financeScope";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaGrid,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaSpan,
  CocoaStat,
  CocoaState,
  CocoaTable,
  openTabPath,
  type CocoaTableColumn
} from "../../components/cocoa";
import { ReportErrorCard } from "./ReportErrorCard";
import {
  BOOK_LABELS,
  BOOK_ORDER,
  BOX_KIND_LABELS,
  DETALLE_LABELS,
  KPI_KEYS,
  MONTH_OPTIONS,
  NO_BOX_LABEL,
  ORIGEN_LABELS,
  QUARTER_OPTIONS,
  TOTALES_LABELS,
  currentMonth,
  currentQuarter,
  describePeriod,
  fiscalErrorText,
  formatBoxValue,
  formatDetalleCell,
  formatTotal,
  generatedAtLabel,
  groupBoxesBySection,
  initialPeriodPicker,
  isCounterKey,
  isZeroBox,
  kpiLabel,
  modelPeriodKind,
  periodCodeOf,
  quarterMonthOptions,
  resultadoCaption,
  saveDownload,
  settlementEntryLabel,
  yearOptions,
  type PeriodPickerState
} from "./fiscal-shared";
import { useFiscalResource } from "./useFiscalResource";

export type FiscalModelScreenProps = {
  modelo: FiscalModelCode;
  /** Page title («Modelo 303»); painted standalone only (the container paints it hosted). */
  title: string;
  /** Standalone subtitle; the model screens pass `undefined` when hosted (the container already explains the item). */
  subtitle?: string;
};

type DetalleRow = Record<string, string | number | null>;
type KeyedDetalleRow = DetalleRow & { rowId: string };
type TotalRow = { key: string; label: string; value: number };
type LedgerDifference = FiscalLedgerCrossCheck["diferencias"][number];

const AVISOS_PREVIEW = 6;

// Columns live outside the component (COCOA-22.md §4.2 A5).
const BOX_COLUMNS: CocoaTableColumn<FiscalBox>[] = [
  {
    key: "casilla",
    label: "Casilla",
    width: "14ch",
    render: (box) =>
      box.casilla ? (
        <CocoaBadge tone="neutral" variant="outline">
          {box.casilla}
        </CocoaBadge>
      ) : (
        <CocoaBadge tone="warning" variant="tinted" uppercase={false} title="La numeración oficial de esta casilla debe validarse con la gestoría antes de presentar.">
          {NO_BOX_LABEL}
        </CocoaBadge>
      )
  },
  { key: "descripcion", label: "Concepto", render: (box) => (box.tipo === "resultado" ? <strong>{box.descripcion}</strong> : box.descripcion) },
  { key: "tipo", label: "Naturaleza", hideOnNarrow: true, width: "12ch", render: (box) => BOX_KIND_LABELS[box.tipo] },
  { key: "importe", label: "Importe", align: "right", width: "16ch", render: (box) => (box.tipo === "resultado" ? <strong>{formatBoxValue(box)}</strong> : formatBoxValue(box)) }
];

const TOTAL_COLUMNS: CocoaTableColumn<TotalRow>[] = [
  { key: "label", label: "Concepto" },
  { key: "value", label: "Importe", align: "right", width: "16ch", render: (row) => formatTotal(row.key, row.value) }
];

const DIFF_COLUMNS: CocoaTableColumn<LedgerDifference>[] = [
  { key: "libro", label: "Libro", render: (row) => (row.libro === "repercutido" ? "IVA repercutido" : "IVA soportado") },
  { key: "rate", label: "Tipo", align: "right", render: (row) => (row.rate === null ? "—" : percent(row.rate, { maximumFractionDigits: 2 })) },
  { key: "libros", label: "Libros", align: "right", render: (row) => money(row.libros) },
  { key: "diario", label: "Diario", align: "right", render: (row) => money(row.diario) },
  { key: "diferencia", label: "Diferencia", align: "right", render: (row) => <strong>{money(row.diferencia)}</strong> }
];

/** «Desglose por centro»: the whole declaration (default) or the informative partial view of one centre. */
const DECLARATION_OPTION = { value: "", label: "Declaración de la sociedad" };

/** FIX-1 · F3: settlement entries imported from Sage 200 inside the period (`fuentes.liquidacionesHistoricas`). */
const HISTORICAL_COLUMNS: CocoaTableColumn<FiscalHistoricalSettlementDto>[] = [
  { key: "entryNumber", label: "Asiento", width: "12ch", render: (row) => <strong>{row.entryNumber !== null ? `${row.fiscalYearCode ? `${row.fiscalYearCode}/` : ""}${row.entryNumber}` : row.journalEntryId}</strong> },
  { key: "entryDate", label: "Fecha", width: "11ch", render: (row) => date(row.entryDate, "short") },
  { key: "description", label: "Concepto", render: (row) => row.description ?? "—" },
  { key: "resultado", label: "Resultado", align: "right", width: "14ch", render: (row) => <strong>{money(row.resultado)}</strong> }
];

/** Columns of the `detalle[]` table from the keys of its first row (390 per period, 347 per third party, 180 per lessor, 111 per row). */
export function detalleColumns(rows: readonly DetalleRow[]): CocoaTableColumn<KeyedDetalleRow>[] {
  const first = rows[0];
  if (!first) return [];
  return Object.keys(first).map((key, index) => {
    const numeric = typeof first[key] === "number";
    return {
      key,
      label: DETALLE_LABELS[key] ?? key,
      align: numeric ? "right" : "left",
      hideOnNarrow: index > 1 && !(numeric && !isCounterKey(key) && index === Object.keys(first).length - 1),
      render: (row) => formatDetalleCell(key, row[key])
    };
  });
}

function ReportSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={4} />
      <CocoaSkeleton.Grid rows={[[8, 4]]} />
    </div>
  );
}

export function FiscalModelScreen({ modelo, title, subtitle }: FiscalModelScreenProps) {
  const { showToast } = useToast();
  const finance = useFinanceScope(financeScopePolicy("FiscalModelReport"));
  const kind = modelPeriodKind(modelo);

  // Only the 303 follows the VAT periodicity of the sociedad; the report waits for it (a month asked to a quarterly sociedad is a 400).
  const settings = useFiscalResource(kind === "settlement" ? "vat-settings" : null, getVatSettings);
  const periodicity: VatPeriodicityCode = settings.data?.periodicity ?? "quarterly";
  const pickerKind: "annual" | "monthly" | "quarterly" = kind === "annual" ? "annual" : kind === "settlement" && periodicity === "monthly" ? "monthly" : "quarterly";
  const settingsPending = kind === "settlement" && settings.data === null && settings.error === null;

  const years = useMemo(() => yearOptions(), []);
  // FIX-1 · F3 (E-04): the 303 opens on the last period with materialised books; the other models on today's. The
  // pickers stay unset (skeleton) until the periods answer — or fail, which falls back to today.
  const periods = useFiscalResource(kind === "settlement" ? "vat-book-periods" : null, getVatBookPeriods);
  const periodsPending = kind === "settlement" && periods.data === null && periods.error === null;
  const [picker, setPicker] = useState<PeriodPickerState | null>(() => (kind === "settlement" ? null : initialPeriodPicker(null)));
  useEffect(() => {
    if (picker === null && !periodsPending) setPicker(initialPeriodPicker(periods.data?.latest ?? null));
  }, [picker, periodsPending, periods.data]);
  const year = picker?.year ?? years[0]?.value ?? String(new Date().getUTCFullYear());
  const quarter = picker?.quarter ?? currentQuarter();
  const month = picker?.month ?? currentMonth();
  const patchPicker = (patch: Partial<PeriodPickerState>) => setPicker((current) => ({ ...(current ?? initialPeriodPicker(null)), ...patch }));
  // FIX-1 · F3 (E-02): one month of the picked quarter read as an informative view of a quarterly 303 ("" = the whole quarter).
  const [informativeMonth, setInformativeMonth] = useState("");
  const setYear = (value: string) => patchPicker({ year: value });
  const setQuarter = (value: string) => {
    patchPicker({ quarter: value });
    setInformativeMonth("");
  };
  const setMonth = (value: string) => patchPicker({ month: value });
  // Informative breakdown of one centre («vista parcial, no liquidable»); "" = the declaration of the sociedad.
  const [breakdown, setBreakdown] = useState("");
  const [hideZero, setHideZero] = useState(false);
  const [allAvisos, setAllAvisos] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const monthlyView = kind === "settlement" && pickerKind === "quarterly" && informativeMonth !== "";
  const period = monthlyView ? periodCodeOf({ kind: "monthly", year, month: informativeMonth }) : periodCodeOf({ kind: pickerKind, year, quarter, month });
  const propertyId = breakdown || undefined;
  const breakdownOptions = useMemo(() => [DECLARATION_OPTION, ...centreSelectOptions(finance.structure, finance.active).map((option) => ({ ...option, label: `Desglose · ${option.label}` }))], [finance.structure, finance.active]);
  const monthOptions = useMemo(() => quarterMonthOptions(quarter), [quarter]);
  const params: FiscalModelParams = kind === "annual" ? { year, propertyId } : { period, propertyId };
  const key = settingsPending || picker === null ? null : `${modelo}|${period}|${propertyId ?? ""}|${monthlyView ? "informativo" : ""}`;
  const report = useFiscalResource<FiscalModelReportDto>(key, () => getFiscalModel(modelo, params, { informativo: monthlyView }));
  const data = report.data;
  const sociedad = data?.sociedad ?? settings.data?.sociedad ?? null;
  const errorText = report.error ? fiscalErrorText(report.error, "No hemos podido cargar este informe. Inténtalo de nuevo.") : null;

  async function download() {
    if (downloading || !data) return;
    setDownloading(true);
    try {
      const file = await downloadFiscalModelPdf(modelo, params);
      saveDownload(file);
      showToast(`Resumen descargado: ${file.filename}`, { variant: "success" });
    } catch (err) {
      showToast(fiscalErrorText(err, "No se pudo descargar el resumen del modelo."), { variant: "error" });
    } finally {
      setDownloading(false);
    }
  }

  const actions = (
    <>
      <FinanceDeclaranteBadge sociedad={sociedad} />
      {pickerKind === "quarterly" ? <CocoaSelect size="small" inline aria-label="Trimestre" value={quarter} onChange={setQuarter} options={[...QUARTER_OPTIONS]} /> : null}
      {kind === "settlement" && pickerKind === "quarterly" ? <CocoaSelect size="small" inline aria-label="Mes (vista informativa)" value={informativeMonth} onChange={setInformativeMonth} options={monthOptions} /> : null}
      {pickerKind === "monthly" ? <CocoaSelect size="small" inline aria-label="Mes" value={month} onChange={setMonth} options={[...MONTH_OPTIONS]} /> : null}
      <CocoaSelect size="small" inline aria-label="Ejercicio" value={year} onChange={setYear} options={years} />
      <FinanceScopeSelector scope={finance} />
      {breakdownOptions.length > 1 ? <CocoaSelect size="small" inline aria-label="Desglose por centro" value={breakdown} onChange={setBreakdown} options={breakdownOptions} /> : null}
      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={report.refresh} loading={report.refreshing && !report.loading} disabled={report.loading}>
        {ACTIONS.refresh}
      </CocoaButton>
      <CocoaButton variant="filled" tone="accent" size="small" onClick={() => void download()} loading={downloading} disabled={!data}>
        Descargar resumen
      </CocoaButton>
    </>
  );

  return (
    <CocoaPage
      eyebrow={finance.eyebrow("Cumplimiento")}
      title={title}
      subtitle={subtitle}
      actions={actions}
      state={report.loading || settingsPending || picker === null ? "loading" : "ready"}
      skeleton={<ReportSkeleton />}
      commands={[
        { id: `modelo-${modelo}-refresh`, label: `Actualizar el Modelo ${modelo}`, run: report.refresh },
        { id: `modelo-${modelo}-download`, label: `Descargar el resumen del Modelo ${modelo}`, run: () => void download() }
      ]}
    >
      {!data ? (
        errorText ? <ReportErrorCard message={errorText} onRetry={report.refresh} /> : null
      ) : (
        <>
          {errorText ? (
            <CocoaCallout
              tone="danger"
              title={UI_STATES.error.title}
              role="alert"
              actions={
                <CocoaButton variant="bordered" tone="neutral" size="small" onClick={report.refresh}>
                  {ACTIONS.retry}
                </CocoaButton>
              }
            >
              {errorText} Se muestran los últimos datos cargados.
            </CocoaCallout>
          ) : null}
          <ReportBody report={data} hideZero={hideZero} onToggleZero={() => setHideZero((value) => !value)} allAvisos={allAvisos} onToggleAvisos={() => setAllAvisos((value) => !value)} propertyName={centreNameFor(finance.structure, data.propertyId)} />
        </>
      )}
    </CocoaPage>
  );
}

type ReportBodyProps = {
  report: FiscalModelReportDto;
  hideZero: boolean;
  onToggleZero: () => void;
  allAvisos: boolean;
  onToggleAvisos: () => void;
  propertyName: string;
};

function ReportBody({ report, hideZero, onToggleZero, allAvisos, onToggleAvisos, propertyName }: ReportBodyProps) {
  const totales = report.totales;
  const diario = report.fuentes.diario;
  const kpis = KPI_KEYS[report.modelo].filter((key) => typeof totales[key] === "number");
  const sections = useMemo(() => groupBoxesBySection(report.casillas), [report.casillas]);
  const unnumbered = report.casillas.filter((box) => box.casilla === null).length;
  const totalRows: TotalRow[] = Object.entries(totales).map(([key, value]) => ({ key, label: TOTALES_LABELS[key] ?? key, value }));
  const detalle = useMemo<KeyedDetalleRow[]>(() => report.detalle.map((row, index) => ({ ...row, rowId: String(index) })), [report.detalle]);
  const detalleCols = useMemo(() => detalleColumns(report.detalle), [report.detalle]);
  const avisos = allAvisos ? report.avisos : report.avisos.slice(0, AVISOS_PREVIEW);
  // FIX-1 · F3 (E-03): a centre breakdown over a Sage period has no rows with centre — say so instead of painting zeros.
  const noCentreBreakdown = Boolean(report.propertyId) && report.avisos.includes(SAGE_NO_CENTRE_AVISO);

  return (
    <>
      {report.fuentes.informativo ? (
        <CocoaCallout tone="info" title="Vista mensual informativa">
          Vista mensual informativa: la sociedad liquida por trimestres y este mes no es presentable. Las casillas 110 y 78 van a cero y el resultado es el del mes sin compensación; el Modelo 303 se presenta por el trimestre completo.
        </CocoaCallout>
      ) : null}
      {report.presentacion.noSePresenta ? (
        <CocoaCallout tone="warning" title={`El Modelo ${report.modelo} no se presenta`} role="status">
          {report.presentacion.noSePresenta.motivo} Las cifras se muestran a título informativo.
        </CocoaCallout>
      ) : (
        <CocoaCallout tone="info" title="Presentación manual en la sede de la AEAT">
          {report.presentacion.nota} Periodo AEAT {report.periodo.aeatPeriod}/{report.periodo.year}.
        </CocoaCallout>
      )}
      <FinanceRegimeCallout regimen={report.sociedad.regimen} />
      {noCentreBreakdown ? (
        <CocoaCallout tone="info" title="Desglose por centro no disponible para lotes Sage sin delegación">
          Las filas del periodo importadas de Sage 200 no llevan centro, así que el desglose de {propertyName} no puede calcularse: consulta la declaración de la sociedad {report.sociedad.legalName}
          {report.sociedad.taxId ? ` (${report.sociedad.taxId})` : ""}.
        </CocoaCallout>
      ) : report.propertyId ? (
        <CocoaCallout tone="warning" title="Desglose por centro: vista parcial, no liquidable">
          Los importes de {propertyName} no se presentan por sí solos: el modelo lo presenta la sociedad {report.sociedad.legalName}
          {report.sociedad.taxId ? ` (${report.sociedad.taxId})` : ""} por todos sus centros.
        </CocoaCallout>
      ) : null}

      {noCentreBreakdown ? null : (
      <CocoaKpiStrip stagger aria-label={`Totales del Modelo ${report.modelo}`}>
        {kpis.map((key) => (
          <CocoaKpi
            key={key}
            label={kpiLabel(key)}
            value={formatTotal(key, totales[key])}
            polarity="neutral"
            deltaLabel={key === "resultado" ? resultadoCaption(totales) : key === "periodosLiquidados" && typeof totales.periodos === "number" ? `de ${number(totales.periodos, { maximumFractionDigits: 0 })} periodos` : undefined}
          />
        ))}
        {diario ? <CocoaKpi label="Cotejo con el diario" value={diario.cuadra ? "Cuadra" : "No cuadra"} status={diario.cuadra ? "ok" : "critical"} polarity="neutral" deltaLabel={plural(diario.apuntes, "apunte", "apuntes")} /> : null}
        <CocoaKpi label="Avisos" value={number(report.avisos.length, { maximumFractionDigits: 0 })} status={report.avisos.length > 0 ? "warning" : "ok"} polarity="neutral" deltaLabel={unnumbered > 0 ? `${number(unnumbered, { maximumFractionDigits: 0 })} sin casilla` : undefined} />
      </CocoaKpiStrip>
      )}

      <CocoaGrid align="start" aria-label="Casillas, declarante y fuentes">
        <CocoaSpan cols={8} min={480}>
          {noCentreBreakdown ? (
            <CocoaSection title="Casillas" padding="md">
              <CocoaState kind="empty" illustration="box" title="Desglose por centro no disponible" message="Las filas importadas de Sage 200 no llevan centro: no hay casillas que desglosar para este centro en el periodo. Elige «Declaración de la sociedad» para ver el modelo completo." />
            </CocoaSection>
          ) : (
          <div className="cocoa-stack" data-gap="3">
            <div className="cocoa-row" data-gap="2" data-justify="between">
              <span>
                {plural(report.casillas.length, "casilla", "casillas")}
                {unnumbered > 0 ? ` · ${plural(unnumbered, "sin numeración confirmada", "sin numeración confirmada")}` : ""}
              </span>
              <CocoaButton variant="plain" size="small" onClick={onToggleZero} aria-pressed={hideZero}>
                {hideZero ? "Mostrar casillas a cero" : "Ocultar casillas a cero"}
              </CocoaButton>
            </div>
            {sections.map((section) => {
              const rows = hideZero ? section.boxes.filter((box) => !isZeroBox(box)) : section.boxes;
              return (
                <CocoaSection key={section.seccion} title={section.seccion} meta={plural(rows.length, "casilla", "casillas")} padding={rows.length > 0 ? "none" : "md"} style={{ overflow: "clip" }}>
                  {rows.length > 0 ? (
                    <CocoaTable columns={BOX_COLUMNS} rows={rows} rowKey="clave" density="compact" caption={`${section.seccion} · Modelo ${report.modelo}`} aria-label={`Casillas de ${section.seccion}`} />
                  ) : (
                    <CocoaState kind="empty" inline title="Todas las casillas de esta sección están a cero." />
                  )}
                </CocoaSection>
              );
            })}
          </div>
          )}
        </CocoaSpan>

        <CocoaSpan cols={4} min={320}>
          <div className="cocoa-stack" data-gap="3">
            <CocoaSection title="Declarante y periodo" footer={generatedAtLabel(report.generatedAt)}>
              <div className="cocoa-stack" data-gap="3">
                <CocoaStat label="NIF" value={report.sociedad.taxId ?? "NIF pendiente"} tone={report.sociedad.taxId && report.sociedad.taxIdValid ? undefined : "warning"} hint={report.sociedad.taxId ? (report.sociedad.taxIdValid ? undefined : "El NIF no supera el dígito de control.") : "Configura el NIF en Configuración › Estructura societaria › Datos fiscales."} />
                <CocoaStat label="Sociedad declarante" value={report.sociedad.legalName} hint={report.sociedad.code ? `Código ${report.sociedad.code}` : undefined} tabular={false} />
                <CocoaStat label="Régimen" value={report.sociedad.regimen.siiEnabled ? "SII (mensual)" : report.sociedad.regimen.largeCompany ? "Gran empresa (mensual)" : report.sociedad.regimen.periodicity === "monthly" ? "General · mensual" : "General · trimestral"} tabular={false} />
                <CocoaStat label="Periodo" value={describePeriod(report.periodo)} tabular={false} />
                <CocoaStat label="Periodo AEAT" value={`${report.periodo.aeatPeriod}/${report.periodo.year}`} />
              </div>
            </CocoaSection>

            <SourcesSection report={report} />

            <CocoaSection title="Totales" meta={plural(totalRows.length, "concepto", "conceptos")} padding="none" style={{ overflow: "clip" }}>
              <CocoaTable columns={TOTAL_COLUMNS} rows={totalRows} rowKey="key" density="compact" caption={`Totales del Modelo ${report.modelo}`} aria-label={`Totales del Modelo ${report.modelo}`} />
            </CocoaSection>
          </div>
        </CocoaSpan>
      </CocoaGrid>

      {detalle.length > 0 ? (
        <CocoaSection title="Detalle" meta={plural(detalle.length, "fila", "filas")} padding="none" style={{ overflow: "clip" }}>
          <CocoaTable columns={detalleCols} rows={detalle} rowKey="rowId" density="compact" virtualize caption={`Detalle del Modelo ${report.modelo}`} aria-label={`Detalle del Modelo ${report.modelo}`} />
        </CocoaSection>
      ) : null}

      <CocoaSection
        title="Avisos"
        meta={plural(report.avisos.length, "aviso", "avisos")}
        action={
          report.avisos.length > AVISOS_PREVIEW ? (
            <CocoaButton variant="plain" size="small" onClick={onToggleAvisos} aria-expanded={allAvisos}>
              {allAvisos ? "Mostrar menos" : `Mostrar los ${number(report.avisos.length, { maximumFractionDigits: 0 })} avisos`}
            </CocoaButton>
          ) : undefined
        }
      >
        {report.avisos.length === 0 ? (
          <CocoaState kind="empty" inline title="Sin avisos: el modelo se calculó sin incidencias." />
        ) : (
          <ul className="c22-section__list">
            {avisos.map((aviso, index) => (
              <li key={`${index}-${aviso.slice(0, 24)}`}>
                <span>{aviso}</span>
              </li>
            ))}
          </ul>
        )}
      </CocoaSection>
    </>
  );
}

/** Ledger cross-check of the 303 (`fuentes.diario`): does the journal (477x / 472x) say the same as the books? Shared with the settlement screen. */
export function LedgerCrossCheckView({ diario }: { diario: FiscalLedgerCrossCheck }) {
  return (
    <div className="cocoa-stack" data-gap="2">
      <div className="cocoa-row" data-gap="2" data-justify="between">
        <span>Cotejo con el diario (cuentas 477 y 472)</span>
        <CocoaBadge tone={diario.cuadra ? "success" : "danger"} variant="dot">
          {diario.cuadra ? "Cuadra" : "No cuadra"}
        </CocoaBadge>
      </div>
      <ul className="c22-section__list">
        <li>
          <span>Apuntes leídos</span>
          <span>{number(diario.apuntes, { maximumFractionDigits: 0 })}</span>
        </li>
        <li>
          <span>Cuota repercutida en el diario</span>
          <span>{money(diario.cuotaRepercutida)}</span>
        </li>
        <li>
          <span>Cuota soportada en el diario</span>
          <span>{money(diario.cuotaSoportada)}</span>
        </li>
      </ul>
      {diario.diferencias.length > 0 ? (
        <CocoaTable columns={DIFF_COLUMNS} rows={diario.diferencias} rowKey={(row) => `${row.libro}-${row.rate ?? "sin-tipo"}`} density="compact" caption="Diferencias entre libros y diario" aria-label="Diferencias entre libros y diario" />
      ) : (
        <CocoaState kind="empty" inline title="Sin diferencias por tipo entre los libros y el diario." />
      )}
    </div>
  );
}

function SourcesSection({ report }: { report: FiscalModelReportDto }) {
  const { fuentes } = report;
  const libros = fuentes.libros;
  const diario = fuentes.diario;
  const liquidacion = fuentes.liquidacion;
  const booksUrl = urlForScreen("VatBooksScreen");
  const settlementUrl = urlForScreen("VatSettlementScreen");
  const bookNames = libros ? BOOK_ORDER.filter((book): book is VatBookName => Boolean(libros[book])) : [];

  return (
    <CocoaSection title="Fuentes de los importes" meta={fuentes.registros !== undefined ? plural(fuentes.registros, "registro", "registros") : undefined}>
      <div className="cocoa-stack" data-gap="3">
        <div className="cocoa-row" data-gap="2" data-justify="between">
          <CocoaBadge tone={fuentes.origen === "documentos" ? "warning" : fuentes.origen === "libros" ? "success" : "info"} variant="tinted" uppercase={false}>
            {ORIGEN_LABELS[fuentes.origen]}
          </CocoaBadge>
          {fuentes.origen === "documentos" && booksUrl ? (
            <CocoaButton variant="plain" size="small" onClick={() => openTabPath(booksUrl)}>
              Abrir Libros de IVA
            </CocoaButton>
          ) : null}
        </div>

        {bookNames.length > 0 ? (
          <ul className="c22-section__list" aria-label="Totales de los libros registro">
            {bookNames.map((book) => {
              const summary = libros![book]!;
              return (
                <li key={book}>
                  <span>{BOOK_LABELS[book]}</span>
                  <span>
                    {plural(summary.filas, "fila", "filas")} · base {money(summary.base)} · cuota {money(summary.cuota)}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : null}

        {diario ? <LedgerCrossCheckView diario={diario} /> : null}

        {liquidacion !== undefined ? (
          <div className="cocoa-row" data-gap="2" data-justify="between">
            {liquidacion ? (
              <>
                <span>{settlementEntryLabel(liquidacion)}</span>
                <CocoaBadge tone={liquidacion.reversed ? "warning" : "success"} variant="dot">
                  {liquidacion.reversed ? "Liquidación anulada" : "Liquidación contabilizada"}
                </CocoaBadge>
              </>
            ) : (
              <>
                <CocoaBadge tone="neutral" variant="dot">
                  Sin asiento de liquidación
                </CocoaBadge>
                {settlementUrl ? (
                  <CocoaButton variant="plain" size="small" onClick={() => openTabPath(settlementUrl)}>
                    Abrir Liquidación de IVA
                  </CocoaButton>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {fuentes.liquidacionesHistoricas && fuentes.liquidacionesHistoricas.length > 0 ? (
          <div className="cocoa-stack" data-gap="2" aria-label="Liquidaciones históricas (importadas de Sage)">
            <div className="cocoa-row" data-gap="2" data-justify="between">
              <span>Liquidaciones históricas (importadas de Sage)</span>
              <CocoaBadge tone="neutral" variant="outline" uppercase={false} title={`Asientos de liquidación importados de Sage 200 (patrón 4750/4700 junto a 477/472): se muestran, ${BRAND.name} no los contabiliza.`}>
                {plural(fuentes.liquidacionesHistoricas.length, "asiento", "asientos")}
              </CocoaBadge>
            </div>
            <CocoaTable columns={HISTORICAL_COLUMNS} rows={fuentes.liquidacionesHistoricas} rowKey="journalEntryId" density="compact" caption="Liquidaciones históricas importadas de Sage" aria-label="Liquidaciones históricas importadas de Sage" />
          </div>
        ) : null}

        {fuentes.periodos && fuentes.periodos.length > 0 ? (
          <ul className="c22-section__list" aria-label="Resultado por periodo">
            {fuentes.periodos.map((item) => (
              <li key={item.periodo}>
                <span>{item.periodo}</span>
                <span>{money(item.resultado)}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {!libros && !diario && liquidacion === undefined && !fuentes.periodos ? <CocoaState kind="empty" inline title={`${plural(fuentes.registros ?? 0, "registro leído", "registros leídos")}.`} /> : null}

        <span className="cocoa-sr-only">{`Informe generado el ${date(report.generatedAt, "short")}`}</span>
      </div>
    </CocoaSection>
  );
}

export default FiscalModelScreen;

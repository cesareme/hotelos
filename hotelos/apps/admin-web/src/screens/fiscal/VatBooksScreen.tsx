// Libros de IVA — /cumplimiento/modelos-aeat/libros-iva (Tanda 6 · Cumplimiento;
// Cocoa 22 · ola 8 · lote 8-B, plantilla ListaTabla, hosted in ModelosAeatTabs).
//
// The three registers of RD 1619/2012 (emitidas · recibidas · bienes de
// inversión) per period, the single source of the 303/390/347: rows with
// totals by rate (GET /fiscal/vat-books?book=&period=[&propertyId=]), the
// `origen` of the figures (materialised rows or derived from the documents),
// the VAT settings of the organisation (GET /fiscal/vat-settings, read-only
// here: they are edited in Contabilidad › Ajustes), a client-side CSV of the
// rows on screen and the «Reconstruir libros» action (POST
// /fiscal/vat-books/rebuild, accounting.configure, confirmed) that
// materialises a period from its documents. Errors map details.code through
// fiscalErrorText; nothing is written without the dialog.
//
// Tanda 6b · L7 (design §5.3): the books are FORCED to the sociedad («Ámbito»
// disabled, services/financeScope.ts), the badge «Declarante: <razón social> ·
// <NIF>» comes from `settings.sociedad`, a centre can be picked as «Desglose
// por centro» (informative partial book) and the SII / gran empresa regime
// paints a warning callout.

import { useMemo, useState, type ReactNode } from "react";
import type { VatBookName, VatBookResponse, VatBookRowDto, VatBookTotalsByRate } from "@hotelos/shared";
import { useToast } from "../../components/Toast";
import { ACTIONS, UI_STATES } from "../../content/actions";
import { date, money, number, percent, plural } from "../../lib/format";
import { FinanceDeclaranteBadge, FinanceRegimeCallout, FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { getVatBook, getVatSettings, rebuildVatBooks } from "../../services/fiscalApi";
import { centreNameFor, centreSelectOptions, financeScopePolicy, useFinanceScope } from "../../services/financeScope";
import { useTabHost } from "../tabs/TabHost";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaDrawer,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSearchInput,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaSkeleton,
  CocoaStat,
  CocoaState,
  CocoaTable,
  CocoaToolbar,
  type CocoaTableColumn,
  type CocoaTableSort
} from "../../components/cocoa";
import { ReportErrorCard } from "./ReportErrorCard";
import {
  BOOK_LABELS,
  BOOK_ORDER,
  PERIODICITY_LABELS,
  REGIME_LABELS,
  SOURCE_TYPE_LABELS,
  bookPeriodOptions,
  currentQuarter,
  fiscalErrorText,
  matchesVatBookSearch,
  periodRangeLabel,
  saveDownload,
  sumVatBookRows,
  vatBookCsv,
  yearOptions
} from "./fiscal-shared";
import { useFiscalResource } from "./useFiscalResource";

/** «Desglose por centro»: the whole book of the sociedad (default) or the informative partial book of one centre. */
const WHOLE_BOOK_OPTION = { value: "", label: "Libro de la sociedad" };

const BOOK_OPTIONS = BOOK_ORDER.map((book) => ({ value: book, label: BOOK_LABELS[book] }));

const SORTABLE: ReadonlySet<string> = new Set(["date", "number", "counterpartyName", "base", "quota", "total"]);

/** Stable row key: a book row is unique by (book, sourceType, sourceId, rate) — the contract's unique index. */
export function vatBookRowKey(row: Pick<VatBookRowDto, "book" | "sourceType" | "sourceId" | "rate">): string {
  return `${row.book}:${row.sourceType}:${row.sourceId}:${row.rate}`;
}

/** Controlled sort of the rows on screen (dates and numbers as strings compare lexically; amounts numerically). */
export function sortVatBookRows(rows: readonly VatBookRowDto[], sort: CocoaTableSort): VatBookRowDto[] {
  const direction = sort.direction === "asc" ? 1 : -1;
  const key = sort.key as keyof VatBookRowDto;
  return [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av === bv) return 0;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * direction;
    return String(av).localeCompare(String(bv), "es") * direction;
  });
}

const RATE_COLUMNS: CocoaTableColumn<VatBookTotalsByRate>[] = [
  { key: "rate", label: "Tipo", render: (row) => <strong>{percent(row.rate, { maximumFractionDigits: 2 })}</strong> },
  { key: "filas", label: "Filas", align: "right", render: (row) => number(row.filas, { maximumFractionDigits: 0 }) },
  { key: "base", label: "Base", align: "right", render: (row) => money(row.base) },
  { key: "cuota", label: "Cuota", align: "right", render: (row) => money(row.cuota) },
  { key: "total", label: "Total", align: "right", render: (row) => money(row.total) },
  { key: "retencion", label: "Retención", align: "right", hideOnNarrow: true, render: (row) => money(row.retencion) }
];

function columnsFor(book: VatBookName): CocoaTableColumn<VatBookRowDto>[] {
  const received = book !== "emitidas";
  const columns: CocoaTableColumn<VatBookRowDto>[] = [
    { key: "date", label: "Fecha", sortable: true, width: "11ch", render: (row) => date(row.date, "short") },
    { key: "number", label: "Documento", sortable: true, render: (row) => <strong>{row.number ?? "—"}</strong> },
    {
      key: "counterpartyNif",
      label: "NIF",
      width: "12ch",
      render: (row) =>
        row.counterpartyNif ?? (
          <CocoaBadge tone="warning" variant="outline" uppercase={false} title="Sin NIF del destinatario: la fila no computa en el Modelo 347.">
            sin NIF
          </CocoaBadge>
        )
    },
    { key: "counterpartyName", label: "Contraparte", sortable: true, hideOnNarrow: true, render: (row) => row.counterpartyName ?? "—" },
    { key: "base", label: "Base", align: "right", sortable: true, render: (row) => money(row.base) },
    { key: "rate", label: "Tipo", align: "right", width: "8ch", render: (row) => percent(row.rate, { maximumFractionDigits: 2 }) },
    { key: "quota", label: "Cuota", align: "right", sortable: true, render: (row) => money(row.quota) },
    { key: "total", label: "Total", align: "right", sortable: true, render: (row) => money(row.total) }
  ];
  if (received) {
    columns.push({ key: "retention", label: "Retención", align: "right", hideOnNarrow: true, render: (row) => money(row.retention) });
    columns.push({
      key: "deductible",
      label: "Deducible",
      hideOnNarrow: true,
      render: (row) => (
        <CocoaBadge tone={row.deductible ? "success" : "warning"} variant="dot">
          {row.deductible ? "Sí" : "No"}
        </CocoaBadge>
      )
    });
  }
  columns.push({ key: "sourceType", label: "Origen", hideOnNarrow: true, render: (row) => SOURCE_TYPE_LABELS[row.sourceType] ?? row.sourceType });
  return columns;
}

export function VatBooksScreen() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const finance = useFinanceScope(financeScopePolicy("VatBooksScreen"));

  const settings = useFiscalResource("vat-settings", getVatSettings);
  const periodicity = settings.data?.periodicity ?? "quarterly";
  const sociedad = settings.data?.sociedad ?? null;

  const years = useMemo(() => yearOptions(), []);
  const [book, setBook] = useState<VatBookName>("emitidas");
  const [year, setYear] = useState(() => years[0]?.value ?? String(new Date().getUTCFullYear()));
  const [period, setPeriod] = useState(() => `${years[0]?.value ?? String(new Date().getUTCFullYear())}-Q${currentQuarter()}`);
  // Informative breakdown of one centre («vista parcial»); "" = the whole book of the sociedad.
  const [breakdown, setBreakdown] = useState("");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<CocoaTableSort>({ key: "date", direction: "asc" });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [askRebuild, setAskRebuild] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);

  const periodOptions = useMemo(() => bookPeriodOptions(year, periodicity), [year, periodicity]);
  const breakdownOptions = useMemo(() => [WHOLE_BOOK_OPTION, ...centreSelectOptions(finance.structure, finance.active).map((option) => ({ ...option, label: `Desglose · ${option.label}` }))], [finance.structure, finance.active]);
  const propertyId = breakdown || undefined;
  const breakdownName = centreNameFor(finance.structure, propertyId);
  const key = `${book}|${period}|${propertyId ?? ""}`;
  const resource = useFiscalResource<VatBookResponse>(key, () => getVatBook({ book, period, propertyId }));
  const data = resource.data;
  const errorText = resource.error ? fiscalErrorText(resource.error, "No hemos podido cargar el libro. Inténtalo de nuevo.") : null;

  const columns = useMemo(() => columnsFor(book), [book]);
  const allRows = data?.rows ?? [];
  const filtered = useMemo(() => allRows.filter((row) => matchesVatBookSearch(row, search)), [allRows, search]);
  const rows = useMemo(() => (SORTABLE.has(sortBy.key) ? sortVatBookRows(filtered, sortBy) : filtered), [filtered, sortBy]);
  const shownTotals = useMemo(() => sumVatBookRows(rows), [rows]);
  const selected = selectedKey ? rows.find((row) => vatBookRowKey(row) === selectedKey) ?? null : null;
  const ready = Boolean(data) && !errorText && rows.length > 0;

  function changeYear(next: string) {
    setYear(next);
    setPeriod((current) => (current.startsWith(year) ? next + current.slice(year.length) : next));
  }

  function downloadCsv() {
    if (!data || rows.length === 0) return;
    const filename = `libro-iva-${book}-${data.periodo.code}${propertyId ? `-${propertyId}` : ""}.csv`;
    saveDownload({ blob: new Blob([vatBookCsv(rows)], { type: "text/csv;charset=utf-8" }), filename });
    showToast(`CSV descargado: ${filename}`, { variant: "success" });
  }

  async function rebuild() {
    if (rebuilding) return;
    setRebuilding(true);
    try {
      const result = await rebuildVatBooks({ period, propertyId });
      showToast(
        `Libros reconstruidos: ${number(result.created.emitidas, { maximumFractionDigits: 0 })} emitidas · ${number(result.created.recibidas, { maximumFractionDigits: 0 })} recibidas · ${number(result.created.bienes_inversion, { maximumFractionDigits: 0 })} bienes de inversión (${plural(result.deleted, "fila anterior eliminada", "filas anteriores eliminadas")}).`,
        { variant: "success", duration: 8000 }
      );
      setAskRebuild(false);
      resource.refresh();
    } catch (err) {
      showToast(fiscalErrorText(err, "No se pudieron reconstruir los libros."), { variant: "error" });
    } finally {
      setRebuilding(false);
    }
  }

  const footer = data ? (
    <span>
      {search ? `${number(rows.length, { maximumFractionDigits: 0 })} de ${number(allRows.length, { maximumFractionDigits: 0 })} filas` : plural(allRows.length, "fila", "filas")} · base {money(shownTotals.base)} · cuota {money(shownTotals.cuota)} · total {money(shownTotals.total)}
    </span>
  ) : undefined;

  const footerCells: Record<string, ReactNode> = {
    date: <strong>Total</strong>,
    base: <strong>{money(shownTotals.base)}</strong>,
    quota: <strong>{money(shownTotals.cuota)}</strong>,
    total: <strong>{money(shownTotals.total)}</strong>,
    retention: <strong>{money(shownTotals.retencion)}</strong>
  };

  const actions = (
    <>
      <FinanceDeclaranteBadge sociedad={sociedad} />
      {settings.data ? (
        <CocoaBadge tone={settings.data.persisted ? "neutral" : "warning"} variant="outline" uppercase={false} title={settings.data.persisted ? "Ajustes de IVA de la sociedad" : "La sociedad aún no ha guardado sus ajustes de IVA: se aplican los valores por defecto."}>
          {settings.data.taxFigure} · {PERIODICITY_LABELS[settings.data.periodicity]} · {REGIME_LABELS[settings.data.regime]}
          {settings.data.prorrataPct !== null ? ` · prorrata ${percent(settings.data.prorrataPct, { maximumFractionDigits: 2 })}` : ""}
          {settings.data.persisted ? "" : " · por defecto"}
        </CocoaBadge>
      ) : null}
      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={resource.refresh} loading={resource.refreshing && !resource.loading} disabled={resource.loading}>
        {ACTIONS.refresh}
      </CocoaButton>
      <CocoaButton variant="filled" tone="accent" size="small" onClick={downloadCsv} disabled={rows.length === 0}>
        Descargar CSV
      </CocoaButton>
    </>
  );

  return (
    <CocoaPage
      eyebrow={finance.eyebrow("Cumplimiento")}
      title="Libros de IVA"
      subtitle={hosted ? undefined : "Libros registro de facturas emitidas, recibidas y bienes de inversión por periodo: la fuente única de los modelos 303, 390 y 347."}
      actions={actions}
      commands={[
        { id: "libros-iva-refresh", label: "Actualizar los libros de IVA", run: resource.refresh },
        { id: "libros-iva-csv", label: "Descargar el libro de IVA en CSV", run: downloadCsv }
      ]}
    >
      <CocoaToolbar
        variant="content"
        wrap
        aria-label="Filtros de los libros de IVA"
        leftSlot={
          <>
            <CocoaSegmentedControl value={book} onChange={(value) => setBook(value as VatBookName)} options={BOOK_OPTIONS} size="small" aria-label="Libro registro" />
            <CocoaSearchInput value={search} onChange={setSearch} debounceMs={200} placeholder="Número, NIF o nombre…" aria-label="Buscar en el libro" />
          </>
        }
        rightSlot={
          <>
            <CocoaSelect size="small" inline aria-label="Periodo" value={period} onChange={setPeriod} options={periodOptions} />
            <CocoaSelect size="small" inline aria-label="Ejercicio" value={year} onChange={changeYear} options={years} />
            <FinanceScopeSelector scope={finance} />
            {breakdownOptions.length > 1 ? <CocoaSelect size="small" inline aria-label="Desglose por centro" value={breakdown} onChange={setBreakdown} options={breakdownOptions} /> : null}
          </>
        }
      />

      <FinanceRegimeCallout regimen={sociedad?.regimen} />
      {propertyId ? (
        <CocoaCallout tone="warning" title="Desglose por centro: vista parcial, no liquidable">
          El libro de {breakdownName} es un auxiliar informativo: los libros registro y los modelos son de la sociedad {sociedad?.legalName ?? finance.entityName} por todos sus centros.
        </CocoaCallout>
      ) : null}

      {data && data.origen === "documentos" ? (
        <CocoaCallout
          tone="warning"
          title="Libros sin materializar para este periodo"
          actions={
            <CocoaButton variant="tinted" tone="neutral" size="small" onClick={() => setAskRebuild(true)}>
              Reconstruir libros
            </CocoaButton>
          }
        >
          Los importes se calculan directamente desde los documentos (facturas, rectificativas, facturas recibidas y gastos). Reconstruir los libros guarda las filas del periodo tal como las leen los modelos.
        </CocoaCallout>
      ) : null}

      {resource.loading ? (
        <CocoaSkeleton.Strip count={4} label="Cargando totales del libro…" />
      ) : data ? (
        <CocoaKpiStrip stagger aria-label={`Totales de ${BOOK_LABELS[book]}`}>
          <CocoaKpi label="Filas" value={number(data.resumen.filas, { maximumFractionDigits: 0 })} polarity="neutral" deltaLabel={periodRangeLabel(data.periodo.code) ?? data.periodo.code} />
          <CocoaKpi label="Base imponible" value={money(data.resumen.base)} polarity="neutral" />
          <CocoaKpi label="Cuota" value={money(data.resumen.cuota)} polarity="neutral" />
          <CocoaKpi label="Total" value={money(data.resumen.total)} polarity="neutral" />
          {book !== "emitidas" || data.resumen.retencion !== 0 ? <CocoaKpi label="Retención" value={money(data.resumen.retencion)} polarity="neutral" /> : null}
        </CocoaKpiStrip>
      ) : null}

      <CocoaSection
        title={BOOK_LABELS[book]}
        meta={data ? (data.origen === "libros" ? "filas materializadas" : "derivado de los documentos") : undefined}
        padding={ready ? "none" : "md"}
        footer={ready ? footer : undefined}
        style={{ overflow: "clip" }}
        aria-label={`Filas de ${BOOK_LABELS[book]}`}
      >
        {errorText && !data ? (
          <ReportErrorCard message={errorText} onRetry={resource.refresh} />
        ) : data && rows.length === 0 && !resource.refreshing ? (
          <CocoaState
            kind="empty"
            illustration={search ? "search" : "box"}
            title={search ? UI_STATES.noResults.title : `Sin filas en ${BOOK_LABELS[book].toLowerCase()} para este periodo`}
            message={search ? UI_STATES.noResults.message : "Los documentos emitidos, contabilizados o registrados en el periodo aparecerán aquí con su tipo de IVA."}
            primaryAction={search ? { label: ACTIONS.clearFilters, onClick: () => setSearch("") } : undefined}
          />
        ) : (
          <CocoaTable
            columns={columns}
            rows={rows}
            rowKey={vatBookRowKey}
            loading={resource.loading}
            sortBy={sortBy}
            onSort={setSortBy}
            selectedKey={selected ? vatBookRowKey(selected) : undefined}
            onSelect={(row) => setSelectedKey(vatBookRowKey(row))}
            rowTone={(row) => (row.base < 0 ? "warning" : undefined)}
            rowTitle={(row) => (row.base < 0 ? "Fila negativa: anulación o rectificativa" : undefined)}
            footer={rows.length > 0 ? footerCells : undefined}
            virtualize
            density="compact"
            caption={`${BOOK_LABELS[book]} · ${data?.periodo.code ?? period}`}
            aria-label={`${BOOK_LABELS[book]} del periodo ${data?.periodo.code ?? period}`}
          />
        )}
      </CocoaSection>

      {data && data.resumen.porTipo.length > 0 ? (
        <CocoaSection title="Totales por tipo impositivo" meta={plural(data.resumen.porTipo.length, "tipo", "tipos")} padding="none" style={{ overflow: "clip" }}>
          <CocoaTable columns={RATE_COLUMNS} rows={data.resumen.porTipo} rowKey={(row) => String(row.rate)} density="compact" caption="Totales por tipo impositivo" aria-label="Totales por tipo impositivo" />
        </CocoaSection>
      ) : null}

      {data && data.avisos.length > 0 ? (
        <CocoaSection title="Avisos" meta={plural(data.avisos.length, "aviso", "avisos")}>
          <ul className="c22-section__list">
            {data.avisos.map((aviso, index) => (
              <li key={`${index}-${aviso.slice(0, 24)}`}>
                <span>{aviso}</span>
              </li>
            ))}
          </ul>
        </CocoaSection>
      ) : null}

      <CocoaDrawer
        open={selected !== null}
        onClose={() => setSelectedKey(null)}
        title={selected ? `${selected.number ?? SOURCE_TYPE_LABELS[selected.sourceType]}` : "Fila del libro"}
        subtitle={selected ? `${BOOK_LABELS[selected.book]} · ${date(selected.date, "medium")}` : undefined}
        side="right"
        size="md"
        footer={
          <CocoaButton variant="bordered" tone="neutral" onClick={() => setSelectedKey(null)}>
            {ACTIONS.close}
          </CocoaButton>
        }
      >
        {selected ? (
          <div className="cocoa-stack" data-gap="3">
            <CocoaStat label="Base imponible" value={money(selected.base)} size="large" />
            <CocoaStat label="Tipo" value={percent(selected.rate, { maximumFractionDigits: 2 })} />
            <CocoaStat label="Cuota" value={money(selected.quota)} />
            <CocoaStat label="Total" value={money(selected.total)} />
            {selected.retention !== 0 ? <CocoaStat label="Retención practicada" value={money(selected.retention)} /> : null}
            {selected.surchargeRate !== null ? <CocoaStat label="Recargo de equivalencia" value={`${percent(selected.surchargeRate, { maximumFractionDigits: 2 })} · ${money(selected.surchargeQuota ?? 0)}`} /> : null}
            <CocoaStat label="Contraparte" value={selected.counterpartyName ?? "—"} hint={selected.counterpartyNif ?? "Sin NIF"} tabular={false} />
            <CocoaStat label="Serie y número" value={`${selected.series ?? "—"} · ${selected.number ?? "—"}`} tabular={false} />
            <CocoaStat label="Origen" value={SOURCE_TYPE_LABELS[selected.sourceType] ?? selected.sourceType} hint={selected.sourceId} tabular={false} />
            <CocoaStat label="Figura impositiva" value={selected.taxFigure} tabular={false} />
            <CocoaStat label="Deducible" value={selected.deductible ? "Sí" : "No"} tone={selected.deductible ? undefined : "warning"} tabular={false} />
            <CocoaStat label="Periodo de liquidación" value={selected.period} />
            <CocoaStat label="Centro de trabajo" value={centreNameFor(finance.structure, selected.propertyId)} tabular={false} />
            <CocoaStat label="Fila" value={selected.id ? "Materializada en el libro" : "Derivada del documento (sin materializar)"} tone={selected.id ? undefined : "warning"} tabular={false} />
          </div>
        ) : null}
      </CocoaDrawer>

      <CocoaDialog
        open={askRebuild}
        onClose={() => setAskRebuild(false)}
        tone="destructive"
        title={`¿Reconstruir los libros de ${period}?`}
        description={`Se eliminan las filas materializadas de los tres libros en ${periodRangeLabel(period) ?? period}${propertyId ? ` para ${breakdownName}` : " de toda la sociedad"} y se vuelven a generar desde los documentos. Los modelos leerán después las filas guardadas; los importes solo cambian si los documentos han cambiado.`}
        confirmLabel="Reconstruir libros"
        busy={rebuilding}
        onConfirm={rebuild}
      />
    </CocoaPage>
  );
}

export default VatBooksScreen;

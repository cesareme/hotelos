// Diario — Finanzas › Contabilidad › Diario (/finanzas/contabilidad; base tab
// of ContabilidadTabs). Cocoa 22 · lote 6-C, archetype «lista / tabla»
// (docs/design/COCOA-22.md §4): CocoaPage → CocoaToolbar (fecha · origen ·
// estado · cuenta · propiedad · texto libre) → CocoaSection padding none →
// CocoaTable (a row opens the entry drawer with its lines) → footer «N de M»
// with «Cargar más» over the keyset cursor of GET /accounting/journal.
//
// Actions: «Nuevo asiento» (manual entry drawer, high risk: a CocoaDialog
// confirms before POST /accounting/journal), «Anular» (marked reversal with a
// reason and an optional date, POST /accounting/journal/:id/reverse — nothing
// is ever deleted) and «Exportar CSV» (GET /accounting/journal/export with the
// same filters). Typed 4xx (details.code) are mapped to Spanish through
// accountingErrorMessage; FISCAL_YEAR_CLOSED offers the link to Cierre de
// ejercicio and CHART_NOT_PROVISIONED the link to Ajustes.
//
// Deep links: ?asiento=<id> (or #<id> from navigateTo) opens an entry; ?cuenta=<código> pre-fills the
// account filter (used by Mayor and Plan de cuentas).

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { ChartAccountView, JournalEntryView, JournalLineView, JournalListQuery, ManualJournalEntryInput } from "@hotelos/shared";
import {
  accountingErrorMessage,
  createManualJournalEntry,
  downloadJournalCsv,
  getJournalEntry,
  listChartAccounts,
  listJournal,
  reverseJournalEntry
} from "../../services/accountingApi";
import { financeErrorCode } from "../../services/finance-contracts";
import { getUser } from "../../services/auth-storage";
import { useNavGate } from "../../navigation/useEnabledModules";
import { urlForScreen } from "../../navigation/nav-tree";
import { useToast } from "../../components/Toast";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { date, money, plural } from "../../lib/format";
import { DownloadIcon, PlusIcon } from "../../components/cocoa-icons/ActionIcons";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaInput,
  CocoaPage,
  CocoaSearchInput,
  CocoaSection,
  CocoaSelect,
  CocoaState,
  CocoaStat,
  CocoaTable,
  CocoaToolbar,
  openTabPath,
  type CocoaTableColumn
} from "../../components/cocoa";
import {
  ENTRY_STATUS_OPTIONS,
  SOURCE_TYPE_OPTIONS,
  accountDisplay,
  actorHint,
  canDo,
  centsToMoneyString,
  chartSelectOptions,
  entryStatusBadge,
  parseMoneyInput,
  readHashParam,
  readQueryParam,
  saveDownload,
  scopeLabel,
  sourceTypeLabel,
  todayIso,
  usePropertyScopeOptions,
  withQuery
} from "./accounting-ui";

const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 300;

type Filters = { from: string; to: string; sourceType: string; status: string; accountCode: string; propertyId: string; q: string };

const EMPTY_FILTERS: Filters = { from: "", to: "", sourceType: "", status: "", accountCode: "", propertyId: "", q: "" };

function toQuery(filters: Filters): Omit<JournalListQuery, "limit" | "cursor"> {
  return {
    from: filters.from || undefined,
    to: filters.to || undefined,
    sourceType: filters.sourceType || undefined,
    status: (filters.status || undefined) as JournalListQuery["status"],
    accountCode: filters.accountCode.trim() || undefined,
    propertyId: filters.propertyId || undefined,
    q: filters.q.trim() || undefined
  };
}

function hasFilters(filters: Filters): boolean {
  return Object.values(filters).some((value) => value !== "");
}

// Secondary line under a cell (documento, cuenta): caption secondary.
const subStyle: CSSProperties = {
  display: "block",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label-secondary)"
};

function entryNumberLabel(entry: Pick<JournalEntryView, "entryNumber" | "fiscalYearCode">): string {
  if (entry.entryNumber === null || entry.entryNumber === undefined) return "Sin numerar";
  return entry.fiscalYearCode ? `${entry.entryNumber} / ${entry.fiscalYearCode}` : String(entry.entryNumber);
}

const COLUMNS: CocoaTableColumn<JournalEntryView>[] = [
  // qa#2: short columns shrink to their content (fit) so the free width goes to
  // «Concepto»; «Origen» is secondary and only shows from 1200 px (showFrom).
  { key: "entryDate", label: "Fecha", fit: true, render: (entry) => date(entry.entryDate, "short") },
  { key: "entryNumber", label: "Nº asiento", fit: true, render: (entry) => entryNumberLabel(entry), hideOnNarrow: true },
  {
    key: "description",
    label: "Concepto",
    minWidth: 200,
    render: (entry) => (
      <>
        <span>{entry.description ?? "—"}</span>
        {entry.reference ? <span style={subStyle}>{entry.reference}</span> : null}
      </>
    )
  },
  { key: "sourceType", label: "Origen", fit: true, showFrom: "desktop", render: (entry) => sourceTypeLabel(entry.sourceType) },
  { key: "totalDebit", label: "Importe", align: "right", fit: true, render: (entry) => money(entry.totalDebit, entry.currencyCode) },
  {
    key: "status",
    label: "Estado",
    fit: true,
    render: (entry) => {
      const badge = entryStatusBadge(entry);
      return <CocoaBadge tone={badge.tone}>{badge.label}</CocoaBadge>;
    }
  }
];

const LINE_COLUMNS: CocoaTableColumn<JournalLineView>[] = [
  {
    key: "accountCode",
    label: "Cuenta",
    render: (line) => (
      <>
        <strong>{line.accountCode}</strong>
        {line.accountName ? <span style={subStyle}>{line.accountName}</span> : null}
      </>
    ),
    footer: "Totales"
  },
  { key: "description", label: "Concepto", render: (line) => line.description ?? "—", hideOnNarrow: true },
  { key: "debit", label: "Debe", align: "right", render: (line) => (line.debit !== "0.00" ? money(line.debit) : "") },
  { key: "credit", label: "Haber", align: "right", render: (line) => (line.credit !== "0.00" ? money(line.credit) : "") }
];

// ---------------------------------------------------------------------------
// Manual entry form (drawer): lines typed as strings, cents for the checks.
// ---------------------------------------------------------------------------

type LineDraft = { key: number; accountCode: string; debit: string; credit: string; description: string };

let lineSeq = 0;
function newLine(): LineDraft {
  lineSeq += 1;
  return { key: lineSeq, accountCode: "", debit: "", credit: "", description: "" };
}

type ManualDraft = { entryDate: string; description: string; reference: string; propertyId: string; lines: LineDraft[] };

function emptyDraft(): ManualDraft {
  return { entryDate: todayIso(), description: "", reference: "", propertyId: "", lines: [newLine(), newLine()] };
}

type DraftCheck = { totalDebit: number; totalCredit: number; errors: string[]; lineErrors: Record<number, string> };

function checkDraft(draft: ManualDraft): DraftCheck {
  const errors: string[] = [];
  const lineErrors: Record<number, string> = {};
  let totalDebit = 0;
  let totalCredit = 0;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.entryDate)) errors.push("Indica la fecha contable del asiento.");
  if (draft.description.trim() === "") errors.push("El concepto del asiento es obligatorio.");
  const filled = draft.lines.filter((line) => line.accountCode || line.debit || line.credit || line.description);
  if (filled.length < 2) errors.push("Un asiento necesita al menos dos líneas con cuenta e importe.");
  for (const line of filled) {
    const debit = parseMoneyInput(line.debit);
    const credit = parseMoneyInput(line.credit);
    if (!line.accountCode) lineErrors[line.key] = "Elige la cuenta.";
    else if (Number.isNaN(debit) || Number.isNaN(credit)) lineErrors[line.key] = "Importe no válido: usa cifras con hasta dos decimales.";
    else if ((debit ?? 0) < 0 || (credit ?? 0) < 0) lineErrors[line.key] = "Los importes no admiten signo negativo: anótalo en la columna contraria.";
    else if ((debit ?? 0) > 0 && (credit ?? 0) > 0) lineErrors[line.key] = "Cada línea lleva importe en el debe o en el haber, no en ambos.";
    else if ((debit ?? 0) === 0 && (credit ?? 0) === 0) lineErrors[line.key] = "Indica el importe en el debe o en el haber.";
    else {
      totalDebit += debit ?? 0;
      totalCredit += credit ?? 0;
    }
  }
  if (Object.keys(lineErrors).length > 0) errors.push("Revisa las líneas marcadas.");
  else if (filled.length >= 2 && totalDebit !== totalCredit) errors.push("El asiento no cuadra: la suma del debe tiene que ser igual a la del haber.");
  return { totalDebit, totalCredit, errors, lineErrors };
}

function draftToInput(draft: ManualDraft): ManualJournalEntryInput {
  const lines = draft.lines
    .filter((line) => line.accountCode)
    .map((line) => {
      const debit = parseMoneyInput(line.debit) ?? 0;
      const credit = parseMoneyInput(line.credit) ?? 0;
      return {
        accountCode: line.accountCode,
        ...(debit > 0 ? { debit: centsToMoneyString(debit) } : {}),
        ...(credit > 0 ? { credit: centsToMoneyString(credit) } : {}),
        ...(line.description.trim() ? { description: line.description.trim() } : {})
      };
    });
  return {
    entryDate: draft.entryDate,
    description: draft.description.trim(),
    ...(draft.reference.trim() ? { reference: draft.reference.trim() } : {}),
    ...(draft.propertyId ? { propertyId: draft.propertyId } : {}),
    lines
  };
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function JournalScreen() {
  // Hosted in ContabilidadTabs the container paints eyebrow («Finanzas») and
  // H1 («Contabilidad»); CocoaPage reads the host context and keeps only the
  // subtitle and the actions. Standalone the page names its base tab.
  const header = { eyebrow: "Finanzas · Contabilidad", title: "Diario" };
  const { showToast } = useToast();
  const gate = useNavGate();
  // Stored session (userId · fullName): names the actor of an entry as «por ti»
  // instead of the raw id when the current user posted it (actorHint).
  const session = useMemo(() => getUser(), []);
  const canPost = canDo(gate, "accounting.journal.post");
  const canReverse = canPost && canDo(gate, "ai.high_risk.confirm");
  const scopeOptions = usePropertyScopeOptions();

  // ---- filters + list -------------------------------------------------------
  const [filters, setFilters] = useState<Filters>(() => ({ ...EMPTY_FILTERS, accountCode: readQueryParam("cuenta") ?? "" }));
  const [items, setItems] = useState<JournalEntryView[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const requestSeq = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback((current: Filters) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    listJournal({ ...toQuery(current), limit: PAGE_SIZE })
      .then((page) => {
        if (seq !== requestSeq.current) return;
        setItems(page.items);
        setTotal(page.total);
        setNextCursor(page.nextCursor);
      })
      .catch((err: unknown) => {
        if (seq !== requestSeq.current) return;
        setError(err);
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => load(filters), SEARCH_DEBOUNCE_MS);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [filters, load]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listJournal({ ...toQuery(filters), limit: PAGE_SIZE, cursor: nextCursor });
      setItems((current) => {
        const seen = new Set(current.map((entry) => entry.id));
        return [...current, ...page.items.filter((entry) => !seen.has(entry.id))];
      });
      setTotal(page.total);
      setNextCursor(page.nextCursor);
    } catch (err) {
      showToast(accountingErrorMessage(err, "No se pudieron cargar más asientos."), { variant: "error" });
    } finally {
      setLoadingMore(false);
    }
  }

  function setFilter<K extends keyof Filters>(key: K, value: Filters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  // ---- chart (account suggestions + manual entry picker) --------------------
  const [chart, setChart] = useState<ChartAccountView[]>([]);
  const [chartError, setChartError] = useState<unknown>(null);
  useEffect(() => {
    let mounted = true;
    listChartAccounts({ postableOnly: true })
      .then((response) => {
        if (mounted) setChart(response.accounts);
      })
      .catch((err: unknown) => {
        if (mounted) setChartError(err);
      });
    return () => {
      mounted = false;
    };
  }, []);
  const accountSuggestions = useMemo(() => chart.map((account) => account.code), [chart]);
  const accountOptions = useMemo(() => chartSelectOptions(chart, { postableOnly: true }), [chart]);

  // ---- entry detail drawer --------------------------------------------------
  const [selected, setSelected] = useState<JournalEntryView | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);

  const openEntry = useCallback(
    async (id: string) => {
      setSelectedLoading(true);
      try {
        setSelected(await getJournalEntry(id));
      } catch (err) {
        showToast(accountingErrorMessage(err, "No se pudo abrir el asiento."), { variant: "error" });
      } finally {
        setSelectedLoading(false);
      }
    },
    [showToast]
  );

  useEffect(() => {
    const deepLinked = readQueryParam("asiento") ?? readHashParam();
    if (deepLinked) void openEntry(deepLinked);
  }, [openEntry]);

  // ---- manual entry ---------------------------------------------------------
  const [manualOpen, setManualOpen] = useState(false);
  const [draft, setDraft] = useState<ManualDraft>(() => emptyDraft());
  const [confirmPost, setConfirmPost] = useState(false);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);
  const check = useMemo(() => checkDraft(draft), [draft]);
  const draftValid = check.errors.length === 0;

  function updateLine(key: number, patch: Partial<LineDraft>) {
    setDraft((current) => ({ ...current, lines: current.lines.map((line) => (line.key === key ? { ...line, ...patch } : line)) }));
  }

  function openManual() {
    setDraft(emptyDraft());
    setPostError(null);
    setTouched(false);
    setManualOpen(true);
  }

  async function postManual() {
    setPosting(true);
    setPostError(null);
    try {
      const posted = await createManualJournalEntry(draftToInput(draft));
      setConfirmPost(false);
      setManualOpen(false);
      showToast(`Asiento ${entryNumberLabel(posted)} contabilizado.`, { variant: "success" });
      load(filters);
      setSelected(posted);
    } catch (err) {
      setConfirmPost(false);
      setPostError(err);
      showToast(accountingErrorMessage(err), { variant: "error" });
    } finally {
      setPosting(false);
    }
  }

  // ---- reversal -------------------------------------------------------------
  const [reversing, setReversing] = useState<JournalEntryView | null>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [reverseDate, setReverseDate] = useState("");
  const [reverseBusy, setReverseBusy] = useState(false);
  const [reverseError, setReverseError] = useState<unknown>(null);

  function openReverse(entry: JournalEntryView) {
    setReversing(entry);
    setReverseReason("");
    setReverseDate(entry.entryDate);
    setReverseError(null);
  }

  async function confirmReverse() {
    if (!reversing) return;
    if (reverseReason.trim() === "") {
      setReverseError(new Error("Indica el motivo de la anulación."));
      return;
    }
    setReverseBusy(true);
    setReverseError(null);
    try {
      const reversal = await reverseJournalEntry(reversing.id, {
        reason: reverseReason.trim(),
        ...(reverseDate && reverseDate !== reversing.entryDate ? { entryDate: reverseDate } : {})
      });
      showToast(`Asiento ${entryNumberLabel(reversing)} anulado con el asiento ${entryNumberLabel(reversal)}.`, { variant: "success" });
      setReversing(null);
      load(filters);
      setSelected(reversal);
    } catch (err) {
      setReverseError(err);
    } finally {
      setReverseBusy(false);
    }
  }

  // ---- export -----------------------------------------------------------------
  const [exporting, setExporting] = useState(false);
  async function exportCsv() {
    setExporting(true);
    try {
      saveDownload(await downloadJournalCsv(toQuery(filters)));
      showToast("Diario exportado en CSV.", { variant: "success" });
    } catch (err) {
      showToast(accountingErrorMessage(err, "No se pudo exportar el diario."), { variant: "error" });
    } finally {
      setExporting(false);
    }
  }

  // ---- derived ------------------------------------------------------------------
  const filtered = hasFilters(filters);
  const ready = !loading && !error && items.length > 0;
  const errorCode = financeErrorCode(error);
  const chartMissing = errorCode === "CHART_NOT_PROVISIONED";
  const settingsUrl = urlForScreen("AccountingSettingsScreen");
  const yearEndUrl = urlForScreen("YearEndCloseScreen");
  const ledgerUrl = urlForScreen("LedgerScreen");

  const canReverseEntry = (entry: JournalEntryView) => canReverse && entry.status === "posted" && !entry.reversedById && !entry.reversalOfId && entry.entryKind !== "reversal";

  const footer = ready ? (
    <>
      <span>
        {items.length}
        {total !== null ? ` de ${total}` : ""} {total === 1 ? "asiento" : "asientos"}
      </span>
      {nextCursor ? (
        <CocoaButton variant="bordered" tone="neutral" size="small" loading={loadingMore} onClick={() => void loadMore()}>
          Cargar más
        </CocoaButton>
      ) : null}
    </>
  ) : undefined;

  let body;
  if (loading && items.length === 0) {
    body = <CocoaTable columns={COLUMNS} rows={[]} loading aria-label="Asientos del diario" />;
  } else if (error) {
    body = (
      <CocoaState
        kind="error"
        title={chartMissing ? "Sin plan de cuentas" : "No se pudo cargar el diario"}
        message={accountingErrorMessage(error)}
        onRetry={() => load(filters)}
        secondaryAction={chartMissing && settingsUrl ? { label: "Ir a Ajustes", onClick: () => openTabPath(settingsUrl) } : undefined}
      />
    );
  } else if (items.length === 0) {
    body = (
      <CocoaState
        kind="empty"
        illustration={filtered ? "search" : "box"}
        title={filtered ? STATUS_LABELS.noResults : "Aún no hay asientos"}
        message={
          filtered
            ? "Ningún asiento coincide con los filtros. Amplía el rango de fechas o quita algún filtro."
            : "Los asientos se generan al emitir facturas, registrar cobros y cerrar comandas; también puedes contabilizar un asiento manual."
        }
        primaryAction={filtered ? { label: ACTIONS.clearFilters, onClick: () => setFilters(EMPTY_FILTERS) } : canPost ? { label: "Nuevo asiento", onClick: openManual } : undefined}
      />
    );
  } else {
    body = (
      <CocoaTable
        columns={COLUMNS}
        rows={items}
        rowKey="id"
        selectedKey={selected?.id}
        onSelect={(entry) => setSelected(entry)}
        rowActions={(entry) =>
          canReverseEntry(entry) ? (
            <CocoaButton
              variant="plain"
              tone="destructive"
              size="small"
              onClick={(event) => {
                event.stopPropagation();
                openReverse(entry);
              }}
            >
              Anular
            </CocoaButton>
          ) : null
        }
        caption="Asientos del diario"
        aria-label="Asientos del diario"
      />
    );
  }

  const postErrorCode = financeErrorCode(postError);

  return (
    <CocoaPage
      eyebrow={header.eyebrow}
      title={header.title}
      subtitle="Libro diario de la organización: cada asiento con su número, fecha contable, origen y estado. Nada se borra: una anulación es otro asiento."
      actions={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" icon={<DownloadIcon size={14} aria-hidden="true" />} loading={exporting} onClick={() => void exportCsv()}>
            Exportar CSV
          </CocoaButton>
          {canPost ? (
            <CocoaButton variant="filled" tone="accent" size="small" icon={<PlusIcon size={14} aria-hidden="true" />} onClick={openManual}>
              Nuevo asiento
            </CocoaButton>
          ) : null}
        </>
      }
      commands={[
        { id: "journal-export-csv", label: "Exportar el diario en CSV", run: () => void exportCsv() },
        ...(canPost ? [{ id: "journal-new-entry", label: "Nuevo asiento manual", run: openManual }] : []),
        { id: "journal-refresh", label: "Actualizar el diario", run: () => load(filters) }
      ]}
      id="journal-screen"
    >
      <CocoaToolbar
        variant="content"
        wrap
        aria-label="Filtros del diario"
        leftSlot={
          <div className="cocoa-row" data-gap="2" data-align="end">
            <CocoaField label="Desde">
              <CocoaDatePicker value={filters.from} onChange={(value) => setFilter("from", value)} size="small" aria-label="Fecha contable desde" />
            </CocoaField>
            <CocoaField label="Hasta">
              <CocoaDatePicker value={filters.to} onChange={(value) => setFilter("to", value)} size="small" aria-label="Fecha contable hasta" />
            </CocoaField>
            <CocoaField label="Origen">
              <CocoaSelect value={filters.sourceType} onChange={(value) => setFilter("sourceType", value)} options={[...SOURCE_TYPE_OPTIONS]} placeholder="Todos los orígenes" size="small" aria-label="Filtrar por origen" />
            </CocoaField>
            <CocoaField label="Estado">
              <CocoaSelect value={filters.status} onChange={(value) => setFilter("status", value)} options={[...ENTRY_STATUS_OPTIONS]} placeholder="Todos" size="small" aria-label="Filtrar por estado" />
            </CocoaField>
            <CocoaField label="Cuenta">
              <CocoaInput value={filters.accountCode} onChange={(value) => setFilter("accountCode", value)} suggestions={accountSuggestions} placeholder="4300" size="small" inputMode="decimal" aria-label="Filtrar por código de cuenta" />
            </CocoaField>
            <CocoaField label="Propiedad">
              <CocoaSelect value={filters.propertyId} onChange={(value) => setFilter("propertyId", value)} options={scopeOptions} size="small" aria-label="Filtrar por propiedad" />
            </CocoaField>
          </div>
        }
        rightSlot={
          <div className="cocoa-row" data-gap="2">
            <CocoaSearchInput value={filters.q} onChange={(value) => setFilter("q", value)} placeholder="Concepto, documento o referencia…" aria-label="Buscar en concepto, documento o referencia" />
            {filtered ? (
              <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setFilters(EMPTY_FILTERS)}>
                {ACTIONS.clearFilters}
              </CocoaButton>
            ) : null}
          </div>
        }
      />

      {chartError && !error ? (
        <CocoaCallout tone="warning" title="Plan de cuentas no disponible" role="status">
          {accountingErrorMessage(chartError, "No se pudo cargar el plan de cuentas: el selector de cuentas del asiento manual queda vacío.")}
        </CocoaCallout>
      ) : null}

      <CocoaSection padding={ready ? "none" : "md"} footer={footer} style={{ overflow: "clip" }} aria-label="Asientos del diario">
        {body}
      </CocoaSection>

      {/* ---- Entry detail ------------------------------------------------- */}
      <CocoaDrawer
        open={selected !== null || selectedLoading}
        onClose={() => setSelected(null)}
        title={selected ? `Asiento ${entryNumberLabel(selected)}` : STATUS_LABELS.loading}
        subtitle={selected ? `${date(selected.entryDate, "long")} · ${sourceTypeLabel(selected.sourceType)}` : undefined}
        side="right"
        size="lg"
        footer={
          <>
            {selected && canReverseEntry(selected) ? (
              <CocoaButton variant="bordered" tone="destructive" onClick={() => openReverse(selected)}>
                Anular asiento
              </CocoaButton>
            ) : null}
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setSelected(null)}>
              {ACTIONS.close}
            </CocoaButton>
          </>
        }
      >
        {selected ? (
          <div className="cocoa-stack" data-gap="4">
            <div className="cocoa-row" data-gap="4" data-align="start">
              <CocoaStat label="Importe" value={money(selected.totalDebit, selected.currencyCode)} size="large" />
              <CocoaStat label="Estado" value={<CocoaBadge tone={entryStatusBadge(selected).tone}>{entryStatusBadge(selected).label}</CocoaBadge>} tabular={false} />
              <CocoaStat label="Documento" value={selected.reference ?? "—"} tabular={false} />
              <CocoaStat label="Propiedad" value={scopeLabel(scopeOptions, selected.propertyId)} tabular={false} />
              {selected.postedAt ? <CocoaStat label="Contabilizado" value={date(selected.postedAt, "short")} hint={actorHint(selected.createdBy, session)} /> : null}
            </div>
            <p className="cocoa-caption">{selected.description ?? "Sin concepto"}</p>
            {selected.reversedById ? (
              <CocoaCallout
                tone="danger"
                title="Asiento anulado"
                actions={
                  <CocoaButton variant="plain" size="small" onClick={() => void openEntry(selected.reversedById!)}>
                    Ver asiento de anulación
                  </CocoaButton>
                }
              >
                Sus importes quedan compensados por el asiento de anulación; ambos se conservan en el libro.
              </CocoaCallout>
            ) : null}
            {selected.reversalOfId ? (
              <CocoaCallout
                tone="info"
                title="Asiento de anulación"
                actions={
                  <CocoaButton variant="plain" size="small" onClick={() => void openEntry(selected.reversalOfId!)}>
                    Ver asiento original
                  </CocoaButton>
                }
              >
                Invierte línea a línea el asiento original.
              </CocoaCallout>
            ) : null}
            <CocoaSection title="Apuntes" meta={plural(selected.lines.length, "línea", "líneas")} padding="none" style={{ overflow: "clip" }}>
              <CocoaTable
                columns={LINE_COLUMNS}
                rows={selected.lines}
                rowKey="id"
                density="compact"
                footer={{ accountCode: "Totales", debit: money(selected.totalDebit, selected.currencyCode), credit: money(selected.totalCredit, selected.currencyCode) }}
                onSelect={ledgerUrl ? (line) => openTabPath(withQuery(ledgerUrl, { cuenta: line.accountCode })) : undefined}
                rowTitle={() => "Abrir el mayor de la cuenta"}
                caption="Apuntes del asiento"
                aria-label="Apuntes del asiento"
              />
            </CocoaSection>
          </div>
        ) : (
          <CocoaState kind="loading" inline title={STATUS_LABELS.loading} />
        )}
      </CocoaDrawer>

      {/* ---- Manual entry (high risk) --------------------------------------- */}
      <CocoaDrawer
        open={manualOpen}
        onClose={() => setManualOpen(false)}
        title="Nuevo asiento manual"
        subtitle="Al menos dos líneas con importes positivos en el debe o en el haber; el asiento tiene que cuadrar."
        side="right"
        size="lg"
        focusKey={manualOpen}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setManualOpen(false)} disabled={posting}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton
              variant="filled"
              tone="accent"
              disabled={posting || (touched && !draftValid)}
              onClick={() => {
                setTouched(true);
                if (draftValid) setConfirmPost(true);
              }}
            >
              Contabilizar…
            </CocoaButton>
          </>
        }
      >
        <div className="cocoa-stack" data-gap="4">
          <CocoaFormRow columns={2}>
            <CocoaField label="Fecha contable" required help="Fija el ejercicio y el periodo del asiento.">
              <CocoaDatePicker value={draft.entryDate} onChange={(value) => setDraft((current) => ({ ...current, entryDate: value }))} />
            </CocoaField>
            <CocoaField label="Propiedad" help="Sin propiedad, el asiento es de toda la organización.">
              <CocoaSelect value={draft.propertyId} onChange={(value) => setDraft((current) => ({ ...current, propertyId: value }))} options={scopeOptions} />
            </CocoaField>
            <CocoaField label="Concepto" required fullWidth>
              <CocoaInput value={draft.description} onChange={(value) => setDraft((current) => ({ ...current, description: value }))} placeholder="Reclasificación de clientes 430 a 4300" maxLength={500} />
            </CocoaField>
            <CocoaField label="Documento" hint="opcional" fullWidth>
              <CocoaInput value={draft.reference} onChange={(value) => setDraft((current) => ({ ...current, reference: value }))} placeholder="Número de factura, contrato o nota interna" maxLength={200} />
            </CocoaField>
          </CocoaFormRow>

          <CocoaSection
            title="Líneas"
            meta={plural(draft.lines.length, "línea", "líneas")}
            action={
              <CocoaButton variant="plain" size="small" icon={<PlusIcon size={14} aria-hidden="true" />} onClick={() => setDraft((current) => ({ ...current, lines: [...current.lines, newLine()] }))}>
                Añadir línea
              </CocoaButton>
            }
          >
            {draft.lines.map((line, index) => (
              <CocoaFormRow key={line.key} columns={4} min={140}>
                <CocoaField label={`Cuenta ${index + 1}`} error={touched ? check.lineErrors[line.key] : undefined}>
                  <CocoaSelect value={line.accountCode} onChange={(value) => updateLine(line.key, { accountCode: value })} options={accountOptions} placeholder="Elegir cuenta…" size="small" />
                </CocoaField>
                <CocoaField label="Debe">
                  <CocoaInput value={line.debit} onChange={(value) => updateLine(line.key, { debit: value })} inputMode="decimal" placeholder="0,00" size="small" rightSlot={<span aria-hidden="true">€</span>} />
                </CocoaField>
                <CocoaField label="Haber">
                  <CocoaInput value={line.credit} onChange={(value) => updateLine(line.key, { credit: value })} inputMode="decimal" placeholder="0,00" size="small" rightSlot={<span aria-hidden="true">€</span>} />
                </CocoaField>
                <CocoaField label="Concepto de la línea" hint="opcional">
                  <div className="cocoa-row" data-gap="1" data-wrap="nowrap">
                    <CocoaInput value={line.description} onChange={(value) => updateLine(line.key, { description: value })} size="small" maxLength={500} aria-label={`Concepto de la línea ${index + 1}`} />
                    {draft.lines.length > 2 ? (
                      <CocoaButton variant="plain" tone="neutral" size="small" aria-label={`Quitar la línea ${index + 1}`} onClick={() => setDraft((current) => ({ ...current, lines: current.lines.filter((candidate) => candidate.key !== line.key) }))}>
                        {ACTIONS.remove}
                      </CocoaButton>
                    ) : null}
                  </div>
                </CocoaField>
              </CocoaFormRow>
            ))}
            <div className="cocoa-row" data-gap="4" data-justify="end">
              <CocoaStat label="Suma del debe" value={money(check.totalDebit / 100)} align="right" />
              <CocoaStat label="Suma del haber" value={money(check.totalCredit / 100)} align="right" />
              <CocoaStat label="Diferencia" value={money((check.totalDebit - check.totalCredit) / 100)} tone={check.totalDebit === check.totalCredit ? "success" : "danger"} align="right" />
            </div>
          </CocoaSection>

          {touched && check.errors.length > 0 ? (
            <CocoaCallout tone="warning" title="Antes de contabilizar" role="alert">
              <ul className="c22-section__list">
                {check.errors.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </CocoaCallout>
          ) : null}

          {postError ? (
            <CocoaCallout
              tone="danger"
              title="No se pudo contabilizar"
              role="alert"
              actions={
                postErrorCode === "FISCAL_YEAR_CLOSED" && yearEndUrl ? (
                  <CocoaButton variant="plain" size="small" onClick={() => openTabPath(yearEndUrl)}>
                    Ir a Cierre de ejercicio
                  </CocoaButton>
                ) : postErrorCode === "CHART_NOT_PROVISIONED" && settingsUrl ? (
                  <CocoaButton variant="plain" size="small" onClick={() => openTabPath(settingsUrl)}>
                    Ir a Ajustes
                  </CocoaButton>
                ) : undefined
              }
            >
              {accountingErrorMessage(postError)}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaDrawer>

      <CocoaDialog
        open={confirmPost}
        onClose={() => setConfirmPost(false)}
        title="¿Contabilizar el asiento?"
        description={`Operación de alto riesgo: el asiento queda numerado en el ejercicio con fecha ${date(draft.entryDate, "long")} por ${money(check.totalDebit / 100)} y solo se puede deshacer con un asiento de anulación.`}
        confirmLabel="Contabilizar"
        cancelLabel={ACTIONS.cancel}
        busy={posting}
        onConfirm={postManual}
      >
        <ul className="c22-section__list">
          {draft.lines
            .filter((line) => line.accountCode)
            .map((line) => (
              <li key={line.key}>
                <span>{accountDisplay(chart, line.accountCode)}</span>
                <strong>{line.debit ? `Debe ${money((parseMoneyInput(line.debit) ?? 0) / 100)}` : `Haber ${money((parseMoneyInput(line.credit) ?? 0) / 100)}`}</strong>
              </li>
            ))}
        </ul>
      </CocoaDialog>

      {/* ---- Reversal -------------------------------------------------------- */}
      <CocoaDialog
        open={reversing !== null}
        onClose={() => setReversing(null)}
        tone="destructive"
        title={reversing ? `¿Anular el asiento ${entryNumberLabel(reversing)}?` : "¿Anular el asiento?"}
        description="Se contabiliza un asiento de anulación que invierte cada línea; el original se conserva marcado como anulado. Si el documento ya se declaró, emite una rectificativa en lugar de anular."
        confirmLabel="Anular asiento"
        cancelLabel={ACTIONS.cancel}
        busy={reverseBusy}
        onConfirm={confirmReverse}
        size="md"
      >
        <div className="cocoa-stack" data-gap="3">
          <CocoaField label="Motivo" required error={reverseError && reverseReason.trim() === "" ? "Indica el motivo de la anulación." : undefined}>
            <CocoaInput value={reverseReason} onChange={setReverseReason} multiline rows={3} placeholder="Factura duplicada, importe erróneo, cobro contabilizado dos veces…" maxLength={500} />
          </CocoaField>
          <CocoaField label="Fecha de la anulación" help="Con la fecha del original la anulación cae en su mismo periodo; con la de hoy, en el periodo actual.">
            <CocoaDatePicker value={reverseDate} onChange={setReverseDate} />
          </CocoaField>
          {reverseError && reverseReason.trim() !== "" ? (
            <CocoaCallout
              tone="danger"
              title="No se pudo anular"
              role="alert"
              actions={
                financeErrorCode(reverseError) === "FISCAL_YEAR_CLOSED" && yearEndUrl ? (
                  <CocoaButton variant="plain" size="small" onClick={() => openTabPath(yearEndUrl)}>
                    Ir a Cierre de ejercicio
                  </CocoaButton>
                ) : undefined
              }
            >
              {accountingErrorMessage(reverseError)}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaDialog>
    </CocoaPage>
  );
}

export default JournalScreen;

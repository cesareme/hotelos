// Informe de sostenibilidad CSRD / ESRS — /cumplimiento/sostenibilidad/esrs
// (Cocoa 22 · ola 8 · lote 8-C, plantilla DashboardAlojado; hosted in SostenibilidadTabs).
//
// The chain enters the indicators (IoT meters can feed them once connected);
// the system computes the completeness of the mandatory disclosures, groups
// them by standard and generates a report signed with an integrity hash.
//
// Page: fiscal year + «Generar informe» in the actions row → KPI strip
// (completeness, reported, active standards) → the generated report as a
// CocoaCallout → one CocoaSection per ESRS standard with its CocoaTable
// (row action «Editar» / «Reportar») → the value prompt is a CocoaDialog
// whose confirm awaits the upsert (`busy`).

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { getActiveOrganizationId } from "../../services/activeProperty";
import { fetchCatalog, fetchIndicators, generateReport, upsertIndicator, type EsrsDisclosure, type EsrsIndicator, type EsrsReportSummary } from "../../services/esrsApi";
import { number, percent, plural, toNumber } from "../../lib/format";
import { ACTIONS, UI_STATES } from "../../content/actions";
import { treeHeaderFor } from "../tabs/tab-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDialog,
  CocoaField,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn
} from "../../components/cocoa";

const ORG_ID = getActiveOrganizationId();
// Menu labels of the tree (Cumplimiento › Sostenibilidad › Informe ESRS), never retyped here.
const HEADER = treeHeaderFor("EsrsReport", { eyebrow: "Cumplimiento · Sostenibilidad", title: "Informe ESRS" });

const STANDARD_LABEL: Record<string, string> = {
  ESRS_E1: "Cambio climático",
  ESRS_E3: "Recursos hídricos",
  ESRS_E5: "Economía circular",
  ESRS_S1: "Plantilla propia",
  ESRS_G1: "Conducta empresarial"
};

const YEAR_OPTIONS = ["2023", "2024", "2025", "2026"].map((year) => ({ value: year, label: year }));

/** A catalogue disclosure with the indicator reported for the selected year (null when nothing was reported). */
type DisclosureRow = EsrsDisclosure & { indicator: EsrsIndicator | null };

/** Value cell of a reported indicator: the figure with its unit, or the free text. */
function indicatorValue(indicator: EsrsIndicator): string {
  if (indicator.numericValue !== null && indicator.numericValue !== undefined) {
    return `${number(indicator.numericValue)}${indicator.unit ? ` ${indicator.unit}` : ""}`;
  }
  return indicator.textValue ?? "—";
}

/** Value the prompt starts from: the reported figure or text, empty when nothing was reported yet. */
function initialDraft(indicator: EsrsIndicator | null): string {
  if (!indicator) return "";
  if (indicator.numericValue !== null && indicator.numericValue !== undefined) return String(indicator.numericValue);
  return indicator.textValue ?? "";
}

// Columns outside the component (A5): code and unit fit their content, the description takes the free width.
const DISCLOSURE_COLUMNS: CocoaTableColumn<DisclosureRow>[] = [
  {
    key: "code",
    label: "Disclosure",
    fit: true,
    render: (row) => (
      <strong>
        {row.code}
        {row.required ? " *" : ""}
      </strong>
    )
  },
  { key: "description", label: "Descripción", minWidth: 240 },
  { key: "unit", label: "Unidad", fit: true, hideOnNarrow: true },
  { key: "value", label: "Valor", align: "right", fit: true, render: (row) => (row.indicator ? <strong>{indicatorValue(row.indicator)}</strong> : "—") },
  { key: "source", label: "Origen", showFrom: "desktop", render: (row) => row.indicator?.source ?? "—" }
];

// Mirror skeleton: the KPI strip and one standard card.
function EsrsSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={3} />
      <CocoaSkeleton variant="card" height={260} />
    </div>
  );
}

export function EsrsReportScreen() {
  // Hosted in SostenibilidadTabs: CocoaPage reads the host context itself and
  // paints only the subtitle and the actions row under the container's head.
  const [year, setYear] = useState<string>(String(new Date().getUTCFullYear() - 1));
  const [catalog, setCatalog] = useState<EsrsDisclosure[]>([]);
  const [indicators, setIndicators] = useState<EsrsIndicator[]>([]);
  const [summary, setSummary] = useState<EsrsReportSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [editing, setEditing] = useState<DisclosureRow | null>(null);
  const [draftValue, setDraftValue] = useState<string>("");
  const valueRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [cat, inds] = await Promise.all([fetchCatalog(), fetchIndicators(ORG_ID, year)]);
      setCatalog(cat);
      setIndicators(inds);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error.");
    } finally {
      setLoading(false);
    }
  }, [year]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const indByCode = useMemo(() => new Map(indicators.map((i) => [i.disclosureCode, i])), [indicators]);
  const rowsByStandard = useMemo(() => {
    const m = new Map<string, DisclosureRow[]>();
    for (const d of catalog) {
      const arr = m.get(d.standard) ?? [];
      arr.push({ ...d, indicator: indByCode.get(d.code) ?? null });
      m.set(d.standard, arr);
    }
    return m;
  }, [catalog, indByCode]);

  const reqCount = catalog.filter((d) => d.required).length;
  const reportedReq = catalog.filter((d) => d.required && indByCode.has(d.code)).length;
  const completeness = reqCount > 0 ? Math.round((reportedReq / reqCount) * 1000) / 10 : 0;
  const missingReq = reqCount - reportedReq;

  function openEdit(row: DisclosureRow) {
    setEditing(row);
    setDraftValue(initialDraft(row.indicator));
  }

  function closeEdit() {
    if (busy) return;
    setEditing(null);
    setDraftValue("");
  }

  async function handleSave() {
    if (!editing) return;
    const val = draftValue.trim();
    if (!val) return;
    setBusy(true);
    try {
      const numeric = toNumber(val);
      const isNumeric = numeric !== null && editing.unit !== "n/a";
      await upsertIndicator({
        organizationId: ORG_ID,
        fiscalYear: year,
        standardCode: editing.standard,
        disclosureCode: editing.code,
        ...(isNumeric ? { numericValue: numeric } : { textValue: val }),
        unit: editing.unit
      });
      setEditing(null);
      setDraftValue("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error guardando.");
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerate() {
    setBusy(true);
    try {
      const r = await generateReport(ORG_ID, year);
      setSummary(r.summary);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error generando informe.");
    } finally {
      setBusy(false);
    }
  }

  function submitOnEnter(event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) {
    if (event.key !== "Enter" || busy || !draftValue.trim()) return;
    event.preventDefault();
    void handleSave();
  }

  const actions = (
    <>
      <CocoaSelect size="small" inline aria-label="Ejercicio" value={year} onChange={setYear} options={YEAR_OPTIONS} disabled={busy} />
      <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void refresh()} disabled={loading || busy}>
        {ACTIONS.refresh}
      </CocoaButton>
      <CocoaButton variant="filled" tone="accent" size="small" onClick={() => void handleGenerate()} loading={busy && editing === null} disabled={busy}>
        Generar informe
      </CocoaButton>
    </>
  );

  return (
    <CocoaPage
      eyebrow={HEADER.eyebrow}
      title={HEADER.title}
      subtitle="Indicadores obligatorios bajo la directiva CSRD. Grandes empresas reportan datos del ejercicio anterior antes de fin del año en curso. Datos firmados con hash de integridad para auditoría externa."
      actions={actions}
      state={loading && catalog.length === 0 ? "loading" : "ready"}
      skeleton={<EsrsSkeleton />}
      commands={[
        { id: "esrs-refresh", label: "Actualizar el informe ESRS", run: () => void refresh() },
        { id: "esrs-generate", label: `Generar informe ESRS ${year}`, run: () => void handleGenerate() }
      ]}
    >
      {error ? (
        <CocoaCallout
          tone="danger"
          role="alert"
          title={UI_STATES.error.title}
          actions={
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => void refresh()}>
              {ACTIONS.retry}
            </CocoaButton>
          }
        >
          {error}
        </CocoaCallout>
      ) : null}

      <CocoaKpiStrip stagger aria-label={`Cumplimiento ESRS del ejercicio ${year}`}>
        <CocoaKpi
          label="Cumplimiento"
          value={percent(completeness, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}
          caption={completeness === 100 ? "completo" : `faltan ${plural(missingReq, "obligatorio", "obligatorios", { withCount: true })}`}
          status={completeness === 100 ? "ok" : completeness >= 80 ? "ok" : "warning"}
          polarity="neutral"
        />
        <CocoaKpi label="Reportados" value={indicators.length} caption={plural(reqCount, "obligatorio", "obligatorios", { withCount: true })} polarity="neutral" />
        <CocoaKpi label="Estándares activos" value={rowsByStandard.size} caption="ESRS" polarity="neutral" />
      </CocoaKpiStrip>

      {summary ? (
        <CocoaCallout tone={summary.completenessPct === 100 ? "success" : "info"} title="Informe generado" role="status">
          <strong>{percent(summary.completenessPct, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</strong> de cumplimiento sobre disclosures obligatorios (
          {summary.reportedRequired}/{summary.requiredDisclosures}). Estado: <strong>{summary.completenessPct === 100 ? "Listo para enviar" : "Borrador"}</strong>.
        </CocoaCallout>
      ) : null}

      {!loading && catalog.length === 0 ? (
        <CocoaSection aria-label="Catálogo ESRS">
          <CocoaState kind="empty" title="Sin catálogo ESRS" message="El catálogo de disclosures no devolvió ningún estándar para este ejercicio." onRetry={() => void refresh()} />
        </CocoaSection>
      ) : null}

      {[...rowsByStandard.entries()].map(([std, rows]) => {
        const reportedHere = rows.filter((row) => row.indicator !== null).length;
        return (
          <CocoaSection
            key={std}
            title={`${std} · ${STANDARD_LABEL[std] ?? std}`}
            meta={
              <CocoaBadge tone={reportedHere === rows.length ? "success" : "info"} variant="dot">
                {reportedHere}/{rows.length} reportados
              </CocoaBadge>
            }
            padding="none"
            style={{ overflow: "clip" }}
          >
            <CocoaTable
              columns={DISCLOSURE_COLUMNS}
              rows={rows}
              rowKey="code"
              rowActionsVisible="always"
              rowActions={(row) => (
                <CocoaButton
                  variant="plain"
                  size="small"
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation();
                    openEdit(row);
                  }}
                >
                  {row.indicator ? ACTIONS.edit : "Reportar"}
                </CocoaButton>
              )}
              caption={`Disclosures de ${std}`}
              aria-label={`Disclosures de ${std}`}
            />
          </CocoaSection>
        );
      })}

      <p className="cocoa-caption">* = disclosure obligatorio bajo CSRD. Los datos no obligatorios mejoran la calidad del informe pero no se exige reportarlos.</p>

      <CocoaDialog
        open={editing !== null}
        onClose={closeEdit}
        title={editing ? `${editing.code} · ${STANDARD_LABEL[editing.standard] ?? editing.standard}` : "Indicador"}
        description={editing?.description}
        confirmLabel={ACTIONS.save}
        busy={busy}
        confirmDisabled={!draftValue.trim()}
        onConfirm={handleSave}
        initialFocus={() => valueRef.current?.querySelector("input")}
      >
        {editing ? (
          <div ref={valueRef}>
            <CocoaField label={`Valor en ${editing.unit}`} required help={`Unidad: ${editing.unit}. Un valor numérico se guarda como cifra; el resto, como texto.`}>
              <CocoaInput
                value={draftValue}
                onChange={setDraftValue}
                placeholder={`Valor en ${editing.unit}`}
                inputMode={editing.unit === "n/a" ? "text" : "decimal"}
                onKeyDown={submitOnEnter}
                disabled={busy}
              />
            </CocoaField>
          </div>
        ) : null}
      </CocoaDialog>
    </CocoaPage>
  );
}

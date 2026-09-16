// Pérdidas y ganancias — Finanzas › Estados contables › Pérdidas y ganancias
// (/finanzas/estados-contables/perdidas-y-ganancias, hosted in
// EstadosContablesTabs). Cocoa 22 · lote 6-C, archetype «dashboard».
//
// GET /accounting/annual-accounts/pyg?from&to[&propertyId][&comparative=1]:
// the PGC Pymes account (income positive, expenses negative, subtotals from
// the ledger with the single reading rule of the statements) for an inclusive
// date range chosen with a preset (ejercicio · trimestre · mes) or by hand,
// with the previous period as comparative. CocoaKpiStrip (ingresos · gastos ·
// explotación · financiero · antes de impuestos · resultado) → CocoaTable of
// the model lines (a row opens the drawer with the PGC accounts behind it) →
// warnings of the API as callouts. «Descargar» fetches the same statement as
// pdf / xlsx / csv through the API (no client-side rendering).

import { useEffect, useMemo, useState } from "react";
import type { PgcProfitAndLoss, StatementAccountAmount, StatementLine } from "@hotelos/shared";
import { downloadStatement, getProfitAndLoss, statementsErrorMessage } from "../../services/financialStatementsApi";
import { useToast } from "../../components/Toast";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { date, dateTime, money, plural } from "../../lib/format";
import { DownloadIcon } from "../../components/cocoa-icons/ActionIcons";
import { treeHeaderFor } from "../tabs/tab-helpers";
import {
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDrawer,
  CocoaField,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaStat,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  CocoaToolbar,
  type CocoaTableColumn
} from "../../components/cocoa";
import { firstDayOfYear, lastDayOfYear, readQueryParam, saveDownload, scopeLabel, signTone, usePropertyScopeOptions } from "../accounting/accounting-ui";
import { DOWNLOAD_FORMAT_OPTIONS, PERIOD_PRESET_OPTIONS, isDownloadFormat, isMeaningfulLine, presetOf, presetRange, statementColumns, type DateRange, type PeriodPresetKey } from "./statement-ui";

const ACCOUNT_COLUMNS: CocoaTableColumn<StatementAccountAmount>[] = [
  { key: "code", label: "Cuenta", width: "10ch", render: (row) => row.code },
  { key: "name", label: "Nombre", render: (row) => row.name },
  { key: "amount", label: "Importe", align: "right", render: (row) => money(row.amount) }
];

function ProfitAndLossSkeleton() {
  return (
    <div className="cocoa-stack" data-gap="4" aria-hidden="true">
      <CocoaSkeleton.Strip count={6} />
      <CocoaSkeleton.Grid rows={[[12]]} height={420} />
    </div>
  );
}

export function ProfitAndLossScreen() {
  const header = treeHeaderFor("ProfitAndLossScreen", { eyebrow: "Finanzas · Estados contables", title: "Pérdidas y ganancias" });
  const { showToast } = useToast();
  const scopeOptions = usePropertyScopeOptions();

  const [range, setRange] = useState<DateRange>(() => ({ from: readQueryParam("desde") ?? firstDayOfYear(), to: readQueryParam("hasta") ?? lastDayOfYear() }));
  const [comparative, setComparative] = useState(false);
  const [propertyId, setPropertyId] = useState(readQueryParam("propiedad") ?? "");
  const [showZero, setShowZero] = useState(false);
  const preset = presetOf(range);

  const [report, setReport] = useState<PgcProfitAndLoss | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getProfitAndLoss({ from: range.from, to: range.to, propertyId: propertyId || undefined, comparative })
      .then((view) => {
        if (!cancelled) setReport(view);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [range.from, range.to, propertyId, comparative, nonce]);

  const [format, setFormat] = useState("pdf");
  const [downloading, setDownloading] = useState(false);
  async function download() {
    if (!isDownloadFormat(format)) return;
    setDownloading(true);
    try {
      saveDownload(await downloadStatement("pyg", { from: range.from, to: range.to, propertyId: propertyId || undefined, comparative }, format));
    } catch (err) {
      showToast(statementsErrorMessage(err, "No se pudo descargar la cuenta de pérdidas y ganancias."), { variant: "error" });
    } finally {
      setDownloading(false);
    }
  }

  const [selected, setSelected] = useState<StatementLine | null>(null);
  const columns = useMemo(() => statementColumns(comparative), [comparative]);
  const lines = useMemo(() => (report ? report.lines.filter((line) => showZero || isMeaningfulLine(line)) : []), [report, showZero]);
  const hiddenLines = report ? report.lines.length - lines.length : 0;

  const k = report;
  const state = loading && !k ? "loading" : error && !k ? "error" : "ready";

  return (
    <CocoaPage
      eyebrow={header.eyebrow}
      title={header.title}
      subtitle={k ? `Modelo de Pymes desde el libro diario · ${scopeLabel(scopeOptions, k.propertyId)} · generado ${dateTime(k.generatedAt)}` : "Cuenta de pérdidas y ganancias del PGC de Pymes calculada desde el libro diario."}
      actions={
        <div className="cocoa-row" data-gap="2" data-wrap="nowrap">
          <CocoaSelect value={format} onChange={setFormat} options={[...DOWNLOAD_FORMAT_OPTIONS]} size="small" aria-label="Formato de descarga" />
          <CocoaButton variant="bordered" tone="neutral" size="small" icon={<DownloadIcon size={14} aria-hidden="true" />} loading={downloading} disabled={!k} onClick={() => void download()}>
            {ACTIONS.download}
          </CocoaButton>
        </div>
      }
      state={state}
      skeleton={<ProfitAndLossSkeleton />}
      error={{ title: "No se pudo calcular la cuenta de pérdidas y ganancias", message: statementsErrorMessage(error), onRetry: () => setNonce((n) => n + 1) }}
      commands={[
        { id: "pyg-download", label: "Descargar pérdidas y ganancias", run: () => void download() },
        { id: "pyg-refresh", label: "Recalcular pérdidas y ganancias", run: () => setNonce((n) => n + 1) }
      ]}
      id="profit-and-loss-screen"
    >
      <CocoaToolbar
        variant="content"
        wrap
        aria-label="Periodo y ámbito"
        leftSlot={
          <div className="cocoa-row" data-gap="2" data-align="end">
            <CocoaField label="Periodo">
              <CocoaSelect value={preset} onChange={(value) => setRange((current) => presetRange(value as PeriodPresetKey, current))} options={[...PERIOD_PRESET_OPTIONS]} size="small" aria-label="Periodo predefinido" />
            </CocoaField>
            <CocoaField label="Desde">
              <CocoaDatePicker value={range.from} onChange={(value) => setRange((current) => ({ ...current, from: value }))} size="small" aria-label="Fecha de inicio" />
            </CocoaField>
            <CocoaField label="Hasta">
              <CocoaDatePicker value={range.to} onChange={(value) => setRange((current) => ({ ...current, to: value }))} size="small" aria-label="Fecha de fin (incluida)" />
            </CocoaField>
            <CocoaField label="Propiedad">
              <CocoaSelect value={propertyId} onChange={setPropertyId} options={scopeOptions} size="small" aria-label="Propiedad" />
            </CocoaField>
          </div>
        }
        rightSlot={
          <div className="cocoa-row" data-gap="4">
            <CocoaField label="Comparar con el periodo anterior" inline>
              <CocoaSwitch checked={comparative} onChange={setComparative} size="small" />
            </CocoaField>
            <CocoaField label="Partidas a cero" inline>
              <CocoaSwitch checked={showZero} onChange={setShowZero} size="small" />
            </CocoaField>
          </div>
        }
      />

      {k ? (
        <>
          <CocoaKpiStrip stagger aria-label="Resultados del periodo">
            <CocoaKpi label="Ingresos" value={money(k.revenueTotal)} deltaLabel="grupo 7" polarity="neutral" />
            <CocoaKpi label="Gastos" value={money(k.expenseTotal)} deltaLabel="grupo 6" polarity="neutral" />
            <CocoaKpi label="Resultado de explotación" value={money(k.operatingResult)} polarity="neutral" tone={signTone(k.operatingResult)} status={signTone(k.operatingResult) === "danger" ? "warning" : "ok"} />
            <CocoaKpi label="Resultado financiero" value={money(k.financialResult)} polarity="neutral" tone={signTone(k.financialResult)} />
            <CocoaKpi label="Antes de impuestos" value={money(k.resultBeforeTax)} deltaLabel={`impuesto ${money(k.incomeTax)}`} polarity="neutral" tone={signTone(k.resultBeforeTax)} />
            <CocoaKpi label="Resultado del ejercicio" value={money(k.netResult)} deltaLabel={Number(k.netResult) >= 0 ? "beneficio" : "pérdida"} polarity="neutral" tone={signTone(k.netResult)} status={Number(k.netResult) < 0 ? "critical" : "ok"} />
          </CocoaKpiStrip>

          {k.warnings.length > 0 ? (
            <CocoaCallout tone="warning" title={plural(k.warnings.length, "aviso del cálculo", "avisos del cálculo")} role="status">
              <ul className="c22-section__list">
                {k.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </CocoaCallout>
          ) : null}

          <CocoaSection
            title="Cuenta de pérdidas y ganancias"
            meta={`${date(k.period.from, "short")} – ${date(k.period.to, "short")}${comparative ? " · con periodo anterior" : ""}`}
            padding={lines.length > 0 ? "none" : "md"}
            footer={hiddenLines > 0 ? <span>{plural(hiddenLines, "partida a cero oculta", "partidas a cero ocultas")}</span> : undefined}
            style={{ overflow: "clip" }}
          >
            {lines.length > 0 ? (
              <CocoaTable
                columns={columns}
                rows={lines}
                rowKey="id"
                density="compact"
                rowTone={(line) => (line.level === 0 ? "neutral" : undefined)}
                onSelect={(line) => setSelected(line)}
                selectedKey={selected?.id}
                rowTitle={(line) => (line.accounts.length > 0 ? plural(line.accounts.length, "cuenta detrás de la partida", "cuentas detrás de la partida") : "Sin cuentas con saldo en esta partida")}
                footer={{ label: "Resultado del ejercicio", amount: money(k.netResult) }}
                caption="Partidas de la cuenta de pérdidas y ganancias"
                aria-label="Partidas de la cuenta de pérdidas y ganancias"
              />
            ) : (
              <CocoaState kind="empty" inline title="Sin movimientos de ingresos ni gastos en el periodo." />
            )}
          </CocoaSection>
        </>
      ) : null}

      <CocoaDrawer
        open={selected !== null}
        onClose={() => setSelected(null)}
        title={selected ? selected.label : "Partida"}
        subtitle={selected ? `${money(selected.amount)}${selected.previousAmount !== undefined ? ` · periodo anterior ${money(selected.previousAmount)}` : ""}` : undefined}
        side="right"
        size="md"
        footer={
          <CocoaButton variant="bordered" tone="neutral" onClick={() => setSelected(null)}>
            {ACTIONS.close}
          </CocoaButton>
        }
      >
        {selected ? (
          selected.accounts.length > 0 ? (
            <CocoaTable columns={ACCOUNT_COLUMNS} rows={selected.accounts} rowKey="code" density="compact" footer={{ name: "Suma", amount: money(selected.amount) }} caption="Cuentas de la partida" aria-label="Cuentas de la partida" />
          ) : (
            <div className="cocoa-stack" data-gap="3">
              <CocoaStat label="Importe" value={money(selected.amount)} size="large" />
              <CocoaState kind="empty" inline title="Ninguna cuenta del plan tiene saldo en esta partida durante el periodo." />
            </div>
          )
        ) : (
          <CocoaState kind="loading" inline title={STATUS_LABELS.loading} />
        )}
      </CocoaDrawer>
    </CocoaPage>
  );
}

export default ProfitAndLossScreen;

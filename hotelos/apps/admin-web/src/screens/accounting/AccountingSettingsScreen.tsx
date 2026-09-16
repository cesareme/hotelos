// Ajustes contables — Finanzas › Contabilidad › Ajustes
// (/finanzas/contabilidad/ajustes, hosted in ContabilidadTabs). Cocoa 22 ·
// lote 6-C, archetype «formulario / ajustes» (docs/design/COCOA-22.md §4).
//
// GET /accounting/settings feeds three form sections — plan de cuentas (read
// only: template, provisioned, account count), ejercicio (month it starts) and
// IVA (periodicity, regime, prorrata, tax figure; `persisted = false` means the
// defaults are shown and nothing has been saved yet) — saved together with
// PATCH /accounting/settings (accounting.configure) from the CocoaActionBar
// (⌘/Ctrl+Enter), with a dirty guard. A fourth section shows the projection
// status (GET /accounting/projection/status) and offers the re-projection
// (POST /accounting/replay: dry run by default, `apply` only after a
// destructive-tone confirmation — high risk). Not to be confused with
// Configuración › Contabilidad y fiscal (fiscal years and periods).

import { useEffect, useMemo, useState } from "react";
import type { AccountingSettingsPatchInput, AccountingSettingsView, ProjectionStatusView, ReplayReportView } from "@hotelos/shared";
import { accountingErrorMessage, getAccountingSettings, getProjectionStatus, patchAccountingSettings, replayProjection } from "../../services/accountingApi";
import { useNavGate } from "../../navigation/useEnabledModules";
import { useToast } from "../../components/Toast";
import { ACTIONS, STATUS_LABELS, confirmDiscard } from "../../content/actions";
import { date, dateTime, money, number, plural } from "../../lib/format";
import { treeHeaderFor } from "../tabs/tab-helpers";
import {
  CocoaActionBar,
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDialog,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaKpi,
  CocoaKpiStrip,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaSkeleton,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  type CocoaTableColumn
} from "../../components/cocoa";
import {
  MONTH_OPTIONS,
  TAX_FIGURE_OPTIONS,
  VAT_PERIODICITY_OPTIONS,
  VAT_REGIME_OPTIONS,
  canDo,
  firstDayOfYear,
  parseMoneyInput,
  sourceTypeLabel,
  todayIso,
  vatPeriodicityLabel,
  vatRegimeLabel
} from "./accounting-ui";
import { FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { centreSelectOptions, financeScopePolicy, useFinanceScope } from "../../services/financeScope";

type Draft = { fiscalYearStartMonth: string; vatPeriodicity: string; vatRegime: string; prorrataPct: string; taxFigure: string };

function draftOf(settings: AccountingSettingsView): Draft {
  return {
    fiscalYearStartMonth: String(settings.fiscalYearStartMonth),
    vatPeriodicity: settings.vat.periodicity,
    vatRegime: settings.vat.regime,
    prorrataPct: settings.vat.prorrataPct === null ? "" : settings.vat.prorrataPct.replace(".", ","),
    taxFigure: settings.vat.taxFigure
  };
}

function isDirty(a: Draft, b: Draft): boolean {
  return (Object.keys(a) as Array<keyof Draft>).some((key) => a[key] !== b[key]);
}

const REPLAY_STATUS_LABEL: Record<string, string> = {
  posted: "Contabilizado",
  exists: "Ya existía",
  would_post: "Se contabilizaría",
  skipped: "Omitido",
  failed: "Fallido"
};

const REPLAY_COLUMNS: CocoaTableColumn<ReplayReportView["items"][number]>[] = [
  { key: "entryDate", label: "Fecha", width: "11ch", render: (item) => date(item.entryDate, "short") },
  { key: "reference", label: "Documento", render: (item) => item.reference ?? item.sourceId },
  { key: "sourceType", label: "Origen", render: (item) => sourceTypeLabel(item.sourceType), hideOnNarrow: true },
  { key: "amount", label: "Importe", align: "right", render: (item) => money(item.amount) },
  {
    key: "status",
    label: "Resultado",
    render: (item) => (
      <CocoaBadge tone={item.status === "failed" ? "danger" : item.status === "posted" ? "success" : item.status === "would_post" ? "info" : "neutral"}>
        {REPLAY_STATUS_LABEL[item.status] ?? item.status}
      </CocoaBadge>
    )
  },
  { key: "message", label: "Detalle", render: (item) => item.message ?? (item.warnings.length > 0 ? item.warnings.join(" · ") : "—"), hideOnNarrow: true }
];

const FAILURE_COLUMNS: CocoaTableColumn<ProjectionStatusView["recentFailures"][number]>[] = [
  { key: "failedAt", label: "Cuándo", width: "16ch", render: (failure) => dateTime(failure.failedAt) },
  { key: "eventType", label: "Evento", render: (failure) => failure.eventType },
  { key: "sourceType", label: "Origen", render: (failure) => `${sourceTypeLabel(failure.sourceType)}${failure.sourceId ? ` · ${failure.sourceId}` : ""}`, hideOnNarrow: true },
  { key: "error", label: "Motivo", render: (failure) => failure.error },
  { key: "attempts", label: "Intentos", align: "right", render: (failure) => number(failure.attempts) }
];

export function AccountingSettingsScreen() {
  const header = treeHeaderFor("AccountingSettingsScreen", { eyebrow: "Finanzas · Contabilidad", title: "Ajustes" });
  const { showToast } = useToast();
  const gate = useNavGate();
  const canConfigure = canDo(gate, "accounting.configure");
  const canReplay = canDo(gate, "accounting.journal.post") && canDo(gate, "ai.high_risk.confirm");
  // Tanda 6b · L7: the accounting settings are the sociedad's (forced); the replay may still target one centre.
  const finance = useFinanceScope(financeScopePolicy("AccountingSettingsScreen"));
  const scopeOptions = useMemo(() => centreSelectOptions(finance.structure, finance.active, { societyLevel: true, societyLabel: "Toda la sociedad" }), [finance.structure, finance.active]);

  // ---- settings -------------------------------------------------------------------
  const [settings, setSettings] = useState<AccountingSettingsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    getAccountingSettings()
      .then((view) => {
        if (!mounted) return;
        setSettings(view);
        setDraft(draftOf(view));
      })
      .catch((err: unknown) => {
        if (mounted) setError(err);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [nonce]);

  const saved = useMemo(() => (settings ? draftOf(settings) : null), [settings]);
  const dirty = draft !== null && saved !== null && isDirty(draft, saved);

  const prorrataCents = draft ? parseMoneyInput(draft.prorrataPct) : null;
  const prorrataError =
    draft && draft.prorrataPct.trim() !== "" && (prorrataCents === null || Number.isNaN(prorrataCents) || prorrataCents < 0 || prorrataCents > 10_000)
      ? "La prorrata es un porcentaje entre 0 y 100 (vacío = deducción íntegra)."
      : undefined;
  const valid = !prorrataError;

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current, [key]: value };
      // REDEME settles monthly by law: the periodicity follows the regime.
      if (key === "vatRegime" && value === "redeme") next.vatPeriodicity = "monthly";
      return next;
    });
  }

  const [saving, setSaving] = useState(false);
  const [askDiscard, setAskDiscard] = useState(false);
  async function save() {
    if (!draft || !saved || !valid || saving || !dirty) return;
    const body: AccountingSettingsPatchInput = {};
    if (draft.fiscalYearStartMonth !== saved.fiscalYearStartMonth) body.fiscalYearStartMonth = Number(draft.fiscalYearStartMonth);
    if (draft.vatPeriodicity !== saved.vatPeriodicity) body.vatPeriodicity = draft.vatPeriodicity as AccountingSettingsPatchInput["vatPeriodicity"];
    if (draft.vatRegime !== saved.vatRegime) body.vatRegime = draft.vatRegime as AccountingSettingsPatchInput["vatRegime"];
    if (draft.taxFigure !== saved.taxFigure) body.taxFigure = draft.taxFigure as AccountingSettingsPatchInput["taxFigure"];
    if (draft.prorrataPct !== saved.prorrataPct) body.prorrataPct = draft.prorrataPct.trim() === "" ? null : (prorrataCents! / 100).toFixed(2);
    setSaving(true);
    try {
      const view = await patchAccountingSettings(body);
      setSettings(view);
      setDraft(draftOf(view));
      showToast("Ajustes contables guardados.", { variant: "success" });
    } catch (err) {
      showToast(accountingErrorMessage(err, STATUS_LABELS.saveError), { variant: "error" });
    } finally {
      setSaving(false);
    }
  }

  // ---- projection status ----------------------------------------------------------
  const [projection, setProjection] = useState<ProjectionStatusView | null>(null);
  const [projectionError, setProjectionError] = useState<unknown>(null);
  const [projectionNonce, setProjectionNonce] = useState(0);
  useEffect(() => {
    let mounted = true;
    getProjectionStatus()
      .then((status) => {
        if (mounted) {
          setProjection(status);
          setProjectionError(null);
        }
      })
      .catch((err: unknown) => {
        if (mounted) setProjectionError(err);
      });
    return () => {
      mounted = false;
    };
  }, [projectionNonce]);

  // ---- replay (dry run by default; apply = high risk) --------------------------------
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayFrom, setReplayFrom] = useState(() => firstDayOfYear());
  const [replayTo, setReplayTo] = useState(() => todayIso());
  const [replayProperty, setReplayProperty] = useState("");
  const [replayApply, setReplayApply] = useState(false);
  const [replayBusy, setReplayBusy] = useState(false);
  const [replayReport, setReplayReport] = useState<ReplayReportView | null>(null);
  const [replayError, setReplayError] = useState<unknown>(null);

  async function runReplay() {
    setReplayBusy(true);
    setReplayError(null);
    try {
      const report = await replayProjection({ from: replayFrom, to: replayTo, apply: replayApply, ...(replayProperty ? { propertyId: replayProperty } : {}) });
      setReplayReport(report);
      setReplayOpen(false);
      setProjectionNonce((n) => n + 1);
      showToast(
        report.apply
          ? `Re-proyección aplicada: ${plural(report.posted, "asiento contabilizado", "asientos contabilizados")}, ${number(report.existing)} ya existían, ${number(report.failed)} fallidos.`
          : `Simulación terminada: ${plural(report.wouldPost, "documento se contabilizaría", "documentos se contabilizarían")}, ${number(report.existing)} ya existían.`,
        { variant: report.failed > 0 ? "warning" : "success" }
      );
    } catch (err) {
      setReplayError(err);
    } finally {
      setReplayBusy(false);
    }
  }

  const discard = confirmDiscard();
  const chartTone = settings?.chartProvisioned ? "success" : "danger";

  return (
    <CocoaPage
      eyebrow={finance.eyebrow("Finanzas")}
      title={header.title}
      subtitle="Mes de inicio del ejercicio, periodicidad y régimen del IVA, figura impositiva y estado de la proyección contable de la sociedad."
      actions={<FinanceScopeSelector scope={finance} />}
      state={loading && !settings ? "loading" : error && !settings ? "error" : "ready"}
      skeleton={
        <div className="cocoa-stack" data-gap="4" aria-hidden="true">
          <CocoaSkeleton.Strip count={3} />
          <CocoaSkeleton.Grid rows={[[6, 6], [12]]} height={200} />
        </div>
      }
      error={{ title: "No se pudieron cargar los ajustes", message: accountingErrorMessage(error), onRetry: () => setNonce((n) => n + 1) }}
      commands={[
        { id: "accounting-settings-save", label: `${ACTIONS.save}: ajustes contables`, run: () => void save(), shortcut: "⌘ Enter" },
        { id: "accounting-settings-refresh", label: "Actualizar los ajustes contables", run: () => setNonce((n) => n + 1) }
      ]}
      id="accounting-settings-screen"
    >
      {settings && draft ? (
        <>
          <CocoaKpiStrip aria-label="Estado del plan y del IVA">
            <CocoaKpi label="Plan de cuentas" value={settings.chartProvisioned ? "Provisionado" : "Sin provisionar"} deltaLabel={settings.chartTemplate === "pgc_pymes_hotelero_v1" ? "PGC Pymes hotelero" : settings.chartTemplate ?? "sin plantilla"} polarity="neutral" status={settings.chartProvisioned ? "ok" : "critical"} />
            <CocoaKpi label="Cuentas" value={number(settings.accountCount)} deltaLabel="en el plan de la sociedad" polarity="neutral" />
            {/* The tax figure (IVA · IGIC · IPSI) names the tile; it is not a unit of «Trimestral» (qa#7: «Trimestral IVA» read as one word). */}
            <CocoaKpi label={`Periodicidad del ${settings.vat.taxFigure}`} value={vatPeriodicityLabel(settings.vat.periodicity)} deltaLabel={settings.vat.persisted ? vatRegimeLabel(settings.vat.regime) : "valores por defecto, sin guardar"} polarity="neutral" status={settings.vat.persisted ? "ok" : "warning"} />
          </CocoaKpiStrip>

          {!settings.chartProvisioned ? (
            <CocoaCallout tone="danger" title="La sociedad no tiene plan de cuentas" role="alert">
              Sin plan no se contabiliza nada (la proyección responde «plan no provisionado»). Provisiona la plantilla PGC Pymes hotelero desde la línea de comandos del API (accounting:provision-chart) o contabiliza un primer documento: el motor la provisiona al vuelo.
            </CocoaCallout>
          ) : null}

          <CocoaFormSection title="Ejercicio contable" description="El ejercicio empieza el día 1 del mes indicado; los ejercicios concretos (código, fechas, cierre) se gestionan en Cierre de ejercicio.">
            <CocoaFormRow columns={2}>
              <CocoaField label="Mes de inicio" required help="Enero para el año natural; otro mes si la sociedad cierra fuera de diciembre.">
                <CocoaSelect value={draft.fiscalYearStartMonth} onChange={(value) => set("fiscalYearStartMonth", value)} options={[...MONTH_OPTIONS]} disabled={!canConfigure} />
              </CocoaField>
            </CocoaFormRow>
          </CocoaFormSection>

          <CocoaFormSection title="IVA" description={settings.vat.persisted ? "Periodicidad y régimen con los que se agrupan los libros registro y se calcula el modelo 303." : "Aún no se han guardado ajustes de IVA: se muestran los valores por defecto (trimestral, régimen general, IVA)."}>
            <CocoaFormRow columns={2}>
              <CocoaField label="Régimen" required>
                <CocoaSelect value={draft.vatRegime} onChange={(value) => set("vatRegime", value)} options={[...VAT_REGIME_OPTIONS]} disabled={!canConfigure} />
              </CocoaField>
              <CocoaField label="Periodicidad" required help={draft.vatRegime === "redeme" ? "La devolución mensual obliga a liquidar cada mes." : "Trimestral salvo REDEME o gran empresa."}>
                <CocoaSelect value={draft.vatPeriodicity} onChange={(value) => set("vatPeriodicity", value)} options={[...VAT_PERIODICITY_OPTIONS]} disabled={!canConfigure || draft.vatRegime === "redeme"} />
              </CocoaField>
              <CocoaField label="Figura impositiva" required help="Determina el impuesto de los libros registro; Canarias, Ceuta y Melilla quedan fuera del modelo 303.">
                <CocoaSelect value={draft.taxFigure} onChange={(value) => set("taxFigure", value)} options={[...TAX_FIGURE_OPTIONS]} disabled={!canConfigure} />
              </CocoaField>
              <CocoaField label="Prorrata" hint="opcional" error={prorrataError} help="Porcentaje de IVA soportado deducible cuando hay actividad exenta; vacío = deducción íntegra.">
                <CocoaInput value={draft.prorrataPct} onChange={(value) => set("prorrataPct", value)} inputMode="decimal" placeholder="Deducción íntegra" rightSlot={<span aria-hidden="true">%</span>} disabled={!canConfigure} />
              </CocoaField>
            </CocoaFormRow>
          </CocoaFormSection>

          <CocoaSection
            title="Proyección contable"
            meta={projection ? `${plural(projection.processed, "evento procesado", "eventos procesados")} · ${number(projection.failed)} fallidos` : undefined}
            action={
              canReplay ? (
                <CocoaButton variant="plain" size="small" onClick={() => setReplayOpen(true)}>
                  Re-proyectar…
                </CocoaButton>
              ) : undefined
            }
          >
            {projectionError ? (
              <CocoaState kind="error" inline title="Estado de la proyección no disponible" message={accountingErrorMessage(projectionError)} onRetry={() => setProjectionNonce((n) => n + 1)} />
            ) : projection ? (
              <div className="cocoa-stack" data-gap="3">
                <CocoaKpiStrip min={200} aria-label="Contadores de la proyección">
                  <CocoaKpi label="En cola" value={number(projection.queued)} polarity="neutral" size="compact" />
                  <CocoaKpi label="Contabilizados" value={number(projection.posted)} polarity="neutral" size="compact" />
                  <CocoaKpi label="Ignorados" value={number(projection.ignored)} deltaLabel="sin efecto contable" polarity="neutral" size="compact" />
                  <CocoaKpi label="Fallidos" value={number(projection.failed)} polarity="negative-good" status={projection.failed > 0 ? "critical" : "ok"} size="compact" />
                </CocoaKpiStrip>
                <p className="cocoa-caption">Contadores del proceso del API desde su último arranque. Un fallo queda auditado y el documento se recupera con la re-proyección.</p>
                {projection.recentFailures.length > 0 ? (
                  <CocoaTable columns={FAILURE_COLUMNS} rows={projection.recentFailures} rowKey="eventId" density="compact" caption="Fallos recientes de la proyección" aria-label="Fallos recientes de la proyección" />
                ) : (
                  <CocoaState kind="empty" inline title="Sin fallos recientes." />
                )}
              </div>
            ) : (
              <CocoaState kind="loading" inline title={STATUS_LABELS.loading} />
            )}
          </CocoaSection>

          {replayReport ? (
            <CocoaSection
              title={replayReport.apply ? "Re-proyección aplicada" : "Simulación de la re-proyección"}
              meta={`${date(replayReport.from, "short")} – ${date(replayReport.to, "short")} · ${plural(replayReport.scanned, "documento", "documentos")}`}
              action={
                <CocoaButton variant="plain" size="small" onClick={() => setReplayReport(null)}>
                  {ACTIONS.close}
                </CocoaButton>
              }
              padding={replayReport.items.length > 0 ? "none" : "md"}
              style={{ overflow: "clip" }}
            >
              {replayReport.items.length > 0 ? (
                <CocoaTable columns={REPLAY_COLUMNS} rows={replayReport.items} rowKey={(item) => `${item.sourceType}-${item.sourceId}`} density="compact" caption="Documentos de la re-proyección" aria-label="Documentos de la re-proyección" />
              ) : (
                <CocoaState kind="empty" inline title="Ningún documento en el rango." />
              )}
            </CocoaSection>
          ) : null}

          {canConfigure ? (
            <CocoaActionBar
              aria-label="Acciones de los ajustes contables"
              status={dirty ? "Cambios sin guardar" : settings.vat.persisted ? undefined : "Ajustes de IVA por defecto"}
              secondary={{ label: ACTIONS.cancel, disabled: !dirty || saving, onClick: () => setAskDiscard(true) }}
              primary={{ label: saving ? STATUS_LABELS.saving : ACTIONS.save, loading: saving, disabled: !dirty || !valid || saving, onClick: () => void save() }}
              publishToastOffset
            />
          ) : (
            <CocoaCallout tone="info" title="Solo lectura" role="status">
              Tu perfil consulta los ajustes pero no los modifica: hace falta el permiso de configuración contable.
            </CocoaCallout>
          )}

          <CocoaDialog
            open={askDiscard}
            onClose={() => setAskDiscard(false)}
            tone="destructive"
            title={discard.title}
            description={discard.message}
            confirmLabel={discard.confirmLabel}
            cancelLabel={discard.cancelLabel}
            onConfirm={() => {
              if (saved) setDraft(saved);
              setAskDiscard(false);
            }}
          />

          <CocoaDialog
            open={replayOpen}
            onClose={() => setReplayOpen(false)}
            tone={replayApply ? "destructive" : "primary"}
            title={replayApply ? "¿Aplicar la re-proyección?" : "Simular la re-proyección"}
            description={
              replayApply
                ? "Operación de alto riesgo: contabiliza los documentos del rango que aún no tengan asiento (facturas, cobros y ventas del punto de venta). Los que ya existen no se duplican."
                : "Recorre las facturas, los cobros y las ventas del punto de venta del rango y dice qué se contabilizaría, sin escribir nada."
            }
            confirmLabel={replayApply ? "Aplicar" : "Simular"}
            cancelLabel={ACTIONS.cancel}
            busy={replayBusy}
            onConfirm={runReplay}
            size="md"
          >
            <div className="cocoa-stack" data-gap="3">
              <CocoaFormRow columns={2}>
                <CocoaField label="Desde" required>
                  <CocoaDatePicker value={replayFrom} onChange={setReplayFrom} />
                </CocoaField>
                <CocoaField label="Hasta" required>
                  <CocoaDatePicker value={replayTo} onChange={setReplayTo} />
                </CocoaField>
                <CocoaField label="Centro de trabajo" fullWidth help="Sin centro se reproyectan los documentos de toda la sociedad.">
                  <CocoaSelect value={replayProperty} onChange={setReplayProperty} options={scopeOptions} />
                </CocoaField>
                <CocoaField label="Contabilizar de verdad" inline help="Desactivado = simulación (no escribe nada).">
                  <CocoaSwitch checked={replayApply} onChange={setReplayApply} size="small" />
                </CocoaField>
              </CocoaFormRow>
              {replayError ? (
                <CocoaCallout tone="danger" title="No se pudo ejecutar" role="alert">
                  {accountingErrorMessage(replayError)}
                </CocoaCallout>
              ) : null}
            </div>
          </CocoaDialog>
        </>
      ) : null}
    </CocoaPage>
  );
}

export default AccountingSettingsScreen;

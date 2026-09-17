// Configuración › Estructura societaria › Series y VeriFactu —
// /configuracion/estructura-societaria/series-verifactu (Tanda 6b · L6; design §5.3).
// Sociedad-wide table of invoice series (centro · serie · prefijo · año ·
// siguiente nº · tipo · estado) with the «Colisión» badge of R3, read from
// GET /legal-entities/:id/series (billing.configure); close / reopen a series
// through PATCH /backoffice/properties/:id/billing-settings after a
// confirmation (a closed series never numbers again: SERIES_CLOSED; reopening
// re-checks the sister centres: SERIES_PREFIX_CLASH). Never renumbers.
// Below, the VeriFactu installations of the sociedad (número inmutable as a
// copiable CocoaKbd — clipboard API, then selection + legacy copy, then the
// selection alone with a hint —, centro, envíos, última factura, estado) from
// GET /legal-entities/:id/verifactu/installations (accounting.configure), and
// the chain policy as INFORMATIVE text — «Cadena por centro · fijada por
// ehotelOS» — never as a control (R7: the platform console decides).

import { useEffect, useMemo, useState } from "react";
import { CocoaBadge, CocoaButton, CocoaCallout, CocoaDialog, CocoaKbd, CocoaPage, CocoaSection, CocoaState, CocoaTable, type CocoaTableColumn } from "../../components/cocoa";
import { useToast } from "../../components/Toast";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { copyText } from "../../services/authApi";
import { patchBillingSettings } from "../../services/billingApi";
import { dateTime, number, plural } from "../../lib/format";
import { listLegalEntitySeries, listVerifactuInstallations, type LegalEntitySeriesRow, type VerifactuInstallationView } from "../../services/structureApi";
import { useTabHost } from "../tabs/TabHost";
import { StructureActions, StructureSplit, structurePageProps, useWizardState } from "./StructureScreen";
import { useStructureModel } from "./structure-model";
import { CHAIN_SCOPE_LABELS, invoiceTypeLabel, propertyKindLabel, structureErrorMessage } from "./structure-ui";

type Loaded<T> = { status: "idle" | "loading" | "ready" | "error"; data: T | null; message: string | null };

function useLoaded<T>(load: (() => Promise<T>) | null, deps: readonly unknown[]): Loaded<T> & { refresh: () => void } {
  const [state, setState] = useState<Loaded<T>>({ status: load ? "loading" : "idle", data: null, message: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!load) {
      setState({ status: "idle", data: null, message: null });
      return;
    }
    let mounted = true;
    setState((current) => ({ ...current, status: "loading" }));
    load()
      .then((data) => {
        if (mounted) setState({ status: "ready", data, message: null });
      })
      .catch((err: unknown) => {
        if (mounted) setState({ status: "error", data: null, message: structureErrorMessage(err, "No se pudieron cargar los datos.") });
      });
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { ...state, refresh: () => setNonce((n) => n + 1) };
}

/** Selects the whole text of `node` (a CocoaKbd); false when the page has no Selection API. */
function selectContents(node: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

/** Copies the current selection through the legacy command (needs a user gesture, not the clipboard permission). */
function legacyCopy(): boolean {
  try {
    return typeof document.execCommand === "function" && document.execCommand("copy");
  } catch {
    return false;
  }
}

const SERIES_COLUMNS: CocoaTableColumn<LegalEntitySeriesRow>[] = [
  { key: "property", label: "Centro", minWidth: 160, render: (row) => (row.propertyCode ? `${row.propertyCode} · ${row.propertyName}` : row.propertyName) },
  { key: "sequenceCode", label: "Serie", fit: true, render: (row) => <strong className="cocoa-tabular">{row.sequenceCode}</strong> },
  {
    key: "prefix",
    label: "Prefijo",
    fit: true,
    render: (row) => (
      <span className="cocoa-cluster">
        <CocoaKbd announce>{row.prefix ?? "—"}</CocoaKbd>
        {row.clash ? <CocoaBadge tone="danger" size="small">colisión</CocoaBadge> : null}
      </span>
    )
  },
  { key: "year", label: "Año", fit: true, align: "right", render: (row) => (row.year === null ? "—" : String(row.year)) },
  { key: "nextNumber", label: "Siguiente nº", fit: true, align: "right", render: (row) => number(row.nextNumber) },
  { key: "invoiceType", label: "Tipo", showFrom: "laptop", render: (row) => invoiceTypeLabel(row.invoiceType) },
  { key: "active", label: "Estado", fit: true, render: (row) => <CocoaBadge tone={row.active ? "success" : "neutral"} variant="dot">{row.active ? "Activa" : "Cerrada"}</CocoaBadge> }
];

const INSTALLATION_COLUMNS: CocoaTableColumn<VerifactuInstallationView>[] = [
  { key: "property", label: "Centro", minWidth: 160, render: (row) => (row.propertyId ? [row.propertyCode, row.propertyName].filter(Boolean).join(" · ") : "Toda la sociedad") },
  {
    key: "numeroInstalacion",
    label: "Nº de instalación",
    fit: true,
    render: (row) => (
      <span data-installation-id={row.id}>
        <CocoaKbd announce>{row.numeroInstalacion}</CocoaKbd>
      </span>
    )
  },
  { key: "route", label: "Ruta", fit: true, hideOnNarrow: true, render: (row) => (row.route === "verifactu" ? "VeriFactu" : row.route === "tbai" ? "TicketBAI" : "IGIC") },
  { key: "submissions", label: "Envíos", fit: true, align: "right", render: (row) => number(row.submissions) },
  { key: "lastInvoice", label: "Última factura", showFrom: "laptop", render: (row) => (row.lastInvoice ? `${row.lastInvoice.invoiceNumber ?? "—"} · ${row.lastInvoice.issuedAt ? dateTime(row.lastInvoice.issuedAt) : "—"}` : "sin facturas encadenadas") },
  { key: "active", label: "Estado", fit: true, render: (row) => <CocoaBadge tone={row.active ? "success" : "neutral"} variant="dot">{row.active ? "Activa" : `Retirada${row.retiredAt ? ` · ${dateTime(row.retiredAt)}` : ""}`}</CocoaBadge> }
];

export function StructureSeriesTab() {
  const hosted = useTabHost() !== null;
  const model = useStructureModel("series");
  const wizard = useWizardState();
  const { showToast } = useToast();
  const entityId = model.legalEntity?.id ?? null;
  const canSeeSeries = model.permissions.billing && !model.redacted;
  const canSeeInstallations = model.permissions.configureAccounting && !model.redacted;

  const series = useLoaded(entityId && canSeeSeries ? () => listLegalEntitySeries(entityId) : null, [entityId, canSeeSeries]);
  const installations = useLoaded(entityId && canSeeInstallations ? () => listVerifactuInstallations(entityId) : null, [entityId, canSeeInstallations]);

  const [toggle, setToggle] = useState<LegalEntitySeriesRow | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function applyToggle() {
    if (!toggle) return;
    setBusy(true);
    setFailure(null);
    try {
      await patchBillingSettings(toggle.propertyId, {
        sequenceCode: toggle.sequenceCode,
        invoiceType: toggle.invoiceType,
        ...(toggle.year !== null ? { year: toggle.year } : {}),
        active: !toggle.active
      });
      showToast(toggle.active ? `Serie ${toggle.prefix ?? toggle.sequenceCode} cerrada: no vuelve a numerar.` : `Serie ${toggle.prefix ?? toggle.sequenceCode} reabierta.`, { variant: "success" });
      setToggle(null);
      series.refresh();
      model.refresh();
    } catch (err) {
      setFailure(structureErrorMessage(err, STATUS_LABELS.saveError, { propertyNames: model.propertyNames }));
    } finally {
      setBusy(false);
    }
  }

  // «Copiar» never dead-ends (qa#15): when the async clipboard is missing or
  // denied (a sandboxed pane, a permission policy) the number is selected in
  // its CocoaKbd and copied through the legacy command; if even that fails the
  // selection stays so ⌘C / Ctrl+C finishes the job.
  async function copyInstallation(row: VerifactuInstallationView) {
    const value = row.numeroInstalacion;
    if (await copyText(value)) {
      showToast(`Número de instalación ${value} copiado.`, { variant: "success" });
      return;
    }
    const node = typeof document === "undefined" ? null : document.querySelector<HTMLElement>(`[data-installation-id="${CSS.escape(row.id)}"]`);
    const selected = node ? selectContents(node) : false;
    if (selected && legacyCopy()) {
      window.getSelection()?.removeAllRanges();
      showToast(`Número de instalación ${value} copiado.`, { variant: "success" });
      return;
    }
    showToast(
      selected ? "No se pudo copiar automáticamente: el número queda seleccionado, cópialo con Ctrl+C o ⌘C." : "No se pudo copiar al portapapeles: selecciona el número y cópialo con Ctrl+C o ⌘C.",
      { variant: "warning" }
    );
  }

  const seriesRows = useMemo(() => series.data?.series ?? [], [series.data]);
  const clashCount = series.data?.clashCount ?? 0;
  const chainScope = installations.data?.chainScope ?? model.legalEntity?.verifactuChainScope ?? "per_center";

  return (
    <CocoaPage {...structurePageProps(model, hosted, "Series de facturación de toda la sociedad, sus colisiones de prefijo y las instalaciones VeriFactu por centro.")} actions={<StructureActions model={model} wizard={wizard} />}>
      <StructureSplit model={model} wizard={wizard}>
        {model.structure ? (
          <>
            {failure ? (
              <CocoaCallout tone="danger" title="No se pudo cambiar la serie" role="alert">
                {failure}
              </CocoaCallout>
            ) : null}

            <CocoaSection
              title="Series de la sociedad"
              meta={series.status === "ready" ? (clashCount > 0 ? `${plural(clashCount, "colisión", "colisiones")}` : `${plural(seriesRows.length, "serie", "series")} · sin colisiones`) : undefined}
              padding={series.status === "ready" && seriesRows.length > 0 ? "none" : "md"}
              style={{ overflow: "clip" }}
              footer={series.status === "ready" ? "Una serie cerrada nunca vuelve a numerar: para cambiar de prefijo se cierra y se abre otra. Las series nuevas se abren en Configuración › Facturación y pagos." : undefined}
            >
              {!canSeeSeries ? (
                <CocoaState kind="empty" inline title={model.redacted ? "Las series de la sociedad solo las ve quien tiene «Finanzas de toda la sociedad»." : "Hace falta el permiso de configuración de facturación para ver las series."} />
              ) : series.status === "loading" ? (
                <CocoaState kind="loading" inline title={STATUS_LABELS.loading} />
              ) : series.status === "error" ? (
                <CocoaState kind="error" inline title="No se pudieron cargar las series" message={series.message ?? undefined} onRetry={series.refresh} />
              ) : seriesRows.length === 0 ? (
                <CocoaState kind="empty" inline title="Ningún centro tiene series todavía." />
              ) : (
                <>
                  {clashCount > 0 ? (
                    <CocoaCallout tone="danger" title={`${plural(clashCount, "serie comparte prefijo", "series comparten prefijo")} con otro centro`} role="alert">
                      Dos centros de la misma sociedad no pueden numerar con el mismo prefijo en el mismo año: cierra una de las dos y abre otra con el código del centro.
                    </CocoaCallout>
                  ) : null}
                  <CocoaTable
                    columns={SERIES_COLUMNS}
                    rows={seriesRows}
                    rowKey="id"
                    caption="Series de facturación de la sociedad"
                    aria-label="Series de facturación de la sociedad"
                    rowTone={(row) => (row.clash ? "danger" : undefined)}
                    rowActions={
                      model.permissions.billing
                        ? (row) => (
                            <CocoaButton
                              variant="plain"
                              tone={row.active ? "destructive" : "accent"}
                              size="small"
                              onClick={(event) => {
                                event.stopPropagation();
                                setFailure(null);
                                setToggle(row);
                              }}
                            >
                              {row.active ? "Cerrar serie" : "Reabrir"}
                            </CocoaButton>
                          )
                        : undefined
                    }
                    rowActionsVisible="always"
                  />
                </>
              )}
            </CocoaSection>

            <CocoaSection
              title="Instalaciones VeriFactu"
              meta={installations.status === "ready" ? plural(installations.data?.installations.length ?? 0, "instalación", "instalaciones") : undefined}
              padding={installations.status === "ready" && (installations.data?.installations.length ?? 0) > 0 ? "none" : "md"}
              style={{ overflow: "clip" }}
              footer={`${CHAIN_SCOPE_LABELS[chainScope]} · fijada por ehotelOS desde la consola de plataforma; cambiarla nunca re-encadena: se retira la instalación y se abre otra con número nuevo.`}
            >
              {!canSeeInstallations ? (
                <CocoaState kind="empty" inline title={model.redacted ? "Las instalaciones solo las ve quien tiene «Finanzas de toda la sociedad»." : "Hace falta el permiso de configuración contable para ver las instalaciones."} />
              ) : installations.status === "loading" ? (
                <CocoaState kind="loading" inline title={STATUS_LABELS.loading} />
              ) : installations.status === "error" ? (
                <CocoaState kind="error" inline title="No se pudieron cargar las instalaciones" message={installations.message ?? undefined} onRetry={installations.refresh} />
              ) : (installations.data?.installations.length ?? 0) === 0 ? (
                <CocoaState kind="empty" inline title="Ningún centro tiene instalación declarada: se abre al activar la primera emisión real." />
              ) : (
                <CocoaTable
                  columns={INSTALLATION_COLUMNS}
                  rows={installations.data?.installations ?? []}
                  rowKey="id"
                  caption="Instalaciones VeriFactu de la sociedad"
                  aria-label="Instalaciones VeriFactu de la sociedad"
                  rowActions={(row) => (
                    <CocoaButton
                      variant="plain"
                      tone="neutral"
                      size="small"
                      onClick={(event) => {
                        event.stopPropagation();
                        void copyInstallation(row);
                      }}
                    >
                      {ACTIONS.copy}
                    </CocoaButton>
                  )}
                  rowActionsVisible="always"
                />
              )}
            </CocoaSection>

            <CocoaDialog
              open={toggle !== null}
              onClose={() => setToggle(null)}
              tone={toggle?.active ? "destructive" : "primary"}
              title={toggle?.active ? `¿Cerrar la serie ${toggle.prefix ?? toggle.sequenceCode}?` : `¿Reabrir la serie ${toggle?.prefix ?? toggle?.sequenceCode ?? ""}?`}
              description={
                toggle?.active
                  ? `${toggle.propertyName} (${propertyKindLabel(toggle.propertyKind)}) dejará de numerar con esta serie; la siguiente factura de ese tipo necesitará otra serie activa. Las facturas emitidas no cambian.`
                  : "La serie vuelve a numerar donde se quedó. Se comprueba de nuevo que ningún otro centro use su prefijo este año."
              }
              confirmLabel={toggle?.active ? "Cerrar serie" : "Reabrir serie"}
              cancelLabel={ACTIONS.cancel}
              busy={busy}
              onConfirm={applyToggle}
            />
          </>
        ) : null}
      </StructureSplit>
    </CocoaPage>
  );
}

export default StructureSeriesTab;

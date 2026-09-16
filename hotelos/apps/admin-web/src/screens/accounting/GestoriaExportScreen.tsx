// Exportar a gestoría — Finanzas › Contabilidad › Exportar a gestoría
// (/finanzas/contabilidad/exportar-gestoria, hosted in ContabilidadTabs).
// Cocoa 22 · lote 6-C, archetype «lista / tabla» with a creation form.
//
// GET /accounting/gestoria-exports/formats lists the formats with their flags:
// `implemented` (A3 is declared not implemented and answers 409) and
// `validateWithAdvisor` («compatible ContaPlus / Sage 50»: validate the layout
// with the gestoría before the first real import). The form (formato · desde ·
// hasta · propiedad · longitud de subcuenta for ContaPlus) creates the file
// with POST /accounting/gestoria-exports (analytics.export) and offers it for
// download; the history table (GET /accounting/gestoria-exports) downloads
// any previous file (GET …/:id/download). Nothing is generated client-side:
// the CSV rows come from the ledger through the API.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { GestoriaExportCreateBody, GestoriaExportFormatInfo, GestoriaExportFormatKey, GestoriaExportRow } from "@hotelos/shared";
import { createGestoriaExport, downloadGestoriaExport, listGestoriaExports, listGestoriaFormats, statementsErrorMessage } from "../../services/financialStatementsApi";
import { previousPeriod, periodBounds, quarterPeriod } from "../../services/finance-contracts";
import { useNavGate } from "../../navigation/useEnabledModules";
import { useToast } from "../../components/Toast";
import { ACTIONS, STATUS_LABELS } from "../../content/actions";
import { date, dateTime, number, plural } from "../../lib/format";
import { DownloadIcon } from "../../components/cocoa-icons/ActionIcons";
import { treeHeaderFor } from "../tabs/tab-helpers";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaPage,
  CocoaSection,
  CocoaSelect,
  CocoaState,
  CocoaTable,
  type CocoaTableColumn
} from "../../components/cocoa";
import { canDo, saveDownload, todayIso, usePropertyScopeOptions } from "./accounting-ui";

const subStyle: CSSProperties = {
  display: "block",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label-secondary)"
};

function formatLabel(formats: readonly GestoriaExportFormatInfo[], key: GestoriaExportFormatKey): string {
  return formats.find((format) => format.format === key)?.label ?? key;
}

/** "12,3 KB" · "1,2 MB" through lib/format (no local formatter). */
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${number(bytes)} B`;
  if (bytes < 1024 * 1024) return `${number(bytes / 1024, { maximumFractionDigits: 1 })} KB`;
  return `${number(bytes / (1024 * 1024), { maximumFractionDigits: 1 })} MB`;
}

export function GestoriaExportScreen() {
  const header = treeHeaderFor("GestoriaExportScreen", { eyebrow: "Finanzas · Contabilidad", title: "Exportar a gestoría" });
  const { showToast } = useToast();
  const gate = useNavGate();
  const canExport = canDo(gate, "analytics.export");
  const scopeOptions = usePropertyScopeOptions();

  // ---- formats ------------------------------------------------------------------
  const [formats, setFormats] = useState<GestoriaExportFormatInfo[]>([]);
  const [formatsError, setFormatsError] = useState<unknown>(null);
  const [formatsLoading, setFormatsLoading] = useState(true);
  useEffect(() => {
    let mounted = true;
    listGestoriaFormats()
      .then((rows) => {
        if (mounted) setFormats(rows);
      })
      .catch((err: unknown) => {
        if (mounted) setFormatsError(err);
      })
      .finally(() => {
        if (mounted) setFormatsLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // ---- history --------------------------------------------------------------------
  const [history, setHistory] = useState<GestoriaExportRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<unknown>(null);
  const [historyNonce, setHistoryNonce] = useState(0);
  useEffect(() => {
    let mounted = true;
    setHistoryLoading(true);
    listGestoriaExports({ limit: 100 })
      .then((rows) => {
        if (mounted) {
          setHistory(rows);
          setHistoryError(null);
        }
      })
      .catch((err: unknown) => {
        if (mounted) setHistoryError(err);
      })
      .finally(() => {
        if (mounted) setHistoryLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [historyNonce]);

  // ---- form -------------------------------------------------------------------------
  const lastQuarter = useMemo(() => periodBounds(previousPeriod(quarterPeriod(todayIso())) ?? quarterPeriod(todayIso())), []);
  const [format, setFormat] = useState<string>("csv_universal");
  const [from, setFrom] = useState(lastQuarter?.from ?? todayIso());
  const [to, setTo] = useState(lastQuarter?.to ?? todayIso());
  const [propertyId, setPropertyId] = useState("");
  const [subaccountLength, setSubaccountLength] = useState("8");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);

  const selectedFormat = formats.find((candidate) => candidate.format === format) ?? null;
  const formatOptions = formats.map((candidate) => ({ value: candidate.format, label: candidate.implemented ? candidate.label : `${candidate.label} (no disponible)`, disabled: !candidate.implemented }));
  const subaccountValue = Number(subaccountLength);
  const errors = {
    format: !selectedFormat ? "Elige un formato." : !selectedFormat.implemented ? "Ese formato aún no está disponible: usa el CSV universal de asientos." : undefined,
    range: !from || !to ? "Indica el periodo completo." : from > to ? "La fecha de inicio no puede ser posterior a la de fin." : undefined,
    subaccount: format === "contaplus_diario" && (!Number.isInteger(subaccountValue) || subaccountValue < 3 || subaccountValue > 12) ? "La longitud de subcuenta va de 3 a 12 dígitos (8 por defecto)." : undefined
  };
  const valid = !errors.format && !errors.range && !errors.subaccount;

  async function createExport() {
    setTouched(true);
    if (!valid || !selectedFormat) return;
    setCreating(true);
    setCreateError(null);
    try {
      const body: GestoriaExportCreateBody = {
        format: selectedFormat.format,
        from,
        to,
        ...(propertyId ? { propertyId } : {}),
        ...(selectedFormat.format === "contaplus_diario" ? { subaccountLength: subaccountValue } : {})
      };
      const row = await createGestoriaExport(body);
      setHistory((current) => [row, ...current.filter((candidate) => candidate.id !== row.id)]);
      showToast(`Exportación generada: ${row.fileName} (${plural(row.rowCount, "fila", "filas")}).`, { variant: "success" });
      saveDownload(await downloadGestoriaExport(row));
    } catch (err) {
      setCreateError(err);
      showToast(statementsErrorMessage(err, "No se pudo generar la exportación."), { variant: "error" });
    } finally {
      setCreating(false);
    }
  }

  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  async function download(row: GestoriaExportRow) {
    setDownloadingId(row.id);
    try {
      saveDownload(await downloadGestoriaExport(row));
    } catch (err) {
      showToast(statementsErrorMessage(err, "No se pudo descargar el fichero."), { variant: "error" });
    } finally {
      setDownloadingId(null);
    }
  }

  const columns: CocoaTableColumn<GestoriaExportRow>[] = useMemo(
    () => [
      { key: "createdAt", label: "Generada", width: "16ch", render: (row) => dateTime(row.createdAt) },
      {
        key: "format",
        label: "Formato",
        render: (row) => (
          <>
            <span>{formatLabel(formats, row.format)}</span>
            <span style={subStyle}>{row.fileName}</span>
          </>
        )
      },
      { key: "period", label: "Periodo", render: (row) => `${date(row.periodFrom, "short")} – ${date(row.periodTo, "short")}`, hideOnNarrow: true },
      { key: "rowCount", label: "Filas", align: "right", render: (row) => number(row.rowCount) },
      { key: "sizeBytes", label: "Tamaño", align: "right", render: (row) => fileSize(row.sizeBytes), hideOnNarrow: true },
      {
        key: "validateWithAdvisor",
        label: "Validación",
        render: (row) => (row.validateWithAdvisor ? <CocoaBadge tone="warning">Validar con la gestoría</CocoaBadge> : <CocoaBadge tone="success">Formato estable</CocoaBadge>)
      }
    ],
    [formats]
  );

  const historyReady = !historyLoading && !historyError && history.length > 0;

  let historyBody;
  if (historyLoading && history.length === 0) {
    historyBody = <CocoaTable columns={columns} rows={[]} loading aria-label="Exportaciones anteriores" />;
  } else if (historyError) {
    historyBody = <CocoaState kind="error" title="No se pudo cargar el historial" message={statementsErrorMessage(historyError)} onRetry={() => setHistoryNonce((n) => n + 1)} />;
  } else if (history.length === 0) {
    historyBody = <CocoaState kind="empty" illustration="box" title="Aún no hay exportaciones" message="Cada fichero generado queda aquí con su periodo, sus filas y su formato para descargarlo de nuevo." />;
  } else {
    historyBody = (
      <CocoaTable
        columns={columns}
        rows={history}
        rowKey="id"
        density="compact"
        rowActions={(row) => (
          <CocoaButton
            variant="plain"
            size="small"
            icon={<DownloadIcon size={14} aria-hidden="true" />}
            loading={downloadingId === row.id}
            onClick={(event) => {
              event.stopPropagation();
              void download(row);
            }}
          >
            {ACTIONS.download}
          </CocoaButton>
        )}
        caption="Exportaciones anteriores"
        aria-label="Exportaciones anteriores"
      />
    );
  }

  return (
    <CocoaPage
      eyebrow={header.eyebrow}
      title={header.title}
      subtitle="Asientos y libros de IVA del libro en el formato que importa la gestoría; cada fichero queda en el historial para descargarlo de nuevo."
      commands={[
        { id: "gestoria-export-create", label: "Generar exportación para la gestoría", run: () => void createExport() },
        { id: "gestoria-export-refresh", label: "Actualizar el historial de exportaciones", run: () => setHistoryNonce((n) => n + 1) }
      ]}
      id="gestoria-export-screen"
    >
      <CocoaFormSection
        title="Nueva exportación"
        description="El CSV universal de asientos lo importa cualquier programa contable; los formatos marcados «validar con la gestoría» siguen un diseño de registro que hay que comprobar antes de la primera importación real."
        actions={
          canExport ? (
            <CocoaButton variant="filled" tone="accent" icon={<DownloadIcon size={14} aria-hidden="true" />} loading={creating} disabled={creating || formatsLoading || (touched && !valid)} onClick={() => void createExport()}>
              Generar y descargar
            </CocoaButton>
          ) : (
            <CocoaBadge tone="neutral" uppercase={false}>
              Tu perfil no exporta: hace falta el permiso de exportación de informes
            </CocoaBadge>
          )
        }
      >
        <CocoaFormRow columns={2}>
          <CocoaField label="Formato" required error={touched ? errors.format : undefined} help={selectedFormat?.description}>
            <CocoaSelect value={format} onChange={setFormat} options={formatOptions} placeholder={formatsLoading ? STATUS_LABELS.loading : "Elegir formato…"} disabled={formatsLoading || formats.length === 0} />
          </CocoaField>
          <CocoaField label="Propiedad" help="Sin propiedad se exportan los asientos de toda la organización.">
            <CocoaSelect value={propertyId} onChange={setPropertyId} options={scopeOptions} />
          </CocoaField>
          <CocoaField label="Desde" required error={touched ? errors.range : undefined}>
            <CocoaDatePicker value={from} onChange={setFrom} />
          </CocoaField>
          <CocoaField label="Hasta" required>
            <CocoaDatePicker value={to} onChange={setTo} />
          </CocoaField>
          {format === "contaplus_diario" ? (
            <CocoaField label="Longitud de subcuenta" required error={touched ? errors.subaccount : undefined} help="Dígitos de la subcuenta en la empresa de ContaPlus / Sage 50 (8 por defecto): las cuentas se rellenan con ceros hasta esa longitud.">
              <CocoaInput value={subaccountLength} onChange={setSubaccountLength} inputMode="numeric" maxLength={2} />
            </CocoaField>
          ) : null}
        </CocoaFormRow>

        {selectedFormat ? (
          <div className="cocoa-cluster" aria-label="Columnas del fichero">
            {selectedFormat.validateWithAdvisor ? <CocoaBadge tone="warning">Validar con la gestoría</CocoaBadge> : <CocoaBadge tone="success">Formato estable</CocoaBadge>}
            <CocoaBadge tone="neutral" uppercase={false}>
              {plural(selectedFormat.columns.length, "columna", "columnas")}: {selectedFormat.columns.join(" · ")}
            </CocoaBadge>
          </div>
        ) : null}

        {formatsError ? (
          <CocoaCallout tone="danger" title="Formatos no disponibles" role="alert">
            {statementsErrorMessage(formatsError, "No se pudo cargar la lista de formatos de exportación.")}
          </CocoaCallout>
        ) : null}

        {selectedFormat?.validateWithAdvisor ? (
          <CocoaCallout tone="warning" title="Diseño de registro por validar" role="status">
            Antes de la primera importación real, envía un fichero de prueba a la gestoría y confirma la longitud de subcuenta, la codificación y el separador decimal.
          </CocoaCallout>
        ) : null}

        {createError ? (
          <CocoaCallout tone="danger" title="No se pudo generar la exportación" role="alert">
            {statementsErrorMessage(createError)}
          </CocoaCallout>
        ) : null}
      </CocoaFormSection>

      <CocoaSection
        title="Historial"
        meta={historyReady ? plural(history.length, "exportación", "exportaciones") : undefined}
        padding={historyReady ? "none" : "md"}
        style={{ overflow: "clip" }}
        aria-label="Exportaciones anteriores"
      >
        {historyBody}
      </CocoaSection>
    </CocoaPage>
  );
}

export default GestoriaExportScreen;

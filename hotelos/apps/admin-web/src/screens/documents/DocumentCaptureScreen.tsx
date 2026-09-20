// Operaciones › Digitalizar — la pantalla de captura del centro (Tanda T9 ·
// lote T9-10, diseño docs/design/DOCUMENTOS-DIGITALIZACION.md §6.4 y §10
// «Montaje» / «Captura»; ítem propio de Operaciones en /operaciones/digitalizar,
// sin gate de módulo: los centros de Faranda no tienen procurement_inventory).
//
// Cocoa 22 sin estilos inline: CocoaPage con la tira de KPI (capturados hoy ·
// pendientes de enviar · en valija · devueltos, calculados sobre la bandeja del
// centro con `captureKpis`), el aviso fijo «Copia digital no certificada:
// conserva el papel», el aviso de éxito con los números de registro recién
// asignados y «Imprimir etiqueta» (DocumentLabelDialog), y la CocoaTable de la
// bandeja con acciones de fila «Enviar a la oficina» · «Dividir» · «Ver» y
// selección múltiple cuya barra (CocoaActionBar del propio CocoaTable) lleva
// «Cerrar valija (N)» → POST …/dispatch-batches → diálogo con la hoja de
// remesa (Blob abierto en una pestaña). «Digitalizar» abre
// DocumentCaptureDrawer (PWA: «Hacer foto» grande a 400 px).
//
// Lectura: useApiData sobre GET /properties/:propertyId/documents (envelope,
// 200 filas). Escrituras por documentsApi. Permiso de escritura:
// canDo(useNavGate(), "documents.capture"); sin él la pantalla se lee y todos
// los botones se deshabilitan con la razón. Estado del API (2026-09-19):
// captura, bandeja, descarga y send-to-office existen; split y la valija
// llegan con el lote de flujo (hoy 404 → frase de DOCUMENT_ERROR_MESSAGES).

import { useMemo, useState } from "react";
import type { DocumentDispatchBatchDto, DocumentListPage, IncomingDocumentRecord } from "@hotelos/shared";
import { CocoaBadge, CocoaButton, CocoaCallout, CocoaDialog, CocoaField, CocoaInput, CocoaKpi, CocoaKpiStrip, CocoaPage, CocoaSection, CocoaState, CocoaTable, useViewportTier, type CocoaTableColumn } from "../../components/cocoa";
import { openBlob } from "../../components/billing/download";
import { useToast } from "../../components/Toast";
import { ACTIONS, STATUS_LABELS, errorStateFor } from "../../content/actions";
import { useApiData } from "../../hooks/useApiData";
import { dateTime, money, number, plural } from "../../lib/format";
import { useNavGate } from "../../navigation/useEnabledModules";
import { useActiveProperty } from "../../services/activeProperty";
import { documentListPath, documentListQuery, documentsApi } from "../../services/documentsApi";
import { canDo, todayIso } from "../accounting/accounting-ui";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { DocumentCaptureDrawer } from "./DocumentCaptureDrawer";
import { DIGITAL_COPY_NOTICE, DocumentLabelDialog, captureKpis, parsePageRanges } from "./DocumentLabelDialog";
import { DOCUMENT_KIND_LABELS, DOCUMENT_STATUS_LABELS, PHYSICAL_STATUS_LABELS, documentErrorMessage, formatBytes, formatRegistry, statusTone } from "./documents-helpers";

const HEADER = treeHeaderFor("DocumentCaptureScreen", { eyebrow: "Operaciones", title: "Digitalizar" });
const LOAD_ERROR = errorStateFor("los documentos del centro");
const EMPTY_ROWS: IncomingDocumentRecord[] = [];
/** Bandeja del centro: las 200 más recientes (MAX_PAGE_LIMIT 500 en lib/pagination.ts). */
const LIST_LIMIT = 200;
const POPUP_BLOCKED = "El navegador bloqueó la ventana: permite las ventanas emergentes para esta página.";
const NO_PERMISSION = "Necesitas el permiso de captura de documentos";

/** Proveedor · nº de documento · importe extraídos, o el título, o el estado de la extracción. */
function documentSummary(row: IncomingDocumentRecord): string {
  const parts = [row.supplierName, row.documentNumber, row.totalAmount ? money(row.totalAmount, row.currency) : null].filter(Boolean);
  if (parts.length > 0) return parts.join(" · ");
  if (row.title) return row.title;
  return row.extractionStatus === "pending" ? "Extracción en curso" : row.extractionStatus === "failed" ? "Extracción fallida" : "Sin datos extraídos";
}

const COLUMNS: CocoaTableColumn<IncomingDocumentRecord>[] = [
  { key: "registryNumber", label: "Registro", fit: true, render: (row) => <strong className="cocoa-mono">{formatRegistry(row.registryNumber, { short: true })}</strong> },
  {
    key: "kind",
    label: "Tipo",
    fit: true,
    render: (row) => (
      <CocoaBadge tone="neutral" variant="tinted" uppercase={false}>
        {DOCUMENT_KIND_LABELS[row.kind] ?? row.kind}
      </CocoaBadge>
    )
  },
  { key: "status", label: "Estado", fit: true, render: (row) => <CocoaBadge tone={statusTone(row.status)}>{DOCUMENT_STATUS_LABELS[row.status] ?? row.status}</CocoaBadge> },
  { key: "physicalStatus", label: "Papel", hideOnNarrow: true, render: (row) => PHYSICAL_STATUS_LABELS[row.physicalStatus] ?? row.physicalStatus },
  { key: "capturedAt", label: "Capturado", hideOnNarrow: true, render: (row) => dateTime(row.capturedAt) },
  { key: "document", label: "Documento", showFrom: "laptop", truncate: 48, render: documentSummary },
  { key: "size", label: "Páginas · tamaño", align: "right", showFrom: "laptop", render: (row) => `${number(row.pageCount)} · ${formatBytes(row.sizeBytes)}` }
];

export function DocumentCaptureScreen() {
  const { propertyId, propertyName } = useActiveProperty();
  const canCapture = canDo(useNavGate(), "documents.capture");
  const phone = useViewportTier() === "phone";
  const { showToast } = useToast();
  const state = useApiData<DocumentListPage>(documentListPath(propertyId), { query: documentListQuery({ limit: LIST_LIMIT }) });
  const rows = state.data?.items ?? EMPTY_ROWS;
  const kpis = useMemo(() => captureKpis(rows, todayIso()), [rows]);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [lastCaptured, setLastCaptured] = useState<IncomingDocumentRecord[]>([]);
  const [labelRecords, setLabelRecords] = useState<IncomingDocumentRecord[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [dispatchBusy, setDispatchBusy] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [dispatchResult, setDispatchResult] = useState<DocumentDispatchBatchDto | null>(null);
  const [splitTarget, setSplitTarget] = useState<IncomingDocumentRecord | null>(null);
  const [splitText, setSplitText] = useState("");
  const [splitBusy, setSplitBusy] = useState(false);

  const pageState = state.loading && !state.data ? "loading" : state.error && !state.data ? "error" : "ready";
  const selectedRows = useMemo(() => rows.filter((row) => selected.includes(row.id)), [rows, selected]);
  const splitParsed = splitTarget ? parsePageRanges(splitText, splitTarget.pageCount) : null;

  function onCaptured(records: IncomingDocumentRecord[]) {
    setLastCaptured(records);
    state.refresh();
  }

  async function send(row: IncomingDocumentRecord) {
    setBusyId(row.id);
    try {
      await documentsApi.sendToOffice(row.id, propertyId);
      showToast(`${formatRegistry(row.registryNumber)} enviado a la oficina.`, { variant: "success" });
      state.refresh();
    } catch (err) {
      showToast(documentErrorMessage(err, "No se pudo enviar el documento a la oficina."), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  }

  async function view(row: IncomingDocumentRecord) {
    setBusyId(row.id);
    try {
      const { blob } = await documentsApi.downloadFile(row.id, { inline: true }, propertyId);
      if (!openBlob(blob)) showToast(POPUP_BLOCKED, { variant: "warning" });
    } catch (err) {
      showToast(documentErrorMessage(err, "No se pudo abrir el documento."), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  }

  function openSplit(row: IncomingDocumentRecord) {
    setSplitTarget(row);
    setSplitText(row.pageCount > 1 ? `1-${row.pageCount - 1}, ${row.pageCount}` : "");
  }

  async function confirmSplit() {
    if (!splitTarget || !splitParsed || splitParsed.error) return;
    setSplitBusy(true);
    try {
      const { pieces } = await documentsApi.split(splitTarget.id, { ranges: splitParsed.ranges }, propertyId);
      showToast(`${formatRegistry(splitTarget.registryNumber)} dividido en ${plural(pieces.length, "documento", "documentos")}.`, { variant: "success" });
      setSplitTarget(null);
      setLastCaptured(pieces);
      state.refresh();
    } catch (err) {
      showToast(documentErrorMessage(err, "No se pudo dividir el documento."), { variant: "error" });
    } finally {
      setSplitBusy(false);
    }
  }

  async function closeDispatch() {
    if (selected.length === 0) return;
    setDispatchBusy(true);
    setDispatchError(null);
    try {
      const batch = await documentsApi.dispatchBatches.create({ documentIds: selected }, propertyId);
      setDispatchOpen(false);
      setDispatchResult(batch);
      setSelected([]);
      state.refresh();
    } catch (err) {
      setDispatchError(documentErrorMessage(err, "No se pudo cerrar la valija."));
    } finally {
      setDispatchBusy(false);
    }
  }

  async function openSheet(batch: DocumentDispatchBatchDto) {
    try {
      const { blob } = await documentsApi.dispatchBatches.sheet(batch.id, { inline: true }, propertyId);
      if (!openBlob(blob)) showToast(POPUP_BLOCKED, { variant: "warning" });
    } catch (err) {
      showToast(documentErrorMessage(err, "No se pudo abrir la hoja de remesa."), { variant: "error" });
    }
  }

  return (
    <CocoaPage
      eyebrow={`${HEADER.eyebrow} · ${propertyName}`}
      title={HEADER.title}
      subtitle="Facturas, albaranes, tiques y correspondencia que llegan al centro: sube el PDF o haz una foto, anota el número de registro en el papel y envíalo a la oficina en la valija."
      actions={
        <>
          {state.error && state.data ? (
            <CocoaBadge tone="danger" title={state.error}>
              {STATUS_LABELS.loadError}
            </CocoaBadge>
          ) : null}
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => state.refresh()} title={ACTIONS.refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" onClick={() => setDrawerOpen(true)} disabled={!canCapture} title={canCapture ? undefined : NO_PERMISSION}>
            Digitalizar
          </CocoaButton>
        </>
      }
      state={pageState}
      error={{ title: LOAD_ERROR.title, message: LOAD_ERROR.message, onRetry: () => state.refresh() }}
      commands={[
        { id: "documents-capture", label: "Digitalizar un documento", run: () => setDrawerOpen(true) },
        { id: "documents-refresh", label: "Actualizar la bandeja de documentos", run: () => state.refresh() }
      ]}
    >
      <CocoaKpiStrip aria-label="Indicadores de digitalización del centro">
        <CocoaKpi label="Capturados hoy" value={number(kpis.capturedToday)} caption="con número de registro" polarity="neutral" status="ok" />
        <CocoaKpi label="Pendientes de enviar" value={number(kpis.pendingToSend)} caption="capturados sin enviar" polarity="neutral" status={kpis.pendingToSend > 0 ? "warning" : "ok"} />
        <CocoaKpi label="En valija" value={number(kpis.inTransit)} caption="papel en tránsito a la oficina" polarity="neutral" status="ok" />
        <CocoaKpi label="Devueltos" value={number(kpis.returned)} caption="a recapturar" polarity="neutral" status={kpis.returned > 0 ? "critical" : "ok"} />
      </CocoaKpiStrip>

      {!canCapture ? <p className="cocoa-note">{NO_PERMISSION} («documents.capture») para digitalizar, enviar a la oficina o cerrar la valija: la bandeja se puede consultar.</p> : null}

      <CocoaCallout tone="info" title="Copia digital no certificada: conserva el papel">
        {DIGITAL_COPY_NOTICE} Escribe el número de registro en el original o pega la etiqueta, y mándalo a la oficina en la valija con su hoja de remesa.
      </CocoaCallout>

      {lastCaptured.length > 0 ? (
        <CocoaCallout
          tone="success"
          role="status"
          title={lastCaptured.length === 1 ? "Número de registro asignado" : `${lastCaptured.length} números de registro asignados`}
          actions={
            <>
              <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setLabelRecords(lastCaptured)}>
                Imprimir etiqueta
              </CocoaButton>
              <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setLastCaptured([])}>
                {ACTIONS.close}
              </CocoaButton>
            </>
          }
        >
          <div className="cocoa-stack" data-gap="2">
            <ul className="c22-section__list">
              {lastCaptured.map((record) => (
                <li key={record.id}>
                  <strong className="cocoa-mono">{formatRegistry(record.registryNumber)}</strong>
                  <span>
                    {DOCUMENT_KIND_LABELS[record.kind] ?? record.kind} · {plural(record.pageCount, "página", "páginas")} · {formatBytes(record.sizeBytes)}
                  </span>
                </li>
              ))}
            </ul>
            <span className="cocoa-note">Escribe el número en el papel o imprime la etiqueta. La clasificación y la extracción siguen en segundo plano; envíalo a la oficina cuando el papel esté listo.</span>
          </div>
        </CocoaCallout>
      ) : null}

      <CocoaSection title="Bandeja del centro" meta={state.data ? plural(rows.length, "documento", "documentos") : undefined}>
        <CocoaTable
          columns={COLUMNS}
          rows={rows}
          rowKey="id"
          caption="Documentos digitalizados en el centro"
          density="compact"
          loading={state.isValidating && rows.length > 0}
          keepDataWhileLoading
          selectable="multiple"
          selectedKeys={selected}
          onSelectionChange={setSelected}
          rowTone={(row) => (row.status === "returned_to_centre" ? "warning" : undefined)}
          rowActionsVisible="always"
          rowActions={(row) => (
            <>
              <CocoaButton
                variant="plain"
                size="small"
                onClick={() => void send(row)}
                loading={busyId === row.id}
                disabled={!canCapture || row.status !== "captured" || busyId !== null}
                title={!canCapture ? NO_PERMISSION : row.status !== "captured" ? `Solo se envía un documento capturado (este está «${DOCUMENT_STATUS_LABELS[row.status] ?? row.status}»)` : undefined}
              >
                Enviar a la oficina
              </CocoaButton>
              <CocoaButton
                variant="plain"
                tone="neutral"
                size="small"
                onClick={() => openSplit(row)}
                disabled={!canCapture || row.status !== "captured" || row.pageCount < 2 || busyId !== null}
                title={!canCapture ? NO_PERMISSION : row.pageCount < 2 ? "El documento tiene una sola página" : row.status !== "captured" ? "Solo se divide un documento capturado" : undefined}
              >
                Dividir
              </CocoaButton>
              <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => void view(row)} disabled={busyId !== null}>
                {ACTIONS.view}
              </CocoaButton>
            </>
          )}
          batchBar={(selection) => (
            <CocoaButton variant="filled" tone="accent" size="small" onClick={() => setDispatchOpen(true)} disabled={!canCapture || selection.count === 0} title={canCapture ? undefined : NO_PERMISSION}>
              {`Cerrar valija (${selection.count})`}
            </CocoaButton>
          )}
          emptyState={
            <CocoaState
              kind="empty"
              title="Sin documentos digitalizados"
              message="Sube un PDF o haz una foto: cada documento recibe su número de registro al instante."
              primaryAction={canCapture ? { label: "Digitalizar", onClick: () => setDrawerOpen(true) } : undefined}
            />
          }
        />
      </CocoaSection>

      <DocumentCaptureDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} propertyId={propertyId} canCapture={canCapture} phone={phone} onCaptured={onCaptured} />

      <DocumentLabelDialog open={labelRecords !== null} onClose={() => setLabelRecords(null)} records={labelRecords ?? EMPTY_ROWS} propertyName={propertyName} />

      <CocoaDialog
        open={dispatchOpen}
        onClose={() => {
          if (!dispatchBusy) setDispatchOpen(false);
        }}
        title={`Cerrar valija (${selectedRows.length})`}
        description="Se genera la hoja de remesa con los números de registro y el papel pasa a «En valija» hasta que la oficina lo reciba."
        confirmLabel="Cerrar valija"
        onConfirm={() => void closeDispatch()}
        busy={dispatchBusy}
        confirmDisabled={selectedRows.length === 0}
      >
        <div className="cocoa-stack" data-gap="2">
          <ul className="c22-section__list">
            {selectedRows.map((row) => (
              <li key={row.id}>
                <strong className="cocoa-mono">{formatRegistry(row.registryNumber)}</strong>
                <span>
                  {DOCUMENT_KIND_LABELS[row.kind] ?? row.kind} · {DOCUMENT_STATUS_LABELS[row.status] ?? row.status} · {PHYSICAL_STATUS_LABELS[row.physicalStatus] ?? row.physicalStatus}
                </span>
              </li>
            ))}
          </ul>
          {dispatchError ? (
            <CocoaCallout tone="danger" title="No se pudo cerrar la valija" role="alert">
              {dispatchError}
            </CocoaCallout>
          ) : null}
        </div>
      </CocoaDialog>

      <CocoaDialog
        open={dispatchResult !== null}
        onClose={() => setDispatchResult(null)}
        title="Valija cerrada"
        description={dispatchResult ? `Hoja de remesa ${dispatchResult.batchNumber} con ${plural(dispatchResult.documentCount, "documento", "documentos")}: imprímela y métela en la valija con el papel.` : undefined}
        confirmLabel="Abrir hoja de remesa"
        cancelLabel={ACTIONS.close}
        onConfirm={() => (dispatchResult ? void openSheet(dispatchResult) : undefined)}
      >
        {dispatchResult?.registryNumbers && dispatchResult.registryNumbers.length > 0 ? (
          <ul className="c22-section__list">
            {dispatchResult.registryNumbers.map((registry) => (
              <li key={registry}>
                <strong className="cocoa-mono">{formatRegistry(registry)}</strong>
              </li>
            ))}
          </ul>
        ) : null}
      </CocoaDialog>

      <CocoaDialog
        open={splitTarget !== null}
        onClose={() => {
          if (!splitBusy) setSplitTarget(null);
        }}
        title={splitTarget ? `Dividir ${formatRegistry(splitTarget.registryNumber)}` : "Dividir"}
        description={splitTarget ? `El documento tiene ${plural(splitTarget.pageCount, "página", "páginas")}. Indica los rangos separados por comas; cada trozo recibe su propio número de registro.` : undefined}
        confirmLabel="Dividir"
        onConfirm={() => void confirmSplit()}
        busy={splitBusy}
        confirmDisabled={!splitParsed || splitParsed.error !== null}
        submitOnEnter
      >
        <CocoaField label="Rangos de páginas" required help="Ejemplo: 1-2, 3-4" error={splitText && splitParsed?.error ? splitParsed.error : undefined}>
          <CocoaInput value={splitText} onChange={setSplitText} placeholder="1-2, 3-4" inputMode="numeric" disabled={splitBusy} />
        </CocoaField>
      </CocoaDialog>
    </CocoaPage>
  );
}

export default DocumentCaptureScreen;

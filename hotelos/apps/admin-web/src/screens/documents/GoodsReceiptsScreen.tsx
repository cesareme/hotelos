// Operaciones › Compras e inventario › Recepciones — recepciones de mercancía
// y su cotejo con las facturas recibidas (Tanda T9 · lote T9-12, diseño
// docs/design/DOCUMENTOS-DIGITALIZACION.md §7.2 y §10 «Recepciones»; pestaña
// /operaciones/compras/recepciones de ComprasInventarioTabs, módulo
// procurement_inventory).
//
// Lista con useApiData sobre goodsReceiptsApi (goodsReceiptListPath +
// goodsReceiptListQuery: GET /properties/:id/goods-receipts, envelope), filtros
// de estado y texto, detalle en CocoaDrawer (líneas, cotejos, enlace a la
// factura cotejada y al documento de origen, «Disputar» con motivo), alta
// manual en CocoaDrawer con el GoodsReceiptForm compartido con la revisión de
// documentos (artículo y ubicación opcionales: con artículo la recepción mueve
// existencias). Escrituras con canDo(useNavGate(), "procurement.manage"); sin
// la clave la lista se lee y los botones se deshabilitan con la razón. Sin
// estilos inline (Cocoa 22).

import { useMemo, useState } from "react";
import type { BillLineMatchDto, GoodsReceiptDetail, GoodsReceiptLineDto, GoodsReceiptRecord, GoodsReceiptStatus } from "@hotelos/shared";
import { GOODS_RECEIPT_STATUSES } from "@hotelos/shared";
import { CocoaBadge, CocoaButton, CocoaCallout, CocoaDialog, CocoaDrawer, CocoaField, CocoaInput, CocoaPage, CocoaSearchInput, CocoaSection, CocoaSelect, CocoaState, CocoaTable, CocoaToolbar, type CocoaTableColumn } from "../../components/cocoa";
import type { CocoaSelectOption } from "../../components/cocoa/CocoaSelect";
import type { CocoaTone } from "../../components/cocoa/cocoa-tones";
import { useToast } from "../../components/Toast";
import { ACTIONS, STATUS_LABELS, errorStateFor } from "../../content/actions";
import { useApiData } from "../../hooks/useApiData";
import { date, money, number, plural } from "../../lib/format";
import { navigateTo } from "../../lib/navigate";
import { useNavGate } from "../../navigation/useEnabledModules";
import { useActiveProperty } from "../../services/activeProperty";
import { fetchInventoryItems, fetchStockLocations, type InventoryItem, type StockLocation } from "../../services/fnbInventoryApi";
import { goodsReceiptListPath, goodsReceiptListQuery, goodsReceiptsApi, type GoodsReceiptListPage } from "../../services/goodsReceiptsApi";
import { listSuppliers } from "../../services/payablesApi";
import { canDo, todayIso } from "../accounting/accounting-ui";
import { useLoader } from "../payables/payables-shared";
import { useTabHost } from "../tabs/TabHost";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { GoodsReceiptForm, receiptDraftFrom, receiptDraftToRequest, validateReceiptDraft, type ReceiptDraft } from "./DocumentReviewPane";
import { documentErrorMessage, formatRegistry } from "./documents-helpers";

const HEADER = treeHeaderFor("GoodsReceiptsScreen", { eyebrow: "Operaciones · Compras e inventario", title: "Recepciones" });
const LOAD_ERROR = errorStateFor("las recepciones de mercancía");
const EMPTY_ROWS: GoodsReceiptRecord[] = [];
const LIST_LIMIT = 200;
const NO_PERMISSION = "Necesitas el permiso de gestión de compras";

export const GOODS_RECEIPT_STATUS_LABELS: Record<GoodsReceiptStatus, string> = {
  received: "Recibida",
  matched: "Cotejada",
  billed: "Facturada",
  disputed: "En disputa"
};

const GOODS_RECEIPT_STATUS_TONES: Record<GoodsReceiptStatus, CocoaTone> = { received: "info", matched: "success", billed: "success", disputed: "danger" };

const MATCH_STATUS_LABELS: Record<BillLineMatchDto["status"], string> = { auto: "Automático", confirmed: "Confirmado", rejected: "Rechazado" };

function decimal(value: string | null | undefined, digits = 3): string {
  if (value === null || value === undefined) return "—";
  return number(value, { maximumFractionDigits: digits });
}

export function GoodsReceiptsScreen() {
  const hosted = useTabHost() !== null;
  const { propertyId, propertyName } = useActiveProperty();
  const canManage = canDo(useNavGate(), "procurement.manage");
  const { showToast } = useToast();

  const [status, setStatus] = useState<"" | GoodsReceiptStatus>("");
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<ReceiptDraft>(() => receiptDraftFrom(null, todayIso()));
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [disputeReason, setDisputeReason] = useState("");

  const list = useApiData<GoodsReceiptListPage>(goodsReceiptListPath(propertyId), { query: goodsReceiptListQuery({ status: status || undefined, q: q.trim() || undefined, limit: LIST_LIMIT }) });
  const rows = list.data?.items ?? EMPTY_ROWS;
  const pageState = list.loading && !list.data ? "loading" : list.error && !list.data ? "error" : "ready";

  const detail = useLoader<GoodsReceiptDetail | null>(() => (selectedId ? goodsReceiptsApi.get(selectedId, propertyId) : Promise.resolve(null)), `${propertyId}|${selectedId ?? ""}`, "No se pudo cargar la recepción.");
  const receipt = detail.data;
  const suppliers = useLoader(() => listSuppliers({ active: true, limit: 500 }), "suppliers", "No se pudo cargar el directorio de proveedores.");
  const inventory = useLoader<{ items: InventoryItem[]; locations: StockLocation[] }>(
    () => Promise.all([fetchInventoryItems(propertyId).catch(() => []), fetchStockLocations(propertyId).catch(() => [])]).then(([items, locations]) => ({ items, locations })),
    `inventory|${propertyId}`,
    ""
  );

  const statusOptions = useMemo<CocoaSelectOption[]>(() => [{ value: "", label: "Todos los estados" }, ...GOODS_RECEIPT_STATUSES.map((value) => ({ value, label: GOODS_RECEIPT_STATUS_LABELS[value] }))], []);
  const errors = useMemo(() => validateReceiptDraft(draft), [draft]);

  const columns = useMemo<CocoaTableColumn<GoodsReceiptRecord>[]>(
    () => [
      { key: "deliveryNoteNumber", label: "Nº de albarán", fit: true, render: (row) => <strong className="cocoa-mono">{row.deliveryNoteNumber}</strong> },
      { key: "deliveryDate", label: "Entrega", fit: true, render: (row) => date(row.deliveryDate, "short") },
      { key: "supplier", label: "Proveedor", truncate: 40, render: (row) => row.supplierName ?? row.supplierTaxId ?? "—" },
      { key: "status", label: "Estado", fit: true, render: (row) => <CocoaBadge tone={GOODS_RECEIPT_STATUS_TONES[row.status]}>{GOODS_RECEIPT_STATUS_LABELS[row.status] ?? row.status}</CocoaBadge> },
      { key: "lineCount", label: "Líneas", align: "right", fit: true, showFrom: "tablet", render: (row) => number(row.lineCount) },
      { key: "baseTotal", label: "Base", align: "right", fit: true, render: (row) => money(row.baseTotal) },
      { key: "registryNumber", label: "Documento", fit: true, showFrom: "laptop", render: (row) => (row.registryNumber ? <span className="cocoa-mono">{formatRegistry(row.registryNumber, { short: true })}</span> : "Alta manual") },
      // RV-16: nombre resuelto por el API cuando `receivedBy` es un usuario; el texto tecleado en un alta manual se muestra tal cual.
      { key: "receivedBy", label: "Recibido por", showFrom: "desktop", truncate: 24, render: (row) => row.receivedByName ?? row.receivedBy ?? "—" }
    ],
    []
  );

  const lineColumns = useMemo<CocoaTableColumn<GoodsReceiptLineDto>[]>(
    () => [
      { key: "lineNo", label: "Nº", fit: true, render: (line) => number(line.lineNo) },
      { key: "description", label: "Descripción", truncate: 48 },
      { key: "quantityReceived", label: "Cantidad", align: "right", fit: true, render: (line) => `${decimal(line.quantityReceived)}${line.unit ? ` ${line.unit}` : ""}` },
      { key: "unitPrice", label: "Precio", align: "right", fit: true, showFrom: "tablet", render: (line) => (line.unitPrice ? number(line.unitPrice, { minimumFractionDigits: 2, maximumFractionDigits: 4 }) : "—") },
      { key: "base", label: "Base", align: "right", fit: true, render: (line) => (line.base ? money(line.base) : "—") },
      { key: "stock", label: "Existencias", fit: true, showFrom: "laptop", render: (line) => (line.stockMovementId ? "Movimiento creado" : line.inventoryItemId ? "Artículo sin movimiento" : "Sin artículo") }
    ],
    []
  );

  function openCreate() {
    setDraft(receiptDraftFrom(null, todayIso()));
    setTouched(false);
    setCreateOpen(true);
  }

  async function create() {
    setTouched(true);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    try {
      const created = await goodsReceiptsApi.create(receiptDraftToRequest(draft), propertyId);
      showToast(`Recepción ${created.deliveryNoteNumber} registrada.`, { variant: "success" });
      setCreateOpen(false);
      list.refresh();
      setSelectedId(created.id);
    } catch (err) {
      showToast(documentErrorMessage(err, "No se pudo registrar la recepción."), { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function dispute() {
    if (!receipt) return;
    setBusy(true);
    try {
      await goodsReceiptsApi.dispute(receipt.id, { reason: disputeReason.trim() }, propertyId);
      showToast(`Recepción ${receipt.deliveryNoteNumber} en disputa.`, { variant: "success" });
      setDisputeOpen(false);
      setDisputeReason("");
      detail.refresh();
      list.refresh();
    } catch (err) {
      showToast(documentErrorMessage(err, "No se pudo disputar la recepción."), { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const canDispute = Boolean(receipt && (receipt.status === "received" || receipt.status === "matched"));

  return (
    <CocoaPage
      eyebrow={`${HEADER.eyebrow} · ${propertyName}`}
      title={HEADER.title}
      subtitle={hosted ? undefined : "Albaranes recibidos en el centro, con o sin documento digitalizado, y su cotejo a dos vías con las facturas de proveedor."}
      actions={
        <>
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => list.refresh()} title={ACTIONS.refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
          <CocoaButton variant="filled" tone="accent" size="small" onClick={openCreate} disabled={!canManage} title={canManage ? undefined : NO_PERMISSION}>
            Nueva recepción
          </CocoaButton>
        </>
      }
      state={pageState}
      error={{ title: LOAD_ERROR.title, message: list.error ?? LOAD_ERROR.message, onRetry: () => list.refresh() }}
      commands={[
        { id: "receipts-new", label: "Registrar una recepción", run: openCreate },
        { id: "receipts-refresh", label: "Actualizar las recepciones", run: () => list.refresh() }
      ]}
    >
      {!canManage ? <p className="cocoa-note">{NO_PERMISSION} («procurement.manage») para registrar o disputar recepciones: la lista se puede consultar.</p> : null}

      <CocoaToolbar
        variant="content"
        aria-label="Filtros de recepciones"
        leftSlot={
          <div className="cocoa-row" data-gap="2">
            <CocoaSearchInput value={q} onChange={setQ} debounceMs={300} placeholder="Nº de albarán o proveedor…" aria-label="Buscar recepciones" />
            <CocoaSelect size="small" inline aria-label="Estado" value={status} onChange={(v) => setStatus(v as "" | GoodsReceiptStatus)} options={statusOptions} />
          </div>
        }
        rightSlot={
          list.error && list.data ? (
            <CocoaBadge tone="danger" title={list.error}>
              {STATUS_LABELS.loadError}
            </CocoaBadge>
          ) : undefined
        }
      />

      <CocoaSection title="Recepciones del centro" meta={list.data ? plural(rows.length, "recepción", "recepciones") : undefined}>
        <CocoaTable
          columns={columns}
          rows={rows}
          rowKey="id"
          caption="Recepciones de mercancía"
          density="compact"
          loading={list.isValidating && rows.length > 0}
          keepDataWhileLoading
          selectedKey={selectedId ?? undefined}
          onSelect={(row) => setSelectedId(row.id)}
          rowTitle={() => "Abrir el detalle de la recepción"}
          rowTone={(row) => (row.status === "disputed" ? "danger" : undefined)}
          emptyState={<CocoaState kind="empty" title="Sin recepciones" message="Las recepciones nacen al aprobar un albarán digitalizado o con «Nueva recepción»." primaryAction={canManage ? { label: "Nueva recepción", onClick: openCreate } : undefined} />}
        />
      </CocoaSection>

      <CocoaDrawer
        open={selectedId !== null}
        onClose={() => {
          if (!busy) setSelectedId(null);
        }}
        title={receipt ? `Albarán ${receipt.deliveryNoteNumber}` : "Recepción"}
        subtitle={receipt ? `${receipt.supplierName ?? receipt.supplierTaxId ?? "Proveedor sin identificar"} · ${date(receipt.deliveryDate, "long")}` : undefined}
        size="lg"
        loading={detail.loading && !receipt}
        focusKey={receipt?.id}
        footer={
          receipt ? (
            <div className="cocoa-row" data-gap="2" data-justify="between">
              <div className="cocoa-row" data-gap="2">
                {receipt.incomingDocumentId ? (
                  <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("IncomingDocumentsScreen", receipt.incomingDocumentId ?? undefined)}>
                    Ver el documento
                  </CocoaButton>
                ) : null}
                {receipt.supplierBillIds.map((billId, index) => (
                  <CocoaButton key={billId} variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("SupplierBillsScreen", billId)}>
                    {receipt.supplierBillIds.length > 1 ? `Factura cotejada ${index + 1}` : "Ver la factura cotejada"}
                  </CocoaButton>
                ))}
              </div>
              <CocoaButton variant="bordered" tone="destructive" size="small" onClick={() => setDisputeOpen(true)} disabled={!canManage || !canDispute || busy} title={!canManage ? NO_PERMISSION : !canDispute ? "Solo se disputa una recepción recibida o cotejada" : undefined}>
                Disputar
              </CocoaButton>
            </div>
          ) : undefined
        }
      >
        {detail.error ? <CocoaState kind="error" inline title="No se pudo cargar la recepción" message={detail.error} onRetry={() => detail.refresh()} /> : null}
        {receipt ? (
          <div className="cocoa-stack" data-gap="4">
            <div className="cocoa-cluster">
              <CocoaBadge tone={GOODS_RECEIPT_STATUS_TONES[receipt.status]}>{GOODS_RECEIPT_STATUS_LABELS[receipt.status] ?? receipt.status}</CocoaBadge>
              {receipt.registryNumber ? (
                <CocoaBadge tone="neutral" variant="outline" uppercase={false}>
                  {formatRegistry(receipt.registryNumber)}
                </CocoaBadge>
              ) : (
                <CocoaBadge tone="neutral" variant="outline" uppercase={false}>
                  Alta manual
                </CocoaBadge>
              )}
              <CocoaBadge tone="neutral" variant="outline" uppercase={false}>
                {`Base ${money(receipt.baseTotal)}`}
              </CocoaBadge>
            </div>
            {receipt.note ? <span className="cocoa-note">{receipt.note}</span> : null}
            {receipt.status === "disputed" ? (
              <CocoaCallout tone="danger" title="Recepción en disputa">
                El proveedor debe aclarar las diferencias antes de cotejarla con una factura.
              </CocoaCallout>
            ) : null}
            <CocoaSection title={`Líneas (${receipt.lines.length})`} headingLevel={3} scroll="x">
              <CocoaTable columns={lineColumns} rows={receipt.lines} rowKey="id" caption="Líneas de la recepción" density="compact" />
            </CocoaSection>
            <CocoaSection title="Cotejo con facturas" headingLevel={3} meta={receipt.matches.length > 0 ? plural(receipt.matches.length, "línea cotejada", "líneas cotejadas") : undefined}>
              {receipt.matches.length === 0 ? (
                <span className="cocoa-note">Sin cotejar: el cotejo se lanza desde la factura recibida («Cotejar con albarán») o al aprobar la factura digitalizada.</span>
              ) : (
                <ul className="c22-section__list">
                  {receipt.matches.map((match) => (
                    <li key={match.id}>
                      <span>{`Línea de albarán ${receipt.lines.find((line) => line.id === match.goodsReceiptLineId)?.lineNo ?? "?"} · cantidad ${decimal(match.matchedQuantity)}${match.matchedBase ? ` · base ${money(match.matchedBase)}` : ""}`}</span>
                      <span className="cocoa-cluster">
                        {match.quantityVariance && Number(match.quantityVariance) !== 0 ? (
                          <CocoaBadge tone="warning" variant="dot" size="small">
                            {`Cantidad ${decimal(match.quantityVariance)}`}
                          </CocoaBadge>
                        ) : null}
                        {match.priceVariance && Number(match.priceVariance) !== 0 ? (
                          <CocoaBadge tone="warning" variant="dot" size="small">
                            {`Precio ${number(match.priceVariance, { maximumFractionDigits: 4 })}`}
                          </CocoaBadge>
                        ) : null}
                        <CocoaBadge tone={match.status === "rejected" ? "danger" : match.status === "confirmed" ? "success" : "info"} size="small">
                          {MATCH_STATUS_LABELS[match.status]}
                        </CocoaBadge>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CocoaSection>
          </div>
        ) : null}
      </CocoaDrawer>

      <CocoaDrawer
        open={createOpen}
        onClose={() => {
          if (!busy) setCreateOpen(false);
        }}
        title="Nueva recepción"
        subtitle="Albarán recibido sin documento digitalizado: proveedor, número, fecha y líneas (artículo y ubicación opcionales)."
        size="lg"
        dismissible={!busy}
        footer={
          <div className="cocoa-row" data-gap="2" data-justify="end">
            <CocoaButton variant="bordered" tone="neutral" onClick={() => setCreateOpen(false)} disabled={busy}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void create()} loading={busy} disabled={!canManage || (touched && Object.keys(errors).length > 0)} title={canManage ? undefined : NO_PERMISSION}>
              Registrar recepción
            </CocoaButton>
          </div>
        }
      >
        <GoodsReceiptForm value={draft} onChange={setDraft} errors={touched ? errors : undefined} suppliers={{ rows: suppliers.data ?? [], loading: suppliers.loading, error: suppliers.error }} inventory={inventory.data ?? undefined} disabled={busy || !canManage} />
      </CocoaDrawer>

      <CocoaDialog
        open={disputeOpen}
        onClose={() => {
          if (!busy) setDisputeOpen(false);
        }}
        title={receipt ? `Disputar el albarán ${receipt.deliveryNoteNumber}` : "Disputar"}
        description="La recepción pasa a «En disputa» hasta que el proveedor aclare las diferencias; queda auditado con el motivo."
        tone="destructive"
        confirmLabel="Disputar"
        onConfirm={() => void dispute()}
        busy={busy}
        confirmDisabled={disputeReason.trim().length < 3}
      >
        <CocoaField label="Motivo" required help="Mínimo 3 caracteres.">
          <CocoaInput value={disputeReason} onChange={setDisputeReason} multiline rows={3} disabled={busy} />
        </CocoaField>
      </CocoaDialog>
    </CocoaPage>
  );
}

export default GoodsReceiptsScreen;

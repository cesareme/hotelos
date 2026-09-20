// Finanzas › Proveedores y gastos › Documentos — bandeja y revisión lado a lado
// de la oficina (Tanda T9 · lote T9-12, diseño
// docs/design/DOCUMENTOS-DIGITALIZACION.md §10 «Bandeja y revisión» y «Cola de
// la oficina»; pestaña /finanzas/proveedores/documentos de ProveedoresTabs).
//
// CocoaSplitView: `sidebar` = la lista filtrable (CocoaSegmentedControl
// Pendientes · En revisión · Aprobados · Devueltos · Archivo, búsqueda, «solo
// vencidos», insignias de SLA y vencimiento), `content` = DocumentViewer (el
// original con miniaturas, zoom y «cortar aquí») y `inspector` =
// DocumentReviewPane (pasos, campos con confianza, comprobaciones, formulario de
// la acción y pie de decisión). Ámbito por FinanceScopeSelector
// (services/financeScope.ts): un centro lee GET /properties/:id/documents; «toda
// la sociedad» (accounting.entity.read) lee la cola de la oficina GET
// /organizations/:id/documents/queue agrupada por centro (CocoaSection por
// Property.code) con los KPI de GET …/kpis (degradados si el API aún no los
// sirve) y la asignación a revisor con CocoaSelect (POST …/assign).
//
// Por debajo de 900 px el CocoaSplitView esconde el inspector, así que la
// pantalla apila: lista → (documento elegido) visor plegable + panel de
// revisión, con «Volver a la bandeja». Acepta `?id=<documentId>` (enlace desde
// Facturas recibidas, T9-11) y `#<documentId>` (navigateTo del resto de
// pantallas). Lecturas con useApiData sobre documentsApi (documentListPath /
// documentQueuePath + documentListQuery); escrituras solo por documentsApi y
// payablesApi (alta de proveedor desde Sage). Permiso: canDo(useNavGate(),
// "documents.review"); sin él la bandeja y la ficha se leen y los botones se
// deshabilitan con la razón. Sin estilos inline (Cocoa 22).

import { useEffect, useMemo, useState } from "react";
import type { DocumentApproveResponse, DocumentListPage, DocumentRejectRequest, DocumentSupplierProposal, IncomingDocumentDetail, IncomingDocumentRecord, SupplierDto } from "@hotelos/shared";
import { CocoaBadge, CocoaButton, CocoaCallout, CocoaKpi, CocoaKpiStrip, CocoaPage, CocoaSearchInput, CocoaSection, CocoaSegmentedControl, CocoaSelect, CocoaSplitView, CocoaState, CocoaSwitch, CocoaToolbar, useViewportTier } from "../../components/cocoa";
import type { CocoaSelectOption } from "../../components/cocoa/CocoaSelect";
import { FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { useToast } from "../../components/Toast";
import { ACTIONS, STATUS_LABELS, errorStateFor } from "../../content/actions";
import { useApiData } from "../../hooks/useApiData";
import { date, money, plural } from "../../lib/format";
import { navigateTo } from "../../lib/navigate";
import { useNavGate } from "../../navigation/useEnabledModules";
import { getActivePropertyId } from "../../services/activeProperty";
import { documentListPath, documentListQuery, documentQueuePath, documentsApi } from "../../services/documentsApi";
import { financeScopePolicy, useFinanceScope } from "../../services/financeScope";
import { fetchInventoryItems, fetchStockLocations, type InventoryItem, type StockLocation } from "../../services/fnbInventoryApi";
import { createSupplier, listSuppliers, payablesErrorMessage } from "../../services/payablesApi";
import { listUsersInScope } from "../../services/rbacApi";
import { useCurrentUserProfile } from "../../services/usersApi";
import { canDo, readHashParam, readQueryParam, todayIso } from "../accounting/accounting-ui";
import { useChartAccounts, useLoader } from "../payables/payables-shared";
import { useTabHost } from "../tabs/TabHost";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { DocumentReviewPane, NO_REVIEW_PERMISSION, OFFICE_SLA_BUSINESS_DAYS, QUEUE_SEGMENTS, SOD_NOTICE, centreGroupTitle, filterOverdue, groupQueueByCentre, isOverdue, isQueueSegment, segmentStatuses, type QueueSegment, type ReviewOutcome } from "./DocumentReviewPane";
import { DocumentViewer, splitRangesAt } from "./DocumentViewer";
import { DOCUMENT_KIND_LABELS, DOCUMENT_STATUS_LABELS, PROPOSED_ACTION_LABELS, documentErrorMessage, formatRegistry, slaBadge, statusTone } from "./documents-helpers";

const HEADER = treeHeaderFor("IncomingDocumentsScreen", { eyebrow: "Finanzas · Proveedores y gastos", title: "Documentos" });
const LOAD_ERROR = errorStateFor("los documentos");
const EMPTY_ROWS: IncomingDocumentRecord[] = [];
/** Bandeja y cola: las 200 más recientes (MAX_PAGE_LIMIT 500 en lib/pagination.ts). */
const LIST_LIMIT = 200;
const SEGMENT_OPTIONS = QUEUE_SEGMENTS.map((spec) => ({ value: spec.value, label: spec.label }));
const UNASSIGNED = "";

/** Lo que el 200 de approve añade al contrato compartido (actions.service.ts · DocumentApproveResult). */
type ApproveResult = DocumentApproveResponse & { sodNote?: string; createdSupplierId?: string; overriddenChecks?: string[] };

type Notice = { tone: "success" | "info"; title: string; message: string; billId?: string; expense?: boolean; receipt?: boolean };

/** Proveedor · nº de documento · importe extraídos, o el título, o el estado de la extracción. */
function documentSummary(row: IncomingDocumentRecord): string {
  const parts = [row.supplierName, row.documentNumber, row.totalAmount ? money(row.totalAmount, row.currency) : null].filter(Boolean);
  if (parts.length > 0) return parts.join(" · ");
  if (row.title) return row.title;
  return row.extractionStatus === "pending" ? "Extracción en curso" : row.extractionStatus === "failed" ? "Extracción fallida" : "Sin datos extraídos";
}

function firstDayOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/** Documento con el que arranca la pantalla: `?id=` (enlace de Facturas recibidas) o `#id` (navigateTo). */
function initialDocumentId(): string | null {
  return readQueryParam("id") ?? readHashParam();
}

export function IncomingDocumentsScreen() {
  const hosted = useTabHost() !== null;
  const gate = useNavGate();
  const canReview = canDo(gate, "documents.review");
  const canCapture = canDo(gate, "documents.capture");
  const finance = useFinanceScope(financeScopePolicy("IncomingDocumentsScreen"));
  const tier = useViewportTier();
  const stacked = tier === "phone" || tier === "tablet";
  const { showToast } = useToast();
  const profile = useCurrentUserProfile();
  const chart = useChartAccounts();
  const suppliers = useLoader(() => listSuppliers({ active: true, limit: 500 }), "suppliers", "No se pudo cargar el directorio de proveedores.");

  const [segment, setSegment] = useState<QueueSegment>("pending");
  const [q, setQ] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(() => initialDocumentId());
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null);
  const [activePage, setActivePage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [deepLinkSegmentApplied, setDeepLinkSegmentApplied] = useState(false);

  const entityScope = finance.propertyId === undefined;
  const listPath = entityScope ? documentQueuePath() : documentListPath(finance.propertyId);
  const list = useApiData<DocumentListPage>(finance.loading ? null : listPath, { query: documentListQuery({ status: segmentStatuses(segment), q: q.trim() || undefined, limit: LIST_LIMIT }) });
  const allRows = list.data?.items ?? EMPTY_ROWS;
  const rows = useMemo(() => (overdueOnly ? filterOverdue(allRows) : allRows), [allRows, overdueOnly]);
  const centres = finance.structure?.centres ?? [];
  const groups = useMemo(() => (entityScope ? groupQueueByCentre(rows, centres) : null), [entityScope, rows, centres]);

  const detailPropertyId = selectedPropertyId ?? rows.find((row) => row.id === selectedId)?.propertyId ?? finance.propertyId ?? getActivePropertyId();
  const detail = useLoader<IncomingDocumentDetail | null>(() => (selectedId ? documentsApi.get(selectedId, detailPropertyId) : Promise.resolve(null)), `${selectedId ?? ""}|${detailPropertyId}`, "No se pudo cargar el documento.");
  const doc = detail.data;

  // RV-15: GET /rbac/users exige users.read; sin la clave el selector se queda en «yo» sin llamar (ni 403 en consola ni fila ACCESS_DENIED).
  const canListUsers = canDo(gate, "users.read");
  const reviewers = useLoader<CocoaSelectOption[]>(
    () =>
      canListUsers
        ? listUsersInScope({ scopeType: "property", ref: detailPropertyId })
            .then((users) => users.filter((user) => user.status === "active").map((user) => ({ value: user.userId, label: user.fullName || user.email })))
            .catch(() => [])
        : Promise.resolve([]),
    `reviewers|${detailPropertyId}|${canListUsers ? "users" : "me"}`,
    ""
  );
  const inventory = useLoader<{ items: InventoryItem[]; locations: StockLocation[] } | null>(
    () => (doc?.kind === "delivery_note" ? Promise.all([fetchInventoryItems(detailPropertyId).catch(() => []), fetchStockLocations(detailPropertyId).catch(() => [])]).then(([items, locations]) => ({ items, locations })) : Promise.resolve(null)),
    `inventory|${detailPropertyId}|${doc?.kind ?? ""}`,
    ""
  );
  const kpis = useLoader(() => (entityScope ? documentsApi.kpis({ from: firstDayOfMonth(todayIso()), to: todayIso() }) : Promise.resolve(null)), `kpis|${entityScope ? "entity" : "centre"}`, "");
  // RV-14: el SLA en vigor viene con los KPIs (DocumentSettings.officeSlaBusinessDays); sin ellos, el defecto de la tanda.
  const officeSlaBusinessDays = kpis.data?.officeSlaBusinessDays ?? OFFICE_SLA_BUSINESS_DAYS;

  // Un enlace profundo a un documento de otro segmento cambia el segmento una sola vez.
  useEffect(() => {
    if (!doc || deepLinkSegmentApplied) return;
    const spec = QUEUE_SEGMENTS.find((entry) => entry.statuses.includes(doc.status));
    if (spec && spec.value !== segment) setSegment(spec.value);
    setDeepLinkSegmentApplied(true);
  }, [doc, deepLinkSegmentApplied, segment]);

  // La fila de la cola conoce el centro del documento elegido por enlace.
  useEffect(() => {
    if (!selectedId || selectedPropertyId) return;
    const row = allRows.find((entry) => entry.id === selectedId);
    if (row) setSelectedPropertyId(row.propertyId);
  }, [selectedId, selectedPropertyId, allRows]);

  const pageState = list.loading && !list.data ? "loading" : list.error && !list.data ? "error" : "ready";

  function select(row: IncomingDocumentRecord) {
    setSelectedId(row.id);
    setSelectedPropertyId(row.propertyId);
    setActivePage(1);
    setNotice(null);
    setViewerOpen(false);
  }

  function refreshAll() {
    list.refresh();
    if (selectedId) detail.refresh();
  }

  async function run<T>(work: () => Promise<T>, fallback: string): Promise<T | null> {
    setBusy(true);
    try {
      return await work();
    } catch (err) {
      showToast(documentErrorMessage(err, fallback), { variant: "error" });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function ensureInReview(current: IncomingDocumentDetail): Promise<boolean> {
    if (current.status !== "sent_to_office") return true;
    await documentsApi.assign(current.id, { assignedTo: profile.profile?.userId ?? null }, current.propertyId);
    return true;
  }

  async function startReview() {
    if (!doc) return;
    const done = await run(async () => {
      await ensureInReview(doc);
      return true;
    }, "No se pudo empezar la revisión.");
    if (done) {
      showToast(`${formatRegistry(doc.registryNumber)} en revisión.`, { variant: "success" });
      refreshAll();
    }
  }

  async function assignTo(userId: string) {
    if (!doc) return;
    const done = await run(() => documentsApi.assign(doc.id, { assignedTo: userId || null }, doc.propertyId), "No se pudo asignar el documento.");
    if (done) {
      showToast(userId ? "Documento asignado." : "Documento sin asignar.", { variant: "success" });
      refreshAll();
    }
  }

  async function approve(outcome: ReviewOutcome) {
    if (!doc) return;
    const result = await run(async () => {
      await ensureInReview(doc);
      if (Object.keys(outcome.reviewedFields).length > 0) await documentsApi.review(doc.id, { reviewedFields: outcome.reviewedFields }, doc.propertyId);
      return (await documentsApi.approve(doc.id, outcome.body, doc.propertyId)) as ApproveResult;
    }, "No se pudo aprobar el documento.");
    if (!result) return;
    const label = PROPOSED_ACTION_LABELS[outcome.action];
    showToast(`${formatRegistry(doc.registryNumber)}: ${label.toLowerCase()}.`, { variant: "success" });
    setNotice({
      tone: "success",
      title: `${label} · ${formatRegistry(doc.registryNumber)}`,
      message: [result.sodNote ? SOD_NOTICE : null, result.createdSupplierId ? "Proveedor dado de alta en el directorio desde la propuesta." : null, result.overriddenChecks && result.overriddenChecks.length > 0 ? `Aprobado con ${plural(result.overriddenChecks.length, "comprobación en rojo", "comprobaciones en rojo")} (motivo auditado).` : null].filter(Boolean).join(" ") || "Acción ejecutada y documento actualizado.",
      billId: result.supplierBillId,
      expense: Boolean(result.expenseId),
      receipt: Boolean(result.goodsReceiptId)
    });
    refreshAll();
  }

  async function reject(body: DocumentRejectRequest) {
    if (!doc) return;
    const result = await run(async () => {
      await ensureInReview(doc);
      return documentsApi.reject(doc.id, body, doc.propertyId);
    }, "No se pudo rechazar el documento.");
    if (!result) return;
    showToast(body.returnToCentre ? `${formatRegistry(doc.registryNumber)} devuelto al centro.` : `${formatRegistry(doc.registryNumber)} rechazado.`, { variant: "success" });
    setNotice({ tone: "info", title: body.returnToCentre ? "Devuelto al centro" : "Documento rechazado", message: body.returnToCentre ? (result.notifiedUserId ? "Se ha avisado a quien lo capturó para que lo digitalice de nuevo con el mismo número de registro." : "El centro lo verá como devuelto en su bandeja.") : "Queda en el archivo con la retención de un año." });
    refreshAll();
  }

  async function createSupplierFromSage(proposal: DocumentSupplierProposal): Promise<SupplierDto | null> {
    setBusy(true);
    try {
      const created = await createSupplier({ name: proposal.name, taxId: proposal.taxId });
      showToast(`Proveedor «${created.name}» dado de alta.`, { variant: "success" });
      suppliers.refresh();
      return created;
    } catch (err) {
      showToast(payablesErrorMessage(err, "No se pudo dar de alta el proveedor."), { variant: "error" });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function splitAt(page: number) {
    if (!doc) return;
    const ranges = splitRangesAt(page, Math.max(doc.pageCount, doc.pages.length));
    if (!ranges) return;
    const result = await run(() => documentsApi.split(doc.id, { ranges }, doc.propertyId), "No se pudo dividir el documento.");
    if (!result) return;
    showToast(`${formatRegistry(doc.registryNumber)} dividido en ${plural(result.pieces.length, "documento", "documentos")}.`, { variant: "success" });
    refreshAll();
  }

  function openDocument(documentId: string) {
    setSelectedId(documentId);
    setActivePage(1);
    setNotice(null);
  }

  const canSplit = Boolean(doc && (canReview || canCapture) && (doc.status === "captured" || doc.status === "in_review"));
  const reviewerOptions = useMemo<CocoaSelectOption[]>(() => {
    const options: CocoaSelectOption[] = [{ value: UNASSIGNED, label: "Sin asignar" }];
    const me = profile.profile;
    if (me) options.push({ value: me.userId, label: `${me.fullName} (yo)` });
    for (const option of reviewers.data ?? []) if (option.value !== me?.userId) options.push(option);
    if (doc?.assignedTo && !options.some((option) => option.value === doc.assignedTo)) options.push({ value: doc.assignedTo, label: "Asignado (otra persona)" });
    return options;
  }, [profile.profile, reviewers.data, doc?.assignedTo]);

  function rowBadges(row: IncomingDocumentRecord) {
    const badges: Array<{ key: string; tone: Parameters<typeof CocoaBadge>[0]["tone"]; label: string }> = [];
    if (row.status === "sent_to_office" || row.status === "in_review") {
      const sla = slaBadge(row.sentAt, officeSlaBusinessDays);
      badges.push({ key: "sla", tone: row.slaBreached ? "danger" : sla.tone, label: row.slaBreached && !sla.breached ? "SLA vencido" : sla.label });
    }
    if (row.dueAt) badges.push({ key: "due", tone: isOverdue({ slaBreached: false, dueAt: row.dueAt }) ? "danger" : "warning", label: `Plazo ${date(row.dueAt, "short")}` });
    return badges;
  }

  function rowList(items: IncomingDocumentRecord[], label: string) {
    return (
      <ul className="c22-section__list" role="listbox" aria-label={label}>
        {items.map((row) => (
          <li key={row.id}>
            <CocoaButton variant={row.id === selectedId ? "tinted" : "plain"} tone={row.id === selectedId ? "accent" : "neutral"} size="small" fullWidth wrap align="start" role="option" aria-selected={row.id === selectedId} onClick={() => select(row)}>
              <span className="cocoa-stack" data-gap="1">
                <span className="cocoa-row" data-gap="2">
                  <strong className="cocoa-mono">{formatRegistry(row.registryNumber, { short: true })}</strong>
                  <CocoaBadge tone="neutral" variant="tinted" size="small" uppercase={false}>
                    {DOCUMENT_KIND_LABELS[row.kind] ?? row.kind}
                  </CocoaBadge>
                </span>
                <span className="cocoa-note">{documentSummary(row)}</span>
                <span className="cocoa-cluster">
                  {rowBadges(row).map((badge) => (
                    <CocoaBadge key={badge.key} tone={badge.tone} variant="dot" size="small">
                      {badge.label}
                    </CocoaBadge>
                  ))}
                </span>
              </span>
            </CocoaButton>
          </li>
        ))}
      </ul>
    );
  }

  const sidebar = (
    <div className="cocoa-stack" data-gap="3" role="region" aria-label="Bandeja de documentos">
      <CocoaSegmentedControl value={segment} onChange={(value) => (isQueueSegment(value) ? setSegment(value) : undefined)} options={SEGMENT_OPTIONS} size="small" fullWidth aria-label="Estado de los documentos" />
      <CocoaSearchInput value={q} onChange={setQ} debounceMs={300} placeholder="Registro, proveedor, NIF o nº…" aria-label="Buscar documentos" />
      <CocoaSwitch checked={overdueOnly} onChange={setOverdueOnly} label="Solo vencidos" size="small" />
      {list.error && list.data ? (
        <CocoaBadge tone="danger" title={list.error}>
          {STATUS_LABELS.loadError}
        </CocoaBadge>
      ) : null}
      {pageState === "loading" ? <CocoaState kind="loading" inline /> : null}
      {pageState === "error" ? <CocoaState kind="error" inline title={LOAD_ERROR.title} message={list.error ?? LOAD_ERROR.message} onRetry={() => list.refresh()} /> : null}
      {pageState === "ready" && rows.length === 0 ? <CocoaState kind="empty" inline title="Sin documentos" message={overdueOnly ? "Ningún documento vencido en este estado." : "Ningún documento en este estado para el ámbito elegido."} /> : null}
      {pageState === "ready" && groups
        ? groups.map((group) => (
            <CocoaSection key={group.propertyId} title={centreGroupTitle(group)} meta={plural(group.rows.length, "documento", "documentos")} headingLevel={3} padding="sm">
              {rowList(group.rows, `Documentos de ${centreGroupTitle(group)}`)}
            </CocoaSection>
          ))
        : null}
      {pageState === "ready" && !groups && rows.length > 0 ? rowList(rows, "Documentos del centro") : null}
    </div>
  );

  const selectedToolbar = doc ? (
    <CocoaToolbar
      variant="content"
      aria-label="Documento seleccionado"
      leftSlot={
        <div className="cocoa-cluster">
          <strong className="cocoa-mono">{formatRegistry(doc.registryNumber)}</strong>
          <CocoaBadge tone={statusTone(doc.status)}>{DOCUMENT_STATUS_LABELS[doc.status] ?? doc.status}</CocoaBadge>
          <CocoaBadge tone="neutral" variant="tinted" uppercase={false}>
            {DOCUMENT_KIND_LABELS[doc.kind] ?? doc.kind}
          </CocoaBadge>
          {doc.slaBreached ? <CocoaBadge tone="danger">SLA vencido</CocoaBadge> : null}
        </div>
      }
      rightSlot={
        <CocoaSelect size="small" inline aria-label="Revisor asignado" value={doc.assignedTo ?? UNASSIGNED} onChange={(value) => void assignTo(value)} options={reviewerOptions} disabled={!canReview || busy || !(doc.status === "sent_to_office" || doc.status === "in_review")} />
      }
    />
  ) : null;

  const viewer = doc ? <DocumentViewer document={doc} propertyId={doc.propertyId} activePage={activePage} onPageChange={setActivePage} onSplitAt={(page) => void splitAt(page)} canSplit={canSplit} busy={busy} height={stacked ? 420 : 720} /> : null;

  const content = (
    <div className="cocoa-stack" data-gap="3" aria-label="Original del documento">
      {!selectedId ? <CocoaState kind="empty" title="Elige un documento" message="La bandeja de la izquierda lista los documentos por estado; al elegir uno se abre el original aquí y la revisión a la derecha." /> : null}
      {selectedId && detail.loading && !doc ? <CocoaState kind="loading" title="Abriendo el documento" /> : null}
      {selectedId && detail.error ? <CocoaState kind="error" title="No se pudo cargar el documento" message={detail.error} onRetry={() => detail.refresh()} /> : null}
      {selectedToolbar}
      {viewer}
    </div>
  );

  const inspector = doc ? (
    <DocumentReviewPane
      key={doc.id}
      document={doc}
      suppliers={{ rows: suppliers.data ?? [], loading: suppliers.loading, error: suppliers.error }}
      accounts={chart}
      inventory={inventory.data ?? undefined}
      canReview={canReview}
      busy={busy}
      onFocusPage={(page) => (page ? setActivePage(page) : undefined)}
      onOpenDocument={openDocument}
      onCreateSupplier={createSupplierFromSage}
      onStartReview={startReview}
      onApprove={approve}
      onReject={reject}
    />
  ) : undefined;

  const noticeCallout = notice ? (
    <CocoaCallout
      tone={notice.tone}
      role="status"
      title={notice.title}
      actions={
        <>
          {notice.billId ? (
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("SupplierBillsScreen", notice.billId)}>
              Ver en Facturas recibidas
            </CocoaButton>
          ) : null}
          {notice.expense ? (
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("ExpensesScreen")}>
              Ver gastos
            </CocoaButton>
          ) : null}
          {notice.receipt ? (
            <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("GoodsReceiptsScreen")}>
              Ver recepciones
            </CocoaButton>
          ) : null}
          <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setNotice(null)}>
            {ACTIONS.close}
          </CocoaButton>
        </>
      }
    >
      {notice.message}
    </CocoaCallout>
  ) : null;

  const kpiStrip =
    entityScope && !stacked ? (
      <CocoaKpiStrip aria-label="Indicadores de la oficina">
        <CocoaKpi label="Pendientes" value={kpis.data ? kpis.data.pendingByProperty.reduce((sum, row) => sum + row.pending, 0) : "—"} caption="en toda la sociedad" polarity="neutral" degraded={!kpis.data} />
        <CocoaKpi label="SLA incumplidos" value={kpis.data ? kpis.data.slaBreached : "—"} caption={`${plural(officeSlaBusinessDays, "día laborable", "días laborables")} desde el envío`} polarity="negative-good" status={kpis.data && kpis.data.slaBreached > 0 ? "critical" : "ok"} degraded={!kpis.data} />
        <CocoaKpi label="Facturas sin albarán" value={kpis.data ? kpis.data.billsWithoutReceipt : "—"} caption="pendientes de cotejo" polarity="negative-good" degraded={!kpis.data} />
        <CocoaKpi label="Sin tocar" value={kpis.data && kpis.data.touchlessPct !== null ? `${Math.round(kpis.data.touchlessPct)} %` : "—"} caption="aprobadas sin corregir campos" polarity="positive-good" degraded={!kpis.data || kpis.data.touchlessPct === null} />
      </CocoaKpiStrip>
    ) : null;

  return (
    <CocoaPage
      eyebrow={finance.eyebrow(HEADER.eyebrow)}
      title={HEADER.title}
      subtitle={hosted ? undefined : "Bandeja de la oficina: revisa los documentos digitalizados en los centros lado a lado con el original, corrige los campos extraídos y aprueba la factura, el gasto, la recepción o la tarea."}
      actions={
        <>
          <FinanceScopeSelector scope={finance} disabled={busy} />
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={refreshAll} title={ACTIONS.refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      commands={[
        { id: "documents-refresh", label: "Actualizar la bandeja de documentos", run: refreshAll },
        { id: "documents-overdue", label: overdueOnly ? "Ver todos los documentos" : "Ver solo los vencidos", run: () => setOverdueOnly((value) => !value) }
      ]}
    >
      {!canReview ? <p className="cocoa-note">{NO_REVIEW_PERMISSION} («documents.review») para asignar, aprobar, devolver o rechazar: la bandeja y la ficha se pueden consultar.</p> : null}
      {kpiStrip}
      {noticeCallout}
      {stacked ? (
        !selectedId ? (
          sidebar
        ) : (
          <div className="cocoa-stack" data-gap="3">
            <div className="cocoa-row" data-gap="2" data-justify="between">
              <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setSelectedId(null)}>
                {`${ACTIONS.back} a la bandeja`}
              </CocoaButton>
              <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setViewerOpen((open) => !open)} disabled={!doc} aria-expanded={viewerOpen}>
                {viewerOpen ? "Ocultar el original" : "Ver el original"}
              </CocoaButton>
            </div>
            {selectedToolbar}
            {detail.loading && !doc ? <CocoaState kind="loading" inline /> : null}
            {detail.error ? <CocoaState kind="error" inline title="No se pudo cargar el documento" message={detail.error} onRetry={() => detail.refresh()} /> : null}
            {viewerOpen ? viewer : null}
            {inspector}
          </div>
        )
      ) : (
        <CocoaSplitView sidebar={sidebar} content={content} inspector={inspector} sidebarWidth={300} inspectorWidth={480} collapsibleSidebar={false} />
      )}
    </CocoaPage>
  );
}

export default IncomingDocumentsScreen;

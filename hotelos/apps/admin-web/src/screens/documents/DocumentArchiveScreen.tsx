// Finanzas › Proveedores y gastos › Archivo — archivo legal de los documentos
// digitalizados con búsqueda por texto extraído (Tanda T9 · lote T9-12, diseño
// docs/design/DOCUMENTOS-DIGITALIZACION.md §7.4-§7.5 y §10 «Archivo»; pestaña
// /finanzas/proveedores/archivo de ProveedoresTabs).
//
// CocoaSearchInput sobre `searchText` + filtros (tipo, centro por el ámbito de
// Finanzas, proveedor, fechas, importe, nº de registro) → useApiData sobre
// documentsApi (documentArchivePath + documentArchiveQuery: GET
// /organizations/:id/documents/archive); CocoaTable con `showFrom` para las
// columnas secundarias; detalle en CocoaDrawer con DocumentViewer, los
// metadatos legales (hash SHA-256, formato original, retención, retención
// ampliada, bloqueo legal, bloqueo por retención vencida, purga) y la descarga.
// Bloquear / desbloquear / purgar solo con canDo(useNavGate(), "documents.admin")
// (CocoaDialog destructivo con motivo → documentsApi.block / unblock / purge).
// Lectura con canDo(…, "documents.archive.read"). Sin estilos inline (Cocoa 22).

import { useMemo, useState } from "react";
import type { DocumentAdminActionRequest, DocumentListPage, IncomingDocumentDetail, IncomingDocumentKind, IncomingDocumentRecord } from "@hotelos/shared";
import { INCOMING_DOCUMENT_KINDS } from "@hotelos/shared";
import { CocoaBadge, CocoaButton, CocoaCallout, CocoaDatePicker, CocoaDialog, CocoaDrawer, CocoaField, CocoaFormRow, CocoaInput, CocoaPage, CocoaSearchInput, CocoaSection, CocoaSelect, CocoaState, CocoaSwitch, CocoaTable, CocoaToolbar, type CocoaTableColumn } from "../../components/cocoa";
import type { CocoaSelectOption } from "../../components/cocoa/CocoaSelect";
import { FinanceScopeSelector } from "../../components/finance/FinanceScopeSelector";
import { useToast } from "../../components/Toast";
import { ACTIONS, STATUS_LABELS, errorStateFor } from "../../content/actions";
import { useApiData } from "../../hooks/useApiData";
import { date, dateTime, money, plural } from "../../lib/format";
import { navigateTo } from "../../lib/navigate";
import { useNavGate } from "../../navigation/useEnabledModules";
import { documentArchivePath, documentArchiveQuery, documentsApi } from "../../services/documentsApi";
import { centreNameFor, financeScopePolicy, useFinanceScope } from "../../services/financeScope";
import { listSuppliers } from "../../services/payablesApi";
import { canDo } from "../accounting/accounting-ui";
import { decimalInput } from "../payables/payables-helpers";
import { useLoader } from "../payables/payables-shared";
import { useTabHost } from "../tabs/TabHost";
import { treeHeaderFor } from "../tabs/tab-helpers";
import { DocumentViewer } from "./DocumentViewer";
import { DOCUMENT_KIND_LABELS, DOCUMENT_SOURCE_LABELS, DOCUMENT_STATUS_LABELS, documentErrorMessage, formatBytes, formatRegistry, statusTone } from "./documents-helpers";

const HEADER = treeHeaderFor("DocumentArchiveScreen", { eyebrow: "Finanzas · Proveedores y gastos", title: "Archivo" });
const LOAD_ERROR = errorStateFor("el archivo de documentos");
const EMPTY_ROWS: IncomingDocumentRecord[] = [];
const LIST_LIMIT = 200;
const NO_READ_PERMISSION = "Necesitas el permiso de lectura del archivo de documentos";
const NO_ADMIN_PERMISSION = "Necesitas el permiso de administración de documentos";

type AdminAction = "block" | "unblock" | "purge";

const ADMIN_COPY: Record<AdminAction, { title: string; description: string; confirm: string; done: string }> = {
  block: { title: "Bloquear el documento", description: "Con la retención vencida, el documento deja de verse para todo el mundo salvo la administración de documentos. Queda auditado con el motivo.", confirm: "Bloquear", done: "Documento bloqueado." },
  unblock: { title: "Desbloquear el documento", description: "Vuelve a ser visible en el archivo. Queda auditado con el motivo.", confirm: "Desbloquear", done: "Documento desbloqueado." },
  purge: { title: "Purgar el documento", description: "Borra el fichero del almacén de forma irreversible; la ficha queda con la fecha de purga. Solo un documento bloqueado y sin bloqueo legal.", confirm: "Purgar", done: "Documento purgado." }
};

type Filters = { q: string; kind: "" | IncomingDocumentKind; supplierId: string; from: string; to: string; amountMin: string; amountMax: string; registryNumber: string; includeBlocked: boolean };

const EMPTY_FILTERS: Filters = { q: "", kind: "", supplierId: "", from: "", to: "", amountMin: "", amountMax: "", registryNumber: "", includeBlocked: false };

function amountFilter(raw: string): string | undefined {
  const value = raw.trim() ? decimalInput(raw) : null;
  return value ?? undefined;
}

export function DocumentArchiveScreen() {
  const hosted = useTabHost() !== null;
  const gate = useNavGate();
  const canRead = canDo(gate, "documents.archive.read");
  const isAdmin = canDo(gate, "documents.admin");
  const finance = useFinanceScope(financeScopePolicy("DocumentArchiveScreen"));
  const { showToast } = useToast();
  const suppliers = useLoader(() => listSuppliers({ active: true, limit: 500 }), "suppliers", "No se pudo cargar el directorio de proveedores.");

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null);
  const [activePage, setActivePage] = useState(1);
  const [adminAction, setAdminAction] = useState<AdminAction | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const query = useMemo(
    () =>
      documentArchiveQuery({
        q: filters.q.trim() || undefined,
        kind: filters.kind || undefined,
        supplierId: filters.supplierId || undefined,
        propertyId: finance.propertyId,
        from: filters.from || undefined,
        to: filters.to || undefined,
        amountMin: amountFilter(filters.amountMin),
        amountMax: amountFilter(filters.amountMax),
        registryNumber: filters.registryNumber.trim() || undefined,
        includeBlocked: isAdmin && filters.includeBlocked ? true : undefined,
        limit: LIST_LIMIT
      }),
    [filters, finance.propertyId, isAdmin]
  );
  const list = useApiData<DocumentListPage>(canRead && !finance.loading ? documentArchivePath() : null, { query });
  const rows = list.data?.items ?? EMPTY_ROWS;
  const pageState = !canRead ? "ready" : list.loading && !list.data ? "loading" : list.error && !list.data ? "error" : "ready";

  const detailPropertyId = selectedPropertyId ?? finance.active.propertyId;
  const detail = useLoader<IncomingDocumentDetail | null>(() => (selectedId ? documentsApi.get(selectedId, detailPropertyId) : Promise.resolve(null)), `${selectedId ?? ""}|${detailPropertyId}`, "No se pudo cargar el documento.");
  const doc = detail.data;

  const kindOptions = useMemo<CocoaSelectOption[]>(() => [{ value: "", label: "Todos los tipos" }, ...INCOMING_DOCUMENT_KINDS.map((kind) => ({ value: kind, label: DOCUMENT_KIND_LABELS[kind] }))], []);
  const supplierOptions = useMemo<CocoaSelectOption[]>(() => [{ value: "", label: "Todos los proveedores" }, ...(suppliers.data ?? []).map((s) => ({ value: s.id, label: s.taxId ? `${s.name} · ${s.taxId}` : s.name }))], [suppliers.data]);
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((prev) => ({ ...prev, [key]: value }));
  const hasFilters = Object.entries(filters).some(([key, value]) => (key === "includeBlocked" ? value === true : String(value).trim() !== ""));

  const columns = useMemo<CocoaTableColumn<IncomingDocumentRecord>[]>(
    () => [
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
      { key: "supplier", label: "Proveedor", truncate: 40, render: (row) => row.supplierName ?? row.supplierTaxId ?? "—" },
      { key: "documentNumber", label: "Nº documento", showFrom: "tablet", truncate: 24, render: (row) => row.documentNumber ?? "—" },
      { key: "documentDate", label: "Fecha", fit: true, showFrom: "tablet", render: (row) => (row.documentDate ? date(row.documentDate, "short") : "—") },
      { key: "totalAmount", label: "Importe", align: "right", fit: true, render: (row) => (row.totalAmount ? money(row.totalAmount, row.currency) : "—") },
      { key: "centre", label: "Centro", showFrom: "laptop", truncate: 28, render: (row) => centreNameFor(finance.structure, row.propertyId) },
      { key: "retentionUntil", label: "Retención hasta", fit: true, showFrom: "desktop", render: (row) => (row.retentionUntil ? date(row.retentionUntil, "short") : "—") },
      {
        key: "flags",
        label: "Situación",
        showFrom: "laptop",
        render: (row) => (
          <span className="cocoa-cluster">
            {row.legalHold ? (
              <CocoaBadge tone="warning" variant="dot" size="small">
                Bloqueo legal
              </CocoaBadge>
            ) : null}
            {row.extendedRetention ? (
              <CocoaBadge tone="info" variant="dot" size="small">
                Retención ampliada
              </CocoaBadge>
            ) : null}
            {row.blockedAt ? (
              <CocoaBadge tone="danger" variant="dot" size="small">
                Bloqueado
              </CocoaBadge>
            ) : null}
            {row.deletedAt ? (
              <CocoaBadge tone="neutral" variant="dot" size="small">
                Purgado
              </CocoaBadge>
            ) : null}
          </span>
        )
      }
    ],
    [finance.structure]
  );

  function open(row: IncomingDocumentRecord) {
    setSelectedId(row.id);
    setSelectedPropertyId(row.propertyId);
    setActivePage(1);
  }

  function close() {
    if (busy) return;
    setSelectedId(null);
    setAdminAction(null);
  }

  async function confirmAdmin() {
    if (!doc || !adminAction) return;
    const body: DocumentAdminActionRequest = { reason: reason.trim() };
    setBusy(true);
    try {
      if (adminAction === "block") await documentsApi.block(doc.id, body);
      else if (adminAction === "unblock") await documentsApi.unblock(doc.id, body);
      else await documentsApi.purge(doc.id, body);
      showToast(ADMIN_COPY[adminAction].done, { variant: "success" });
      setAdminAction(null);
      setReason("");
      detail.refresh();
      list.refresh();
    } catch (err) {
      showToast(documentErrorMessage(err, "No se pudo completar la acción sobre el documento."), { variant: "error" });
    } finally {
      setBusy(false);
    }
  }

  const metadata = doc
    ? [
        ["Nº de registro", formatRegistry(doc.registryNumber)],
        ["Estado", DOCUMENT_STATUS_LABELS[doc.status] ?? doc.status],
        ["Tipo", DOCUMENT_KIND_LABELS[doc.kind] ?? doc.kind],
        ["Origen", DOCUMENT_SOURCE_LABELS[doc.source] ?? doc.source],
        ["Centro", centreNameFor(finance.structure, doc.propertyId)],
        ["Proveedor", doc.supplierName ? `${doc.supplierName}${doc.supplierTaxId ? ` · ${doc.supplierTaxId}` : ""}` : doc.supplierTaxId ?? "—"],
        ["Nº de documento", doc.documentNumber ?? "—"],
        ["Fecha del documento", doc.documentDate ? date(doc.documentDate, "short") : "—"],
        ["Importe", doc.totalAmount ? money(doc.totalAmount, doc.currency) : "—"],
        ["Formato original", `${doc.originalFormat ?? "—"} · ${formatBytes(doc.sizeBytes)} · ${plural(doc.pageCount, "página", "páginas")}`],
        ["Huella SHA-256", doc.sha256],
        ["Capturado", dateTime(doc.capturedAt)],
        ["Archivado", doc.archivedAt ? dateTime(doc.archivedAt) : doc.postedAt ? `Contabilizado ${dateTime(doc.postedAt)}` : "—"],
        ["Retención hasta", doc.retentionUntil ? date(doc.retentionUntil, "long") : "Sin calcular"],
        ["Retención ampliada", doc.extendedRetention ? STATUS_LABELS.yes : STATUS_LABELS.no],
        ["Bloqueo legal", doc.legalHold ? STATUS_LABELS.yes : STATUS_LABELS.no],
        ["Bloqueado por retención", doc.blockedAt ? dateTime(doc.blockedAt) : STATUS_LABELS.no],
        ["Purgado", doc.deletedAt ? dateTime(doc.deletedAt) : STATUS_LABELS.no]
      ]
    : [];

  return (
    <CocoaPage
      eyebrow={finance.eyebrow(HEADER.eyebrow)}
      title={HEADER.title}
      subtitle={hosted ? undefined : "Archivo legal de los documentos digitalizados: búsqueda por el texto extraído, metadatos de conservación y descarga del original."}
      actions={
        <>
          <FinanceScopeSelector scope={finance} disabled={busy} />
          <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => list.refresh()} title={ACTIONS.refresh}>
            {ACTIONS.refresh}
          </CocoaButton>
        </>
      }
      state={pageState}
      error={{ title: LOAD_ERROR.title, message: list.error ?? LOAD_ERROR.message, onRetry: () => list.refresh() }}
      commands={[
        { id: "archive-refresh", label: "Actualizar el archivo", run: () => list.refresh() },
        { id: "archive-clear", label: ACTIONS.clearFilters, run: () => setFilters(EMPTY_FILTERS) }
      ]}
    >
      {!canRead ? <CocoaCallout tone="warning" title={NO_READ_PERMISSION}>{`«documents.archive.read» da acceso al archivo; pide a dirección la clave si necesitas consultarlo.`}</CocoaCallout> : null}

      <CocoaToolbar
        variant="content"
        aria-label="Filtros del archivo"
        leftSlot={
          <div className="cocoa-row" data-gap="2">
            <CocoaSearchInput value={filters.q} onChange={(v) => set("q", v)} debounceMs={300} placeholder="Texto del documento, NIF, número…" aria-label="Buscar en el texto extraído" />
            <CocoaSelect size="small" inline aria-label="Tipo de documento" value={filters.kind} onChange={(v) => set("kind", v as Filters["kind"])} options={kindOptions} />
            <CocoaSelect size="small" inline aria-label="Proveedor" value={filters.supplierId} onChange={(v) => set("supplierId", v)} options={supplierOptions} disabled={suppliers.loading} />
          </div>
        }
        rightSlot={
          <div className="cocoa-row" data-gap="2">
            {isAdmin ? <CocoaSwitch checked={filters.includeBlocked} onChange={(v) => set("includeBlocked", v)} label="Incluir bloqueados" size="small" /> : null}
            <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setFilters(EMPTY_FILTERS)} disabled={!hasFilters}>
              {ACTIONS.clearFilters}
            </CocoaButton>
          </div>
        }
      />

      <CocoaFormRow columns={4} min={150} role="group" aria-label="Más filtros">
        <CocoaField label="Desde">
          <CocoaDatePicker value={filters.from} onChange={(v) => set("from", v)} size="small" />
        </CocoaField>
        <CocoaField label="Hasta">
          <CocoaDatePicker value={filters.to} onChange={(v) => set("to", v)} size="small" />
        </CocoaField>
        <CocoaField label="Importe mínimo">
          <CocoaInput value={filters.amountMin} onChange={(v) => set("amountMin", v)} inputMode="decimal" size="small" placeholder="0,00" />
        </CocoaField>
        <CocoaField label="Importe máximo">
          <CocoaInput value={filters.amountMax} onChange={(v) => set("amountMax", v)} inputMode="decimal" size="small" placeholder="0,00" />
        </CocoaField>
        <CocoaField label="Nº de registro">
          <CocoaInput value={filters.registryNumber} onChange={(v) => set("registryNumber", v)} size="small" placeholder="DOC-AMC-2026-000001" />
        </CocoaField>
      </CocoaFormRow>

      <CocoaSection title="Documentos archivados" meta={list.data ? plural(rows.length, "documento", "documentos") : undefined}>
        <CocoaTable
          columns={columns}
          rows={rows}
          rowKey="id"
          caption="Archivo de documentos digitalizados"
          density="compact"
          loading={list.isValidating && rows.length > 0}
          keepDataWhileLoading
          selectedKey={selectedId ?? undefined}
          onSelect={open}
          rowTitle={() => "Abrir la ficha del documento"}
          rowTone={(row) => (row.blockedAt ? "danger" : row.legalHold ? "warning" : undefined)}
          emptyState={<CocoaState kind="empty" title={hasFilters ? "Sin resultados" : "Archivo vacío"} message={hasFilters ? "Ningún documento coincide con los filtros; prueba con menos condiciones." : "Los documentos aprobados, contabilizados, archivados o rechazados aparecen aquí con su retención."} />}
        />
      </CocoaSection>

      <CocoaDrawer open={selectedId !== null} onClose={close} title={doc ? formatRegistry(doc.registryNumber) : "Documento"} subtitle={doc ? `${DOCUMENT_KIND_LABELS[doc.kind] ?? doc.kind} · ${DOCUMENT_STATUS_LABELS[doc.status] ?? doc.status}` : undefined} size="lg" loading={detail.loading && !doc} focusKey={doc?.id}>
        {detail.error ? <CocoaState kind="error" inline title="No se pudo cargar el documento" message={detail.error} onRetry={() => detail.refresh()} /> : null}
        {doc ? (
          <div className="cocoa-stack" data-gap="4">
            {doc.deletedAt ? (
              <CocoaCallout tone="warning" title="Documento purgado">
                El fichero se borró del almacén el {dateTime(doc.deletedAt)}; solo queda la ficha con sus metadatos.
              </CocoaCallout>
            ) : (
              <DocumentViewer document={doc} propertyId={doc.propertyId} activePage={activePage} onPageChange={setActivePage} height={480} />
            )}
            <CocoaSection title="Metadatos legales" headingLevel={3}>
              <ul className="c22-section__list">
                {metadata.map(([label, value]) => (
                  <li key={label}>
                    <span className="cocoa-note">{label}</span>
                    <span className={label === "Huella SHA-256" || label === "Nº de registro" ? "cocoa-mono" : undefined}>{value}</span>
                  </li>
                ))}
              </ul>
            </CocoaSection>
            <div className="cocoa-row" data-gap="2" data-justify="between">
              <div className="cocoa-row" data-gap="2">
                <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => navigateTo("IncomingDocumentsScreen", doc.id)}>
                  Abrir en Documentos
                </CocoaButton>
                {doc.supplierBillId ? (
                  <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => navigateTo("SupplierBillsScreen", doc.supplierBillId ?? undefined)}>
                    Ver la factura
                  </CocoaButton>
                ) : null}
              </div>
              <div className="cocoa-row" data-gap="2">
                {doc.blockedAt ? (
                  <>
                    <CocoaButton variant="bordered" tone="neutral" size="small" onClick={() => setAdminAction("unblock")} disabled={!isAdmin || busy} title={isAdmin ? undefined : NO_ADMIN_PERMISSION}>
                      Desbloquear
                    </CocoaButton>
                    <CocoaButton variant="bordered" tone="destructive" size="small" onClick={() => setAdminAction("purge")} disabled={!isAdmin || busy || doc.legalHold || Boolean(doc.deletedAt)} title={!isAdmin ? NO_ADMIN_PERMISSION : doc.legalHold ? "Con bloqueo legal no se purga" : doc.deletedAt ? "Ya está purgado" : undefined}>
                      Purgar
                    </CocoaButton>
                  </>
                ) : (
                  <CocoaButton variant="bordered" tone="destructive" size="small" onClick={() => setAdminAction("block")} disabled={!isAdmin || busy || Boolean(doc.deletedAt)} title={isAdmin ? undefined : NO_ADMIN_PERMISSION}>
                    Bloquear
                  </CocoaButton>
                )}
              </div>
            </div>
            {!isAdmin ? <span className="cocoa-note">{NO_ADMIN_PERMISSION} («documents.admin») para bloquear, desbloquear o purgar.</span> : null}
          </div>
        ) : null}
      </CocoaDrawer>

      <CocoaDialog
        open={adminAction !== null}
        onClose={() => {
          if (!busy) setAdminAction(null);
        }}
        title={adminAction ? ADMIN_COPY[adminAction].title : ""}
        description={adminAction ? ADMIN_COPY[adminAction].description : undefined}
        tone="destructive"
        confirmLabel={adminAction ? ADMIN_COPY[adminAction].confirm : ACTIONS.confirm}
        onConfirm={() => void confirmAdmin()}
        busy={busy}
        confirmDisabled={reason.trim().length < 3}
      >
        <CocoaField label="Motivo" required help="Queda en la auditoría del documento.">
          <CocoaInput value={reason} onChange={setReason} multiline rows={3} disabled={busy} />
        </CocoaField>
      </CocoaDialog>

    </CocoaPage>
  );
}

export default DocumentArchiveScreen;

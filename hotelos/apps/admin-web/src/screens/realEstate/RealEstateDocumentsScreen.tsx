// Documentación del activo inmobiliario — Finanzas › Activo inmobiliario › Documentación
// (Tanda ACT · lote ACT-F2, diseño docs/design/ASSET-MANAGEMENT-INMOBILIARIO.md §8).
//
// Cocoa 22 «lista / tabla»: CocoaPage → CocoaToolbar (búsqueda, categoría, estado,
// «Solo vigentes») → CocoaTable (categoría, tipo, título, emisor, emisión, vigencia
// con CocoaBadge verde / ámbar / rojo, versión, obligación enlazada, fichero) → la
// fila abre un CocoaSheet con la ficha y el VISOR: el fichero llega por
// downloadRealEstateDocument (apiRequestBlob, auditado en el API), se pinta desde un
// `blob:` propio —PDF en <iframe>, imagen en <img>, XML como texto— y se revoca al
// cerrar; «Descargar» guarda ese mismo blob (nunca fetch crudo). Una fila SIN fichero
// muestra «Sin fichero» y no abre el visor (la ficha sigue abriéndose para subir la
// versión con el fichero, editar fechas o retirar). Subida por CocoaFileInput (un
// fichero; PDF / JPEG / PNG / TIFF / XML; 40 MiB) + formulario de metadatos; el
// fichero viaja en base64 sin prefijo `data:` (services/realEstateApi.ts ·
// documentFileOf). Acciones: «Nueva versión» y «Editar fechas»
// (real_estate.documents.manage), «Retirar» (real_estate.manage; el 409 LEGAL_HOLD
// se explica con realEstateErrorMessage). Estados loading · empty · error con
// CocoaState; sin ficha del centro (404 ASSET_NOT_FOUND) el vacío remite a la
// pestaña Ficha. Cero estilos en línea.
//
// Lee services/realEstateApi.ts (listRealEstateDocuments · uploadRealEstateDocument ·
// uploadRealEstateDocumentVersion · updateRealEstateDocument · retireRealEstateDocument ·
// downloadRealEstateDocument) y screens/realEstate/real-estate-helpers.ts (etiquetas,
// tonos, formateadores y frases de error). Los helpers puros de abajo se prueban en
// __tests__/RealEstateDocumentsScreen.test.mts.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealEstateConfidentiality, RealEstateDocumentCategory, RealEstateDocumentKind, RealEstateDocumentRecord, RealEstateDocumentStatus } from "@hotelos/shared";
import { REAL_ESTATE_CONFIDENTIALITIES, REAL_ESTATE_DOCUMENT_CATEGORIES, REAL_ESTATE_DOCUMENT_KINDS, REAL_ESTATE_DOCUMENT_STATUSES } from "@hotelos/shared";
import {
  REAL_ESTATE_DOCUMENT_ACCEPT,
  REAL_ESTATE_DOCUMENT_MAX_BYTES,
  downloadRealEstateDocument,
  listRealEstateDocuments,
  retireRealEstateDocument,
  updateRealEstateDocument,
  uploadRealEstateDocument,
  uploadRealEstateDocumentVersion,
  type RealEstateDocumentMeta,
  type RealEstateDocumentPatchRequest
} from "../../services/realEstateApi";
import { financeErrorCode, financeErrorStatus } from "../../services/finance-contracts";
import { useActiveProperty } from "../../services/activeProperty";
import { useNavGate } from "../../navigation/useEnabledModules";
import { canDo } from "../accounting/accounting-ui";
import { useTabHost } from "../tabs/TabHost";
import { useToast } from "../../components/Toast";
import { saveBlob } from "../../components/billing/download";
import { ACTIONS, STATUS_LABELS, UI_STATES } from "../../content/actions";
import { plural } from "../../lib/format";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDatePicker,
  CocoaDialog,
  CocoaDrawer,
  CocoaField,
  CocoaFileInput,
  CocoaFormRow,
  CocoaInput,
  CocoaPage,
  CocoaScrollArea,
  CocoaSearchInput,
  CocoaSection,
  CocoaSelect,
  CocoaSheet,
  CocoaStat,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  CocoaToolbar,
  formatFileSize,
  useIsNarrow,
  type CocoaTableColumn
} from "../../components/cocoa";
import {
  CONFIDENTIALITY_LABELS,
  DOCUMENT_CATEGORY_LABELS,
  DOCUMENT_KIND_LABELS,
  DOCUMENT_STATUS_LABELS,
  catalogOptions,
  cdeStateLabel,
  confidentialityLabel,
  documentCategoryLabel,
  documentKindLabel,
  documentStatusLabel,
  documentStatusTone,
  formatDay,
  linkedEntityTypeLabel,
  realEstateErrorMessage
} from "./real-estate-helpers";

// ---------------------------------------------------------------------------
// Pantalla
// ---------------------------------------------------------------------------

export function RealEstateDocumentsScreen() {
  const hosted = useTabHost() !== null;
  const narrow = useIsNarrow();
  const { showToast } = useToast();
  const gate = useNavGate();
  const canManageDocs = canDo(gate, "real_estate.documents.manage");
  const canManage = canDo(gate, "real_estate.manage");
  const { propertyId } = useActiveProperty();

  const docs = useLoad(() => listRealEstateDocuments({}, propertyId), propertyId);
  const [filters, setFilters] = useState<DocumentFilters>(DOCUMENT_FILTER_DEFAULTS);
  const all = docs.data ?? [];
  const rows = filterDocuments(all, filters);
  const filtered = filters.search.trim() !== "" || filters.category !== "" || filters.status !== "" || !filters.onlyValid;

  // Ficha + visor (CocoaSheet)
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? (all.find((doc) => doc.id === selectedId) ?? null) : null;
  const viewer = useDocumentViewer(selected, propertyId);
  const [actionFailure, setActionFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [askRetire, setAskRetire] = useState(false);
  const [editingDates, setEditingDates] = useState(false);
  const [datesForm, setDatesForm] = useState<DocumentDatesForm>(EMPTY_DATES);

  // Subida (CocoaDrawer)
  const [uploading, setUploading] = useState(false);
  const [uploadForm, setUploadForm] = useState<DocumentUploadForm>(emptyUploadForm);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadTouched, setUploadTouched] = useState(false);
  const [uploadFailure, setUploadFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const uploadErrors = validateUploadForm(uploadForm);
  const shownUploadErrors: UploadFormErrors = uploadTouched ? uploadErrors : {};

  const errorCode = financeErrorCode(docs.error);
  const errorStatus = financeErrorStatus(docs.error);

  function setFilter<K extends keyof DocumentFilters>(key: K, value: DocumentFilters[K]) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function openDocument(doc: RealEstateDocumentRecord) {
    setActionFailure(null);
    setEditingDates(false);
    setSelectedId(doc.id);
  }

  function closeSheet() {
    setSelectedId(null);
    setEditingDates(false);
    setActionFailure(null);
    setAskRetire(false);
  }

  function openUpload() {
    setUploadForm(emptyUploadForm());
    setUploadFile(null);
    setUploadTouched(false);
    setUploadFailure(null);
    setUploading(true);
  }

  function setUpload<K extends keyof DocumentUploadForm>(key: K, value: DocumentUploadForm[K]) {
    setUploadForm((current) => ({ ...current, [key]: value }));
  }

  async function saveUpload() {
    if (saving) return;
    setUploadTouched(true);
    if (Object.keys(uploadErrors).length > 0) return;
    setSaving(true);
    setUploadFailure(null);
    try {
      const created = await submitDocumentUpload(uploadForm, uploadFile, propertyId);
      showToast(uploadFile ? `Documento «${created.title}» subido (v${created.version}).` : `Ficha «${created.title}» registrada sin fichero.`, { variant: "success" });
      setUploading(false);
      docs.refresh();
      setSelectedId(created.id);
    } catch (error: unknown) {
      setUploadFailure(documentFailureMessage(error, "No se pudo subir el documento. Revisa los datos e inténtalo de nuevo."));
    } finally {
      setSaving(false);
    }
  }

  async function uploadVersion(file: File) {
    if (!selected || busy) return;
    setBusy(true);
    setActionFailure(null);
    try {
      const version = await uploadRealEstateDocumentVersion(selected.id, file, {}, propertyId);
      showToast(`Versión ${version.version} de «${version.title}» subida.`, { variant: "success" });
      docs.refresh();
      setSelectedId(version.id);
    } catch (error: unknown) {
      setActionFailure(documentFailureMessage(error, "No se pudo subir la versión nueva."));
    } finally {
      setBusy(false);
    }
  }

  function startEditDates() {
    if (!selected) return;
    setDatesForm(datesFormOf(selected));
    setActionFailure(null);
    setEditingDates(true);
  }

  async function saveDates() {
    if (!selected || busy) return;
    const invalid = validateDatesForm(datesForm);
    if (invalid) {
      setActionFailure(invalid);
      return;
    }
    const patch = datesPatchOf(datesForm, selected);
    if (Object.keys(patch).length === 0) {
      setEditingDates(false);
      return;
    }
    setBusy(true);
    setActionFailure(null);
    try {
      await updateRealEstateDocument(selected.id, patch, propertyId);
      showToast("Fechas del documento actualizadas.", { variant: "success" });
      setEditingDates(false);
      docs.refresh();
    } catch (error: unknown) {
      setActionFailure(documentFailureMessage(error, "No se pudieron guardar las fechas."));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRetire() {
    if (!selected || busy) return;
    setBusy(true);
    setActionFailure(null);
    try {
      await retireRealEstateDocument(selected.id, propertyId);
      showToast(`Documento «${selected.title}» retirado. El fichero se conserva en el almacén.`, { variant: "success" });
      setAskRetire(false);
      closeSheet();
      docs.refresh();
    } catch (error: unknown) {
      // 409 LEGAL_HOLD → «El documento tiene bloqueo legal…» (real-estate-helpers).
      setActionFailure(documentFailureMessage(error, "No se pudo retirar el documento."));
      setAskRetire(false);
    } finally {
      setBusy(false);
    }
  }

  function download() {
    if (viewer.status !== "ready" || !selected) return;
    saveBlob(viewer.blob, viewer.fileName ?? selected.fileName ?? `${selected.title}.bin`);
  }

  const uploadLabel = "Subir documento";
  const ready = !docs.loading && !docs.error && rows.length > 0;

  let body;
  if (docs.loading && !docs.data) {
    body = <CocoaTable columns={DOCUMENT_COLUMNS} rows={[]} loading aria-label="Documentación del activo inmobiliario" />;
  } else if (docs.error && errorCode === "ASSET_NOT_FOUND") {
    body = <CocoaState kind="empty" illustration="box" title={NO_ASSET_TITLE} message={NO_ASSET_MESSAGE} />;
  } else if (docs.error && errorStatus === 403) {
    body = <CocoaState kind="empty" title={UI_STATES.forbidden.title} message={UI_STATES.forbidden.message} />;
  } else if (docs.error) {
    body = <CocoaState kind="error" title="No se pudo cargar la documentación" message={documentFailureMessage(docs.error, UI_STATES.error.message)} onRetry={docs.refresh} />;
  } else if (rows.length === 0) {
    body = (
      <CocoaState
        kind="empty"
        illustration={filtered ? "search" : "box"}
        title={filtered ? STATUS_LABELS.noResults : "Aún no hay documentación del activo"}
        message={filtered ? "Ningún documento coincide con los filtros." : "Sube escrituras, notas simples, planos, licencias, pólizas y contratos con su vigencia para que el calendario avise antes de que caduquen."}
        primaryAction={canManageDocs && !filtered ? { label: uploadLabel, onClick: openUpload } : undefined}
        secondaryAction={filtered ? { label: ACTIONS.clearFilters, onClick: () => setFilters(DOCUMENT_FILTER_DEFAULTS) } : undefined}
      />
    );
  } else {
    body = (
      <CocoaTable
        columns={DOCUMENT_COLUMNS}
        rows={rows}
        rowKey="id"
        selectedKey={selectedId ?? undefined}
        onSelect={openDocument}
        rowTone={documentRowTone}
        rowTitle={(doc) => (documentOpensViewer(doc) ? "Abrir la ficha y el visor del documento" : "Abrir la ficha (sin fichero: no hay visor)")}
        caption="Documentación del activo inmobiliario"
        aria-label="Documentación del activo inmobiliario"
        columnsPrefsKey="real-estate-documents"
      />
    );
  }

  return (
    <CocoaPage
      eyebrow="Finanzas · Activo inmobiliario"
      title="Documentación"
      subtitle={hosted ? undefined : "Escrituras, planos, licencias, pólizas y contratos del inmueble con su vigencia, sus versiones y el visor del fichero."}
      actions={
        <CocoaButton variant="filled" tone="accent" size={hosted ? "small" : "regular"} onClick={openUpload} disabled={!canManageDocs || errorCode === "ASSET_NOT_FOUND"} title={canManageDocs ? undefined : NO_PERMISSION_UPLOAD}>
          {uploadLabel}
        </CocoaButton>
      }
      commands={[
        { id: "real-estate-documents-upload", label: uploadLabel, run: openUpload },
        { id: "real-estate-documents-refresh", label: "Actualizar documentación", run: docs.refresh }
      ]}
    >
      <CocoaToolbar
        variant="content"
        aria-label="Filtros de la documentación"
        leftSlot={<CocoaSearchInput value={filters.search} onChange={(value) => setFilter("search", value)} debounceMs={200} placeholder="Título, emisor o fichero…" aria-label="Buscar documentos" />}
        rightSlot={
          <>
            <CocoaSelect value={filters.category} onChange={(value) => setFilter("category", value)} size="small" inline aria-label="Filtrar por categoría" options={[{ value: "", label: "Todas las categorías" }, ...catalogOptions(REAL_ESTATE_DOCUMENT_CATEGORIES, DOCUMENT_CATEGORY_LABELS)]} />
            <CocoaSelect value={filters.status} onChange={(value) => setFilter("status", value)} size="small" inline aria-label="Filtrar por vigencia" options={[{ value: "", label: "Toda vigencia" }, ...catalogOptions(REAL_ESTATE_DOCUMENT_STATUSES, DOCUMENT_STATUS_LABELS)]} />
            <CocoaSwitch checked={filters.onlyValid} onChange={(value) => setFilter("onlyValid", value)} size="small" label="Solo vigentes" />
          </>
        }
      />

      <CocoaSection padding={ready ? "none" : "md"} aria-label="Documentos del activo" footer={ready ? <span>{plural(rows.length, "documento", "documentos")}</span> : undefined}>
        {body}
      </CocoaSection>

      <CocoaSheet
        open={selected !== null}
        onClose={closeSheet}
        title={selected?.title ?? "Documento"}
        size="lg"
        footer={
          selected ? (
            <div className="cocoa-row" data-gap="2" data-justify="between">
              <div className="cocoa-cluster">
                <CocoaButton variant="bordered" tone="neutral" size="small" onClick={download} disabled={viewer.status !== "ready"} title={documentOpensViewer(selected) ? undefined : NO_FILE_LABEL}>
                  {ACTIONS.download}
                </CocoaButton>
                <CocoaFileInput
                  accept={REAL_ESTATE_DOCUMENT_ACCEPT}
                  maxBytes={REAL_ESTATE_DOCUMENT_MAX_BYTES}
                  label="Nueva versión"
                  onPick={(file) => void uploadVersion(file)}
                  onReject={setActionFailure}
                  disabled={!canManageDocs || busy || selected.deletedAt !== null || selected.supersededById !== null}
                />
                <CocoaButton variant="plain" tone="neutral" size="small" onClick={startEditDates} disabled={!canManageDocs || busy || editingDates || selected.deletedAt !== null} title={canManageDocs ? undefined : NO_PERMISSION_UPLOAD}>
                  Editar fechas
                </CocoaButton>
                <CocoaButton variant="plain" tone="destructive" size="small" onClick={() => setAskRetire(true)} disabled={!canManage || busy || selected.deletedAt !== null} title={canManage ? (selected.legalHold ? "Documento con bloqueo legal: la retirada responderá LEGAL_HOLD" : undefined) : NO_PERMISSION_RETIRE}>
                  Retirar
                </CocoaButton>
              </div>
              <CocoaButton variant="bordered" tone="neutral" size="small" onClick={closeSheet}>
                {ACTIONS.close}
              </CocoaButton>
            </div>
          ) : undefined
        }
      >
        {selected ? (
          <div className="cocoa-stack" data-gap="4">
            <div className="cocoa-cluster">
              <CocoaBadge tone="neutral" variant="outline">
                {documentCategoryLabel(selected.category)}
              </CocoaBadge>
              <CocoaBadge tone="neutral" variant="outline" uppercase={false}>
                {documentKindLabel(selected.kind)}
              </CocoaBadge>
              <DocumentValidityBadge doc={selected} />
              <CocoaBadge tone="neutral" variant="outline" uppercase={false}>
                {`Versión ${selected.version}`}
              </CocoaBadge>
              {selected.legalHold ? (
                <CocoaBadge tone="warning" variant="tinted" uppercase={false}>
                  Bloqueo legal
                </CocoaBadge>
              ) : null}
              {selected.deletedAt ? (
                <CocoaBadge tone="danger" variant="tinted" uppercase={false}>
                  Retirado
                </CocoaBadge>
              ) : null}
            </div>

            {actionFailure ? (
              <CocoaCallout tone="danger" role="alert" title="No se pudo completar la acción">
                {actionFailure}
              </CocoaCallout>
            ) : null}

            <CocoaFormRow columns={4} min={160}>
              <CocoaStat label="Emisor" value={selected.issuerName ?? "—"} tabular={false} />
              <CocoaStat label="Emisión" value={formatDay(selected.issueDate)} />
              <CocoaStat label="Vigencia" value={validityRange(selected)} hint={selected.renewalDays !== null ? `Renovación ${plural(selected.renewalDays, "día", "días")} antes` : undefined} />
              <CocoaStat label="Obligación enlazada" value={linkedLabel(selected)} tabular={false} />
              <CocoaStat label="Fichero" value={fileLabel(selected)} tabular={false} hint={selected.sha256 ? `SHA-256 ${selected.sha256.slice(0, 12)}…` : undefined} />
              <CocoaStat label="Confidencialidad" value={confidentialityLabel(selected.confidentiality)} tabular={false} hint={cdeStateLabel(selected.cdeState)} />
              <CocoaStat label="Retención hasta" value={formatDay(selected.retentionUntil)} />
              <CocoaStat label="Sustituye a" value={selected.supersedesId ? "una versión anterior" : "—"} tabular={false} hint={selected.supersededById ? "Sustituido por una versión posterior" : undefined} />
            </CocoaFormRow>

            {editingDates ? (
              <CocoaSection title="Editar fechas" aria-label="Editar fechas del documento">
                <div className="cocoa-stack" data-gap="3">
                  <CocoaFormRow columns={4} min={160}>
                    <CocoaField label="Emisión">
                      <CocoaDatePicker value={datesForm.issueDate} onChange={(value) => setDatesForm((current) => ({ ...current, issueDate: value }))} disabled={busy} />
                    </CocoaField>
                    <CocoaField label="Vigente desde">
                      <CocoaDatePicker value={datesForm.validFrom} onChange={(value) => setDatesForm((current) => ({ ...current, validFrom: value }))} disabled={busy} />
                    </CocoaField>
                    <CocoaField label="Vigente hasta" help="Vacío: sin vigencia (no caduca).">
                      <CocoaDatePicker value={datesForm.validUntil} onChange={(value) => setDatesForm((current) => ({ ...current, validUntil: value }))} disabled={busy} />
                    </CocoaField>
                    <CocoaField label="Aviso de renovación (días)">
                      <CocoaInput value={datesForm.renewalDays} onChange={(value) => setDatesForm((current) => ({ ...current, renewalDays: value }))} type="number" inputMode="numeric" min={0} step={1} disabled={busy} />
                    </CocoaField>
                  </CocoaFormRow>
                  <div className="cocoa-row" data-gap="2" data-justify="end">
                    <CocoaButton variant="plain" tone="neutral" size="small" onClick={() => setEditingDates(false)} disabled={busy}>
                      {ACTIONS.cancel}
                    </CocoaButton>
                    <CocoaButton variant="filled" tone="accent" size="small" onClick={() => void saveDates()} loading={busy}>
                      {ACTIONS.save}
                    </CocoaButton>
                  </div>
                </div>
              </CocoaSection>
            ) : null}

            <DocumentViewerPane doc={selected} viewer={viewer} narrow={narrow} />
          </div>
        ) : null}
      </CocoaSheet>

      <CocoaDialog
        open={askRetire && selected !== null}
        onClose={() => setAskRetire(false)}
        title="Retirar el documento"
        description={selected ? `«${selected.title}» dejará de aparecer en la documentación del activo. El fichero se conserva en el almacén y la retirada queda auditada.` : ""}
        tone="destructive"
        confirmLabel="Retirar"
        onConfirm={confirmRetire}
        busy={busy}
      />

      <CocoaDrawer
        open={uploading}
        onClose={() => setUploading(false)}
        title={uploadLabel}
        subtitle="Metadatos del documento y, si lo tienes, el fichero escaneado."
        size="md"
        footer={
          <div className="cocoa-row" data-gap="2" data-justify="end">
            <CocoaButton variant="plain" tone="neutral" onClick={() => setUploading(false)} disabled={saving}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void saveUpload()} loading={saving} disabled={!canManageDocs}>
              {uploadFile ? "Subir documento" : "Registrar sin fichero"}
            </CocoaButton>
          </div>
        }
      >
        <div className="cocoa-stack" data-gap="4">
          {uploadFailure ? (
            <CocoaCallout tone="danger" role="alert" title="No se pudo subir">
              {uploadFailure}
            </CocoaCallout>
          ) : null}
          <CocoaField label="Fichero" help={uploadFile ? `${uploadFile.name} · ${formatFileSize(uploadFile.size)}` : "PDF, JPEG, PNG, TIFF o XML de hasta 40 MiB. Sin fichero se registra solo la ficha («Sin fichero») y podrás subirlo después como versión nueva."} error={shownUploadErrors.file}>
            <CocoaFileInput accept={REAL_ESTATE_DOCUMENT_ACCEPT} maxBytes={REAL_ESTATE_DOCUMENT_MAX_BYTES} fileName={uploadFile?.name ?? null} onPick={(file) => { setUploadFile(file); if (!uploadForm.title.trim()) setUpload("title", titleFromFileName(file.name)); }} onReject={setUploadFailure} disabled={saving} label="Elegir fichero" />
          </CocoaField>
          <CocoaFormRow columns={2}>
            <CocoaField label="Categoría" required>
              <CocoaSelect value={uploadForm.category} onChange={(value) => setUpload("category", value as RealEstateDocumentCategory)} options={catalogOptions(REAL_ESTATE_DOCUMENT_CATEGORIES, DOCUMENT_CATEGORY_LABELS)} disabled={saving} />
            </CocoaField>
            <CocoaField label="Tipo" required>
              <CocoaSelect value={uploadForm.kind} onChange={(value) => setUpload("kind", value as RealEstateDocumentKind)} options={catalogOptions(REAL_ESTATE_DOCUMENT_KINDS, DOCUMENT_KIND_LABELS)} disabled={saving} />
            </CocoaField>
            <CocoaField label="Título" required error={shownUploadErrors.title} fullWidth>
              <CocoaInput value={uploadForm.title} onChange={(value) => setUpload("title", value)} placeholder="Escritura de compraventa, licencia de actividad…" maxLength={200} disabled={saving} />
            </CocoaField>
            <CocoaField label="Emisor" help="Notaría, registro, ayuntamiento, OCA, aseguradora…">
              <CocoaInput value={uploadForm.issuerName} onChange={(value) => setUpload("issuerName", value)} maxLength={160} disabled={saving} />
            </CocoaField>
            <CocoaField label="Obligación de cumplimiento" help="Código del requisito (catálogo de Cumplimiento) que este documento acredita.">
              <CocoaInput value={uploadForm.complianceRequirementCode} onChange={(value) => setUpload("complianceRequirementCode", value)} placeholder="SAN-LEG-01" maxLength={64} disabled={saving} />
            </CocoaField>
            <CocoaField label="Emisión">
              <CocoaDatePicker value={uploadForm.issueDate} onChange={(value) => setUpload("issueDate", value)} disabled={saving} />
            </CocoaField>
            <CocoaField label="Vigente desde">
              <CocoaDatePicker value={uploadForm.validFrom} onChange={(value) => setUpload("validFrom", value)} disabled={saving} />
            </CocoaField>
            <CocoaField label="Vigente hasta" help="Vacío: sin vigencia (no caduca)." error={shownUploadErrors.validUntil}>
              <CocoaDatePicker value={uploadForm.validUntil} onChange={(value) => setUpload("validUntil", value)} disabled={saving} />
            </CocoaField>
            <CocoaField label="Aviso de renovación (días)" error={shownUploadErrors.renewalDays}>
              <CocoaInput value={uploadForm.renewalDays} onChange={(value) => setUpload("renewalDays", value)} type="number" inputMode="numeric" min={0} step={1} disabled={saving} />
            </CocoaField>
            <CocoaField label="Confidencialidad">
              <CocoaSelect value={uploadForm.confidentiality} onChange={(value) => setUpload("confidentiality", value as RealEstateConfidentiality)} options={catalogOptions(REAL_ESTATE_CONFIDENTIALITIES, CONFIDENTIALITY_LABELS)} disabled={saving} />
            </CocoaField>
          </CocoaFormRow>
        </div>
      </CocoaDrawer>
    </CocoaPage>
  );
}

// ---------------------------------------------------------------------------
// Piezas de presentación
// ---------------------------------------------------------------------------

/** Vigencia derivada del documento: verde vigente · ámbar caduca pronto · rojo caducado · gris sin fecha / sustituido. */
export function DocumentValidityBadge({ doc }: { doc: Pick<RealEstateDocumentRecord, "status" | "validUntil"> }) {
  return (
    <CocoaBadge tone={documentStatusTone(doc.status)} variant="tinted" uppercase={false} title={doc.validUntil ? `Vigente hasta el ${formatDay(doc.validUntil)}` : undefined}>
      {documentStatusLabel(doc.status)}
    </CocoaBadge>
  );
}

/** Celda «Fichero»: nombre y tamaño, o «Sin fichero» cuando la ficha se registró sin él. */
export function DocumentFileCell({ doc }: { doc: Pick<RealEstateDocumentRecord, "hasFile" | "fileName" | "sizeBytes" | "mimeType"> }) {
  if (!doc.hasFile) {
    return (
      <CocoaBadge tone="neutral" variant="outline" uppercase={false}>
        {NO_FILE_LABEL}
      </CocoaBadge>
    );
  }
  return <span title={doc.mimeType ?? undefined}>{fileLabel(doc)}</span>;
}

export type DocumentViewerPaneProps = { doc: RealEstateDocumentRecord; viewer: ViewerState; narrow: boolean };

/** Visor del fichero dentro del CocoaSheet: PDF en iframe, imagen en img, XML como texto; sin fichero, la nota «Sin fichero». */
export function DocumentViewerPane({ doc, viewer, narrow }: DocumentViewerPaneProps) {
  const height = narrow ? VIEWER_HEIGHT_NARROW : VIEWER_HEIGHT;
  if (!documentOpensViewer(doc)) {
    return (
      <CocoaCallout tone="neutral" title={NO_FILE_LABEL}>
        {doc.deletedAt ? "El documento está retirado: el fichero permanece en el almacén pero ya no se abre desde aquí." : "La ficha se registró sin fichero: sube una versión nueva con el documento escaneado para verlo aquí."}
      </CocoaCallout>
    );
  }
  if (viewer.status === "loading" || viewer.status === "idle") return <CocoaState kind="loading" inline title="Abriendo el fichero" />;
  if (viewer.status === "error") return <CocoaState kind="error" inline title="No se pudo abrir el fichero" message={viewer.message} />;
  if (viewer.kind === "pdf" && viewer.url) return <iframe src={viewer.url} title={`Visor · ${doc.title}`} width="100%" height={height} />;
  if (viewer.kind === "image" && viewer.url) {
    return (
      <div className="cocoa-scroll-x">
        <img src={viewer.url} alt={`Fichero · ${doc.title}`} />
      </div>
    );
  }
  if (viewer.kind === "xml") {
    return (
      <CocoaScrollArea axis="both" maxHeight={height} aria-label={`Contenido XML · ${doc.title}`}>
        <pre>{viewer.text ?? ""}</pre>
      </CocoaScrollArea>
    );
  }
  return (
    <CocoaCallout tone="info" title="Este formato no se previsualiza">
      {`El fichero es ${viewer.blob.type || doc.mimeType || "de un tipo desconocido"} (${formatFileSize(viewer.blob.size)}): descárgalo para consultarlo.`}
    </CocoaCallout>
  );
}

// ---------------------------------------------------------------------------
// Carga (clave = centro activo; conserva el error tipado para ASSET_NOT_FOUND / 403)
// ---------------------------------------------------------------------------

type LoadState<T> = { data: T | null; loading: boolean; error: unknown; refresh: () => void };

function useLoad<T>(load: () => Promise<T>, key: string): LoadState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    const current = ++seq.current;
    setLoading(true);
    setError(null);
    loadRef
      .current()
      .then((value) => {
        if (current !== seq.current) return;
        setData(value);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (current !== seq.current) return;
        setError(err);
        setLoading(false);
      });
  }, [key, nonce]);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { data, loading, error, refresh };
}

// ---------------------------------------------------------------------------
// Visor: blob propio del documento abierto (se revoca al cerrar o cambiar)
// ---------------------------------------------------------------------------

export type ViewerKind = "pdf" | "image" | "xml" | "other";

export type ViewerState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; kind: ViewerKind; url: string | null; blob: Blob; text: string | null; fileName: string | null };

const VIEWER_IDLE: ViewerState = { status: "idle" };
export const VIEWER_HEIGHT = 560;
export const VIEWER_HEIGHT_NARROW = 360;

function useDocumentViewer(doc: RealEstateDocumentRecord | null, propertyId: string): ViewerState {
  const [state, setState] = useState<ViewerState>(VIEWER_IDLE);
  const docId = doc?.id ?? null;
  const opens = doc ? documentOpensViewer(doc) : false;
  const mimeType = doc?.mimeType ?? null;
  const fileName = doc?.fileName ?? null;
  useEffect(() => {
    if (!docId || !opens) {
      setState(VIEWER_IDLE);
      return undefined;
    }
    let alive = true;
    let objectUrl: string | null = null;
    setState({ status: "loading" });
    downloadRealEstateDocument(docId, { inline: true }, propertyId)
      .then(async (response) => {
        if (!alive) return;
        const kind = viewerKindOf(response.contentType || mimeType, fileName);
        const text = kind === "xml" ? await response.blob.text() : null;
        if (!alive) return;
        objectUrl = kind === "pdf" || kind === "image" ? URL.createObjectURL(response.blob) : null;
        setState({ status: "ready", kind, url: objectUrl, blob: response.blob, text, fileName: fileNameFromDisposition(response.contentDisposition) ?? fileName });
      })
      .catch((error: unknown) => {
        if (!alive) return;
        setState({ status: "error", message: documentFailureMessage(error, "No se pudo abrir el fichero.") });
      });
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [docId, opens, mimeType, fileName, propertyId]);
  return state;
}

// ---------------------------------------------------------------------------
// Helpers puros (probados en __tests__/RealEstateDocumentsScreen.test.mts)
// ---------------------------------------------------------------------------

export const NO_FILE_LABEL = "Sin fichero";
export const NO_ASSET_TITLE = "Este centro aún no tiene activo inmobiliario";
export const NO_ASSET_MESSAGE = "Crea la ficha del inmueble en la pestaña Ficha; después podrás subir aquí escrituras, planos, licencias, pólizas y contratos.";
export const NO_PERMISSION_UPLOAD = "Necesitas el permiso de gestión de documentos del activo («real_estate.documents.manage»).";
export const NO_PERMISSION_RETIRE = "Solo quien gestiona el activo inmobiliario («real_estate.manage») puede retirar un documento.";

export type DocumentFilters = { search: string; category: string; status: string; onlyValid: boolean };

export const DOCUMENT_FILTER_DEFAULTS: DocumentFilters = { search: "", category: "", status: "", onlyValid: true };

/** «Solo vigentes» oculta los caducados y los sustituidos; «sin vigencia» y «caduca pronto» siguen siendo válidos. */
export const NON_VALID_STATUSES: readonly RealEstateDocumentStatus[] = ["caducado", "sustituido"];

export function documentIsValid(doc: Pick<RealEstateDocumentRecord, "status" | "deletedAt">): boolean {
  return doc.deletedAt === null && !NON_VALID_STATUSES.includes(doc.status);
}

function fold(text: string | null | undefined): string {
  return (text ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** Filtro en cliente sobre el listado del centro: texto (título, emisor, fichero, tipo, categoría), categoría, vigencia y «Solo vigentes». */
export function filterDocuments<T extends Pick<RealEstateDocumentRecord, "title" | "issuerName" | "fileName" | "kind" | "category" | "status" | "deletedAt">>(rows: readonly T[], filters: DocumentFilters): T[] {
  const needle = fold(filters.search.trim());
  return rows.filter((doc) => {
    if (filters.onlyValid && !documentIsValid(doc)) return false;
    if (filters.category && doc.category !== filters.category) return false;
    if (filters.status && doc.status !== filters.status) return false;
    if (!needle) return true;
    const haystack = [doc.title, doc.issuerName, doc.fileName, documentKindLabel(doc.kind), documentCategoryLabel(doc.category)].map(fold).join(" ");
    return haystack.includes(needle);
  });
}

/** La fila abre el visor solo con fichero y sin retirar: sin fichero se abre la ficha pero no se pide ningún blob. */
export function documentOpensViewer(doc: Pick<RealEstateDocumentRecord, "hasFile" | "deletedAt">): boolean {
  return doc.hasFile && doc.deletedAt === null;
}

/** Cómo se pinta el fichero: PDF en iframe, JPEG / PNG en img, XML como texto; TIFF y el resto solo se descargan. */
export function viewerKindOf(mimeType: string | null | undefined, fileName?: string | null): ViewerKind {
  const mime = (mimeType ?? "").split(";")[0].trim().toLowerCase();
  const name = (fileName ?? "").toLowerCase();
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (mime === "image/jpeg" || mime === "image/png" || mime === "image/webp" || mime === "image/gif") return "image";
  if (mime === "application/xml" || mime === "text/xml" || name.endsWith(".xml")) return "xml";
  return "other";
}

/** Nombre de fichero de `Content-Disposition` (`attachment; filename="x.pdf"` o `filename*=UTF-8''x.pdf`); null si no lo lleva. */
export function fileNameFromDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  const star = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      return star[1].trim();
    }
  }
  const plain = /filename="?([^";]+)"?/.exec(header);
  return plain ? plain[1].trim() : null;
}

/** Frase en español de un fallo (LEGAL_HOLD, DOCUMENT_SUPERSEDED, DOCUMENT_TOO_LARGE, ASSET_NOT_FOUND…) o `fallback`. */
export function documentFailureMessage(error: unknown, fallback?: string): string {
  return realEstateErrorMessage(error, fallback);
}

export function fileLabel(doc: Pick<RealEstateDocumentRecord, "hasFile" | "fileName" | "sizeBytes">): string {
  if (!doc.hasFile) return NO_FILE_LABEL;
  const size = doc.sizeBytes !== null ? formatFileSize(doc.sizeBytes) : null;
  const name = doc.fileName ?? "fichero";
  return size ? `${name} · ${size}` : name;
}

export function validityRange(doc: Pick<RealEstateDocumentRecord, "validFrom" | "validUntil">): string {
  if (!doc.validFrom && !doc.validUntil) return "Sin vigencia";
  if (!doc.validFrom) return `hasta ${formatDay(doc.validUntil)}`;
  if (!doc.validUntil) return `desde ${formatDay(doc.validFrom)}`;
  return `${formatDay(doc.validFrom)} – ${formatDay(doc.validUntil)}`;
}

/** Columna «Obligación enlazada»: el código del requisito de cumplimiento o la entidad del activo a la que acompaña. */
export function linkedLabel(doc: Pick<RealEstateDocumentRecord, "complianceRequirementCode" | "linkedEntityType" | "linkedEntityId">): string {
  if (doc.complianceRequirementCode) return doc.complianceRequirementCode;
  if (doc.linkedEntityType) return linkedEntityTypeLabel(doc.linkedEntityType);
  return "—";
}

export function documentRowTone(doc: Pick<RealEstateDocumentRecord, "status" | "deletedAt">): "danger" | "warning" | "neutral" | undefined {
  if (doc.deletedAt || doc.status === "sustituido") return "neutral";
  if (doc.status === "caducado") return "danger";
  if (doc.status === "caduca_pronto") return "warning";
  return undefined;
}

/** «escritura-compraventa_2019.pdf» → «escritura-compraventa_2019» (título por defecto al elegir fichero). */
export function titleFromFileName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  return base.trim();
}

export const DOCUMENT_COLUMNS: CocoaTableColumn<RealEstateDocumentRecord>[] = [
  { key: "category", label: "Categoría", fit: true, render: (doc) => documentCategoryLabel(doc.category) },
  { key: "kind", label: "Tipo", truncate: 220, render: (doc) => documentKindLabel(doc.kind) },
  { key: "title", label: "Título", truncate: 320, render: (doc) => doc.title },
  { key: "issuerName", label: "Emisor", truncate: 200, hideOnNarrow: true, render: (doc) => doc.issuerName ?? "—" },
  { key: "issueDate", label: "Emisión", fit: true, hideOnNarrow: true, render: (doc) => formatDay(doc.issueDate) },
  {
    key: "status",
    label: "Vigencia",
    fit: true,
    render: (doc) => (
      <span className="cocoa-cluster">
        <DocumentValidityBadge doc={doc} />
        {doc.validUntil ? <span>{formatDay(doc.validUntil)}</span> : null}
      </span>
    )
  },
  { key: "version", label: "Versión", fit: true, align: "right", showFrom: "tablet", render: (doc) => `v${doc.version}` },
  { key: "linked", label: "Obligación", truncate: 180, showFrom: "laptop", render: linkedLabel },
  { key: "file", label: "Fichero", fit: true, render: (doc) => <DocumentFileCell doc={doc} /> }
];

// ---------------------------------------------------------------------------
// Formularios: subida (metadatos + fichero) y fechas
// ---------------------------------------------------------------------------

export type DocumentUploadForm = {
  category: RealEstateDocumentCategory;
  kind: RealEstateDocumentKind;
  title: string;
  issuerName: string;
  issueDate: string;
  validFrom: string;
  validUntil: string;
  renewalDays: string;
  complianceRequirementCode: string;
  confidentiality: RealEstateConfidentiality;
};

export type UploadFormErrors = Partial<Record<keyof DocumentUploadForm | "file", string>>;

export function emptyUploadForm(): DocumentUploadForm {
  return { category: "legal", kind: "escritura", title: "", issuerName: "", issueDate: "", validFrom: "", validUntil: "", renewalDays: "", complianceRequirementCode: "", confidentiality: "interno" };
}

const INTEGER = /^\d+$/;

export function validateUploadForm(form: DocumentUploadForm): UploadFormErrors {
  const errors: UploadFormErrors = {};
  if (!form.title.trim()) errors.title = "Indica el título del documento.";
  if (form.renewalDays.trim() && !INTEGER.test(form.renewalDays.trim())) errors.renewalDays = "Días enteros (0 o más).";
  if (form.validFrom && form.validUntil && form.validUntil < form.validFrom) errors.validUntil = "La vigencia termina antes de empezar.";
  return errors;
}

function textOrNull(value: string): string | null {
  const text = value.trim();
  return text ? text : null;
}

/** Metadatos del alta tal como viajan al API (vacío → null; el fichero lo añade uploadRealEstateDocument en base64). */
export function uploadMetaOf(form: DocumentUploadForm): RealEstateDocumentMeta {
  const renewal = form.renewalDays.trim();
  return {
    category: form.category,
    kind: form.kind,
    title: form.title.trim(),
    issuerName: textOrNull(form.issuerName),
    issueDate: textOrNull(form.issueDate),
    validFrom: textOrNull(form.validFrom),
    validUntil: textOrNull(form.validUntil),
    renewalDays: renewal ? Number(renewal) : null,
    complianceRequirementCode: textOrNull(form.complianceRequirementCode),
    confidentiality: form.confidentiality
  };
}

/** Alta: metadatos + fichero opcional. El fichero va en el JSON como base64 estándar SIN prefijo `data:` (documentFileOf → readFileAsBase64). */
export function submitDocumentUpload(form: DocumentUploadForm, file: File | null, propertyId: string): Promise<RealEstateDocumentRecord> {
  return uploadRealEstateDocument(uploadMetaOf(form), file, propertyId);
}

export type DocumentDatesForm = { issueDate: string; validFrom: string; validUntil: string; renewalDays: string };

const EMPTY_DATES: DocumentDatesForm = { issueDate: "", validFrom: "", validUntil: "", renewalDays: "" };

export function datesFormOf(doc: Pick<RealEstateDocumentRecord, "issueDate" | "validFrom" | "validUntil" | "renewalDays">): DocumentDatesForm {
  return { issueDate: doc.issueDate ?? "", validFrom: doc.validFrom ?? "", validUntil: doc.validUntil ?? "", renewalDays: doc.renewalDays !== null ? String(doc.renewalDays) : "" };
}

export function validateDatesForm(form: DocumentDatesForm): string | null {
  if (form.renewalDays.trim() && !INTEGER.test(form.renewalDays.trim())) return "Los días de aviso deben ser un entero (0 o más).";
  if (form.validFrom && form.validUntil && form.validUntil < form.validFrom) return "La vigencia termina antes de empezar.";
  return null;
}

/** Solo los campos que cambian (vacío → null borra en el API); sin cambios → {}. */
export function datesPatchOf(form: DocumentDatesForm, doc: Pick<RealEstateDocumentRecord, "issueDate" | "validFrom" | "validUntil" | "renewalDays">): RealEstateDocumentPatchRequest {
  const patch: RealEstateDocumentPatchRequest = {};
  const issueDate = textOrNull(form.issueDate);
  const validFrom = textOrNull(form.validFrom);
  const validUntil = textOrNull(form.validUntil);
  const renewal = form.renewalDays.trim();
  const renewalDays = renewal ? Number(renewal) : null;
  if (issueDate !== doc.issueDate) patch.issueDate = issueDate;
  if (validFrom !== doc.validFrom) patch.validFrom = validFrom;
  if (validUntil !== doc.validUntil) patch.validUntil = validUntil;
  if (renewalDays !== doc.renewalDays) patch.renewalDays = renewalDays;
  return patch;
}

export default RealEstateDocumentsScreen;

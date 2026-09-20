import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Tanda T9 · lote T9-10 (diseño docs/design/DOCUMENTOS-DIGITALIZACION.md §6.4,
// §9 y §10 «Montaje» / «Captura»): Operaciones › Digitalizar, su cajón de captura,
// el diálogo de la etiqueta y los dos clientes tipados están anclados sobre el
// código fuente — la pantalla y el cajón llegan a services/api-client.ts
// (import.meta.env) y no cargan bajo node --test, como finance-scope-usage y
// payroll-cost-screen-contract. Lo que sí carga es DocumentLabelDialog.tsx
// (Cocoa + lib/format): sus helpers puros (KPI de la tira, rangos de «Dividir»,
// HTML de la etiqueta) se prueban de verdad más abajo.
//
// Anclas: reglas Cocoa 22 (cero `style={` en los tres ficheros, sin elementos
// crudos, sin literales de color, sin emoji), cero `fetch(` (todo por
// documentsApi / api-client), el copy «Copia digital no certificada», el permiso
// documents.capture por canDo(useNavGate(), …), las piezas del diseño (KPI,
// aviso fijo, aviso de éxito + «Imprimir etiqueta», rowActions, valija, cajón con
// foto + arrastrar y soltar + compresión) y la superficie de los dos servicios.

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

const screen = source("../DocumentCaptureScreen.tsx");
const drawer = source("../DocumentCaptureDrawer.tsx");
const dialog = source("../DocumentLabelDialog.tsx");
const documentsApi = source("../../../services/documentsApi.ts");
const goodsReceiptsApi = source("../../../services/goodsReceiptsApi.ts");
const app = source("../../../App.tsx");
const tree = JSON.parse(source("../../../navigation/nav-tree.generated.json")) as {
  categories: Array<{ label: string; items: Array<{ screenKey: string; label: string; url: string; roles: string[]; modulesAny: string[]; tabs: unknown[] }> }>;
};

const labelDialog = await import("../DocumentLabelDialog.tsx");

/** Rules 1-5, 9-11 of tests/cocoa-22-contract.test.mjs, applied to one file. */
function assertCocoaRules(name: string, src: string) {
  assert.doesNotMatch(src, /(?<!-)\bbo-[a-z0-9-]+/, `${name}: no .bo-* classes`);
  assert.doesNotMatch(src, /<button\b/, `${name}: no raw <button>`);
  assert.doesNotMatch(src, /<table\b/, `${name}: no raw <table>`);
  assert.doesNotMatch(src, /<(?:input|select|textarea)\b/, `${name}: no raw form controls`);
  assert.doesNotMatch(src, /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/, `${name}: no colour literals`);
  assert.doesNotMatch(src, /\p{Extended_Pictographic}/u, `${name}: no emoji`);
  assert.doesNotMatch(src, /transition:\s*["']all|position:\s*["'(]*fixed|zIndex:\s*["'(]*\d/, `${name}: no transition: all, fixed position nor numeric zIndex`);
  assert.doesNotMatch(src, /money\([^)]*"EUR"\)/, `${name}: the currency never travels as a literal`);
  assert.doesNotMatch(src, /\b(?:window\.|globalThis\.)?fetch\s*\(/, `${name}: no raw fetch`);
  assert.doesNotMatch(src, /Intl\.(?:NumberFormat|DateTimeFormat)|toLocale[A-Za-z]*String\(/, `${name}: formatting only through lib/format`);
}

describe("Operaciones › Digitalizar · Cocoa 22 y superficie de red (T9-10)", () => {
  it("the three files are born without inline styles and obey the Cocoa rules; nothing but api-client touches the network", () => {
    for (const [name, src] of [
      ["DocumentCaptureScreen.tsx", screen],
      ["DocumentCaptureDrawer.tsx", drawer],
      ["DocumentLabelDialog.tsx", dialog]
    ] as const) {
      assertCocoaRules(name, src);
      assert.equal(count(src, /\bstyle=\{/g), 0, `${name}: style={ ×${count(src, /\bstyle=\{/g)} (must be 0)`);
    }
    for (const [name, src] of [
      ["documentsApi.ts", documentsApi],
      ["goodsReceiptsApi.ts", goodsReceiptsApi]
    ] as const) {
      assert.doesNotMatch(src, /\b(?:window\.|globalThis\.)?fetch\s*\(/, `${name}: no raw fetch`);
      assert.match(src, /from "\.\/api-client"/, `${name}: goes through api-client`);
    }
  });

  it("paints the legal copy «Copia digital no certificada» (fixed info callout of the screen, label and dialog)", () => {
    assert.match(screen, /<CocoaCallout tone="info" title="Copia digital no certificada: conserva el papel">/);
    assert.match(dialog, /export const DIGITAL_COPY_NOTICE = "Copia digital no certificada \(Orden EHA\/962\/2007 art\. 7\)/);
    assert.match(screen, /\{DIGITAL_COPY_NOTICE\}/);
    assert.match(dialog, /escapeHtml\(DIGITAL_COPY_NOTICE\)/);
  });

  it("the screen reads the tray with useApiData over documentsApi's path/query and writes only through documentsApi", () => {
    assert.match(screen, /import \{ documentListPath, documentListQuery, documentsApi \} from "\.\.\/\.\.\/services\/documentsApi";/);
    assert.match(screen, /useApiData<DocumentListPage>\(documentListPath\(propertyId\), \{ query: documentListQuery\(\{ limit: LIST_LIMIT \}\) \}\)/);
    for (const call of ["documentsApi.sendToOffice(", "documentsApi.downloadFile(", "documentsApi.split(", "documentsApi.dispatchBatches.create(", "documentsApi.dispatchBatches.sheet("]) {
      assert.ok(screen.includes(call), `screen uses ${call}`);
    }
    assert.match(drawer, /import \{ documentsApi \} from "\.\.\/\.\.\/services\/documentsApi";/);
    assert.match(drawer, /await documentsApi\.capture\(/);
    assert.doesNotMatch(screen, /from "\.\.\/\.\.\/services\/api-client"/, "the screen never imports api-client directly");
    assert.doesNotMatch(drawer, /from "\.\.\/\.\.\/services\/api-client"/, "the drawer never imports api-client directly");
  });

  it("gates every write on documents.capture with the real grants (canDo over useNavGate) and explains the missing permission in Spanish", () => {
    assert.match(screen, /import \{ useNavGate \} from "\.\.\/\.\.\/navigation\/useEnabledModules";/);
    assert.match(screen, /import \{ canDo, todayIso \} from "\.\.\/accounting\/accounting-ui";/);
    assert.match(screen, /const canCapture = canDo\(useNavGate\(\), "documents\.capture"\);/);
    assert.ok(count(screen, /disabled=\{!canCapture/g) >= 4, "Digitalizar · Enviar · Dividir · Cerrar valija are disabled without the grant");
    assert.match(screen, /const NO_PERMISSION = "Necesitas el permiso de captura de documentos";/);
    assert.match(drawer, /canCapture: boolean;/);
    assert.match(drawer, /Necesitas el permiso de captura de documentos \(«documents\.capture»\)/);
    assert.doesNotMatch(screen, /auth-storage|getUser\(|\?\.permissions/);
  });

  it("carries the §10 pieces: KPI strip, success callout with «Imprimir etiqueta», rowActions, batch bar «Cerrar valija (N)» and the dispatch-sheet dialog", () => {
    assert.match(screen, /<CocoaKpiStrip aria-label="Indicadores de digitalización del centro">/);
    for (const label of ["Capturados hoy", "Pendientes de enviar", "En valija", "Devueltos"]) assert.match(screen, new RegExp(`<CocoaKpi label="${label}"`), `KPI ${label}`);
    assert.match(screen, /const kpis = useMemo\(\(\) => captureKpis\(rows, todayIso\(\)\), \[rows\]\);/);
    assert.match(screen, /<CocoaCallout\s+tone="success"\s+role="status"/);
    assert.match(screen, /Imprimir etiqueta/);
    assert.match(screen, /<DocumentLabelDialog open=\{labelRecords !== null\}/);
    for (const action of ["Enviar a la oficina", "Dividir", "{ACTIONS.view}"]) assert.ok(screen.includes(action), `row action ${action}`);
    assert.match(screen, /selectable="multiple"/);
    assert.match(screen, /batchBar=\{\(selection\) => \(/);
    assert.match(screen, /\{`Cerrar valija \(\$\{selection\.count\}\)`\}/);
    assert.match(screen, /confirmLabel="Abrir hoja de remesa"/);
    assert.match(screen, /openBlob\(blob\)/);
    assert.match(screen, /parsePageRanges\(splitText, splitTarget\.pageCount\)/);
    assert.match(screen, /<CocoaState\s+kind="empty"/);
  });

  it("the drawer offers «Hacer foto» (capture=\"environment\"), drag and drop on a CocoaCard, thumbnails with a suggested kind, client compression and base64", () => {
    assert.match(drawer, /<CocoaFileInput accept=\{PHOTO_ACCEPT\} capture="environment" multiple/);
    assert.match(drawer, /<CocoaFileInput accept=\{CAPTURE_ACCEPT\} multiple/);
    assert.match(drawer, /label="Hacer foto"/);
    assert.match(drawer, /onDrop=\{\(event\) => \{/);
    assert.match(drawer, /<CocoaCard variant=\{dragging \? "elevated" : "bordered"\}/);
    assert.match(drawer, /import \{ compressImageFile, fileToBase64 \} from "\.\/capture-compress";/);
    assert.match(drawer, /const result = await compressImageFile\(file\);/);
    assert.match(drawer, /base64: await fileToBase64\(item\.file\)/);
    assert.match(drawer, /<CocoaSelect size="small" inline value=\{item\.kind\}/);
    assert.match(drawer, /kindHint: group\.kind/);
    assert.match(drawer, /source: IncomingDocumentSource = phone \? "mobile" : "upload"/);
    assert.match(drawer, /const pickerSize = phone \? "large" : "small";/);
    assert.match(drawer, /documentErrorMessage\(err, "No se pudo capturar el documento/);
    assert.match(drawer, /URL\.revokeObjectURL/);
    assert.match(drawer, /DOCUMENT_UPLOAD_MAX_FILES/);
  });

  it("the label dialog prints through window.print on its own document (popup), never a PDF", () => {
    assert.match(dialog, /window\.open\("", "_blank", "noopener,width=520,height=680"\)/);
    assert.match(dialog, /popup\.print\(\);/);
    assert.doesNotMatch(dialog, /from "[^"]*pdf-writer|application\/pdf|jsPDF|pdfmake/);
    assert.match(dialog, /popup\.document\.write\(labelSheetHtml\(records, propertyName\)\);/);
    assert.match(dialog, /confirmLabel=\{ACTIONS\.print\}/);
  });

  it("documentsApi types every route of §9 (34 routes incl. classify/extract, workflow, archive/kpis/settings, block/unblock/purge) and the blob downloads use apiRequestBlob", () => {
    assert.match(documentsApi, /import \{ apiRequest, apiRequestBlob, type BlobResponse \} from "\.\/api-client";/);
    const expected: Array<[RegExp, string]> = [
      [/export function capture\(body: DocumentUploadRequest/, "capture"],
      [/export function addFile\(documentId: string, body: DocumentAddFileRequest/, "addFile"],
      [/export function list\(filters: DocumentQueueFilters = \{\}/, "list"],
      [/export function get\(documentId: string/, "get"],
      [/export function downloadFile\(documentId: string, options: DocumentDownloadOptions = \{\}, propertyId = getActivePropertyId\(\)\): Promise<BlobResponse>/, "downloadFile"],
      [/export function pageImage\(documentId: string, pageNo: number/, "pageImage"],
      [/export function classify\(/, "classify"],
      [/export function extract\(/, "extract"],
      [/export function sendToOffice\(documentId: string/, "sendToOffice"],
      [/export function recapture\(documentId: string, body: DocumentAddFileRequest/, "recapture"],
      [/export function split\(documentId: string, body: DocumentSplitRequest/, "split"],
      [/export function merge\(documentId: string, body: DocumentMergeRequest/, "merge"],
      [/export const dispatchBatches = \{/, "dispatchBatches"],
      [/create\(body: DocumentDispatchBatchRequest/, "dispatchBatches.create"],
      [/receive\(batchId: string, body: DocumentDispatchReceiveRequest/, "dispatchBatches.receive"],
      [/sheet\(batchId: string, options: DocumentDownloadOptions = \{\}, propertyId = getActivePropertyId\(\)\): Promise<BlobResponse>/, "dispatchBatches.sheet"],
      [/export function assign\(documentId: string, body: DocumentAssignRequest/, "assign"],
      [/export function review\(documentId: string, body: DocumentReviewRequest/, "review"],
      [/export function approve\(documentId: string, body: DocumentApproveRequest/, "approve"],
      [/export function reject\(documentId: string, body: DocumentRejectRequest/, "reject"],
      [/export function archiveDocument\(documentId: string, body: DocumentArchiveRequest = \{\}/, "archiveDocument"],
      [/export const actions = \{/, "actions"],
      [/create\(documentId: string, body: DocumentActionRequest/, "actions.create"],
      [/update\(documentId: string, actionId: string, body: DocumentActionPatchRequest/, "actions.update"],
      [/export function queue\(filters: DocumentQueueFilters = \{\}, organizationId/, "queue"],
      [/export const archive = \{/, "archive"],
      [/search\(filters: DocumentArchiveFilters = \{\}, organizationId/, "archive.search"],
      [/export function kpis\(query: DocumentKpisQuery, organizationId/, "kpis"],
      [/export const settings = \{/, "settings"],
      [/patch\(body: DocumentSettingsPatchRequest, organizationId/, "settings.patch"],
      [/export function block\(documentId: string, body: DocumentAdminActionRequest, organizationId/, "block"],
      [/export function unblock\(documentId: string, body: DocumentAdminActionRequest, organizationId/, "unblock"],
      [/export function purge\(documentId: string, body: DocumentAdminActionRequest, organizationId/, "purge"]
    ];
    for (const [re, name] of expected) assert.match(documentsApi, re, `documentsApi.${name}`);
    // Route literals of §9 (paths built from the property / organisation base).
    for (const literal of ["/files", "/file`", "/pages/", "/image`", "/classify`", "/extract`", "/send-to-office`", "/recapture`", "/split`", "/merge`", "/dispatch-batches`", "/receive`", "/sheet`", "/assign`", "/review`", "/approve`", "/reject`", "/archive`", "/actions`", "/documents/queue`", "/documents/archive`", "/documents/kpis`", "/documents/settings`"]) {
      assert.ok(documentsApi.includes(literal), `route literal ${literal}`);
    }
    assert.match(documentsApi, /getActivePropertyId\(\)/);
    assert.match(documentsApi, /getActiveOrganizationId\(\)/);
    assert.match(documentsApi, /envelope: "1"/, "lists always ask for the envelope");
    assert.match(documentsApi, /export const documentsApi = \{/);
  });

  it("goodsReceiptsApi types create / list / get / dispute and the supplier-bill match", () => {
    assert.match(goodsReceiptsApi, /export function create\(body: GoodsReceiptRequest/);
    assert.match(goodsReceiptsApi, /export function list\(filters: GoodsReceiptFilters = \{\}/);
    assert.match(goodsReceiptsApi, /export function get\(receiptId: string/);
    assert.match(goodsReceiptsApi, /export function dispute\(receiptId: string, body: GoodsReceiptDisputeRequest/);
    assert.match(goodsReceiptsApi, /export function matchSupplierBill\(billId: string, body: SupplierBillMatchRequest = \{ auto: true \}/);
    assert.match(goodsReceiptsApi, /\/payables\/supplier-bills\/\$\{enc\(billId\)\}\/match`/);
    assert.match(goodsReceiptsApi, /\/goods-receipts`/);
    assert.match(goodsReceiptsApi, /envelope: "1"/);
  });

  it("is mounted as its own Operaciones item (/operaciones/digitalizar, core, 7 role tokens) and registered in App.tsx", () => {
    assert.match(app, /const DocumentCaptureScreen = lazyNamed\(\(\) => import\("\.\/screens\/documents\/DocumentCaptureScreen"\), "DocumentCaptureScreen"\);/);
    assert.match(app, /^\s+DocumentCaptureScreen,$/m);
    const operaciones = tree.categories.find((category) => category.label === "Operaciones");
    assert.ok(operaciones, "Operaciones category");
    const item = operaciones.items.find((entry) => entry.screenKey === "DocumentCaptureScreen");
    assert.ok(item, "DocumentCaptureScreen is an Operaciones item");
    assert.equal(item.label, "Digitalizar");
    assert.equal(item.url, "/operaciones/digitalizar");
    assert.deepEqual(item.modulesAny, [], "no module gate: every centre digitises");
    assert.deepEqual([...item.roles].sort(), ["admin", "administracion", "direccion", "fnb", "mantenimiento", "pisos", "recepcion"]);
    assert.deepEqual(item.tabs, []);
    assert.ok(operaciones.items.length <= 12, "≤ 12 items per category (nav-tree-contract)");
    assert.ok(item.label.length <= 28, "label ≤ 28 characters");
  });
});

describe("captureKpis · KPI strip of the capture screen (pure)", () => {
  const { captureKpis } = labelDialog;
  const row = (over: Partial<{ status: string; physicalStatus: string; capturedAt: string }>) => ({ status: "captured", physicalStatus: "at_centre", capturedAt: "2026-09-19T08:00:00.000Z", ...over }) as Parameters<typeof captureKpis>[0][number];

  it("counts captured today (Madrid day), pending to send, in transit and returned, independently", () => {
    const rows = [
      row({}),
      row({ capturedAt: "2026-09-18T22:30:00.000Z" }), // 00:30 del 19 en Madrid → cuenta como hoy
      row({ status: "sent_to_office", physicalStatus: "at_centre", capturedAt: "2026-09-18T10:00:00.000Z" }),
      row({ status: "sent_to_office", physicalStatus: "in_transit", capturedAt: "2026-09-17T10:00:00.000Z" }),
      row({ status: "in_review", physicalStatus: "in_transit", capturedAt: "2026-09-17T10:00:00.000Z" }),
      row({ status: "returned_to_centre", physicalStatus: "at_centre", capturedAt: "2026-09-10T10:00:00.000Z" }),
      row({ status: "approved", physicalStatus: "at_office", capturedAt: "2026-09-01T10:00:00.000Z" })
    ];
    assert.deepEqual(captureKpis(rows, "2026-09-19"), { capturedToday: 2, pendingToSend: 2, inTransit: 2, returned: 1 });
  });

  it("returns zeros for an empty tray and ignores rows of other days", () => {
    assert.deepEqual(captureKpis([], "2026-09-19"), { capturedToday: 0, pendingToSend: 0, inTransit: 0, returned: 0 });
    assert.deepEqual(captureKpis([row({ capturedAt: "2026-09-18T10:00:00.000Z", status: "archived", physicalStatus: "filed" })], "2026-09-19"), { capturedToday: 0, pendingToSend: 0, inTransit: 0, returned: 0 });
  });
});

describe("parsePageRanges · «Dividir» (pure)", () => {
  const { parsePageRanges } = labelDialog;

  it("accepts «1-2, 3-4», single pages and «;» separators, in the written order", () => {
    assert.deepEqual(parsePageRanges("1-2, 3-4", 4), { ranges: [[1, 2], [3, 4]], error: null });
    assert.deepEqual(parsePageRanges("3; 1 - 2", 3), { ranges: [[3, 3], [1, 2]], error: null });
    assert.deepEqual(parsePageRanges("1, 2", 5), { ranges: [[1, 1], [2, 2]], error: null });
  });

  it("refuses empty input, garbage, page 0, inverted, out of range, overlapping and the whole document as one piece", () => {
    assert.match(parsePageRanges("", 4).error ?? "", /al menos un rango/);
    assert.match(parsePageRanges("a-b", 4).error ?? "", /no es un rango válido/);
    assert.match(parsePageRanges("0-1", 4).error ?? "", /empiezan en 1/);
    assert.match(parsePageRanges("3-2", 4).error ?? "", /invertido/);
    assert.match(parsePageRanges("1-5", 4).error ?? "", /se sale/);
    assert.match(parsePageRanges("1-2, 2-3", 4).error ?? "", /se solapa/);
    assert.match(parsePageRanges("1-4", 4).error ?? "", /documento entero/);
    for (const text of ["", "a-b", "0-1", "3-2", "1-5", "1-2, 2-3", "1-4"]) assert.deepEqual(parsePageRanges(text, 4).ranges, [], `${text}: no ranges on error`);
  });
});

describe("labelSheetHtml · printable label (pure)", () => {
  const { escapeHtml, labelSheetHtml, DIGITAL_COPY_NOTICE } = labelDialog;

  it("paints one label per record with the registry number, centre, date, kind, pages and the legal notice, HTML-escaped", () => {
    const html = labelSheetHtml(
      [
        { registryNumber: "DOC-FAR-2026-000123", kind: "invoice", capturedAt: "2026-09-19T08:00:00.000Z", pageCount: 2 },
        { registryNumber: "DOC-FAR-2026-000124", kind: "delivery_note", capturedAt: "2026-09-19T08:05:00.000Z", pageCount: 1 }
      ],
      "Hotel <Demo> & Spa"
    );
    assert.equal(count(html, /<section class="label">/g), 2);
    assert.ok(html.includes("DOC-FAR-2026-000123") && html.includes("DOC-FAR-2026-000124"));
    assert.ok(html.includes("Hotel &lt;Demo&gt; &amp; Spa"), "property name is escaped");
    assert.ok(html.includes("<dt>Tipo</dt><dd>Factura</dd>") && html.includes("<dt>Tipo</dt><dd>Albarán</dd>"));
    assert.ok(html.includes("<dt>Páginas</dt><dd>2</dd>"));
    assert.ok(html.includes(escapeHtml(DIGITAL_COPY_NOTICE)));
    assert.match(html, /<html lang="es">/);
    assert.doesNotMatch(html, /#(?:[0-9a-fA-F]{3,8})\b|rgba?\(/, "no colour literals in the printed sheet");
  });

  it("escapeHtml neutralises the five HTML metacharacters and tolerates null", () => {
    assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
    assert.equal(escapeHtml(null), "");
    assert.equal(escapeHtml(7), "7");
  });
});

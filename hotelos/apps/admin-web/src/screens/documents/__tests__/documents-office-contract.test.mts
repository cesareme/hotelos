import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// Tanda T9 · lote T9-12 (diseño docs/design/DOCUMENTOS-DIGITALIZACION.md §10
// «Bandeja y revisión», «Cola de la oficina», «Archivo» y «Recepciones»): el
// front de la oficina. Las tres pantallas y el visor llegan a
// services/api-client.ts (import.meta.env) y no cargan bajo node --test, como
// documents-screen-contract (T9-10): se anclan sobre el código fuente. Lo que
// sí carga es DocumentReviewPane.tsx (Cocoa + SupplierBillForm + lib/format):
// sus helpers puros de la bandeja de la oficina (segmentos, «solo vencidos»,
// agrupación por centro, campos extraídos con confianza, pasos, borradores de
// gasto / recepción / tarea) se prueban de verdad más abajo.
//
// Anclas: reglas Cocoa 22 (cero `style={` en los cinco ficheros y en las dos
// pestañas, sin elementos crudos, sin literales de color, sin emoji), cero
// `fetch(` (todo por documentsApi / goodsReceiptsApi / payablesApi), el copy
// «IA no configurada (AI_PROVIDER=none)…» y «Quedas como registrador…», los
// permisos documents.review / documents.archive.read / documents.admin /
// procurement.manage por canDo(useNavGate(), …) con los botones
// deshabilitados sin la clave, las piezas del diseño (CocoaSplitView con
// sidebar · content · inspector, segmentos, FinanceScopeSelector, cola agrupada
// por centro, «cortar aquí», pie de decisión, archivo con CocoaDrawer y
// acciones admin, recepciones con alta y disputa) y el montaje en el árbol
// (dos pestañas nuevas de Proveedores y gastos, una de Compras e inventario).

const source = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

const screen = source("../IncomingDocumentsScreen.tsx");
const pane = source("../DocumentReviewPane.tsx");
const viewer = source("../DocumentViewer.tsx");
const archive = source("../DocumentArchiveScreen.tsx");
const receipts = source("../GoodsReceiptsScreen.tsx");
const proveedoresTabs = source("../../tabs/finanzas/ProveedoresTabs.tsx");
const comprasTabs = source("../../tabs/operaciones/ComprasInventarioTabs.tsx");
const app = source("../../../App.tsx");
const tree = JSON.parse(source("../../../navigation/nav-tree.generated.json")) as {
  categories: Array<{ label: string; items: Array<{ screenKey: string; label: string; url: string; roles: string[]; modulesAny: string[]; tabs: Array<{ screenKey: string; label: string; url: string; roles: string[]; modulesAny: string[] }> }> }>;
};

const helpers = await import("../DocumentReviewPane.tsx");

const FILES = [
  ["IncomingDocumentsScreen.tsx", screen],
  ["DocumentReviewPane.tsx", pane],
  ["DocumentViewer.tsx", viewer],
  ["DocumentArchiveScreen.tsx", archive],
  ["GoodsReceiptsScreen.tsx", receipts]
] as const;

/** Rules 1-5, 9-11 of tests/cocoa-22-contract.test.mjs, applied to one file. */
function assertCocoaRules(name: string, src: string) {
  assert.doesNotMatch(src, /(?<!-)\bbo-[a-z0-9-]+/, `${name}: no .bo-* classes`);
  assert.doesNotMatch(src, /<button\b/, `${name}: no raw <button>`);
  assert.doesNotMatch(src, /<table\b/, `${name}: no raw <table>`);
  assert.doesNotMatch(src, /<(?:input|select|textarea)\b/, `${name}: no raw form controls`);
  assert.doesNotMatch(src, /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\(/, `${name}: no colour literals`);
  assert.doesNotMatch(src, /\p{Extended_Pictographic}/u, `${name}: no emoji`);
  assert.doesNotMatch(src, /money\([^)]*"EUR"\)/, `${name}: the currency never travels as a literal`);
  assert.doesNotMatch(src, /\b(?:window\.|globalThis\.)?fetch\s*\(/, `${name}: no raw fetch`);
  assert.doesNotMatch(src, /Intl\.(?:NumberFormat|DateTimeFormat)|toLocale[A-Za-z]*String\(/, `${name}: formatting only through lib/format`);
  assert.doesNotMatch(src, /from "\.\.\/\.\.\/services\/api-client"/, `${name}: never imports api-client directly`);
}

describe("Oficina de documentos · Cocoa 22 y superficie de red (T9-12)", () => {
  it("the five files are born without inline styles, obey the Cocoa rules and never touch the network outside the typed clients", () => {
    for (const [name, src] of FILES) {
      assertCocoaRules(name, src);
      assert.equal(count(src, /\bstyle=\{/g), 0, `${name}: style={ ×${count(src, /\bstyle=\{/g)} (must be 0)`);
    }
    for (const [name, src] of [
      ["ProveedoresTabs.tsx", proveedoresTabs],
      ["ComprasInventarioTabs.tsx", comprasTabs]
    ] as const) {
      assert.equal(count(src, /\bstyle=\{/g), 0, `${name}: no inline styles`);
      assert.doesNotMatch(src, /\bfetch\s*\(/, `${name}: no raw fetch`);
    }
    assert.match(screen, /from "\.\.\/\.\.\/services\/documentsApi";/);
    assert.match(viewer, /from "\.\.\/\.\.\/services\/documentsApi";/);
    assert.match(archive, /from "\.\.\/\.\.\/services\/documentsApi";/);
    assert.match(receipts, /from "\.\.\/\.\.\/services\/goodsReceiptsApi";/);
    assert.doesNotMatch(pane, /services\/(?:documentsApi|goodsReceiptsApi|payablesApi|api-client)"/, "the pane is presentational: no API client at runtime");
  });

  it("speaks Spanish: «IA no configurada (AI_PROVIDER=none)» warning and the SoD notice after creating the bill", () => {
    assert.equal(helpers.AI_NOT_CONFIGURED_COPY, "IA no configurada (AI_PROVIDER=none): campos por extractor de texto o manual");
    assert.match(pane, /<CocoaCallout tone="warning" title=\{AI_NOT_CONFIGURED_COPY\}>/);
    assert.match(pane, /nunca se inventan/);
    assert.equal(helpers.SOD_NOTICE, "Quedas como registrador: otra persona aprobará y pagará.");
    assert.match(screen, /result\.sodNote \? SOD_NOTICE : null/);
  });

  it("gates every write with canDo(useNavGate(), clave) and disables the buttons with the reason when the key is missing", () => {
    assert.match(screen, /const canReview = canDo\(gate, "documents\.review"\);/);
    assert.match(screen, /const canCapture = canDo\(gate, "documents\.capture"\);/);
    assert.match(archive, /const canRead = canDo\(gate, "documents\.archive\.read"\);/);
    assert.match(archive, /const isAdmin = canDo\(gate, "documents\.admin"\);/);
    assert.match(receipts, /const canManage = canDo\(useNavGate\(\), "procurement\.manage"\);/);
    for (const [name, src] of FILES) assert.doesNotMatch(src, /auth-storage|getUser\(|\?\.permissions/, `${name}: never reads the session permissions directly`);
    assert.match(pane, /canReview: boolean;/);
    assert.match(pane, /const editable = canReview && !busy;/);
    assert.ok(count(pane, /disabled=\{!editable/g) >= 20, "every control of the pane follows the grant");
    assert.match(pane, /export const NO_REVIEW_PERMISSION = "Necesitas el permiso de revisión de documentos";/);
    assert.ok(count(archive, /disabled=\{!isAdmin/g) >= 3, "block · unblock · purge are disabled without documents.admin");
    assert.ok(count(receipts, /disabled=\{!canManage/g) >= 3, "new receipt · register · dispute are disabled without procurement.manage");
    assert.match(archive, /tone="destructive"/);
    assert.match(receipts, /tone="destructive"/);
  });

  it("mounts the §10 pieces: CocoaSplitView (sidebar · content · inspector), segments, FinanceScopeSelector, queue grouped by centre, viewer with «cortar aquí», decision bar", () => {
    assert.match(screen, /<CocoaSplitView sidebar=\{sidebar\} content=\{content\} inspector=\{inspector\}/);
    assert.match(screen, /<CocoaSegmentedControl value=\{segment\}/);
    assert.match(screen, /<FinanceScopeSelector scope=\{finance\}/);
    assert.match(screen, /useFinanceScope\(financeScopePolicy\("IncomingDocumentsScreen"\)\)/);
    assert.match(screen, /entityScope \? documentQueuePath\(\) : documentListPath\(finance\.propertyId\)/);
    assert.match(screen, /groupQueueByCentre\(rows, centres\)/);
    assert.match(screen, /<CocoaSection key=\{group\.propertyId\} title=\{centreGroupTitle\(group\)\}/);
    assert.match(screen, /label="Solo vencidos"/);
    assert.match(screen, /filterOverdue\(allRows\)/);
    assert.match(screen, /aria-label="Revisor asignado"/);
    assert.match(screen, /documentsApi\.assign\(/);
    assert.match(screen, /readQueryParam\("id"\) \?\? readHashParam\(\)/);
    assert.match(screen, /const stacked = tier === "phone" \|\| tier === "tablet";/, "below 900 px the split stacks and the review stays reachable");
    assert.match(screen, /\{`\$\{ACTIONS\.back\} a la bandeja`\}/);
    for (const call of ["documentsApi.review(", "documentsApi.approve(", "documentsApi.reject(", "documentsApi.split(", "documentsApi.get(", "documentsApi.kpis("]) assert.ok(screen.includes(call), `screen uses ${call}`);
    assert.match(viewer, /documentsApi\s*\.downloadFile\(doc\.id, \{ inline: true \}, propertyId\)/);
    assert.match(viewer, /URL\.createObjectURL\(response\.blob\)/);
    assert.match(viewer, /<iframe key=\{`\$\{activePage\}-\$\{zoom\}`\}/);
    assert.match(viewer, /<img src=\{file\.url\}/);
    assert.match(viewer, /Cortar aquí/);
    assert.match(viewer, /<CocoaSegmentedControl value=\{zoom\}/);
    assert.match(pane, /<SupplierBillForm value=\{billForm\} onChange=\{setBillForm\}[^>]*mode="review"/);
    assert.match(pane, /billFormFromRequest\(request\)/);
    assert.match(pane, /<CocoaActionBar/);
    assert.match(pane, /aria-current=\{steps\[step\.key\] === "current" \? "step" : undefined\}/);
    assert.match(pane, /Dar de alta desde Sage/);
    assert.match(pane, /Abrir el original/);
    assert.match(pane, /label: "Devolver al centro"/);
    assert.match(pane, /confidenceTone\(row\.confidence\)/);
    assert.match(pane, /onFocus=\{\(\) => onFocusPage\(row\.page\)\}/);
    assert.match(pane, /label="Pagado con" required/);
  });

  it("the archive searches the extracted text with the §7.4 filters, paints the legal metadata in a CocoaDrawer and keeps block / unblock / purge for documents.admin", () => {
    assert.match(archive, /<CocoaSearchInput value=\{filters\.q\}/);
    assert.match(archive, /documentArchiveQuery\(\{/);
    for (const key of ["kind:", "supplierId:", "propertyId: finance.propertyId", "from:", "to:", "amountMin:", "amountMax:", "registryNumber:", "includeBlocked:"]) assert.ok(archive.includes(key), `archive filter ${key}`);
    assert.match(archive, /useApiData<DocumentListPage>\(canRead && !finance\.loading \? documentArchivePath\(\) : null, \{ query \}\)/);
    assert.ok(count(archive, /showFrom: "(?:tablet|laptop|desktop)"/g) >= 4, "secondary columns use showFrom");
    assert.match(archive, /<CocoaDrawer open=\{selectedId !== null\}/);
    assert.match(archive, /<DocumentViewer document=\{doc\}/);
    for (const label of ["Huella SHA-256", "Formato original", "Retención hasta", "Retención ampliada", "Bloqueo legal", "Bloqueado por retención", "Purgado"]) assert.ok(archive.includes(`["${label}"`), `metadata ${label}`);
    for (const call of ["documentsApi.block(", "documentsApi.unblock(", "documentsApi.purge(", "documentsApi.get("]) assert.ok(archive.includes(call), `archive uses ${call}`);
    assert.match(archive, /confirmDisabled=\{reason\.trim\(\)\.length < 3\}/);
  });

  it("the receipts tab lists, creates manually (drawer with lines, item and location optional), disputes and links the matched bill", () => {
    assert.match(receipts, /useApiData<GoodsReceiptListPage>\(goodsReceiptListPath\(propertyId\), \{ query: goodsReceiptListQuery\(/);
    for (const call of ["goodsReceiptsApi.create(", "goodsReceiptsApi.get(", "goodsReceiptsApi.dispute("]) assert.ok(receipts.includes(call), `receipts uses ${call}`);
    assert.match(receipts, /<GoodsReceiptForm value=\{draft\} onChange=\{setDraft\}/);
    assert.match(receipts, /inventory=\{inventory\.data \?\? undefined\}/);
    assert.match(receipts, /Ver la factura cotejada/);
    assert.match(receipts, /navigateTo\("SupplierBillsScreen", billId\)/);
    assert.match(receipts, /navigateTo\("IncomingDocumentsScreen", receipt\.incomingDocumentId/);
    assert.match(receipts, /title="Nueva recepción"/);
    assert.match(receipts, /confirmLabel="Disputar"/);
    assert.match(pane, /export function GoodsReceiptForm\(/);
    assert.match(pane, /label="Artículo de inventario"/);
    assert.match(pane, /label="Ubicación de almacén"/);
  });

  it("hangs from the tree: Documentos and Archivo as tabs of Proveedores y gastos, Recepciones as a tab of Compras e inventario, all registered in App.tsx through their containers", () => {
    assert.match(proveedoresTabs, /IncomingDocumentsScreen: \(\) => import\("\.\.\/\.\.\/documents\/IncomingDocumentsScreen"\)/);
    assert.match(proveedoresTabs, /DocumentArchiveScreen: \(\) => import\("\.\.\/\.\.\/documents\/DocumentArchiveScreen"\)/);
    assert.match(comprasTabs, /GoodsReceiptsScreen: \(\) => import\("\.\.\/\.\.\/documents\/GoodsReceiptsScreen"\)/);
    assert.match(app, /^\s+IncomingDocumentsScreen: ProveedoresTabs,$/m);
    assert.match(app, /^\s+DocumentArchiveScreen: ProveedoresTabs,$/m);
    assert.match(app, /^\s+GoodsReceiptsScreen: ComprasInventarioTabs,$/m);
    const finanzas = tree.categories.find((category) => category.label === "Finanzas");
    const proveedores = finanzas?.items.find((item) => item.screenKey === "SupplierBillsScreen");
    assert.ok(proveedores, "Proveedores y gastos item");
    const documentos = proveedores.tabs.find((tab) => tab.screenKey === "IncomingDocumentsScreen");
    const archivo = proveedores.tabs.find((tab) => tab.screenKey === "DocumentArchiveScreen");
    assert.ok(documentos && archivo, "both tabs exist");
    assert.equal(documentos.url, "/finanzas/proveedores/documentos");
    assert.equal(documentos.label, "Documentos");
    assert.equal(archivo.url, "/finanzas/proveedores/archivo");
    assert.equal(archivo.label, "Archivo");
    for (const tab of [documentos, archivo]) {
      assert.deepEqual([...tab.roles].sort(), ["admin", "administracion", "auditoria", "direccion", "finanzas"]);
      assert.deepEqual(tab.modulesAny, []);
      assert.ok(tab.label.length <= 28);
    }
    const operaciones = tree.categories.find((category) => category.label === "Operaciones");
    const compras = operaciones?.items.find((item) => item.screenKey === "ProcurementDashboard");
    assert.ok(compras, "Compras e inventario item");
    const recepciones = compras.tabs.find((tab) => tab.screenKey === "GoodsReceiptsScreen");
    assert.ok(recepciones, "Recepciones tab");
    assert.equal(recepciones.url, "/operaciones/compras/recepciones");
    assert.equal(recepciones.label, "Recepciones");
    assert.deepEqual(recepciones.modulesAny, ["procurement_inventory"]);
    assert.deepEqual([...recepciones.roles].sort(), ["admin", "administracion", "auditoria", "direccion", "finanzas", "fnb"]);
  });
});

describe("bandeja de la oficina · helpers puros de DocumentReviewPane", () => {
  const { QUEUE_SEGMENTS, segmentStatuses, isQueueSegment, isOverdue, filterOverdue, groupQueueByCentre, centreGroupTitle } = helpers;
  const NOW = new Date("2026-09-20T10:00:00.000Z");
  const row = (over: Partial<{ id: string; propertyId: string; slaBreached: boolean; dueAt: string | null }>) => ({ id: "d1", propertyId: "prop_a", slaBreached: false, dueAt: null, ...over });

  it("the five segments cover the eight statuses of §6.1 exactly once (captured stays at the centre)", () => {
    assert.deepEqual(
      QUEUE_SEGMENTS.map((spec) => spec.label),
      ["Pendientes", "En revisión", "Aprobados", "Devueltos", "Archivo"]
    );
    const covered = QUEUE_SEGMENTS.flatMap((spec) => spec.statuses);
    assert.equal(new Set(covered).size, covered.length, "no status in two segments");
    assert.deepEqual([...covered].sort(), ["approved", "archived", "in_review", "posted", "rejected", "returned_to_centre", "sent_to_office"]);
    assert.deepEqual(segmentStatuses("approved"), ["approved", "posted"]);
    assert.deepEqual(segmentStatuses("nope"), ["sent_to_office"], "unknown segment falls back to Pendientes");
    assert.equal(isQueueSegment("archive"), true);
    assert.equal(isQueueSegment("captured"), false);
  });

  it("«solo vencidos» keeps the SLA breaches and the past due dates, nothing else", () => {
    assert.equal(isOverdue(row({ slaBreached: true }), NOW), true);
    assert.equal(isOverdue(row({ dueAt: "2026-09-19T00:00:00.000Z" }), NOW), true);
    assert.equal(isOverdue(row({ dueAt: "2026-09-22T00:00:00.000Z" }), NOW), false);
    assert.equal(isOverdue(row({}), NOW), false);
    assert.equal(isOverdue(row({ dueAt: "not-a-date" }), NOW), false);
    const rows = [row({ id: "a", slaBreached: true }), row({ id: "b" }), row({ id: "c", dueAt: "2026-09-01T00:00:00.000Z" }), row({ id: "d", dueAt: "2026-12-01T00:00:00.000Z" })];
    assert.deepEqual(
      filterOverdue(rows, NOW).map((entry) => entry.id),
      ["a", "c"]
    );
    assert.deepEqual(filterOverdue([], NOW), []);
  });

  it("groups the organisation queue by centre with Property.code from the structure, code order first, unknown centres by id", () => {
    const centres = [
      { id: "prop_b", code: "ATS", name: "Hotel Demo Tenerife Sur" },
      { id: "prop_a", code: "AMC", name: "Hotel Demo Madrid Centro" }
    ];
    const rows = [row({ id: "1", propertyId: "prop_b" }), row({ id: "2", propertyId: "prop_a" }), row({ id: "3", propertyId: "prop_b" }), row({ id: "4", propertyId: "prop_zzz" })];
    const groups = groupQueueByCentre(rows, centres);
    assert.deepEqual(
      groups.map((group) => [group.propertyId, group.propertyCode, group.rows.map((entry) => entry.id)]),
      [
        ["prop_a", "AMC", ["2"]],
        ["prop_b", "ATS", ["1", "3"]],
        ["prop_zzz", null, ["4"]]
      ]
    );
    assert.equal(centreGroupTitle(groups[0]), "AMC · Hotel Demo Madrid Centro");
    assert.equal(centreGroupTitle(groups[2]), "prop_zzz");
    assert.equal(centreGroupTitle({ propertyId: "x", propertyCode: null, propertyName: "Solo nombre" }), "Solo nombre");
    assert.deepEqual(groupQueueByCentre([], centres), []);
  });
});

describe("revisión · campos extraídos, pasos, acciones y borradores (puros)", () => {
  const { extractedFieldRows, unwrapField, fieldDisplay, reviewStepStates, aiConfiguredFrom, actionsForKind, failedChecks, expenseDraftFrom, validateExpenseDraft, expenseDraftToRequest, receiptDraftFrom, validateReceiptDraft, receiptDraftToRequest, taskDraftFrom, taskDraftToRequest, rejectReasonOptions, APPROVE_LABELS } = helpers;

  const extraction = {
    id: "x1",
    documentId: "d1",
    runNo: 1,
    source: "text_rules",
    provider: null,
    modelVersion: null,
    schemaVersion: "invoice.v1",
    fields: { supplierName: "Lavandería Cantábrica Demo SL", supplierTaxId: { value: "B76543210", confidence: 0.91, page: 1 }, total: "1060.00", lines: [{ description: "Servicio" }], requiresResponse: false, deliveryNoteRefs: ["ALB-1", "ALB-2"] },
    confidence: { supplierName: 0.5, total: 0.99 },
    warnings: [],
    tokensInput: null,
    tokensOutput: null,
    costEur: null,
    durationMs: 12,
    status: "done",
    error: null,
    createdAt: "2026-09-20T09:00:00.000Z"
  } as Parameters<typeof extractedFieldRows>[0] & object;

  it("unwraps `{ value, confidence, page }` boxes, keeps plain values, and paints lists, booleans and objects honestly", () => {
    assert.deepEqual(unwrapField({ value: "B76543210", confidence: "0.91", page: 2 }), { value: "B76543210", confidence: 0.91, page: 2 });
    assert.deepEqual(unwrapField("plain"), { value: "plain", confidence: null, page: null });
    assert.equal(fieldDisplay(["ALB-1", "ALB-2"]), "ALB-1 · ALB-2");
    assert.equal(fieldDisplay(true), "Sí");
    assert.equal(fieldDisplay(null), "");
    assert.equal(fieldDisplay([{ a: 1 }, { b: 2 }]), "2 elementos");
  });

  it("lists the scalar fields with the confidence of the box or of confidenceJson, hides lines/taxBreakdown and marks the reviewed ones as manual", () => {
    const rows = extractedFieldRows(extraction, { total: "1061.00", note: "corregido" });
    const byKey = Object.fromEntries(rows.map((entry) => [entry.key, entry]));
    assert.ok(!("lines" in byKey), "lines live in the form");
    assert.deepEqual(byKey.supplierTaxId, { key: "supplierTaxId", label: "NIF del proveedor", value: "B76543210", confidence: 0.91, page: 1, reviewed: false });
    assert.equal(byKey.supplierName.confidence, 0.5);
    assert.equal(byKey.supplierName.label, "Proveedor");
    assert.deepEqual(byKey.total, { key: "total", label: "Total", value: "1061.00", confidence: null, page: null, reviewed: true });
    assert.equal(byKey.deliveryNoteRefs.value, "ALB-1 · ALB-2");
    assert.equal(byKey.requiresResponse.value, "No");
    assert.deepEqual(byKey.note, { key: "note", label: "note", value: "corregido", confidence: null, page: null, reviewed: true });
    assert.deepEqual(extractedFieldRows(null, null), []);
  });

  it("derives the four pipeline steps from the detail and flags a failed extraction", () => {
    const base = { kind: "invoice", classificationSource: "rules", extractionStatus: "done", proposedAction: "create_supplier_bill", checks: { nif: { status: "ok", message: "" } }, extraction } as unknown as Parameters<typeof reviewStepStates>[0];
    assert.deepEqual(reviewStepStates(base), { classified: "done", extracted: "done", validated: "done", proposed: "done" });
    assert.deepEqual(reviewStepStates({ ...base, kind: "unknown", classificationSource: null, extractionStatus: "pending", extraction: null, checks: null, proposedAction: null }), { classified: "current", extracted: "pending", validated: "pending", proposed: "pending" });
    assert.deepEqual(reviewStepStates({ ...base, extractionStatus: "failed", extraction: null, checks: null, proposedAction: null }), { classified: "done", extracted: "failed", validated: "pending", proposed: "pending" });
    assert.equal(aiConfiguredFrom(extraction), false, "text_rules is not a provider");
    assert.equal(aiConfiguredFrom({ ...extraction, source: "ai", provider: "anthropic" }), true);
    assert.equal(aiConfiguredFrom(null), false);
  });

  it("offers the actions that fit the kind, the server proposal first, and the primary labels of §10", () => {
    assert.deepEqual(actionsForKind("invoice", "create_supplier_bill"), ["create_supplier_bill", "create_expense", "archive"]);
    assert.deepEqual(actionsForKind("invoice", "archive"), ["archive", "create_supplier_bill", "create_expense"]);
    assert.deepEqual(actionsForKind("delivery_note", null), ["create_goods_receipt", "archive"]);
    assert.deepEqual(actionsForKind("letter", "create_task"), ["create_task", "archive"]);
    assert.deepEqual(actionsForKind("receipt", "create_task"), ["create_task", "create_expense", "create_supplier_bill", "archive"], "an unexpected proposal is still offered first");
    assert.equal(actionsForKind("unknown", null).length, 5);
    assert.deepEqual(APPROVE_LABELS, { create_supplier_bill: "Aprobar y crear factura", create_expense: "Crear gasto", create_goods_receipt: "Crear recepción", create_task: "Crear tarea", archive: "Archivar" });
    assert.deepEqual(failedChecks({ nif: { status: "fail", message: "" }, supplier: { status: "warn", message: "" }, totals: { status: "ok", message: "" }, vat: { status: "fail", message: "" }, duplicate: { status: "ok", message: "" }, retention: { status: "ok", message: "" }, match: { status: "ok", message: "" } }), ["nif", "vat"]);
    assert.deepEqual(failedChecks(null), []);
  });

  it("expense draft: paidWith is mandatory (the proposal leaves it null), quotas optional, wire body with two decimals", () => {
    const draft = expenseDraftFrom({ date: "2026-09-18", supplierName: "Bar Demo", supplierNif: "B12345674", concept: "Café", accountCode: "629", base: "10.00", taxRate: 10, paidWith: null }, "2026-09-20");
    assert.equal(draft.paidWith, "");
    assert.equal(draft.taxRate, "10");
    assert.equal(draft.base, "10");
    assert.equal(draft.vatDeductible, true);
    assert.deepEqual(validateExpenseDraft(draft), { paidWith: "Indica cómo se pagó (efectivo, tarjeta o banco)." });
    const request = expenseDraftToRequest({ ...draft, paidWith: "card", base: "10,50", quota: "1,05" });
    assert.deepEqual(request, { date: "2026-09-18", supplierName: "Bar Demo", supplierNif: "B12345674", concept: "Café", accountCode: "629", base: "10.50", taxRate: "10", quota: "1.05", paidWith: "card", vatDeductible: true });
    const empty = expenseDraftFrom(null, "2026-09-20");
    assert.equal(empty.date, "2026-09-20");
    assert.deepEqual(Object.keys(validateExpenseDraft(empty)).sort(), ["accountCode", "base", "concept", "paidWith", "supplierName"]);
    assert.equal(validateExpenseDraft({ ...draft, paidWith: "cash", accountCode: "4300" }).accountCode, "Subcuenta del grupo 6.");
  });

  it("receipt draft: from the proposal with fresh line keys, validation per line, wire decimals with a dot", () => {
    const draft = receiptDraftFrom({ supplierId: null, supplierName: "Distribuciones Hosteleras Demo SA", supplierTaxId: "a12345674", deliveryNoteNumber: "ALB-77", deliveryDate: "2026-09-19", lines: [{ description: "Agua", quantityReceived: "12.000", unit: "ud", unitPrice: "0.4500" }] }, "2026-09-20");
    assert.equal(draft.lines.length, 1);
    assert.equal(draft.lines[0].quantityReceived, "12");
    assert.equal(draft.lines[0].unitPrice, "0,45");
    assert.deepEqual(validateReceiptDraft(draft), {});
    const request = receiptDraftToRequest(draft);
    assert.deepEqual(request, { supplierId: null, supplierName: "Distribuciones Hosteleras Demo SA", supplierTaxId: "A12345674", deliveryNoteNumber: "ALB-77", deliveryDate: "2026-09-19", lines: [{ description: "Agua", quantityReceived: "12", unit: "ud", unitPrice: "0.45" }] });
    const empty = receiptDraftFrom(null, "2026-09-20");
    assert.equal(empty.lines.length, 1, "one blank line to start");
    const errors = validateReceiptDraft({ ...empty, lines: [{ ...empty.lines[0], quantityReceived: "0" }] });
    assert.deepEqual(Object.keys(errors).sort(), ["deliveryNoteNumber", "lines", "supplierName"]);
    assert.match(errors.lines?.[empty.lines[0].key]?.quantityReceived ?? "", /mayor que cero/);
    const withSupplier = receiptDraftToRequest({ ...draft, supplierId: "sup_1", stockLocationId: "loc_1", note: "muelle", lines: [{ ...draft.lines[0], inventoryItemId: "item_1", base: "5,40", taxRate: "10" }] });
    assert.equal(withSupplier.supplierId, "sup_1");
    assert.equal("supplierName" in withSupplier, false);
    assert.deepEqual(withSupplier.lines[0], { description: "Agua", quantityReceived: "12", unit: "ud", unitPrice: "0.45", base: "5.40", taxRate: "10", inventoryItemId: "item_1" });
    assert.equal(withSupplier.stockLocationId, "loc_1");
    assert.equal(withSupplier.note, "muelle");
  });

  it("task draft: ISO dueAt becomes a day and back; reject reasons split between «Devolver al centro» and «Rechazar»", () => {
    const draft = taskDraftFrom({ kind: "pay", title: "Sanción de tráfico", dueAt: "2026-10-05T00:00:00.000Z" }, "Carta");
    assert.deepEqual(draft, { kind: "pay", title: "Sanción de tráfico", description: "", dueOn: "2026-10-05" });
    assert.deepEqual(taskDraftToRequest({ ...draft, description: " Pagar antes del plazo " }), { kind: "pay", title: "Sanción de tráfico", description: "Pagar antes del plazo", dueAt: "2026-10-05T00:00:00.000Z" });
    assert.deepEqual(taskDraftToRequest(taskDraftFrom(null, "Carta")), { kind: "respond", title: "Carta", dueAt: null });
    assert.deepEqual(
      rejectReasonOptions(true).map((option) => option.value),
      ["illegible", "missing_pages", "other"]
    );
    assert.deepEqual(
      rejectReasonOptions(false).map((option) => option.value),
      ["duplicate", "not_ours", "other"]
    );
  });
});

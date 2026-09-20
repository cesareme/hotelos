// Contrato · Documentos y digitalización con IA (Tanda T9 · L0, tipos wire y permisos).
//
// Sin TypeScript ni base de datos (mismos parsers por expresión regular que
// tests/rbac-sod-contract.test.mjs): lee packages/shared/src/{permissions, types,
// rbac-types, index, documents-types, payables-types}.ts y fija lo que
// docs/design/DOCUMENTOS-DIGITALIZACION.md §6.2 y §8 «Tipos wire» exigen:
//   - las 4 claves documents.* existen en PERMISSIONS y en PermissionKey, son de
//     ámbito organización (nunca admin./platform.) y cada una vive en las
//     plantillas del diseño (matriz exacta, admin las cuatro);
//   - ROLE_TEMPLATE_VERSION === 4 y la versión es ADITIVA: cada plantilla conserva
//     exactamente las claves de la v3 (instantánea de tamaños) y solo suma
//     documents.*; ROLE_TEMPLATE_REVOCATIONS no menciona documents.*;
//   - APPROVAL_KINDS sigue siendo la lista de 10 de la Tanda 8a (sin clase nueva);
//   - documents-types.ts exporta los catálogos, los DTOs y DOCUMENT_ERROR_CODES,
//     importa MoneyString de payables-types (nunca float en importes) y está
//     reexportado desde index.ts;
//   - payables-types.ts lleva los campos nuevos de SupplierBillRequest /
//     SupplierBillLineRequest / SupplierBillDto / SupplierBillLineDto y los
//     catálogos SUPPLIER_BILL_SOURCES / SUPPLIER_BILL_MATCH_STATUSES, con
//     SUPPLIER_BILL_STATUSES intacto.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8");
const permissionsSource = read("../packages/shared/src/permissions.ts");
const typesSource = read("../packages/shared/src/types.ts");
const rbacTypesSource = read("../packages/shared/src/rbac-types.ts");
const indexSource = read("../packages/shared/src/index.ts");
const documentsSource = read("../packages/shared/src/documents-types.ts");
const payablesSource = read("../packages/shared/src/payables-types.ts");

// ---------------------------------------------------------------------------
// Parsers (sin TS)
// ---------------------------------------------------------------------------

function stripLineComments(source) {
  return source.replace(/^\s*\/\/.*$/gm, "").replace(/\/\/[^"\n]*$/gm, "");
}

function parsePermissionCatalog(source) {
  const block = source.match(/export const PERMISSIONS[^{]*\{(.*?)\n\};/s);
  assert.ok(block, "PERMISSIONS block not found");
  return [...block[1].matchAll(/^\s*"([a-z_]+(?:\.[a-z_]+)+)":\s*"/gm)].map((m) => m[1]);
}

/** `export const NAME: Record<RoleKey, PermissionKey[]> = { key: [ "a", "b" ], … };` → { key: Set } */
function parseArrayRecord(source, name, orgKeys) {
  const block = source.match(new RegExp(`export const ${name}[^{]*\\{(.*?)\\n\\};`, "s"));
  assert.ok(block, `${name} block not found`);
  const body = stripLineComments(block[1]);
  const record = {};
  for (const m of body.matchAll(/^\s*(\w+):\s*\[(.*?)\]/gms)) {
    record[m[1]] = m[2].includes("ORG_PERMISSION_KEYS") ? new Set(orgKeys) : new Set([...m[2].matchAll(/"([^"]+)"/g)].map((k) => k[1]));
  }
  return record;
}

/** `export const NAME = [ "a", "b" ] as const;` → ["a", "b"] */
function parseConstArray(source, name) {
  const block = source.match(new RegExp(`export const ${name}\\b[^=]*=\\s*\\[([^\\]]*)\\]`, "s"));
  assert.ok(block, `${name} not found`);
  return [...stripLineComments(block[1]).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** `| "a"\n | "b"` members of a string-literal union type (ends at the first `"…";` line). */
function parseUnion(source, name) {
  const start = source.indexOf(`export type ${name} =`);
  assert.ok(start >= 0, `type ${name} not found`);
  const members = [];
  for (const line of source.slice(start).split("\n").slice(1)) {
    const code = line.replace(/\/\/.*$/, "");
    const m = code.match(/^\s*\|\s*"([^"]+)"\s*;?\s*$/);
    if (m) members.push(m[1]);
    if (/";\s*$/.test(code)) break;
  }
  return members;
}

/** Body of `export type NAME = … {` … `\n};` (object types and intersections `A & { … }`). */
function typeBlock(source, name) {
  const block = source.match(new RegExp(`export type ${name} = [^{]*\\{([\\s\\S]*?)\\n\\};`));
  assert.ok(block, `type ${name} not found`);
  return block[1];
}

const catalog = parsePermissionCatalog(permissionsSource);
const catalogSet = new Set(catalog);
const orgKeys = catalog.filter((key) => !key.startsWith("admin.") && !key.startsWith("platform."));
const templates = parseArrayRecord(permissionsSource, "ROLE_PERMISSION_MAP", orgKeys);
const revocations = parseArrayRecord(permissionsSource, "ROLE_TEMPLATE_REVOCATIONS", orgKeys);
const permissionKeyUnion = parseUnion(typesSource, "PermissionKey");

const DOCUMENT_KEYS = ["documents.capture", "documents.review", "documents.archive.read", "documents.admin"];
/** Tanda RRHH (v5, posterior a T9): claves hr.* que tampoco existían en v3; se descuentan del tamaño v3 igual que documents.*. */
const HR_KEYS_V5 = ["hr.employee.read", "hr.employee.manage", "hr.config.manage", "hr.standards.manage", "hr.staffing.approve"];
/** v5 también suma compliance.read a payroll_hr (resumen de cumplimiento laboral, permissions.ts «Tanda RRHH»); única adición fuera de hr.*. */
const V5_EXTRA_KEYS = { payroll_hr: ["compliance.read"] };

/** Diseño §6.2 adaptado a las 24 plantillas de la Tanda 8a (brief T9-02); break_glass = todo el ámbito org. */
const HOLDERS = {
  "documents.capture": ["receptionist", "front_office_manager", "manager", "admin_clerk", "fnb_manager", "housekeeping_manager", "maintenance_manager", "general_manager", "operations_director", "admin"],
  "documents.review": ["admin_clerk", "accountant", "controller", "general_manager", "owner", "admin"],
  "documents.archive.read": ["admin_clerk", "accountant", "controller", "general_manager", "owner", "manager", "operations_director", "auditor", "compliance", "admin"],
  "documents.admin": ["controller", "general_manager", "owner", "admin"]
};

/** Tamaño de cada plantilla en la versión 3 (antes de T9-02), medido con este mismo parser. */
const TEMPLATE_SIZES_V3 = {
  receptionist: 75,
  night_auditor: 51,
  front_office_manager: 101,
  housekeeper: 12,
  housekeeping_manager: 34,
  maintenance: 25,
  maintenance_manager: 47,
  fnb: 22,
  fnb_manager: 48,
  sales: 51,
  admin_clerk: 51,
  manager: 205,
  operations_director: 110,
  revenue: 53,
  accountant: 57,
  controller: 80,
  payroll_hr: 13,
  compliance: 58,
  asset_manager: 29,
  general_manager: 119,
  owner: 65,
  auditor: 68,
  admin: 72,
  break_glass: 249
};

// ---------------------------------------------------------------------------
// Permisos
// ---------------------------------------------------------------------------

describe("Documentos T9 · claves documents.* en el catálogo (§6.2)", () => {
  it("las 4 claves existen en PERMISSIONS (259 = 250 + 4 + 5 hr.* de la Tanda RRHH) y en PermissionKey, con descripción, y no son de plataforma", () => {
    assert.equal(catalog.length, 259);
    assert.deepEqual([...catalog].sort(), [...permissionKeyUnion].sort());
    for (const key of DOCUMENT_KEYS) {
      assert.ok(catalogSet.has(key), `${key} not in PERMISSIONS`);
      assert.ok(permissionKeyUnion.includes(key), `${key} not in PermissionKey`);
      assert.match(permissionsSource, new RegExp(`^\\s*"${key.replace(/\./g, "\\.")}": "[^"]{20,}",?$`, "m"), `${key}: description`);
      assert.equal(key.startsWith("admin.") || key.startsWith("platform."), false, `${key} would be platform scope (isPlatformPermission)`);
    }
    assert.deepEqual(catalog.filter((key) => key.startsWith("admin.") || key.startsWith("platform.")), ["admin.tenants.manage"]);
    assert.match(permissionsSource, /export const PLATFORM_PERMISSION_KEYS: readonly PermissionKey\[\] = \["admin\.tenants\.manage"\];/);
  });

  it("cada clave vive exactamente en las plantillas del diseño (admin las cuatro; break_glass = ámbito org)", () => {
    for (const key of DOCUMENT_KEYS) {
      const holders = Object.keys(templates).filter((template) => template !== "break_glass" && templates[template].has(key));
      assert.deepEqual(holders.sort(), [...HOLDERS[key]].sort(), `holders of ${key}`);
      assert.ok(templates.break_glass.has(key), `break_glass holds ${key}`);
    }
    // Mínimo privilegio: la revisión y la administración nunca bajan al mostrador ni a los departamentos.
    for (const template of ["receptionist", "front_office_manager", "housekeeping_manager", "maintenance_manager", "fnb_manager", "night_auditor", "housekeeper", "maintenance", "fnb", "sales", "revenue", "payroll_hr", "asset_manager"]) {
      assert.equal(templates[template].has("documents.review"), false, `${template} must not review`);
      assert.equal(templates[template].has("documents.admin"), false, `${template} must not administer`);
    }
    // auditor sigue siendo solo lectura; compliance solo consulta el archivo.
    for (const template of ["auditor", "compliance"]) {
      assert.deepEqual(DOCUMENT_KEYS.filter((key) => templates[template].has(key)), ["documents.archive.read"], `${template}: read-only`);
    }
    // admin (Administración de sistema) no gana dinero por el camino: sin payables.* ni asientos.
    for (const key of catalog.filter((permission) => /^(payables|payment|payments)\./.test(permission) || permission === "accounting.journal.post")) {
      assert.equal(templates.admin.has(key), false, `admin must not hold ${key}`);
    }
  });

  it("ROLE_TEMPLATE_VERSION === 5 (v4 y v5 aditivas): cada plantilla conserva sus claves v3 y solo suma documents.* (v4) y hr.* (v5); sin revocaciones nuevas", () => {
    assert.match(permissionsSource, /export const ROLE_TEMPLATE_VERSION = 5;/);
    assert.match(permissionsSource, /Version 4 \(Tanda T9/);
    assert.doesNotMatch(permissionsSource, /Keep any change additive/);
    assert.deepEqual(Object.keys(templates).sort(), Object.keys(TEMPLATE_SIZES_V3).sort());
    for (const [template, sizeV3] of Object.entries(TEMPLATE_SIZES_V3)) {
      const held = templates[template];
      const documentsHeld = DOCUMENT_KEYS.filter((key) => held.has(key)).length;
      const hrHeld = HR_KEYS_V5.filter((key) => held.has(key)).length;
      const extraHeld = (V5_EXTRA_KEYS[template] ?? []).filter((key) => held.has(key)).length;
      assert.equal(held.size - documentsHeld - hrHeld - extraHeld, sizeV3, `${template}: keys other than documents.* / hr.* changed (v3 had ${sizeV3})`);
      for (const permission of held) assert.ok(catalogSet.has(permission), `${template}: ${permission} not in PERMISSIONS`);
      for (const key of DOCUMENT_KEYS) assert.equal(revocations[template].has(key), false, `${template}: ${key} revoked`);
      for (const permission of revocations[template]) assert.equal(held.has(permission), false, `${template}: ${permission} both held and revoked`);
    }
    // Sin cambio en la lista de revocaciones v2 (cifras de rbac-sod-contract).
    assert.equal(revocations.manager.size, 16);
    assert.equal(revocations.accountant.size, 6);
    assert.equal(revocations.compliance.size, 4);
  });

  it("no hay clase de aprobación nueva: APPROVAL_KINDS sigue siendo la lista de 10 de la Tanda 8a", () => {
    assert.deepEqual(parseConstArray(rbacTypesSource, "APPROVAL_KINDS"), ["refund", "folio_adjust", "discount", "rate_change", "supplier_bill", "purchase_order", "payroll", "capex", "invoice_cancel", "day_reopen"]);
    assert.doesNotMatch(rbacTypesSource, /documents\./);
  });
});

// ---------------------------------------------------------------------------
// Tipos wire
// ---------------------------------------------------------------------------

describe("Documentos T9 · documents-types.ts (§8 «Tipos wire»)", () => {
  it("está reexportado desde index.ts justo después de payables-types", () => {
    const payables = indexSource.indexOf('export * from "./payables-types.js";');
    const documents = indexSource.indexOf('export * from "./documents-types.js";');
    assert.ok(payables >= 0 && documents > payables, "documents-types after payables-types");
    assert.ok(documents < indexSource.indexOf('export * from "./treasury-types.js";'));
  });

  it("catálogos con los valores del diseño (= enums Prisma y esquemas zod)", () => {
    assert.deepEqual(parseConstArray(documentsSource, "INCOMING_DOCUMENT_KINDS"), ["invoice", "delivery_note", "receipt", "letter", "administrative_notice", "contract", "e_invoice_status", "other", "unknown"]);
    assert.deepEqual(parseConstArray(documentsSource, "INCOMING_DOCUMENT_STATUSES"), ["captured", "sent_to_office", "in_review", "approved", "posted", "archived", "returned_to_centre", "rejected"]);
    assert.deepEqual(parseConstArray(documentsSource, "INCOMING_DOCUMENT_SOURCES"), ["upload", "mobile", "email", "scanner", "e_invoice", "api"]);
    assert.deepEqual(parseConstArray(documentsSource, "DOCUMENT_PHYSICAL_STATUSES"), ["at_centre", "in_transit", "at_office", "filed", "not_applicable"]);
    assert.deepEqual(parseConstArray(documentsSource, "DOCUMENT_STORAGE_KINDS"), ["inline", "disk", "s3"]);
    assert.deepEqual(parseConstArray(documentsSource, "DOCUMENT_PROPOSED_ACTIONS"), ["create_supplier_bill", "create_expense", "create_goods_receipt", "create_task", "archive"]);
    assert.deepEqual(parseConstArray(documentsSource, "DOCUMENT_REJECT_REASONS"), ["illegible", "missing_pages", "duplicate", "not_ours", "other"]);
    assert.deepEqual(parseConstArray(documentsSource, "DOCUMENT_ACTION_KINDS"), ["respond", "pay", "file", "forward", "verify"]);
    assert.deepEqual(parseConstArray(documentsSource, "DOCUMENT_ACTION_STATUSES"), ["open", "done", "cancelled"]);
    assert.deepEqual(parseConstArray(documentsSource, "GOODS_RECEIPT_STATUSES"), ["received", "matched", "billed", "disputed"]);
    assert.deepEqual(parseConstArray(documentsSource, "CHECK_STATUSES"), ["ok", "warn", "fail"]);
    assert.deepEqual(parseConstArray(documentsSource, "DOCUMENT_CHECK_KEYS"), ["nif", "supplier", "totals", "vat", "duplicate", "retention", "match"]);
    assert.deepEqual(parseConstArray(documentsSource, "DOCUMENT_EXTRACTION_SOURCES"), ["ai", "text_rules", "e_invoice", "manual"]);
    assert.match(documentsSource, /export const DOCUMENT_UPLOAD_MAX_FILES = 20;/);
    assert.match(documentsSource, /export const DOCUMENT_FILE_NAME_MAX_LENGTH = 200;/);
    // Cada catálogo tiene su tipo derivado `(typeof X)[number]`.
    for (const name of ["INCOMING_DOCUMENT_KINDS", "INCOMING_DOCUMENT_STATUSES", "INCOMING_DOCUMENT_SOURCES", "DOCUMENT_PHYSICAL_STATUSES", "DOCUMENT_STORAGE_KINDS", "DOCUMENT_PROPOSED_ACTIONS", "DOCUMENT_REJECT_REASONS", "DOCUMENT_ACTION_KINDS", "CHECK_STATUSES", "DOCUMENT_ERROR_CODES"]) {
      assert.match(documentsSource, new RegExp(`\\(typeof ${name}\\)\\[number\\]`), `${name}: derived type`);
    }
  });

  it("DOCUMENT_ERROR_CODES = los 16 códigos de §9 + página sin imagen (RV-17) + los 3 de recepción de T9-09 (R8)", () => {
    assert.deepEqual(parseConstArray(documentsSource, "DOCUMENT_ERROR_CODES"), [
      "VALIDATION_ERROR",
      "DOCUMENT_MIME_NOT_ALLOWED",
      "DOCUMENT_CONTENT_MISMATCH",
      "DOCUMENT_ACTION_INVALID_FOR_KIND",
      "DOCUMENT_NOT_FOUND",
      "PROPERTY_NOT_FOUND",
      "ENTITY_SCOPE_REQUIRED",
      "DOCUMENT_DUPLICATE_FILE",
      "DOCUMENT_STATUS_TRANSITION",
      "DOCUMENT_BLOCKED",
      "DOCUMENT_LEGAL_HOLD",
      "GOODS_RECEIPT_DUPLICATE",
      "SUPPLIER_BILL_MATCH_REQUIRED",
      "DOCUMENT_TOO_LARGE",
      "AI_PROVIDER_UNAVAILABLE",
      "DOCUMENT_CHECKS_FAILED",
      "DOCUMENT_PAGE_IMAGE_UNAVAILABLE",
      "INVENTORY_ITEM_INVALID",
      "STOCK_LOCATION_INVALID",
      "STOCK_QUANTITY_TOO_SMALL"
    ]);
  });

  it("exporta los DTOs y peticiones del diseño con la forma acordada", () => {
    for (const name of [
      "IncomingDocumentRecord", "IncomingDocumentDetail", "DocumentFileDto", "DocumentPageDto", "DocumentExtractionDto", "DocumentChecks", "DocumentCheck", "DocumentProposal",
      "DocumentUploadRequest", "DocumentUploadFile", "DocumentReviewRequest", "DocumentApproveRequest", "DocumentRejectRequest", "DocumentQueueFilters", "DocumentArchiveFilters", "DocumentKpis",
      "DocumentSettingsDto", "DocumentDispatchBatchDto", "DocumentActionRequest", "DocumentActionDto", "GoodsReceiptRequest", "GoodsReceiptLineRequest", "GoodsReceiptRecord", "GoodsReceiptDetail",
      "BillLineMatchDto", "SupplierBillMatchRequest", "DocumentErrorCode", "IncomingDocumentKind", "IncomingDocumentStatus", "CheckStatus"
    ]) {
      assert.match(documentsSource, new RegExp(`^export type ${name}\\b`, "m"), `${name} not exported`);
    }
    const detail = typeBlock(documentsSource, "IncomingDocumentDetail");
    for (const field of ["files: DocumentFileDto[]", "pages: DocumentPageDto[]", "extraction: DocumentExtractionDto | null", "checks: DocumentChecks | null", "proposal: DocumentProposal | null", "actions: DocumentActionDto[]", "matches: BillLineMatchDto[]", "reviewItemId: string | null"]) {
      assert.ok(detail.includes(field), `IncomingDocumentDetail lacks «${field}»`);
    }
    assert.match(documentsSource, /export type IncomingDocumentDetail = IncomingDocumentRecord & \{/);
    const extraction = typeBlock(documentsSource, "DocumentExtractionDto");
    for (const field of ["source: DocumentExtractionSource", "provider: string | null", "modelVersion: string | null", "tokensInput: number | null", "tokensOutput: number | null", "costEur: MoneyString | null"]) {
      assert.ok(extraction.includes(field), `DocumentExtractionDto lacks «${field}»`);
    }
    assert.match(documentsSource, /export type DocumentChecks = Record<DocumentCheckKey, DocumentCheck>;/);
    const check = typeBlock(documentsSource, "DocumentCheck");
    assert.ok(check.includes("status: CheckStatus") && check.includes("message: string") && check.includes("details?: Record<string, unknown>"));
    const proposal = typeBlock(documentsSource, "DocumentProposal");
    for (const field of ["action: DocumentProposedAction", "supplierBill?: SupplierBillRequest", "expense?: ExpenseRequest", "goodsReceipt?: GoodsReceiptRequest", "task?: DocumentActionRequest", "supplierProposal?: DocumentSupplierProposal"]) {
      assert.ok(proposal.includes(field), `DocumentProposal lacks «${field}»`);
    }
    assert.match(typeBlock(documentsSource, "DocumentSupplierProposal"), /fromSage: boolean;[\s\S]*name: string;[\s\S]*taxId: string \| null;/);
    const upload = typeBlock(documentsSource, "DocumentUploadRequest");
    for (const field of ["files: DocumentUploadFile[]", "kindHint?: IncomingDocumentKind", "note?: string", "allowDuplicate?: boolean", "source?: IncomingDocumentSource"]) {
      assert.ok(upload.includes(field), `DocumentUploadRequest lacks «${field}»`);
    }
    assert.match(typeBlock(documentsSource, "DocumentUploadFile"), /fileName: string;[\s\S]*mimeType: DocumentMimeType \| string;[\s\S]*base64: string;/);
    const approve = typeBlock(documentsSource, "DocumentApproveRequest");
    for (const field of ["action: DocumentProposedAction", "supplierBill?: SupplierBillRequest", "expense?: ExpenseRequest", "goodsReceipt?: GoodsReceiptRequest", "task?: DocumentActionRequest", "override?: DocumentApproveOverride"]) {
      assert.ok(approve.includes(field), `DocumentApproveRequest lacks «${field}»`);
    }
    assert.match(typeBlock(documentsSource, "DocumentApproveOverride"), /reason: string;/);
    assert.match(typeBlock(documentsSource, "DocumentRejectRequest"), /reason: DocumentRejectReason;[\s\S]*note\?: string;[\s\S]*returnToCentre\?: boolean;/);
    assert.match(typeBlock(documentsSource, "DocumentReviewRequest"), /reviewedFields: Record<string, unknown>;[\s\S]*kind\?: IncomingDocumentKind;/);
    const kpis = typeBlock(documentsSource, "DocumentKpis");
    for (const field of ["pendingByProperty: Array<{", "avgHoursCentreToOffice: number | null", "touchlessPct: number | null", "billsWithoutReceipt: number", "slaBreached: number", "aiCostEur: MoneyString", "degraded: DocumentKpiDegraded[]"]) {
      assert.ok(kpis.includes(field), `DocumentKpis lacks «${field}»`);
    }
    const settings = typeBlock(documentsSource, "DocumentSettingsDto");
    for (const field of ["officeSlaBusinessDays: number", "autoSendToOffice: boolean", "aiAllowedKinds: IncomingDocumentKind[]", "priceTolerancePct: DecimalString", "quantityTolerance: DecimalString", "amountToleranceAbs: MoneyString", "requireMatchForApproval: boolean", "retentionYearsDefault: number", "letterRetentionYears: number"]) {
      assert.ok(settings.includes(field), `DocumentSettingsDto lacks «${field}»`);
    }
    const record = typeBlock(documentsSource, "IncomingDocumentRecord");
    for (const field of ["registryNumber: string", "kind: IncomingDocumentKind", "status: IncomingDocumentStatus", "physicalStatus: DocumentPhysicalStatus", "source: IncomingDocumentSource", "sha256: string", "extractionStatus: DocumentExtractionStatus", "proposedAction: DocumentProposedAction | null", "slaBreached: boolean", "retentionUntil: IsoDay | null", "legalHold: boolean", "blockedAt: string | null", "deletedAt: string | null"]) {
      assert.ok(record.includes(field), `IncomingDocumentRecord lacks «${field}»`);
    }
    const goodsReceipt = typeBlock(documentsSource, "GoodsReceiptRequest");
    for (const field of ["deliveryNoteNumber: string", "deliveryDate: IsoDay", "lines: GoodsReceiptLineRequest[]", "supplierId?: string | null"]) {
      assert.ok(goodsReceipt.includes(field), `GoodsReceiptRequest lacks «${field}»`);
    }
    assert.match(typeBlock(documentsSource, "BillLineMatchDto"), /supplierBillLineId: string;[\s\S]*goodsReceiptLineId: string;[\s\S]*matchedBase: MoneyString \| null;[\s\S]*status: BillLineMatchStatus;/);
    assert.match(typeBlock(documentsSource, "DocumentActionRequest"), /kind: DocumentActionKind;[\s\S]*title: string;[\s\S]*dueAt\?: string \| null;/);
  });

  it("dinero como MoneyString de payables-types (importado, no redeclarado) y nunca `number` en importes", () => {
    assert.match(documentsSource, /^import type \{[^}]*\bMoneyString\b[^}]*\} from "\.\/payables-types\.js";/m);
    assert.doesNotMatch(documentsSource, /export type (MoneyString|IsoDay)\b/);
    for (const field of ["totalAmount: MoneyString | null", "costEur: MoneyString | null", "aiCostEur: MoneyString", "matchedBase: MoneyString | null", "amountMin?: MoneyString", "amountMax?: MoneyString", "baseTotal: MoneyString"]) {
      assert.ok(documentsSource.includes(field), `«${field}» missing`);
    }
    // Las peticiones admiten `number | string` (convención de payables-types); los DTO de lectura nunca `number` a secas.
    const floats = [...documentsSource.matchAll(/^\s*(\w*(?:amount|Amount|total|Total|Eur|price|Price|base|Base|cost|Cost)\w*)\??: number(?: \| null)?;/gm)].map((m) => m[1]);
    assert.deepEqual(floats, [], `money-like fields typed as number: ${floats.join(", ")}`);
    assert.doesNotMatch(documentsSource, /^import .* from "(?!\.\/payables-types\.js)/m, "only payables-types is imported (no runtime deps)");
  });
});

describe("Documentos T9 · payables-types.ts (campos nuevos de SupplierBill*)", () => {
  it("catálogos SUPPLIER_BILL_SOURCES / SUPPLIER_BILL_MATCH_STATUSES; SUPPLIER_BILL_STATUSES intacto", () => {
    assert.deepEqual(parseConstArray(payablesSource, "SUPPLIER_BILL_SOURCES"), ["manual", "digitized", "e_invoice"]);
    assert.deepEqual(parseConstArray(payablesSource, "SUPPLIER_BILL_MATCH_STATUSES"), ["none", "partial", "full", "variance"]);
    assert.deepEqual(parseConstArray(payablesSource, "SUPPLIER_BILL_STATUSES"), ["draft", "approved", "posted", "paid", "cancelled"]);
    assert.match(payablesSource, /export type SupplierBillSource = \(typeof SUPPLIER_BILL_SOURCES\)\[number\];/);
    assert.match(payablesSource, /export type SupplierBillMatchStatus = \(typeof SUPPLIER_BILL_MATCH_STATUSES\)\[number\];/);
    // Los catálogos viven una sola vez (documents-types no los redeclara: sin ambigüedad en `export *`).
    assert.doesNotMatch(documentsSource, /export (const|type) SUPPLIER_BILL_(SOURCES|MATCH_STATUSES)\b/);
    assert.doesNotMatch(documentsSource, /export type SupplierBill(Source|MatchStatus)\b/);
  });

  it("SupplierBillRequest / SupplierBillLineRequest: receptionDate, incomingDocumentId, source; quantity, unitPrice, deliveryNoteRef (opcionales)", () => {
    const request = typeBlock(payablesSource, "SupplierBillRequest");
    for (const field of ["receptionDate?: IsoDay | null", "incomingDocumentId?: string | null", "source?: SupplierBillSource", "lines: SupplierBillLineRequest[]", "invoiceNumber: string", "issueDate: IsoDay"]) {
      assert.ok(request.includes(field), `SupplierBillRequest lacks «${field}»`);
    }
    const line = typeBlock(payablesSource, "SupplierBillLineRequest");
    for (const field of ["quantity?: number | string | null", "unitPrice?: number | string | null", "deliveryNoteRef?: string | null", "expenseAccountCode: string", "base: number | string"]) {
      assert.ok(line.includes(field), `SupplierBillLineRequest lacks «${field}»`);
    }
  });

  it("SupplierBillDto / SupplierBillLineDto: receptionDate, incomingDocumentId, source, matchStatus; quantity, unitPrice, deliveryNoteRef (nullable, siempre presentes)", () => {
    const dto = typeBlock(payablesSource, "SupplierBillDto");
    for (const field of ["receptionDate: IsoDay | null", "incomingDocumentId: string | null", "source: SupplierBillSource", "matchStatus: SupplierBillMatchStatus", "status: SupplierBillStatus", "total: MoneyString"]) {
      assert.ok(dto.includes(field), `SupplierBillDto lacks «${field}»`);
    }
    const lineDto = typeBlock(payablesSource, "SupplierBillLineDto");
    for (const field of ["quantity: string | null", "unitPrice: string | null", "deliveryNoteRef: string | null", "base: MoneyString", "quota: MoneyString"]) {
      assert.ok(lineDto.includes(field), `SupplierBillLineDto lacks «${field}»`);
    }
  });
});

// Documentos · Tanda T9 · lote T9-14 — seed de demo FICTICIO del módulo de
// documentos (apps/api/src/scripts/seed-documents-demo.ts).
//
// Patrón seed-reputation-demo.ts: el seed vive en apps/api/src/scripts, reutiliza
// la guarda demo de packages/database/prisma/lib/demo-guard.ts pasándole un
// objeto de entorno EXPLÍCITO construido desde los flags (--allow-real /
// --confirm), sin leer el entorno del proceso (una lectura nueva en apps/api/src
// cambiaría el censo de tests/env-contract.test.mjs). El dataset es puro y
// determinista (seed-documents-demo.dataset.ts); este fichero orquesta Prisma y
// los servicios REALES del módulo (captura, pipeline, valija, oficina, payables).
//
// Uso (desde apps/api):
//   node --env-file-if-exists=../../.env --import tsx src/scripts/seed-documents-demo.ts \
//     [--dry-run (defecto) | --apply] [--property <id>] (defecto prop_123) \
//     [--allow-real --confirm <organizationId|propertyId>]… [--purge] [--seed 42] [--json]
//   corepack pnpm --filter @hotelos/api demo:seed-documents -- --dry-run | --apply | --purge --apply
//
// Qué escribe (--apply):
//   1. UNA transacción: claves de plantilla que faltan (permissions +
//      role_permissions, top-up ADITIVO de receptionist / admin_clerk de la
//      organización, patrón seed-rbac-demo.ts) y las 4 documents.* en los roles
//      del superusuario demo (reception@example.com); 2 usuarios demo
//      (documentos.centro@example.com · receptionist · ámbito el centro;
//      documentos.oficina@example.com · admin_clerk · ámbito la organización;
//      contraseña hotelos-demo) con su user_role_assignments (+ espejo
//      user_property_roles del centro); rbac_version + 1; 3 proveedores demo
//      (upsert por NIF; cuentas 628 / 600 / 622).
//   2. Después, con los servicios del módulo (cada uno confirma su propia
//      transacción, como el tick de reputación): captureIncomingDocuments por
//      documento (upload / mobile con el contexto del usuario del centro; email
//      y e_invoice como el poller: source fijado y skipPermissionCheck) +
//      runDocumentPipeline (provider none → clasificación por reglas y
//      extracción text_rules / e_invoice, una revisión en la cola de la oficina),
//      valija (lote A cerrado en el centro y recibido en la oficina; lote B en
//      tránsito), y la acción de la oficina que deja cada documento en su estado
//      objetivo: enviar, asignar, revisar campos (foto), aprobar (factura en
//      borrador → aprobación y contabilización por el superusuario demo,
//      separación de funciones; recepción de mercancía; tarea con plazo),
//      cotejo factura–albarán, devolver al centro, rechazar duplicado, archivar
//      desde el centro. Asientos y libro de IVA SOLO en la organización demo.
//   3. Retrasa capturedAt / sentAt de dos documentos (SLA vencido en la cola),
//      audita DocumentsDemoSeeded (actor de sistema) y vacía las colas de auditoría.
// Idempotente: un documento se reconoce por su título (nombre de fichero con el
// prefijo demo-documentos-) y se salta si ya existe; usuarios por e-mail,
// proveedores por NIF; el top-up de claves nunca revoca.
//
// --purge --apply borra SOLO lo suyo: documentos por título demo de la
// organización (ficheros del almacén con storage.delete antes de la fila),
// facturas / asientos / libro de IVA / retenciones enlazados a esos documentos,
// recepciones y cotejos, revisiones de la cola, valijas, notificaciones,
// asignaciones y usuarios demo, proveedores demo por NIF. Nunca audit_events;
// las claves añadidas a los roles se conservan (aditivas, como rbac:sync).
//
// Exit codes: 0 ok · 1 fallo (propiedad inexistente, error de BD/servicio) · 2 flags o guarda.

import { fileURLToPath } from "node:url";
import { resolve as resolvePath } from "node:path";
import { z } from "zod";
import { hashPassword, prisma } from "@hotelos/database";
import type { Prisma } from "@hotelos/database";
import { PERMISSIONS, ROLE_PERMISSION_MAP, type IncomingDocumentStatus, type PermissionKey, type RoleKey } from "@hotelos/shared";
import { assertDemoTarget, type PlannedWrite } from "../../../../packages/database/prisma/lib/demo-guard.js";
import type { UserContext } from "../lib/demo-store.js";
import { bumpRbacVersion, loadUserScope, permissionsFor, toContextAssignments } from "../lib/rbac-scope.js";
import { flushAuditQueues, hydrateAuditChainFromPostgres, recordAuditEvent } from "../modules/audit/audit.service.js";
import { hasPlatformAdminGrant } from "../modules/auth/auth.service.js";
import { approveDocument, archiveDocument, assignDocument, failedChecks, rejectDocument, reviewDocument } from "../modules/documents/actions.service.js";
import { matchSupplierBill } from "../modules/documents/bill-matching.service.js";
import { closeDispatchBatch, receiveDispatchBatch } from "../modules/documents/dispatch.service.js";
import { checksOf } from "../modules/documents/documents-dto.js";
import { getDocumentStorage } from "../modules/documents/documents.config.js";
import { captureIncomingDocuments, sendToOffice } from "../modules/documents/documents.service.js";
import { runDocumentPipeline } from "../modules/documents/pipeline.service.js";
import { approveSupplierBill, postSupplierBill } from "../modules/payables/supplier-bills.service.js";
import {
  DEMO_DEFAULT_PROPERTY_ID,
  DEMO_DEFAULT_SEED,
  DEMO_NOTE,
  DEMO_PASSWORD,
  DEMO_SUPPLIERS,
  DEMO_TITLE_PREFIX,
  DEMO_USERS,
  buildDocumentsDemoDataset,
  buildPurgePlan,
  buildSeedPlan,
  daysBefore,
  explainSeedTarget,
  goodsReceiptBodyOf,
  guardEnvFromFlags,
  reviewedFieldsOf,
  supplierBillBodyOf,
  type DemoDocument,
  type DemoSupplierIds,
  type DemoUserKey,
  type DocumentsDemoDataset,
  type ExistingDemoState,
  type PurgePlanCounts,
  type SeedTargetDecision
} from "./seed-documents-demo.dataset.js";

export const SEED_ACTION = "seed-documents-demo";
export const CORRELATION_PREFIX = "corr_documents_demo_seed";
export const FINAL_NOTICE = "Datos ficticios: ningún proveedor, factura ni persona procede de una empresa real.";
/** Superusuario del seed base (packages/database/prisma/seed.ts): aprueba y contabiliza las facturas demo (SoD frente a la oficina). */
export const DEMO_SUPER_USER_EMAIL = "reception@example.com";
export const DEMO_DEVICE_ID = "demo:seed-documents";
const LOG = "[demo:seed-documents]";
const TX_OPTIONS = { maxWait: 10_000, timeout: 600_000 } as const;
const DOCUMENT_KEYS: readonly PermissionKey[] = Object.freeze(["documents.capture", "documents.review", "documents.archive.read", "documents.admin"]);

// ───────────────────────────────────────────────────────────── flags

export const SEED_FLAGS_SCHEMA = z
  .object({
    apply: z.boolean(),
    purge: z.boolean(),
    json: z.boolean(),
    allowReal: z.boolean(),
    propertyId: z.string().trim().min(1).max(64),
    confirm: z.array(z.string().trim().min(1).max(64)),
    seed: z.number().int().min(0).max(2_147_483_647)
  })
  .strict();

export type SeedFlags = z.infer<typeof SEED_FLAGS_SCHEMA>;

const KNOWN_FLAGS = "--dry-run, --apply, --property <id>, --allow-real, --confirm <organizationId|propertyId> (repetible), --purge, --seed <n>, --json";

export function parseFlags(argv: readonly string[]): SeedFlags {
  const raw = { apply: false, purge: false, json: false, allowReal: false, propertyId: DEMO_DEFAULT_PROPERTY_ID, confirm: [] as string[], seed: DEMO_DEFAULT_SEED };
  let sawDryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`El flag "${arg}" necesita un valor.`);
      i += 1;
      return value;
    };
    if (arg === "--dry-run") sawDryRun = true;
    else if (arg === "--apply") raw.apply = true;
    else if (arg === "--purge") raw.purge = true;
    else if (arg === "--json") raw.json = true;
    else if (arg === "--allow-real") raw.allowReal = true;
    else if (arg === "--property") raw.propertyId = next();
    else if (arg === "--confirm") raw.confirm.push(next());
    else if (arg === "--seed") {
      const value = next();
      if (!/^\d+$/.test(value)) throw new Error(`El flag "--seed" espera un entero (recibido "${value}").`);
      raw.seed = Number(value);
    } else if (arg === "--") continue;
    else throw new Error(`Flag desconocido "${arg}". Conocidos: ${KNOWN_FLAGS}.`);
  }
  if (sawDryRun && raw.apply) throw new Error("--dry-run y --apply son excluyentes.");
  if (raw.confirm.length > 0 && !raw.allowReal) throw new Error("--confirm solo tiene sentido junto a --allow-real.");
  const parsed = SEED_FLAGS_SCHEMA.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".") || "flags"}: ${issue.message}`).join("; "));
  return parsed.data;
}

// ───────────────────────────────────────────────────────────── resumen

export type DocumentOutcome = {
  code: string;
  id: string | null;
  registryNumber: string | null;
  status: string | null;
  physicalStatus: string | null;
  action: string;
  created: boolean;
  extraction: string | null;
  proposedAction: string | null;
  checksFailed: string[];
  supplierBillId: string | null;
  goodsReceiptId: string | null;
  matchStatus: string | null;
  error: string | null;
};

export type SeedSummary = {
  mode: "seed" | "purge";
  dryRun: boolean;
  seed: number;
  propertyId: string;
  propertyName: string | null;
  organizationId: string | null;
  decision: SeedTargetDecision;
  reason: string | null;
  guardLog: string[];
  plan: PlannedWrite[];
  dataset: DocumentsDemoDataset["stats"] | null;
  rbac: { permissionsCreated: number; grants: number; rbacVersion: number | null } | null;
  users: Array<{ email: string; id: string | null; created: boolean; assignmentCreated: boolean }>;
  suppliers: Array<{ taxId: string; name: string; id: string | null; created: boolean }>;
  documents: DocumentOutcome[];
  dispatch: Array<{ key: string; batchId: string | null; batchNumber: string | null; documents: number; received: boolean }>;
  byStatus: Partial<Record<IncomingDocumentStatus, number>>;
  purged: PurgePlanCounts | null;
  warnings: string[];
  refused: boolean;
  applied: boolean;
  error?: string;
  durationMs: number;
  notice: string;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const details = (error as { details?: { code?: string } }).details;
    return details?.code ? `${details.code}: ${error.message}` : error.message;
  }
  return String(error);
}

type Db = Prisma.TransactionClient | typeof prisma;

// ───────────────────────────────────────────────────────────── lecturas

type PropertyRow = { id: string; name: string; code: string | null; organizationId: string; legalEntityId: string | null };
type UserRow = { id: string; email: string; organizationId: string; fullName: string };

/** Roles del superusuario demo (reception@example.com): reciben las 4 claves documents.* (aditivo). */
async function superUserRoleIds(db: Db, organizationId: string, userId: string): Promise<string[]> {
  const [legacy, live] = await Promise.all([
    db.userPropertyRole.findMany({ where: { userId }, select: { roleId: true } }),
    db.userRoleAssignment.findMany({ where: { userId, organizationId, revokedAt: null }, select: { roleId: true } })
  ]);
  return [...new Set([...legacy, ...live].map((row) => row.roleId))];
}

type RoleTopUp = { roleId: string; label: string; keys: PermissionKey[] };

/** Claves que faltan en cada rol objetivo (plantillas receptionist / admin_clerk + roles del superusuario demo). */
async function roleTopUps(db: Db, organizationId: string, superUser: UserRow | null): Promise<RoleTopUp[]> {
  const targets: Array<{ roleId: string; label: string; wanted: PermissionKey[] }> = [];
  for (const templateKey of ["receptionist", "admin_clerk"] as const satisfies readonly RoleKey[]) {
    const role = await db.role.findFirst({ where: { organizationId, templateKey }, orderBy: { id: "asc" }, select: { id: true, name: true } });
    if (!role) throw new Error(`La organización ${organizationId} no tiene un rol de plantilla «${templateKey}»: ejecuta rbac:sync o provisiona las plantillas antes del seed.`);
    targets.push({ roleId: role.id, label: `${role.name} (${templateKey})`, wanted: [...new Set(ROLE_PERMISSION_MAP[templateKey])] });
  }
  if (superUser) {
    for (const roleId of await superUserRoleIds(db, organizationId, superUser.id)) {
      const role = await db.role.findUnique({ where: { id: roleId }, select: { id: true, name: true } });
      if (role) targets.push({ roleId: role.id, label: `${role.name} (superusuario demo)`, wanted: [...DOCUMENT_KEYS] });
    }
  }
  const permissionRows = await db.permission.findMany({ select: { id: true, key: true } });
  const idByKey = new Map(permissionRows.map((row) => [row.key, row.id]));
  const out: RoleTopUp[] = [];
  for (const target of targets) {
    const granted = new Set((await db.rolePermission.findMany({ where: { roleId: target.roleId }, select: { permissionId: true } })).map((row) => row.permissionId));
    const missing = target.wanted.filter((key) => {
      const id = idByKey.get(key);
      return id === undefined || !granted.has(id);
    });
    if (missing.length > 0) out.push({ roleId: target.roleId, label: target.label, keys: missing });
  }
  return out;
}

async function countDemoRows(db: Db, organizationId: string, propertyId: string): Promise<PurgePlanCounts> {
  const docs = await db.incomingDocument.findMany({ where: { organizationId, propertyId, title: { startsWith: DEMO_TITLE_PREFIX } }, select: { id: true, dispatchBatchId: true } });
  const docIds = docs.map((doc) => doc.id);
  const batchIds = [...new Set(docs.map((doc) => doc.dispatchBatchId).filter((id): id is string => !!id))];
  const users = await db.user.findMany({ where: { organizationId, email: { in: DEMO_USERS.map((user) => user.email) } }, select: { id: true } });
  const userIds = users.map((user) => user.id);
  const bills = docIds.length > 0 ? await db.supplierBill.findMany({ where: { organizationId, incomingDocumentId: { in: docIds } }, select: { id: true } }) : [];
  const billIds = bills.map((bill) => bill.id);
  const receipts = docIds.length > 0 ? await db.goodsReceipt.findMany({ where: { organizationId, incomingDocumentId: { in: docIds } }, select: { id: true } }) : [];
  const receiptIds = receipts.map((receipt) => receipt.id);
  const billLineIds = billIds.length > 0 ? (await db.supplierBillLine.findMany({ where: { supplierBillId: { in: billIds } }, select: { id: true } })).map((line) => line.id) : [];
  const [matches, entries, vat, withholding, movements, reviews, notifications, files, assignments, legacy, sessions, suppliers] = await Promise.all([
    billLineIds.length > 0 ? db.billLineMatch.count({ where: { supplierBillLineId: { in: billLineIds } } }) : Promise.resolve(0),
    billIds.length > 0 ? db.journalEntry.count({ where: { organizationId, sourceType: "supplier_bill", sourceId: { in: billIds } } }) : Promise.resolve(0),
    billIds.length > 0 ? db.vatBookEntry.count({ where: { organizationId, sourceType: "supplier_bill", sourceId: { in: billIds } } }) : Promise.resolve(0),
    billIds.length > 0 ? db.withholdingTaxRecord.count({ where: { sourceType: "vendor_invoice", sourceId: { in: billIds } } }) : Promise.resolve(0),
    receiptIds.length > 0 ? db.stockMovement.count({ where: { sourceType: "goods_receipt", sourceId: { in: receiptIds } } }) : Promise.resolve(0),
    docIds.length > 0 ? db.aiHumanReviewItem.count({ where: { organizationId, relatedEntityType: "incoming_document", relatedEntityId: { in: docIds } } }) : Promise.resolve(0),
    userIds.length > 0 ? db.notification.count({ where: { organizationId, userId: { in: userIds } } }) : Promise.resolve(0),
    docIds.length > 0 ? db.documentFile.count({ where: { documentId: { in: docIds } } }) : Promise.resolve(0),
    userIds.length > 0 ? db.userRoleAssignment.count({ where: { organizationId, userId: { in: userIds } } }) : Promise.resolve(0),
    userIds.length > 0 ? db.userPropertyRole.count({ where: { userId: { in: userIds } } }) : Promise.resolve(0),
    userIds.length > 0 ? db.session.count({ where: { userId: { in: userIds } } }) : Promise.resolve(0),
    db.supplier.count({ where: { organizationId, taxId: { in: DEMO_SUPPLIERS.map((supplier) => supplier.taxId) } } })
  ]);
  return {
    bill_line_matches: matches,
    journal_entries: entries,
    vat_book_entries: vat,
    withholding_tax_records: withholding,
    supplier_bills: billIds.length,
    stock_movements: movements,
    goods_receipts: receiptIds.length,
    ai_human_review_items: reviews,
    notifications,
    document_files: files,
    incoming_documents: docIds.length,
    document_dispatch_batches: batchIds.length,
    user_role_assignments: assignments,
    user_property_roles: legacy,
    sessions,
    users: userIds.length,
    suppliers
  };
}

// ───────────────────────────────────────────────────────────── contextos

/** Contexto de sesión de un usuario real, ensamblado como contextFromScope (auth.service.ts) sin fila Session. */
async function contextOf(user: UserRow, propertyId: string): Promise<UserContext> {
  const scope = await loadUserScope(user.id, user.organizationId);
  const property = scope.assignedPropertyIds.includes(propertyId) ? propertyId : (scope.assignedPropertyIds[0] ?? propertyId);
  return {
    organizationId: user.organizationId,
    propertyId: property,
    userId: user.id,
    fullName: user.fullName,
    deviceId: DEMO_DEVICE_ID,
    permissions: permissionsFor(scope, property),
    assignedPropertyIds: scope.assignedPropertyIds,
    orgScope: scope.orgScope,
    scopes: scope.scopes,
    assignments: toContextAssignments(scope),
    isPlatformAdmin: hasPlatformAdminGrant(scope.allPermissions)
  };
}

// ───────────────────────────────────────────────────────────── fase 1 (transacción)

type Phase1Result = { rbac: NonNullable<SeedSummary["rbac"]>; users: SeedSummary["users"]; suppliers: SeedSummary["suppliers"]; userIds: Record<DemoUserKey, string>; supplierIds: DemoSupplierIds };

async function applyPhase1(tx: Prisma.TransactionClient, dataset: DocumentsDemoDataset, property: PropertyRow, superUser: UserRow | null): Promise<Phase1Result> {
  const organizationId = property.organizationId;
  // 1. Claves de plantilla que faltan (permissions + role_permissions, aditivo).
  const topUps = await roleTopUps(tx, organizationId, superUser);
  const wanted = [...new Set(topUps.flatMap((topUp) => topUp.keys))];
  let permissionsCreated = 0;
  if (wanted.length > 0) {
    const created = await tx.permission.createMany({ data: wanted.map((key) => ({ key, description: PERMISSIONS[key] })), skipDuplicates: true });
    permissionsCreated = created.count;
  }
  const idByKey = new Map((await tx.permission.findMany({ where: { key: { in: wanted } }, select: { id: true, key: true } })).map((row) => [row.key, row.id]));
  let grants = 0;
  for (const topUp of topUps) {
    const data = topUp.keys.map((key) => idByKey.get(key)).filter((id): id is string => id !== undefined).map((permissionId) => ({ roleId: topUp.roleId, permissionId }));
    if (data.length > 0) grants += (await tx.rolePermission.createMany({ data, skipDuplicates: true })).count;
  }

  // 2. Usuarios demo (idempotentes por e-mail) y su asignación de ámbito real.
  const passwordHash = hashPassword(DEMO_PASSWORD);
  const users: SeedSummary["users"] = [];
  const userIds = {} as Record<DemoUserKey, string>;
  for (const spec of dataset.users) {
    const existing = await tx.user.findUnique({ where: { email: spec.email }, select: { id: true, organizationId: true } });
    if (existing && existing.organizationId !== organizationId) throw new Error(`${spec.email} ya existe en otra organización (${existing.organizationId}). Nada escrito.`);
    let userId: string;
    if (existing) {
      await tx.user.update({ where: { id: existing.id }, data: { fullName: spec.fullName, status: "active", mfaEnabled: false, mustChangePassword: false, lockedUntil: null, failedLoginAttempts: 0 } });
      userId = existing.id;
    } else {
      const created = await tx.user.create({
        data: { organizationId, email: spec.email, fullName: spec.fullName, status: "active", mfaEnabled: false, passwordHash, mustChangePassword: false, passwordChangedAt: new Date() },
        select: { id: true }
      });
      userId = created.id;
    }
    userIds[spec.key] = userId;
    const role = await tx.role.findFirst({ where: { organizationId, templateKey: spec.templateKey }, orderBy: { id: "asc" }, select: { id: true } });
    if (!role) throw new Error(`Sin rol de plantilla «${spec.templateKey}» en ${organizationId}.`);
    const scopePropertyId = spec.scopeType === "property" ? property.id : null;
    const live = await tx.userRoleAssignment.findFirst({ where: { userId, roleId: role.id, organizationId, scopeType: spec.scopeType, propertyId: scopePropertyId, propertyGroupId: null, legalEntityId: null, revokedAt: null }, select: { id: true } });
    let assignmentCreated = false;
    if (!live) {
      await tx.userRoleAssignment.create({ data: { userId, roleId: role.id, organizationId, scopeType: spec.scopeType, propertyId: scopePropertyId, reason: DEMO_NOTE } });
      assignmentCreated = true;
    }
    if (spec.scopeType === "property") {
      // Espejo dual-read (seed-rbac-demo.ts): solo el ámbito property lo lleva.
      const mirror = await tx.userPropertyRole.findFirst({ where: { userId, propertyId: property.id, roleId: role.id }, select: { id: true } });
      if (!mirror) await tx.userPropertyRole.create({ data: { userId, propertyId: property.id, roleId: role.id } });
    }
    users.push({ email: spec.email, id: userId, created: !existing, assignmentCreated });
  }
  // rbac_version solo cambia cuando cambió algo de RBAC (claves concedidas, usuarios o asignaciones nuevas): así una
  // segunda ejecución sin cambios no obliga a las sesiones vivas a recargar su ámbito.
  const rbacChanged = grants > 0 || users.some((user) => user.created || user.assignmentCreated);
  const rbacVersion = rbacChanged ? await bumpRbacVersion(organizationId, tx) : (await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { rbacVersion: true } })).rbacVersion;

  // 3. Proveedores demo (upsert por NIF).
  const suppliers: SeedSummary["suppliers"] = [];
  const supplierIds: DemoSupplierIds = {};
  for (const spec of dataset.suppliers) {
    const existing = await tx.supplier.findFirst({ where: { organizationId, taxId: spec.taxId }, orderBy: { createdAt: "asc" }, select: { id: true } });
    const data = {
      name: spec.name,
      taxId: spec.taxId,
      nifValidatedAt: new Date(),
      address: spec.address,
      postalCode: spec.postalCode,
      city: spec.city,
      province: spec.province,
      countryCode: "ES",
      defaultExpenseAccountCode: spec.defaultExpenseAccountCode,
      contactJson: { email: spec.email, isDemo: true } as Prisma.InputJsonObject,
      active: true
    };
    let id: string;
    if (existing) {
      await tx.supplier.update({ where: { id: existing.id }, data });
      id = existing.id;
    } else {
      id = (await tx.supplier.create({ data: { organizationId, ...data }, select: { id: true } })).id;
    }
    supplierIds[spec.key] = id;
    suppliers.push({ taxId: spec.taxId, name: spec.name, id, created: !existing });
  }
  return { rbac: { permissionsCreated, grants, rbacVersion }, users, suppliers, userIds, supplierIds };
}

// ───────────────────────────────────────────────────────────── fase 2 (servicios)

type Actors = { centre: UserContext; office: UserContext; superUser: UserContext };

type DocumentState = { id: string; registryNumber: string; status: string; physicalStatus: string; created: boolean };

function emptyOutcome(code: string, action: string): DocumentOutcome {
  return { code, id: null, registryNumber: null, status: null, physicalStatus: null, action, created: false, extraction: null, proposedAction: null, checksFailed: [], supplierBillId: null, goodsReceiptId: null, matchStatus: null, error: null };
}

function actionLabel(doc: DemoDocument): string {
  switch (doc.office.type) {
    case "none":
      return doc.target === "sent_to_office" ? "capturar · enviar a la oficina" : "capturar";
    case "assign":
      return "enviar · asignar (en revisión)";
    case "approve_supplier_bill":
      return `enviar · asignar${doc.office.reviewFirst ? " · revisar campos" : ""} · aprobar factura${doc.office.matchWith ? ` · cotejar con ${doc.office.matchWith}` : ""}${doc.office.post ? " · aprobar y contabilizar la factura" : ""}`;
    case "approve_goods_receipt":
      return "enviar · asignar · aprobar recepción de mercancía";
    case "approve_task":
      return "enviar · asignar · aprobar tarea con plazo (archivado)";
    case "archive_from_centre":
      return "archivar desde el centro";
    case "reject_return":
      return "enviar · asignar · devolver al centro";
    case "reject_duplicate":
      return `enviar · asignar · rechazar como duplicado de ${doc.office.duplicateOf}`;
  }
}

/** Orden de proceso: albaranes antes que facturas (el cotejo necesita la recepción), el resto después. */
function processingOrder(documents: readonly DemoDocument[]): DemoDocument[] {
  const notes = documents.filter((doc) => doc.content.kind === "delivery_note");
  const rest = documents.filter((doc) => doc.content.kind !== "delivery_note");
  return [...notes, ...rest];
}

async function captureOne(doc: DemoDocument, dataset: DocumentsDemoDataset, actors: Actors, correlationId: string, warnings: string[]): Promise<DocumentState> {
  const organizationId = dataset.organizationId;
  const existing = await prisma.incomingDocument.findFirst({ where: { organizationId, propertyId: dataset.propertyId, title: doc.fileName }, select: { id: true, registryNumber: true, status: true, physicalStatus: true } });
  if (existing) return { ...existing, created: false };
  const viaServer = doc.source === "email" || doc.source === "e_invoice";
  const records = await captureIncomingDocuments({
    context: actors.centre,
    correlationId,
    propertyId: dataset.propertyId,
    ...(viaServer ? { source: doc.source, skipPermissionCheck: true } : {}),
    ...(doc.emailMeta ? { emailMeta: { messageId: `demo-${doc.code.toLowerCase()}@${dataset.propertyId}.example`, attachmentId: `att-${doc.code.toLowerCase()}`, from: doc.emailMeta.from, subject: doc.emailMeta.subject, receivedAt: daysBefore(dataset.anchor, 1).toISOString(), connectionId: null, isDemo: true } } : {}),
    body: {
      files: [{ fileName: doc.fileName, mimeType: doc.mimeType, base64: doc.bytes.toString("base64") }],
      ...(doc.kindHint ? { kindHint: doc.kindHint } : {}),
      ...(viaServer ? {} : { source: doc.source }),
      ...(doc.duplicateOf ? { allowDuplicate: true } : {}),
      note: `${DEMO_NOTE} · ${doc.code}: ${doc.note}`
    }
  });
  const record = records[0];
  if (!record) throw new Error(`${doc.code}: captureIncomingDocuments no devolvió ningún documento.`);
  try {
    await runDocumentPipeline(record.id, { trigger: "capture", correlationId });
  } catch (error) {
    warnings.push(`${doc.code}: pipeline → ${errorMessage(error)}`);
  }
  return { id: record.id, registryNumber: record.registryNumber, status: record.status, physicalStatus: record.physicalStatus, created: true };
}

async function refresh(id: string): Promise<{ status: string; physicalStatus: string; extractionStatus: string; proposedAction: string | null; checksJson: unknown; supplierBillId: string | null; goodsReceiptId: string | null }> {
  return prisma.incomingDocument.findUniqueOrThrow({ where: { id }, select: { status: true, physicalStatus: true, extractionStatus: true, proposedAction: true, checksJson: true, supplierBillId: true, goodsReceiptId: true } });
}

function overrideFor(checksJson: unknown, reason: string): { override?: { reason: string } } & { failed: string[] } {
  const failed = failedChecks(checksOf(checksJson));
  return failed.length > 0 ? { override: { reason: `${reason} (comprobaciones en fallo: ${failed.join(", ")})` }, failed } : { failed };
}

async function toOffice(doc: DocumentState, dataset: DocumentsDemoDataset, actors: Actors, correlationId: string): Promise<void> {
  if (doc.status === "captured") await sendToOffice({ context: actors.centre, correlationId, propertyId: dataset.propertyId, documentId: doc.id });
  await assignDocument({ context: actors.office, correlationId, propertyId: dataset.propertyId, id: doc.id, body: { assignedTo: actors.office.userId } });
}

async function runOfficeFlow(doc: DemoDocument, state: DocumentState, dataset: DocumentsDemoDataset, actors: Actors, supplierIds: DemoSupplierIds, states: Map<string, DocumentState>, outcome: DocumentOutcome, correlationId: string): Promise<void> {
  const propertyId = dataset.propertyId;
  const office = doc.office;
  switch (office.type) {
    case "none":
      if (doc.target === "sent_to_office") await sendToOffice({ context: actors.centre, correlationId, propertyId, documentId: state.id });
      return;
    case "assign":
      await toOffice(state, dataset, actors, correlationId);
      return;
    case "archive_from_centre":
      await archiveDocument({ context: actors.office, correlationId, propertyId, id: state.id, body: {} });
      return;
    case "reject_return":
      await toOffice(state, dataset, actors, correlationId);
      await rejectDocument({ context: actors.office, correlationId, propertyId, id: state.id, body: { reason: office.reason, note: office.note, returnToCentre: true } });
      return;
    case "reject_duplicate": {
      await toOffice(state, dataset, actors, correlationId);
      const twin = states.get(office.duplicateOf);
      await rejectDocument({ context: actors.office, correlationId, propertyId, id: state.id, body: { reason: "duplicate", note: office.note, returnToCentre: false, ...(twin ? { duplicateOfId: twin.id } : {}) } });
      return;
    }
    case "approve_task": {
      await toOffice(state, dataset, actors, correlationId);
      const current = await refresh(state.id);
      const { failed, ...override } = overrideFor(current.checksJson, "Demo: notificación ficticia");
      outcome.checksFailed = failed;
      const result = await approveDocument({ context: actors.office, correlationId, propertyId, id: state.id, body: { action: "create_task", task: { ...office.task, assignedTo: actors.office.userId }, ...override } });
      if (result.actionId) outcome.action += ` · tarea ${result.actionId}`;
      return;
    }
    case "approve_goods_receipt": {
      await toOffice(state, dataset, actors, correlationId);
      const current = await refresh(state.id);
      const { failed, ...override } = overrideFor(current.checksJson, "Demo: albarán ficticio");
      outcome.checksFailed = failed;
      const result = await approveDocument({ context: actors.office, correlationId, propertyId, id: state.id, body: { action: "create_goods_receipt", goodsReceipt: goodsReceiptBodyOf(doc, dataset.anchor, supplierIds, actors.centre.fullName), ...override } });
      outcome.goodsReceiptId = result.goodsReceiptId ?? null;
      return;
    }
    case "approve_supplier_bill": {
      await toOffice(state, dataset, actors, correlationId);
      if (office.reviewFirst) {
        await reviewDocument({ context: actors.office, correlationId, propertyId, id: state.id, body: { reviewedFields: reviewedFieldsOf(doc, dataset.anchor), kind: "invoice", note: "Foto sin capa de texto: campos tecleados por la oficina (demo)." } });
      }
      const current = await refresh(state.id);
      const { failed, ...override } = overrideFor(current.checksJson, office.reviewFirst ? "Demo: campos tecleados sobre una foto" : "Demo: factura ficticia");
      outcome.checksFailed = failed;
      const result = await approveDocument({ context: actors.office, correlationId, propertyId, id: state.id, body: { action: "create_supplier_bill", supplierBill: supplierBillBodyOf(doc, dataset.anchor, supplierIds), ...override } });
      const billId = result.supplierBillId ?? null;
      outcome.supplierBillId = billId;
      if (!billId) return;
      if (office.matchWith) {
        const matched = await matchSupplierBill({ context: actors.office, correlationId, propertyId, billId, body: { auto: true } });
        outcome.matchStatus = matched.matchStatus;
      }
      if (office.post) {
        // Separación de funciones: la oficina registró la factura; el superusuario demo la aprueba y contabiliza.
        await approveSupplierBill({ context: actors.superUser, correlationId, propertyId, billId, body: {} });
        await postSupplierBill({ context: actors.superUser, correlationId, propertyId, billId, body: {} });
      }
      return;
    }
  }
}

async function applyDispatch(dataset: DocumentsDemoDataset, states: Map<string, DocumentState>, actors: Actors, correlationId: string, summary: SeedSummary): Promise<void> {
  for (const batch of dataset.dispatch) {
    const ids = batch.codes.map((code) => states.get(code)).filter((state): state is DocumentState => !!state && state.created && state.physicalStatus === "at_centre").map((state) => state.id);
    if (ids.length === 0) {
      summary.dispatch.push({ key: batch.key, batchId: null, batchNumber: null, documents: 0, received: false });
      continue;
    }
    const closed = await closeDispatchBatch({ context: actors.centre, correlationId, propertyId: dataset.propertyId, body: { documentIds: ids } });
    let received = false;
    if (batch.receive) {
      await receiveDispatchBatch({ context: actors.office, correlationId, propertyId: dataset.propertyId, batchId: closed.id, body: { receivedIds: ids } });
      received = true;
    }
    summary.dispatch.push({ key: batch.key, batchId: closed.id, batchNumber: closed.batchNumber, documents: ids.length, received });
  }
}

async function applyBackdates(dataset: DocumentsDemoDataset, states: Map<string, DocumentState>): Promise<number> {
  let updated = 0;
  for (const doc of dataset.documents) {
    const state = states.get(doc.code);
    if (!doc.backdate || !state?.created) continue;
    const capturedAt = daysBefore(dataset.anchor, doc.backdate.capturedDaysAgo);
    const sentAt = daysBefore(dataset.anchor, doc.backdate.sentDaysAgo);
    const row = await prisma.incomingDocument.findUnique({ where: { id: state.id }, select: { sentAt: true } });
    await prisma.incomingDocument.update({ where: { id: state.id }, data: { capturedAt, ...(row?.sentAt ? { sentAt } : {}) } });
    updated += 1;
  }
  return updated;
}

async function applyDocuments(dataset: DocumentsDemoDataset, actors: Actors, supplierIds: DemoSupplierIds, correlationId: string, summary: SeedSummary): Promise<void> {
  const states = new Map<string, DocumentState>();
  const outcomes = new Map<string, DocumentOutcome>();
  // Captura + pipeline de todos (en el orden del dataset: números de registro consecutivos).
  for (const doc of dataset.documents) {
    const outcome = emptyOutcome(doc.code, actionLabel(doc));
    outcomes.set(doc.code, outcome);
    try {
      const state = await captureOne(doc, dataset, actors, correlationId, summary.warnings);
      states.set(doc.code, state);
      outcome.id = state.id;
      outcome.registryNumber = state.registryNumber;
      outcome.created = state.created;
      if (!state.created) outcome.action = "ya existía: sin cambios";
    } catch (error) {
      outcome.error = `captura: ${errorMessage(error)}`;
    }
  }
  // Valija (antes de que la oficina decida: el papel sale del centro con los documentos).
  try {
    await applyDispatch(dataset, states, actors, correlationId, summary);
  } catch (error) {
    summary.warnings.push(`valija: ${errorMessage(error)}`);
  }
  // Flujo de la oficina, albaranes primero.
  for (const doc of processingOrder(dataset.documents)) {
    const state = states.get(doc.code);
    const outcome = outcomes.get(doc.code)!;
    if (!state || !state.created || outcome.error) continue;
    try {
      await runOfficeFlow(doc, state, dataset, actors, supplierIds, states, outcome, correlationId);
    } catch (error) {
      outcome.error = `${errorMessage(error)}`;
    }
  }
  try {
    const backdated = await applyBackdates(dataset, states);
    if (backdated > 0) summary.warnings.push(`fechas retrasadas (capturedAt / sentAt) en ${backdated} documento(s) para mostrar el SLA vencido.`);
  } catch (error) {
    summary.warnings.push(`retraso de fechas: ${errorMessage(error)}`);
  }
  // Estado final de cada documento.
  for (const doc of dataset.documents) {
    const outcome = outcomes.get(doc.code)!;
    const state = states.get(doc.code);
    if (state) {
      const current = await refresh(state.id);
      outcome.status = current.status;
      outcome.physicalStatus = current.physicalStatus;
      outcome.extraction = current.extractionStatus;
      outcome.proposedAction = current.proposedAction;
      outcome.supplierBillId = outcome.supplierBillId ?? current.supplierBillId;
      outcome.goodsReceiptId = outcome.goodsReceiptId ?? current.goodsReceiptId;
      if (state.created && !outcome.error && current.status !== doc.target) outcome.error = `estado final «${current.status}», esperado «${doc.target}»`;
    }
    summary.documents.push(outcome);
  }
  const rows = await prisma.incomingDocument.groupBy({ by: ["status"], where: { organizationId: dataset.organizationId, propertyId: dataset.propertyId, title: { startsWith: DEMO_TITLE_PREFIX } }, _count: { _all: true } });
  for (const row of rows) summary.byStatus[row.status] = row._count._all;
}

// ───────────────────────────────────────────────────────────── purga

async function purgeDemoRows(organizationId: string, propertyId: string, warnings: string[]): Promise<PurgePlanCounts> {
  // 1. Ficheros del almacén (idempotente; inline no tiene nada que borrar).
  const docs = await prisma.incomingDocument.findMany({ where: { organizationId, propertyId, title: { startsWith: DEMO_TITLE_PREFIX } }, select: { id: true, dispatchBatchId: true } });
  const docIds = docs.map((doc) => doc.id);
  const batchIds = [...new Set(docs.map((doc) => doc.dispatchBatchId).filter((id): id is string => !!id))];
  const files = docIds.length > 0 ? await prisma.documentFile.findMany({ where: { documentId: { in: docIds } }, select: { storageKind: true, storageKey: true } }) : [];
  const keys = files.filter((file) => file.storageKind !== "inline" && file.storageKey).map((file) => file.storageKey as string);
  if (keys.length > 0) {
    const storage = getDocumentStorage();
    for (const key of keys) {
      try {
        await storage.delete(key);
      } catch (error) {
        warnings.push(`storage.delete falló (se reintenta en la próxima purga): ${errorMessage(error)}`);
      }
    }
  }
  // 2. Filas, en una transacción, siempre acotadas a la organización y a los ids demo.
  return prisma.$transaction(async (tx) => {
    const users = await tx.user.findMany({ where: { organizationId, email: { in: DEMO_USERS.map((user) => user.email) } }, select: { id: true } });
    const userIds = users.map((user) => user.id);
    const billIds = docIds.length > 0 ? (await tx.supplierBill.findMany({ where: { organizationId, incomingDocumentId: { in: docIds } }, select: { id: true } })).map((bill) => bill.id) : [];
    const receiptIds = docIds.length > 0 ? (await tx.goodsReceipt.findMany({ where: { organizationId, incomingDocumentId: { in: docIds } }, select: { id: true } })).map((receipt) => receipt.id) : [];
    const billLineIds = billIds.length > 0 ? (await tx.supplierBillLine.findMany({ where: { supplierBillId: { in: billIds } }, select: { id: true } })).map((line) => line.id) : [];
    const counts: PurgePlanCounts = {};
    counts.bill_line_matches = billLineIds.length > 0 ? (await tx.billLineMatch.deleteMany({ where: { supplierBillLineId: { in: billLineIds } } })).count : 0;
    if (billIds.length > 0) {
      const entries = await tx.journalEntry.findMany({ where: { organizationId, sourceType: "supplier_bill", sourceId: { in: billIds } }, select: { id: true } });
      const entryIds = entries.map((entry) => entry.id);
      if (entryIds.length > 0) await tx.journalLine.deleteMany({ where: { journalEntryId: { in: entryIds } } });
      counts.journal_entries = entryIds.length > 0 ? (await tx.journalEntry.deleteMany({ where: { id: { in: entryIds }, organizationId } })).count : 0;
      counts.vat_book_entries = (await tx.vatBookEntry.deleteMany({ where: { organizationId, sourceType: "supplier_bill", sourceId: { in: billIds } } })).count;
      counts.withholding_tax_records = (await tx.withholdingTaxRecord.deleteMany({ where: { sourceType: "vendor_invoice", sourceId: { in: billIds } } })).count;
      counts.supplier_bills = (await tx.supplierBill.deleteMany({ where: { id: { in: billIds }, organizationId } })).count;
    } else {
      counts.journal_entries = 0;
      counts.vat_book_entries = 0;
      counts.withholding_tax_records = 0;
      counts.supplier_bills = 0;
    }
    counts.stock_movements = receiptIds.length > 0 ? (await tx.stockMovement.deleteMany({ where: { sourceType: "goods_receipt", sourceId: { in: receiptIds } } })).count : 0;
    counts.goods_receipts = receiptIds.length > 0 ? (await tx.goodsReceipt.deleteMany({ where: { id: { in: receiptIds }, organizationId } })).count : 0;
    counts.ai_human_review_items = docIds.length > 0 ? (await tx.aiHumanReviewItem.deleteMany({ where: { organizationId, relatedEntityType: "incoming_document", relatedEntityId: { in: docIds } } })).count : 0;
    counts.notifications = userIds.length > 0 ? (await tx.notification.deleteMany({ where: { organizationId, userId: { in: userIds } } })).count : 0;
    counts.document_files = files.length;
    counts.incoming_documents = docIds.length > 0 ? (await tx.incomingDocument.deleteMany({ where: { id: { in: docIds }, organizationId, propertyId } })).count : 0;
    counts.document_dispatch_batches = batchIds.length > 0 ? (await tx.documentDispatchBatch.deleteMany({ where: { id: { in: batchIds }, propertyId } })).count : 0;
    counts.user_role_assignments = userIds.length > 0 ? (await tx.userRoleAssignment.deleteMany({ where: { organizationId, userId: { in: userIds } } })).count : 0;
    counts.user_property_roles = userIds.length > 0 ? (await tx.userPropertyRole.deleteMany({ where: { userId: { in: userIds } } })).count : 0;
    if (userIds.length > 0) {
      counts.sessions = (await tx.session.deleteMany({ where: { userId: { in: userIds } } })).count;
      await tx.device.deleteMany({ where: { userId: { in: userIds } } });
      await tx.mfaChallenge.deleteMany({ where: { userId: { in: userIds } } });
    } else counts.sessions = 0;
    counts.users = userIds.length > 0 ? (await tx.user.deleteMany({ where: { id: { in: userIds }, organizationId } })).count : 0;
    counts.suppliers = (await tx.supplier.deleteMany({ where: { organizationId, taxId: { in: DEMO_SUPPLIERS.map((supplier) => supplier.taxId) } } })).count;
    if (userIds.length > 0) await bumpRbacVersion(organizationId, tx);
    return counts;
  }, TX_OPTIONS);
}

// ───────────────────────────────────────────────────────────── orquestación

export async function runSeed(flags: SeedFlags): Promise<SeedSummary> {
  const start = Date.now();
  const now = new Date();
  const summary: SeedSummary = {
    mode: flags.purge ? "purge" : "seed",
    dryRun: !flags.apply,
    seed: flags.seed,
    propertyId: flags.propertyId,
    propertyName: null,
    organizationId: null,
    decision: "refused",
    reason: null,
    guardLog: [],
    plan: [],
    dataset: null,
    rbac: null,
    users: [],
    suppliers: [],
    documents: [],
    dispatch: [],
    byStatus: {},
    purged: null,
    warnings: [],
    refused: false,
    applied: false,
    durationMs: 0,
    notice: FINAL_NOTICE
  };
  try {
    const property = await prisma.property.findUnique({ where: { id: flags.propertyId }, select: { id: true, name: true, code: true, organizationId: true, legalEntityId: true } });
    if (!property) {
      summary.error = `La propiedad ${flags.propertyId} no existe.`;
      summary.durationMs = Date.now() - start;
      return summary;
    }
    summary.propertyName = property.name;
    summary.organizationId = property.organizationId;
    const organizationId = property.organizationId;
    const legalEntity = await prisma.legalEntity.findFirst({ where: { organizationId, ...(property.legalEntityId ? { id: property.legalEntityId } : { isDefault: true }) }, select: { legalName: true, taxId: true } });
    const superUser = await prisma.user.findFirst({ where: { organizationId, email: DEMO_SUPER_USER_EMAIL }, select: { id: true, email: true, organizationId: true, fullName: true } });
    if (!superUser) summary.warnings.push(`No existe ${DEMO_SUPER_USER_EMAIL} en ${organizationId}: sin superusuario demo no se pueden aprobar ni contabilizar las facturas (db:seed del paquete database lo crea).`);

    const dataset = buildDocumentsDemoDataset({
      propertyId: property.id,
      organizationId,
      propertyName: property.name,
      ...(legalEntity?.taxId ? { customer: { legalName: legalEntity.legalName, taxId: legalEntity.taxId } } : {}),
      now,
      seed: flags.seed
    });
    summary.dataset = dataset.stats;

    // Plan (solo lecturas) y guarda demo con entorno explícito desde los flags.
    if (flags.purge) {
      summary.purged = null;
      summary.plan = buildPurgePlan({ organizationId, propertyId: property.id, counts: await countDemoRows(prisma, organizationId, property.id) });
    } else {
      const [users, suppliers, documents, topUps] = await Promise.all([
        prisma.user.count({ where: { organizationId, email: { in: DEMO_USERS.map((user) => user.email) } } }),
        prisma.supplier.count({ where: { organizationId, taxId: { in: DEMO_SUPPLIERS.map((supplier) => supplier.taxId) } } }),
        prisma.incomingDocument.count({ where: { organizationId, propertyId: property.id, title: { startsWith: DEMO_TITLE_PREFIX } } }),
        roleTopUps(prisma, organizationId, superUser)
      ]);
      const existing: ExistingDemoState = { users, suppliers, documents, missingRoleKeys: topUps.reduce((sum, topUp) => sum + topUp.keys.length, 0) };
      summary.plan = buildSeedPlan(dataset, existing);
      for (const topUp of topUps) summary.warnings.push(`top-up de rol ${topUp.label}: +${topUp.keys.length} clave(s) (${topUp.keys.join(", ")})`);
    }
    const explained = explainSeedTarget({ propertyId: property.id, orgId: organizationId, allowReal: flags.allowReal, confirm: flags.confirm, action: SEED_ACTION });
    summary.decision = explained.decision;
    summary.reason = explained.reason;
    // assertDemoTarget imprime el plan y bloquea (sin escribir) si el objetivo no es demo ni está confirmado: con `exit`
    // que no termina el proceso, la guarda lanza y aquí se traduce en `refused` (código de salida 2 tras imprimir el plan).
    try {
      assertDemoTarget(
        { orgId: organizationId, propertyId: property.id, action: `${SEED_ACTION} (${summary.mode}${flags.apply ? ", --apply" : ", dry-run"})`, planned: summary.plan },
        { env: guardEnvFromFlags(flags), log: (line) => summary.guardLog.push(line), exit: () => undefined }
      );
    } catch (error) {
      summary.refused = true;
      summary.reason = summary.reason ?? errorMessage(error);
      summary.durationMs = Date.now() - start;
      return summary;
    }
    if (summary.dryRun) {
      summary.durationMs = Date.now() - start;
      return summary;
    }

    await hydrateAuditChainFromPostgres();
    const correlationId = `${CORRELATION_PREFIX}_${flags.seed}_${property.id.slice(-6)}`;

    if (flags.purge) {
      summary.purged = await purgeDemoRows(organizationId, property.id, summary.warnings);
      recordAuditEvent({ organizationId, propertyId: property.id, actorType: "system", action: "DocumentsDemoPurged", entityType: "incoming_document", afterJson: { ...summary.purged, isDemo: true }, correlationId });
      await flushAuditQueues();
      summary.applied = true;
      summary.durationMs = Date.now() - start;
      return summary;
    }

    const phase1 = await prisma.$transaction((tx) => applyPhase1(tx, dataset, property, superUser), TX_OPTIONS);
    summary.rbac = phase1.rbac;
    summary.users = phase1.users;
    summary.suppliers = phase1.suppliers;

    const centreUser = await prisma.user.findUniqueOrThrow({ where: { id: phase1.userIds.centre }, select: { id: true, email: true, organizationId: true, fullName: true } });
    const officeUser = await prisma.user.findUniqueOrThrow({ where: { id: phase1.userIds.office }, select: { id: true, email: true, organizationId: true, fullName: true } });
    const actors: Actors = {
      centre: await contextOf(centreUser, property.id),
      office: await contextOf(officeUser, property.id),
      superUser: superUser ? await contextOf(superUser, property.id) : await contextOf(officeUser, property.id)
    };
    await applyDocuments(dataset, actors, phase1.supplierIds, correlationId, summary);

    recordAuditEvent({
      organizationId,
      propertyId: property.id,
      actorType: "system",
      action: "DocumentsDemoSeeded",
      entityType: "incoming_document",
      afterJson: {
        seed: flags.seed,
        documents: summary.documents.filter((doc) => doc.created).length,
        byStatus: summary.byStatus,
        supplierBills: summary.documents.filter((doc) => doc.supplierBillId).length,
        goodsReceipts: summary.documents.filter((doc) => doc.goodsReceiptId).length,
        dispatchBatches: summary.dispatch.filter((batch) => batch.batchId).length,
        errors: summary.documents.filter((doc) => doc.error).length,
        isDemo: true
      },
      correlationId
    });
    await flushAuditQueues();
    summary.applied = true;
  } catch (error) {
    summary.error = errorMessage(error);
  }
  summary.durationMs = Date.now() - start;
  return summary;
}

// ───────────────────────────────────────────────────────────── salida

function fmtCounts(counts: PurgePlanCounts | null): string {
  if (!counts) return "—";
  return Object.entries(counts)
    .map(([table, count]) => `${table}=${count}`)
    .join(" · ");
}

export function printHuman(summary: SeedSummary): void {
  const lines: string[] = [];
  lines.push(`${LOG} ${summary.mode === "purge" ? "PURGA" : "SIEMBRA"} · ${summary.dryRun ? "DRY-RUN (nada escrito)" : summary.applied ? "APLICADO" : "NO APLICADO"} · seed ${summary.seed} · ${summary.durationMs} ms`);
  lines.push(`  propiedad ${summary.propertyId}${summary.propertyName ? ` (${summary.propertyName})` : ""} · org ${summary.organizationId ?? "?"} · guarda: ${summary.decision}${summary.reason ? ` — ${summary.reason}` : ""}`);
  if (summary.dataset) {
    const d = summary.dataset;
    lines.push(`  dataset: ${d.documents} documentos (${d.invoices} facturas · ${d.deliveryNotes} albaranes · ${d.correspondence} correspondencia) · pdf ${d.byFormat.pdf} / png ${d.byFormat.png} / xml ${d.byFormat.xml} · objetivo: ${Object.entries(d.byTarget).map(([status, count]) => `${status} ${count}`).join(", ")} · ${d.supplierBills} facturas de proveedor (${d.postedBills} contabilizadas) · ${d.goodsReceipts} recepciones · ${d.tasks} tarea · ${d.dispatchBatches} valijas`);
  }
  lines.push("  plan (impreso también por la guarda):");
  for (const line of summary.guardLog) lines.push(`    ${line}`);
  if (summary.rbac) lines.push(`  rbac: permisos creados ${summary.rbac.permissionsCreated} · claves concedidas ${summary.rbac.grants} · rbac_version ${summary.rbac.rbacVersion ?? "?"}`);
  for (const user of summary.users) lines.push(`  usuario ${user.email}: ${user.created ? "creado" : "existente"} · asignación ${user.assignmentCreated ? "creada" : "existente"} · contraseña ${DEMO_PASSWORD}`);
  for (const supplier of summary.suppliers) lines.push(`  proveedor ${supplier.name} (${supplier.taxId}): ${supplier.created ? "creado" : "existente"}`);
  for (const doc of summary.documents) {
    lines.push(`  ${doc.code.padEnd(6)} ${(doc.registryNumber ?? "—").padEnd(22)} ${(doc.status ?? "—").padEnd(18)} papel ${(doc.physicalStatus ?? "—").padEnd(15)} extracción ${(doc.extraction ?? "—").padEnd(8)} propuesta ${(doc.proposedAction ?? "—").padEnd(21)} ${doc.action}${doc.checksFailed.length > 0 ? ` · override (${doc.checksFailed.join(", ")})` : ""}${doc.supplierBillId ? ` · factura ${doc.supplierBillId}${doc.matchStatus ? ` (${doc.matchStatus})` : ""}` : ""}${doc.goodsReceiptId ? ` · recepción ${doc.goodsReceiptId}` : ""}${doc.error ? ` · ERROR ${doc.error}` : ""}`);
  }
  for (const batch of summary.dispatch) lines.push(`  valija ${batch.key}: ${batch.batchId ? `lote ${batch.batchNumber} (${batch.batchId}) · ${batch.documents} documentos · ${batch.received ? "recibida en la oficina" : "en tránsito"}` : "sin documentos nuevos"}`);
  if (Object.keys(summary.byStatus).length > 0) lines.push(`  documentos demo por estado: ${Object.entries(summary.byStatus).map(([status, count]) => `${status}=${count}`).join(" · ")}`);
  if (summary.purged) lines.push(`  purgado: ${fmtCounts(summary.purged)}`);
  for (const warning of summary.warnings) lines.push(`  WARN ${warning}`);
  if (summary.error) lines.push(`  ERROR ${summary.error}`);
  if (summary.dryRun) lines.push(`  Nada escrito. Repite con --apply${summary.mode === "purge" ? " --purge" : ""} para ejecutar el plan.`);
  lines.push(`  ${FINAL_NOTICE}`);
  console.log(lines.join("\n"));
}

/** Código de salida: 2 guarda/flags · 1 error (incluido un documento que no llegó a su estado) · 0 ok. */
export function exitCodeFor(summary: SeedSummary): number {
  if (summary.refused) return 2;
  if (summary.error) return 1;
  if (summary.applied && summary.documents.some((doc) => doc.error)) return 1;
  return 0;
}

// CLI: solo corre cuando se invoca directamente (misma guarda que seed-reputation-demo.ts).
const entryFile = resolvePath(fileURLToPath(import.meta.url));
const argFile = process.argv[1] ? resolvePath(process.argv[1]) : "";
if (entryFile === argFile) {
  let flags: SeedFlags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    console.error(`${LOG} ${errorMessage(error)}`);
    process.exit(2);
  }
  runSeed(flags)
    .then(async (summary) => {
      if (flags.json) console.log(JSON.stringify(summary, null, 2));
      else printHuman(summary);
      await prisma.$disconnect();
      return exitCodeFor(summary);
    })
    .then((code) => process.exit(code))
    .catch(async (error) => {
      console.error(`${LOG} fallo:`, error);
      await prisma.$disconnect().catch(() => undefined);
      process.exit(1);
    });
}

// Compliance Center — applicability + status-semaphore engine over the
// requirement catalog and per-property items, plus corrective tasks.
import { prisma } from "@hotelos/database";
import { createId } from "../../lib/ids.js";
import { NotFoundError } from "../../lib/http-error.js";
import type { UserContext } from "../../lib/demo-store.js";

const MS_DAY = 86_400_000;

export type ComplianceStatus =
  | "COMPLIANT" | "NON_COMPLIANT" | "PENDING" | "EXPIRED" | "EXPIRING_SOON" | "NOT_APPLICABLE" | "UNDER_REVIEW";

function deriveStatus(
  item: { applies: boolean; status: string; expiryDate: Date | null },
  expiringSoonDays: number,
  today: Date
): ComplianceStatus {
  if (!item.applies) return "NOT_APPLICABLE";
  if (item.status === "UNDER_REVIEW") return "UNDER_REVIEW";
  if (item.expiryDate) {
    if (item.expiryDate.getTime() < today.getTime()) return "EXPIRED";
    if (item.expiryDate.getTime() <= today.getTime() + expiringSoonDays * MS_DAY) return "EXPIRING_SOON";
  }
  if (item.status === "NON_COMPLIANT") return "NON_COMPLIANT";
  if (item.status === "COMPLIANT") return "COMPLIANT";
  return "PENDING";
}

function profileFlag(profile: Record<string, unknown> | null, key: string | null): boolean {
  if (!key) return true;
  return Boolean(profile?.[key]);
}

type ApplicabilityProfile = { autonomousCommunity?: string | null; hotelType?: string | null } & Record<string, unknown>;
type ApplicabilityReq = { appliesRule: string | null; defaultApplies: boolean; autonomousCommunity: string | null; hotelTypes: string[] };

// Effective applicability is COMPUTED from the property profile (feature flags +
// autonomous community + hotel type). This is what makes the "template per CA /
// hotel type" work: change the profile and the matrix recomputes which
// obligations apply, without re-seeding.
function computeApplies(req: ApplicabilityReq, profile: ApplicabilityProfile | null): boolean {
  const base = req.appliesRule ? profileFlag(profile, req.appliesRule) : req.defaultApplies;
  const communityOk = !req.autonomousCommunity || req.autonomousCommunity === (profile?.autonomousCommunity ?? null);
  const hotelTypeOk = !req.hotelTypes?.length || (!!profile?.hotelType && req.hotelTypes.includes(profile.hotelType));
  return base && communityOk && hotelTypeOk;
}

export async function getComplianceCenter(propertyId: string) {
  const today = new Date();
  const [profile, areas, requirements, items, documents] = await Promise.all([
    prisma.compliancePropertyProfile.findUnique({ where: { propertyId } }),
    prisma.complianceArea.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } }),
    prisma.complianceRequirement.findMany({ where: { active: true } }),
    prisma.complianceItem.findMany({ where: { propertyId } }),
    prisma.complianceDocument.findMany({ where: { propertyId, isCurrent: true }, select: { requirementCode: true } })
  ]);
  const expiringSoonDays = profile?.expiringSoonDays ?? 30;
  const itemByReq = new Map(items.map((i) => [i.requirementCode, i]));
  const docCountByReq = new Map<string, number>();
  for (const d of documents) {
    if (d.requirementCode) docCountByReq.set(d.requirementCode, (docCountByReq.get(d.requirementCode) ?? 0) + 1);
  }
  const areaName = new Map(areas.map((a) => [a.code, a.name]));

  const controls = requirements
    .map((req) => {
      const item = itemByReq.get(req.code);
      const computed = computeApplies(req, profile as ApplicabilityProfile | null);
      const override = item?.appliesOverride;
      const applies = override === null || override === undefined ? computed : override;
      const base = item
        ? { applies, status: item.status, expiryDate: item.expiryDate }
        : { applies, status: "PENDING", expiryDate: null as Date | null };
      const status = deriveStatus(base, expiringSoonDays, today);
      return {
        code: req.code,
        title: req.title,
        areaCode: req.areaCode,
        areaName: areaName.get(req.areaCode) ?? req.areaCode,
        riskLevel: req.riskLevel,
        jurisdiction: req.jurisdiction,
        autonomousCommunity: req.autonomousCommunity ?? null,
        hotelTypes: req.hotelTypes ?? [],
        legalReference: req.legalReference,
        appliesWhen: req.appliesWhen,
        requiredDocuments: req.requiredDocuments,
        documentsCount: docCountByReq.get(req.code) ?? 0,
        applies,
        status,
        responsibleName: item?.responsibleName ?? null,
        externalAdvisorName: item?.externalAdvisorName ?? null,
        issueDate: item?.issueDate ?? null,
        expiryDate: item?.expiryDate ?? null,
        lastReviewDate: item?.lastReviewDate ?? null,
        nextReviewDate: item?.nextReviewDate ?? null,
        notes: item?.notes ?? null,
        correctiveAction: item?.correctiveAction ?? null,
        notApplicableReason: item?.notApplicableReason ?? null
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));

  const kpis = {
    total: controls.length,
    applicable: controls.filter((c) => c.applies).length,
    compliant: controls.filter((c) => c.status === "COMPLIANT").length,
    nonCompliant: controls.filter((c) => c.status === "NON_COMPLIANT").length,
    expired: controls.filter((c) => c.status === "EXPIRED").length,
    expiringSoon: controls.filter((c) => c.status === "EXPIRING_SOON").length,
    pending: controls.filter((c) => c.status === "PENDING").length,
    underReview: controls.filter((c) => c.status === "UNDER_REVIEW").length,
    notApplicable: controls.filter((c) => c.status === "NOT_APPLICABLE").length,
    criticalOpen: controls.filter((c) => c.riskLevel === "CRITICAL" && ["NON_COMPLIANT", "EXPIRED", "PENDING"].includes(c.status)).length,
    compliancePct: 0
  };
  kpis.compliancePct = kpis.applicable > 0 ? Math.round((kpis.compliant / kpis.applicable) * 100) : 0;

  const byArea = areas.map((a) => {
    const list = controls.filter((c) => c.areaCode === a.code && c.applies);
    return {
      code: a.code,
      name: a.name,
      total: list.length,
      compliant: list.filter((c) => c.status === "COMPLIANT").length,
      pending: list.filter((c) => c.status === "PENDING" || c.status === "UNDER_REVIEW").length,
      expiringSoon: list.filter((c) => c.status === "EXPIRING_SOON").length,
      expired: list.filter((c) => c.status === "EXPIRED").length,
      nonCompliant: list.filter((c) => c.status === "NON_COMPLIANT").length,
      critical: list.filter((c) => c.riskLevel === "CRITICAL" && c.status !== "COMPLIANT").length
    };
  }).filter((a) => a.total > 0);

  return { propertyId, asOf: today.toISOString(), profile, kpis, areas: byArea, controls };
}

export async function updateComplianceItem(input: {
  context: UserContext;
  propertyId: string;
  requirementCode: string;
  patch: {
    applies?: boolean;
    status?: string;
    responsibleName?: string;
    externalAdvisorName?: string;
    issueDate?: string | null;
    expiryDate?: string | null;
    lastReviewDate?: string | null;
    nextReviewDate?: string | null;
    notes?: string;
    correctiveAction?: string;
    notApplicableReason?: string;
  };
}) {
  const req = await prisma.complianceRequirement.findUnique({ where: { code: input.requirementCode } });
  if (!req) throw new NotFoundError("Requisito de cumplimiento no encontrado.");
  const p = input.patch;
  const data: Record<string, unknown> = {};
  // A manual applies/no-aplica decision is stored as an override that wins over
  // the computed template applicability.
  if (p.applies !== undefined) { data.appliesOverride = p.applies; data.applies = p.applies; }
  if (p.status !== undefined) data.status = p.status;
  if (p.responsibleName !== undefined) data.responsibleName = p.responsibleName;
  if (p.externalAdvisorName !== undefined) data.externalAdvisorName = p.externalAdvisorName;
  if (p.issueDate !== undefined) data.issueDate = p.issueDate ? new Date(p.issueDate) : null;
  if (p.expiryDate !== undefined) data.expiryDate = p.expiryDate ? new Date(p.expiryDate) : null;
  if (p.lastReviewDate !== undefined) data.lastReviewDate = p.lastReviewDate ? new Date(p.lastReviewDate) : null;
  if (p.nextReviewDate !== undefined) data.nextReviewDate = p.nextReviewDate ? new Date(p.nextReviewDate) : null;
  if (p.notes !== undefined) data.notes = p.notes;
  if (p.correctiveAction !== undefined) data.correctiveAction = p.correctiveAction;
  if (p.notApplicableReason !== undefined) data.notApplicableReason = p.notApplicableReason;

  const item = await prisma.complianceItem.upsert({
    where: { propertyId_requirementCode: { propertyId: input.propertyId, requirementCode: input.requirementCode } },
    create: {
      propertyId: input.propertyId,
      requirementCode: input.requirementCode,
      applies: p.applies ?? req.defaultApplies,
      status: p.status ?? "PENDING",
      ...data
    },
    update: data
  });
  return item;
}

// Editing the profile re-templates the matrix: which obligations apply is
// recomputed from autonomous community + hotel type + feature flags.
export async function updateComplianceProfile(input: {
  context: UserContext;
  propertyId: string;
  patch: Partial<{
    autonomousCommunity: string | null;
    hotelType: string | null;
    hasRestaurant: boolean; hasKitchen: boolean; hasPool: boolean; hasSpa: boolean;
    hasParking: boolean; hasEvents: boolean; hasTerrace: boolean; hasLaundry: boolean;
    buildingProtected: boolean; expiringSoonDays: number;
  }>;
}) {
  const keys = ["autonomousCommunity", "hotelType", "hasRestaurant", "hasKitchen", "hasPool", "hasSpa", "hasParking", "hasEvents", "hasTerrace", "hasLaundry", "buildingProtected", "expiringSoonDays"] as const;
  const p = input.patch as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const key of keys) if (p[key] !== undefined) data[key] = p[key];
  return prisma.compliancePropertyProfile.upsert({
    where: { propertyId: input.propertyId },
    create: { propertyId: input.propertyId, ...data },
    update: data
  });
}

export async function listComplianceTasks(propertyId: string) {
  return prisma.complianceTask.findMany({ where: { propertyId }, orderBy: [{ status: "asc" }, { createdAt: "desc" }] });
}

export async function createComplianceTask(input: {
  context: UserContext;
  propertyId: string;
  requirementCode?: string;
  title: string;
  description?: string;
  assignedToName?: string;
  priority?: string;
  dueDate?: string;
}) {
  return prisma.complianceTask.create({
    data: {
      propertyId: input.propertyId,
      requirementCode: input.requirementCode ?? null,
      title: input.title,
      description: input.description ?? null,
      assignedToName: input.assignedToName ?? null,
      priority: input.priority ?? "MEDIUM",
      dueDate: input.dueDate ? new Date(input.dueDate) : null
    }
  });
}

export async function updateComplianceTask(input: { context: UserContext; taskId: string; patch: { status?: string; priority?: string; assignedToName?: string; dueDate?: string | null } }) {
  const existing = await prisma.complianceTask.findUnique({ where: { id: input.taskId } });
  if (!existing) throw new NotFoundError("Tarea no encontrada.");
  const p = input.patch;
  const data: Record<string, unknown> = {};
  if (p.status !== undefined) {
    data.status = p.status;
    data.completedAt = p.status === "DONE" ? new Date() : null;
  }
  if (p.priority !== undefined) data.priority = p.priority;
  if (p.assignedToName !== undefined) data.assignedToName = p.assignedToName;
  if (p.dueDate !== undefined) data.dueDate = p.dueDate ? new Date(p.dueDate) : null;
  return prisma.complianceTask.update({ where: { id: input.taskId }, data });
}

export async function deleteComplianceTask(input: { context: UserContext; taskId: string }) {
  const existing = await prisma.complianceTask.findUnique({ where: { id: input.taskId } });
  if (!existing) throw new NotFoundError("Tarea no encontrada.");
  await prisma.complianceTask.delete({ where: { id: input.taskId } });
  return { ok: true, id: input.taskId };
}

// --- Document Vault ---------------------------------------------------------
// Documents are the evidence that justifies each obligation. We persist their
// metadata (no binary store exists in this codebase, so we are honest about
// that: the vault tracks the document record + dates, not the raw file bytes).

export async function listComplianceDocuments(propertyId: string, requirementCode?: string) {
  return prisma.complianceDocument.findMany({
    where: { propertyId, ...(requirementCode ? { requirementCode } : {}) },
    orderBy: [{ isCurrent: "desc" }, { uploadedAt: "desc" }]
  });
}

export async function createComplianceDocument(input: {
  context: UserContext;
  propertyId: string;
  requirementCode?: string | null;
  areaCode?: string | null;
  title: string;
  documentType?: string;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  issueDate?: string | null;
  expiryDate?: string | null;
  issuingAuthority?: string;
  providerName?: string;
  notes?: string;
  tags?: string[];
  syncControl?: boolean;
}) {
  let areaCode = input.areaCode ?? null;
  let req = null as Awaited<ReturnType<typeof prisma.complianceRequirement.findUnique>> | null;
  if (input.requirementCode) {
    req = await prisma.complianceRequirement.findUnique({ where: { code: input.requirementCode } });
    if (!areaCode) areaCode = req?.areaCode ?? null;
  }

  const issueDate = input.issueDate ? new Date(input.issueDate) : null;
  const expiryDate = input.expiryDate ? new Date(input.expiryDate) : null;

  const doc = await prisma.complianceDocument.create({
    data: {
      propertyId: input.propertyId,
      requirementCode: input.requirementCode ?? null,
      areaCode,
      title: input.title,
      documentType: input.documentType ?? null,
      fileName: input.fileName ?? input.title,
      mimeType: input.mimeType ?? null,
      fileSize: input.fileSize ?? 0,
      issueDate,
      expiryDate,
      issuingAuthority: input.issuingAuthority ?? null,
      providerName: input.providerName ?? null,
      uploadedByUserId: input.context?.userId ?? null,
      tags: input.tags ?? [],
      notes: input.notes ?? null
    }
  });

  // The document justifies the control: sync the item's dates + status so the
  // matrix reflects reality without a second manual edit.
  if (req && input.syncControl !== false) {
    const existing = await prisma.complianceItem.findUnique({
      where: { propertyId_requirementCode: { propertyId: input.propertyId, requirementCode: req.code } }
    });
    const data: Record<string, unknown> = {};
    if (issueDate) data.issueDate = issueDate;
    if (expiryDate) data.expiryDate = expiryDate;
    // Auto-mark compliant unless the control was explicitly flagged otherwise.
    const keepStatus = existing && ["NON_COMPLIANT", "UNDER_REVIEW"].includes(existing.status);
    if (!keepStatus) data.status = "COMPLIANT";
    await prisma.complianceItem.upsert({
      where: { propertyId_requirementCode: { propertyId: input.propertyId, requirementCode: req.code } },
      create: {
        propertyId: input.propertyId,
        requirementCode: req.code,
        applies: existing?.applies ?? req.defaultApplies,
        status: (data.status as string) ?? existing?.status ?? "COMPLIANT",
        issueDate,
        expiryDate
      },
      update: data
    });
  }
  return doc;
}

export async function deleteComplianceDocument(input: { context: UserContext; documentId: string }) {
  const existing = await prisma.complianceDocument.findUnique({ where: { id: input.documentId } });
  if (!existing) throw new NotFoundError("Documento no encontrado.");
  await prisma.complianceDocument.delete({ where: { id: input.documentId } });
  return { ok: true, id: input.documentId };
}

// --- Alerts -----------------------------------------------------------------
// What needs attention right now: expired / expiring obligations, non-conform
// controls, applicable controls missing their justifying documents, and
// corrective tasks past their due date.

export type ComplianceAlertKind = "EXPIRED" | "EXPIRING_SOON" | "NON_COMPLIANT" | "MISSING_DOCUMENT" | "TASK_OVERDUE";
export type ComplianceAlertSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export type ComplianceAlert = {
  id: string;
  kind: ComplianceAlertKind;
  severity: ComplianceAlertSeverity;
  requirementCode?: string | null;
  areaCode?: string | null;
  areaName?: string | null;
  title: string;
  detail: string;
  dueDate?: string | null;
  daysOverdue?: number | null;
};

const SEVERITY_RANK: Record<ComplianceAlertSeverity, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

export async function getComplianceAlerts(propertyId: string) {
  const today = new Date();
  const center = await getComplianceCenter(propertyId);
  const alerts: ComplianceAlert[] = [];

  for (const c of center.controls) {
    if (!c.applies) continue;
    const risk = c.riskLevel as ComplianceAlertSeverity;
    if (c.status === "EXPIRED") {
      const days = c.expiryDate ? Math.floor((today.getTime() - new Date(c.expiryDate).getTime()) / MS_DAY) : null;
      alerts.push({
        id: `exp-${c.code}`, kind: "EXPIRED", severity: risk, requirementCode: c.code, areaCode: c.areaCode, areaName: c.areaName,
        title: c.title, detail: c.expiryDate ? `Caducó el ${new Date(c.expiryDate).toLocaleDateString("es-ES")}` : "Documento caducado",
        dueDate: c.expiryDate ? new Date(c.expiryDate).toISOString() : null, daysOverdue: days
      });
    } else if (c.status === "EXPIRING_SOON") {
      const days = c.expiryDate ? Math.ceil((new Date(c.expiryDate).getTime() - today.getTime()) / MS_DAY) : null;
      alerts.push({
        id: `soon-${c.code}`, kind: "EXPIRING_SOON", severity: risk === "CRITICAL" ? "HIGH" : "MEDIUM", requirementCode: c.code, areaCode: c.areaCode, areaName: c.areaName,
        title: c.title, detail: days != null ? `Vence en ${days} día${days === 1 ? "" : "s"}` : "Vence pronto",
        dueDate: c.expiryDate ? new Date(c.expiryDate).toISOString() : null, daysOverdue: null
      });
    } else if (c.status === "NON_COMPLIANT") {
      alerts.push({
        id: `nc-${c.code}`, kind: "NON_COMPLIANT", severity: risk, requirementCode: c.code, areaCode: c.areaCode, areaName: c.areaName,
        title: c.title, detail: c.correctiveAction || "Control marcado como no conforme.", dueDate: null, daysOverdue: null
      });
    }
    // Applicable control that requires documents but has none on file.
    if (c.requiredDocuments.length > 0 && c.documentsCount === 0 && c.status !== "NOT_APPLICABLE") {
      alerts.push({
        id: `doc-${c.code}`, kind: "MISSING_DOCUMENT", severity: risk === "CRITICAL" ? "HIGH" : risk === "HIGH" ? "MEDIUM" : "LOW",
        requirementCode: c.code, areaCode: c.areaCode, areaName: c.areaName, title: c.title,
        detail: `Sin documento que lo justifique: ${c.requiredDocuments.join(", ")}`, dueDate: null, daysOverdue: null
      });
    }
  }

  // Overdue corrective tasks.
  const overdue = await prisma.complianceTask.findMany({
    where: { propertyId, status: { not: "DONE" }, dueDate: { lt: today } },
    orderBy: { dueDate: "asc" }
  });
  for (const t of overdue) {
    const days = t.dueDate ? Math.floor((today.getTime() - t.dueDate.getTime()) / MS_DAY) : null;
    alerts.push({
      id: `task-${t.id}`, kind: "TASK_OVERDUE", severity: t.priority === "HIGH" ? "HIGH" : t.priority === "LOW" ? "LOW" : "MEDIUM",
      requirementCode: t.requirementCode, areaCode: null, areaName: null, title: t.title,
      detail: days != null ? `Tarea vencida hace ${days} día${days === 1 ? "" : "s"}` : "Tarea vencida",
      dueDate: t.dueDate ? t.dueDate.toISOString() : null, daysOverdue: days
    });
  }

  alerts.sort((a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) || ((b.daysOverdue ?? 0) - (a.daysOverdue ?? 0)));

  const byKind = alerts.reduce<Record<string, number>>((acc, a) => { acc[a.kind] = (acc[a.kind] ?? 0) + 1; return acc; }, {});
  const bySeverity = alerts.reduce<Record<string, number>>((acc, a) => { acc[a.severity] = (acc[a.severity] ?? 0) + 1; return acc; }, {});
  return { propertyId, asOf: today.toISOString(), count: alerts.length, byKind, bySeverity, alerts };
}

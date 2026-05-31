// Frontend client for the Compliance Center.
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";

export type ComplianceStatus =
  | "COMPLIANT" | "NON_COMPLIANT" | "PENDING" | "EXPIRED" | "EXPIRING_SOON" | "NOT_APPLICABLE" | "UNDER_REVIEW";

export type ComplianceControl = {
  code: string;
  title: string;
  areaCode: string;
  areaName: string;
  riskLevel: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  jurisdiction: string;
  autonomousCommunity?: string | null;
  hotelTypes?: string[];
  legalReference?: string | null;
  appliesWhen?: string | null;
  requiredDocuments: string[];
  documentsCount: number;
  applies: boolean;
  status: ComplianceStatus;
  responsibleName?: string | null;
  externalAdvisorName?: string | null;
  issueDate?: string | null;
  expiryDate?: string | null;
  lastReviewDate?: string | null;
  nextReviewDate?: string | null;
  notes?: string | null;
  correctiveAction?: string | null;
  notApplicableReason?: string | null;
};

export type ComplianceAreaSummary = {
  code: string; name: string; total: number; compliant: number; pending: number; expiringSoon: number; expired: number; nonCompliant: number; critical: number;
};

export type ComplianceKpis = {
  total: number; applicable: number; compliant: number; nonCompliant: number; expired: number; expiringSoon: number; pending: number; underReview: number; notApplicable: number; criticalOpen: number; compliancePct: number;
};

export type ComplianceProfile = {
  propertyId: string;
  autonomousCommunity?: string | null;
  hotelType?: string | null;
  hasRestaurant: boolean; hasKitchen: boolean; hasPool: boolean; hasSpa: boolean;
  hasParking: boolean; hasEvents: boolean; hasTerrace: boolean; hasLaundry: boolean;
  buildingProtected: boolean; expiringSoonDays: number;
};

export type ComplianceCenter = {
  propertyId: string;
  asOf: string;
  profile: ComplianceProfile | null;
  kpis: ComplianceKpis;
  areas: ComplianceAreaSummary[];
  controls: ComplianceControl[];
};

export type ComplianceTask = {
  id: string; propertyId: string; requirementCode?: string | null; title: string; description?: string | null;
  assignedToName?: string | null; status: string; priority: string; dueDate?: string | null; completedAt?: string | null; createdAt: string;
};

export type ComplianceDocument = {
  id: string; propertyId: string; requirementCode?: string | null; areaCode?: string | null;
  title: string; documentType?: string | null; fileName: string; mimeType?: string | null; fileSize: number;
  issueDate?: string | null; expiryDate?: string | null; issuingAuthority?: string | null; providerName?: string | null;
  isCurrent: boolean; uploadedAt: string; tags: string[]; notes?: string | null;
};

export type ComplianceAlertKind = "EXPIRED" | "EXPIRING_SOON" | "NON_COMPLIANT" | "MISSING_DOCUMENT" | "TASK_OVERDUE";
export type ComplianceAlertSeverity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type ComplianceAlert = {
  id: string; kind: ComplianceAlertKind; severity: ComplianceAlertSeverity;
  requirementCode?: string | null; areaCode?: string | null; areaName?: string | null;
  title: string; detail: string; dueDate?: string | null; daysOverdue?: number | null;
};
export type ComplianceAlertsResponse = {
  propertyId: string; asOf: string; count: number;
  byKind: Record<string, number>; bySeverity: Record<string, number>; alerts: ComplianceAlert[];
};

export function fetchComplianceCenter(propertyId = getActivePropertyId()) {
  return apiRequest<ComplianceCenter>(`/compliance/properties/${propertyId}/center`);
}
export function updateComplianceItem(requirementCode: string, patch: Record<string, unknown>, propertyId = getActivePropertyId()) {
  return apiRequest(`/compliance/properties/${propertyId}/items/${requirementCode}`, { method: "PATCH", body: patch });
}
export function updateComplianceProfile(patch: Partial<Omit<ComplianceProfile, "propertyId">>, propertyId = getActivePropertyId()) {
  return apiRequest<ComplianceProfile>(`/compliance/properties/${propertyId}/profile`, { method: "PATCH", body: patch });
}
export function fetchComplianceTasks(propertyId = getActivePropertyId()) {
  return apiRequest<ComplianceTask[]>(`/compliance/properties/${propertyId}/tasks`);
}
export function createComplianceTask(payload: { requirementCode?: string; title: string; priority?: string; dueDate?: string; assignedToName?: string }, propertyId = getActivePropertyId()) {
  return apiRequest<ComplianceTask>(`/compliance/properties/${propertyId}/tasks`, { method: "POST", body: payload });
}
export function updateComplianceTask(id: string, patch: { status?: string; priority?: string }) {
  return apiRequest<ComplianceTask>(`/compliance/tasks/${id}`, { method: "PATCH", body: patch });
}
export function deleteComplianceTask(id: string) {
  return apiRequest<{ ok: boolean; id: string }>(`/compliance/tasks/${id}`, { method: "DELETE" });
}

export async function fetchComplianceDocuments(requirementCode?: string, propertyId = getActivePropertyId()) {
  const qs = requirementCode ? `?requirementCode=${encodeURIComponent(requirementCode)}` : "";
  const res = await apiRequest<{ items: ComplianceDocument[] }>(`/compliance/properties/${propertyId}/documents${qs}`);
  return res.items;
}
export function createComplianceDocument(payload: {
  requirementCode?: string; areaCode?: string; title: string; documentType?: string;
  fileName?: string; mimeType?: string; fileSize?: number; issueDate?: string; expiryDate?: string;
  issuingAuthority?: string; providerName?: string; notes?: string; tags?: string[]; syncControl?: boolean;
}, propertyId = getActivePropertyId()) {
  return apiRequest<ComplianceDocument>(`/compliance/properties/${propertyId}/documents`, { method: "POST", body: payload });
}
export function deleteComplianceDocument(id: string) {
  return apiRequest<{ ok: boolean; id: string }>(`/compliance/documents/${id}`, { method: "DELETE" });
}
export function fetchComplianceAlerts(propertyId = getActivePropertyId()) {
  return apiRequest<ComplianceAlertsResponse>(`/compliance/properties/${propertyId}/alerts`);
}

export type InspectionFolder = {
  filename: string;
  generatedAt: string;
  summary: { applicable: number; compliancePct: number; expired: number; criticalOpen: number; documents: number; openAlerts: number };
  html: string;
};
export function fetchInspectionFolder(preparedBy?: string, propertyId = getActivePropertyId()) {
  const qs = preparedBy ? `?preparedBy=${encodeURIComponent(preparedBy)}` : "";
  return apiRequest<InspectionFolder>(`/compliance/properties/${propertyId}/inspection-folder${qs}`);
}

export type ComplianceSuggestion = {
  id: string;
  kind: "MISSING_DOCUMENT" | "RENEW" | "CORRECT" | "REVIEW";
  priority: "HIGH" | "MEDIUM" | "LOW";
  requirementCode: string;
  controlTitle: string;
  areaName: string;
  action: string;
  taskTitle: string;
  taskPriority: "HIGH" | "MEDIUM" | "LOW";
};
export type ComplianceAssistant = {
  propertyId: string;
  generatedAt: string;
  provider: string;
  narrativeSource: "ai" | "rules";
  narrative: string;
  count: number;
  byPriority: Record<string, number>;
  suggestions: ComplianceSuggestion[];
};
export function fetchComplianceAssistant(propertyId = getActivePropertyId()) {
  return apiRequest<ComplianceAssistant>(`/compliance/properties/${propertyId}/assistant`);
}

export type OcrDatesResult = {
  aiGenerated: boolean;
  provider: string;
  reason?: string;
  fields: { documentType?: string; issuingAuthority?: string; issueDate?: string; expiryDate?: string };
};
export function extractDocumentDates(imageDataUrl: string) {
  return apiRequest<OcrDatesResult>(`/compliance/ocr/extract-dates`, { method: "POST", body: { imageDataUrl } });
}

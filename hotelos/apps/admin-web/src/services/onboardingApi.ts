import { apiRequest } from "./api-client";

// ---- Sprint 53 — AI Onboarding & Migration API helpers ----
// Typed wrappers around the frozen onboarding contract. The screens drive the
// upload -> classify -> extract -> generate-mappings -> approve pipeline through
// these helpers. Shapes follow the frozen contract; Sprint 52 owns the backend
// that fulfils them. Where the live backend still returns its legacy shape, the
// screens normalise defensively (see normalizeEntity / normalizeSuggestion) so
// the UI degrades gracefully instead of crashing.

export type OnboardingProject = {
  id: string;
  name?: string;
  sourceSystem?: string;
  status?: string;
  progress?: number;
  confidence?: number;
  blockingIssues?: number;
  targetGoLiveDate?: string;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
};

export type OnboardingFile = {
  id: string;
  fileName?: string;
  fileType?: string;
  detectedDocumentType?: string;
  status?: string;
  extractionStatus?: string;
  confidence?: number;
  [key: string]: unknown;
};

export type ExtractedEntity = {
  id: string;
  entityType: string;
  sourceRef: string;
  confidence: number;
  fields: Record<string, unknown>;
  warnings: string[];
};

export type MappingSuggestion = {
  id: string;
  mappingType: string;
  sourceValue: string;
  targetValue: string;
  confidence: number;
  status: string;
  rationale: string;
};

export type ExtractSummary = {
  totalEntities: number;
  avgConfidence: number;
  warnings: number;
};

export type ExtractResult = {
  file: OnboardingFile;
  extractedEntities: ExtractedEntity[];
  summary?: ExtractSummary;
  [key: string]: unknown;
};

export type GenerateMappingsResult = {
  suggestions: MappingSuggestion[];
  summary?: { total?: number; pending?: number; avgConfidence?: number; [key: string]: unknown };
  [key: string]: unknown;
};

// localStorage key for the active onboarding project across screens.
export const ACTIVE_PROJECT_KEY = "onboarding-active-project";

export function getActiveProjectId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_PROJECT_KEY);
  } catch {
    return null;
  }
}

export function setActiveProjectId(projectId: string): void {
  try {
    window.localStorage.setItem(ACTIVE_PROJECT_KEY, projectId);
  } catch {
    /* ignore storage failures (private mode, etc.) */
  }
}

// ---- Projects ----

export async function listProjects(): Promise<OnboardingProject[]> {
  const res = await apiRequest<{ items: OnboardingProject[] }>("/onboarding/projects");
  return res.items ?? [];
}

export async function createProject(payload: { name?: string; sourceSystem?: string } = {}): Promise<OnboardingProject> {
  return apiRequest<OnboardingProject>("/onboarding/projects", { method: "POST", body: payload });
}

// ---- Files: upload -> classify -> extract ----

export async function uploadFile(
  projectId: string,
  payload: { fileName: string; fileType: string; content: string }
): Promise<OnboardingFile> {
  return apiRequest<OnboardingFile>(`/onboarding/projects/${projectId}/files`, { method: "POST", body: payload });
}

export async function classifyFile(fileId: string): Promise<OnboardingFile> {
  return apiRequest<OnboardingFile>(`/onboarding/files/${fileId}/classify`, { method: "POST" });
}

export async function extractFile(fileId: string): Promise<ExtractResult> {
  return apiRequest<ExtractResult>(`/onboarding/files/${fileId}/extract`, { method: "POST" });
}

// ---- Extracted entities ----

export async function listExtractedEntities(projectId: string): Promise<ExtractedEntity[]> {
  const res = await apiRequest<{ items: unknown[] }>(`/onboarding/projects/${projectId}/extracted-entities`);
  return (res.items ?? []).map(normalizeEntity);
}

// ---- Mappings ----

export async function generateMappings(projectId: string): Promise<GenerateMappingsResult> {
  return apiRequest<GenerateMappingsResult>(`/onboarding/projects/${projectId}/ai/generate-mappings`, { method: "POST" });
}

export async function listMappingSuggestions(projectId: string): Promise<MappingSuggestion[]> {
  const res = await apiRequest<{ items: unknown[] }>(`/onboarding/projects/${projectId}/mapping-suggestions`);
  return (res.items ?? []).map(normalizeSuggestion);
}

export async function approveMapping(id: string): Promise<MappingSuggestion> {
  const res = await apiRequest<unknown>(`/onboarding/mapping-suggestions/${id}/approve`, { method: "PATCH" });
  return normalizeSuggestion(res);
}

export type AiMappingSuggestion = {
  configured: boolean;
  message?: string;
  suggestion?: { target: string; confidence: number; rationale: string } | null;
};

export async function aiSuggestMapping(input: { sourceValue: string; targetType: string }): Promise<AiMappingSuggestion> {
  return apiRequest<AiMappingSuggestion>(`/onboarding/ai/suggest-mapping`, { method: "POST", body: input });
}

export async function rejectMapping(id: string): Promise<MappingSuggestion> {
  const res = await apiRequest<unknown>(`/onboarding/mapping-suggestions/${id}/reject`, { method: "PATCH" });
  return normalizeSuggestion(res);
}

export async function editMapping(id: string, targetValue: string): Promise<MappingSuggestion> {
  const res = await apiRequest<unknown>(`/onboarding/mapping-suggestions/${id}/edit`, {
    method: "PATCH",
    body: { targetValue }
  });
  return normalizeSuggestion(res);
}

// ---- Defensive normalisation ----
// The frozen contract is the target. If the live backend is still emitting its
// legacy shape (sourceType/sourceIdentifier/rawJson, targetEntityType/
// suggestedTargetJson/reasonJson, etc.) these helpers translate it so the
// screens render either way.

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown, fallback = ""): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => asString(v)).filter(Boolean);
  if (typeof value === "string" && value) return [value];
  return [];
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function normalizeEntity(raw: unknown): ExtractedEntity {
  const e = asRecord(raw);
  const fields =
    "fields" in e
      ? asRecord(e.fields)
      : "normalizedJson" in e
        ? asRecord(e.normalizedJson)
        : asRecord(e.rawJson);
  return {
    id: asString(e.id),
    entityType: asString(e.entityType ?? e.sourceType, "unknown"),
    sourceRef: asString(e.sourceRef ?? e.sourceIdentifier ?? e.id),
    confidence: asNumber(e.confidence),
    fields,
    warnings: asStringArray(e.warnings ?? e.warningsJson ?? e.missingDataJson)
  };
}

export function normalizeSuggestion(raw: unknown): MappingSuggestion {
  const s = asRecord(raw);
  const target =
    "targetValue" in s
      ? asString(s.targetValue)
      : compactRecord(asRecord(s.suggestedTargetJson));
  const rationale =
    "rationale" in s
      ? asString(s.rationale)
      : asStringArray(s.reasonJson).join(" ");
  return {
    id: asString(s.id),
    mappingType: asString(s.mappingType ?? s.targetEntityType, "mapping"),
    sourceValue: asString(s.sourceValue ?? s.sourceEntityId, "—"),
    targetValue: target || "—",
    confidence: asNumber(s.confidence),
    status: asString(s.status, "pending"),
    rationale: rationale || "—"
  };
}

function compactRecord(record: Record<string, unknown>): string {
  const entries = Object.entries(record).slice(0, 3);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}: ${asString(v)}`).join(", ");
}

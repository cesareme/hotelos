// Back Office API client (Setup Center, property setup forms, configuration
// categories). Every call goes through `apiRequest` so it carries the session
// JWT, the tenant context and the shared 401 handling (Tanda 3 · CF-05). Errors
// surface as `ApiError` (extends Error, carries `.status`), so callers that only
// read `error.message` keep working.

import { apiRequest } from "./api-client";

export type PropertySetupFormField = {
  key: string;
  label: string;
  inputType: string;
  required?: boolean;
  categoryCode?: string;
  options?: string[];
  mapsTo?: string;
};

export type PropertySetupForm = {
  code: string;
  title: string;
  route: string;
  apiRoute: string;
  description: string;
  permission: string;
  targetEntityType: string;
  inputCategories: string[];
  fields: PropertySetupFormField[];
  dataQualityChecks: string[];
  status?: string;
  latestSubmission?: unknown;
  existingData?: unknown;
  categoryOptions?: Array<{ fieldKey: string; categoryCode?: string; options: unknown[] }>;
  dataQuality?: Array<{ code: string; severity: string; message: string }>;
  submissions?: unknown[];
};

export type ManualSetupOption = {
  code: string;
  group: string;
  label: string;
  description: string;
  moduleCode?: string;
  adminPath: string;
  mobileRoute?: string;
  screen: string;
  permission: string;
  apiEndpoint?: string;
  saveEndpoint?: string;
  targetTables: string[];
  inputCategories: string[];
  requiredInputs: string[];
  inputMethods: Array<{ code: string; label: string; description: string; requiresReview?: boolean }>;
  completionChecks: Array<{ code: string; label: string; severity: "blocking" | "warning" | "info" }>;
  status: "ready" | "needs_setup" | "coming_soon";
  moduleEnabled?: boolean;
  localDemoReason?: string;
  setupState?: "not_started" | "saved" | "failed";
  latestSubmission?: {
    id: string;
    status: "saved" | "failed";
    createdAt: string;
    validationErrorsJson?: string[];
  };
};

export type ManualSetupCoverage = {
  totalOptions: number;
  uncheckedOptions: number;
  warningOptions: number;
  issues: Array<{ optionCode: string; field: string; severity: "blocking" | "warning"; message: string }>;
};

export type ManualSetupSummary = {
  totalOptions: number;
  savedOptions: number;
  failedOptions: number;
  notStartedOptions: number;
};

export type ConfigurationCategoryOption = {
  id: string;
  code: string;
  label: string;
  description?: string;
  colorToken?: string;
  iconName?: string;
  parentOptionId?: string;
  active: boolean;
  sortOrder: number;
  usageCount: number;
  canDelete?: boolean;
  canDeactivate?: boolean;
  linkedRecordsUrl?: string;
};

export type ConfigurationCategory = {
  id: string;
  code: string;
  name: string;
  description?: string;
  categoryGroup: string;
  entityType?: string;
  mode: "system_controlled" | "property_editable" | "property_extendable" | "read_only";
  active: boolean;
  sortOrder: number;
  options: ConfigurationCategoryOption[];
  activeOptions: number;
  inactiveOptions: number;
};

export type ConfigurationCategoryGroup = {
  group: string;
  categories: ConfigurationCategory[];
};

export type ManualSetupOptionsResponse = {
  propertyId: string;
  coverage: ManualSetupCoverage;
  setupSummary: ManualSetupSummary;
  options: ManualSetupOption[];
};

const propertyPath = (propertyId: string) => `/backoffice/properties/${encodeURIComponent(propertyId)}`;

export function fetchPropertySetupForms(propertyId: string): Promise<{ propertyId: string; forms: PropertySetupForm[] }> {
  return apiRequest<{ propertyId: string; forms: PropertySetupForm[] }>(`${propertyPath(propertyId)}/property-setup/forms`);
}

export function fetchManualSetupOptions(propertyId: string): Promise<ManualSetupOptionsResponse> {
  return apiRequest<ManualSetupOptionsResponse>(`${propertyPath(propertyId)}/manual-setup/options`);
}

// --- Pasos de puesta en marcha (GET /backoffice/properties/:propertyId/setup · backoffice.access) ---

export type PropertySetupStep = {
  id: string;
  propertyId: string;
  stepCode: string;
  /** Corrector L5 (L5F-06): etiqueta en español del catálogo del API (SETUP_STEP_LABELS); el front no la duplica. */
  label?: string;
  status: "not_started" | "in_progress" | "completed" | "blocked" | "needs_review";
  completedAt?: string;
  completedBy?: string;
  metadataJson: Record<string, unknown>;
};

/** Tanda L5 (lote C): los 15 pasos del catálogo materializados en property_setup_steps, con el estado en vivo. */
export type PropertySetupProgress = {
  propertyId: string;
  steps: PropertySetupStep[];
  completed: number;
  total: number;
  progressPercent: number;
  /** true cuando approveGoLive escribió goLiveAt. */
  live: boolean;
  goLiveAt: string | null;
};

export function fetchSetupProgress(propertyId: string): Promise<PropertySetupProgress> {
  return apiRequest<PropertySetupProgress>(`${propertyPath(propertyId)}/setup`);
}

export function saveManualSetupOption(propertyId: string, optionCode: string, payload: Record<string, unknown>): Promise<unknown> {
  return apiRequest<unknown>(`${propertyPath(propertyId)}/manual-setup/${encodeURIComponent(optionCode)}`, {
    method: "POST",
    body: payload
  });
}

export function fetchPropertySetupForm(propertyId: string, formCode: string): Promise<PropertySetupForm> {
  return apiRequest<PropertySetupForm>(`${propertyPath(propertyId)}/property-setup/forms/${encodeURIComponent(formCode)}`);
}

export function savePropertySetupForm(propertyId: string, formCode: string, payload: Record<string, unknown>): Promise<unknown> {
  return apiRequest<unknown>(`${propertyPath(propertyId)}/property-setup/forms/${encodeURIComponent(formCode)}`, {
    method: "POST",
    body: payload
  });
}

export function fetchConfigurationCategories(propertyId: string): Promise<{ propertyId: string; groups: ConfigurationCategoryGroup[] }> {
  return apiRequest<{ propertyId: string; groups: ConfigurationCategoryGroup[] }>(`${propertyPath(propertyId)}/configuration/categories`);
}

export function fetchConfigurationCategory(propertyId: string, categoryCode: string): Promise<ConfigurationCategory> {
  return apiRequest<ConfigurationCategory>(`${propertyPath(propertyId)}/configuration/categories/${encodeURIComponent(categoryCode)}`);
}

export function createConfigurationCategoryOption(
  propertyId: string,
  categoryCode: string,
  option: Record<string, unknown>
): Promise<ConfigurationCategoryOption> {
  return apiRequest<ConfigurationCategoryOption>(
    `${propertyPath(propertyId)}/configuration/categories/${encodeURIComponent(categoryCode)}/options`,
    { method: "POST", body: option }
  );
}

export const backOfficeEndpoints = {
  dashboard: "/backoffice/properties/:propertyId/dashboard",
  setup: "/backoffice/properties/:propertyId/setup",
  manualSetupOptions: "/backoffice/properties/:propertyId/manual-setup/options",
  manualSetupOption: "/backoffice/properties/:propertyId/manual-setup/:optionCode",
  propertySetupForms: "/backoffice/properties/:propertyId/property-setup/forms",
  propertySetupForm: "/backoffice/properties/:propertyId/property-setup/forms/:formCode",
  configurationCategories: "/backoffice/properties/:propertyId/configuration/categories",
  configurationCategory: "/backoffice/properties/:propertyId/configuration/categories/:categoryCode",
  configurationCategoryOptions: "/backoffice/properties/:propertyId/configuration/categories/:categoryCode/options",
  readiness: "/backoffice/properties/:propertyId/readiness",
  map: "/backoffice/properties/:propertyId/map",
  modules: "/backoffice/properties/:propertyId/modules",
  integrations: "/backoffice/properties/:propertyId/integrations",
  complianceSettings: "/backoffice/properties/:propertyId/compliance-settings",
  billingSettings: "/backoffice/properties/:propertyId/billing-settings",
  accountingSettings: "/backoffice/properties/:propertyId/accounting-settings",
  aiSettings: "/backoffice/properties/:propertyId/ai-settings",
  audit: "/backoffice/properties/:propertyId/audit"
};

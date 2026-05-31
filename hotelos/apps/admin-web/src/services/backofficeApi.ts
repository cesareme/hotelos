const API_BASE_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:3000";

export type BackOfficeDashboard = {
  setupProgress: number;
  goLiveReadiness: "ready" | "blocked";
  blockingIssues: Array<{ checkCode: string; message: string; severity: string }>;
  activeModules: number;
  modulesNeedingConfiguration: unknown[];
  integrationErrors: number;
  roomsMapped: number;
  invoiceSequenceStatus: string;
  paymentProviderStatus: string;
  aiStatus: string;
  recommendedNextAction: string;
};

export async function fetchBackOfficeDashboard(propertyId: string): Promise<BackOfficeDashboard> {
  const response = await fetch(`${API_BASE_URL}/backoffice/properties/${propertyId}/dashboard`);
  if (!response.ok) {
    throw new Error("Unable to load Back Office dashboard.");
  }
  return response.json() as Promise<BackOfficeDashboard>;
}

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

export async function fetchPropertySetupForms(propertyId: string): Promise<{ propertyId: string; forms: PropertySetupForm[] }> {
  const response = await fetch(`${API_BASE_URL}/backoffice/properties/${propertyId}/property-setup/forms`);
  if (!response.ok) {
    throw new Error("Unable to load property setup forms.");
  }
  return response.json() as Promise<{ propertyId: string; forms: PropertySetupForm[] }>;
}

export async function fetchManualSetupOptions(propertyId: string): Promise<{ propertyId: string; coverage: ManualSetupCoverage; setupSummary: ManualSetupSummary; options: ManualSetupOption[] }> {
  const response = await fetch(`${API_BASE_URL}/backoffice/properties/${propertyId}/manual-setup/options`);
  if (!response.ok) {
    throw new Error("Unable to load manual setup options.");
  }
  return response.json() as Promise<{ propertyId: string; coverage: ManualSetupCoverage; setupSummary: ManualSetupSummary; options: ManualSetupOption[] }>;
}

export async function fetchManualSetupOption(propertyId: string, optionCode: string): Promise<{
  propertyId: string;
  option: ManualSetupOption;
  latestSubmission?: unknown;
  submissions: unknown[];
  databaseBinding: { readEndpoint?: string; saveEndpoint?: string; targetTables: string[]; inputCategories: string[] };
}> {
  const response = await fetch(`${API_BASE_URL}/backoffice/properties/${propertyId}/manual-setup/${optionCode}`);
  if (!response.ok) {
    throw new Error("Unable to load manual setup option.");
  }
  return response.json() as Promise<{
    propertyId: string;
    option: ManualSetupOption;
    latestSubmission?: unknown;
    submissions: unknown[];
    databaseBinding: { readEndpoint?: string; saveEndpoint?: string; targetTables: string[]; inputCategories: string[] };
  }>;
}

export async function saveManualSetupOption(propertyId: string, optionCode: string, payload: Record<string, unknown>) {
  const response = await fetch(`${API_BASE_URL}/backoffice/properties/${propertyId}/manual-setup/${optionCode}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error("Unable to save manual setup option.");
  }
  return response.json();
}

export async function fetchPropertySetupForm(propertyId: string, formCode: string): Promise<PropertySetupForm> {
  const response = await fetch(`${API_BASE_URL}/backoffice/properties/${propertyId}/property-setup/forms/${formCode}`);
  if (!response.ok) {
    throw new Error("Unable to load property setup form.");
  }
  return response.json() as Promise<PropertySetupForm>;
}

export async function savePropertySetupForm(propertyId: string, formCode: string, payload: Record<string, unknown>) {
  const response = await fetch(`${API_BASE_URL}/backoffice/properties/${propertyId}/property-setup/forms/${formCode}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error("Unable to save property setup form.");
  }
  return response.json();
}

export async function fetchConfigurationCategories(propertyId: string): Promise<{ propertyId: string; groups: ConfigurationCategoryGroup[] }> {
  const response = await fetch(`${API_BASE_URL}/backoffice/properties/${propertyId}/configuration/categories`);
  if (!response.ok) {
    throw new Error("Unable to load configuration categories.");
  }
  return response.json() as Promise<{ propertyId: string; groups: ConfigurationCategoryGroup[] }>;
}

export async function fetchConfigurationCategory(propertyId: string, categoryCode: string): Promise<ConfigurationCategory> {
  const response = await fetch(`${API_BASE_URL}/backoffice/properties/${propertyId}/configuration/categories/${categoryCode}`);
  if (!response.ok) {
    throw new Error("Unable to load configuration category.");
  }
  return response.json() as Promise<ConfigurationCategory>;
}

export async function createConfigurationCategoryOption(
  propertyId: string,
  categoryCode: string,
  option: Record<string, unknown>
): Promise<ConfigurationCategoryOption> {
  const response = await fetch(`${API_BASE_URL}/backoffice/properties/${propertyId}/configuration/categories/${categoryCode}/options`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(option)
  });
  if (!response.ok) {
    throw new Error("Unable to save category option.");
  }
  return response.json() as Promise<ConfigurationCategoryOption>;
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

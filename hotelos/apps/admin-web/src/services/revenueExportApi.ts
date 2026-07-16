// Client for the Revenue Export Center endpoints (contract frozen 2026-07-15).
// Exports are permission-gated (revenue.history_forecast.export, high risk),
// so this client goes through apiRequest to attach the JWT.
import { apiRequest } from "./api-client";
import { getActivePropertyId } from "./activeProperty";

export type ExportFormat = "csv" | "xls" | "pdf" | "json";
export type ExportParamsKind = "dateRange" | "month" | "none";
export type ExportDef = {
  code: string;
  name: string;
  description: string;
  ritual: "diario" | "semanal" | "mensual";
  formats: ExportFormat[];
  params: ExportParamsKind;
  recommendedSchedule?: string;
};
export type ExportCatalog = {
  propertyId: string;
  conventions: string[];
  exports: ExportDef[];
};
export type GeneratedExportMeta = {
  id: string;
  code: string;
  format: ExportFormat;
  filename: string;
  contentType: string;
  generatedAt: string;
  sizeBytes: number;
};
export type GenerateExportResponse = {
  export: GeneratedExportMeta;
  content: string;
};

export function fetchExportCatalog(propertyId = getActivePropertyId()) {
  return apiRequest<ExportCatalog>(`/revenue/properties/${propertyId}/export-center/catalog`);
}

export function generateRevenueExport(
  payload: { exportCode: string; format: ExportFormat; from?: string; to?: string; month?: string },
  propertyId = getActivePropertyId()
) {
  return apiRequest<GenerateExportResponse>(`/revenue/properties/${propertyId}/export-center/generate`, {
    method: "POST",
    body: payload
  });
}

/** Turn a generate response into a browser file download. */
export function downloadGeneratedExport(resp: GenerateExportResponse): void {
  const blob = new Blob([resp.content], { type: resp.export.contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = resp.export.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

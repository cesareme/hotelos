// Inmovilizado y amortización (Tanda 6 · lote nav-services). Typed client of
// apps/api/src/modules/fixed-assets/fixed-assets.routes.ts on
// packages/shared/src/payables-types.ts (FixedAssetDto · DepreciationRunDto).
//
//   GET|POST  /properties/:propertyId/asset-register                       listFixedAssets · createFixedAsset   assets.read · assets.manage
//   GET|PATCH /properties/:propertyId/asset-register/:assetId              getFixedAsset · updateFixedAsset
//   POST      /properties/:propertyId/asset-register/:assetId/dispose      disposeFixedAsset                    accounting.journal.post (crítico)
//   GET       /organizations/:organizationId/depreciation-runs             listDepreciationRuns                 accounting.reports.read
//   GET       …/depreciation-runs/preview?period=AAAA-MM                   previewDepreciationRun (pendingPeriods)
//   POST      /organizations/:organizationId/depreciation-runs             postDepreciationRun                  accounting.journal.post (crítico)
//   GET       …/depreciation-runs/:runId · POST …/:runId/reverse           getDepreciationRun · reverseDepreciationRun
//
// Runs are posted month by month without gaps: while `preview.pendingPeriods`
// is not empty the POST answers 409 PREVIOUS_PERIOD_MISSING with the same
// list in details.pendingPeriods (assetsErrorMessage lists them).

import type {
  DepreciationRunDto,
  DepreciationRunRequest,
  DisposeFixedAssetRequest,
  FixedAssetDetailDto,
  FixedAssetDto,
  FixedAssetPatchRequest,
  FixedAssetRequest
} from "@hotelos/shared";
import { apiRequest } from "./api-client";
import { getActiveOrganizationId, getActivePropertyId } from "./activeProperty";
import { compactQuery, financeErrorMessage, fixedAssetListQuery, type FixedAssetListInput } from "./finance-contracts";

export type { DepreciationRunDto, FixedAssetDetailDto, FixedAssetDto, FixedAssetRequest } from "@hotelos/shared";
export type { FixedAssetListInput } from "./finance-contracts";

const enc = encodeURIComponent;

// ---- Registro de elementos (propiedad) ---------------------------------------

export function listFixedAssets(input: FixedAssetListInput = {}, propertyId = getActivePropertyId()): Promise<FixedAssetDto[]> {
  return apiRequest<FixedAssetDto[]>(`/properties/${enc(propertyId)}/asset-register`, { query: fixedAssetListQuery(input) });
}

/** 201. `coefficientPct` must not exceed the category maximum (COEFFICIENT_ABOVE_MAX). */
export function createFixedAsset(body: FixedAssetRequest, propertyId = getActivePropertyId()): Promise<FixedAssetDto> {
  return apiRequest<FixedAssetDto>(`/properties/${enc(propertyId)}/asset-register`, { method: "POST", body });
}

export function getFixedAsset(assetId: string, propertyId = getActivePropertyId()): Promise<FixedAssetDetailDto> {
  return apiRequest<FixedAssetDetailDto>(`/properties/${enc(propertyId)}/asset-register/${enc(assetId)}`);
}

export function updateFixedAsset(assetId: string, body: FixedAssetPatchRequest, propertyId = getActivePropertyId()): Promise<FixedAssetDto> {
  return apiRequest<FixedAssetDto>(`/properties/${enc(propertyId)}/asset-register/${enc(assetId)}`, { method: "PATCH", body });
}

/** Disposal entry with result (`counterAccountCode` 572 · 570 · 4300). Critical. */
export function disposeFixedAsset(assetId: string, body: DisposeFixedAssetRequest, propertyId = getActivePropertyId()): Promise<FixedAssetDetailDto> {
  return apiRequest<FixedAssetDetailDto>(`/properties/${enc(propertyId)}/asset-register/${enc(assetId)}/dispose`, { method: "POST", body });
}

// ---- Corridas de amortización (organización) ----------------------------------

export function listDepreciationRuns(limit?: number, organizationId = getActiveOrganizationId()): Promise<DepreciationRunDto[]> {
  return apiRequest<DepreciationRunDto[]>(`/organizations/${enc(organizationId)}/depreciation-runs`, { query: compactQuery({ limit }) });
}

/** Preview of `period` (AAAA-MM): lines, skipped elements and `pendingPeriods` (empty when the month can be posted). */
export function previewDepreciationRun(period: string, organizationId = getActiveOrganizationId()): Promise<DepreciationRunDto> {
  return apiRequest<DepreciationRunDto>(`/organizations/${enc(organizationId)}/depreciation-runs/preview`, { query: { period } });
}

/** 201 (200 when the month was already posted: `alreadyPosted`). Critical. */
export function postDepreciationRun(body: DepreciationRunRequest, organizationId = getActiveOrganizationId()): Promise<DepreciationRunDto> {
  return apiRequest<DepreciationRunDto>(`/organizations/${enc(organizationId)}/depreciation-runs`, { method: "POST", body });
}

export function getDepreciationRun(runId: string, organizationId = getActiveOrganizationId()): Promise<DepreciationRunDto> {
  return apiRequest<DepreciationRunDto>(`/organizations/${enc(organizationId)}/depreciation-runs/${enc(runId)}`);
}

/** Only the latest posted run can be reversed (LATER_RUN_EXISTS otherwise). */
export function reverseDepreciationRun(runId: string, body: { reason?: string } = {}, organizationId = getActiveOrganizationId()): Promise<DepreciationRunDto> {
  return apiRequest<DepreciationRunDto>(`/organizations/${enc(organizationId)}/depreciation-runs/${enc(runId)}/reverse`, { method: "POST", body });
}

// ---- Errores ------------------------------------------------------------------

export function assetsErrorMessage(error: unknown, fallback = "No se pudo guardar el elemento. Inténtalo de nuevo."): string {
  return financeErrorMessage(error, fallback);
}

// Estado honesto de las integraciones (Tanda L8 · L8-06). Cliente tipado de
// la ruta que L8-05 cablea en apps/api/src/server.ts sobre el colector
// `collectIntegrationsStatus` de L8-01 (contrato en
// packages/shared/src/integrations-status-types.ts; runbook
// docs/runbooks/integraciones.md §2.2):
//
//   GET /integrations/status?propertyId=   fetchIntegrationsStatus   integrations.read
//
// La respuesta trae una fila por `IntegrationKey` (18) con su modo
// none | sandbox | real, la frase de estado, qué falta para operar en real y
// la última actividad o error registrados; `degraded` lista las consultas que
// fallaron y se degradaron a «sin datos» (nunca a un éxito). El cliente no
// interpreta nada: los helpers puros viven en
// screens/integrations/integrations-status-helpers.ts. Solo `import type` de
// @hotelos/shared.

import type { IntegrationsStatusResponse } from "@hotelos/shared";
import { getActivePropertyId } from "./activeProperty";
import { apiRequest } from "./api-client";

export type { IntegrationKey, IntegrationMode, IntegrationStatusDto, IntegrationTransport, IntegrationsStatusResponse } from "@hotelos/shared";

export const INTEGRATIONS_STATUS_PATH = "/integrations/status";

export type FetchIntegrationsStatusOptions = {
  signal?: AbortSignal;
};

/** Estado de las 18 integraciones para la propiedad indicada (por defecto, la activa). */
export function fetchIntegrationsStatus(propertyId?: string, options: FetchIntegrationsStatusOptions = {}): Promise<IntegrationsStatusResponse> {
  const id = propertyId ?? getActivePropertyId();
  return apiRequest<IntegrationsStatusResponse>(INTEGRATIONS_STATUS_PATH, { query: { propertyId: id }, signal: options.signal });
}

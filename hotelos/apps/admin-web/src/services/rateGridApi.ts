// Frontend client for the Rate Manager grid (BAR + restricciones + push a canales).
//
// Tipos viven en `packages/shared/src/rate-manager-types.ts` y se re-exportan
// desde `@hotelos/shared` (barrel `index.ts`). Importamos desde el barrel
// porque es el patrón establecido en este repo (ej.: `AuditLogViewer.tsx`):
// el `paths` de `tsconfig.base.json` solo mapea `@hotelos/shared` raíz, no
// subpaths como `@hotelos/shared/rate-manager-types`.
import { apiRequest } from "./api-client";
import { toArray } from "../utils/toArray";
import type {
  RateGridCell,
  RateGridBulkUpdateRequest,
  RateGridPushRequest,
  RateChangeJournalEntry
} from "@hotelos/shared";

export type FetchRateGridInput = {
  propertyId: string;
  from: string;
  to: string;
  roomTypeIds?: string[];
  channelId?: string;
};

/**
 * GET /properties/:propertyId/rate-grid?from&to&roomTypeIds&channelId
 * Devuelve celdas BAR + price + restricciones para el rango pedido. Si se
 * omite `channelId` se obtiene la base BAR; si se pasa, los precios incluyen
 * el markup del canal.
 */
export async function fetchRateGrid(input: FetchRateGridInput): Promise<RateGridCell[]> {
  const { propertyId, from, to, roomTypeIds, channelId } = input;
  const query: Record<string, string | number | undefined> = { from, to };
  if (roomTypeIds && roomTypeIds.length > 0) query.roomTypeIds = roomTypeIds.join(",");
  if (channelId) query.channelId = channelId;
  // Auditoría 2026-07: el backend devuelve el ARRAY pelado (getRateGrid →
  // RateGridCell[]), no `{items}` — el `res.items` anterior dejaba `cells`
  // undefined y la rejilla crasheaba. toArray tolera ambas formas.
  const res = await apiRequest<RateGridCell[] | { items: RateGridCell[] }>(
    `/properties/${propertyId}/rate-grid`,
    { query }
  );
  return toArray<RateGridCell>(res);
}

/**
 * POST /properties/:propertyId/rate-grid/bulk-update
 * Bulk update de precios y/o restricciones. El backend crea una journal entry
 * (estado `draft`) y devuelve su id para que la UI pueda navegar/auditar.
 */
export function bulkUpdateRateGrid(
  propertyId: string,
  body: RateGridBulkUpdateRequest
): Promise<{ updated: number; journalId: string }> {
  return apiRequest<{ updated: number; journalId: string }>(
    `/properties/${propertyId}/rate-grid/bulk-update`,
    { method: "POST", body }
  );
}

/**
 * POST /properties/:propertyId/rate-grid/push
 * Empuja el rango/canales solicitados a los OTA mappers. Si algunos canales
 * fallan, los devuelve en `failedChannels` para mostrarse en la UI sin
 * abortar el resto.
 */
export function pushRateGrid(
  propertyId: string,
  body: RateGridPushRequest
): Promise<{ pushed: number; failedChannels: string[] }> {
  return apiRequest<{ pushed: number; failedChannels: string[] }>(
    `/properties/${propertyId}/rate-grid/push`,
    { method: "POST", body }
  );
}

/**
 * GET /properties/:propertyId/rate-journal?limit
 * Historial de cambios (quién, cuándo, cuántas celdas, estado de push).
 * Auditoría 2026-07: el path era `/rate-grid/journal` (inexistente → 404) y se
 * desempaquetaba `{items}` cuando el backend devuelve el array pelado.
 */
export async function fetchRateJournal(
  propertyId: string,
  limit?: number
): Promise<RateChangeJournalEntry[]> {
  const query: Record<string, string | number | undefined> = {};
  if (limit !== undefined) query.limit = limit;
  const res = await apiRequest<RateChangeJournalEntry[] | { items: RateChangeJournalEntry[] }>(
    `/properties/${propertyId}/rate-journal`,
    { query }
  );
  return toArray<RateChangeJournalEntry>(res);
}

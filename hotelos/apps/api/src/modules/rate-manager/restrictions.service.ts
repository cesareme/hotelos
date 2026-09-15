// Rate grid v2 · restriction patches from OUTSIDE the editor (recommendations,
// automations). Same engine and journal as bulk-update, so a restriction the
// RMS applies is revertible and visible in the history like a manual edit.
//
// `ratePlanId` omitted (or "*") → the (roomType, "*") row that applies to every
// plan; `channelId` omitted → the base row that applies to every channel.

import type { RateGridBulkUpdateResponse, RateRestrictionsPatch } from "@hotelos/shared";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError } from "../../lib/http-error.js";
import { requirePermissions } from "../auth/auth.service.js";
import { STAR, executeRateGridWrite, loadPropertyCatalog, toWireResponse, type EnginePatch } from "./rate-grid.engine.js";
import { parseOr400, restrictionsPatchSchema, isoDateSchema } from "./rate-grid.schemas.js";
import { z } from "zod";

export type RestrictionPatchInput = {
  roomTypeId: string;
  ratePlanId?: string | null;
  channelId?: string | null;
  date: string;
  restrictions: RateRestrictionsPatch;
};

const restrictionPatchListSchema = z
  .array(
    z
      .object({
        roomTypeId: z.string().min(1),
        ratePlanId: z.string().min(1).nullable().optional(),
        channelId: z.string().min(1).nullable().optional(),
        date: isoDateSchema,
        restrictions: restrictionsPatchSchema
      })
      .strict()
  )
  .min(1)
  .max(5000);

export async function applyRestrictionPatches(
  propertyId: string,
  patches: RestrictionPatchInput[],
  context: UserContext,
  options: { reason?: string; correlationId?: string; clientRequestId?: string } = {}
): Promise<RateGridBulkUpdateResponse> {
  requirePermissions(context, ["revenue.manage_restrictions"]);
  if (!propertyId) throw new BadRequestError("propertyId es obligatorio.");
  const list = parseOr400(restrictionPatchListSchema, patches, "restricciones");
  const catalog = await loadPropertyCatalog(propertyId);
  const enginePatches: EnginePatch[] = list.map((p) => ({
    ratePlanId: p.ratePlanId ?? STAR,
    roomTypeId: p.roomTypeId,
    date: p.date,
    ...(p.channelId ? { channelId: p.channelId } : {}),
    restrictions: p.restrictions
  }));
  const result = await executeRateGridWrite({
    catalog,
    context,
    patches: enginePatches,
    reason: options.reason ?? "Restricciones (automático)",
    status: "draft",
    clientRequestId: options.clientRequestId ?? null,
    correlationId: options.correlationId,
    auditAction: "RATE_GRID_RESTRICTIONS_UPDATED"
  });
  return toWireResponse(result);
}

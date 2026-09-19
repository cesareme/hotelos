// Reputación · Tanda T8 · lote T8-B — colector `expedia` (Lodging Supply API)
// (apps/api/src/modules/reputation/collectors/expedia-lodging-supply.ts).
//
// Estado honesto: Expedia solo da acceso al Lodging Supply GraphQL API a
// connectivity providers certificados; hasta que ehotelOS esté certificado
// (o Faranda indique su channel manager) la fuente es `unavailable` y
// fetchSince devuelve [] SIN hacer red. Sin Prisma, sin variables de
// entorno, sin red.

import { DEFAULT_SOURCE_CAPABILITIES } from "../reputation-types.js";
import type { CollectorSource, CollectorState, FetchSinceInput, FetchSinceResult, ReviewCollector } from "./types.js";

export const EXPEDIA_UNAVAILABLE_REASON = "No disponible hasta certificar a ehotelOS como connectivity provider de Expedia; indica tu channel manager";

export class ExpediaLodgingSupplyCollector implements ReviewCollector {
  readonly provider = "expedia" as const;
  readonly mode = "api" as const;
  readonly capabilities = DEFAULT_SOURCE_CAPABILITIES.expedia;

  describeState(source: CollectorSource): CollectorState {
    if (source.credentials?.partnerToken) {
      return { status: "pending", reason: "Token de partner recibido; el cliente GraphQL llega en T8-L5 (hoy no sincroniza)." };
    }
    return { status: "unavailable", reason: EXPEDIA_UNAVAILABLE_REASON };
  }

  async fetchSince(input: FetchSinceInput): Promise<FetchSinceResult> {
    const state = this.describeState(input.source);
    return { items: [], status: state.status, ...(state.reason ? { error: state.reason } : {}) };
  }
}

export const expediaLodgingSupplyCollector = new ExpediaLodgingSupplyCollector();

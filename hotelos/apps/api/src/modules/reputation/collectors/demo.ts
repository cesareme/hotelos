// Reputación · Tanda T8 · lote T8-B — colector `demo` (datos ficticios)
// (apps/api/src/modules/reputation/collectors/demo.ts).
//
// Los datos demo los escribe el seed (T8-L6, reseñas FICTICIAS con sufijo
// `_demo` e `isDemo`); el colector no genera nada en el tick: fetchSince
// devuelve [] con estado `connected`. Sin Prisma, sin variables de entorno,
// sin red.

import { DEFAULT_SOURCE_CAPABILITIES } from "../reputation-types.js";
import type { CollectorSource, CollectorState, FetchSinceInput, FetchSinceResult, ReviewCollector } from "./types.js";

export const DEMO_REASON = "Fuente de demostración con reseñas ficticias sembradas; el bot diario no sincroniza esta fuente.";

export class DemoCollector implements ReviewCollector {
  readonly provider = "demo" as const;
  readonly mode = "demo" as const;
  readonly capabilities = DEFAULT_SOURCE_CAPABILITIES.demo;

  describeState(_source: CollectorSource): CollectorState {
    return { status: "connected", reason: DEMO_REASON };
  }

  async fetchSince(_input: FetchSinceInput): Promise<FetchSinceResult> {
    return { items: [], status: "connected" };
  }
}

export const demoCollector = new DemoCollector();

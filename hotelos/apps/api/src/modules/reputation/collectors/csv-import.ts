// Reputación · Tanda T8 · lote T8-B — colector `csv` (importación manual)
// (apps/api/src/modules/reputation/collectors/csv-import.ts).
//
// La importación entra por ruta (`POST /reputation/properties/:id/imports`,
// parser en ../review-csv.parser.ts); el tick diario no tiene nada que
// traer: fetchSince devuelve [] con estado `connected` (la fuente siempre
// está disponible). Sin Prisma, sin variables de entorno, sin red.

import { DEFAULT_SOURCE_CAPABILITIES } from "../reputation-types.js";
import type { CollectorSource, CollectorState, FetchSinceInput, FetchSinceResult, ReviewCollector } from "./types.js";

export const CSV_IMPORT_REASON = "Importación manual: sube un CSV desde Ajustes de fuentes; el bot diario no sincroniza esta fuente.";

export class CsvImportCollector implements ReviewCollector {
  readonly provider = "csv" as const;
  readonly mode = "csv" as const;
  readonly capabilities = DEFAULT_SOURCE_CAPABILITIES.csv;

  describeState(_source: CollectorSource): CollectorState {
    return { status: "connected", reason: CSV_IMPORT_REASON };
  }

  async fetchSince(_input: FetchSinceInput): Promise<FetchSinceResult> {
    return { items: [], status: "connected" };
  }
}

export const csvImportCollector = new CsvImportCollector();

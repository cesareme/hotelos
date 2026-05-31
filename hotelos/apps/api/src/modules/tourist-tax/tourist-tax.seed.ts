// Seed real de tarifas de tasa turística en España, vigentes en 2026.
//
// Fuentes legales:
//   - Cataluña: Ley 2/2026 del 1/4/2026 (DOGC).
//   - Baleares: Ley 4/2014, vigente con Decreto 35/2016 + revisiones anuales.
//   - País Vasco / San Sebastián: Norma Foral 2/2024 (BOG).
//   - Canarias: no aplica todavía a nivel autonómico (estudio en 2026).
//
// La estructura permite añadir/actualizar tarifas sin código: la UI tiene CRUD
// completo. Este seed es solo punto de partida.

import { prisma } from "@hotelos/database";

const RATES_2026: Array<{
  ccaaCode: string;
  municipality?: string | null;
  establishmentClass: string;
  amountPerPersonNight: number;
  validFrom: string;
  validUntil?: string | null;
  maxNightsPerStay?: number;
  highSeasonSurcharge?: number | null;
  highSeasonFromMmdd?: string | null;
  highSeasonUntilMmdd?: string | null;
  taxableAgeFrom?: number;
  legalSource?: string;
}> = [
  // ---- Cataluña — Ley 2/2026 (entra en vigor 1/4/2026) ----
  // Barcelona ciudad cobra recargo municipal adicional.
  { ccaaCode: "CAT", municipality: "Barcelona", establishmentClass: "lujo_5e", amountPerPersonNight: 9.5, validFrom: "2026-04-01", maxNightsPerStay: 7, legalSource: "DOGC Ley 2/2026" },
  { ccaaCode: "CAT", municipality: "Barcelona", establishmentClass: "5_estrellas", amountPerPersonNight: 7.0, validFrom: "2026-04-01", maxNightsPerStay: 7, legalSource: "DOGC Ley 2/2026" },
  { ccaaCode: "CAT", municipality: "Barcelona", establishmentClass: "4_estrellas", amountPerPersonNight: 4.75, validFrom: "2026-04-01", maxNightsPerStay: 7, legalSource: "DOGC Ley 2/2026" },
  { ccaaCode: "CAT", municipality: "Barcelona", establishmentClass: "3_estrellas", amountPerPersonNight: 3.25, validFrom: "2026-04-01", maxNightsPerStay: 7, legalSource: "DOGC Ley 2/2026" },
  { ccaaCode: "CAT", municipality: "Barcelona", establishmentClass: "2_o_menos", amountPerPersonNight: 2.0, validFrom: "2026-04-01", maxNightsPerStay: 7, legalSource: "DOGC Ley 2/2026" },
  // Resto de Cataluña (tarifa autonómica sin recargo municipal).
  { ccaaCode: "CAT", municipality: null, establishmentClass: "5_estrellas", amountPerPersonNight: 3.5, validFrom: "2026-04-01", maxNightsPerStay: 7, legalSource: "DOGC Ley 2/2026" },
  { ccaaCode: "CAT", municipality: null, establishmentClass: "4_estrellas", amountPerPersonNight: 1.75, validFrom: "2026-04-01", maxNightsPerStay: 7, legalSource: "DOGC Ley 2/2026" },
  { ccaaCode: "CAT", municipality: null, establishmentClass: "3_estrellas", amountPerPersonNight: 1.20, validFrom: "2026-04-01", maxNightsPerStay: 7, legalSource: "DOGC Ley 2/2026" },
  { ccaaCode: "CAT", municipality: null, establishmentClass: "2_o_menos", amountPerPersonNight: 0.75, validFrom: "2026-04-01", maxNightsPerStay: 7, legalSource: "DOGC Ley 2/2026" },
  { ccaaCode: "CAT", municipality: null, establishmentClass: "camping", amountPerPersonNight: 0.50, validFrom: "2026-04-01", maxNightsPerStay: 7, legalSource: "DOGC Ley 2/2026" },

  // ---- Baleares — Impuesto Turismo Sostenible (ITS) ----
  // Aplica recargo temporada alta (mayo-octubre +25%) según Decreto 35/2016 y sucesivos.
  { ccaaCode: "BAL", municipality: null, establishmentClass: "5_estrellas", amountPerPersonNight: 4.0, validFrom: "2026-01-01", highSeasonSurcharge: 0.25, highSeasonFromMmdd: "05-01", highSeasonUntilMmdd: "10-31", legalSource: "Decreto 35/2016 + revisión 2026" },
  { ccaaCode: "BAL", municipality: null, establishmentClass: "4_estrellas_sup", amountPerPersonNight: 3.0, validFrom: "2026-01-01", highSeasonSurcharge: 0.25, highSeasonFromMmdd: "05-01", highSeasonUntilMmdd: "10-31", legalSource: "Decreto 35/2016" },
  { ccaaCode: "BAL", municipality: null, establishmentClass: "4_estrellas", amountPerPersonNight: 2.0, validFrom: "2026-01-01", highSeasonSurcharge: 0.25, highSeasonFromMmdd: "05-01", highSeasonUntilMmdd: "10-31", legalSource: "Decreto 35/2016" },
  { ccaaCode: "BAL", municipality: null, establishmentClass: "3_estrellas", amountPerPersonNight: 1.0, validFrom: "2026-01-01", highSeasonSurcharge: 0.25, highSeasonFromMmdd: "05-01", highSeasonUntilMmdd: "10-31", legalSource: "Decreto 35/2016" },
  { ccaaCode: "BAL", municipality: null, establishmentClass: "apt_turistico", amountPerPersonNight: 2.0, validFrom: "2026-01-01", highSeasonSurcharge: 0.25, highSeasonFromMmdd: "05-01", highSeasonUntilMmdd: "10-31", legalSource: "Decreto 35/2016" },
  { ccaaCode: "BAL", municipality: null, establishmentClass: "rural", amountPerPersonNight: 2.0, validFrom: "2026-01-01", legalSource: "Decreto 35/2016" },

  // ---- País Vasco — Tasa turística (Norma Foral 2/2024 en Gipuzkoa) ----
  { ccaaCode: "EUSK", municipality: "Donostia/San Sebastián", establishmentClass: "5_estrellas", amountPerPersonNight: 3.5, validFrom: "2026-01-01", maxNightsPerStay: 3, legalSource: "BOG Norma Foral 2/2024" },
  { ccaaCode: "EUSK", municipality: "Donostia/San Sebastián", establishmentClass: "4_estrellas", amountPerPersonNight: 2.5, validFrom: "2026-01-01", maxNightsPerStay: 3, legalSource: "BOG Norma Foral 2/2024" },
  { ccaaCode: "EUSK", municipality: "Donostia/San Sebastián", establishmentClass: "3_estrellas", amountPerPersonNight: 1.5, validFrom: "2026-01-01", maxNightsPerStay: 3, legalSource: "BOG Norma Foral 2/2024" }
];

const EXEMPTIONS: Array<{
  ccaaCode: string;
  code: string;
  description: string;
  ageFrom?: number | null;
  ageTo?: number | null;
  legalSource?: string;
}> = [
  { ccaaCode: "CAT", code: "MENORES_16", description: "Menores de 16 años exentos.", ageTo: 15, legalSource: "DOGC Ley 2/2026" },
  { ccaaCode: "BAL", code: "MENORES_16", description: "Menores de 16 años exentos.", ageTo: 15, legalSource: "Decreto 35/2016" },
  { ccaaCode: "EUSK", code: "MENORES_18", description: "Menores de 18 años exentos.", ageTo: 17, legalSource: "BOG Norma Foral 2/2024" },
  { ccaaCode: "CAT", code: "MEDICAL_TRIP", description: "Estancia por motivos médicos justificados.", legalSource: "DOGC Ley 2/2026" },
  { ccaaCode: "CAT", code: "FORCED_BY_AUTHORITY", description: "Estancia forzosa decretada por autoridad pública.", legalSource: "DOGC Ley 2/2026" }
];

export async function seedTouristTaxRates(): Promise<{ rates: number; exemptions: number }> {
  let rates = 0;
  for (const r of RATES_2026) {
    // Upsert by (ccaaCode, municipality, class, validFrom).
    const existing = await prisma.touristTaxRate.findFirst({
      where: {
        ccaaCode: r.ccaaCode,
        municipality: r.municipality ?? null,
        establishmentClass: r.establishmentClass,
        validFrom: new Date(r.validFrom)
      }
    });
    if (existing) continue;
    await prisma.touristTaxRate.create({
      data: {
        ccaaCode: r.ccaaCode,
        municipality: r.municipality ?? null,
        establishmentClass: r.establishmentClass,
        amountPerPersonNight: r.amountPerPersonNight,
        validFrom: new Date(r.validFrom),
        validUntil: r.validUntil ? new Date(r.validUntil) : null,
        maxNightsPerStay: r.maxNightsPerStay ?? 0,
        highSeasonSurcharge: r.highSeasonSurcharge ?? null,
        highSeasonFromMmdd: r.highSeasonFromMmdd ?? null,
        highSeasonUntilMmdd: r.highSeasonUntilMmdd ?? null,
        taxableAgeFrom: r.taxableAgeFrom ?? 16,
        legalSource: r.legalSource ?? null
      }
    });
    rates += 1;
  }
  let exemptions = 0;
  for (const e of EXEMPTIONS) {
    const existing = await prisma.touristTaxExemption.findFirst({
      where: { ccaaCode: e.ccaaCode, code: e.code }
    });
    if (existing) continue;
    await prisma.touristTaxExemption.create({
      data: {
        ccaaCode: e.ccaaCode,
        code: e.code,
        description: e.description,
        ageFrom: e.ageFrom ?? null,
        ageTo: e.ageTo ?? null,
        active: true,
        legalSource: e.legalSource ?? null
      }
    });
    exemptions += 1;
  }
  return { rates, exemptions };
}

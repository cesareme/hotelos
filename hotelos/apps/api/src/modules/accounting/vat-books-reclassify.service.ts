// Finanzas · Tanda FIX-1 · lote F2 — reclasificación de régimen de las filas de los
// libros de IVA YA cargadas desde Sage 200 (`sourceType sage200`, `regime` null).
//
// Acción de PRODUCTO (`POST /fiscal/vat-books/reclassify`, permiso accounting.configure,
// riskLevel high): dry-run por defecto, `apply: true` escribe. Ámbito: la organización del
// contexto y un periodo (`period` 2025 · 2025-Q3 · 2025-09, o `from`+`to` natural). Trabaja
// SOLO sobre filas sin régimen: nunca reescribe una clasificación previa (importador o
// reclasificación anterior) y nunca toca filas nativas ni el libro de bienes de inversión.
//
// Reglas (puras, exportadas, testeables con filas inventadas; informe de carga §15 B-4/B-6;
// corrector FIX-1, F2-RECLASSIFY-RULE1-AMOUNT-PAIRING):
//   1 y 4 `pairAutofacturas`: una emitida SIN NIF y con cuota ≠ 0 (autofactura de Sage: lleva
//     el NOMBRE del proveedor extranjero como destinatario) emparejada 1:1 —mismo periodo,
//     mismo nombre normalizado, misma base y misma cuota al céntimo— con una recibida CON NIF
//     extranjero (nunca sin NIF: un ticket sin NIF no es la pareja de nada). El régimen de la
//     pareja lo decide el NIF de la recibida: prefijo de país con NIF-IVA de la UE (DE, FR, NL,
//     PT…) → regla 1, las dos caras `aib` (casillas 10/11 y 36/37); cualquier otro (CH, CO, GB,
//     US… o sin prefijo de país) → regla 4, las dos caras `isp` (12/13 y 28/29). Orden estable
//     por fecha e id; una recibida solo empareja una vez. Sobre la carga real las parejas
//     por nombre + importe coinciden con las 66 recibidas clave 09 (AIB) y las 10 con
//     «Inversión del Sujeto Pasivo» = S (CH / CO) del 1T 2025; el emparejamiento anterior
//     solo por importe casaba también ventas a particulares y etiquetaba todo `aib`.
//   2 `isDuaImport`: recibida SIN NIF cuyo número casa el MRN de un DUA
//     (`^\d{2}[A-Z]{2}[0-9A-Z]{14,16}$`) o tiene ≥ 14 dígitos → `importacion` (32/33).
//   3 `isZeroRateForeign`: emitida al 0 % con NIF extranjero → `exento_no_sujeto` (120) SOLO
//     con `includeZeroRate: true` (el usuario confirma: AR 2/3/4/10 del informe, pregunta B-4).
// El dry-run devuelve recuentos por regla (filas de las dos caras, filasEmitidas /
// filasRecibidas, base y cuota de UNA cara —la emitida en las parejas—, ≤ 5 ids de ejemplo,
// desglose por periodo con las dos caras), las emitidas sin pareja y las recibidas sin NIF
// que ninguna regla clasifica.
// Con apply: `updateMany` por ids dentro de una transacción (condición `regime IS NULL`,
// así una carrera no pisa nada) y auditoría `VAT_BOOKS_RECLASSIFIED` con recuentos (nunca
// textos ni NIF). El 303 / 390 / regime cambian solo tras el apply.

import { prisma } from "@hotelos/database";
import type { FiscalPeriodDto, VatBookRegimeCode, VatBooksReclassifyResponse, VatBooksReclassifyRuleDto } from "@hotelos/shared/src/fiscal-types.js";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import { ZERO, dateColumn, dateColumnDay, isIsoDay, money, parseFiscalPeriod, periodFromRange, round2, toWire, type Money } from "./vat-books.service.js";

// ── Pure rules ──────────────────────────────────────────────────────────────

/** Fila candidata (mínimo que las reglas necesitan; los importes son Decimal). */
export type ReclassifyCandidate = {
  id: string;
  book: "emitidas" | "recibidas";
  period: string;
  date: string;
  series: string | null;
  number: string | null;
  counterpartyNif: string | null;
  /** Nombre del tercero tal como viene del libro (la autofactura de Sage lleva el del proveedor). Nunca sale en la respuesta. */
  counterpartyName: string | null;
  base: Money;
  rate: Money;
  quota: Money;
};

/** NIF español normalizado (DNI / NIE / CIF), con o sin prefijo «ES»: letra opcional + 7-8 dígitos + carácter de control. */
export const SPANISH_NIF_RE = /^(?:ES)?[A-Z]?\d{7,8}[A-Z0-9]$/;
/** MRN de un DUA: año (2) + país (2) + 14-16 alfanuméricos. */
export const DUA_MRN_RE = /^\d{2}[A-Z]{2}[0-9A-Z]{14,16}$/;
/**
 * Prefijos de país de los NIF-IVA intracomunitarios (Estados miembros; EL = Grecia; XI = Irlanda del Norte, bienes).
 * Una recibida con NIF de estos prefijos es una adquisición intracomunitaria (`aib`); cualquier otro NIF extranjero
 * (CH, GB, NO, US, CO…) o sin prefijo de país es inversión del sujeto pasivo (`isp`).
 */
export const EU_VAT_PREFIXES: ReadonlySet<string> = new Set(["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK", "XI"]);
/** Tope explícito de filas candidatas por ejecución (≈ 27.000 al año en Faranda); por encima, acota el periodo. */
export const RECLASSIFY_MAX_ROWS = 200_000;
export const RECLASSIFY_EXAMPLE_IDS = 5;
export const VAT_BOOKS_RECLASSIFIED_ACTION = "VAT_BOOKS_RECLASSIFIED";

export function isSpanishNif(nif: string | null | undefined): boolean {
  return typeof nif === "string" && SPANISH_NIF_RE.test(nif.trim().toUpperCase());
}

/** NIF presente y NO español (extranjero u otra identificación). Un NIF nulo no es «extranjero». */
export function isForeignNif(nif: string | null | undefined): boolean {
  return typeof nif === "string" && nif.trim() !== "" && !isSpanishNif(nif);
}

/** NIF extranjero con prefijo de país de la UE (NIF-IVA intracomunitario). Un NIF español o sin prefijo de país no lo es. */
export function isEuVatNif(nif: string | null | undefined): boolean {
  if (!isForeignNif(nif)) return false;
  const normalized = nif!.trim().toUpperCase().replace(/[\s-]/g, "");
  return /^[A-Z]{2}[0-9A-Z]{2,}$/.test(normalized) && EU_VAT_PREFIXES.has(normalized.slice(0, 2));
}

/** Nombre del tercero normalizado para emparejar: mayúsculas sin diacríticos, solo letras y dígitos separados por un espacio; null si queda vacío. */
export function normalizeCounterpartyName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const folded = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  return folded === "" ? null : folded;
}

const byDateThenId = (a: ReclassifyCandidate, b: ReclassifyCandidate): number => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const pairKey = (row: ReclassifyCandidate, name: string): string => `${row.period}|${name}|${round2(row.base).toFixed(2)}|${round2(row.quota).toFixed(2)}`;

export type AutofacturaPair = { emitida: ReclassifyCandidate; recibida: ReclassifyCandidate; regimen: "aib" | "isp" };

/**
 * Reglas 1 y 4. Pura. Empareja cada emitida sin NIF, con cuota ≠ 0 y con nombre, con la primera recibida
 * libre del mismo periodo, mismo nombre normalizado, misma base y misma cuota (al céntimo) cuyo NIF es
 * extranjero (presente y no español). `regimen` = `aib` si el NIF de la recibida lleva prefijo de país de la
 * UE, `isp` en otro caso. Devuelve las parejas y las emitidas sin NIF (cuota ≠ 0) que quedaron sin pareja
 * (ventas a particulares, autofacturas huérfanas…).
 */
export function pairAutofacturas(emitidas: readonly ReclassifyCandidate[], recibidas: readonly ReclassifyCandidate[]): { pairs: AutofacturaPair[]; unpaired: ReclassifyCandidate[] } {
  const queues = new Map<string, ReclassifyCandidate[]>();
  for (const recibida of [...recibidas].sort(byDateThenId)) {
    if (recibida.book !== "recibidas" || !isForeignNif(recibida.counterpartyNif)) continue;
    const name = normalizeCounterpartyName(recibida.counterpartyName);
    if (name === null) continue;
    const key = pairKey(recibida, name);
    const queue = queues.get(key) ?? [];
    queue.push(recibida);
    queues.set(key, queue);
  }
  const pairs: AutofacturaPair[] = [];
  const unpaired: ReclassifyCandidate[] = [];
  for (const emitida of [...emitidas].sort(byDateThenId)) {
    if (emitida.book !== "emitidas" || emitida.counterpartyNif !== null) continue;
    const name = normalizeCounterpartyName(emitida.counterpartyName);
    const recibida = name === null || round2(emitida.quota).isZero() ? undefined : queues.get(pairKey(emitida, name))?.shift();
    if (recibida) pairs.push({ emitida, recibida, regimen: isEuVatNif(recibida.counterpartyNif) ? "aib" : "isp" });
    else unpaired.push(emitida);
  }
  return { pairs, unpaired };
}

/** Regla 2. Pura: recibida sin NIF cuyo número es un MRN de DUA o tiene ≥ 14 dígitos. */
export function isDuaImport(recibida: Pick<ReclassifyCandidate, "book" | "counterpartyNif" | "number">): boolean {
  if (recibida.book !== "recibidas" || recibida.counterpartyNif !== null) return false;
  const number = (recibida.number ?? "").replace(/[\s-]/g, "").toUpperCase();
  if (number === "") return false;
  return DUA_MRN_RE.test(number) || number.replace(/\D/g, "").length >= 14;
}

/** Regla 3. Pura: emitida al 0 % con NIF extranjero (exenta / no sujeta por localización). */
export function isZeroRateForeign(emitida: Pick<ReclassifyCandidate, "book" | "counterpartyNif" | "rate">): boolean {
  return emitida.book === "emitidas" && round2(emitida.rate).isZero() && isForeignNif(emitida.counterpartyNif);
}

export type ReclassificationPlan = {
  /** ids a escribir por régimen (deduplicados). */
  updates: Map<VatBookRegimeCode, string[]>;
  reglas: VatBooksReclassifyRuleDto[];
  sinPareja: { filas: number; cuota: number };
  recibidasSinNifNoClasificadas: { filas: number; cuota: number };
};

/**
 * DTO de una regla. `filas` y `porPeriodo[].filas` cuentan TODAS las filas que la regla clasifica (las dos
 * caras en las parejas: `filasEmitidas` + `filasRecibidas`); `base` y `cuota` (total y por periodo) suman
 * UNA cara: la emitida en las parejas (la recibida tiene los mismos importes), la única en las reglas 2 y 3.
 * Corrector FIX-1 (F2-RULE-DTO-COUNTS): antes `porPeriodo[].filas` sumaba la mitad de `filas` en la regla 1.
 */
function ruleDto(regla: VatBooksReclassifyRuleDto["regla"], regimen: VatBookRegimeCode, descripcion: string, faces: { emitidas: readonly ReclassifyCandidate[]; recibidas: readonly ReclassifyCandidate[] }, amounts: readonly ReclassifyCandidate[], extra: { parejas?: number } = {}): VatBooksReclassifyRuleDto {
  const byPeriod = new Map<string, { filas: number; base: Money; cuota: Money }>();
  const bucketOf = (period: string): { filas: number; base: Money; cuota: Money } => {
    const bucket = byPeriod.get(period) ?? { filas: 0, base: ZERO, cuota: ZERO };
    byPeriod.set(period, bucket);
    return bucket;
  };
  for (const row of [...faces.emitidas, ...faces.recibidas]) bucketOf(row.period).filas += 1;
  let base = ZERO;
  let cuota = ZERO;
  for (const row of amounts) {
    base = base.plus(row.base);
    cuota = cuota.plus(row.quota);
    const bucket = bucketOf(row.period);
    bucket.base = bucket.base.plus(row.base);
    bucket.cuota = bucket.cuota.plus(row.quota);
  }
  return {
    regla,
    regimen,
    descripcion,
    filas: faces.emitidas.length + faces.recibidas.length,
    filasEmitidas: faces.emitidas.length,
    filasRecibidas: faces.recibidas.length,
    ...(extra.parejas !== undefined ? { parejas: extra.parejas } : {}),
    base: toWire(round2(base)),
    cuota: toWire(round2(cuota)),
    ids: amounts.slice(0, RECLASSIFY_EXAMPLE_IDS).map((row) => row.id),
    porPeriodo: Array.from(byPeriod.entries())
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([periodo, bucket]) => ({ periodo, filas: bucket.filas, base: toWire(round2(bucket.base)), cuota: toWire(round2(bucket.cuota)) }))
  };
}

/** Pura: aplica las reglas a las filas candidatas y devuelve el plan (ids por régimen + recuentos; `reglas` en el orden 1, 2, 3, 4). */
export function planReclassification(input: { rows: readonly ReclassifyCandidate[]; includeZeroRate: boolean }): ReclassificationPlan {
  const emitidas = input.rows.filter((row) => row.book === "emitidas");
  const recibidas = input.rows.filter((row) => row.book === "recibidas");
  const { pairs, unpaired } = pairAutofacturas(emitidas, recibidas);
  const aibPairs = pairs.filter((pair) => pair.regimen === "aib");
  const ispPairs = pairs.filter((pair) => pair.regimen === "isp");
  const pairedRecibidas = new Set(pairs.map((pair) => pair.recibida.id));
  const dua = recibidas.filter((row) => !pairedRecibidas.has(row.id) && isDuaImport(row));
  const duaIds = new Set(dua.map((row) => row.id));
  const zeroRate = input.includeZeroRate ? emitidas.filter(isZeroRateForeign) : [];
  const sinNifNoClasificadas = recibidas.filter((row) => row.counterpartyNif === null && !pairedRecibidas.has(row.id) && !duaIds.has(row.id));
  const sumQuota = (rows: readonly ReclassifyCandidate[]): number => toWire(round2(rows.reduce((sum, row) => sum.plus(row.quota), ZERO)));
  const faces = (list: readonly AutofacturaPair[]): { emitidas: ReclassifyCandidate[]; recibidas: ReclassifyCandidate[] } => ({ emitidas: list.map((pair) => pair.emitida), recibidas: list.map((pair) => pair.recibida) });

  const updates = new Map<VatBookRegimeCode, string[]>();
  updates.set("aib", [...aibPairs.map((pair) => pair.emitida.id), ...aibPairs.map((pair) => pair.recibida.id)]);
  updates.set("isp", [...ispPairs.map((pair) => pair.emitida.id), ...ispPairs.map((pair) => pair.recibida.id)]);
  updates.set("importacion", dua.map((row) => row.id));
  updates.set("exento_no_sujeto", zeroRate.map((row) => row.id));

  const reglas: VatBooksReclassifyRuleDto[] = [
    ruleDto(1, "aib", "Autofacturas intracomunitarias: emitida sin NIF emparejada 1:1 (periodo, nombre del proveedor, base y cuota) con una recibida con NIF-IVA de la UE → las dos caras aib (10/11 y 36/37)", faces(aibPairs), aibPairs.map((pair) => pair.emitida), { parejas: aibPairs.length }),
    ruleDto(2, "importacion", "Recibidas sin NIF con número de DUA (MRN o ≥ 14 dígitos) → importacion (32/33)", { emitidas: [], recibidas: dua }, dua),
    ruleDto(3, "exento_no_sujeto", input.includeZeroRate ? "Emitidas al 0 % con NIF extranjero → exento_no_sujeto (120)" : "Emitidas al 0 % con NIF extranjero → exento_no_sujeto (120): NO aplicada (includeZeroRate false)", { emitidas: zeroRate, recibidas: [] }, zeroRate),
    ruleDto(4, "isp", "Autofacturas con inversión del sujeto pasivo: emitida sin NIF emparejada 1:1 (periodo, nombre del proveedor, base y cuota) con una recibida con NIF extranjero no intracomunitario → las dos caras isp (12/13 y 28/29)", faces(ispPairs), ispPairs.map((pair) => pair.emitida), { parejas: ispPairs.length })
  ];
  return {
    updates,
    reglas,
    sinPareja: { filas: unpaired.length, cuota: sumQuota(unpaired) },
    recibidasSinNifNoClasificadas: { filas: sinNifNoClasificadas.length, cuota: sumQuota(sinNifNoClasificadas) }
  };
}

// ── Period ──────────────────────────────────────────────────────────────────

/** `period` (2025 · 2025-Q3 · 2025-09) o `from`+`to` (ejercicio, trimestre o mes natural). */
export function resolveReclassifyPeriod(input: { period?: string; from?: string; to?: string }): FiscalPeriodDto {
  if (input.period) return parseFiscalPeriod(input.period, ["annual", "quarterly", "monthly"]);
  if (input.from || input.to) {
    if (!isIsoDay(input.from) || !isIsoDay(input.to)) throw new BadRequestError("Indica period (2025 · 2025-Q3 · 2025-09) o from y to (formato YYYY-MM-DD).");
    const resolved = periodFromRange(input.from, input.to);
    if (!resolved) {
      const error = new BadRequestError("from y to deben delimitar un ejercicio, trimestre o mes natural completo (p. ej. 2025-01-01..2025-12-31); usa mejor period=2025.");
      error.details = { code: "INVALID_PERIOD" };
      throw error;
    }
    return resolved;
  }
  const error = new BadRequestError("El parámetro period es obligatorio (2025 ejercicio · 2025-Q3 trimestre · 2025-09 mes).");
  error.details = { code: "INVALID_PERIOD" };
  throw error;
}

// ── Service ─────────────────────────────────────────────────────────────────

export type ReclassifyVatBooksInput = {
  context: UserContext;
  period?: string;
  from?: string;
  to?: string;
  apply: boolean;
  includeZeroRate: boolean;
  correlationId?: string;
};

export async function reclassifyVatBooks(input: ReclassifyVatBooksInput): Promise<VatBooksReclassifyResponse> {
  requirePermissions(input.context, ["accounting.configure"]);
  const organizationId = input.context.organizationId;
  const periodo = resolveReclassifyPeriod(input);
  const avisos: string[] = [];
  const persisted = await prisma.vatBookEntry.findMany({
    where: { organizationId, sourceType: "sage200", regime: null, book: { in: ["emitidas", "recibidas"] }, date: { gte: dateColumn(periodo.from), lte: dateColumn(periodo.to) } },
    select: { id: true, book: true, period: true, date: true, series: true, number: true, counterpartyNif: true, counterpartyName: true, base: true, rate: true, quota: true },
    orderBy: [{ date: "asc" }, { id: "asc" }],
    take: RECLASSIFY_MAX_ROWS + 1
  });
  if (persisted.length > RECLASSIFY_MAX_ROWS) {
    const error = new BadRequestError(`El periodo ${periodo.code} tiene más de ${RECLASSIFY_MAX_ROWS} filas sin régimen: acota el periodo (trimestre o mes).`);
    error.details = { code: "RECLASSIFY_TOO_MANY_ROWS", max: RECLASSIFY_MAX_ROWS };
    throw error;
  }
  const rows: ReclassifyCandidate[] = persisted.map((row) => ({
    id: row.id,
    book: row.book as "emitidas" | "recibidas",
    period: row.period,
    date: dateColumnDay(row.date),
    series: row.series,
    number: row.number,
    counterpartyNif: row.counterpartyNif,
    counterpartyName: row.counterpartyName,
    base: money(row.base),
    rate: money(row.rate),
    quota: money(row.quota)
  }));
  const candidatas = { emitidas: rows.filter((row) => row.book === "emitidas").length, recibidas: rows.filter((row) => row.book === "recibidas").length };
  const plan = planReclassification({ rows, includeZeroRate: input.includeZeroRate });
  if (rows.length === 0) avisos.push(`Sin filas sage200 pendientes de clasificar en ${periodo.code}: nada que reclasificar.`);
  if (!input.includeZeroRate && plan.reglas[2]) {
    const zeroRate = rows.filter(isZeroRateForeign);
    if (zeroRate.length > 0) avisos.push(`${zeroRate.length} emitida(s) al 0 % con NIF extranjero (base ${round2(zeroRate.reduce((sum, row) => sum.plus(row.base), ZERO)).toFixed(2)} €) NO se reclasifican: confirma con includeZeroRate: true tras revisar su calificación (casilla 120).`);
  }
  if (plan.sinPareja.filas > 0) avisos.push(`${plan.sinPareja.filas} emitida(s) sin NIF sin recibida pareja (cuota ${plan.sinPareja.cuota.toFixed(2)} €): quedan sin régimen (ventas a particulares o autofacturas huérfanas; revisar).`);
  if (plan.recibidasSinNifNoClasificadas.filas > 0) avisos.push(`${plan.recibidasSinNifNoClasificadas.filas} recibida(s) sin NIF que ninguna regla clasifica (cuota ${plan.recibidasSinNifNoClasificadas.cuota.toFixed(2)} €): quedan sin régimen.`);
  const planned = Array.from(plan.updates.values()).reduce((sum, ids) => sum + ids.length, 0);
  let actualizadas = 0;
  if (input.apply && planned > 0) {
    actualizadas = await prisma.$transaction(
      async (tx) => {
        let written = 0;
        for (const [regime, ids] of plan.updates) {
          for (let offset = 0; offset < ids.length; offset += 5_000) {
            const chunk = ids.slice(offset, offset + 5_000);
            const result = await tx.vatBookEntry.updateMany({ where: { id: { in: chunk }, organizationId, sourceType: "sage200", regime: null }, data: { regime } });
            written += result.count;
          }
        }
        return written;
      },
      { maxWait: 15_000, timeout: 120_000 }
    );
    if (actualizadas !== planned) avisos.push(`Se planificaron ${planned} filas y se han escrito ${actualizadas}: alguna fila cambió de régimen entre el dry-run y el apply.`);
    recordAuditEvent({
      organizationId,
      propertyId: input.context.propertyId,
      actorUserId: input.context.userId,
      actorType: "user",
      action: VAT_BOOKS_RECLASSIFIED_ACTION,
      entityType: "vat_book_entries",
      entityId: `${organizationId}:${periodo.code}`,
      afterJson: {
        periodo: periodo.code,
        includeZeroRate: input.includeZeroRate,
        candidatas,
        reglas: plan.reglas.map((regla) => ({ regla: regla.regla, regimen: regla.regimen, filas: regla.filas, ...(regla.parejas !== undefined ? { parejas: regla.parejas } : {}), base: regla.base, cuota: regla.cuota })),
        sinPareja: plan.sinPareja,
        recibidasSinNifNoClasificadas: plan.recibidasSinNifNoClasificadas,
        actualizadas
      },
      correlationId: input.correlationId
    });
  } else if (input.apply) {
    avisos.push("apply: true sin filas que reclasificar: no se ha escrito nada.");
  } else {
    avisos.push("Simulación (dry-run): no se ha escrito nada; repite con apply: true para reclasificar.");
  }
  return {
    organizationId,
    apply: input.apply,
    includeZeroRate: input.includeZeroRate,
    periodo,
    candidatas,
    reglas: plan.reglas,
    sinPareja: plan.sinPareja,
    recibidasSinNifNoClasificadas: plan.recibidasSinNifNoClasificadas,
    actualizadas,
    avisos,
    generatedAt: new Date().toISOString()
  };
}

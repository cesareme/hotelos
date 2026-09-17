// Importación contable desde Sage 200 (Tanda 7c · L1) — mapa de cuentas y mapa
// analítico, PUROS (sin Prisma, sin red).
//
//   · `LEDGER_ACCOUNT_CODE_PATTERN` — duplicado literal de ACCOUNT_CODE_PATTERN
//     (accounting.service.ts, no exportado; ledger.routes.ts ya lo duplica en zod):
//     un test lo pina leyendo el fuente del motor;
//   · `resolveAccountMapping(sourceAccount, ctx)` — las 7 reglas del diseño §4.4
//     en orden, la primera que aplica gana:
//       1 entrada explícita del mapa persistido;
//       2 código Sage sin ceros finales ≡ cuenta postable del plan (6400000 → 640,
//         5720000 → 572, 4300000 → 4300; los prefijos de tercero 43x/40x/41x van
//         SIEMPRE a 4300 / 400 / 410, las cuentas que usan los escritores nativos;
//         472 / 477 nunca por esta regla: el IVA es por tipo);
//       3 prefijo de 3 dígitos (o de 4 si el plan tiene esa cuenta de 4 dígitos:
//         4300, 4751, 5721…) + serial sin ceros ≤ 999 → `prefijo.serial` existente
//         (4770021 → 477.21, 7050001 → 705.1);
//       4 prefijo de tercero 430/431/435/400/401/410/411 con serial > 0 → collapse
//         a 4300 / 400 / 410 con carryCounterparty;
//       5 472/477 sin serial pero apunte con PorIva → map_by_rate (accountCode =
//         prefijo; el destino `prefijo.<PorIva>` se resuelve apunte a apunte con
//         vatOutputAccount / vatInputAccount);
//       6 regla 3 sin destino existente y prefijo (3 dígitos) válido en el plan →
//         create { code: prefijo.serial, name: título Sage, usali propuesto por
//         templateUsaliFor(prefijo) } — en grupos 6/7 el USALI es obligatorio y
//         la fila queda con `suggested: true` para que la persona lo confirme;
//       7 resto → block;
//   · `suggestAnalyticsMapping(codes, properties, dimension)` — centro por igualdad
//     de código / nombre / nombre comercial plegados (`foldValue`) y centro de coste
//     USALI por `costCentreCodeFor` (HAB / REST / MANT / ADM / COM / IT / OTROS);
//   · `normalizeNativeDocumentKey(series, number)` — clave de exclusión de nativos
//     (§5.1): mayúsculas, sin guiones ni espacios, serial sin ceros a la izquierda
//     (`FAC-2026-000001` ≡ Serie `FAC-2026` + Factura `1` → `FAC2026:1`).

import {
  CUSTOMER_ACCOUNT_CODE,
  LEDGER_USALI_COST_CENTRE_CODES,
  type LedgerAccountMapDto,
  type LedgerAnalyticsDimension,
  type LedgerAnalyticsMapDto,
  type LedgerUsaliCostCentreCode,
  type UsaliDepartmentKey,
  type UsaliLineKey
} from "@hotelos/shared";
import { foldValue } from "../../pms/reservation-import.mapping.js";
import { accountGroup, templateUsaliFor } from "../chart-of-accounts.service.js";
import { CREDITOR_ACCOUNT, SUPPLIER_ACCOUNT } from "../posting-rules.js";

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Igual, carácter a carácter, a ACCOUNT_CODE_PATTERN del motor (accounting.service.ts): 1-8 dígitos sin cero inicial y sufijo opcional `.ddd`. */
export const LEDGER_ACCOUNT_CODE_PATTERN = /^[1-9][0-9]{0,7}(\.[0-9]{1,3})?$/;

/** Prefijos de tercero de Sage → cuenta colectiva de Anfitorio (las de los escritores nativos). */
export const THIRD_PARTY_PREFIX_TARGETS: Readonly<Record<string, string>> = Object.freeze({
  "430": CUSTOMER_ACCOUNT_CODE,
  "431": CUSTOMER_ACCOUNT_CODE,
  "435": CUSTOMER_ACCOUNT_CODE,
  "400": SUPPLIER_ACCOUNT,
  "401": SUPPLIER_ACCOUNT,
  "410": CREDITOR_ACCOUNT,
  "411": CREDITOR_ACCOUNT
});

/** Cuentas de IVA por tipo: nunca se mapean a la cabecera genérica. */
export const VAT_BY_RATE_PREFIXES: readonly string[] = Object.freeze(["472", "477"]);

/** Serial máximo admitido en `prefijo.serial` (ACCOUNT_CODE_PATTERN admite hasta 3 dígitos tras el punto). */
export const MAX_SUBACCOUNT_SERIAL = 999;

// ---------------------------------------------------------------------------
// Mapa de cuentas
// ---------------------------------------------------------------------------

export type ChartLookupEntry = {
  isPostable: boolean;
  kind: string;
  usaliDepartment: UsaliDepartmentKey | string | null;
  usaliLine: UsaliLineKey | string | null;
  name?: string | null;
};

export type ChartLookup = ReadonlyMap<string, ChartLookupEntry>;

export type AccountMappingContext = {
  /** Mapa persistido / enviado con la preview, por cuenta Sage literal. */
  explicit: ReadonlyMap<string, LedgerAccountMapDto>;
  /** Plan de cuentas de la organización por código. */
  chart: ChartLookup;
  /** Título Sage de la cuenta (para `create`). */
  sourceName?: string | null;
  /** PorIva del apunte (regla 5); null si el apunte no lleva bloque IVA. */
  porIva?: number | string | null;
};

/** Resultado del mapeador: el DTO del mapa más la regla (1-7) que lo decidió. */
export type ResolvedAccountMapping = LedgerAccountMapDto & { rule: 1 | 2 | 3 | 4 | 5 | 6 | 7 };

function digitsOnly(code: string): string | null {
  const text = code.trim();
  return /^\d+$/.test(text) ? text : null;
}

/** Candidatos de la regla 2: el propio código y los que quedan al quitar ceros finales (mínimo 3 dígitos), del más largo al más corto. */
export function trailingZeroCandidates(sourceAccount: string): string[] {
  const out: string[] = [sourceAccount.trim()];
  const digits = digitsOnly(sourceAccount);
  if (!digits) return out;
  let current = digits;
  while (current.length > 3 && current.endsWith("0")) {
    current = current.slice(0, -1);
    out.push(current);
  }
  return out;
}

function serialOf(rest: string): number | null {
  if (!/^\d+$/.test(rest)) return null;
  return Number(rest);
}

/** Prefijos candidatos de la regla 3: el de 3 dígitos siempre; el de 4 solo si el plan tiene esa cuenta de 4 dígitos. */
function prefixCandidates(digits: string, chart: ChartLookup): Array<{ prefix: string; rest: string }> {
  const out: Array<{ prefix: string; rest: string }> = [];
  if (digits.length > 3) out.push({ prefix: digits.slice(0, 3), rest: digits.slice(3) });
  if (digits.length > 4 && chart.has(digits.slice(0, 4))) out.push({ prefix: digits.slice(0, 4), rest: digits.slice(4) });
  return out;
}

function dto(partial: Omit<LedgerAccountMapDto, "carryCounterparty" | "suggested"> & { carryCounterparty?: boolean }, rule: ResolvedAccountMapping["rule"]): ResolvedAccountMapping {
  return { ...partial, carryCounterparty: partial.carryCounterparty ?? false, suggested: rule !== 1, rule };
}

/**
 * Cuenta Sage → acción del mapa (reglas 1-7 de §4.4). Puro y determinista: la
 * previsualización lo muestra antes de contabilizar y el servicio persiste el resultado
 * en LedgerAccountMap.
 */
export function resolveAccountMapping(sourceAccount: string, ctx: AccountMappingContext): ResolvedAccountMapping {
  const source = sourceAccount.trim();
  const sourceName = ctx.sourceName ?? null;

  // 1 · explícita
  const explicit = ctx.explicit.get(source);
  if (explicit) return { ...explicit, sourceAccount: source, sourceName: explicit.sourceName ?? sourceName, carryCounterparty: explicit.carryCounterparty ?? false, suggested: false, rule: 1 };

  const digits = digitsOnly(source);
  const thirdPartyPrefix = digits && digits.length >= 3 ? digits.slice(0, 3) : null;
  const thirdPartyTarget = thirdPartyPrefix ? THIRD_PARTY_PREFIX_TARGETS[thirdPartyPrefix] : undefined;

  // 2 · sin ceros finales ≡ cuenta postable del plan
  for (const candidate of trailingZeroCandidates(source)) {
    if (VAT_BY_RATE_PREFIXES.includes(candidate)) continue;
    if (thirdPartyTarget && candidate === thirdPartyPrefix) {
      // 4300000 → 4300 / 4000000 → 400 / 4100000 → 410: la cuenta colectiva de los escritores nativos.
      const target = ctx.chart.get(thirdPartyTarget);
      if (target?.isPostable) return dto({ sourceAccount: source, sourceName, action: "map", accountCode: thirdPartyTarget }, 2);
    }
    const entry = ctx.chart.get(candidate);
    if (entry?.isPostable) {
      if (thirdPartyTarget && candidate.length === 4 && candidate.startsWith(thirdPartyPrefix!) && candidate !== thirdPartyTarget && digits!.slice(candidate.length).replace(/0/g, "") === "") {
        // 4000000 → «4000» existe pero los escritores usan 400: preferimos la colectiva.
        const target = ctx.chart.get(thirdPartyTarget);
        if (target?.isPostable) return dto({ sourceAccount: source, sourceName, action: "map", accountCode: thirdPartyTarget }, 2);
      }
      return dto({ sourceAccount: source, sourceName, action: "map", accountCode: candidate }, 2);
    }
  }

  if (!digits) return dto({ sourceAccount: source, sourceName, action: "block", accountCode: null }, 7);

  // 3 · prefijo + serial ≤ 999 → prefijo.serial existente
  const candidates = prefixCandidates(digits, ctx.chart);
  for (const { prefix, rest } of candidates) {
    const serial = serialOf(rest);
    if (serial === null || serial <= 0 || serial > MAX_SUBACCOUNT_SERIAL) continue;
    const target = `${prefix}.${serial}`;
    const entry = ctx.chart.get(target);
    if (entry?.isPostable) return dto({ sourceAccount: source, sourceName, action: "map", accountCode: target }, 3);
    // 477.10 / 472.04: las subcuentas de IVA del plan llevan el tipo con dos cifras.
    if (VAT_BY_RATE_PREFIXES.includes(prefix)) {
      const padded = `${prefix}.${String(serial).padStart(2, "0")}`;
      const paddedEntry = ctx.chart.get(padded);
      if (paddedEntry?.isPostable) return dto({ sourceAccount: source, sourceName, action: "map", accountCode: padded }, 3);
    }
  }

  // 4 · tercero con serial > 0 → collapse
  if (thirdPartyTarget && digits.length > 3) {
    const serial = serialOf(digits.slice(3));
    if (serial !== null && serial > 0) {
      return dto({ sourceAccount: source, sourceName, action: "collapse", accountCode: thirdPartyTarget, carryCounterparty: true }, 4);
    }
  }

  // 5 · 472 / 477 sin serial + apunte con PorIva → map_by_rate
  if (digits.length >= 3 && VAT_BY_RATE_PREFIXES.includes(digits.slice(0, 3))) {
    const serial = serialOf(digits.slice(3));
    const hasRate = ctx.porIva !== null && ctx.porIva !== undefined && String(ctx.porIva).trim() !== "";
    if ((serial === null || serial === 0) && hasRate) {
      return dto({ sourceAccount: source, sourceName, action: "map_by_rate", accountCode: digits.slice(0, 3) }, 5);
    }
  }

  // 6 · regla 3 sin destino: crear prefijo.serial (prefijo de 3 dígitos válido en el plan)
  const first = candidates[0];
  if (first && first.prefix.length === 3 && ctx.chart.has(first.prefix)) {
    const serial = serialOf(first.rest);
    if (serial !== null && serial > 0 && serial <= MAX_SUBACCOUNT_SERIAL) {
      const code = `${first.prefix}.${serial}`;
      if (LEDGER_ACCOUNT_CODE_PATTERN.test(code) && !VAT_BY_RATE_PREFIXES.includes(first.prefix)) {
        const group = accountGroup(code);
        const usali = group === 6 || group === 7 ? templateUsaliFor(first.prefix) : null;
        return dto(
          {
            sourceAccount: source,
            sourceName,
            action: "create",
            accountCode: code,
            usaliDepartment: usali?.usaliDepartment ?? null,
            usaliLine: usali?.usaliLine ?? null
          },
          6
        );
      }
    }
  }

  // 7 · resto
  return dto({ sourceAccount: source, sourceName, action: "block", accountCode: null }, 7);
}

/** Cuenta destino de un apunte con `map_by_rate`: `477.<tipo>` / `472.<tipo>` (dos cifras, como vatOutputAccount / vatInputAccount). */
export function accountForRate(prefix: string, ratePercent: number | string): string {
  const rate = Math.round(Number(ratePercent));
  return `${prefix}.${String(rate).padStart(2, "0")}`;
}

/** true si el mapa deja la cuenta contabilizable (map / map_by_rate / create / collapse con accountCode). */
export function isPostableMapping(mapping: Pick<LedgerAccountMapDto, "action" | "accountCode">): boolean {
  return mapping.action !== "block" && !!mapping.accountCode;
}

// ---------------------------------------------------------------------------
// Mapa analítico
// ---------------------------------------------------------------------------

export type AnalyticsProperty = {
  id: string;
  code: string | null;
  name: string | null;
  tradeName?: string | null;
};

export type AnalyticsCode = { code: string; name?: string | null };

/** Sinónimos (plegados con `foldValue`) de cada centro de coste USALI. */
export const COST_CENTRE_SYNONYMS: Readonly<Record<LedgerUsaliCostCentreCode, readonly string[]>> = Object.freeze({
  ROOMS: ["rooms", "hab", "habitaciones", "alojamiento", "room", "recepcion", "pisos", "hospedaje"],
  FNB: ["fnb", "f_b", "fyb", "ayb", "a_b", "rest", "restaurante", "restauracion", "cocina", "bar", "comedor", "cafeteria", "alimentos_bebidas", "food_beverage", "food_and_beverage"],
  POM: ["pom", "mant", "mantenimiento", "sstt", "servicios_tecnicos", "reparaciones", "maintenance"],
  ADMIN_GENERAL: ["admin_general", "adm", "admin", "administracion", "administracion_general", "general", "direccion", "gerencia", "a_g", "ag"],
  SALES_MARKETING: ["sales_marketing", "com", "comercial", "ventas", "marketing", "mkt", "ventas_marketing", "sales"],
  IT: ["it", "informatica", "sistemas", "ti", "tecnologia", "tecnologia_informacion"],
  OTHER_OPERATED: ["other_operated", "otros", "otros_departamentos", "other", "spa", "parking", "lavanderia", "tienda", "eventos", "wellness", "golf"]
});

/** Código Sage (o su nombre) de departamento / sección → centro de coste USALI; null si no se reconoce. */
export function costCentreCodeFor(sourceCode: string, sourceName?: string | null): LedgerUsaliCostCentreCode | null {
  const candidates = [foldValue(sourceCode), sourceName ? foldValue(sourceName) : ""].filter((value) => value !== "");
  for (const candidate of candidates) {
    if ((LEDGER_USALI_COST_CENTRE_CODES as readonly string[]).includes(candidate.toUpperCase())) return candidate.toUpperCase() as LedgerUsaliCostCentreCode;
    for (const code of LEDGER_USALI_COST_CENTRE_CODES) {
      if (COST_CENTRE_SYNONYMS[code].includes(candidate)) return code;
    }
  }
  return null;
}

/** Centro de trabajo cuyo código, nombre o nombre comercial plegado coincide con el código o el nombre Sage; null si ninguno o varios. */
export function matchProperty(code: AnalyticsCode, properties: readonly AnalyticsProperty[]): AnalyticsProperty | null {
  const keys = [foldValue(code.code), code.name ? foldValue(code.name) : ""].filter((value) => value !== "");
  for (const key of keys) {
    const matches = properties.filter((property) => [property.code, property.name, property.tradeName].some((value) => value && foldValue(value) === key));
    if (matches.length === 1) return matches[0]!;
  }
  return null;
}

/**
 * Propuesta de mapa analítico para los códigos de una dimensión: `propertyId` por igualdad
 * de código / nombre / nombre comercial plegados y `costCentreCode` por sinónimos USALI.
 * `suggested` es true cuando alguna de las dos se ha propuesto.
 */
export function suggestAnalyticsMapping(codes: readonly AnalyticsCode[], properties: readonly AnalyticsProperty[], dimension: LedgerAnalyticsDimension): LedgerAnalyticsMapDto[] {
  const seen = new Set<string>();
  const out: LedgerAnalyticsMapDto[] = [];
  for (const code of codes) {
    const sourceCode = code.code.trim();
    if (sourceCode === "" || seen.has(sourceCode)) continue;
    seen.add(sourceCode);
    const property = matchProperty({ code: sourceCode, name: code.name ?? null }, properties);
    const costCentreCode = costCentreCodeFor(sourceCode, code.name ?? null);
    out.push({
      dimension,
      sourceCode,
      sourceName: code.name ?? null,
      propertyId: property?.id ?? null,
      costCentreCode,
      suggested: property !== null || costCentreCode !== null
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Clave de documento nativo (§5.1)
// ---------------------------------------------------------------------------

function stripSerial(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits === "") return value;
  return String(Number(digits));
}

/**
 * Serie + número → clave comparable: serie en mayúsculas sin guiones / espacios / barras,
 * serial sin ceros a la izquierda, separados por «:». Sin número, el valor de `series` se
 * toma como número impreso completo y se parte por el último guion (`FAC-2026-000001` →
 * `FAC2026:1`) o por el último bloque de dígitos (`FAC000001` → `FAC:1`); solo número →
 * `:123`. Vacío → null.
 */
export function normalizeNativeDocumentKey(series: string | null | undefined, number: string | null | undefined): string | null {
  const seriesText = (series ?? "").trim();
  const numberText = (number ?? "").trim();
  if (seriesText === "" && numberText === "") return null;
  let seriesPart = seriesText;
  let numberPart = numberText;
  if (numberPart === "") {
    const dash = seriesText.lastIndexOf("-");
    if (dash > 0 && /\d/.test(seriesText.slice(dash + 1))) {
      seriesPart = seriesText.slice(0, dash);
      numberPart = seriesText.slice(dash + 1);
    } else {
      const match = /^(.*?)(\d+)$/.exec(seriesText);
      if (match) {
        seriesPart = match[1]!;
        numberPart = match[2]!;
      } else {
        seriesPart = seriesText;
        numberPart = "";
      }
    }
  }
  const normalizedSeries = seriesPart.toUpperCase().replace(/[\s\-_/\\.]/g, "");
  const normalizedNumber = numberPart === "" ? "" : stripSerial(numberPart);
  if (normalizedSeries === "" && normalizedNumber === "") return null;
  return `${normalizedSeries}:${normalizedNumber}`;
}

/** Clave de una factura nativa por su número impreso completo (`Invoice.invoiceNumber`). */
export function nativeInvoiceKey(invoiceNumber: string): string | null {
  return normalizeNativeDocumentKey(invoiceNumber, null);
}

/** Candidatos a número de documento dentro de un texto libre (documento / concepto): `FAC-2026-000001`, `REC-2026-12`, `F2026/000123`. */
export function documentKeysInText(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const pattern = /\b([A-Z]{1,8}(?:[-_/]?\d{2,4})?[-_/]\d{1,10})\b/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const key = normalizeNativeDocumentKey(match[1], null);
    if (key) out.add(key);
  }
  return [...out];
}

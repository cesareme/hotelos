// Terceros importados desde Sage 200 · FIX-1 · F11 (informe E-05): consulta de SOLO
// lectura de `ledger_third_parties`, la tabla que `ledger-import.service.ts`
// (upsertThirdParty) escribe desde los lotes `third_parties` y `vat_books` y que hasta
// ahora no tenía GET (Proveedores › directorio queda vacío porque `supplier_id` es null
// salvo con options.createSuppliers).
//
//   GET /accounting/ledger-imports/third-parties?q=&role=&limit=&cursor=
//     · accounting.read (remapeada a accounting.reports.read en el manifiesto)
//     · organización del contexto (los terceros son de la sociedad, nunca de un centro)
//     · página keyset por (role, sourceCode, id) — patrón de listVatBook — con `total`
//       del filtro y `nextCursor`; `q` casa código Sage o nombre (sin mayúsculas), NIF
//       (contiene, en mayúsculas) o subcuenta Sage (empieza por)
//     · `lote`: la entrada `third_parties` más reciente del tercero en
//       ledger_import_entries (sourceFiscalYear "terceros", sourcePeriod = rol,
//       sourceEntryNumber = código: postThirdPartiesInTx) con su ledger_imports
//       (id, fileName, createdAt), UNA consulta por página; null si solo lo escribió
//       un lote de libros de IVA
//     · regla de nombres (corrector FIX-1, F11-EMPLOYEE-NAMES-STILL-EXPOSED): `name` solo si
//       el tercero está acreditado como SOCIEDAD por su NIF (`isLegalEntityTaxId`: CIF español
//       de persona jurídica —letras A-H, J, N, P-S, U, V, W—, con o sin prefijo ES, o NIF-IVA
//       extranjero con prefijo de país de la UE / EEE / GB / CH), la subcuenta no empieza por
//       465 / 460 / 555 y el nombre no contiene la palabra EMPLEADO (`^EMPLEADO` del brief
//       ampliado a cualquier posición: la carga real tiene «<palabra> EMPLEADO nnnn»); en otro
//       caso null. Un DNI / NIE, un pasaporte o un NIF ausente son personas físicas o
//       desconocidos: el directorio nunca muestra su nombre (huéspedes, empleados con nombre
//       en otro orden —C-03—, autónomos), sin necesidad de diccionario de personas.
//
// Los constructores puros (where, cursor, regla de nombres, lote por tercero) están
// exportados y probados sin base de datos en __tests__/ledger-third-parties.test.mts.

import type { Prisma } from "@prisma/client";
import { prisma } from "@hotelos/database";
import {
  LEDGER_THIRD_PARTY_LIST_DEFAULT_LIMIT,
  LEDGER_THIRD_PARTY_LIST_MAX_LIMIT,
  LEDGER_THIRD_PARTY_PERSONAL_ACCOUNT_PREFIXES,
  LEDGER_THIRD_PARTY_ROLES,
  type LedgerThirdPartyDto,
  type LedgerThirdPartyLotRef,
  type LedgerThirdPartyPage,
  type LedgerThirdPartyRole
} from "@hotelos/shared";
import type { UserContext } from "../../../lib/demo-store.js";
import { BadRequestError } from "../../../lib/http-error.js";
import { buildPage, decodeCursor, type CursorKey } from "../../../lib/pagination.js";
import { requirePermissions } from "../../auth/auth.service.js";

/** `sourceFiscalYear` de las entradas de un lote `third_parties` (ledger-import.service.ts · postThirdPartiesInTx). */
const THIRD_PARTY_ENTRY_FISCAL_YEAR = "terceros";
/** Separador del cursor: `k = <rol>|<código>` (los roles del catálogo no llevan «|»). */
const CURSOR_KEY_SEPARATOR = "|";
/** Nombre enmascarado del preprocesado («EMPLEADO nnnn»), al principio o tras un resto de nombre («<palabra> EMPLEADO nnnn», 5 clientes de la carga real). */
const EMPLOYEE_NAME = /(^|[^A-ZÁÉÍÓÚÑ])EMPLEADO(?![A-ZÁÉÍÓÚÑ])/i;
const INVALID_CURSOR = "El cursor de paginación no es válido.";

export type ThirdPartyListFilter = {
  organizationId: string;
  q?: string | null;
  role?: LedgerThirdPartyRole | null;
};

/** Fila mínima que la regla de nombres y el lote necesitan (subconjunto de LedgerThirdParty). */
export type ThirdPartyNameInput = { sourceAccount: string | null; name: string; taxId: string | null };

/** CIF español de persona jurídica (con o sin prefijo ES): letra de forma social + 7 dígitos + control. K, L, M (personas físicas) y X, Y, Z (NIE) quedan fuera. */
const LEGAL_ENTITY_CIF_RE = /^(?:ES)?[A-HJNP-SUVW]\d{7}[0-9A-J]$/;
/** Prefijos de país de los NIF-IVA extranjeros que acreditan un sujeto pasivo registrado (UE + EEE + GB + CH); un pasaporte «PA…» / «YC…» no está aquí. */
const FOREIGN_VAT_PREFIXES: ReadonlySet<string> = new Set(["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "FI", "FR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK", "XI", "GB", "CH", "NO", "IS", "LI"]);

/**
 * true cuando el NIF acredita una persona jurídica: CIF español de sociedad o NIF-IVA extranjero con prefijo de
 * país reconocido (≥ 5 caracteres tras el prefijo). DNI, NIE, pasaportes, identificadores numéricos y NIF ausente → false.
 */
export function isLegalEntityTaxId(taxId: string | null | undefined): boolean {
  if (typeof taxId !== "string") return false;
  const normalized = taxId.replace(/[\s-]/g, "").toUpperCase();
  if (normalized === "") return false;
  if (LEGAL_ENTITY_CIF_RE.test(normalized)) return true;
  return /^[A-Z]{2}[0-9A-Z]{5,}$/.test(normalized) && FOREIGN_VAT_PREFIXES.has(normalized.slice(0, 2)) && !/^ES/.test(normalized);
}

/** Entrada `third_parties` de ledger_import_entries con su lote (lo que devuelve la consulta de la página). */
export type ThirdPartyLotEntry = {
  sourcePeriod: string;
  sourceEntryNumber: string;
  import: { id: string; fileName: string | null; createdAt: Date };
};

function isThirdPartyRole(value: string): value is LedgerThirdPartyRole {
  return (LEDGER_THIRD_PARTY_ROLES as readonly string[]).includes(value);
}

/** `where` de la lista (sin cursor): organización, rol opcional y búsqueda por código / NIF / cuenta / nombre. */
export function buildThirdPartyWhere(filter: ThirdPartyListFilter): Prisma.LedgerThirdPartyWhereInput {
  const q = filter.q?.trim() ?? "";
  return {
    organizationId: filter.organizationId,
    ...(filter.role ? { role: filter.role } : {}),
    ...(q
      ? {
          OR: [
            { sourceCode: { contains: q, mode: "insensitive" } },
            { taxId: { contains: q.toUpperCase() } },
            { sourceAccount: { startsWith: q } },
            { name: { contains: q, mode: "insensitive" } }
          ]
        }
      : {})
  };
}

/** Clave de orden de una fila: `<rol>|<código>` (el id es el desempate del cursor). */
export function thirdPartyCursorKey(row: { role: string; sourceCode: string }): string {
  return `${row.role}${CURSOR_KEY_SEPARATOR}${row.sourceCode}`;
}

/** Descompone `k`; 400 si no tiene la forma `<rol>|<código>` con un rol del catálogo. */
export function parseThirdPartyCursorKey(key: string): { role: LedgerThirdPartyRole; sourceCode: string } {
  const at = key.indexOf(CURSOR_KEY_SEPARATOR);
  if (at <= 0) throw new BadRequestError(INVALID_CURSOR);
  const role = key.slice(0, at);
  const sourceCode = key.slice(at + 1);
  if (!isThirdPartyRole(role) || sourceCode.length === 0) throw new BadRequestError(INVALID_CURSOR);
  return { role, sourceCode };
}

/** Condición keyset «después del cursor» en el orden (role, sourceCode, id). */
export function thirdPartyCursorWhere(cursor: CursorKey): Prisma.LedgerThirdPartyWhereInput {
  const { role, sourceCode } = parseThirdPartyCursorKey(cursor.k);
  return {
    OR: [{ role: { gt: role } }, { role, sourceCode: { gt: sourceCode } }, { role, sourceCode, id: { gt: cursor.id } }]
  };
}

/**
 * Regla de nombres: el nombre SOLO de las sociedades acreditadas por su NIF (`isLegalEntityTaxId`); null en las
 * subcuentas de personal (465 / 460 / 555), en los nombres con la palabra EMPLEADO («EMPLEADO nnnn», «<palabra>
 * EMPLEADO nnnn») y en todo tercero con DNI / NIE / pasaporte / sin NIF (persona física o desconocido).
 */
export function thirdPartyDisplayName(row: ThirdPartyNameInput): string | null {
  const account = row.sourceAccount ?? "";
  if (LEDGER_THIRD_PARTY_PERSONAL_ACCOUNT_PREFIXES.some((prefix) => account.startsWith(prefix))) return null;
  if (!isLegalEntityTaxId(row.taxId)) return null;
  const name = row.name.trim();
  if (name.length === 0 || EMPLOYEE_NAME.test(name)) return null;
  return row.name;
}

function lotKey(role: string, sourceCode: string): string {
  return `${role}${CURSOR_KEY_SEPARATOR}${sourceCode}`;
}

/** Lote más reciente por (rol, código) a partir de las entradas `third_parties` de la página (empate: el id mayor). */
export function latestLotByThirdParty(entries: readonly ThirdPartyLotEntry[]): Map<string, LedgerThirdPartyLotRef> {
  const latest = new Map<string, ThirdPartyLotEntry["import"]>();
  for (const entry of entries) {
    const key = lotKey(entry.sourcePeriod, entry.sourceEntryNumber);
    const current = latest.get(key);
    const newer = !current || entry.import.createdAt > current.createdAt || (entry.import.createdAt.getTime() === current.createdAt.getTime() && entry.import.id > current.id);
    if (newer) latest.set(key, entry.import);
  }
  return new Map([...latest].map(([key, lot]) => [key, { importId: lot.id, fileName: lot.fileName, createdAt: lot.createdAt.toISOString() }]));
}

/** UNA consulta a ledger_import_entries (+ su lote) por los códigos de la página, agrupados por rol. */
async function lotsForPage(organizationId: string, rows: readonly { role: string; sourceCode: string }[]): Promise<Map<string, LedgerThirdPartyLotRef>> {
  const byRole = new Map<string, string[]>();
  for (const row of rows) byRole.set(row.role, [...(byRole.get(row.role) ?? []), row.sourceCode]);
  if (byRole.size === 0) return new Map();
  const entries = await prisma.ledgerImportEntry.findMany({
    where: {
      organizationId,
      sourceFiscalYear: THIRD_PARTY_ENTRY_FISCAL_YEAR,
      OR: [...byRole].map(([role, codes]) => ({ sourcePeriod: role, sourceEntryNumber: { in: codes } }))
    },
    select: { sourcePeriod: true, sourceEntryNumber: true, import: { select: { id: true, fileName: true, createdAt: true } } }
  });
  return latestLotByThirdParty(entries);
}

type ThirdPartyRow = Prisma.LedgerThirdPartyGetPayload<Record<string, never>>;

function toDto(row: ThirdPartyRow, lote: LedgerThirdPartyLotRef | null): LedgerThirdPartyDto {
  return {
    id: row.id,
    sourceCode: row.sourceCode,
    role: isThirdPartyRole(row.role) ? row.role : "supplier",
    sourceAccount: row.sourceAccount,
    taxId: row.taxId,
    countryCode: row.countryCode,
    name: thirdPartyDisplayName(row),
    supplierId: row.supplierId,
    updatedAt: row.updatedAt.toISOString(),
    lote
  };
}

/**
 * Directorio de solo lectura de los terceros importados de la organización: página keyset
 * ordenada por rol y código Sage con `total` del filtro, `nextCursor` y el lote de cada fila.
 */
export async function listLedgerThirdParties(input: { context: UserContext; q?: string | null; role?: LedgerThirdPartyRole | null; limit?: number | null; cursor?: string | null }): Promise<LedgerThirdPartyPage> {
  requirePermissions(input.context, ["accounting.read"]);
  const organizationId = input.context.organizationId;
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? LEDGER_THIRD_PARTY_LIST_DEFAULT_LIMIT), 1), LEDGER_THIRD_PARTY_LIST_MAX_LIMIT);
  const cursor = decodeCursor(input.cursor ?? null);
  const filter = buildThirdPartyWhere({ organizationId, q: input.q, role: input.role });
  const where: Prisma.LedgerThirdPartyWhereInput = cursor ? { AND: [filter, thirdPartyCursorWhere(cursor)] } : filter;
  const [total, rows] = await Promise.all([
    prisma.ledgerThirdParty.count({ where: filter }),
    prisma.ledgerThirdParty.findMany({ where, orderBy: [{ role: "asc" }, { sourceCode: "asc" }, { id: "asc" }], take: limit + 1 })
  ]);
  const page = buildPage(rows, limit, total, thirdPartyCursorKey);
  const lots = await lotsForPage(organizationId, page.items);
  return {
    rows: page.items.map((row) => toDto(row, lots.get(lotKey(row.role, row.sourceCode)) ?? null)),
    total,
    nextCursor: page.nextCursor
  };
}

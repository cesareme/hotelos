// Banking España: importación CSB-43 (Norma 43) que PERSISTE y concilia, y
// remesas SEPA (Norma 19/34) persistidas (lote tesoreria-banca).
//
// Antes, «Importar y conciliar» parseaba el fichero y devolvía coincidencias
// en memoria (nada quedaba al recargar). Ahora:
//   1. cada cuenta del fichero se resuelve a un BankAccount de la propiedad
//      por IBAN (derivado del CCC del registro 11); si no existe se crea con
//      los datos del fichero (aviso en la respuesta), nunca en otra propiedad;
//   2. extracto + movimientos se guardan con `persistStatement` (saldos
//      inicial/final declarados por los registros 11/33, deduplicación por
//      huella: reimportar el mismo fichero no duplica nada);
//   3. el auto-match del módulo banking aplica las coincidencias altas/medias
//      (cobros, liquidaciones de datáfono, facturas de proveedor, nóminas,
//      comisiones) con su efecto contable y deja sugerencias en el resto.
// La respuesta conserva la forma que lee la pantalla «Extractos y remesas»
// (accounts[].movements/matches/unmatchedMovementIdxs, unmatchedPayments) y
// añade statementId/bankAccountId/persisted/newLines/duplicateLines/warnings.

import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { BadRequestError, HttpError, NotFoundError } from "../../lib/http-error.js";
import { createBankAccount, findBankAccountByIban } from "../banking/bank-account.service.js";
import { getStatement, persistStatement, type StatementLineInput } from "../banking/bank-statement.service.js";
import { autoMatchStatement, loadCandidates, type AutoMatchDetail } from "../banking/reconciliation.service.js";
import { createRemittance, type CreateRemittanceResult } from "../treasury/sepa-remittance.service.js";
import { fromCents, isoDay } from "../treasury/money.js";
import { TREASURY_WRITE_KEYS, requireAnyPermission } from "../treasury/permissions.js";
import { parseCsb43File, type Csb43Account, type Csb43Movement } from "./csb43.parser.js";
import { validateIban, type SepaRemittance } from "./sepa-norma19.generator.js";

export type Csb43AccountImport = Csb43Account & {
  bankAccountId: string | null;
  statementId: string | null;
  persisted: boolean;
  newLines: number;
  duplicateLines: number;
  matches: Array<{ movementIndex: number; paymentId: string; matchType: string; confidence: "high" | "medium" | "low"; reason: string }>;
  unmatchedMovementIdxs: number[];
  warnings: string[];
};

export type Csb43ImportResult = {
  accounts: Csb43AccountImport[];
  unmatchedPayments: string[];
  warnings: string[];
};

function movementToLine(movement: Csb43Movement): StatementLineInput {
  const description = movement.descriptions.join(" | ") || `Concepto ${movement.conceptCode}${movement.ownConceptCode ? `/${movement.ownConceptCode}` : ""}`;
  return {
    txDate: new Date(`${movement.operationDate}T00:00:00Z`),
    valueDate: movement.valueDate ? new Date(`${movement.valueDate}T00:00:00Z`) : null,
    amount: fromCents(movement.amountCents),
    description,
    reference: movement.referenceA ?? movement.referenceB ?? movement.documentNumber,
    counterparty: null,
    fingerprint: movement.fingerprint,
    raw: {
      conceptCode: movement.conceptCode,
      ownConceptCode: movement.ownConceptCode,
      documentNumber: movement.documentNumber,
      referenceA: movement.referenceA,
      referenceB: movement.referenceB,
      lineNumber: movement.lineNumber,
      descriptions: movement.descriptions
    }
  };
}

async function resolveBankAccount(input: { context: UserContext; propertyId: string; account: Csb43Account; bankAccountId?: string | null; createMissing: boolean; warnings: string[] }): Promise<string | null> {
  if (input.bankAccountId) {
    const explicit = await prisma.bankAccount.findFirst({ where: { id: input.bankAccountId, propertyId: input.propertyId } });
    if (!explicit) throw new NotFoundError("La cuenta bancaria indicada no existe en esta propiedad.");
    if (explicit.iban && explicit.iban.replace(/\s+/g, "").toUpperCase() !== input.account.iban) {
      input.warnings.push(`El IBAN del fichero (${input.account.iban}) no coincide con el de la cuenta ${explicit.name} (${explicit.iban}).`);
    }
    return explicit.id;
  }
  const byIban = await findBankAccountByIban(input.propertyId, input.account.iban);
  if (byIban) return byIban.id;
  if (!input.createMissing) return null;
  const created = await createBankAccount({
    context: input.context,
    propertyId: input.propertyId,
    name: `${input.account.ownerName ?? "Cuenta"} ····${input.account.accountNumber.slice(-4)}`,
    bankName: `Entidad ${input.account.bankCode}`,
    iban: input.account.iban,
    currencyCode: input.account.currency,
    openingBalance: fromCents(input.account.initialBalanceCents).toFixed(2)
  });
  input.warnings.push(`Cuenta bancaria creada desde el fichero: «${created.name}» (${input.account.iban}). Asigna su subcuenta 572 si no es la general.`);
  return created.id;
}

/**
 * Importa un fichero CSB-43: persiste extracto y movimientos por cuenta,
 * concilia automáticamente y devuelve el resultado con las coincidencias.
 */
export async function importCsb43(input: {
  context: UserContext;
  propertyId: string;
  content: string;
  bankAccountId?: string | null;
  /** false → una cuenta desconocida se reporta (409 en la cuenta) en vez de crearse. */
  createMissingAccount?: boolean;
  autoMatch?: boolean;
}): Promise<Csb43ImportResult> {
  requireAnyPermission(input.context, TREASURY_WRITE_KEYS);
  if (!input.content || input.content.length < 50) throw new BadRequestError("Fichero CSB-43 inválido o vacío.");
  const property = await prisma.property.findUnique({ where: { id: input.propertyId }, select: { organizationId: true } });
  if (!property) throw new NotFoundError("La propiedad no existe.");

  const parsed = parseCsb43File(input.content);
  if (parsed.accounts.length === 0) throw new BadRequestError("No se encontraron cuentas en el fichero (falta el registro 11).");
  if (input.bankAccountId && parsed.accounts.length > 1) throw new BadRequestError("El fichero trae varias cuentas: no se puede forzar una sola cuenta bancaria.");
  const warnings = [...parsed.warnings];
  const accounts: Csb43AccountImport[] = [];
  const matchedPaymentIds = new Set<string>();
  const candidatePaymentIds = new Set<string>();

  for (const account of parsed.accounts) {
    const accountWarnings = [...account.warnings];
    const bankAccountId = await resolveBankAccount({ context: input.context, propertyId: input.propertyId, account, bankAccountId: input.bankAccountId, createMissing: input.createMissingAccount !== false, warnings: accountWarnings });
    if (!bankAccountId) {
      accountWarnings.push(`No hay cuenta bancaria con IBAN ${account.iban} en la propiedad: crea la cuenta y vuelve a importar.`);
      accounts.push({ ...account, bankAccountId: null, statementId: null, persisted: false, newLines: 0, duplicateLines: 0, matches: [], unmatchedMovementIdxs: account.movements.map((_, i) => i), warnings: accountWarnings });
      continue;
    }
    if (account.movements.length === 0) {
      accountWarnings.push("La cuenta no trae movimientos (registros 22).");
      accounts.push({ ...account, bankAccountId, statementId: null, persisted: false, newLines: 0, duplicateLines: 0, matches: [], unmatchedMovementIdxs: [], warnings: accountWarnings });
      continue;
    }

    let statementId: string | null = null;
    let persisted = false;
    let newLines = 0;
    let duplicateLines = 0;
    let lineIds: Array<string | null> = account.movements.map(() => null);
    try {
      const result = await persistStatement({
        bankAccountId,
        source: "csb43",
        lines: account.movements.map(movementToLine),
        openingBalance: fromCents(account.initialBalanceCents),
        closingBalance: account.finalBalanceCents !== 0 || account.warnings.length === 0 ? fromCents(account.finalBalanceCents) : null,
        periodStart: account.fromDate ? new Date(`${account.fromDate}T00:00:00Z`) : null,
        periodEnd: account.toDate ? new Date(`${account.toDate}T00:00:00Z`) : null
      });
      statementId = result.statementId;
      persisted = true;
      newLines = result.newLines;
      duplicateLines = result.duplicateLines;
      lineIds = result.lineIds;
      accountWarnings.push(...result.warnings);
    } catch (error) {
      // Honest: the whole file was already imported → report the existing statement, no 409 for the screen.
      const details = error instanceof HttpError ? (error.details as { code?: string; statementId?: string | null; duplicateLines?: number } | undefined) : undefined;
      if (details?.code !== "STATEMENT_ALREADY_IMPORTED") throw error;
      statementId = details.statementId ?? null;
      duplicateLines = details.duplicateLines ?? account.movements.length;
      accountWarnings.push("Todos los movimientos de esta cuenta ya estaban importados: no se ha creado un extracto nuevo.");
    }

    // Auto-match (also for a previously imported statement: pending lines may now have candidates).
    const matches: Csb43AccountImport["matches"] = [];
    const unmatchedMovementIdxs: number[] = [];
    if (statementId && input.autoMatch !== false) {
      const auto = await autoMatchStatement(statementId, { context: input.context });
      const detailByLine = new Map<string, AutoMatchDetail>(auto.details.map((d) => [d.bankLineId, d]));
      const detail = await getStatement(statementId);
      const matchByLine = new Map(detail.lines.map((l) => [l.id, l.match]));
      if (lineIds.every((id) => id === null)) {
        // Duplicate import: map movements to the stored lines by fingerprint.
        const idByFingerprint = new Map(detail.lines.map((l) => [l.fingerprint, l.id]));
        lineIds = account.movements.map((m) => idByFingerprint.get(m.fingerprint) ?? null);
      }
      account.movements.forEach((_, index) => {
        const lineId = lineIds[index];
        const match = lineId ? matchByLine.get(lineId) : null;
        if (match) {
          const d = lineId ? detailByLine.get(lineId) : undefined;
          const confidence = (d?.confidence ?? (match.confidence?.replace("auto_", "") || "medium")) as "high" | "medium" | "low";
          matches.push({ movementIndex: index, paymentId: match.matchedEntityId, matchType: match.matchType, confidence: confidence === "high" || confidence === "low" ? confidence : "medium", reason: d?.reason ?? match.matchType });
          if (match.matchType === "payment") matchedPaymentIds.add(match.matchedEntityId);
        } else {
          unmatchedMovementIdxs.push(index);
        }
      });
      const bankAccount = await prisma.bankAccount.findUnique({ where: { id: bankAccountId } });
      if (bankAccount) {
        const { candidates } = await loadCandidates(bankAccount, detail.lines.length ? new Date(detail.periodStart) : new Date(), detail.lines.length ? new Date(detail.periodEnd) : new Date());
        for (const c of candidates) if (c.kind === "payment") candidatePaymentIds.add(c.id);
      }
    } else {
      account.movements.forEach((_, index) => unmatchedMovementIdxs.push(index));
    }

    accounts.push({ ...account, bankAccountId, statementId, persisted, newLines, duplicateLines, matches, unmatchedMovementIdxs, warnings: accountWarnings });
  }

  const unmatchedPayments = Array.from(candidatePaymentIds).filter((id) => !matchedPaymentIds.has(id));
  return { accounts, unmatchedPayments, warnings };
}

/**
 * Genera y PERSISTE una remesa SEPA Norma 19 (pain.008). Respuesta compatible
 * con la pantalla (messageId, xml, totalAmount, transactions, warnings) más
 * el id y el estado de la remesa guardada.
 */
export async function generateRemittance(input: { context: UserContext; remittance: SepaRemittance; propertyId?: string | null; correlationId?: string }): Promise<{ id: string; status: string; messageId: string; xml: string; totalAmount: number; transactions: number; warnings: string[] }> {
  const propertyId = input.propertyId ?? input.context.propertyId;
  const result: CreateRemittanceResult = await createRemittance({ context: input.context, propertyId, kind: "norma19", body: input.remittance, correlationId: input.correlationId });
  return { id: result.id, status: result.status, messageId: result.messageId, xml: result.xml, totalAmount: Number(result.totalAmount), transactions: result.transactions, warnings: result.warnings };
}

export { validateIban };

/** Helper for tests: ISO day of a parsed movement. */
export function movementDay(movement: Csb43Movement): string {
  return isoDay(new Date(`${movement.operationDate}T00:00:00Z`));
}

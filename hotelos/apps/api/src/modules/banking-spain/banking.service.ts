// Banking service (España): expone CSB-43 reconciliation + Norma 19 remesas
// como API consumible por la UI y otros servicios.

import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";
import { BadRequestError } from "../../lib/http-error.js";
import { parseCsb43, reconcileMovements, type Csb43Account, type ReconciliationCandidate, type ReconciliationMatch } from "./csb43.parser.js";
import { generateSepaRemittance, validateIban, type SepaRemittance } from "./sepa-norma19.generator.js";

/**
 * Sube un fichero CSB-43, lo parsea y devuelve cuentas + matches contra
 * `Payment` (status=captured) en una ventana de ±15 días.
 */
export async function importCsb43(input: {
  context: UserContext;
  propertyId: string;
  content: string;
}): Promise<{
  accounts: Array<Csb43Account & { matches: ReconciliationMatch[]; unmatchedMovementIdxs: number[] }>;
  unmatchedPayments: string[];
}> {
  requirePermissions(input.context, ["accounting.journal.post"]);
  if (!input.content || input.content.length < 50) {
    throw new BadRequestError("Fichero CSB-43 inválido o vacío.");
  }

  const accounts = parseCsb43(input.content);
  if (accounts.length === 0) {
    throw new BadRequestError("No se encontraron cuentas en el fichero.");
  }

  // Para conciliar, listamos los Payment con status=captured de la propiedad en
  // un rango más amplio que el del extracto (los movimientos suelen llegar 1-2
  // días después de la captura).
  const dates = accounts.flatMap((a) => [new Date(a.fromDate), new Date(a.toDate)]);
  const earliest = new Date(Math.min(...dates.map((d) => d.getTime())));
  const latest = new Date(Math.max(...dates.map((d) => d.getTime())));
  earliest.setUTCDate(earliest.getUTCDate() - 15);
  latest.setUTCDate(latest.getUTCDate() + 15);
  const paymentsRaw = await prisma.payment.findMany({
    where: {
      propertyId: input.propertyId,
      status: "captured",
      createdAt: { gte: earliest, lte: latest }
    },
    select: { id: true, amount: true, pspReference: true, createdAt: true }
  });
  const candidates: ReconciliationCandidate[] = paymentsRaw.map((p) => ({
    paymentId: p.id,
    amount: Number(p.amount),
    pspReference: p.pspReference,
    createdAt: p.createdAt
  }));

  const enriched: Array<Csb43Account & { matches: ReconciliationMatch[]; unmatchedMovementIdxs: number[] }> = [];
  const usedPayments = new Set<string>();
  for (const account of accounts) {
    const result = reconcileMovements(account.movements, candidates.filter((c) => !usedPayments.has(c.paymentId)));
    for (const m of result.matches) usedPayments.add(m.paymentId);
    enriched.push({ ...account, matches: result.matches, unmatchedMovementIdxs: result.unmatchedMovements });
  }
  const unmatchedPayments = candidates.filter((c) => !usedPayments.has(c.paymentId)).map((c) => c.paymentId);
  return { accounts: enriched, unmatchedPayments };
}

/**
 * Genera un fichero SEPA Norma 19 a partir de la solicitud. Devuelve XML + un
 * messageId que sirve de idempotency key.
 */
export async function generateRemittance(input: {
  context: UserContext;
  remittance: SepaRemittance;
}): Promise<{ messageId: string; xml: string; totalAmount: number; transactions: number; warnings: string[] }> {
  requirePermissions(input.context, ["accounting.journal.post"]);
  const warnings: string[] = [];
  if (!validateIban(input.remittance.creditor.iban)) {
    throw new BadRequestError("IBAN del acreedor no válido.");
  }
  for (const d of input.remittance.debtors) {
    if (!validateIban(d.iban)) warnings.push(`IBAN inválido para deudor "${d.name}".`);
    if (d.amount <= 0) warnings.push(`Importe no positivo para deudor "${d.name}".`);
  }
  if (input.remittance.debtors.length === 0) {
    throw new BadRequestError("Al menos un deudor es obligatorio.");
  }
  const result = generateSepaRemittance(input.remittance);
  return { ...result, totalAmount: result.control.totalAmount, transactions: result.control.transactions, warnings };
}

export { validateIban };

// Treasury: cash position, receivables, payables and 30/60/90 forecast
// (lote tesoreria-banca). Read-only over the ledger and the operational
// tables; every figure says where it comes from.
//
//   position     570 Caja and every bank account: ledger balance (posted
//                entries on 572 / the account's subaccount) and, when a
//                statement exists, the bank's closing balance — the
//                "reconciled" figure prefers the statement. 5721 (datáfono
//                pendiente de liquidar) and 5722 (pasarela) are shown as
//                pending settlements. NEVER the historical sum of payments.
//   receivables  issued invoices net of rectifications and of the payments
//                linked to them (or to their folio, FIFO), plus the balance of
//                open folios that have no invoice yet (charges − payments +
//                refunds). Aging by issue date / departure date.
//   payables     received invoices approved/posted and unpaid, calculated
//                payroll not paid (net), channel commissions accrued and not
//                settled, and the tax/social liabilities the ledger carries
//                (4750 IVA, 4751 retenciones, 476 SS).
//   forecast     the same items placed on their expected date (due date, or
//                issue + 30 days when the document has no due date — flagged
//                `assumed`), bucketed 0-30 / 31-60 / 61-90 / >90 and overdue,
//                with the projected balance after each horizon.

import { prisma } from "@hotelos/database";
import type { Prisma } from "@prisma/client";
import { NotFoundError } from "../../lib/http-error.js";
import { ledgerBalances } from "./ledger-bridge.js";
import { addDays, dayUtc, daysBetween, dec, isoDay, money, round2, sum, type Dec } from "./money.js";
import { DEFAULT_BANK_LEDGER_CODE } from "../banking/bank-account.service.js";
import { folioDisplayLabel } from "../folio/folio-labels.js";

export const CASH_CODE = "570";
export const CARD_PENDING_CODE = "5721";
export const PSP_PENDING_CODE = "5722";
export const VAT_PAYABLE_CODE = "4750";
export const WITHHOLDING_PAYABLE_CODE = "4751";
export const SS_PAYABLE_CODE = "476";
const DEFAULT_PAYMENT_TERMS_DAYS = 30;

export type TreasuryBankRow = {
  bankAccountId: string;
  name: string;
  ibanMasked: string | null;
  ledgerAccountCode: string;
  ledgerBalance: string;
  statementClosing: string | null;
  statementDate: string | null;
  /** statementClosing when a statement exists, else the ledger balance. */
  reconciledBalance: string;
  drift: string;
  unmatchedLines: number;
  unmatchedAmount: string;
};

export type TreasuryPosition = {
  propertyId: string;
  organizationId: string;
  asOf: string;
  cash: { ledgerAccountCode: string; balance: string };
  banks: TreasuryBankRow[];
  pendingSettlements: { cardTerminal: string; paymentGateway: string; total: string };
  totals: { cashAndBanks: string; receivables: string; payables: string; net: string };
  source: "ledger" | "ledger+statements";
  warnings: string[];
};

export type ReceivableItem = {
  kind: "invoice" | "folio";
  id: string;
  reference: string;
  counterparty: string;
  date: string;
  expectedOn: string;
  assumedDate: boolean;
  amount: string;
  outstanding: string;
  daysOverdue: number;
};

export type PayableItem = {
  kind: "supplier_bill" | "payroll_period" | "commission_accrual" | "tax_liability";
  id: string;
  reference: string;
  counterparty: string;
  date: string;
  expectedOn: string;
  assumedDate: boolean;
  amount: string;
  outstanding: string;
  daysOverdue: number;
};

export type AgingBuckets = { current: string; days0_30: string; days31_60: string; days61_90: string; days90Plus: string; total: string };

export type Receivables = { propertyId: string; asOf: string; total: string; invoices: string; openFolios: string; aging: AgingBuckets; items: ReceivableItem[]; method: string[] };
export type Payables = { propertyId: string; asOf: string; total: string; supplierBills: string; payroll: string; commissions: string; taxLiabilities: string; aging: AgingBuckets; items: PayableItem[]; method: string[] };

export type ForecastBucket = { label: "overdue" | "0-30" | "31-60" | "61-90" | "90+"; from: string | null; to: string | null; inflows: string; outflows: string; net: string };
export type TreasuryForecast = {
  propertyId: string;
  asOf: string;
  opening: string;
  buckets: ForecastBucket[];
  horizons: Array<{ days: 30 | 60 | 90; inflows: string; outflows: string; projectedBalance: string }>;
  items: Array<(ReceivableItem & { direction: "in" }) | (PayableItem & { direction: "out" })>;
  assumptions: string[];
};

function maskIban(iban: string | null): string | null {
  if (!iban) return null;
  const clean = iban.replace(/\s+/g, "");
  return clean.length > 8 ? `${clean.slice(0, 4)} •••• ${clean.slice(-4)}` : clean;
}

async function organizationOf(propertyId: string): Promise<string> {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { organizationId: true } });
  if (!property) throw new NotFoundError("La propiedad no existe.");
  return property.organizationId;
}

function emptyAging(): { current: Dec; days0_30: Dec; days31_60: Dec; days61_90: Dec; days90Plus: Dec } {
  return { current: dec(0), days0_30: dec(0), days31_60: dec(0), days61_90: dec(0), days90Plus: dec(0) };
}

function addAging(buckets: ReturnType<typeof emptyAging>, days: number, amount: Dec): void {
  if (days < 0) buckets.current = buckets.current.plus(amount);
  else if (days <= 30) buckets.days0_30 = buckets.days0_30.plus(amount);
  else if (days <= 60) buckets.days31_60 = buckets.days31_60.plus(amount);
  else if (days <= 90) buckets.days61_90 = buckets.days61_90.plus(amount);
  else buckets.days90Plus = buckets.days90Plus.plus(amount);
}

function agingOut(b: ReturnType<typeof emptyAging>): AgingBuckets {
  return { current: money(b.current), days0_30: money(b.days0_30), days31_60: money(b.days31_60), days61_90: money(b.days61_90), days90Plus: money(b.days90Plus), total: money(sum([b.current, b.days0_30, b.days31_60, b.days61_90, b.days90Plus])) };
}

// ---- Position -----------------------------------------------------------------------

export async function treasuryPosition(input: { propertyId: string; asOf?: Date }): Promise<TreasuryPosition> {
  const asOf = dayUtc(input.asOf ?? new Date());
  const organizationId = await organizationOf(input.propertyId);
  const warnings: string[] = [];
  const bankAccounts = await prisma.bankAccount.findMany({ where: { propertyId: input.propertyId, active: true }, orderBy: { name: "asc" } });
  const bankCodes = Array.from(new Set(bankAccounts.map((b) => b.ledgerAccountCode ?? DEFAULT_BANK_LEDGER_CODE)));
  const codes = Array.from(new Set([CASH_CODE, CARD_PENDING_CODE, PSP_PENDING_CODE, DEFAULT_BANK_LEDGER_CODE, ...bankCodes]));
  const balances = await ledgerBalances(organizationId, codes, { propertyId: input.propertyId, asOf });
  const anyEntry = await prisma.journalEntry.findFirst({ where: { organizationId, status: { in: ["posted", "reversed"] } }, select: { id: true } });
  if (!anyEntry) warnings.push("La organización no tiene asientos contabilizados: los saldos de caja y bancos del libro son 0 hasta que la contabilidad esté al día.");

  const banks: TreasuryBankRow[] = [];
  let statementsUsed = false;
  const sharedCodeCount = new Map<string, number>();
  for (const b of bankAccounts) {
    const code = b.ledgerAccountCode ?? DEFAULT_BANK_LEDGER_CODE;
    sharedCodeCount.set(code, (sharedCodeCount.get(code) ?? 0) + 1);
  }
  for (const account of bankAccounts) {
    const code = account.ledgerAccountCode ?? DEFAULT_BANK_LEDGER_CODE;
    const ledgerBalance = round2(balances.get(code) ?? dec(0));
    const statement = await prisma.bankStatement.findFirst({ where: { bankAccountId: account.id, periodEnd: { lte: addDays(asOf, 1) } }, orderBy: { periodEnd: "desc" } });
    const lines = await prisma.bankStatementLine.findMany({ where: { bankAccountId: account.id }, select: { id: true, amount: true } });
    const matched = lines.length ? await prisma.reconciliationMatch.findMany({ where: { bankLineId: { in: lines.map((l) => l.id) } }, select: { bankLineId: true } }) : [];
    const matchedIds = new Set(matched.map((m) => m.bankLineId));
    const unmatched = lines.filter((l) => !matchedIds.has(l.id));
    const closing = statement ? round2(dec(statement.closingBalance)) : null;
    if (closing !== null) statementsUsed = true;
    if ((sharedCodeCount.get(code) ?? 0) > 1) warnings.push(`Varias cuentas bancarias comparten la subcuenta ${code}: el saldo del libro se repite en cada una; asigna una subcuenta 572.x por cuenta.`);
    banks.push({
      bankAccountId: account.id,
      name: account.name,
      ibanMasked: maskIban(account.iban),
      ledgerAccountCode: code,
      ledgerBalance: money(ledgerBalance),
      statementClosing: closing === null ? null : money(closing),
      statementDate: statement ? isoDay(statement.periodEnd) : null,
      reconciledBalance: money(closing ?? ledgerBalance),
      drift: money(closing === null ? dec(0) : closing.minus(ledgerBalance)),
      unmatchedLines: unmatched.length,
      unmatchedAmount: money(sum(unmatched.map((l) => dec(l.amount))))
    });
  }
  // Ledger 572 (general) when no bank account is registered: still a bank balance.
  let banksTotal = sum(banks.map((b) => dec(b.reconciledBalance)));
  if (bankAccounts.length === 0) {
    banksTotal = round2(balances.get(DEFAULT_BANK_LEDGER_CODE) ?? dec(0));
    warnings.push("La propiedad no tiene cuentas bancarias registradas: se muestra el saldo contable de 572.");
  }
  const cash = round2(balances.get(CASH_CODE) ?? dec(0));
  const cardPending = round2(balances.get(CARD_PENDING_CODE) ?? dec(0));
  const pspPending = round2(balances.get(PSP_PENDING_CODE) ?? dec(0));
  const [receivables, payables] = await Promise.all([treasuryReceivables({ propertyId: input.propertyId, asOf }), treasuryPayables({ propertyId: input.propertyId, asOf })]);
  const cashAndBanks = round2(cash.plus(banksTotal));
  return {
    propertyId: input.propertyId,
    organizationId,
    asOf: isoDay(asOf),
    cash: { ledgerAccountCode: CASH_CODE, balance: money(cash) },
    banks,
    pendingSettlements: { cardTerminal: money(cardPending), paymentGateway: money(pspPending), total: money(cardPending.plus(pspPending)) },
    totals: { cashAndBanks: money(cashAndBanks), receivables: receivables.total, payables: payables.total, net: money(cashAndBanks.plus(dec(receivables.total)).minus(dec(payables.total))) },
    source: statementsUsed ? "ledger+statements" : "ledger",
    warnings: Array.from(new Set(warnings))
  };
}

// ---- Receivables ---------------------------------------------------------------------

type InvoiceRow = {
  id: string;
  invoiceNumber: string | null;
  status: string;
  issuedAt: Date | null;
  createdAt: Date;
  total: Prisma.Decimal;
  rectifyingForId: string | null;
  rectificationType: string | null;
  folioId: string | null;
  reservationId: string | null;
  paidAt: Date | null;
  customerName: string | null;
  customerTaxId: string | null;
  customerType: string;
};

export async function treasuryReceivables(input: { propertyId: string; asOf?: Date }): Promise<Receivables> {
  const asOf = dayUtc(input.asOf ?? new Date());
  const method = [
    "Facturas emitidas (no anuladas) netas de rectificativas: una rectificativa por sustitución reemplaza a la original; una por diferencias se suma a ella.",
    "Cobros descontados: los enlazados a la factura y, si viene de un folio, los cobros del folio no enlazados (FIFO por fecha de emisión).",
    "Folios abiertos sin factura: cargos − cobros + devoluciones.",
    "Vencimiento asumido a 30 días de la emisión (las facturas no tienen fecha de vencimiento) y a la salida en los folios."
  ];
  const invoices = (await prisma.invoice.findMany({
    where: { propertyId: input.propertyId, deletedAt: null, status: { in: ["issued", "rectified"] } },
    select: { id: true, invoiceNumber: true, status: true, issuedAt: true, createdAt: true, total: true, rectifyingForId: true, rectificationType: true, folioId: true, reservationId: true, paidAt: true, customerName: true, customerTaxId: true, customerType: true }
  })) as InvoiceRow[];
  const byId = new Map(invoices.map((i) => [i.id, i]));

  // Family = original + its rectifications; substitution (S) replaces the original amount.
  type Family = { root: InvoiceRow; members: InvoiceRow[]; amount: Dec };
  const families = new Map<string, Family>();
  const rootOf = (inv: InvoiceRow): InvoiceRow => {
    let current = inv;
    const seen = new Set<string>();
    while (current.rectifyingForId && byId.has(current.rectifyingForId) && !seen.has(current.id)) {
      seen.add(current.id);
      current = byId.get(current.rectifyingForId)!;
    }
    return current;
  };
  for (const inv of invoices) {
    const root = rootOf(inv);
    const family = families.get(root.id) ?? { root, members: [], amount: dec(0) };
    family.members.push(inv);
    families.set(root.id, family);
  }
  for (const family of families.values()) {
    const substitutions = family.members.filter((m) => m.id !== family.root.id && m.rectificationType === "S");
    const differences = family.members.filter((m) => m.id !== family.root.id && m.rectificationType !== "S");
    const base = substitutions.length > 0 ? sum(substitutions.map((m) => dec(m.total))) : dec(family.root.total);
    family.amount = round2(base.plus(sum(differences.map((m) => dec(m.total)))));
  }

  // Payments: linked to invoices, or to folios (unlinked) allocated FIFO.
  const invoiceIds = invoices.map((i) => i.id);
  const folioIds = Array.from(new Set(invoices.map((i) => i.folioId).filter((id): id is string => Boolean(id))));
  const payments = await prisma.payment.findMany({
    where: { propertyId: input.propertyId, status: "captured", deletedAt: null, createdAt: { lte: addDays(asOf, 1) }, OR: [{ invoiceId: { in: invoiceIds } }, { folioId: { in: folioIds }, invoiceId: null }] },
    select: { id: true, amount: true, invoiceId: true, folioId: true }
  });
  const refunds = payments.length ? await prisma.paymentRefund.findMany({ where: { paymentId: { in: payments.map((p) => p.id) }, status: { notIn: ["rejected", "failed", "cancelled"] } }, select: { paymentId: true, amount: true } }) : [];
  const refundByPayment = new Map<string, Dec>();
  for (const r of refunds) refundByPayment.set(r.paymentId, (refundByPayment.get(r.paymentId) ?? dec(0)).plus(dec(r.amount)));
  const netPayment = (p: { id: string; amount: Prisma.Decimal }): Dec => round2(dec(p.amount).minus(refundByPayment.get(p.id) ?? dec(0)));
  const paidByFamily = new Map<string, Dec>();
  const folioPool = new Map<string, Dec>();
  for (const p of payments) {
    if (p.invoiceId && byId.has(p.invoiceId)) {
      const root = rootOf(byId.get(p.invoiceId)!).id;
      paidByFamily.set(root, (paidByFamily.get(root) ?? dec(0)).plus(netPayment(p)));
    } else if (p.folioId) {
      folioPool.set(p.folioId, (folioPool.get(p.folioId) ?? dec(0)).plus(netPayment(p)));
    }
  }
  const items: ReceivableItem[] = [];
  const aging = emptyAging();
  let invoicesTotal = dec(0);
  const familiesByDate = Array.from(families.values()).sort((a, b) => (a.root.issuedAt ?? a.root.createdAt).getTime() - (b.root.issuedAt ?? b.root.createdAt).getTime());
  for (const family of familiesByDate) {
    const root = family.root;
    if (family.members.every((m) => m.paidAt)) continue;
    let paid = paidByFamily.get(root.id) ?? dec(0);
    if (root.folioId && folioPool.has(root.folioId)) {
      const pool = folioPool.get(root.folioId)!;
      const take = pool.gt(family.amount.minus(paid)) ? family.amount.minus(paid) : pool;
      if (take.gt(0)) {
        paid = paid.plus(take);
        folioPool.set(root.folioId, pool.minus(take));
      }
    }
    const outstanding = round2(family.amount.minus(paid));
    if (outstanding.lte(0)) continue;
    const issued = root.issuedAt ?? root.createdAt;
    const expectedOn = addDays(dayUtc(issued), DEFAULT_PAYMENT_TERMS_DAYS);
    const daysOverdue = daysBetween(asOf, expectedOn);
    addAging(aging, daysBetween(asOf, issued), outstanding);
    invoicesTotal = invoicesTotal.plus(outstanding);
    items.push({
      kind: "invoice",
      id: root.id,
      reference: root.invoiceNumber ?? root.id,
      counterparty: root.customerName ?? root.customerTaxId ?? (root.customerType === "business" ? "Empresa sin identificar" : "Cliente sin identificar"),
      date: isoDay(issued),
      expectedOn: isoDay(expectedOn),
      assumedDate: true,
      amount: money(family.amount),
      outstanding: money(outstanding),
      daysOverdue
    });
  }

  // Open folios without any invoice.
  const reservations = await prisma.reservation.findMany({ where: { propertyId: input.propertyId, deletedAt: null }, select: { id: true, code: true, departureDate: true, bookerName: true, companyName: true } });
  const reservationById = new Map(reservations.map((r) => [r.id, r]));
  const openFolios = reservations.length
    ? await prisma.folio.findMany({ where: { reservationId: { in: reservations.map((r) => r.id) }, status: "open", deletedAt: null }, select: { id: true, reservationId: true, label: true, invoices: { select: { id: true, status: true } } } })
    : [];
  const uninvoiced = openFolios.filter((f) => !f.invoices.some((i) => i.status !== "cancelled"));
  let foliosTotal = dec(0);
  if (uninvoiced.length > 0) {
    const ids = uninvoiced.map((f) => f.id);
    const [charges, folioPayments] = await Promise.all([
      prisma.folioLine.groupBy({ by: ["folioId"], where: { folioId: { in: ids }, deletedAt: null }, _sum: { total: true } }),
      prisma.payment.findMany({ where: { folioId: { in: ids }, status: "captured", deletedAt: null }, select: { id: true, folioId: true, amount: true } })
    ]);
    const folioRefunds = folioPayments.length ? await prisma.paymentRefund.findMany({ where: { paymentId: { in: folioPayments.map((p) => p.id) }, status: { notIn: ["rejected", "failed", "cancelled"] } }, select: { paymentId: true, amount: true } }) : [];
    const refundsByFolio = new Map<string, Dec>();
    const folioOfPayment = new Map(folioPayments.map((p) => [p.id, p.folioId]));
    for (const r of folioRefunds) {
      const folioId = folioOfPayment.get(r.paymentId);
      if (folioId) refundsByFolio.set(folioId, (refundsByFolio.get(folioId) ?? dec(0)).plus(dec(r.amount)));
    }
    const chargesByFolio = new Map(charges.map((c) => [c.folioId, dec(c._sum.total)]));
    const paymentsByFolio = new Map<string, Dec>();
    for (const p of folioPayments) paymentsByFolio.set(p.folioId, (paymentsByFolio.get(p.folioId) ?? dec(0)).plus(dec(p.amount)));
    for (const folio of uninvoiced) {
      const balance = round2((chargesByFolio.get(folio.id) ?? dec(0)).minus(paymentsByFolio.get(folio.id) ?? dec(0)).plus(refundsByFolio.get(folio.id) ?? dec(0)));
      if (balance.lte(0)) continue;
      const reservation = reservationById.get(folio.reservationId);
      const departure = reservation?.departureDate ? dayUtc(reservation.departureDate) : asOf;
      const expectedOn = departure < asOf ? asOf : departure;
      foliosTotal = foliosTotal.plus(balance);
      addAging(aging, daysBetween(asOf, departure), balance);
      items.push({
        kind: "folio",
        id: folio.id,
        reference: folioReceivableReference(reservation?.code ?? folio.reservationId, folio.label),
        counterparty: reservation?.companyName ?? reservation?.bookerName ?? "Huésped",
        date: isoDay(departure),
        expectedOn: isoDay(expectedOn),
        assumedDate: false,
        amount: money(balance),
        outstanding: money(balance),
        daysOverdue: daysBetween(asOf, expectedOn)
      });
    }
  }
  items.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return { propertyId: input.propertyId, asOf: isoDay(asOf), total: money(invoicesTotal.plus(foliosTotal)), invoices: money(invoicesTotal), openFolios: money(foliosTotal), aging: agingOut(aging), items, method };
}

// ---- Payables -------------------------------------------------------------------------

function quarterSettlementDate(date: Date): Date {
  // Modelo 303 / 111 trimestral: día 20 del mes siguiente al trimestre (30 de enero para el 4T).
  const month = date.getUTCMonth();
  const quarterEndMonth = Math.floor(month / 3) * 3 + 2;
  const year = date.getUTCFullYear();
  if (quarterEndMonth === 11) return new Date(Date.UTC(year + 1, 0, 30));
  return new Date(Date.UTC(year, quarterEndMonth + 1, 20));
}

function socialSecurityDueDate(date: Date): Date {
  // Cuotas SS: último día del mes siguiente al devengo.
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 2, 0));
}

export async function treasuryPayables(input: { propertyId: string; asOf?: Date }): Promise<Payables> {
  const asOf = dayUtc(input.asOf ?? new Date());
  const organizationId = await organizationOf(input.propertyId);
  const method = [
    "Facturas recibidas aprobadas o contabilizadas sin fecha de pago (vencimiento: fecha de vencimiento o emisión + 30 días).",
    "Nóminas calculadas y no pagadas (líquido; fecha: fin del periodo).",
    "Comisiones de canal devengadas y no liquidadas (fecha asumida: devengo + 30 días).",
    "Obligaciones del libro: 4750 IVA a ingresar (día 20 tras el trimestre), 4751 retenciones (idem), 476 Seguridad Social (fin del mes siguiente)."
  ];
  const items: PayableItem[] = [];
  const aging = emptyAging();
  let supplierTotal = dec(0);
  let payrollTotal = dec(0);
  let commissionTotal = dec(0);
  let taxTotal = dec(0);

  const bills = await prisma.supplierBill.findMany({
    where: { propertyId: input.propertyId, status: { in: ["approved", "posted"] }, paymentDate: null, cancelledAt: null },
    select: { id: true, total: true, dueDate: true, issueDate: true, createdAt: true, invoiceNumber: true, supplierName: true }
  });
  for (const bill of bills) {
    const total = round2(dec(bill.total));
    if (total.lte(0)) continue;
    const issue = bill.issueDate ?? bill.createdAt;
    const expectedOn = bill.dueDate ?? addDays(dayUtc(issue), DEFAULT_PAYMENT_TERMS_DAYS);
    supplierTotal = supplierTotal.plus(total);
    addAging(aging, daysBetween(asOf, expectedOn), total);
    items.push({ kind: "supplier_bill", id: bill.id, reference: bill.invoiceNumber ?? bill.id, counterparty: bill.supplierName ?? "Proveedor", date: isoDay(issue), expectedOn: isoDay(expectedOn), assumedDate: !bill.dueDate, amount: money(total), outstanding: money(total), daysOverdue: daysBetween(asOf, expectedOn) });
  }

  const periods = await prisma.payrollPeriod.findMany({ where: { organizationId, OR: [{ propertyId: input.propertyId }, { propertyId: null }], status: { in: ["calculated", "exported"] }, paidAt: null }, select: { id: true, periodCode: true, totalNet: true, endDate: true } });
  for (const period of periods) {
    const net = round2(dec(period.totalNet));
    if (net.lte(0)) continue;
    payrollTotal = payrollTotal.plus(net);
    addAging(aging, daysBetween(asOf, period.endDate), net);
    items.push({ kind: "payroll_period", id: period.id, reference: `Nóminas ${period.periodCode}`, counterparty: "Personal", date: isoDay(period.endDate), expectedOn: isoDay(period.endDate), assumedDate: false, amount: money(net), outstanding: money(net), daysOverdue: daysBetween(asOf, period.endDate) });
  }

  const accruals = await prisma.commissionAccrual.findMany({ where: { propertyId: input.propertyId, status: "accrued" }, select: { id: true, commissionAmount: true, accruedAt: true, channelCode: true, channelId: true, reservationId: true } });
  for (const accrual of accruals) {
    const amount = round2(dec(accrual.commissionAmount));
    if (amount.lte(0)) continue;
    const expectedOn = addDays(dayUtc(accrual.accruedAt), DEFAULT_PAYMENT_TERMS_DAYS);
    commissionTotal = commissionTotal.plus(amount);
    addAging(aging, daysBetween(asOf, expectedOn), amount);
    items.push({ kind: "commission_accrual", id: accrual.id, reference: accrual.reservationId ?? accrual.id, counterparty: `Canal ${accrual.channelCode ?? accrual.channelId ?? ""}`.trim(), date: isoDay(accrual.accruedAt), expectedOn: isoDay(expectedOn), assumedDate: true, amount: money(amount), outstanding: money(amount), daysOverdue: daysBetween(asOf, expectedOn) });
  }

  const balances = await ledgerBalances(organizationId, [VAT_PAYABLE_CODE, WITHHOLDING_PAYABLE_CODE, SS_PAYABLE_CODE], { propertyId: input.propertyId, asOf });
  const liabilities: Array<{ code: string; label: string; due: Date }> = [
    { code: VAT_PAYABLE_CODE, label: "IVA a ingresar (Modelo 303)", due: quarterSettlementDate(asOf) },
    { code: WITHHOLDING_PAYABLE_CODE, label: "Retenciones IRPF (Modelo 111/115)", due: quarterSettlementDate(asOf) },
    { code: SS_PAYABLE_CODE, label: "Seguridad Social acreedora", due: socialSecurityDueDate(asOf) }
  ];
  for (const liability of liabilities) {
    const credit = round2((balances.get(liability.code) ?? dec(0)).neg()); // credit balance = amount owed
    if (credit.lte(0)) continue;
    taxTotal = taxTotal.plus(credit);
    addAging(aging, daysBetween(asOf, liability.due), credit);
    items.push({ kind: "tax_liability", id: liability.code, reference: liability.code, counterparty: liability.label, date: isoDay(asOf), expectedOn: isoDay(liability.due), assumedDate: false, amount: money(credit), outstanding: money(credit), daysOverdue: daysBetween(asOf, liability.due) });
  }
  items.sort((a, b) => b.daysOverdue - a.daysOverdue);
  return {
    propertyId: input.propertyId,
    asOf: isoDay(asOf),
    total: money(sum([supplierTotal, payrollTotal, commissionTotal, taxTotal])),
    supplierBills: money(supplierTotal),
    payroll: money(payrollTotal),
    commissions: money(commissionTotal),
    taxLiabilities: money(taxTotal),
    aging: agingOut(aging),
    items,
    method
  };
}

// ---- Forecast -------------------------------------------------------------------------

/**
 * `reference` of an uninvoiced open folio in the receivables list:
 * «RES-00081 · Huésped». The reservation code (or its id when the reservation
 * is gone) plus the folio label in Spanish — the primary folio is stored as
 * "guest", so the raw value must never reach the screen (qa#6).
 */
export function folioReceivableReference(reservationRef: string, folioLabel: string | null | undefined): string {
  return `${reservationRef} · ${folioDisplayLabel(folioLabel)}`;
}

export function bucketFor(asOf: Date, expectedOn: Date): ForecastBucket["label"] {
  const days = daysBetween(expectedOn, asOf);
  if (days < 0) return "overdue";
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

/** Pure bucketing used by the forecast and its unit test. */
export function buildForecast(input: { asOf: Date; opening: Dec; inflows: Array<{ expectedOn: Date; amount: Dec }>; outflows: Array<{ expectedOn: Date; amount: Dec }> }): { buckets: ForecastBucket[]; horizons: TreasuryForecast["horizons"] } {
  const labels: ForecastBucket["label"][] = ["overdue", "0-30", "31-60", "61-90", "90+"];
  const totals = new Map<ForecastBucket["label"], { inflows: Dec; outflows: Dec }>(labels.map((l) => [l, { inflows: dec(0), outflows: dec(0) }]));
  for (const item of input.inflows) totals.get(bucketFor(input.asOf, item.expectedOn))!.inflows = totals.get(bucketFor(input.asOf, item.expectedOn))!.inflows.plus(item.amount);
  for (const item of input.outflows) totals.get(bucketFor(input.asOf, item.expectedOn))!.outflows = totals.get(bucketFor(input.asOf, item.expectedOn))!.outflows.plus(item.amount);
  const edges: Record<ForecastBucket["label"], { from: number | null; to: number | null }> = { overdue: { from: null, to: -1 }, "0-30": { from: 0, to: 30 }, "31-60": { from: 31, to: 60 }, "61-90": { from: 61, to: 90 }, "90+": { from: 91, to: null } };
  const buckets: ForecastBucket[] = labels.map((label) => {
    const t = totals.get(label)!;
    return { label, from: edges[label].from === null ? null : isoDay(addDays(input.asOf, edges[label].from!)), to: edges[label].to === null ? null : isoDay(addDays(input.asOf, edges[label].to!)), inflows: money(t.inflows), outflows: money(t.outflows), net: money(t.inflows.minus(t.outflows)) };
  });
  const horizons: TreasuryForecast["horizons"] = [];
  for (const days of [30, 60, 90] as const) {
    const inflows = sum(input.inflows.filter((i) => daysBetween(i.expectedOn, input.asOf) <= days).map((i) => i.amount));
    const outflows = sum(input.outflows.filter((o) => daysBetween(o.expectedOn, input.asOf) <= days).map((o) => o.amount));
    horizons.push({ days, inflows: money(inflows), outflows: money(outflows), projectedBalance: money(input.opening.plus(inflows).minus(outflows)) });
  }
  return { buckets, horizons };
}

export async function treasuryForecast(input: { propertyId: string; asOf?: Date }): Promise<TreasuryForecast> {
  const asOf = dayUtc(input.asOf ?? new Date());
  const [position, receivables, payables] = await Promise.all([treasuryPosition({ propertyId: input.propertyId, asOf }), treasuryReceivables({ propertyId: input.propertyId, asOf }), treasuryPayables({ propertyId: input.propertyId, asOf })]);
  const inflows = receivables.items.map((i) => ({ expectedOn: dayUtc(i.expectedOn), amount: dec(i.outstanding) }));
  const outflows = payables.items.map((i) => ({ expectedOn: dayUtc(i.expectedOn), amount: dec(i.outstanding) }));
  const { buckets, horizons } = buildForecast({ asOf, opening: dec(position.totals.cashAndBanks), inflows, outflows });
  const items: TreasuryForecast["items"] = [
    ...receivables.items.map((i) => ({ ...i, direction: "in" as const })),
    ...payables.items.map((i) => ({ ...i, direction: "out" as const }))
  ].sort((a, b) => a.expectedOn.localeCompare(b.expectedOn));
  return {
    propertyId: input.propertyId,
    asOf: isoDay(asOf),
    opening: position.totals.cashAndBanks,
    buckets,
    horizons,
    items,
    assumptions: [
      "Saldo inicial = caja (570) + saldo conciliado de cada cuenta bancaria (extracto si existe, si no el libro).",
      "Vencido = fecha esperada anterior a hoy; los importes vencidos cuentan en todos los horizontes.",
      ...receivables.method,
      ...payables.method,
      ...position.warnings
    ]
  };
}

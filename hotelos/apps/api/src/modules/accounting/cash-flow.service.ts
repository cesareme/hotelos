import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";

export type CashFlowItem = { description: string; amount: number };
export type WorkingCapitalChange = { category: string; amount: number };

export type CashFlowStatement = {
  organizationId: string;
  propertyId?: string;
  periodStart: string;
  periodEnd: string;
  generatedAt: string;
  operating: {
    netIncome: number;
    depreciation: number;
    workingCapitalChanges: WorkingCapitalChange[];
    subtotal: number;
  };
  investing: {
    items: CashFlowItem[];
    subtotal: number;
  };
  financing: {
    items: CashFlowItem[];
    subtotal: number;
  };
  netChangeInCash: number;
  openingCash: number;
  closingCash: number;
};

function dateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// Cash and equivalents (PGC): 570 caja euros, 571 caja moneda extranjera, 572 bancos cuenta corriente,
// 573 bancos cuenta corriente moneda extranjera, 574 caja postal.
const CASH_3 = new Set(["570", "571", "572", "573", "574"]);

// AR (clientes / deudores receivables): 430, 431, 432, 433, 434, 435, 436, 440, 441, 446, 449, 460
const AR_3 = new Set(["430", "431", "432", "433", "434", "435", "436", "440", "441", "446", "449", "460"]);

// AP (proveedores / acreedores payables): 400, 401, 402, 403, 405, 406, 410, 411, 419
const AP_3 = new Set(["400", "401", "402", "403", "405", "406", "410", "411", "419"]);

// Inventory (existencias): 30x-39x — i.e. account class 3
function isInventory(code: string): boolean {
  return code.startsWith("3") && !AR_3.has(code.slice(0, 3));
}

// Depreciation expense in PGC: cuenta 68x (dotaciones para amortización)
const DEPRECIATION_PREFIX2 = ["68"];

// Fixed assets (investing) — cuentas 20-27 (excluding 28x acc. depreciation)
const FIXED_ASSET_PREFIXES = ["20", "21", "22", "23", "24", "25", "26", "27"];

// Financing: 17x long-term debt, 10x capital, 11x reserves (changes), 52x short-term debt with banks,
// dividends payable 526.
const LONG_TERM_DEBT_PREFIX2 = ["17"];
const SHORT_TERM_DEBT_PREFIX2 = ["52"];
const CAPITAL_PREFIX2 = ["10"];
const RESERVES_PREFIX2 = ["11"];
const DIVIDENDS_3 = new Set(["526"]);

type Aggregated = {
  accountCode: string;
  accountName: string;
  accountType: string;
  debit: number;
  credit: number;
};

async function aggregateInRange(input: {
  organizationId: string;
  propertyId?: string;
  gte?: Date;
  lt?: Date;
  lte?: Date;
}): Promise<Aggregated[]> {
  const postedAt: { gte?: Date; lt?: Date; lte?: Date } = {};
  if (input.gte) postedAt.gte = input.gte;
  if (input.lt) postedAt.lt = input.lt;
  if (input.lte) postedAt.lte = input.lte;

  const entries = await prisma.journalEntry.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.propertyId ? { propertyId: input.propertyId } : {}),
      status: "posted",
      ...(Object.keys(postedAt).length > 0 ? { postedAt } : {})
    },
    select: { id: true }
  });
  if (entries.length === 0) return [];

  const lines = await prisma.journalLine.findMany({
    where: { journalEntryId: { in: entries.map((e) => e.id) } }
  });
  const accountIds = Array.from(new Set(lines.map((l) => l.accountId)));
  const accounts = await prisma.account.findMany({ where: { id: { in: accountIds } } });
  const accountById = new Map(accounts.map((a) => [a.id, a]));

  const grouped = new Map<string, Aggregated>();
  for (const line of lines) {
    const account = accountById.get(line.accountId);
    if (!account) continue;
    const debit = Number(line.debit);
    const credit = Number(line.credit);
    const existing = grouped.get(account.code);
    if (existing) {
      existing.debit += debit;
      existing.credit += credit;
    } else {
      grouped.set(account.code, {
        accountCode: account.code,
        accountName: account.name,
        accountType: account.accountType,
        debit,
        credit
      });
    }
  }
  return Array.from(grouped.values());
}

function cashBalance(aggregated: Aggregated[]): number {
  let cash = 0;
  for (const row of aggregated) {
    if (row.accountType !== "asset") continue;
    if (!CASH_3.has(row.accountCode.slice(0, 3))) continue;
    cash += row.debit - row.credit;
  }
  return round(cash);
}

function netIncome(aggregated: Aggregated[]): number {
  let revenue = 0;
  let expense = 0;
  for (const row of aggregated) {
    if (row.accountType === "revenue") revenue += row.credit - row.debit;
    else if (row.accountType === "expense") expense += row.debit - row.credit;
  }
  return round(revenue - expense);
}

function depreciationFromPeriod(aggregated: Aggregated[]): number {
  let total = 0;
  for (const row of aggregated) {
    if (row.accountType !== "expense") continue;
    if (DEPRECIATION_PREFIX2.includes(row.accountCode.slice(0, 2))) {
      total += row.debit - row.credit;
    }
  }
  return round(total);
}

/**
 * Working capital change for receivables/inventory: an increase in the asset means cash was used
 * (negative impact). So delta = -(closing - opening) = opening - closing.
 * For payables (liability): an increase means cash was preserved (positive impact). So
 * delta = closing - opening.
 */
function computeWorkingCapital(opening: Aggregated[], closing: Aggregated[]): WorkingCapitalChange[] {
  const openBalanceByCode = new Map<string, { code: string; type: string; debitNetBalance: number; creditNetBalance: number }>();
  for (const row of opening) {
    openBalanceByCode.set(row.accountCode, {
      code: row.accountCode,
      type: row.accountType,
      debitNetBalance: row.debit - row.credit,
      creditNetBalance: row.credit - row.debit
    });
  }
  const closeBalanceByCode = new Map<string, { code: string; type: string; debitNetBalance: number; creditNetBalance: number }>();
  for (const row of closing) {
    closeBalanceByCode.set(row.accountCode, {
      code: row.accountCode,
      type: row.accountType,
      debitNetBalance: row.debit - row.credit,
      creditNetBalance: row.credit - row.debit
    });
  }

  let arDelta = 0;
  let invDelta = 0;
  let apDelta = 0;
  let otherCurrentLiabDelta = 0;

  const allCodes = new Set<string>([...openBalanceByCode.keys(), ...closeBalanceByCode.keys()]);
  for (const code of allCodes) {
    const open = openBalanceByCode.get(code);
    const close = closeBalanceByCode.get(code);
    const type = (open ?? close)?.type;
    if (!type) continue;
    const p3 = code.slice(0, 3);

    if (type === "asset" && AR_3.has(p3)) {
      const openVal = open?.debitNetBalance ?? 0;
      const closeVal = close?.debitNetBalance ?? 0;
      arDelta += openVal - closeVal; // decrease in AR -> +cash
      continue;
    }
    if (type === "asset" && isInventory(code)) {
      const openVal = open?.debitNetBalance ?? 0;
      const closeVal = close?.debitNetBalance ?? 0;
      invDelta += openVal - closeVal;
      continue;
    }
    if (type === "liability" && AP_3.has(p3)) {
      const openVal = open?.creditNetBalance ?? 0;
      const closeVal = close?.creditNetBalance ?? 0;
      apDelta += closeVal - openVal; // increase in AP -> +cash
      continue;
    }
    if (type === "liability") {
      // Other current liabilities excluding LT debt and ST bank debt (handled in financing)
      const p2 = code.slice(0, 2);
      if (LONG_TERM_DEBT_PREFIX2.includes(p2)) continue;
      if (SHORT_TERM_DEBT_PREFIX2.includes(p2)) continue;
      // tax/SS/etc payables (475, 476, 477, 4750-series)
      if (["475", "476", "477"].includes(p3)) {
        const openVal = open?.creditNetBalance ?? 0;
        const closeVal = close?.creditNetBalance ?? 0;
        otherCurrentLiabDelta += closeVal - openVal;
      }
    }
  }

  return [
    { category: "Cambio en cuentas a cobrar (clientes/deudores)", amount: round(arDelta) },
    { category: "Cambio en existencias", amount: round(invDelta) },
    { category: "Cambio en cuentas a pagar (proveedores/acreedores)", amount: round(apDelta) },
    { category: "Cambio en pasivos corrientes fiscales (475/476/477)", amount: round(otherCurrentLiabDelta) }
  ];
}

function investingItems(aggregated: Aggregated[]): CashFlowItem[] {
  const items: CashFlowItem[] = [];
  for (const row of aggregated) {
    if (row.accountType !== "asset") continue;
    const p2 = row.accountCode.slice(0, 2);
    if (!FIXED_ASSET_PREFIXES.includes(p2)) continue;
    const net = row.debit - row.credit; // positive = purchase (cash outflow), negative = sale (inflow)
    if (Math.abs(net) < 0.01) continue;
    items.push({
      description: `${row.accountCode} ${row.accountName}`,
      amount: round(-net) // outflow -> negative cash impact
    });
  }
  return items;
}

function financingItems(aggregated: Aggregated[]): CashFlowItem[] {
  const items: CashFlowItem[] = [];
  for (const row of aggregated) {
    const p2 = row.accountCode.slice(0, 2);
    const p3 = row.accountCode.slice(0, 3);
    if (row.accountType === "liability" && LONG_TERM_DEBT_PREFIX2.includes(p2)) {
      const delta = row.credit - row.debit; // increase = inflow
      if (Math.abs(delta) < 0.01) continue;
      items.push({
        description: `${row.accountCode} ${row.accountName} (deuda a largo plazo)`,
        amount: round(delta)
      });
      continue;
    }
    if (row.accountType === "liability" && SHORT_TERM_DEBT_PREFIX2.includes(p2)) {
      const delta = row.credit - row.debit;
      if (Math.abs(delta) < 0.01) continue;
      items.push({
        description: `${row.accountCode} ${row.accountName} (deuda a corto plazo)`,
        amount: round(delta)
      });
      continue;
    }
    if (row.accountType === "equity" && CAPITAL_PREFIX2.includes(p2)) {
      const delta = row.credit - row.debit;
      if (Math.abs(delta) < 0.01) continue;
      items.push({
        description: `${row.accountCode} ${row.accountName} (aportaciones de capital)`,
        amount: round(delta)
      });
      continue;
    }
    if (row.accountType === "equity" && RESERVES_PREFIX2.includes(p2)) {
      const delta = row.credit - row.debit;
      if (Math.abs(delta) < 0.01) continue;
      items.push({
        description: `${row.accountCode} ${row.accountName} (reservas)`,
        amount: round(delta)
      });
      continue;
    }
    if (row.accountType === "liability" && DIVIDENDS_3.has(p3)) {
      const delta = row.credit - row.debit;
      if (Math.abs(delta) < 0.01) continue;
      items.push({
        description: `${row.accountCode} ${row.accountName} (dividendos)`,
        amount: round(-delta) // dividend payment is a cash outflow
      });
    }
  }
  return items;
}

export async function buildCashFlow(input: {
  context: UserContext;
  propertyId?: string;
  fromDate: string;
  toDate: string;
}): Promise<CashFlowStatement> {
  requirePermissions(input.context, ["analytics.read"]);

  if (input.fromDate >= input.toDate) {
    throw new Error("fromDate must be before toDate.");
  }

  const start = dateOnly(input.fromDate);
  const end = dateOnly(input.toDate);

  // Period aggregates (postings within [start, end))
  const periodAgg = await aggregateInRange({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    gte: start,
    lt: end
  });

  // Opening balances: cumulative up to (not including) start
  const openingAgg = await aggregateInRange({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    lt: start
  });

  // Closing balances: cumulative up to (not including) end
  const closingAgg = await aggregateInRange({
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    lt: end
  });

  const openingCash = cashBalance(openingAgg);
  const closingCash = cashBalance(closingAgg);

  const ni = netIncome(periodAgg);
  const depreciation = depreciationFromPeriod(periodAgg);
  const workingCapitalChanges = computeWorkingCapital(openingAgg, closingAgg);
  const wcSubtotal = workingCapitalChanges.reduce((s, c) => s + c.amount, 0);
  const operatingSubtotal = round(ni + depreciation + wcSubtotal);

  const investing = investingItems(periodAgg);
  const investingSubtotal = round(investing.reduce((s, i) => s + i.amount, 0));

  const financing = financingItems(periodAgg);
  const financingSubtotal = round(financing.reduce((s, i) => s + i.amount, 0));

  const netChangeInCash = round(operatingSubtotal + investingSubtotal + financingSubtotal);

  return {
    organizationId: input.context.organizationId,
    propertyId: input.propertyId,
    periodStart: input.fromDate,
    periodEnd: input.toDate,
    generatedAt: new Date().toISOString(),
    operating: {
      netIncome: ni,
      depreciation,
      workingCapitalChanges,
      subtotal: operatingSubtotal
    },
    investing: {
      items: investing,
      subtotal: investingSubtotal
    },
    financing: {
      items: financing,
      subtotal: financingSubtotal
    },
    netChangeInCash,
    openingCash,
    closingCash
  };
}

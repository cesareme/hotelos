import { prisma } from "@hotelos/database";
import { createId } from "../../lib/ids.js";

// ---- Number helper ----

function num(value: unknown): number {
  if (value == null) return 0;
  return Number(typeof value === "object" && value !== null && "toString" in value ? value.toString() : value);
}

// ---- Date parsing ----
// We accept either ISO (YYYY-MM-DD) or European DD/MM/YYYY (also DD-MM-YYYY,
// DD.MM.YYYY). Time component is ignored if present.

export function parseLiberalDate(input: string): Date {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Empty date");
  // YYYY-MM-DD (anchored or with time suffix)
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(trimmed);
  if (iso) {
    const [, y, m, d] = iso;
    const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    if (Number.isNaN(dt.getTime())) throw new Error(`Bad date: ${input}`);
    return dt;
  }
  // DD/MM/YYYY or DD-MM-YYYY or DD.MM.YYYY
  const eu = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(trimmed);
  if (eu) {
    const [, dStr, mStr, yStr] = eu;
    let y = Number(yStr);
    if (yStr.length === 2) y = 2000 + y;
    const dt = new Date(Date.UTC(y, Number(mStr) - 1, Number(dStr)));
    if (Number.isNaN(dt.getTime())) throw new Error(`Bad date: ${input}`);
    return dt;
  }
  // Last-ditch fallback — let JS try.
  const dt = new Date(trimmed);
  if (Number.isNaN(dt.getTime())) throw new Error(`Unrecognised date format: ${input}`);
  return dt;
}

// ---- Amount parsing ----
// Comma OR dot decimal. Strip whitespace and any thousands separators.

export function parseLiberalAmount(input: string): number {
  let s = input.trim();
  if (!s) throw new Error("Empty amount");
  // Spanish/European format: 1.234,56 → 1234.56
  // English format: 1,234.56 → 1234.56
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    const lastComma = s.lastIndexOf(",");
    const lastDot = s.lastIndexOf(".");
    if (lastComma > lastDot) {
      // comma is decimal separator → drop dots, swap commas to dots
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      // dot is decimal separator → drop commas
      s = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    // comma is decimal separator
    s = s.replace(",", ".");
  }
  // sign: leading +/- or trailing - (some banks)
  s = s.replace(/\s+/g, "");
  if (s.endsWith("-")) s = "-" + s.slice(0, -1);
  const n = Number(s);
  if (Number.isNaN(n)) throw new Error(`Unrecognised amount: ${input}`);
  return Math.round(n * 100) / 100;
}

// ---- CSV parsing ----
// Strict-enough CSV. Handles double-quoted fields, escaped quotes, and either
// comma or semicolon separators (auto-detected from the header).

function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === sep) {
      out.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  out.push(cell);
  return out.map((c) => c.trim());
}

function detectSeparator(headerLine: string): string {
  return headerLine.includes(";") && !headerLine.includes(",") ? ";" : ",";
}

type ParsedLine = {
  txDate: Date;
  amount: number;
  description: string | null;
  reference: string | null;
  counterparty: string | null;
};

function parseCsv(csv: string): { lines: ParsedLine[]; header: string[] } {
  const rows = csv
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  if (rows.length < 1) throw new Error("CSV is empty.");
  const sep = detectSeparator(rows[0]);
  const header = splitCsvLine(rows[0], sep).map((h) => h.toLowerCase());
  const idx = (...names: string[]) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const dateI = idx("date", "fecha", "tx_date", "txdate");
  const amountI = idx("amount", "importe", "monto");
  const descI = idx("description", "descripcion", "descripción", "concepto");
  const refI = idx("reference", "referencia", "ref");
  const cpI = idx("counterparty", "beneficiario", "contraparte");

  if (dateI < 0) throw new Error('CSV header missing "date" column.');
  if (amountI < 0) throw new Error('CSV header missing "amount" column.');

  const lines: ParsedLine[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = splitCsvLine(rows[r], sep);
    if (cells.length === 1 && cells[0] === "") continue;
    const rawDate = cells[dateI] ?? "";
    const rawAmount = cells[amountI] ?? "";
    if (!rawDate && !rawAmount) continue;
    try {
      const line: ParsedLine = {
        txDate: parseLiberalDate(rawDate),
        amount: parseLiberalAmount(rawAmount),
        description: descI >= 0 ? cells[descI] || null : null,
        reference: refI >= 0 ? cells[refI] || null : null,
        counterparty: cpI >= 0 ? cells[cpI] || null : null
      };
      lines.push(line);
    } catch (e) {
      throw new Error(`Row ${r + 1}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { lines, header };
}

// ---- Public API ----

export async function listStatements(bankAccountId: string) {
  const statements = await prisma.bankStatement.findMany({
    where: { bankAccountId },
    orderBy: { periodEnd: "desc" }
  });
  return statements.map((s) => ({
    id: s.id,
    bankAccountId: s.bankAccountId,
    propertyId: s.propertyId,
    periodStart: s.periodStart.toISOString(),
    periodEnd: s.periodEnd.toISOString(),
    openingBalance: num(s.openingBalance),
    closingBalance: num(s.closingBalance),
    source: s.source,
    status: s.status,
    importedAt: s.importedAt.toISOString()
  }));
}

export async function getStatement(id: string) {
  const statement = await prisma.bankStatement.findUnique({ where: { id } });
  if (!statement) throw new Error(`Statement ${id} not found.`);
  const lines = await prisma.bankStatementLine.findMany({
    where: { statementId: id },
    orderBy: { txDate: "asc" }
  });
  const lineIds = lines.map((l) => l.id);
  const matches = lineIds.length
    ? await prisma.reconciliationMatch.findMany({ where: { bankLineId: { in: lineIds } } })
    : [];
  const matchByLine = new Map(matches.map((m) => [m.bankLineId, m]));

  return {
    id: statement.id,
    bankAccountId: statement.bankAccountId,
    propertyId: statement.propertyId,
    periodStart: statement.periodStart.toISOString(),
    periodEnd: statement.periodEnd.toISOString(),
    openingBalance: num(statement.openingBalance),
    closingBalance: num(statement.closingBalance),
    source: statement.source,
    status: statement.status,
    importedAt: statement.importedAt.toISOString(),
    lines: lines.map((l) => {
      const match = matchByLine.get(l.id);
      return {
        id: l.id,
        statementId: l.statementId,
        bankAccountId: l.bankAccountId,
        txDate: l.txDate.toISOString(),
        valueDate: l.valueDate?.toISOString() ?? null,
        amount: num(l.amount),
        currencyCode: l.currencyCode,
        description: l.description,
        reference: l.reference,
        counterparty: l.counterparty,
        matchedTo: l.matchedTo,
        match: match
          ? {
              id: match.id,
              matchType: match.matchType,
              matchedEntityId: match.matchedEntityId,
              amount: num(match.amount),
              matchedAt: match.matchedAt.toISOString(),
              confidence: match.confidence,
              notes: match.notes
            }
          : null
      };
    })
  };
}

export async function importStatementFromCsv(input: {
  bankAccountId: string;
  csv: string;
  source?: string;
}) {
  const account = await prisma.bankAccount.findUnique({ where: { id: input.bankAccountId } });
  if (!account) throw new Error(`Bank account ${input.bankAccountId} not found.`);

  const { lines } = parseCsv(input.csv);
  if (lines.length === 0) throw new Error("CSV contained no data rows.");

  // Period start / end from min/max txDate.
  let periodStart = lines[0].txDate;
  let periodEnd = lines[0].txDate;
  for (const line of lines) {
    if (line.txDate < periodStart) periodStart = line.txDate;
    if (line.txDate > periodEnd) periodEnd = line.txDate;
  }

  // Opening = current ledger / previous closing if any; closing = opening + sum.
  const previous = await prisma.bankStatement.findFirst({
    where: { bankAccountId: input.bankAccountId, periodEnd: { lte: periodStart } },
    orderBy: { periodEnd: "desc" }
  });
  const opening = previous ? num(previous.closingBalance) : num(account.openingBalance);
  const movement = lines.reduce((acc, l) => acc + l.amount, 0);
  const closing = Math.round((opening + movement) * 100) / 100;

  const statementId = createId("bstmt");

  await prisma.$transaction(async (tx) => {
    await tx.bankStatement.create({
      data: {
        id: statementId,
        bankAccountId: input.bankAccountId,
        propertyId: account.propertyId,
        periodStart,
        periodEnd,
        openingBalance: opening,
        closingBalance: closing,
        source: input.source ?? "csv",
        status: "pending"
      }
    });
    await tx.bankStatementLine.createMany({
      data: lines.map((line) => ({
        id: createId("bln"),
        statementId,
        bankAccountId: input.bankAccountId,
        txDate: line.txDate,
        valueDate: null,
        amount: line.amount,
        currencyCode: account.currencyCode,
        description: line.description,
        reference: line.reference,
        counterparty: line.counterparty,
        rawJson: undefined
      }))
    });
  });

  return getStatement(statementId);
}

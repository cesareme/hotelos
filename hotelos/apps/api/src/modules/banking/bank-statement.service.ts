// Bank statements: import (CSV and, through banking-spain, CSB43/Norma 43),
// persistence and read models.
//
// Lote tesoreria-banca:
//   · every import PERSISTS the statement and its lines (bank_statements /
//     bank_statement_lines) — nothing lives only in memory any more;
//   · lines carry a stable `fingerprint` (rawJson.fingerprint) so re-importing
//     the same file, or a file that overlaps a previous one, skips the lines
//     already stored (one bank movement is never stored twice);
//   · money is Decimal end to end; the wire keeps numbers (2 decimals) for the
//     existing admin-web screen.

import { createHash } from "node:crypto";
import { prisma } from "@hotelos/database";
import type { Prisma } from "@prisma/client";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/http-error.js";
import { createId } from "../../lib/ids.js";
import { dayUtc, dec, isoDay, money, moneyNumber, round2, sum, type Dec } from "../treasury/money.js";

// ---- Date parsing ----
// ISO (YYYY-MM-DD) or European DD/MM/YYYY (also DD-MM-YYYY, DD.MM.YYYY).

export function parseLiberalDate(input: string): Date {
  const trimmed = input.trim();
  if (!trimmed) throw new BadRequestError("Fecha vacía.");
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(trimmed);
  if (iso) {
    const [, y, m, d] = iso;
    const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
    if (Number.isNaN(dt.getTime())) throw new BadRequestError(`Fecha no válida: ${input}`);
    return dt;
  }
  const eu = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(trimmed);
  if (eu) {
    const [, dStr, mStr, yStr] = eu;
    let y = Number(yStr);
    if (yStr!.length === 2) y = 2000 + y;
    const dt = new Date(Date.UTC(y, Number(mStr) - 1, Number(dStr)));
    if (Number.isNaN(dt.getTime())) throw new BadRequestError(`Fecha no válida: ${input}`);
    return dt;
  }
  const dt = new Date(trimmed);
  if (Number.isNaN(dt.getTime())) throw new BadRequestError(`Formato de fecha no reconocido: ${input}`);
  return dayUtc(dt);
}

// ---- Amount parsing ----
// Comma OR dot decimal; thousands separators stripped; trailing minus accepted.

export function parseLiberalAmount(input: string): Dec {
  let s = input.trim();
  if (!s) throw new BadRequestError("Importe vacío.");
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (hasComma) {
    s = s.replace(",", ".");
  }
  s = s.replace(/\s+/g, "").replace(/€/g, "");
  if (s.endsWith("-")) s = `-${s.slice(0, -1)}`;
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) throw new BadRequestError(`Importe no reconocido: ${input}`);
  return round2(dec(s));
}

// ---- CSV parsing ----

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
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === sep) {
      out.push(cell);
      cell = "";
    } else cell += ch;
  }
  out.push(cell);
  return out.map((c) => c.trim());
}

function detectSeparator(headerLine: string): string {
  return headerLine.includes(";") && !headerLine.includes(",") ? ";" : ",";
}

export type StatementLineInput = {
  txDate: Date;
  valueDate?: Date | null;
  amount: Dec;
  description: string | null;
  reference: string | null;
  counterparty: string | null;
  /** Stable identity of the movement; computed here when the source has none. */
  fingerprint?: string;
  raw?: Record<string, unknown>;
};

export function parseStatementCsv(csv: string): StatementLineInput[] {
  const rows = csv
    .replace(/^﻿/, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  if (rows.length < 1) throw new BadRequestError("El CSV está vacío.");
  const sep = detectSeparator(rows[0]!);
  const header = splitCsvLine(rows[0]!, sep).map((h) => h.toLowerCase());
  const idx = (...names: string[]) => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const dateI = idx("date", "fecha", "tx_date", "txdate", "fecha operacion", "fecha operación", "f. operativa");
  const valueI = idx("value_date", "fecha valor", "valuedate", "f. valor");
  const amountI = idx("amount", "importe", "monto");
  const descI = idx("description", "descripcion", "descripción", "concepto");
  const refI = idx("reference", "referencia", "ref");
  const cpI = idx("counterparty", "beneficiario", "contraparte", "ordenante");
  if (dateI < 0) throw new BadRequestError("La cabecera del CSV no tiene columna de fecha (date/fecha).");
  if (amountI < 0) throw new BadRequestError("La cabecera del CSV no tiene columna de importe (amount/importe).");

  const lines: StatementLineInput[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = splitCsvLine(rows[r]!, sep);
    if (cells.length === 1 && cells[0] === "") continue;
    const rawDate = cells[dateI] ?? "";
    const rawAmount = cells[amountI] ?? "";
    if (!rawDate && !rawAmount) continue;
    try {
      lines.push({
        txDate: parseLiberalDate(rawDate),
        valueDate: valueI >= 0 && cells[valueI] ? parseLiberalDate(cells[valueI]!) : null,
        amount: parseLiberalAmount(rawAmount),
        description: descI >= 0 ? cells[descI] || null : null,
        reference: refI >= 0 ? cells[refI] || null : null,
        counterparty: cpI >= 0 ? cells[cpI] || null : null
      });
    } catch (e) {
      throw new BadRequestError(`Fila ${r + 1}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return lines;
}

/** Fingerprint of a line without a native identity (CSV): date + cents + texts + ordinal among identical siblings. */
export function assignFingerprints(lines: StatementLineInput[]): void {
  const seen = new Map<string, number>();
  for (const line of lines) {
    if (line.fingerprint) continue;
    const material = [isoDay(line.txDate), round2(line.amount).mul(100).toFixed(0), line.description ?? "", line.reference ?? "", line.counterparty ?? ""].join("|");
    const ordinal = (seen.get(material) ?? 0) + 1;
    seen.set(material, ordinal);
    line.fingerprint = createHash("sha1").update(`${material}#${ordinal}`).digest("hex");
  }
}

// ---- Read models ----

export type StatementSummary = {
  id: string;
  bankAccountId: string;
  propertyId: string;
  periodStart: string;
  periodEnd: string;
  openingBalance: number;
  closingBalance: number;
  source: string | null;
  status: string;
  importedAt: string;
  lineCount?: number;
  matchedCount?: number;
};

function mapStatement(s: {
  id: string;
  bankAccountId: string;
  propertyId: string;
  periodStart: Date;
  periodEnd: Date;
  openingBalance: Prisma.Decimal;
  closingBalance: Prisma.Decimal;
  source: string | null;
  status: string;
  importedAt: Date;
}): StatementSummary {
  return {
    id: s.id,
    bankAccountId: s.bankAccountId,
    propertyId: s.propertyId,
    periodStart: s.periodStart.toISOString(),
    periodEnd: s.periodEnd.toISOString(),
    openingBalance: moneyNumber(s.openingBalance),
    closingBalance: moneyNumber(s.closingBalance),
    source: s.source,
    status: s.status,
    importedAt: s.importedAt.toISOString()
  };
}

export async function listStatements(bankAccountId: string): Promise<StatementSummary[]> {
  const statements = await prisma.bankStatement.findMany({ where: { bankAccountId }, orderBy: { periodEnd: "desc" } });
  if (statements.length === 0) return [];
  const ids = statements.map((s) => s.id);
  const lines = await prisma.bankStatementLine.findMany({ where: { statementId: { in: ids } }, select: { id: true, statementId: true } });
  const matches = lines.length
    ? await prisma.reconciliationMatch.findMany({ where: { bankLineId: { in: lines.map((l) => l.id) } }, select: { bankLineId: true } })
    : [];
  const matchedLineIds = new Set(matches.map((m) => m.bankLineId));
  const countByStatement = new Map<string, { lines: number; matched: number }>();
  for (const line of lines) {
    const agg = countByStatement.get(line.statementId) ?? { lines: 0, matched: 0 };
    agg.lines++;
    if (matchedLineIds.has(line.id)) agg.matched++;
    countByStatement.set(line.statementId, agg);
  }
  return statements.map((s) => ({
    ...mapStatement(s),
    lineCount: countByStatement.get(s.id)?.lines ?? 0,
    matchedCount: countByStatement.get(s.id)?.matched ?? 0
  }));
}

export type StatementLineView = {
  id: string;
  statementId: string;
  bankAccountId: string;
  txDate: string;
  valueDate: string | null;
  amount: number;
  currencyCode: string;
  description: string | null;
  reference: string | null;
  counterparty: string | null;
  fingerprint: string | null;
  matchedTo: string | null;
  match: {
    id: string;
    matchType: string;
    matchedEntityId: string;
    amount: number;
    matchedAt: string;
    confidence: string | null;
    notes: string | null;
    journalEntryId: string | null;
  } | null;
};

export type StatementDetail = StatementSummary & { lines: StatementLineView[] };

/** The journal entry a match produced is kept inside `notes` as JSON ({ journalEntryId, … }). */
export function parseMatchNotes(notes: string | null): { journalEntryId?: string; paymentIds?: string[]; fee?: string; text?: string } {
  if (!notes) return {};
  try {
    const parsed = JSON.parse(notes) as unknown;
    if (parsed && typeof parsed === "object") return parsed as { journalEntryId?: string; paymentIds?: string[]; fee?: string; text?: string };
  } catch {
    // free text note written by the legacy screen
  }
  return { text: notes };
}

export async function getStatement(id: string): Promise<StatementDetail> {
  const statement = await prisma.bankStatement.findUnique({ where: { id } });
  if (!statement) throw new NotFoundError("El extracto no existe.");
  const lines = await prisma.bankStatementLine.findMany({ where: { statementId: id }, orderBy: [{ txDate: "asc" }, { id: "asc" }] });
  const lineIds = lines.map((l) => l.id);
  const matches = lineIds.length ? await prisma.reconciliationMatch.findMany({ where: { bankLineId: { in: lineIds } } }) : [];
  const matchByLine = new Map(matches.map((m) => [m.bankLineId, m]));
  return {
    ...mapStatement(statement),
    lineCount: lines.length,
    matchedCount: matches.length,
    lines: lines.map((l) => {
      const match = matchByLine.get(l.id);
      const raw = (l.rawJson ?? {}) as Record<string, unknown>;
      return {
        id: l.id,
        statementId: l.statementId,
        bankAccountId: l.bankAccountId,
        txDate: l.txDate.toISOString(),
        valueDate: l.valueDate?.toISOString() ?? null,
        amount: moneyNumber(l.amount),
        currencyCode: l.currencyCode,
        description: l.description,
        reference: l.reference,
        counterparty: l.counterparty,
        fingerprint: typeof raw.fingerprint === "string" ? raw.fingerprint : null,
        matchedTo: l.matchedTo,
        match: match
          ? {
              id: match.id,
              matchType: match.matchType,
              matchedEntityId: match.matchedEntityId,
              amount: moneyNumber(match.amount),
              matchedAt: match.matchedAt.toISOString(),
              confidence: match.confidence,
              notes: parseMatchNotes(match.notes).text ?? null,
              journalEntryId: parseMatchNotes(match.notes).journalEntryId ?? null
            }
          : null
      };
    })
  };
}

// ---- Persistence (shared by CSV and CSB43 imports) ----

export type PersistStatementInput = {
  bankAccountId: string;
  source: string;
  lines: StatementLineInput[];
  /** Declared by the file (CSB43 record 11); otherwise the previous closing / account opening. */
  openingBalance?: Dec | null;
  /** Declared by the file (CSB43 record 33); otherwise opening + Σ new lines. */
  closingBalance?: Dec | null;
  periodStart?: Date | null;
  periodEnd?: Date | null;
};

export type PersistStatementResult = {
  statementId: string;
  newLines: number;
  duplicateLines: number;
  /** ids of the persisted lines, in input order (null for the duplicates). */
  lineIds: Array<string | null>;
  warnings: string[];
};

/**
 * Stores a statement and its lines, skipping every line whose fingerprint is
 * already stored on the same bank account. When nothing is new the statement is
 * NOT created and a 409 STATEMENT_ALREADY_IMPORTED names the existing one.
 */
export async function persistStatement(input: PersistStatementInput): Promise<PersistStatementResult> {
  const account = await prisma.bankAccount.findUnique({ where: { id: input.bankAccountId } });
  if (!account) throw new NotFoundError("La cuenta bancaria no existe.");
  if (input.lines.length === 0) throw new BadRequestError("El extracto no contiene movimientos.");
  assignFingerprints(input.lines);

  let periodStart = input.periodStart ?? input.lines[0]!.txDate;
  let periodEnd = input.periodEnd ?? input.lines[0]!.txDate;
  for (const line of input.lines) {
    if (line.txDate < periodStart) periodStart = line.txDate;
    if (line.txDate > periodEnd) periodEnd = line.txDate;
  }

  // Dedupe against the lines already stored on this account (any statement).
  const fingerprints = input.lines.map((l) => l.fingerprint!);
  const existing = await prisma.bankStatementLine.findMany({
    where: {
      bankAccountId: input.bankAccountId,
      txDate: { gte: new Date(periodStart.getTime() - 86_400_000), lte: new Date(periodEnd.getTime() + 86_400_000) }
    },
    select: { id: true, statementId: true, rawJson: true }
  });
  const existingByFingerprint = new Map<string, { id: string; statementId: string }>();
  for (const row of existing) {
    const raw = (row.rawJson ?? {}) as Record<string, unknown>;
    if (typeof raw.fingerprint === "string") existingByFingerprint.set(raw.fingerprint, { id: row.id, statementId: row.statementId });
  }
  const fresh = input.lines.filter((l) => !existingByFingerprint.has(l.fingerprint!));
  const duplicateLines = input.lines.length - fresh.length;
  const warnings: string[] = [];
  if (fresh.length === 0) {
    const previousStatementId = existingByFingerprint.get(fingerprints[0]!)?.statementId ?? null;
    throw new ConflictError("Todos los movimientos del fichero ya estaban importados en esta cuenta.", {
      code: "STATEMENT_ALREADY_IMPORTED",
      statementId: previousStatementId,
      duplicateLines
    });
  }
  if (duplicateLines > 0) warnings.push(`${duplicateLines} movimiento(s) ya importados se han omitido.`);

  // Opening: declared, else previous closing, else the account opening balance.
  const previous = await prisma.bankStatement.findFirst({
    where: { bankAccountId: input.bankAccountId, periodEnd: { lte: periodStart } },
    orderBy: { periodEnd: "desc" }
  });
  const opening = input.openingBalance ?? (previous ? dec(previous.closingBalance) : dec(account.openingBalance));
  const movement = sum(fresh.map((l) => l.amount));
  const computedClosing = round2(opening.plus(movement));
  const closing = input.closingBalance ?? computedClosing;
  if (input.closingBalance && duplicateLines === 0 && !closing.equals(computedClosing)) {
    warnings.push(`El saldo final declarado (${money(closing)}) no coincide con apertura + movimientos (${money(computedClosing)}).`);
  }

  const statementId = createId("bstmt");
  const lineIds: Array<string | null> = [];
  await prisma.$transaction(async (tx) => {
    await tx.bankStatement.create({
      data: {
        id: statementId,
        bankAccountId: input.bankAccountId,
        propertyId: account.propertyId,
        periodStart,
        periodEnd,
        openingBalance: round2(opening),
        closingBalance: round2(closing),
        source: input.source,
        status: "pending"
      }
    });
    const rows = fresh.map((line) => ({
      id: createId("bln"),
      statementId,
      bankAccountId: input.bankAccountId,
      txDate: line.txDate,
      valueDate: line.valueDate ?? null,
      amount: round2(line.amount),
      currencyCode: account.currencyCode,
      description: line.description,
      reference: line.reference,
      counterparty: line.counterparty,
      rawJson: { fingerprint: line.fingerprint, ...(line.raw ?? {}) } as Prisma.InputJsonValue
    }));
    await tx.bankStatementLine.createMany({ data: rows });
    const idByFingerprint = new Map(rows.map((r) => [(r.rawJson as { fingerprint: string }).fingerprint, r.id]));
    for (const line of input.lines) lineIds.push(idByFingerprint.get(line.fingerprint!) ?? null);
  });

  return { statementId, newLines: fresh.length, duplicateLines, lineIds, warnings };
}

export async function importStatementFromCsv(input: { bankAccountId: string; csv: string; source?: string }): Promise<StatementDetail & { import: PersistStatementResult }> {
  if (!input.csv || !input.csv.trim()) throw new BadRequestError("`csv` es obligatorio.");
  const lines = parseStatementCsv(input.csv);
  if (lines.length === 0) throw new BadRequestError("El CSV no contiene filas de datos.");
  const result = await persistStatement({ bankAccountId: input.bankAccountId, source: input.source ?? "csv", lines });
  const detail = await getStatement(result.statementId);
  return { ...detail, import: result };
}

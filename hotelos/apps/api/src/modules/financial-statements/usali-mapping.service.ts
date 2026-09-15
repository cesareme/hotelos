// USALI mapping per organisation (Finanzas · lote usali-cuentas).
//
// Resolution order of docs/runbooks/finanzas-contabilidad.md §4 for a P&L
// account code:
//   1. active UsaliMapping of the organisation whose accountPrefix is a prefix
//      of the code — highest priority, then the longest prefix;
//   2. Account.usaliDepartment / usaliLine of the account row;
//   3. templateUsaliFor(code) (the «PGC Pymes hotelero» default by prefix);
//   4. nothing → «Sin asignar» (the USALI statement shows it, never hides it).
// A stored combination that USALI_DEPARTMENT_LINES does not admit is treated
// as absent (issue reported) so a bad row can never silently move money.
//
// The editor (PATCH / DELETE) validates against the same vocabulary and
// writes audit events; reads go through FinancialStatementsSource so the
// coverage report is testable in memory.

import { prisma } from "@hotelos/database";
import type { UserContext } from "../../lib/demo-store.js";
import { HttpError, NotFoundError } from "../../lib/http-error.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { requirePermissions } from "../auth/auth.service.js";
import {
  USALI_DEPARTMENTS,
  USALI_DEPARTMENT_LINES,
  USALI_LINES,
  accountDigits,
  templateUsaliFor,
  type UsaliDepartment,
  type UsaliLine
} from "../accounting/chart-of-accounts.service.js";
import type {
  UsaliAccountResolution,
  UsaliCoverage,
  UsaliMappingRow,
  UsaliMappingSource,
  UsaliMappingsResponse,
  UsaliMappingUpsert
} from "../../../../../packages/shared/src/financial-statements-types.js";
import { money } from "./money.js";
import { prismaFinancialStatementsSource, type AccountBalanceRow, type ChartAccountLite, type FinancialStatementsSource, type UsaliMappingSourceRow } from "./source.js";

export type ResolvedUsali = {
  usaliDepartment: UsaliDepartment | null;
  usaliLine: UsaliLine | null;
  source: UsaliMappingSource;
  mappingId: string | null;
  issue: string | null;
};

export function isAdmittedUsali(department: string | null | undefined, line: string | null | undefined): department is UsaliDepartment {
  if (!department || !line) return false;
  const lines = USALI_DEPARTMENT_LINES[department as UsaliDepartment];
  return Array.isArray(lines) && lines.includes(line as UsaliLine);
}

/** A mapping prefix matches a code when it is the code itself or a prefix of it ("62" → 620…629.9; "705" → 705.1 and legacy 7050). */
export function prefixMatches(prefix: string, code: string): boolean {
  return code === prefix || code.startsWith(prefix);
}

export function resolveUsaliForCode(
  code: string,
  account: { usaliDepartment: string | null; usaliLine: string | null } | null,
  mappings: readonly UsaliMappingSourceRow[]
): ResolvedUsali {
  const issues: string[] = [];
  const candidates = mappings.filter((m) => m.active && prefixMatches(m.accountPrefix, code));
  candidates.sort((a, b) => (b.priority - a.priority) || (b.accountPrefix.length - a.accountPrefix.length) || a.accountPrefix.localeCompare(b.accountPrefix));
  for (const candidate of candidates) {
    if (isAdmittedUsali(candidate.usaliDepartment, candidate.usaliLine)) {
      return {
        usaliDepartment: candidate.usaliDepartment,
        usaliLine: candidate.usaliLine as UsaliLine,
        source: "mapping",
        mappingId: candidate.id,
        issue: issues.length ? issues.join("; ") : null
      };
    }
    issues.push(`mapeo ${candidate.accountPrefix} con combinación no admitida (${candidate.usaliDepartment}.${candidate.usaliLine})`);
  }
  if (account && (account.usaliDepartment || account.usaliLine)) {
    if (isAdmittedUsali(account.usaliDepartment, account.usaliLine)) {
      return {
        usaliDepartment: account.usaliDepartment,
        usaliLine: account.usaliLine as UsaliLine,
        source: "account",
        mappingId: null,
        issue: issues.length ? issues.join("; ") : null
      };
    }
    issues.push(`la cuenta guarda una combinación no admitida (${account.usaliDepartment ?? "∅"}.${account.usaliLine ?? "∅"})`);
  }
  const template = templateUsaliFor(code);
  if (template) {
    return { ...template, source: "template", mappingId: null, issue: issues.length ? issues.join("; ") : null };
  }
  issues.push("sin mapeo USALI: la cuenta se presenta en «Sin asignar»");
  return { usaliDepartment: null, usaliLine: null, source: "none", mappingId: null, issue: issues.join("; ") };
}

// ---------------------------------------------------------------------------
// Coverage (pure)
// ---------------------------------------------------------------------------

export function buildCoverage(input: {
  organizationId: string;
  accounts: ChartAccountLite[];
  mappings: UsaliMappingSourceRow[];
  period?: { from: string; to: string } | null;
  movements?: AccountBalanceRow[];
}): UsaliCoverage {
  const bySource: Record<UsaliMappingSource, number> = { mapping: 0, account: 0, template: 0, none: 0 };
  const resolutions: UsaliAccountResolution[] = [];
  const byCode = new Map<string, UsaliAccountResolution>();
  for (const account of input.accounts) {
    if (account.kind !== "income" && account.kind !== "expense") continue;
    const resolved = resolveUsaliForCode(account.code, account, input.mappings);
    bySource[resolved.source] += 1;
    const row: UsaliAccountResolution = {
      code: account.code,
      name: account.name,
      kind: account.kind,
      usaliDepartment: resolved.usaliDepartment,
      usaliLine: resolved.usaliLine,
      source: resolved.source,
      mappingId: resolved.mappingId,
      issue: resolved.issue
    };
    resolutions.push(row);
    byCode.set(account.code, row);
  }
  const unmappedWithMovements: UsaliCoverage["unmappedWithMovements"] = [];
  for (const movement of input.movements ?? []) {
    if (movement.kind !== "income" && movement.kind !== "expense") continue;
    if (movement.debit.isZero() && movement.credit.isZero()) continue;
    const known = byCode.get(movement.code);
    const resolved = known ?? {
      code: movement.code,
      name: movement.name,
      kind: movement.kind,
      ...resolveUsaliForCode(movement.code, movement, input.mappings)
    };
    if (resolved.source === "none") {
      unmappedWithMovements.push({ ...resolved, debit: money(movement.debit), credit: money(movement.credit) });
    }
  }
  return {
    organizationId: input.organizationId,
    period: input.period ?? null,
    totalAccounts: resolutions.length,
    mapped: resolutions.length - bySource.none,
    unmapped: bySource.none,
    bySource,
    unmappedAccounts: resolutions.filter((r) => r.source === "none"),
    unmappedWithMovements,
    resolutions
  };
}

export function usaliVocabulary(): Pick<UsaliMappingsResponse, "departments" | "lines"> {
  return {
    departments: (Object.keys(USALI_DEPARTMENTS) as UsaliDepartment[]).map((key) => ({
      key,
      label: USALI_DEPARTMENTS[key],
      lines: [...USALI_DEPARTMENT_LINES[key]]
    })),
    lines: (Object.keys(USALI_LINES) as UsaliLine[]).map((key) => ({ key, label: USALI_LINES[key] }))
  };
}

function toWireRow(row: UsaliMappingSourceRow): UsaliMappingRow {
  return {
    id: row.id,
    organizationId: row.organizationId,
    accountPrefix: row.accountPrefix,
    usaliDepartment: row.usaliDepartment as UsaliDepartment,
    usaliLine: row.usaliLine as UsaliLine,
    priority: row.priority,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

// ---------------------------------------------------------------------------
// Service (Prisma)
// ---------------------------------------------------------------------------

export async function getUsaliMappings(input: {
  context: UserContext;
  period?: { from: string; to: string } | null;
  source?: FinancialStatementsSource;
}): Promise<UsaliMappingsResponse> {
  requirePermissions(input.context, ["accounting.read"]);
  const source = input.source ?? prismaFinancialStatementsSource;
  const organizationId = input.context.organizationId;
  const [accounts, mappings] = await Promise.all([source.plAccounts(organizationId), source.usaliMappings(organizationId)]);
  const movements = input.period
    ? await source.accountBalances({ organizationId, mode: "movements", from: input.period.from, to: input.period.to, groups: [6, 7] })
    : undefined;
  return {
    organizationId,
    mappings: mappings.map(toWireRow),
    coverage: buildCoverage({ organizationId, accounts, mappings, period: input.period ?? null, movements }),
    ...usaliVocabulary()
  };
}

export async function getUsaliCoverage(input: {
  context: UserContext;
  period?: { from: string; to: string } | null;
  source?: FinancialStatementsSource;
}): Promise<UsaliCoverage> {
  return (await getUsaliMappings(input)).coverage;
}

/** Validates the admitted department × line combination of every entry (the zod schema only checks the vocabularies). */
export function assertAdmittedCombinations(entries: UsaliMappingUpsert[]): void {
  const bad = entries.filter((e) => !isAdmittedUsali(e.usaliDepartment, e.usaliLine));
  if (bad.length === 0) return;
  throw new HttpError(400, `Combinación departamento/línea USALI no admitida en ${bad.map((e) => e.accountPrefix).join(", ")}.`, true, {
    code: "USALI_LINE_NOT_ADMITTED",
    issues: bad.map((e) => ({
      path: e.accountPrefix,
      message: `la línea ${e.usaliLine} no se admite en el departamento ${e.usaliDepartment} (admitidas: ${USALI_DEPARTMENT_LINES[e.usaliDepartment].join(", ")})`
    }))
  });
}

export async function patchUsaliMappings(input: {
  context: UserContext;
  mappings: UsaliMappingUpsert[];
  correlationId: string;
}): Promise<UsaliMappingsResponse> {
  requirePermissions(input.context, ["accounting.configure"]);
  assertAdmittedCombinations(input.mappings);
  const organizationId = input.context.organizationId;
  // Last write wins inside the same request for a repeated prefix.
  const byPrefix = new Map<string, UsaliMappingUpsert>();
  for (const entry of input.mappings) byPrefix.set(entry.accountPrefix, entry);
  const before = await prisma.usaliMapping.findMany({ where: { organizationId, accountPrefix: { in: Array.from(byPrefix.keys()) } } });
  await prisma.$transaction(async (tx) => {
    for (const entry of byPrefix.values()) {
      await tx.usaliMapping.upsert({
        where: { organizationId_accountPrefix: { organizationId, accountPrefix: entry.accountPrefix } },
        create: {
          organizationId,
          accountPrefix: entry.accountPrefix,
          usaliDepartment: entry.usaliDepartment,
          usaliLine: entry.usaliLine,
          priority: entry.priority ?? 0,
          active: entry.active ?? true
        },
        update: {
          usaliDepartment: entry.usaliDepartment,
          usaliLine: entry.usaliLine,
          ...(entry.priority !== undefined ? { priority: entry.priority } : {}),
          ...(entry.active !== undefined ? { active: entry.active } : {})
        }
      });
    }
  });
  recordAuditEvent({
    organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "USALI_MAPPING_UPDATED",
    entityType: "usali_mapping",
    entityId: organizationId,
    beforeJson: { mappings: before.map(toWireRow) },
    afterJson: { mappings: Array.from(byPrefix.values()) },
    correlationId: input.correlationId
  });
  return getUsaliMappings({ context: input.context });
}

export async function deleteUsaliMapping(input: { context: UserContext; mappingId: string; correlationId: string }): Promise<UsaliMappingsResponse> {
  requirePermissions(input.context, ["accounting.configure"]);
  const organizationId = input.context.organizationId;
  const row = await prisma.usaliMapping.findFirst({ where: { id: input.mappingId, organizationId } });
  if (!row) throw new NotFoundError("Mapeo USALI no encontrado.");
  await prisma.usaliMapping.delete({ where: { id: row.id } });
  recordAuditEvent({
    organizationId,
    propertyId: input.context.propertyId,
    actorUserId: input.context.userId,
    actorType: "user",
    action: "USALI_MAPPING_DELETED",
    entityType: "usali_mapping",
    entityId: row.id,
    beforeJson: toWireRow(row),
    correlationId: input.correlationId
  });
  return getUsaliMappings({ context: input.context });
}

import { prisma } from "@hotelos/database";
import type { EventEnvelope } from "@hotelos/shared";
import { assertBalanced, evaluate, type PostingResult } from "./posting-rules.js";
import { isPostingAllowed } from "./fiscal-period.service.js";

// Cache organization-scoped account code → id lookups so we don't hit the DB
// on every posting. Account catalog is small and rarely changes.
const accountIdCache = new Map<string, string>();

async function resolveAccountId(organizationId: string, code: string): Promise<string | null> {
  const key = `${organizationId}::${code}`;
  const cached = accountIdCache.get(key);
  if (cached) return cached;
  const row = await prisma.account.findUnique({
    where: { organizationId_code: { organizationId, code } },
    select: { id: true }
  });
  if (!row) return null;
  accountIdCache.set(key, row.id);
  return row.id;
}

let projectionChain: Promise<void> = Promise.resolve();

export function queueAccountingProjection(event: EventEnvelope): void {
  projectionChain = projectionChain.then(async () => {
    try {
      const posting = await evaluate(event);
      if (!posting) return;
      await persistJournalEntry(event, posting);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[accounting] failed to project ${event.eventId} (${event.eventType}): ${message}`);
    }
  });
}

async function persistJournalEntry(event: EventEnvelope, posting: PostingResult): Promise<void> {
  assertBalanced(posting.lines);

  // Idempotency: skip if a journal entry for this source already exists.
  const existing = await prisma.journalEntry.findFirst({
    where: {
      organizationId: event.organizationId,
      sourceType: posting.sourceType,
      sourceId: posting.sourceId
    },
    select: { id: true }
  });
  if (existing) return;

  // Block postings into a closed fiscal period.
  const postingDate = new Date(event.createdAt);
  const check = await isPostingAllowed(event.organizationId, event.propertyId || undefined, postingDate);
  if (!check.allowed) {
    throw new Error(`Posting blocked: fiscal period ${check.closedPeriodCode} is closed.`);
  }

  const accountIds = await Promise.all(
    posting.lines.map((line) => resolveAccountId(event.organizationId, line.accountCode))
  );
  if (accountIds.some((id) => !id)) {
    const missing = posting.lines
      .filter((_, i) => !accountIds[i])
      .map((l) => l.accountCode)
      .join(", ");
    throw new Error(`Missing accounts in chart for organization ${event.organizationId}: ${missing}`);
  }

  await prisma.$transaction(async (tx) => {
    const entry = await tx.journalEntry.create({
      data: {
        organizationId: event.organizationId,
        propertyId: event.propertyId,
        sourceType: posting.sourceType,
        sourceId: posting.sourceId,
        status: "posted",
        postedAt: new Date(),
        createdBy: event.actorUserId ?? null
      }
    });
    await tx.journalLine.createMany({
      data: posting.lines.map((line, i) => ({
        journalEntryId: entry.id,
        accountId: accountIds[i]!,
        debit: line.debit,
        credit: line.credit,
        currency: "EUR",
        description: line.description ?? posting.description
      }))
    });
  });
}

export async function flushAccountingProjection(): Promise<void> {
  await projectionChain;
}

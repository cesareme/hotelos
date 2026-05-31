export type RetentionMode = "temporary_only" | "scheduled_delete" | "manual_review" | "append_only";

export type RetentionPolicy = {
  entityType: string;
  mode: RetentionMode;
  retentionMonths?: number;
  legalHoldAllowed: boolean;
  auditAction?: string;
};

export const DEFAULT_RETENTION_POLICIES: RetentionPolicy[] = [
  {
    entityType: "id_document_image",
    mode: "temporary_only",
    legalHoldAllowed: false,
    auditAction: "ID_IMAGE_DISCARDED"
  },
  {
    entityType: "guest_register_record",
    mode: "scheduled_delete",
    retentionMonths: 36,
    legalHoldAllowed: true
  },
  {
    entityType: "ses_hospedajes_submission",
    mode: "scheduled_delete",
    retentionMonths: 36,
    legalHoldAllowed: true
  },
  {
    entityType: "audit_event",
    mode: "append_only",
    legalHoldAllowed: false
  },
  {
    entityType: "event_stream",
    mode: "append_only",
    legalHoldAllowed: false
  },
  {
    entityType: "invoice",
    mode: "manual_review",
    legalHoldAllowed: true
  },
  {
    entityType: "journal_entry",
    mode: "manual_review",
    legalHoldAllowed: true
  },
  {
    entityType: "supplier_bill",
    mode: "manual_review",
    legalHoldAllowed: true
  },
  {
    entityType: "maintenance_photo",
    mode: "manual_review",
    legalHoldAllowed: true
  },
  {
    entityType: "voice_command_draft",
    mode: "scheduled_delete",
    retentionMonths: 1,
    legalHoldAllowed: false
  }
];

export function getRetentionPolicy(entityType: string): RetentionPolicy {
  return (
    DEFAULT_RETENTION_POLICIES.find((policy) => policy.entityType === entityType) ?? {
      entityType,
      mode: "manual_review",
      legalHoldAllowed: true
    }
  );
}

export function calculateRetentionUntilForPolicy(input: { entityType: string; createdAt: string | Date }): string | undefined {
  const policy = getRetentionPolicy(input.entityType);
  if (!policy.retentionMonths) {
    return undefined;
  }

  const createdAt = typeof input.createdAt === "string" ? new Date(input.createdAt) : new Date(input.createdAt);
  createdAt.setMonth(createdAt.getMonth() + policy.retentionMonths);
  return createdAt.toISOString();
}

export function shouldDeleteRetentionCandidate(input: {
  entityType: string;
  asOf: string | Date;
  retentionUntil?: string;
  legalHold?: boolean;
}): { deleteNow: boolean; reason: string; policy: RetentionPolicy } {
  const policy = getRetentionPolicy(input.entityType);

  if (input.legalHold && policy.legalHoldAllowed) {
    return { deleteNow: false, reason: "Record is under legal hold.", policy };
  }

  if (policy.mode === "temporary_only") {
    return { deleteNow: true, reason: "Temporary-only data must be deleted immediately.", policy };
  }

  if (policy.mode === "append_only") {
    return { deleteNow: false, reason: "Append-only records are not deleted by retention jobs.", policy };
  }

  if (policy.mode === "manual_review") {
    return { deleteNow: false, reason: "Retention requires human review or configured statutory policy.", policy };
  }

  if (!input.retentionUntil) {
    return { deleteNow: false, reason: "Retention date is missing.", policy };
  }

  const asOf = typeof input.asOf === "string" ? new Date(input.asOf) : input.asOf;
  const retentionUntil = new Date(input.retentionUntil);
  return {
    deleteNow: retentionUntil.getTime() <= asOf.getTime(),
    reason: retentionUntil.getTime() <= asOf.getTime() ? "Retention date has elapsed." : "Retention date has not elapsed.",
    policy
  };
}

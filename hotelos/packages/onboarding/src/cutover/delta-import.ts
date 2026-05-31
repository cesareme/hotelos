import type { OnboardingDataQualityIssue } from "../data-quality/checks.js";

export type CutoverDeltaEntity = "reservations" | "guests" | "folios" | "balances" | "housekeeping_status" | "maintenance_status" | "channel_reservations";

export type CutoverDeltaImportPlan = {
  projectId: string;
  sourceWatermark: string;
  targetWindowStart: string;
  targetWindowEnd: string;
  dryRunOnly: true;
  applyRequiresConfirmation: true;
  canApply: false;
  entities: Array<{
    entity: CutoverDeltaEntity;
    recordsToCreate: number;
    recordsToUpdate: number;
    conflicts: number;
    policy: "source_wins_after_freeze" | "hotelos_wins_after_go_live" | "manual_review";
  }>;
  blockers: string[];
  warnings: string[];
};

export function generateCutoverDeltaImportDryRun(input: {
  projectId: string;
  sourceWatermark: string;
  targetWindowStart: string;
  targetWindowEnd: string;
  counts?: Partial<Record<CutoverDeltaEntity, { create: number; update: number; conflicts?: number }>>;
  blockingIssues: OnboardingDataQualityIssue[];
}): CutoverDeltaImportPlan {
  const entities: CutoverDeltaImportPlan["entities"] = ([
    "reservations",
    "guests",
    "folios",
    "balances",
    "housekeeping_status",
    "maintenance_status",
    "channel_reservations"
  ] as CutoverDeltaEntity[]).map((entity) => {
    const counts = input.counts?.[entity] ?? { create: 0, update: 0, conflicts: 0 };
    return {
      entity,
      recordsToCreate: counts.create,
      recordsToUpdate: counts.update,
      conflicts: counts.conflicts ?? 0,
      policy: entity === "balances" || entity === "folios" ? "manual_review" : entity === "channel_reservations" ? "source_wins_after_freeze" : "hotelos_wins_after_go_live"
    };
  });

  return {
    projectId: input.projectId,
    sourceWatermark: input.sourceWatermark,
    targetWindowStart: input.targetWindowStart,
    targetWindowEnd: input.targetWindowEnd,
    dryRunOnly: true,
    applyRequiresConfirmation: true,
    canApply: false,
    entities,
    blockers: input.blockingIssues.filter((issue) => issue.severity === "blocking").map((issue) => issue.code),
    warnings: ["Delta import is a dry-run preview until go-live approval and manager confirmation are present."]
  };
}

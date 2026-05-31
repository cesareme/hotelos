export type CutoverStageStatus = "completed" | "in_progress" | "pending" | "blocked";

export type CutoverStage = {
  stage: "T-30 days" | "T-14 days" | "T-7 days" | "T-2 days" | "T-1 day" | "Go-live day" | "T+1 day";
  title: string;
  actions: string[];
  ownerRole: "implementation" | "hotel_manager" | "revenue_manager" | "finance" | "support";
  status: CutoverStageStatus;
};

export type CutoverAssistantPlan = {
  projectId: string;
  freezeWindowRequired: true;
  deltaImportRequired: true;
  rollbackPlanRequired: true;
  goLiveBlocked: boolean;
  stages: CutoverStage[];
  blockers: string[];
  nextBestAction: string;
};

export function generateCutoverAssistantPlan(input: {
  projectId: string;
  blockingIssues: Array<{ code: string; severity: string; detail?: string }>;
  staffReviewCompleted?: boolean;
  testImportCompleted?: boolean;
}): CutoverAssistantPlan {
  const goLiveBlocked = input.blockingIssues.some((issue) => issue.severity === "blocking");
  const stages: CutoverStage[] = [
    {
      stage: "T-30 days",
      title: "Discovery and data collection",
      actions: ["Confirm source PMS", "Collect exports", "Assign migration owner", "Create rollback plan"],
      ownerRole: "implementation",
      status: "completed"
    },
    {
      stage: "T-14 days",
      title: "Test import",
      actions: ["Run dry-run", "Validate room inventory", "Validate future reservations", "Validate revenue history totals"],
      ownerRole: "implementation",
      status: input.testImportCompleted ? "completed" : "in_progress"
    },
    {
      stage: "T-7 days",
      title: "Staff review and training",
      actions: ["Review mappings", "Train front desk", "Train housekeeping", "Review guest register workflow"],
      ownerRole: "hotel_manager",
      status: input.staffReviewCompleted ? "completed" : "in_progress"
    },
    {
      stage: "T-2 days",
      title: "Final source PMS export rehearsal",
      actions: ["Run export rehearsal", "Check delta import", "Confirm channel mapping", "Confirm payment provider"],
      ownerRole: "support",
      status: goLiveBlocked ? "blocked" : "pending"
    },
    {
      stage: "T-1 day",
      title: "Freeze configuration",
      actions: ["Freeze source PMS configuration", "Pause non-essential changes", "Confirm invoice sequences", "Confirm authority reporting settings"],
      ownerRole: "hotel_manager",
      status: goLiveBlocked ? "blocked" : "pending"
    },
    {
      stage: "Go-live day",
      title: "Delta import and switch",
      actions: ["Import delta", "Validate arrivals", "Validate balances", "Validate channels", "Run first night audit"],
      ownerRole: "implementation",
      status: goLiveBlocked ? "blocked" : "pending"
    },
    {
      stage: "T+1 day",
      title: "Post go-live checks",
      actions: ["Review failed syncs", "Review payments", "Review guest register queue", "Confirm owner report"],
      ownerRole: "support",
      status: "pending"
    }
  ];

  return {
    projectId: input.projectId,
    freezeWindowRequired: true,
    deltaImportRequired: true,
    rollbackPlanRequired: true,
    goLiveBlocked,
    stages,
    blockers: input.blockingIssues.filter((issue) => issue.severity === "blocking").map((issue) => issue.detail ?? issue.code),
    nextBestAction: goLiveBlocked ? "Resolve blocking data quality issues before the final export rehearsal." : "Schedule the final export rehearsal and confirm the freeze window."
  };
}

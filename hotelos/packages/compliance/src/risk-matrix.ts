import type { PermissionKey, RiskLevel } from "@hotelos/shared";

export type RiskMatrixEntry = {
  key: string;
  aiMayAutoExecute: boolean;
  requiresConfirmation: boolean;
  requiredApproval?: "manager" | "supervisor" | "accountant" | "owner" | "compliance";
  requiredPermissions: PermissionKey[];
  riskLevel: RiskLevel;
};

export const RISK_MATRIX: RiskMatrixEntry[] = [
  {
    key: "create_maintenance_task",
    aiMayAutoExecute: true,
    requiresConfirmation: false,
    requiredPermissions: ["maintenance.workorder.manage", "ai.tool.execute"],
    riskLevel: "low"
  },
  {
    key: "assign_room",
    aiMayAutoExecute: false,
    requiresConfirmation: true,
    requiredPermissions: ["pms.reservation.modify", "ai.tool.execute"],
    riskLevel: "medium"
  },
  {
    key: "check_in_guest",
    aiMayAutoExecute: false,
    requiresConfirmation: true,
    requiredPermissions: ["pms.checkin.execute", "ai.tool.execute"],
    riskLevel: "high"
  },
  {
    key: "refund_payment",
    aiMayAutoExecute: false,
    requiresConfirmation: false,
    requiredApproval: "manager",
    requiredPermissions: ["payment.refund", "ai.high_risk.confirm"],
    riskLevel: "critical"
  },
  {
    key: "issue_invoice",
    aiMayAutoExecute: false,
    requiresConfirmation: true,
    requiredApproval: "accountant",
    requiredPermissions: ["invoice.issue", "ai.high_risk.confirm"],
    riskLevel: "high"
  },
  {
    key: "post_accounting_entry",
    aiMayAutoExecute: false,
    requiresConfirmation: false,
    requiredApproval: "accountant",
    requiredPermissions: ["accounting.journal.post", "ai.high_risk.confirm"],
    riskLevel: "critical"
  },
  {
    key: "approve_capex",
    aiMayAutoExecute: false,
    requiresConfirmation: false,
    requiredApproval: "owner",
    requiredPermissions: ["asset.capex.approve", "ai.high_risk.confirm"],
    riskLevel: "critical"
  },
  {
    key: "quote_availability",
    aiMayAutoExecute: true,
    requiresConfirmation: false,
    requiredPermissions: ["ai.tool.execute"],
    riskLevel: "medium"
  },
  {
    key: "cancel_booking",
    aiMayAutoExecute: false,
    requiresConfirmation: true,
    requiredApproval: "manager",
    requiredPermissions: ["pms.reservation.modify", "ai.high_risk.confirm"],
    riskLevel: "high"
  }
];

export function getRiskEntry(key: string): RiskMatrixEntry {
  const entry = RISK_MATRIX.find((item) => item.key === key);
  if (!entry) {
    throw new Error(`No risk matrix entry registered for ${key}`);
  }

  return entry;
}

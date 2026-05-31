export const OWNER_MODE_ROUTES = [
  "OwnerDashboard",
  "OwnerBriefing",
  "RoomProfitability",
  "CapexProjects",
  "ComplianceInbox"
];

export function canOpenOwnerRoute(input: { route: string; userPermissions: string[] }): boolean {
  if (!OWNER_MODE_ROUTES.includes(input.route)) {
    return false;
  }

  return input.userPermissions.includes("owner.dashboard.read") || input.userPermissions.includes("owner.ai_ask");
}

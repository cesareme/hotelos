// Persona guides — one plain-Spanish guide per job, written over the nine
// categories of the Tanda 5 navigation tree. Rendered by the help center
// («?» button) and filtered by role token; see ./types.ts.
import type { RoleToken } from "../../navigation/role-tokens";
import { COMPLIANCE_OFFICER_GUIDE } from "./compliance-officer";
import { FNB_GUIDE } from "./fnb";
import { HOUSEKEEPER_GUIDE } from "./housekeeper";
import { MAINTENANCE_GUIDE } from "./maintenance";
import { MANAGER_GUIDE } from "./manager";
import { OWNER_GUIDE } from "./owner";
import { RECEPTIONIST_GUIDE } from "./receptionist";
import { REVENUE_GUIDE } from "./revenue";
import { SALES_GUIDE } from "./sales";
import type { PersonaGuide } from "./types";

export type { PersonaGuide } from "./types";
export {
  COMPLIANCE_OFFICER_GUIDE,
  FNB_GUIDE,
  HOUSEKEEPER_GUIDE,
  MAINTENANCE_GUIDE,
  MANAGER_GUIDE,
  OWNER_GUIDE,
  RECEPTIONIST_GUIDE,
  REVENUE_GUIDE,
  SALES_GUIDE
};

/** Every guide, broadest role first (same order as the role priority of the tree). */
export const PERSONA_GUIDES: readonly PersonaGuide[] = [
  MANAGER_GUIDE,
  OWNER_GUIDE,
  COMPLIANCE_OFFICER_GUIDE,
  REVENUE_GUIDE,
  SALES_GUIDE,
  RECEPTIONIST_GUIDE,
  FNB_GUIDE,
  MAINTENANCE_GUIDE,
  HOUSEKEEPER_GUIDE
];

/** Guides for a set of role tokens; unknown/empty tokens → every guide. */
export function personaGuidesFor(roleTokens: readonly RoleToken[]): PersonaGuide[] {
  if (roleTokens.length === 0) return [...PERSONA_GUIDES];
  const matching = PERSONA_GUIDES.filter(
    (guide) => guide.roleTokens.length === 0 || guide.roleTokens.some((token) => roleTokens.includes(token))
  );
  return matching.length > 0 ? matching : [...PERSONA_GUIDES];
}

/** Markdown body of a guide, for the searchable article list of the help center. */
export function personaGuideMarkdown(guide: PersonaGuide): string {
  return [
    `# ${guide.title}`,
    "",
    guide.summary,
    "",
    "## Tu día, paso a paso",
    "",
    ...guide.dailyFlow.map((step, index) => `${index + 1}. ${step}`),
    "",
    "## Consejos",
    "",
    ...guide.tips.map((tip) => `- ${tip}`)
  ].join("\n");
}

import type { RoleToken } from "../../navigation/role-tokens";

/**
 * A short, plain-Spanish guide for one job in the hotel. Surfaced in the help
 * center («?») and filtered by the role tokens of the Tanda 5 navigation tree
 * (`pilots/tanda5-nav-tree.csv`). Screen keys must be `keep` items of that
 * tree so «Ir a…» links keep working after the L1b router rewrite.
 */
export interface PersonaGuide {
  readonly id: string;
  /** Tokens this guide is written for; empty = everyone. */
  readonly roleTokens: readonly RoleToken[];
  readonly title: string;
  readonly summary: string;
  /** The day, step by step, using the menu labels of the 9 categories. */
  readonly dailyFlow: readonly string[];
  readonly tips: readonly string[];
  /** Screen keys (keep items) the guide points to. */
  readonly relatedScreens: readonly string[];
}

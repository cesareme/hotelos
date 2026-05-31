/**
 * Cocoa Guidance components.
 *
 * Barrel export for all guidance-related components used to assist users
 * with onboarding, help, tours, hints and contextual information.
 */

export { CocoaTooltip, default as CocoaTooltipDefault } from "./CocoaTooltip";
export type {
  CocoaTooltipPlacement,
  CocoaTooltipProps,
} from "./CocoaTooltip";

export {
  CocoaInfoPopover,
  default as CocoaInfoPopoverDefault,
} from "./CocoaInfoPopover";
export type { CocoaInfoPopoverProps } from "./CocoaInfoPopover";

export {
  CocoaGuidedTour,
  default as CocoaGuidedTourDefault,
} from "./CocoaGuidedTour";
export type {
  CocoaGuidedTourProps,
  CocoaGuidedTourStep,
} from "./CocoaGuidedTour";

export {
  CocoaScreenInstructionsCard,
  default as CocoaScreenInstructionsCardDefault,
} from "./CocoaScreenInstructionsCard";
export type { CocoaScreenInstructionsCardProps } from "./CocoaScreenInstructionsCard";

export {
  CocoaEmptyStateGuide,
  default as CocoaEmptyStateGuideDefault,
} from "./CocoaEmptyStateGuide";
export type {
  CocoaEmptyStateGuideProps,
  CocoaEmptyStateGuideStep,
  CocoaEmptyStateGuideStepAction,
} from "./CocoaEmptyStateGuide";

export {
  CocoaShortcutHint,
  default as CocoaShortcutHintDefault,
} from "./CocoaShortcutHint";
export type {
  CocoaShortcutHintProps,
  CocoaShortcutHintSize,
  CocoaShortcutHintTone,
} from "./CocoaShortcutHint";

export {
  CocoaBreadcrumb,
  default as CocoaBreadcrumbDefault,
} from "./CocoaBreadcrumb";
export type {
  CocoaBreadcrumbItem,
  CocoaBreadcrumbProps,
} from "./CocoaBreadcrumb";

export {
  CocoaFirstRunWelcome,
  default as CocoaFirstRunWelcomeDefault,
} from "./CocoaFirstRunWelcome";
export type { CocoaFirstRunWelcomeProps } from "./CocoaFirstRunWelcome";

export {
  CocoaContextualHelp,
  default as CocoaContextualHelpDefault,
} from "./CocoaContextualHelp";
export type {
  CocoaContextualHelpProps,
  CocoaContextualHelpQuestion,
} from "./CocoaContextualHelp";

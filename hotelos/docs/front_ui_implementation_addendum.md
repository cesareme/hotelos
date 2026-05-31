# Front UI Implementation Addendum

HotelOS Aurora is the incremental visual and interaction layer for HotelOS. It keeps the existing architecture and gives mobile, admin-web and guest-web a shared operational design system.

## Implemented foundation

- Token source: `design-tokens/hotelos.tokens.json`.
- Code tokens: `packages/ui/src/tokens/index.ts`.
- UI exports include MetricCard, StatusChip, RoomOperationalCard, ConfirmationSheet, CommandDock, SkeletonCard, EmptyState, ErrorState, PermissionGate, ModuleGate, RiskBadge and ConfidenceMeter.
- Mobile navigation has a dedicated `HotelOSTabs` implementation for Hoy, Habitaciones, IA, Tareas and Mas.
- The Today dashboard starter uses action-first Aurora cards.
- The AI Command Center uses CommandDock, ConfidenceMeter, RiskBadge and ConfirmationCard.
- The flagship AI Check-in flow now has dedicated mobile screens for voice command, temporary document scan, OCR review, reservation match, room validation, confirmation, guest signature and success.
- The Rooms and planning screens now use operational room cards, quick filters, tablet rate-grid structure and a room detail bottom sheet with confirmation-first room blocking.
- The Back Office dashboard now has an Aurora readiness hero, go-live blockers, setup progress, module health, audit summary and a stronger Property Mapper with tree, grid, visual map and import preview.
- The Guest Portal now has a standalone `apps/guest-web` shell for online check-in, folio review, mobile checkout, upsells, service requests, itinerary and AI concierge disclosure.
- The demo preview uses Aurora colors, rounded operational cards and an AI command interpretation panel.

## Design rules

- Use tokens instead of hardcoded colors for new components.
- AI actions must show confidence, risk and next step.
- Critical actions must go through ConfirmationCard or ConfirmationSheet.
- ID scan screens must show that the document image is temporary, discarded after OCR and logged with ID_IMAGE_DISCARDED.
- Room and compliance states must be visible before opening detail screens.
- Empty and error states must explain the operational next action.
- Tap targets should be at least 44px in primary mobile interactions.
- Dense operational screens should avoid heavy blur.

## Figma handoff

Use `figma/figma_file_structure.md` for page organization and `figma/prompt_for_figma_or_sigma.md` for first-pass visual generation. Components should be named to match code exports from `packages/ui`.

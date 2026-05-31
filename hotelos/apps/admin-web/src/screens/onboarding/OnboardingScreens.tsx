import { ScreenScaffold, type ScreenScaffoldAction, type ScreenScaffoldProps } from "../ScreenScaffold";

// Sprint 53 — the upload→classify→extract→map→approve screens are now real,
// interactive components living in OnboardingInteractive.tsx. They are re-exported
// here so the existing App.tsx / route registrations keep working unchanged.
export {
  FileUploadAndClassificationScreen,
  AIExtractionReviewScreen,
  RoomMappingReviewScreen
} from "./OnboardingInteractive";

const sharedCards = [
  { title: "Human review", status: "warn" as const, body: "AI suggestions stay pending until a user approves, rejects or edits them. AI cannot apply migration directly." },
  { title: "Dry-run required", status: "ok" as const, body: "Every apply action requires a dry-run result with create, update, link and skip counts." },
  { title: "Sensitive data controls", status: "ok" as const, body: "Uploaded files are encrypted, raw payment card data is rejected and sensitive previews are permission-gated." }
];

function OnboardingScreen(props: {
  title: string;
  summary: string;
  cards?: ScreenScaffoldProps["cards"];
  nav?: ScreenScaffoldAction[];
}) {
  const baseCards = props.cards ?? sharedCards;
  const cards = props.nav?.length
    ? [
        ...baseCards,
        {
          title: "Continue the journey",
          status: "ok" as const,
          body: "Move to the next step of the AI onboarding & migration pipeline.",
          actions: props.nav
        }
      ]
    : baseCards;
  return <ScreenScaffold eyebrow="AI Onboarding & Migration" title={props.title} summary={props.summary} cards={cards} />;
}

export function AISetupCenterScreen() {
  return (
    <OnboardingScreen
      title="AI Setup Center"
      summary="Start or continue AI-powered implementation projects: source PMS connection, uploads, extraction, mapping, review, dry-run, migration batches and go-live readiness."
      cards={[
        {
          title: "HotelOS Demo Onboarding Project",
          metric: "62%",
          status: "warn",
          body: "Source: Generic PMS exports. Next action: review revenue history totals and approve low-risk room mappings.",
          actions: [
            { label: "Continue AI Setup", screen: "OnboardingProjects" },
            { label: "Upload files", screen: "FileUploadAndClassification" },
            { label: "Run data quality", screen: "OnboardingDataQualityReview" }
          ]
        },
        {
          title: "Property Blueprint",
          metric: "84% confidence",
          status: "ok",
          body: "AI found 1 building, 4 floors, 70 rooms, 4 room types and 3 non-room resources.",
          actions: [
            { label: "Review blueprint", screen: "PropertyBlueprintReview" },
            { label: "Room mapping review", screen: "RoomMappingReview" }
          ]
        },
        {
          title: "Go-live",
          metric: "blocked",
          status: "error",
          body: "SES.HOSPEDAJES settings and revenue report total validation are blocking production readiness.",
          actions: [
            { label: "Open readiness", screen: "OnboardingGoLiveReadiness" },
            { label: "Open cutover assistant", screen: "CutoverAssistant" }
          ]
        }
      ]}
    />
  );
}

export function OnboardingProjectListScreen() {
  return (
    <OnboardingScreen
      title="Onboarding Projects"
      summary="All AI setup and migration projects, source systems, go-live targets, owners, confidence and blocking issue counts."
      nav={[
        { label: "Open project detail", screen: "OnboardingProjectDetail" },
        { label: "Connect a source", screen: "SourceConnections" },
        { label: "Back to AI Setup Center", screen: "AISetupCenter" }
      ]}
    />
  );
}

export function OnboardingProjectDetailScreen() {
  return (
    <OnboardingScreen
      title="Onboarding Project Detail"
      summary="Project progress, source connections, uploaded files, extracted entities, mapping queue, migration batches and next setup action."
      nav={[
        { label: "Source connections", screen: "SourceConnections" },
        { label: "Upload files", screen: "FileUploadAndClassification" },
        { label: "Migration batches", screen: "MigrationBatches" },
        { label: "Go-live readiness", screen: "OnboardingGoLiveReadiness" }
      ]}
    />
  );
}

export function SourceConnectionScreen() {
  return (
    <OnboardingScreen
      title="Source Connections"
      summary="Connect or stub Mews, Oracle OPERA/OHIP, Cloudbeds, Apaleo, generic OpenAPI, CSV/XLSX/PDF and manual setup sources."
      nav={[
        { label: "Next: upload files", screen: "FileUploadAndClassification" },
        { label: "Back to project", screen: "OnboardingProjectDetail" }
      ]}
    />
  );
}

export function PropertyBlueprintReviewScreen() {
  return (
    <OnboardingScreen
      title="Property Blueprint Review"
      summary="Review buildings, floors, zones, rooms, spaces, inventory resources, housekeeping sections, maintenance areas and QR setup."
      cards={[
        { title: "Room Walk Setup", status: "ok", body: "Voice transcript parsing can suggest room ranges, floor, zone, room type, storage and out-of-order state, but creation is blocked until human confirmation." },
        { title: "Floor plan AI mapping", status: "warn", body: "Floor plans are assistive only. Room labels, public spaces and emergency-exit hints require manual review and cannot be used for legal or safety compliance without validation." },
        { title: "Blueprint preview", status: "ok", body: "Demo preview: 1 building, 4 floors, 70 rooms, 3 non-room resources and 2 operating zones." }
      ]}
      nav={[
        { label: "Next: room mapping review", screen: "RoomMappingReview" },
        { label: "Back to extraction review", screen: "AIExtractionReview" }
      ]}
    />
  );
}

export function RatePlanMappingReviewScreen() {
  return (
    <OnboardingScreen
      title="Rate Plan Mapping Review"
      summary="Map old PMS rate codes to HotelOS rate plans, restrictions, derivations and min/max rules."
      nav={[
        { label: "Next: channel mapping review", screen: "ChannelMappingReview" },
        { label: "Back to room mapping", screen: "RoomMappingReview" }
      ]}
    />
  );
}

export function ReservationImportReviewScreen() {
  return (
    <OnboardingScreen
      title="Reservation Import Review"
      summary="Review future reservations, assigned resources, guests, deposits, balances, dates and conflicts before importing live bookings."
      cards={[
        { title: "Human review queue", status: "warn", body: "Pending, low-confidence, high-risk, missing-data, financial and compliance mappings are pulled into a dedicated review queue." },
        { title: "Apply blocked", status: "error", body: "Migration apply remains blocked while the human review queue contains pending items." },
        { title: "Delta conflict policy", status: "warn", body: "Go-live delta reservations and balances use source-watermark dry-runs and manual conflict review." }
      ]}
      nav={[
        { label: "Next: guest import review", screen: "GuestImportReview" },
        { label: "Open human review queue", screen: "AiHumanReviewQueueScreen" }
      ]}
    />
  );
}

export function GuestImportReviewScreen() {
  return (
    <OnboardingScreen
      title="Guest Import Review"
      summary="Review guest profiles, duplicate detection, minimization options and sensitive-field visibility before migration."
      nav={[
        { label: "Next: data quality review", screen: "OnboardingDataQualityReview" },
        { label: "Back to reservation import", screen: "ReservationImportReview" }
      ]}
    />
  );
}

export function ChannelMappingReviewScreen() {
  return (
    <OnboardingScreen
      title="Channel Mapping Review"
      summary="Map source channel room/rate codes to HotelOS channels, room types, rate plans and ARI sync readiness."
      nav={[
        { label: "Next: revenue history import", screen: "RevenueHistoryImportReview" },
        { label: "Back to rate plan mapping", screen: "RatePlanMappingReview" }
      ]}
    />
  );
}

export function RevenueHistoryImportReviewScreen() {
  return (
    <OnboardingScreen
      title="Revenue History Import Review"
      summary="Classify and extract History & Forecast reports into revenue daily and forecast snapshots, with total validation before apply."
      nav={[
        { label: "Next: data quality review", screen: "OnboardingDataQualityReview" },
        { label: "Back to channel mapping", screen: "ChannelMappingReview" }
      ]}
    />
  );
}

export function ComplianceSetupReviewScreen() {
  return (
    <OnboardingScreen
      title="Compliance Setup Review"
      summary="Suggest Spain guest register, authority routing, SES.HOSPEDAJES, invoice/tax region and retention setup from legal profile data."
      nav={[
        { label: "Next: data quality review", screen: "OnboardingDataQualityReview" },
        { label: "SES.HOSPEDAJES settings", screen: "SesHospedajesSettings" }
      ]}
    />
  );
}

export function DataQualityReviewScreen() {
  return (
    <OnboardingScreen
      title="Data Quality Review"
      summary="Blocking, warning and info checks for rooms, rate plans, reservations, channels, guest duplicates, compliance and revenue reports."
      cards={[
        { title: "Blocking checks", status: "error", body: "Duplicate room numbers, rooms without room type, future reservations without guest, missing channel mappings, SES.HOSPEDAJES setup and History & Forecast totals mismatch block go-live." },
        { title: "Warnings", status: "warn", body: "Guest duplicates, missing payment provider, forecast gaps and rate plans without rate days require review but can be handled by operating policy." },
        { title: "Apply gate", status: "ok", body: "Migration apply requires completed dry-run, explicit human confirmation, zero blocking issues and zero pending mapping reviews." }
      ]}
      nav={[
        { label: "Next: dry-run result", screen: "DryRunResult" },
        { label: "Open human review queue", screen: "AiHumanReviewQueueScreen" }
      ]}
    />
  );
}

export function DryRunResultScreen() {
  return (
    <OnboardingScreen
      title="Dry-Run Result"
      summary="Preview objects to create, update, link or skip, plus warnings and conflicts. Applying stays disabled until this is reviewed."
      cards={[
        { title: "Import application order", status: "ok", body: "Property blueprint, compliance settings, rooms, spaces, inventory resources, rates, restrictions, channels, channel mappings, guests, companies, reservations, revenue history and users/roles." },
        { title: "Accounting rule", status: "warn", body: "Historical invoices and revenue reports import as read-only history or analytics snapshots unless explicitly approved as ledger migration." },
        { title: "Review blockers", status: "error", body: "Blocked batches cannot be applied. Review-required batches must be approved, rejected or edited before apply." }
      ]}
      nav={[
        { label: "Next: migration batches", screen: "MigrationBatches" },
        { label: "Back to data quality", screen: "OnboardingDataQualityReview" }
      ]}
    />
  );
}

export function MigrationBatchScreen() {
  return (
    <OnboardingScreen
      title="Migration Batches"
      summary="Controlled apply and safe rollback batches for property blueprint, rooms, rates, reservations, guests, channels and revenue history."
      nav={[
        { label: "Next: go-live readiness", screen: "OnboardingGoLiveReadiness" },
        { label: "Back to dry-run result", screen: "DryRunResult" }
      ]}
    />
  );
}

export function GoLiveReadinessScreen() {
  return (
    <OnboardingScreen
      title="Go-Live Readiness"
      summary="Readiness score, blocking issues, cutover checklist, freeze window, delta import, rollback plan and final approval status."
      cards={[
        { title: "Cutover plan", status: "warn", body: "T-30 discovery, T-14 test import, T-7 staff review, T-2 export rehearsal, T-1 freeze, go-live delta import and T+1 checks are tracked." },
        { title: "Go-live blocked", status: "error", body: "Blocking data quality issues stop final approval until SES.HOSPEDAJES setup and History & Forecast total validation are resolved." },
        { title: "Rollback policy", status: "ok", body: "Rollback is allowed only for safe batches that are not locked by live activity; audit events are always created." }
      ]}
      nav={[
        { label: "Open cutover assistant", screen: "CutoverAssistant" },
        { label: "Back to migration batches", screen: "MigrationBatches" },
        { label: "SES.HOSPEDAJES settings", screen: "SesHospedajesSettings" }
      ]}
    />
  );
}

export function CutoverAssistantScreen() {
  return (
    <OnboardingScreen
      title="Cutover Assistant"
      summary="T-30 through T+1 cutover stages: discovery, test import, training, freeze, delta import, arrival/balance/channel validation and first night audit."
      cards={[
        { title: "Delta import dry-run", status: "warn", body: "Final PMS changes are previewed from a source watermark. The delta plan is dry-run only until go-live approval and manager confirmation." },
        { title: "Conflict policies", status: "ok", body: "Reservations and channel deltas can use source-wins-after-freeze. Folios and balances require manual review." },
        { title: "First night audit", status: "ok", body: "The cutover plan keeps first night audit as an explicit go-live day validation step." }
      ]}
      nav={[
        { label: "Back to go-live readiness", screen: "OnboardingGoLiveReadiness" },
        { label: "Back to AI Setup Center", screen: "AISetupCenter" }
      ]}
    />
  );
}

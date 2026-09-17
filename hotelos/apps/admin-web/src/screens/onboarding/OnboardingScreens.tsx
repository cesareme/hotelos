import { CocoaButton, CocoaPage } from "../../components/cocoa";
import { navigateTo, type ScreenKey } from "../../lib/navigate";
import { ScreenScaffold, type ScreenScaffoldProps } from "../ScreenScaffold";

// Sprint 53 — the upload→classify→extract screens are real, interactive
// components living in OnboardingInteractive.tsx. They are re-exported here so
// App.tsx keeps one chunk for the whole migration module.
export { FileUploadAndClassificationScreen, AIExtractionReviewScreen } from "./OnboardingInteractive";

// Tanda 5 (L1b): the assisted migration lives under /desarrollo/migracion/*
// (dev-only: `?dev=1` + platform admin). Only four screens remain — the
// project list (this file), the file upload and the extraction review
// (OnboardingInteractive.tsx) and the migration batches (this file). The
// scaffold steps the CSV retired (source connections, blueprint, rate-plan /
// channel / guest / reservation / revenue-history / compliance reviews,
// data-quality, dry-run, cutover, AI setup center) are gone; their links land
// on the covering screen (nav-tree.generated.json → retired[].url).
//
// Cocoa 22 · ola 11: every screen is a standalone CocoaPage (eyebrow · h1 ·
// subtitle · next-step actions) whose body is the migrated ScreenScaffold
// (pending-note callout + card grid).

const EYEBROW = "Onboarding con IA y migración";

/** Default banner: the step is not wired to services/onboardingApi.ts yet. */
const ONBOARDING_PENDING_NOTE =
  "Pantalla en construcción: este paso aún no está conectado al API de onboarding y no muestra datos de tu propiedad.";

type OnboardingCard = ScreenScaffoldProps["cards"][number];
type OnboardingNav = { label: string; screen: ScreenKey };

const sharedCards: OnboardingCard[] = [
  {
    title: "Revisión humana",
    body: "Las sugerencias de la IA quedan pendientes hasta que una persona las aprueba, rechaza o edita. La IA no aplica la migración directamente."
  },
  {
    title: "Dry-run obligatorio",
    body: "Cada acción de aplicar exige un resultado de dry-run con el recuento de creaciones, actualizaciones, enlaces y omisiones."
  },
  {
    title: "Control de datos sensibles",
    body: "Los ficheros subidos se cifran, los datos de tarjeta en bruto se rechazan y las vistas previas sensibles requieren permiso."
  }
];

function OnboardingScreen(props: {
  title: string;
  summary: string;
  cards?: OnboardingCard[];
  /** Next steps of the journey, painted as header actions. */
  nav?: OnboardingNav[];
  /** Custom "under construction" wording; the onboarding default applies otherwise. */
  pendingNote?: string;
}) {
  return (
    <CocoaPage
      eyebrow={EYEBROW}
      title={props.title}
      subtitle={props.summary}
      actions={
        props.nav?.length ? (
          <>
            {props.nav.map((item) => (
              <CocoaButton key={item.screen} variant="bordered" tone="neutral" size="small" onClick={() => navigateTo(item.screen)}>
                {item.label}
              </CocoaButton>
            ))}
          </>
        ) : undefined
      }
    >
      <ScreenScaffold cards={props.cards ?? sharedCards} pendingNote={props.pendingNote ?? ONBOARDING_PENDING_NOTE} />
    </CocoaPage>
  );
}

export function OnboardingProjectListScreen() {
  return (
    <OnboardingScreen
      title="Proyectos de onboarding"
      summary="Proyectos de implantación y migración asistidos por IA: sistema de origen, fecha objetivo de go-live, responsables, confianza de la extracción y número de incidencias bloqueantes."
      nav={[
        { label: "Subir ficheros", screen: "FileUploadAndClassification" },
        { label: "Revisión de la extracción", screen: "AIExtractionReview" },
        { label: "Lotes de migración", screen: "MigrationBatches" },
        { label: "Salida en vivo", screen: "GoLiveChecklist" }
      ]}
    />
  );
}

export function MigrationBatchScreen() {
  return (
    <OnboardingScreen
      title="Lotes de migración"
      summary="Lotes de aplicación controlada y reversión segura para el plano de la propiedad, habitaciones, tarifas, reservas, huéspedes, canales e histórico de ingresos."
      cards={[
        {
          title: "Orden de aplicación de la importación",
          body: "Plano de la propiedad, ajustes de cumplimiento, habitaciones, espacios, recursos de inventario, tarifas, restricciones, canales, mapeos de canal, huéspedes, empresas, reservas, histórico de ingresos y usuarios/roles."
        },
        {
          title: "Regla contable",
          body: "Las facturas históricas y los informes de ingresos se importan como histórico de solo lectura o instantáneas analíticas, salvo aprobación explícita como migración contable."
        },
        {
          title: "Bloqueos de revisión",
          body: "Los lotes bloqueados no se pueden aplicar. Los lotes que requieren revisión deben aprobarse, rechazarse o editarse antes de aplicar."
        }
      ]}
      nav={[
        { label: "Siguiente: salida en vivo", screen: "GoLiveChecklist" },
        { label: "Volver a la revisión de la extracción", screen: "AIExtractionReview" },
        { label: "Volver a los proyectos", screen: "OnboardingProjects" }
      ]}
    />
  );
}

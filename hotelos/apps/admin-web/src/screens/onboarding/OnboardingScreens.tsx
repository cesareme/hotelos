import { ScreenScaffold, type ScreenScaffoldAction, type ScreenScaffoldProps } from "../ScreenScaffold";

// Sprint 53 — the upload→classify→extract→map→approve screens are now real,
// interactive components living in OnboardingInteractive.tsx. They are re-exported
// here so the existing App.tsx / route registrations keep working unchanged.
export {
  FileUploadAndClassificationScreen,
  AIExtractionReviewScreen,
  RoomMappingReviewScreen
} from "./OnboardingInteractive";

// Tanda 3 (cierre): the 16 scaffold screens below are honest placeholders.
// Every one of them renders the `pendingNote` banner, Spanish copy and NO
// invented status tags or metrics — the cards describe the rules each step
// will enforce, never the state of a property. The `screen: "…"` keys and the
// exported component names are route contracts (App.tsx / Sidebar.tsx) and
// stay exactly as they were.

const EYEBROW = "Onboarding con IA y migración";

/** Default banner: the step is not wired to services/onboardingApi.ts yet. */
const ONBOARDING_PENDING_NOTE =
  "Pantalla en construcción: este paso aún no está conectado al API de onboarding y no muestra datos de tu propiedad.";

type OnboardingCard = { title: string; body: string; actions?: ScreenScaffoldAction[] };

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
  nav?: ScreenScaffoldAction[];
  /** Custom "under construction" wording; the onboarding default applies otherwise. */
  pendingNote?: string;
}) {
  const baseCards = props.cards ?? sharedCards;
  const cards: ScreenScaffoldProps["cards"] = props.nav?.length
    ? [
        ...baseCards,
        {
          title: "Continuar el recorrido",
          body: "Ir al siguiente paso del onboarding asistido por IA y de la migración.",
          actions: props.nav
        }
      ]
    : baseCards;
  return (
    <ScreenScaffold
      eyebrow={EYEBROW}
      title={props.title}
      summary={props.summary}
      cards={cards}
      pendingNote={props.pendingNote ?? ONBOARDING_PENDING_NOTE}
    />
  );
}

export function AISetupCenterScreen() {
  // Tanda 3: no invented project metrics ("62%", "84% confidence", "blocked").
  // The screen is a navigation hub for the AI onboarding flow until the
  // onboarding API (services/onboardingApi.ts) is wired here.
  return (
    <OnboardingScreen
      title="Centro de setup de IA"
      summary="Inicia o continúa una implantación asistida por IA: conexión con el PMS de origen, subida de ficheros, extracción, mapeo, revisión, dry-run, lotes de migración y preparación para el go-live."
      pendingNote="Pantalla en construcción: aquí no se muestran datos de tu propiedad; los proyectos de onboarding reales se gestionan desde las pantallas enlazadas."
      cards={[
        {
          title: "Proyecto de onboarding",
          body: "Revisa los proyectos de migración, sube los ficheros de origen y lanza la comprobación de calidad de datos.",
          actions: [
            { label: "Proyectos de onboarding", screen: "OnboardingProjects" },
            { label: "Subir ficheros", screen: "FileUploadAndClassification" },
            { label: "Calidad de datos", screen: "OnboardingDataQualityReview" }
          ]
        },
        {
          title: "Plano de la propiedad",
          body: "Revisa edificios, plantas, habitaciones, tipos y recursos detectados antes de aplicarlos.",
          actions: [
            { label: "Revisar plano", screen: "PropertyBlueprintReview" },
            { label: "Revisión de mapeo de habitaciones", screen: "RoomMappingReview" }
          ]
        },
        {
          title: "Go-live",
          body: "Comprueba los bloqueos pendientes y el plan de cutover antes de pasar a producción.",
          actions: [
            { label: "Preparación para el go-live", screen: "OnboardingGoLiveReadiness" },
            { label: "Asistente de cutover", screen: "CutoverAssistant" }
          ]
        }
      ]}
    />
  );
}

export function OnboardingProjectListScreen() {
  return (
    <OnboardingScreen
      title="Proyectos de onboarding"
      summary="Proyectos de implantación y migración asistidos por IA: sistema de origen, fecha objetivo de go-live, responsables, confianza de la extracción y número de incidencias bloqueantes."
      nav={[
        { label: "Abrir el detalle del proyecto", screen: "OnboardingProjectDetail" },
        { label: "Conectar un origen", screen: "SourceConnections" },
        { label: "Volver al centro de setup de IA", screen: "AISetupCenter" }
      ]}
    />
  );
}

export function OnboardingProjectDetailScreen() {
  return (
    <OnboardingScreen
      title="Detalle del proyecto de onboarding"
      summary="Progreso del proyecto, conexiones de origen, ficheros subidos, entidades extraídas, cola de mapeo, lotes de migración y siguiente acción de configuración."
      nav={[
        { label: "Conexiones de origen", screen: "SourceConnections" },
        { label: "Subir ficheros", screen: "FileUploadAndClassification" },
        { label: "Lotes de migración", screen: "MigrationBatches" },
        { label: "Preparación para el go-live", screen: "OnboardingGoLiveReadiness" }
      ]}
    />
  );
}

export function SourceConnectionScreen() {
  return (
    <OnboardingScreen
      title="Conexiones de origen"
      summary="Conecta o simula los orígenes de datos: Mews, Oracle OPERA/OHIP, Cloudbeds, Apaleo, OpenAPI genérico, ficheros CSV/XLSX/PDF y configuración manual."
      nav={[
        { label: "Siguiente: subir ficheros", screen: "FileUploadAndClassification" },
        { label: "Volver al proyecto", screen: "OnboardingProjectDetail" }
      ]}
    />
  );
}

export function PropertyBlueprintReviewScreen() {
  return (
    <OnboardingScreen
      title="Revisión del plano de la propiedad"
      summary="Revisa edificios, plantas, zonas, habitaciones, espacios, recursos de inventario, secciones de housekeeping, áreas de mantenimiento y configuración de códigos QR."
      cards={[
        {
          title: "Alta por recorrido de habitaciones",
          body: "La transcripción de voz puede sugerir rangos de habitaciones, planta, zona, tipo, almacenes y estado fuera de servicio, pero no se crea nada sin confirmación humana."
        },
        {
          title: "Mapeo de planos con IA",
          body: "Los planos son solo una ayuda. Las etiquetas de habitaciones, los espacios públicos y las salidas de emergencia requieren revisión manual y no sirven para cumplimiento legal o de seguridad sin validación."
        },
        {
          title: "Vista previa del plano",
          body: "Cuando el proyecto tenga un plano extraído, aquí se listarán los edificios, plantas, habitaciones y recursos detectados para su aprobación."
        }
      ]}
      nav={[
        { label: "Siguiente: revisión de mapeo de habitaciones", screen: "RoomMappingReview" },
        { label: "Volver a la revisión de extracción", screen: "AIExtractionReview" }
      ]}
    />
  );
}

export function RatePlanMappingReviewScreen() {
  return (
    <OnboardingScreen
      title="Revisión de mapeo de planes de tarifa"
      summary="Mapea los códigos de tarifa del PMS anterior a los planes de tarifa de Anfitorio, con sus restricciones, derivaciones y reglas de mínimo y máximo."
      nav={[
        { label: "Siguiente: revisión de mapeo de canales", screen: "ChannelMappingReview" },
        { label: "Volver al mapeo de habitaciones", screen: "RoomMappingReview" }
      ]}
    />
  );
}

export function ReservationImportReviewScreen() {
  return (
    <OnboardingScreen
      title="Revisión de importación de reservas"
      summary="Revisa reservas futuras, recursos asignados, huéspedes, depósitos, saldos, fechas y conflictos antes de importar reservas en vivo."
      cards={[
        {
          title: "Cola de revisión humana",
          body: "Los mapeos pendientes, de baja confianza, de alto riesgo, con datos incompletos, financieros o de cumplimiento pasan a una cola de revisión dedicada."
        },
        {
          title: "Aplicación bloqueada con revisiones pendientes",
          body: "La aplicación de la migración se bloquea mientras la cola de revisión humana tenga elementos pendientes."
        },
        {
          title: "Política de conflictos del delta",
          body: "Las reservas y saldos del delta de go-live usan dry-runs con marca de agua del origen y revisión manual de conflictos."
        }
      ]}
      nav={[
        { label: "Siguiente: revisión de importación de huéspedes", screen: "GuestImportReview" },
        { label: "Abrir la cola de revisión humana", screen: "AiHumanReviewQueueScreen" }
      ]}
    />
  );
}

export function GuestImportReviewScreen() {
  return (
    <OnboardingScreen
      title="Revisión de importación de huéspedes"
      summary="Revisa perfiles de huésped, detección de duplicados, opciones de minimización y visibilidad de campos sensibles antes de migrar."
      nav={[
        { label: "Siguiente: revisión de calidad de datos", screen: "OnboardingDataQualityReview" },
        { label: "Volver a la importación de reservas", screen: "ReservationImportReview" }
      ]}
    />
  );
}

export function ChannelMappingReviewScreen() {
  return (
    <OnboardingScreen
      title="Revisión de mapeo de canales"
      summary="Mapea los códigos de habitación y tarifa de los canales de origen a los canales, tipos de habitación y planes de tarifa de Anfitorio, y comprueba la preparación de la sincronización ARI."
      nav={[
        { label: "Siguiente: importación del histórico de ingresos", screen: "RevenueHistoryImportReview" },
        { label: "Volver al mapeo de planes de tarifa", screen: "RatePlanMappingReview" }
      ]}
    />
  );
}

export function RevenueHistoryImportReviewScreen() {
  return (
    <OnboardingScreen
      title="Revisión de importación del histórico de ingresos"
      summary="Clasifica y extrae los informes de History & Forecast en ingresos diarios e instantáneas de previsión, con validación de totales antes de aplicar."
      nav={[
        { label: "Siguiente: revisión de calidad de datos", screen: "OnboardingDataQualityReview" },
        { label: "Volver al mapeo de canales", screen: "ChannelMappingReview" }
      ]}
    />
  );
}

export function ComplianceSetupReviewScreen() {
  return (
    <OnboardingScreen
      title="Revisión de la configuración de cumplimiento"
      summary="Propone, a partir del perfil legal, la configuración del registro de viajeros, el enrutamiento a las autoridades, SES.HOSPEDAJES, la región fiscal de facturación y la retención de datos."
      nav={[
        { label: "Siguiente: revisión de calidad de datos", screen: "OnboardingDataQualityReview" },
        { label: "Ajustes de SES.HOSPEDAJES", screen: "SesHospedajesSettings" }
      ]}
    />
  );
}

export function DataQualityReviewScreen() {
  return (
    <OnboardingScreen
      title="Revisión de calidad de datos"
      summary="Comprobaciones bloqueantes, avisos e informativas sobre habitaciones, planes de tarifa, reservas, canales, duplicados de huéspedes, cumplimiento e informes de ingresos."
      cards={[
        {
          title: "Comprobaciones bloqueantes",
          body: "Números de habitación duplicados, habitaciones sin tipo, reservas futuras sin huésped, mapeos de canal ausentes, configuración de SES.HOSPEDAJES incompleta y descuadres en los totales de History & Forecast bloquean el go-live."
        },
        {
          title: "Avisos",
          body: "Duplicados de huéspedes, proveedor de pago ausente, huecos en la previsión y planes de tarifa sin días tarifados requieren revisión, pero pueden resolverse por política operativa."
        },
        {
          title: "Condición para aplicar",
          body: "Aplicar la migración exige un dry-run completado, confirmación humana explícita, cero incidencias bloqueantes y cero revisiones de mapeo pendientes."
        }
      ]}
      nav={[
        { label: "Siguiente: resultado del dry-run", screen: "DryRunResult" },
        { label: "Abrir la cola de revisión humana", screen: "AiHumanReviewQueueScreen" }
      ]}
    />
  );
}

export function DryRunResultScreen() {
  return (
    <OnboardingScreen
      title="Resultado del dry-run"
      summary="Vista previa de los objetos a crear, actualizar, enlazar u omitir, con avisos y conflictos. Aplicar permanece deshabilitado hasta revisar este resultado."
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
        { label: "Siguiente: lotes de migración", screen: "MigrationBatches" },
        { label: "Volver a la calidad de datos", screen: "OnboardingDataQualityReview" }
      ]}
    />
  );
}

export function MigrationBatchScreen() {
  return (
    <OnboardingScreen
      title="Lotes de migración"
      summary="Lotes de aplicación controlada y reversión segura para el plano de la propiedad, habitaciones, tarifas, reservas, huéspedes, canales e histórico de ingresos."
      nav={[
        { label: "Siguiente: preparación para el go-live", screen: "OnboardingGoLiveReadiness" },
        { label: "Volver al resultado del dry-run", screen: "DryRunResult" }
      ]}
    />
  );
}

export function GoLiveReadinessScreen() {
  return (
    <OnboardingScreen
      title="Preparación para el go-live"
      summary="Puntuación de preparación, incidencias bloqueantes, checklist de cutover, ventana de congelación, importación del delta, plan de reversión y estado de la aprobación final."
      cards={[
        {
          title: "Plan de cutover",
          body: "Se hace seguimiento de las etapas T-30 descubrimiento, T-14 importación de prueba, T-7 revisión con el equipo, T-2 ensayo de exportación, T-1 congelación, importación del delta en el go-live y comprobaciones T+1."
        },
        {
          title: "Condiciones de bloqueo del go-live",
          body: "Las incidencias bloqueantes de calidad de datos impiden la aprobación final hasta resolver la configuración de SES.HOSPEDAJES y la validación de totales de History & Forecast."
        },
        {
          title: "Política de reversión",
          body: "Solo se permite revertir lotes seguros que no estén bloqueados por actividad en vivo; siempre se generan eventos de auditoría."
        }
      ]}
      nav={[
        { label: "Abrir el asistente de cutover", screen: "CutoverAssistant" },
        { label: "Volver a los lotes de migración", screen: "MigrationBatches" },
        { label: "Ajustes de SES.HOSPEDAJES", screen: "SesHospedajesSettings" }
      ]}
    />
  );
}

export function CutoverAssistantScreen() {
  return (
    <OnboardingScreen
      title="Asistente de cutover"
      summary="Etapas de cutover de T-30 a T+1: descubrimiento, importación de prueba, formación, congelación, importación del delta, validación de llegadas, saldos y canales, y auditoría de la primera noche."
      cards={[
        {
          title: "Dry-run de la importación del delta",
          body: "Los últimos cambios del PMS se previsualizan desde una marca de agua del origen. El plan del delta es solo dry-run hasta la aprobación del go-live y la confirmación del responsable."
        },
        {
          title: "Políticas de conflicto",
          body: "Las reservas y los deltas de canal pueden usar «gana el origen tras la congelación». Los folios y saldos requieren revisión manual."
        },
        {
          title: "Auditoría de la primera noche",
          body: "El plan de cutover mantiene la auditoría de la primera noche como paso de validación explícito del día del go-live."
        }
      ]}
      nav={[
        { label: "Volver a la preparación para el go-live", screen: "OnboardingGoLiveReadiness" },
        { label: "Volver al centro de setup de IA", screen: "AISetupCenter" }
      ]}
    />
  );
}

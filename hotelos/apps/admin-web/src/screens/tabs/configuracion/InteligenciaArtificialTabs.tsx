// Inteligencia artificial — /configuracion/ia (Tanda 5 · L1a · lot tabs-c).
//
// Item `PropertyAiScreen` (the only AI settings backend, Prisma): base tab «Ajustes»
// plus Herramientas (AiToolRegistryScreen: the real 105-tool catalogue that hid
// behind «Próximamente»), Actividad (AiPipelineStatusScreen: real telemetry),
// Gobernanza (AiGovernanceScreen: políticas, prompts, evaluaciones, incidentes,
// coste) and Alta de IA (AiPropertySetupForm, the orphan setup form). The
// demoStore twin AISettings and the AISetupCenter scaffold retire into this item;
// AIGovernanceSettings is an alias of Gobernanza.
// Labels, URLs and roles come from nav-tree.generated.json (pilots/tanda5-nav-tree.csv).
//
// L1b registers: screenKey PropertyAiScreen · url /configuracion/ia · tabs
// /configuracion/ia/herramientas, /actividad, /gobernanza, /alta.

import { NavItemTabs } from "../NavItemTabs";
import type { TabLoaders } from "../nav-item-tabs";
import { embed } from "../tab-helpers";

export const loaders: TabLoaders = {
  PropertyAiScreen: () => import("../../aiOperations/PropertyAiScreen").then((m) => embed(m.PropertyAiScreen)),
  AiToolRegistryScreen: () => import("../../aiOperations/AiToolRegistryScreen").then((m) => embed(m.AiToolRegistryScreen)),
  AiPipelineStatusScreen: () => import("../../aiOperations/AiPipelineStatusScreen").then((m) => embed(m.AiPipelineStatusScreen)),
  AiGovernanceScreen: () => import("../../aiOperations/AiGovernanceScreen").then((m) => embed(m.AiGovernanceScreen)),
  AiPropertySetupForm: () => import("../../propertySetup/PropertySetupForms").then((m) => ({ default: m.AiPropertySetupForm }))
};

export default function InteligenciaArtificialTabs() {
  return (
    <NavItemTabs
      screenKey="PropertyAiScreen"
      loaders={loaders}
      subtitle="Interruptor y valores por defecto de la IA en esta propiedad, catálogo de herramientas, actividad, gobernanza y alta inicial."
    />
  );
}

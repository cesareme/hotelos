// Tarjeta de instrucciones del Centro de cumplimiento (/cumplimiento/centro).
// AVISO (corrección DOC-2, 2026-09-20): este objeto NO se renderiza hoy. Ninguna
// pantalla lo importa: ComplianceCenterScreen.tsx pinta su propia constante local
// COMPLIANCE_INSTRUCTIONS (title/description/steps/tip). Queda aquí como copia de
// referencia hasta que la pantalla lo importe (decisión del orquestador; cambio
// fuera de content/) o se retire el fichero.
// Tanda DOC-2: copy en español (tildes completas), vocabulario del manual y solo lo
// que existe en la pantalla: seis secciones (Matriz · Documentos · Tareas · Alertas ·
// Asistente IA · Ajustes), filtros de la matriz por área, riesgo y estado, «Registrar
// documento», «Nueva tarea correctiva» y el botón «Carpeta de inspección». Los envíos
// a la AEAT y al Ministerio del Interior se siguen en sus propias pantallas, no aquí.
// Los atajos salen del registro, nunca escritos a mano.
import { shortcutKeys } from "../shortcuts-registry";

export const COMPLIANCE_INSTRUCTIONS = {
  whatIsThis:
    "Centro de cumplimiento: qué obligaciones legales aplican a este hotel (estatales, autonómicas y municipales), qué documento las justifica, cuándo vencen, quién es el responsable y qué riesgo hay si no se cumplen. Seis secciones: Matriz, Documentos, Tareas, Alertas, Asistente IA y Ajustes.",
  howToUse: [
    "Configura en «Ajustes» el perfil del establecimiento (comunidad autónoma, tipo y servicios) para que la matriz aplique las obligaciones correctas.",
    "Revisa la «Matriz»: la tabla «Cumplimiento por área» resume cumplidos, pendientes, vencidos y críticos; filtra los controles por área, riesgo o estado (Cumple · No cumple · Pendiente · Vencido · Vence pronto · No aplica · En revisión) y abre cada uno para actualizar su estado, el responsable, la fecha de vencimiento y las notas.",
    "Registra en «Documentos» los certificados, licencias y acuses que justifican cada obligación («Registrar documento», con su fecha de caducidad y el control al que se asocia); con el documento vigente el control pasa a «Cumple».",
    "Atiende las «Alertas» (obligaciones vencidas, que vencen pronto o sin documento) y crea en «Tareas» las tareas correctivas con prioridad, fecha límite («Vence el») y responsable."
  ],
  tips: [
    "«Carpeta de inspección» genera un dosier imprimible (ábrelo e imprímelo a PDF) con las obligaciones aplicables y sus documentos, listo para una inspección de la AEAT, de una Hacienda Foral o de la autoridad turística.",
    "Los envíos a la AEAT (VeriFactu) y al Ministerio del Interior (SES.Hospedajes) se siguen en Cumplimiento › Envíos a autoridades y en Cumplimiento › Registro de viajeros, no en esta matriz."
  ],
  shortcuts: [
    { keys: shortcutKeys("global.palette"), description: "Buscar reservas, huéspedes y pantallas" },
    { keys: shortcutKeys("global.escape"), description: "Cerrar el panel o diálogo abierto" }
  ],
  relatedScreens: [
    { label: "Tasas e impuestos", screenId: "PropertyTaxesScreen" },
    { label: "Configuración › Fiscal", screenId: "TaxComplianceSettings" }
  ]
};

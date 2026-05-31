// Compliance Center seed: areas + baseline requirement matrix (Spanish hotels)
// + a demo property profile and materialized items with a realistic status mix.
// Idempotent. Run: node --env-file=../../.env --import tsx prisma/seed-compliance.ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const PROPERTY_ID = process.env.SEED_PROPERTY_ID ?? "prop_123";
const MS_DAY = 86_400_000;

type Risk = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
type Jur = "STATE" | "AUTONOMOUS_COMMUNITY" | "MUNICIPAL" | "INTERNAL";

const AREAS: { code: string; name: string; description: string }[] = [
  { code: "LIC", name: "Licencias y urbanismo", description: "Apertura, actividad, ocupación y compatibilidad urbanística." },
  { code: "TUR", name: "Turismo y clasificación", description: "Registro turístico, categoría y placa identificativa." },
  { code: "SEG", name: "Registro de viajeros", description: "SES.HOSPEDAJES y partes de viajeros (RD 933/2021)." },
  { code: "RGPD", name: "Protección de datos", description: "RGPD/LOPDGDD: tratamientos, privacidad y videovigilancia." },
  { code: "LAB", name: "Laboral y Seguridad Social", description: "Contratos, altas, jornada y convenios." },
  { code: "PRL", name: "Prevención de riesgos laborales", description: "Evaluación, planificación, formación y vigilancia de la salud." },
  { code: "PCI", name: "Incendios y autoprotección", description: "Plan de emergencia, mantenimiento PCI y simulacros." },
  { code: "INS", name: "Instalaciones técnicas", description: "Electricidad, climatización, ascensores, gas y presión." },
  { code: "SAN", name: "Sanidad alimentaria", description: "APPCC, temperaturas, alérgenos y plagas." },
  { code: "LEG", name: "Legionella, agua y piscinas", description: "Prevención de legionella, analíticas y control de piscina." },
  { code: "ACC", name: "Accesibilidad", description: "Itinerarios, habitaciones y baños adaptados." },
  { code: "CON", name: "Consumo y reclamaciones", description: "Hojas de reclamaciones, cartel y política de precios." },
  { code: "ENV", name: "Medio ambiente", description: "Residuos, aceite usado, eficiencia energética y ruido." },
  { code: "FIS", name: "Fiscal y contable", description: "Facturación correcta y tasas turísticas." },
  { code: "SEGUR", name: "Seguros", description: "Responsabilidad civil y multirriesgo vigentes." }
];

type Req = {
  area: string; code: string; title: string; risk: Risk; jur?: Jur;
  ref?: string; docs?: string[]; rule?: string; def?: boolean; renew?: number; appliesWhen?: string;
  community?: string; hotelTypes?: string[];
};

const REQS: Req[] = [
  // Licencias
  { area: "LIC", code: "LIC-001", title: "Licencia de actividad / apertura", risk: "CRITICAL", jur: "MUNICIPAL", docs: ["Licencia de actividad"], ref: "Ordenanza municipal" },
  { area: "LIC", code: "LIC-002", title: "Licencia de primera ocupación / utilización", risk: "HIGH", jur: "MUNICIPAL", docs: ["Licencia de primera ocupación"] },
  { area: "LIC", code: "LIC-003", title: "Compatibilidad urbanística", risk: "MEDIUM", jur: "MUNICIPAL", docs: ["Certificado de compatibilidad"] },
  { area: "LIC", code: "LIC-004", title: "Licencia de terraza, música o eventos", risk: "MEDIUM", jur: "MUNICIPAL", rule: "hasTerrace", docs: ["Licencia de terraza/eventos"], appliesWhen: "Si hay terraza, música o eventos" },
  { area: "LIC", code: "LIC-005", title: "Autorización de patrimonio (edificio protegido)", risk: "HIGH", jur: "AUTONOMOUS_COMMUNITY", rule: "buildingProtected", def: false, docs: ["Autorización de patrimonio"], appliesWhen: "Si el edificio está protegido" },
  // Turismo
  { area: "TUR", code: "TUR-001", title: "Inscripción en el Registro de Turismo", risk: "CRITICAL", jur: "AUTONOMOUS_COMMUNITY", docs: ["Resolución de inscripción"] },
  { area: "TUR", code: "TUR-002", title: "Clasificación hotelera y categoría", risk: "HIGH", jur: "AUTONOMOUS_COMMUNITY", docs: ["Resolución de categoría"] },
  { area: "TUR", code: "TUR-003", title: "Placa identificativa oficial", risk: "LOW", jur: "AUTONOMOUS_COMMUNITY", docs: ["Foto de la placa"] },
  // Turismo — variantes por comunidad autónoma (plantillas autonómicas)
  { area: "TUR", code: "TUR-MAD-01", title: "Declaración Responsable de inicio de actividad turística (Madrid)", risk: "HIGH", jur: "AUTONOMOUS_COMMUNITY", community: "MAD", ref: "Decreto 159/2003 (CM)", docs: ["Declaración responsable", "Justificante de registro"] },
  { area: "TUR", code: "TUR-CAT-01", title: "Habilitació turística / núm. d'inscripció (Cataluña)", risk: "HIGH", jur: "AUTONOMOUS_COMMUNITY", community: "CAT", ref: "Decret 75/2020", docs: ["Comunicació prèvia", "Núm. d'inscripció"] },
  { area: "TUR", code: "TUR-AND-01", title: "Inscripción en el Registro de Turismo de Andalucía (RTA)", risk: "HIGH", jur: "AUTONOMOUS_COMMUNITY", community: "AND", ref: "Decreto 155/2018", docs: ["Declaración responsable", "Inscripción RTA"] },
  { area: "TUR", code: "TUR-CAN-01", title: "Inscripción en el Registro General Turístico de Canarias", risk: "HIGH", jur: "AUTONOMOUS_COMMUNITY", community: "CAN", ref: "Decreto 142/2010", docs: ["Declaración responsable", "Inscripción registro"] },
  { area: "TUR", code: "TUR-VAL-01", title: "Inscripción en el Registro de Empresas Turísticas CV (Valencia)", risk: "HIGH", jur: "AUTONOMOUS_COMMUNITY", community: "VAL", ref: "Ley 15/2018", docs: ["Declaración responsable"] },
  // Registro de viajeros
  { area: "SEG", code: "SEG-001", title: "Alta en SES.HOSPEDAJES", risk: "CRITICAL", jur: "STATE", ref: "RD 933/2021", docs: ["Justificante de alta", "Credenciales o certificado"] },
  { area: "SEG", code: "SEG-002", title: "Comunicación de partes de viajeros", risk: "CRITICAL", jur: "STATE", ref: "RD 933/2021", docs: ["Evidencia de envío"] },
  { area: "SEG", code: "SEG-003", title: "Conservación de registros de huéspedes", risk: "HIGH", jur: "STATE", docs: ["Política de conservación"] },
  // RGPD
  { area: "RGPD", code: "RGPD-001", title: "Registro de Actividades de Tratamiento", risk: "HIGH", jur: "STATE", ref: "RGPD art. 30", docs: ["RAT"] },
  { area: "RGPD", code: "RGPD-002", title: "Política de privacidad de huéspedes", risk: "MEDIUM", jur: "STATE", docs: ["Política de privacidad"] },
  { area: "RGPD", code: "RGPD-003", title: "Contratos de encargado de tratamiento", risk: "MEDIUM", jur: "STATE", docs: ["Contratos DPA"] },
  { area: "RGPD", code: "RGPD-004", title: "Videovigilancia documentada", risk: "MEDIUM", jur: "STATE", docs: ["Carteles", "Registro de cámaras"] },
  { area: "RGPD", code: "RGPD-005", title: "No almacenar copias innecesarias de DNI", risk: "HIGH", jur: "STATE", docs: ["Procedimiento"] },
  // Laboral
  { area: "LAB", code: "LAB-001", title: "Contratos laborales", risk: "HIGH", jur: "STATE", docs: ["Contratos"] },
  { area: "LAB", code: "LAB-002", title: "Altas en Seguridad Social", risk: "CRITICAL", jur: "STATE", docs: ["Altas TGSS"] },
  { area: "LAB", code: "LAB-003", title: "Registro diario de jornada", risk: "HIGH", jur: "STATE", docs: ["Registro de jornada"] },
  { area: "LAB", code: "LAB-004", title: "Convenio colectivo aplicable", risk: "MEDIUM", jur: "STATE", docs: ["Convenio"] },
  { area: "LAB", code: "LAB-005", title: "Calendario laboral", risk: "LOW", jur: "STATE", docs: ["Calendario"] },
  { area: "LAB", code: "LAB-006", title: "Registro retributivo", risk: "MEDIUM", jur: "STATE", docs: ["Registro retributivo"] },
  { area: "LAB", code: "LAB-007", title: "Plan de igualdad", risk: "MEDIUM", jur: "STATE", def: false, docs: ["Plan de igualdad"], appliesWhen: "Si ≥50 personas en plantilla" },
  { area: "LAB", code: "LAB-008", title: "Canal interno de denuncias", risk: "MEDIUM", jur: "STATE", def: false, docs: ["Canal de denuncias"], appliesWhen: "Si ≥50 personas en plantilla" },
  // PRL
  { area: "PRL", code: "PRL-001", title: "Modalidad preventiva", risk: "HIGH", jur: "STATE", docs: ["Concierto SPA / modalidad"] },
  { area: "PRL", code: "PRL-002", title: "Evaluación de riesgos", risk: "HIGH", jur: "STATE", docs: ["Evaluación de riesgos"], renew: 365 },
  { area: "PRL", code: "PRL-003", title: "Planificación preventiva", risk: "MEDIUM", jur: "STATE", docs: ["Planificación"] },
  { area: "PRL", code: "PRL-004", title: "Formación PRL de trabajadores", risk: "MEDIUM", jur: "STATE", docs: ["Certificados de formación"], renew: 365 },
  { area: "PRL", code: "PRL-005", title: "Vigilancia de la salud", risk: "MEDIUM", jur: "STATE", docs: ["Aptitudes médicas"], renew: 365 },
  { area: "PRL", code: "PRL-006", title: "Coordinación de actividades empresariales", risk: "MEDIUM", jur: "STATE", docs: ["CAE contratas"] },
  // Incendios
  { area: "PCI", code: "PCI-001", title: "Plan de emergencia", risk: "HIGH", jur: "AUTONOMOUS_COMMUNITY", docs: ["Plan de emergencia"] },
  { area: "PCI", code: "PCI-002", title: "Plan de autoprotección", risk: "HIGH", jur: "AUTONOMOUS_COMMUNITY", rule: "hasParking", docs: ["Plan de autoprotección"], appliesWhen: "Según aforo/normativa autonómica" },
  { area: "PCI", code: "PCI-003", title: "Mantenimiento de extintores", risk: "HIGH", jur: "STATE", docs: ["Actas de revisión"], renew: 365 },
  { area: "PCI", code: "PCI-004", title: "Mantenimiento de detección y alarma", risk: "HIGH", jur: "STATE", docs: ["Actas de mantenimiento"], renew: 365 },
  { area: "PCI", code: "PCI-005", title: "Alumbrado de emergencia", risk: "MEDIUM", jur: "STATE", docs: ["Acta de revisión"], renew: 365 },
  { area: "PCI", code: "PCI-006", title: "Simulacros", risk: "LOW", jur: "INTERNAL", docs: ["Acta de simulacro"], renew: 365 },
  // Instalaciones
  { area: "INS", code: "INS-001", title: "Certificado de instalación eléctrica", risk: "HIGH", jur: "STATE", docs: ["Boletín eléctrico"] },
  { area: "INS", code: "INS-002", title: "Inspecciones OCA de baja tensión", risk: "HIGH", jur: "STATE", docs: ["Acta OCA"], renew: 1825 },
  { area: "INS", code: "INS-003", title: "Mantenimiento RITE / climatización", risk: "MEDIUM", jur: "STATE", docs: ["Contrato de mantenimiento"], renew: 365 },
  { area: "INS", code: "INS-004", title: "Ascensores: contrato e inspección", risk: "HIGH", jur: "STATE", docs: ["Contrato", "Acta de inspección"], renew: 730 },
  { area: "INS", code: "INS-005", title: "Instalaciones de gas", risk: "MEDIUM", jur: "STATE", def: false, docs: ["Revisión de gas"], appliesWhen: "Si hay instalación de gas", renew: 1825 },
  { area: "INS", code: "INS-006", title: "Equipos a presión", risk: "MEDIUM", jur: "STATE", def: false, docs: ["Inspección"], appliesWhen: "Si hay equipos a presión" },
  // Sanidad
  { area: "SAN", code: "SAN-001", title: "APPCC o autocontrol alimentario", risk: "HIGH", jur: "STATE", rule: "hasKitchen", docs: ["Plan APPCC"], appliesWhen: "Si hay cocina/restaurante" },
  { area: "SAN", code: "SAN-002", title: "Control de temperaturas en cocina", risk: "MEDIUM", jur: "STATE", rule: "hasKitchen", docs: ["Registros de temperatura"] },
  { area: "SAN", code: "SAN-003", title: "Formación de manipuladores", risk: "MEDIUM", jur: "STATE", rule: "hasKitchen", docs: ["Certificados"], renew: 1460 },
  { area: "SAN", code: "SAN-004", title: "Información de alérgenos", risk: "HIGH", jur: "STATE", rule: "hasKitchen", docs: ["Fichas de alérgenos"] },
  { area: "SAN", code: "SAN-005", title: "Control de plagas (DDD)", risk: "MEDIUM", jur: "STATE", docs: ["Contrato DDD", "Actas"], renew: 365 },
  // Legionella / agua
  { area: "LEG", code: "LEG-001", title: "Plan de prevención de legionella", risk: "HIGH", jur: "STATE", ref: "RD 487/2022", docs: ["Plan de prevención"] },
  { area: "LEG", code: "LEG-002", title: "Analíticas de legionella", risk: "HIGH", jur: "STATE", docs: ["Analíticas"], renew: 365 },
  { area: "LEG", code: "LEG-003", title: "Control de agua de consumo", risk: "MEDIUM", jur: "STATE", docs: ["Analíticas de agua"], renew: 365 },
  { area: "LEG", code: "LEG-004", title: "Control sanitario de piscina", risk: "HIGH", jur: "AUTONOMOUS_COMMUNITY", rule: "hasPool", docs: ["Registros de piscina"], appliesWhen: "Si hay piscina" },
  // Accesibilidad
  { area: "ACC", code: "ACC-001", title: "Itinerario accesible", risk: "MEDIUM", jur: "AUTONOMOUS_COMMUNITY", docs: ["Certificado/plano"] },
  { area: "ACC", code: "ACC-002", title: "Habitaciones adaptadas", risk: "MEDIUM", jur: "AUTONOMOUS_COMMUNITY", docs: ["Inventario"] },
  { area: "ACC", code: "ACC-003", title: "Baños adaptados", risk: "LOW", jur: "AUTONOMOUS_COMMUNITY", docs: ["Inventario"] },
  // Legionella — variante por tipo de hotel (resort con piscina)
  { area: "LEG", code: "LEG-RES-01", title: "Socorrista y plan de seguridad de piscina (resort)", risk: "HIGH", jur: "AUTONOMOUS_COMMUNITY", hotelTypes: ["RESORT", "APARTHOTEL"], rule: "hasPool", docs: ["Contrato de socorrista", "Plan de seguridad de piscina"], appliesWhen: "Resort/aparthotel con piscina" },
  // Consumo
  { area: "CON", code: "CON-001", title: "Hojas de reclamaciones disponibles", risk: "MEDIUM", jur: "AUTONOMOUS_COMMUNITY", docs: ["Stock de hojas"] },
  { area: "CON", code: "CON-002", title: "Cartel de hojas de reclamaciones", risk: "LOW", jur: "AUTONOMOUS_COMMUNITY", docs: ["Foto del cartel"] },
  { area: "CON", code: "CON-003", title: "Política de precios y cancelaciones", risk: "LOW", jur: "STATE", docs: ["Política publicada"] },
  // Medio ambiente
  { area: "ENV", code: "ENV-001", title: "Contratos con gestores de residuos", risk: "MEDIUM", jur: "AUTONOMOUS_COMMUNITY", docs: ["Contratos"] },
  { area: "ENV", code: "ENV-002", title: "Gestión del aceite usado de cocina", risk: "LOW", jur: "AUTONOMOUS_COMMUNITY", rule: "hasKitchen", docs: ["Albaranes de retirada"] },
  { area: "ENV", code: "ENV-003", title: "Certificado de eficiencia energética", risk: "LOW", jur: "STATE", docs: ["CEE"], renew: 3650 },
  { area: "ENV", code: "ENV-004", title: "Control de ruido", risk: "LOW", jur: "MUNICIPAL", def: false, docs: ["Estudio acústico"], appliesWhen: "Si hay música/terraza" },
  // Fiscal
  { area: "FIS", code: "FIS-001", title: "Facturación correcta", risk: "HIGH", jur: "STATE", docs: ["Series y modelo"] },
  { area: "FIS", code: "FIS-002", title: "Tasa turística", risk: "MEDIUM", jur: "AUTONOMOUS_COMMUNITY", def: false, docs: ["Autoliquidaciones"], appliesWhen: "Según comunidad autónoma" },
  { area: "FIS", code: "FIS-CAT-01", title: "Impost sobre estades en establiments turístics (IEET, Cataluña)", risk: "MEDIUM", jur: "AUTONOMOUS_COMMUNITY", community: "CAT", docs: ["Autoliquidaciones IEET"], renew: 90 },
  { area: "FIS", code: "FIS-BAL-01", title: "Impuesto de Turismo Sostenible (Baleares)", risk: "MEDIUM", jur: "AUTONOMOUS_COMMUNITY", community: "BAL", docs: ["Autoliquidaciones ITS"], renew: 90 },
  // Seguros
  { area: "SEGUR", code: "SEGUR-001", title: "Seguro de responsabilidad civil vigente", risk: "CRITICAL", jur: "AUTONOMOUS_COMMUNITY", docs: ["Póliza", "Recibo"], renew: 365 },
  { area: "SEGUR", code: "SEGUR-002", title: "Seguro multirriesgo vigente", risk: "HIGH", jur: "INTERNAL", docs: ["Póliza", "Recibo"], renew: 365 }
];

function addDays(base: Date, n: number): Date {
  return new Date(base.getTime() + n * MS_DAY);
}

async function main() {
  const property = await prisma.property.findUnique({ where: { id: PROPERTY_ID }, select: { id: true, name: true } });
  if (!property) throw new Error(`Property ${PROPERTY_ID} not found`);
  console.log(`[compliance] property ${PROPERTY_ID} (${property.name})`);

  // Areas
  for (let i = 0; i < AREAS.length; i += 1) {
    const a = AREAS[i];
    await prisma.complianceArea.upsert({
      where: { code: a.code },
      create: { code: a.code, name: a.name, description: a.description, sortOrder: i * 10, active: true },
      update: { name: a.name, description: a.description, sortOrder: i * 10, active: true }
    });
  }

  // Requirements
  for (const r of REQS) {
    await prisma.complianceRequirement.upsert({
      where: { code: r.code },
      create: {
        areaCode: r.area, code: r.code, title: r.title, jurisdiction: r.jur ?? "STATE",
        autonomousCommunity: r.community ?? null, hotelTypes: r.hotelTypes ?? [],
        legalReference: r.ref, appliesWhen: r.appliesWhen, appliesRule: r.rule,
        defaultApplies: r.def ?? true, riskLevel: r.risk, requiredDocuments: r.docs ?? [],
        renewalRequired: Boolean(r.renew), defaultRenewalPeriodDays: r.renew, active: true
      },
      update: {
        areaCode: r.area, title: r.title, jurisdiction: r.jur ?? "STATE",
        autonomousCommunity: r.community ?? null, hotelTypes: r.hotelTypes ?? [],
        legalReference: r.ref, appliesWhen: r.appliesWhen, appliesRule: r.rule,
        defaultApplies: r.def ?? true, riskLevel: r.risk, requiredDocuments: r.docs ?? [],
        renewalRequired: Boolean(r.renew), defaultRenewalPeriodDays: r.renew, active: true
      }
    });
  }

  // Demo property profile (Madrid Centro: urban hotel with restaurant + parking + events).
  await prisma.compliancePropertyProfile.upsert({
    where: { propertyId: PROPERTY_ID },
    create: { propertyId: PROPERTY_ID, autonomousCommunity: "MAD", hotelType: "URBAN", hasRestaurant: true, hasKitchen: true, hasParking: true, hasEvents: true, hasTerrace: true, hasLaundry: true, hasPool: false, hasSpa: false, buildingProtected: false, expiringSoonDays: 30 },
    update: { autonomousCommunity: "MAD", hotelType: "URBAN", hasRestaurant: true, hasKitchen: true, hasParking: true, hasEvents: true, hasTerrace: true, hasLaundry: true, expiringSoonDays: 30 }
  });
  const profile = await prisma.compliancePropertyProfile.findUnique({ where: { propertyId: PROPERTY_ID } });

  // Materialize items for applicable requirements with a realistic status mix.
  const today = new Date();
  const reqs = await prisma.complianceRequirement.findMany({ where: { active: true } });
  let created = 0;
  for (let i = 0; i < reqs.length; i += 1) {
    const req = reqs[i];
    const base = req.appliesRule
      ? Boolean((profile as Record<string, unknown> | null)?.[req.appliesRule])
      : req.defaultApplies;
    const communityOk = !req.autonomousCommunity || req.autonomousCommunity === profile?.autonomousCommunity;
    const hotelTypeOk = !req.hotelTypes?.length || (!!profile?.hotelType && req.hotelTypes.includes(profile.hotelType));
    const applies = base && communityOk && hotelTypeOk;

    let status = "COMPLIANT";
    let issueDate: Date | null = applies ? addDays(today, -200) : null;
    let expiryDate: Date | null = null;
    if (!applies) {
      status = "NOT_APPLICABLE";
      issueDate = null;
    } else if (i % 11 === 0) {
      status = "COMPLIANT"; expiryDate = addDays(today, -15); // → EXPIRED on read
    } else if (i % 7 === 0) {
      status = "COMPLIANT"; expiryDate = addDays(today, 18); // → EXPIRING_SOON on read
    } else if (i % 13 === 0) {
      status = "NON_COMPLIANT"; issueDate = null;
    } else if (i % 9 === 0) {
      status = "PENDING"; issueDate = null;
    } else if (i % 17 === 0) {
      status = "UNDER_REVIEW";
    } else if (req.renewalRequired) {
      status = "COMPLIANT"; expiryDate = addDays(today, req.defaultRenewalPeriodDays ?? 300);
    }

    await prisma.complianceItem.upsert({
      where: { propertyId_requirementCode: { propertyId: PROPERTY_ID, requirementCode: req.code } },
      create: {
        propertyId: PROPERTY_ID, requirementCode: req.code, applies,
        notApplicableReason: applies ? null : req.appliesWhen ?? "No aplica a este establecimiento",
        status, issueDate, expiryDate,
        lastReviewDate: applies ? addDays(today, -30) : null,
        responsibleName: applies ? "Dirección" : null
      },
      update: {}
    });
    created += 1;
  }

  console.log(`[compliance] ${AREAS.length} áreas · ${REQS.length} requisitos · ${created} items para ${PROPERTY_ID}`);
  console.log("[compliance] listo.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());

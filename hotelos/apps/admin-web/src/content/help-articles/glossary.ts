// glossary — hotel and Spanish-compliance vocabulary, one help article per term.
//
// Tanda DOC-2: definiciones en español con ortografía completa; las siglas se
// conservan con su desarrollo en inglés entre paréntesis una sola vez y los
// anglicismos del oficio (pickup, release) se explican en español la primera vez.
import type { CocoaHelpArticle } from '../../components/cocoa-guidance/CocoaSearchableHelpModal';
import { BRAND } from '../../config/brand';

export const GLOSSARY_CATEGORY = 'Glosario';

export interface GlossaryTerm {
  readonly term: string;
  readonly definition: string;
  readonly example?: string;
  readonly relatedTerms: readonly string[];
}

const GLOSSARY: readonly GlossaryTerm[] = [
  {
    term: 'ADR',
    definition:
      'ADR (Average Daily Rate): ingreso medio por habitación ocupada en un periodo. Se calcula dividiendo los ingresos totales de habitaciones entre el número de habitaciones vendidas. Es la métrica base de la fijación de precios en hotelería.',
    example:
      'Si el hotel facturó 50.000 EUR en 500 habitaciones vendidas durante el mes, el ADR fue de 100 EUR.',
    relatedTerms: ['RevPAR', 'GOPPAR', 'BAR', 'Yield'],
  },
  {
    term: 'RevPAR',
    definition:
      'RevPAR (Revenue Per Available Room): ingreso por habitación disponible, incluidas las no vendidas. Se calcula como ADR multiplicado por ocupación, o ingresos totales de habitaciones divididos entre habitaciones disponibles. Mide la eficiencia comercial real.',
    example:
      'Con ADR de 100 EUR y ocupación del 80 %, el RevPAR es 80 EUR por habitación disponible.',
    relatedTerms: ['ADR', 'GOPPAR', 'Yield', 'RMS'],
  },
  {
    term: 'GOPPAR',
    definition:
      'GOPPAR (Gross Operating Profit Per Available Room): beneficio operativo bruto por habitación disponible. Resta los costes operativos de los ingresos totales y divide entre el inventario disponible. Es la métrica preferida por propietarios y gestores del activo.',
    example:
      'Si el GOP (beneficio operativo bruto) del mes fue 30.000 EUR y hubo 1.000 habitaciones disponibles, el GOPPAR es 30 EUR.',
    relatedTerms: ['RevPAR', 'ADR', 'ERP'],
  },
  {
    term: 'BAR',
    definition:
      'BAR (Best Available Rate): mejor tarifa pública disponible para una fecha sin restricciones especiales. Es la tarifa de referencia que ven los huéspedes en la web del hotel y en las agencias en línea (OTA). Suele variar dinámicamente según la demanda.',
    example:
      'El BAR del 15 de agosto es 180 EUR; en temporada baja baja a 95 EUR.',
    relatedTerms: ['ADR', 'Yield', 'Stop-sell', 'Channel parity'],
  },
  {
    term: 'Yield',
    definition:
      'Yield management o gestión del rendimiento: disciplina de ajustar precios y disponibilidad en tiempo real según la demanda, el segmento y el canal para maximizar los ingresos. Es la base del revenue management (gestión de ingresos) moderno.',
    example:
      'Subir el BAR un 20 % el viernes porque queda solo el 30 % del inventario y la demanda crece.',
    relatedTerms: ['BAR', 'RevPAR', 'RMS', 'Stop-sell'],
  },
  {
    term: 'Allotment',
    definition:
      'Allotment o cupo: bloque de habitaciones asignado a un canal, tour operador o agencia bajo contrato. El hotel garantiza la disponibilidad hasta una fecha de liberación (release) o fecha límite (cut-off). Es común en el negocio mayorista y en grupos.',
    example:
      'Cupo de 20 habitaciones para un tour operador hasta 7 días antes de la llegada.',
    relatedTerms: ['Cut-off', 'Attrition', 'Rooming list'],
  },
  {
    term: 'Cut-off',
    definition:
      'Cut-off o fecha límite: fecha anterior a la llegada en la que el hotel libera el inventario no vendido de un cupo o de un bloque de grupo. Pasada la fecha límite, las habitaciones vuelven al fondo común de venta directa.',
    example:
      'Fecha límite de 14 días: el día 15 antes de la llegada el hotel reabsorbe lo no confirmado.',
    relatedTerms: ['Allotment', 'Attrition', 'Stop-sell'],
  },
  {
    term: 'Attrition',
    definition:
      'Attrition o cláusula de ocupación mínima: cláusula contractual que penaliza al grupo o al cliente corporativo cuando ocupa menos habitaciones de las bloqueadas. Suele expresarse como porcentaje mínimo de pickup (habitaciones realmente ocupadas) garantizado.',
    example:
      'Bloque de 100 habitaciones con attrition del 80 %: si solo ocupan 70, pagan las 80.',
    relatedTerms: ['Allotment', 'Cut-off', 'Rooming list'],
  },
  {
    term: 'Rooming list',
    definition:
      'Rooming list o lista de huéspedes: listado nominal de los huéspedes de un grupo con la asignación de habitaciones, el tipo de cama y las peticiones especiales. La envía el organizador antes de la llegada para preparar el check-in del grupo.',
    example:
      'El tour operador envía la rooming list 72 horas antes con 40 nombres y asignaciones.',
    relatedTerms: ['Allotment', 'Attrition', 'PMS'],
  },
  {
    term: 'Channel parity',
    definition:
      'Channel parity o paridad de canales: paridad de precios y condiciones entre todos los canales de distribución. El hotel se compromete a no ofrecer una tarifa pública más baja en un canal que en otro. Es una cláusula típica con las agencias en línea (OTA).',
    example:
      'Si una agencia en línea vende a 120 EUR, la web propia no puede mostrar la tarifa pública a 110 EUR.',
    relatedTerms: ['BAR', 'CRS', 'Stop-sell'],
  },
  {
    term: 'Stop-sell',
    definition:
      'Stop-sell o cierre de venta: cierre temporal de la venta de una tarifa, un tipo de habitación o un canal para fechas concretas. Se usa para proteger el inventario en alta demanda o para forzar la venta de tarifas superiores.',
    example:
      'Cierre de venta de la tarifa no reembolsable el 31 de diciembre para empujar el BAR flexible.',
    relatedTerms: ['BAR', 'Yield', 'Channel parity', 'CRS'],
  },
  {
    term: 'OOO',
    definition:
      'OOO (Out Of Order) o fuera de servicio: habitación bloqueada y excluida del inventario vendible por reforma, daño o mantenimiento prolongado. No genera ingresos ni cuenta para el cálculo de la ocupación comercial.',
    example:
      'Habitación 305 fuera de servicio durante 10 días por reforma del baño.',
    relatedTerms: ['OOS', 'PMS'],
  },
  {
    term: 'OOS',
    definition:
      'OOS (Out Of Service) o bloqueada: habitación temporalmente no vendible por una incidencia menor (limpieza profunda, fallo puntual) que volverá al inventario a corto plazo. Se diferencia de la fuera de servicio (OOO) por su carácter transitorio.',
    example:
      'Habitación 210 bloqueada hasta mañana por cambio de colchón.',
    relatedTerms: ['OOO', 'PMS'],
  },
  {
    term: 'PMS',
    definition:
      'PMS (Property Management System): sistema central que gestiona reservas, check-in, folios, pisos y facturación del hotel. Es el corazón operativo y el sistema de registro de la actividad diaria.',
    example:
      `Opera, Mews o el PMS de ${BRAND.name} centralizan todas las operaciones de recepción.`,
    relatedTerms: ['ERP', 'CRS', 'RMS', 'Folio'],
  },
  {
    term: 'ERP',
    definition:
      'ERP (Enterprise Resource Planning): sistema corporativo que integra finanzas, compras, nóminas e informes de la empresa hotelera. Se conecta con el PMS para consolidar la contabilidad y la administración.',
    example:
      'Un ERP como SAP u Oracle recibe del PMS los asientos diarios de ingresos.',
    relatedTerms: ['PMS', 'GOPPAR', 'ESRS'],
  },
  {
    term: 'CRS',
    definition:
      'CRS (Central Reservation System): sistema que centraliza la disponibilidad y las tarifas para distribuirlas a la web propia, las agencias en línea (OTA) y los GDS. Mantiene la paridad y sincroniza el inventario en tiempo real.',
    example:
      'El CRS envía el BAR y los cierres de venta a Booking, Expedia y al motor propio simultáneamente.',
    relatedTerms: ['PMS', 'Channel parity', 'BAR', 'Stop-sell'],
  },
  {
    term: 'RMS',
    definition:
      'RMS (Revenue Management System): programa que analiza el histórico, la demanda y la competencia para recomendar las tarifas óptimas. Aplica algoritmos de precios dinámicos y de previsión para maximizar el RevPAR.',
    example:
      'El RMS sugiere subir el BAR del sábado un 15 % por el aumento de pickup (ritmo de reservas) detectado.',
    relatedTerms: ['Yield', 'BAR', 'RevPAR', 'CRS'],
  },
  {
    term: 'Folio',
    definition:
      'Cuenta del huésped donde se acumulan todos los cargos de la estancia: habitaciones, restaurante, minibar, extras. Se cierra al check-out generando la factura. Es la unidad contable principal del PMS.',
    example:
      'El folio 4521 acumula 3 noches a 100 EUR más 45 EUR de minibar.',
    relatedTerms: ['Posting', 'Routing', 'Master folio', 'PMS'],
  },
  {
    term: 'Posting',
    definition:
      'Posting o asiento de cargo: acción de cargar un consumo o servicio al folio del huésped. Puede ser manual (recepción carga el minibar) o automática a través de la interfaz del punto de venta. Es la operación básica que alimenta los ingresos.',
    example:
      'El punto de venta del restaurante carga 38 EUR de cena al folio de la habitación 412.',
    relatedTerms: ['Folio', 'Routing', 'PMS'],
  },
  {
    term: 'Routing',
    definition:
      'Routing o enrutamiento: regla que envía cargos específicos a un folio distinto del principal. Útil cuando una empresa paga la habitación pero el huésped paga los extras, o para grupos con folio maestro.',
    example:
      'Enrutamiento: habitación al folio de la empresa, consumos al folio personal del huésped.',
    relatedTerms: ['Folio', 'Master folio', 'Posting'],
  },
  {
    term: 'Master folio',
    definition:
      'Master folio o folio maestro: folio principal de un grupo o evento donde se consolidan los cargos comunes (sala, pausa café, banquete). Los folios individuales de habitación se asocian a él para los informes y la facturación conjunta.',
    example:
      'El folio maestro del congreso recibe la sala y el catering; los folios de huésped solo los extras personales.',
    relatedTerms: ['Folio', 'Routing', 'Rooming list'],
  },
  {
    term: 'ESRS',
    definition:
      'ESRS (European Sustainability Reporting Standards): estándares europeos obligatorios de información de sostenibilidad bajo la directiva CSRD. Exigen al hotel publicar métricas ambientales, sociales y de gobernanza auditables.',
    example:
      'El hotel informa del consumo energético y de las emisiones de alcance 1, 2 y 3 según el ESRS E1.',
    relatedTerms: ['ERP', 'GOPPAR'],
  },
  {
    term: 'VeriFactu',
    definition:
      'Sistema español de facturación verificable de la AEAT. Exige a los programas de facturación registrar cada factura con huella encadenada y código QR para garantizar la trazabilidad, y permite remitirla a la Agencia Tributaria. Obligatorio para empresas a partir de 2027.',
    example:
      'La factura del check-out incluye el QR de VeriFactu y se remite a la AEAT en tiempo real.',
    relatedTerms: ['TBAI', 'SES Hospedajes', 'ERP'],
  },
  {
    term: 'SES Hospedajes',
    definition:
      'Sistema de Entrada de Viajeros del Ministerio del Interior español. Obliga a los hoteles a comunicar los datos de los huéspedes y de la operación de pago en menos de 24 horas desde el registro de entrada.',
    example:
      'Tras el check-in, el PMS envía el documento, las fechas y el medio de pago al portal SES Hospedajes.',
    relatedTerms: ['PMS', 'VeriFactu'],
  },
  {
    term: 'TBAI',
    definition:
      'TicketBAI: sistema antifraude de las Haciendas Forales vascas (Bizkaia, Gipuzkoa, Araba). Obliga a firmar electrónicamente facturas y tiques, encadenarlos y enviarlos a la administración fiscal.',
    example:
      'La factura emitida en un hotel de Bilbao lleva firma TBAI y código TBAI con QR.',
    relatedTerms: ['VeriFactu', 'SES Hospedajes', 'ERP'],
  },
] as const;

function slug(term: string): string {
  return term
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** The glossary as help articles («Glosario» category), searchable by term and definition. */
export function glossaryArticles(): CocoaHelpArticle[] {
  return GLOSSARY.map((entry) => ({
    id: `glosario-${slug(entry.term)}`,
    title: entry.term,
    category: GLOSSARY_CATEGORY,
    tags: ['glosario', entry.term.toLowerCase(), ...entry.relatedTerms.map((term) => term.toLowerCase())],
    bodyMd: [
      `# ${entry.term}`,
      '',
      entry.definition,
      ...(entry.example ? ['', `**Ejemplo:** ${entry.example}`] : []),
      ...(entry.relatedTerms.length > 0 ? ['', `Términos relacionados: ${entry.relatedTerms.join(', ')}.`] : [])
    ].join('\n')
  }));
}

export default GLOSSARY;
export { GLOSSARY };

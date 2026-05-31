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
      'Average Daily Rate. Ingreso medio por habitacion ocupada en un periodo. Se calcula dividiendo el revenue total de habitaciones entre el numero de habitaciones vendidas. Es la metrica base de pricing en hoteleria.',
    example:
      'Si el hotel facturo 50.000 EUR en 500 habitaciones vendidas durante el mes, el ADR fue de 100 EUR.',
    relatedTerms: ['RevPAR', 'GOPPAR', 'BAR', 'Yield'],
  },
  {
    term: 'RevPAR',
    definition:
      'Revenue Per Available Room. Ingreso por habitacion disponible, incluyendo las no vendidas. Se calcula como ADR multiplicado por ocupacion, o revenue total dividido entre habitaciones disponibles. Mide eficiencia comercial real.',
    example:
      'Con ADR de 100 EUR y ocupacion del 80%, el RevPAR es 80 EUR por habitacion disponible.',
    relatedTerms: ['ADR', 'GOPPAR', 'Yield', 'RMS'],
  },
  {
    term: 'GOPPAR',
    definition:
      'Gross Operating Profit Per Available Room. Beneficio operativo bruto por habitacion disponible. Resta costes operativos del revenue total y divide entre inventario disponible. Es la metrica favorita de owners y asset managers.',
    example:
      'Si el GOP del mes fue 30.000 EUR y hubo 1.000 habitaciones disponibles, el GOPPAR es 30 EUR.',
    relatedTerms: ['RevPAR', 'ADR', 'ERP'],
  },
  {
    term: 'BAR',
    definition:
      'Best Available Rate. Mejor tarifa publica disponible para una fecha sin restricciones especiales. Es la tarifa de referencia que ven los huespedes en la web del hotel y OTAs. Suele variar dinamicamente por demanda.',
    example:
      'El BAR del 15 de agosto es 180 EUR; en temporada baja baja a 95 EUR.',
    relatedTerms: ['ADR', 'Yield', 'Stop-sell', 'Channel parity'],
  },
  {
    term: 'Yield',
    definition:
      'Yield management o gestion del rendimiento. Disciplina de ajustar precios y disponibilidad en tiempo real segun demanda, segmento y canal para maximizar revenue. Base del revenue management moderno.',
    example:
      'Subir la BAR un 20% el viernes porque queda solo 30% de inventario y la demanda crece.',
    relatedTerms: ['BAR', 'RevPAR', 'RMS', 'Stop-sell'],
  },
  {
    term: 'Allotment',
    definition:
      'Bloque de habitaciones asignado a un canal, tour operador o agencia bajo contrato. El hotel garantiza disponibilidad hasta una fecha de release o cut-off. Comun en negocio mayorista y grupos.',
    example:
      'Allotment de 20 habitaciones a TUI hasta 7 dias antes de la llegada.',
    relatedTerms: ['Cut-off', 'Attrition', 'Rooming list'],
  },
  {
    term: 'Cut-off',
    definition:
      'Fecha limite antes de la llegada en la que el hotel libera el inventario no vendido de un allotment o bloque grupal. Tras el cut-off, las habitaciones vuelven al pool general de venta directa.',
    example:
      'Cut-off de 14 dias: el dia 15 antes de la llegada el hotel reabsorbe lo no confirmado.',
    relatedTerms: ['Allotment', 'Attrition', 'Stop-sell'],
  },
  {
    term: 'Attrition',
    definition:
      'Clausula contractual que penaliza al grupo o cliente corporativo cuando ocupa menos habitaciones de las bloqueadas. Suele expresarse como porcentaje minimo de pickup garantizado.',
    example:
      'Bloque de 100 habitaciones con attrition del 80%: si solo ocupan 70, pagan las 80.',
    relatedTerms: ['Allotment', 'Cut-off', 'Rooming list'],
  },
  {
    term: 'Rooming list',
    definition:
      'Listado nominal de huespedes de un grupo con asignacion de habitaciones, tipo de cama y peticiones especiales. La envia el organizador antes de la llegada para preparar check-in masivo.',
    example:
      'El tour operador envia rooming list 72h antes con 40 nombres y asignaciones.',
    relatedTerms: ['Allotment', 'Attrition', 'PMS'],
  },
  {
    term: 'Channel parity',
    definition:
      'Paridad de precios y condiciones entre todos los canales de distribucion. El hotel se compromete a no ofrecer tarifa publica mas baja en un canal que en otro. Clausula tipica con OTAs.',
    example:
      'Si Booking vende a 120 EUR, la web propia no puede mostrar publico a 110 EUR.',
    relatedTerms: ['BAR', 'CRS', 'Stop-sell'],
  },
  {
    term: 'Stop-sell',
    definition:
      'Cierre temporal de venta de una tarifa, tipo de habitacion o canal para fechas concretas. Se usa para proteger inventario en alta demanda o forzar venta de tarifas superiores.',
    example:
      'Stop-sell de la tarifa no reembolsable el 31 de diciembre para empujar BAR flexible.',
    relatedTerms: ['BAR', 'Yield', 'Channel parity', 'CRS'],
  },
  {
    term: 'OOO',
    definition:
      'Out Of Order. Habitacion bloqueada y excluida del inventario vendible por reforma, dano o mantenimiento prolongado. No genera ingresos ni cuenta para calculo de ocupacion comercial.',
    example:
      'Habitacion 305 en OOO durante 10 dias por reforma de bano.',
    relatedTerms: ['OOS', 'PMS'],
  },
  {
    term: 'OOS',
    definition:
      'Out Of Service. Habitacion temporalmente no vendible por incidencia menor (limpieza profunda, fallo puntual) pero que volvera al inventario en el corto plazo. Diferente de OOO por su caracter transitorio.',
    example:
      'Habitacion 210 marcada OOS hasta manana por cambio de colchon.',
    relatedTerms: ['OOO', 'PMS'],
  },
  {
    term: 'PMS',
    definition:
      'Property Management System. Sistema central que gestiona reservas, check-in, folios, housekeeping y facturacion del hotel. Es el corazon operativo y el sistema de registro de la actividad diaria.',
    example:
      'Opera, Mews o el PMS de hotelOS centralizan todas las operaciones de front office.',
    relatedTerms: ['ERP', 'CRS', 'RMS', 'Folio'],
  },
  {
    term: 'ERP',
    definition:
      'Enterprise Resource Planning. Sistema corporativo que integra finanzas, compras, nominas y reporting de la empresa hotelera. Se conecta con el PMS para consolidar contabilidad y back office.',
    example:
      'SAP o Oracle ERP recibe del PMS los asientos diarios de revenue.',
    relatedTerms: ['PMS', 'GOPPAR', 'ESRS'],
  },
  {
    term: 'CRS',
    definition:
      'Central Reservation System. Sistema que centraliza disponibilidad y tarifas para distribuirlas a la web propia, OTAs y GDS. Mantiene paridad y sincroniza inventario en tiempo real.',
    example:
      'El CRS empuja BAR y stop-sell a Booking, Expedia y motor propio simultaneamente.',
    relatedTerms: ['PMS', 'Channel parity', 'BAR', 'Stop-sell'],
  },
  {
    term: 'RMS',
    definition:
      'Revenue Management System. Software que analiza historico, demanda y competencia para recomendar tarifas optimas. Aplica algoritmos de pricing dinamico y forecasting para maximizar RevPAR.',
    example:
      'El RMS sugiere subir la BAR del sabado 15% por incremento de pickup detectado.',
    relatedTerms: ['Yield', 'BAR', 'RevPAR', 'CRS'],
  },
  {
    term: 'Folio',
    definition:
      'Cuenta del huesped donde se acumulan todos los cargos de la estancia: habitaciones, restaurante, minibar, extras. Se cierra al check-out generando factura. Es la unidad contable principal del PMS.',
    example:
      'El folio 4521 acumula 3 noches a 100 EUR mas 45 EUR de minibar.',
    relatedTerms: ['Posting', 'Routing', 'Master folio', 'PMS'],
  },
  {
    term: 'Posting',
    definition:
      'Accion de cargar un consumo o servicio al folio del huesped. Puede ser manual (recepcion postea minibar) o automatica via interfaz POS. Es la operacion atomica que alimenta el revenue.',
    example:
      'El POS del restaurante postea 38 EUR de cena al folio de la habitacion 412.',
    relatedTerms: ['Folio', 'Routing', 'PMS'],
  },
  {
    term: 'Routing',
    definition:
      'Regla de enrutamiento que envia cargos especificos a un folio distinto del principal. Util cuando una empresa paga la habitacion pero el huesped paga los extras, o para grupos con master folio.',
    example:
      'Routing: habitacion al folio de la empresa, consumos al folio personal del huesped.',
    relatedTerms: ['Folio', 'Master folio', 'Posting'],
  },
  {
    term: 'Master folio',
    definition:
      'Folio principal de un grupo o evento donde se consolidan cargos comunes (sala, coffee break, banquete). Los folios individuales de habitacion se asocian para reporting unificado y facturacion conjunta.',
    example:
      'Master folio del congreso recibe sala y catering; folios de huesped solo extras personales.',
    relatedTerms: ['Folio', 'Routing', 'Rooming list'],
  },
  {
    term: 'ESRS',
    definition:
      'European Sustainability Reporting Standards. Estandares europeos obligatorios de reporte de sostenibilidad bajo la CSRD. Exigen al hotel publicar metricas ambientales, sociales y de gobernanza auditables.',
    example:
      'El hotel reporta consumo energetico y emisiones de alcance 1, 2 y 3 segun ESRS E1.',
    relatedTerms: ['ERP', 'GOPPAR'],
  },
  {
    term: 'VeriFactu',
    definition:
      'Sistema espanol de facturacion verificable de la AEAT. Exige a software de facturacion enviar o registrar facturas con huella y QR para garantizar trazabilidad. Entra en vigor para empresas en 2026.',
    example:
      'La factura del check-out incluye QR VeriFactu y se remite a la AEAT en tiempo real.',
    relatedTerms: ['TBAI', 'SES Hospedajes', 'ERP'],
  },
  {
    term: 'SES Hospedajes',
    definition:
      'Sistema de Entrada de Viajeros del Ministerio del Interior espanol. Obliga a hoteles a comunicar datos de huespedes y operaciones de pago en menos de 24 horas tras el registro de entrada.',
    example:
      'Tras el check-in, el PMS envia DNI, fechas y medio de pago al portal SES Hospedajes.',
    relatedTerms: ['PMS', 'VeriFactu'],
  },
  {
    term: 'TBAI',
    definition:
      'TicketBAI. Sistema antifraude de las Haciendas Forales vascas (Bizkaia, Gipuzkoa, Araba). Obliga a firmar electronicamente facturas y tickets, encadenarlos y enviarlos a la administracion fiscal.',
    example:
      'La factura emitida en hotel de Bilbao lleva firma TBAI y codigo TBAI con QR.',
    relatedTerms: ['VeriFactu', 'SES Hospedajes', 'ERP'],
  },
] as const;

export default GLOSSARY;
export { GLOSSARY };

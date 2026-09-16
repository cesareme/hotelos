export const TAXES_INSTRUCTIONS = {
  whatIsThis:
    "Tipos de impuesto indirecto (IVA, IGIC o IPSI) que aplica esta propiedad por concepto de folio: alojamiento, restauración, servicios generales, transporte, tasa turística y operaciones no sujetas. Es la fuente que usan el folio, las facturas y el desglose VeriFactu.",
  howToUse: [
    "Comprueba la región fiscal y la figura (IVA/IGIC/IPSI). Si la región se ha derivado de la provincia o es el valor por defecto, confírmala en el perfil del establecimiento.",
    "Revisa el tipo de cada concepto. Los tipos con fuente «catálogo» proceden de la ley vigente; los «manual» los ha fijado tu asesor.",
    "Usa «Editar» para sobrescribir un tipo con fecha de vigencia. El cambio solo afecta a cargos y facturas posteriores.",
    "Si la propiedad está en Ceuta o Melilla, confirma que los tipos del IPSI coinciden con la ordenanza municipal del año."
  ],
  tips: [
    "Sin tipos vigentes para alojamiento, restauración y servicios generales no se puede emitir factura en modo fiscal (bloqueo TAX_NOT_CONFIGURED).",
    "Las facturas ya emitidas son inmutables: un cambio de tipo no las corrige; usa una factura rectificativa."
  ]
};

export const TAX_COMPLIANCE_INSTRUCTIONS = {
  whatIsThis:
    "Configuración fiscal y regulatoria de la propiedad: país, región fiscal, territorio foral, tasa turística, conectores obligatorios (SES.HOSPEDAJES, VeriFactu, TicketBAI, SII, factura electrónica B2B) y datos del establecimiento que exigen el MIR y la AEAT.",
  howToUse: [
    "Guarda país, región fiscal y territorio foral: determinan la figura del impuesto (IVA/IGIC/IPSI) y a qué autoridad se envían las facturas.",
    "Activa solo los conectores que aplican a tu propiedad. El estado real de cada uno (modo, certificado, software) se muestra en las tarjetas.",
    "Completa código postal, código INE y número de registro turístico: SES.HOSPEDAJES los exige para dar de alta el establecimiento.",
    "Revisa los tipos de impuesto en «Impuestos de la propiedad» antes de facturar."
  ]
};

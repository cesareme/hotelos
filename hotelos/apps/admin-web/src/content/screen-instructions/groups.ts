export const GROUPS_INSTRUCTIONS = {
  whatIsThis: 'Gestion de grupos y eventos B2B.',
  howToUse: [
    'Crear el grupo desde la pantalla principal.',
    'Asignar el room block correspondiente al grupo.',
    'Configurar los eventos asociados al grupo.',
    'Generar y mantener actualizada la rooming list.',
    'Definir y controlar la fecha de cut-off del room block.',
  ],
  tips: [
    'Usa NewGroupDialog con 31 campos para crear el grupo completo.',
    'Usa RoomBlockGridDialog para la distribucion de habitaciones del room block.',
  ],
  shortcuts: [
    { keys: '⌘G', description: 'Abrir gestion de grupos.' },
  ],
  relatedScreens: ['Allotments', 'TT.OO.'],
} as const;

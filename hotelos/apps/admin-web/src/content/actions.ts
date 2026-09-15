// Spanish dictionary of common actions, statuses and UI states (Tanda 5 · L1a).
//
// Plan §2.3: «un diccionario ES de acciones … estados vacío/error/carga
// uniformes, confirmación en destructivos, sin jerga técnica ni de roadmap».
// Screens import these instead of typing their own literals so the same verb
// reads the same everywhere (and the contract test for EN literals has one
// place to point at). No anglicisms, no roadmap words («Próximamente»,
// «sandbox», «stub») — those are exactly what this dictionary retires.

export const ACTIONS = {
  save: "Guardar",
  saveChanges: "Guardar cambios",
  cancel: "Cancelar",
  close: "Cerrar",
  confirm: "Confirmar",
  publish: "Publicar",
  revert: "Revertir",
  discard: "Descartar",
  archive: "Archivar",
  unarchive: "Desarchivar",
  delete: "Eliminar",
  remove: "Quitar",
  add: "Añadir",
  create: "Crear",
  edit: "Editar",
  view: "Ver",
  viewDetail: "Ver detalle",
  duplicate: "Duplicar",
  export: "Exportar",
  import: "Importar",
  download: "Descargar",
  print: "Imprimir",
  send: "Enviar",
  resend: "Reenviar",
  search: "Buscar",
  filter: "Filtrar",
  clearFilters: "Limpiar filtros",
  apply: "Aplicar",
  refresh: "Actualizar",
  retry: "Reintentar",
  back: "Volver",
  next: "Siguiente",
  previous: "Anterior",
  finish: "Finalizar",
  select: "Seleccionar",
  selectAll: "Seleccionar todo",
  clearSelection: "Quitar selección",
  activate: "Activar",
  deactivate: "Desactivar",
  enable: "Habilitar",
  disable: "Deshabilitar",
  enableModule: "Activar módulo",
  approve: "Aprobar",
  reject: "Rechazar",
  assign: "Asignar",
  reassign: "Reasignar",
  complete: "Completar",
  reopen: "Reabrir",
  markAsRead: "Marcar como leído",
  copy: "Copiar",
  copyLink: "Copiar enlace",
  share: "Compartir",
  more: "Más",
  moreActions: "Más acciones",
  help: "Ayuda",
  signOut: "Cerrar sesión",
  signIn: "Iniciar sesión"
} as const;

export type ActionKey = keyof typeof ACTIONS;

/** «Nuevo» / «Nueva», optionally with the noun: newLabel("f", "reserva") → "Nueva reserva". */
export function newLabel(gender: "m" | "f", noun?: string): string {
  const base = gender === "f" ? "Nueva" : "Nuevo";
  return noun ? `${base} ${noun}` : base;
}

export const STATUS_LABELS = {
  loading: "Cargando…",
  saving: "Guardando…",
  sending: "Enviando…",
  saved: "Guardado",
  sent: "Enviado",
  noResults: "Sin resultados",
  loadError: "Error al cargar",
  saveError: "No se ha podido guardar",
  offline: "Sin conexión",
  active: "Activo",
  inactive: "Inactivo",
  enabled: "Activado",
  disabled: "Desactivado",
  pending: "Pendiente",
  inProgress: "En curso",
  completed: "Completado",
  cancelled: "Cancelado",
  draft: "Borrador",
  published: "Publicado",
  archived: "Archivado",
  approved: "Aprobado",
  rejected: "Rechazado",
  expired: "Caducado",
  unknown: "Desconocido",
  yes: "Sí",
  no: "No",
  all: "Todos",
  none: "Ninguno",
  optional: "Opcional",
  required: "Obligatorio"
} as const;

export type StatusKey = keyof typeof STATUS_LABELS;

export const TIME_LABELS = {
  today: "Hoy",
  yesterday: "Ayer",
  tomorrow: "Mañana",
  thisWeek: "Esta semana",
  lastWeek: "Semana pasada",
  nextWeek: "Próxima semana",
  thisMonth: "Este mes",
  lastMonth: "Mes pasado",
  thisYear: "Este año",
  lastYear: "Año pasado",
  last7Days: "Últimos 7 días",
  last30Days: "Últimos 30 días",
  last90Days: "Últimos 90 días",
  custom: "Personalizado",
  allTime: "Todo el periodo"
} as const;

export type TimeLabelKey = keyof typeof TIME_LABELS;

/** Column headers and field labels that repeat across tables and forms. */
export const FIELD_LABELS = {
  name: "Nombre",
  description: "Descripción",
  status: "Estado",
  type: "Tipo",
  date: "Fecha",
  from: "Desde",
  to: "Hasta",
  createdAt: "Creado",
  updatedAt: "Actualizado",
  amount: "Importe",
  total: "Total",
  quantity: "Cantidad",
  price: "Precio",
  currency: "Moneda",
  notes: "Notas",
  actions: "Acciones",
  property: "Propiedad",
  room: "Habitación",
  roomType: "Tipo de habitación",
  guest: "Huésped",
  reservation: "Reserva",
  channel: "Canal",
  ratePlan: "Plan de tarifas",
  user: "Usuario",
  role: "Rol",
  email: "Correo electrónico",
  phone: "Teléfono"
} as const;

export type FieldLabelKey = keyof typeof FIELD_LABELS;

/** Visually hidden or `aria-label` texts. */
export const A11Y_LABELS = {
  close: "Cerrar",
  closeDialog: "Cerrar ventana",
  openMenu: "Abrir menú",
  closeMenu: "Cerrar menú",
  loading: "Cargando",
  search: "Buscar",
  moreActions: "Más acciones",
  sections: "Secciones",
  previousPage: "Página anterior",
  nextPage: "Página siguiente",
  sortAscending: "Orden ascendente",
  sortDescending: "Orden descendente",
  selectRow: "Seleccionar fila",
  required: "Obligatorio",
  expand: "Desplegar",
  collapse: "Plegar"
} as const;

export const PAGINATION = {
  previous: "Anterior",
  next: "Siguiente",
  page: (current: number, total: number) => `Página ${current} de ${total}`,
  rows: (from: number, to: number, total: number) => `${from}–${to} de ${total}`,
  perPage: "Por página"
} as const;

/** Copy for a whole-panel state: title, optional explanation and optional call to action. */
export type UiStateCopy = {
  title: string;
  message?: string;
  cta?: string;
};

export const UI_STATES = {
  loading: { title: "Cargando…" },
  empty: { title: "Nada por aquí todavía", message: "Cuando haya datos aparecerán en esta pantalla." },
  noResults: { title: "Sin resultados", message: "Prueba con otros filtros o términos de búsqueda.", cta: ACTIONS.clearFilters },
  error: { title: "Error al cargar", message: "No hemos podido cargar los datos. Inténtalo de nuevo.", cta: ACTIONS.retry },
  saveError: { title: "No se ha podido guardar", message: "Revisa los datos e inténtalo de nuevo.", cta: ACTIONS.retry },
  forbidden: { title: "Sin acceso", message: "Tu perfil no tiene permiso para ver esta pantalla. Pide acceso a dirección." },
  notFound: { title: "No encontrado", message: "Lo que buscas no existe o se ha eliminado.", cta: ACTIONS.back },
  moduleDisabled: {
    title: "Módulo no activado",
    message: "Esta función pertenece a un módulo que no está activo en la propiedad.",
    cta: ACTIONS.enableModule
  },
  noRole: { title: "Sin rol en esta propiedad", message: "Pide a dirección que te asigne un rol para ver el resto del menú." },
  offline: { title: "Sin conexión", message: "Los cambios se enviarán cuando vuelva la conexión." }
} as const satisfies Record<string, UiStateCopy>;

export type UiStateKey = keyof typeof UI_STATES;

/** «Sin reservas» + explanation + optional CTA. Pass the plural noun without article. */
export function emptyStateFor(pluralNoun: string, options: { message?: string; cta?: string } = {}): UiStateCopy {
  return {
    title: `Sin ${pluralNoun}`,
    message: options.message ?? `Aún no hay ${pluralNoun}. Cuando existan aparecerán aquí.`,
    ...(options.cta ? { cta: options.cta } : {})
  };
}

/** «Error al cargar» + «No hemos podido cargar las reservas…». Pass the noun with its article. */
export function errorStateFor(nounWithArticle: string, options: { cta?: string } = {}): UiStateCopy {
  return {
    title: UI_STATES.error.title,
    message: `No hemos podido cargar ${nounWithArticle}. Inténtalo de nuevo.`,
    cta: options.cta ?? ACTIONS.retry
  };
}

/** «Cargando reservas…» */
export function loadingLabel(pluralNoun?: string): string {
  return pluralNoun ? `Cargando ${pluralNoun}…` : STATUS_LABELS.loading;
}

/** Copy of a confirmation dialog; `destructive` styles the confirm button as danger. */
export type ConfirmCopy = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  destructive: boolean;
};

/** confirmDelete("la reserva RS-1024") → «¿Eliminar la reserva RS-1024?» */
export function confirmDelete(itemWithArticle: string, options: { message?: string; confirmLabel?: string } = {}): ConfirmCopy {
  return {
    title: `¿Eliminar ${itemWithArticle}?`,
    message: options.message ?? "Esta acción no se puede deshacer.",
    confirmLabel: options.confirmLabel ?? ACTIONS.delete,
    cancelLabel: ACTIONS.cancel,
    destructive: true
  };
}

/** Leaving a form with unsaved changes. */
export function confirmDiscard(): ConfirmCopy {
  return {
    title: "¿Descartar los cambios?",
    message: "Hay cambios sin guardar que se perderán.",
    confirmLabel: ACTIONS.discard,
    cancelLabel: "Seguir editando",
    destructive: true
  };
}

/** Generic non-destructive confirmation («¿Publicar las tarifas?»). */
export function confirmAction(question: string, confirmLabel: string, message?: string): ConfirmCopy {
  return {
    title: question,
    message: message ?? "",
    confirmLabel,
    cancelLabel: ACTIONS.cancel,
    destructive: false
  };
}

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
  signIn: "Iniciar sesión",
  // Cocoa 22 · ola 2
  escalate: "Escalar",
  assignToMe: "Asignar a mí",
  // Tanda UX-1 · U7 (§4.2 deshacer antes que confirmar): la acción del toast y de la barra de deshacer.
  undo: "Deshacer"
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
  required: "Obligatorio",
  // Cocoa 22 · ola 2
  failed: "Fallido"
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

// ---------------------------------------------------------------------------
// Recepción · Mi día, cola y cajones rápidos (Tanda UX-1 · lote U6 ·
// docs/design/UX-RECEPCION-FEEL.md §4 «Copy de acciones y estados»). Todo CTA,
// pestaña y toast nuevo de §5.1-5.4 y §5.12 vive aquí como plantilla con
// importe o recuento (0 literales de acción nuevos dentro de screens/). El
// importe llega ya formateado por lib/format (`money`), nunca se formatea aquí.
// ---------------------------------------------------------------------------

export const FRONT_DESK_ACTIONS = {
  // Acción primaria contextual por fila (§5.1, `primaryActionFor`).
  checkIn: "Hacer check-in",
  /** «Check-in en 118»: la habitación sugerida (sin asignar) ya preseleccionada. */
  checkInTo: (room: string) => `Check-in en ${room}`,
  /** «Cobrar 120,00 € y hacer check-in»: el CTA del cajón dice lo que hará. */
  collectAndCheckIn: (amount: string) => `Cobrar ${amount} y hacer check-in`,
  checkOut: "Hacer check-out",
  /** «Cobrar 120,00 € y cerrar»: salida con saldo desde la fila o el cajón. */
  collectAndClose: (amount: string) => `Cobrar ${amount} y cerrar`,
  leaveWithBalance: "Salir con saldo pendiente",
  collect: (amount: string) => `Cobrar ${amount}`,
  noCharge: "Sin cobro",
  issueInvoice: "Emitir factura",
  openReservation: "Abrir ficha",
  openFullReservation: "Abrir ficha completa",
  viewFolio: "Ver folio",
  assignRoom: "Asignar habitación",
  assignRoomNumber: (room: string) => `Asignar la ${room}`,
  changeRoom: "Cambiar habitación",
  changeRoomTo: (room: string) => `Cambiar a la ${room}`,
  markNoShow: "Marcar no-show…",
  /** Botón nominal del diálogo (§4.2): «Marcar no-show (penalización 89,00 €)». */
  markNoShowWithPenalty: (amount: string | null) => (amount ? `Marcar no-show (penalización ${amount})` : "Marcar no-show (sin penalización)"),
  cancelWithPenalty: (amount: string | null) => (amount ? `Cancelar la reserva (penalización ${amount})` : "Cancelar la reserva (sin penalización)"),
  keepReservation: "Mantener la reserva",
  overrideCheckIn: "Hacer check-in igualmente",
  // Walk-in (§5.3).
  walkIn: "Walk-in",
  createOnly: "Solo crear reserva",
  createAndCheckIn: "Crear y hacer check-in",
  // Lote (§5.1 (3), F25).
  batchCheckOut: (count: number) => `Check-out de ${count} con saldo 0`,
  /** Botón nominal de «no» del diálogo del lote de check-outs (UX1-REV-01). */
  reviewSelection: "Revisar la selección",
  printCards: (count: number) => `Imprimir ${count} ${count === 1 ? "ficha" : "fichas"}`,
  batchAssign: (count: number) => `Asignar habitación a ${count}`,
  cancelRest: "Cancelar el resto",
  // Turno (§5.12).
  cashClosure: "Arqueo de caja",
  closeDay: "Cerrar el día",
  // Buscador de Mi día (§5.1 (6)).
  searchPlaceholder: "Buscar por nombre o habitación…"
} as const;

/** Toasts de recepción: dicen qué pasó y con qué número (P7), nunca «solicitado» a secas. */
export const FRONT_DESK_TOASTS = {
  checkInDone: (room: string | null) => (room ? `Check-in de la ${room} hecho` : "Check-in hecho"),
  checkInDoneSes: (room: string | null, queued: number) => `${FRONT_DESK_TOASTS.checkInDone(room)} · parte enviado a SES (${queued})`,
  checkOutDone: (room: string | null) => (room ? `Check-out de la ${room} hecho` : "Check-out hecho"),
  invoiceIssued: (invoiceNumber: string) => `Factura ${invoiceNumber} emitida`,
  /** POST /folios/:id/invoice crea un BORRADOR (sin número): lo emite Facturación, salvo «Emitir ahora». */
  invoiceDrafted: "Borrador de factura creado: emítela desde Facturación",
  invoiceFailed: "Check-out hecho, pero la factura no se pudo emitir. Emítela desde Facturación.",
  roomAssigned: (room: string) => `Habitación ${room} asignada`,
  roomChanged: (from: string, to: string) => `Cambio de la ${from} a la ${to}`,
  /** Confirmación del deshacer de un traslado (L-11 (c)). */
  roomChangeUndone: (room: string) => `Cambio deshecho: el huésped sigue en la ${room}`,
  reservationCreated: (code: string) => `Reserva ${code} creada`,
  walkInDone: (code: string, room: string | null) => `Walk-in ${code}${room ? ` en la ${room}` : ""}: check-in hecho`,
  batchCheckOutSummary: (done: number, failed: number) => `${done} check-out${done === 1 ? "" : "s"} ${done === 1 ? "hecho" : "hechos"}${failed > 0 ? ` · ${failed} sin hacer` : ""}`,
  batchAssignSummary: (done: number, failed: number) => `${done} ${done === 1 ? "habitación asignada" : "habitaciones asignadas"}${failed > 0 ? ` · ${failed} sin asignar` : ""}`,
  batchCancelled: (done: number, total: number) => `Lote cancelado: ${done} de ${total}`
} as const;

/** Frases informativas de los cajones (honestidad, D6 / F18). */
export const FRONT_DESK_NOTES = {
  roomWillBeDirty: "La habitación pasará a sucia.",
  roomNotClean: "La habitación no está lista.",
  overrideReasonLabel: "Motivo del check-in con la habitación sin limpiar",
  invoiceTo: "Factura a",
  invoiceGuest: "Huésped",
  invoiceCompany: "Empresa",
  /** Qué pasa con la factura al cerrar: borrador para Facturación (hoy), emitida ahora con número (irreversible: VeriFactu) o nada. */
  invoiceDraft: "Borrador para Facturación",
  invoiceIssueNow: "Emitir ahora con número",
  invoiceNone: "Sin factura",
  taxId: "NIF",
  companyName: "Razón social"
} as const;

// ---------------------------------------------------------------------------
// Ficha de reserva y cobro (Tanda UX-1 · lote U7 · docs/design/UX-RECEPCION-FEEL.md
// §5.5-5.6, F7 F8 F13 F14 F20): barra de comandos, cambio de habitación de
// alojados, fechas con aritmética, cargo y nota con deshacer, factura desde la
// reserva. Plantillas con importe o recuento; el importe llega formateado.
// ---------------------------------------------------------------------------

export const RESERVATION_ACTIONS = {
  /** Menú «Más ▾» de la barra de comandos (destructivos y secundarios, P1). */
  more: "Más",
  cancelReservation: "Cancelar reserva…",
  markNoShow: "Marcar no-show…",
  blockRoom: (room: string) => `Bloquear la ${room}…`,
  /** Botones nominales del diálogo de bloqueo (§4.2: afecta al inventario). */
  blockRoomConfirm: (room: string) => `Bloquear la ${room}`,
  keepRoomOnSale: "Mantenerla en venta",
  refund: "Devolver",
  backToReservations: "Volver a reservas",
  // Cambio de habitación (F7): confirmadas y alojadas.
  changeRoom: FRONT_DESK_ACTIONS.changeRoom,
  assignRoom: FRONT_DESK_ACTIONS.assignRoom,
  moveTo: (room: string) => `Mover a la ${room}`,
  // Fechas (F8).
  plusNight: "+1 noche",
  minusNight: "−1 noche",
  applyDatesAndPrice: (total: string) => `Aplicar fechas y nuevo total ${total}`,
  keepDates: "Mantener las fechas",
  // Cargo y nota (F13).
  addCharge: "Añadir cargo",
  saveNote: "Guardar nota",
  // Documentos (F14).
  invoiceToGuest: "Factura a huésped",
  invoiceToCompany: "Factura a empresa",
  issueInvoice: FRONT_DESK_ACTIONS.issueInvoice,
  createDraft: "Crear borrador",
  issueWithNumber: "Emitir con número"
} as const;

/** Toasts de la ficha: qué pasó y con qué número (P7); los reversibles llevan «Deshacer». */
export const RESERVATION_TOASTS = {
  chargeAdded: (amount: string) => `Cargo de ${amount} añadido al folio`,
  chargeUndone: (amount: string) => `Cargo de ${amount} deshecho: no se ha enviado`,
  chargeFailed: "No se pudo añadir el cargo",
  noteSaved: "Nota guardada",
  noteRestored: "Nota anterior restaurada",
  datesChanged: (range: string, nights: number) => `Estancia ${range} · ${nights} ${nights === 1 ? "noche" : "noches"}`,
  datesRestored: (range: string) => `Fechas anteriores restauradas (${range})`,
  datesLocked: "Con el huésped alojado solo se puede cambiar de habitación; la estancia se ajusta al hacer el check-out.",
  quoteUnavailable: "Fechas cambiadas sin recotizar: el total se mantiene.",
  roomBlocked: (room: string) => `Habitación ${room} bloqueada (fuera de venta)`,
  checkInDone: FRONT_DESK_TOASTS.checkInDone,
  checkOutDone: FRONT_DESK_TOASTS.checkOutDone,
  checkOutWithBalance: "Check-out registrado con saldo pendiente",
  paymentClosed: (room: string | null) => `Cobro registrado y ${room ? `check-out de la ${room} hecho` : "check-out hecho"}`
} as const;

/** Ayudas y notas de la ficha (honestidad, P7). */
export const RESERVATION_NOTES = {
  datesArithmetic: "Admite «+7», «−1», «hoy» o «mañana» y confirma con Intro.",
  chargeAmount: "Precio bruto, con impuestos. Intro añade el cargo.",
  roomPickerHelp: "Limpias, libres y sin otra reserva: primero las del mismo tipo. Intro confirma.",
  roomPickerEmpty: "Sin habitaciones limpias y libres para estas fechas.",
  noteHelp: "Visible para recepción; queda en la reserva.",
  noteLocked: "Con el huésped alojado el API no admite cambios en la reserva salvo la habitación.",
  invoiceIssueHelp: "Se emite con número ahora (irreversible: entra en la cadena VeriFactu).",
  invoiceDraftHelp: "Queda como borrador con los cargos del folio; Facturación la emite.",
  invoiceTaxIdRemembered: "Recordado de la última factura a este nombre.",
  invoiceGuestTaxIdHelp: "Documento del huésped principal; opcional en factura simplificada."
} as const;

// ---------------------------------------------------------------------------
// Nueva reserva · modo rápido y completo (Tanda UX-1 · lote U9a ·
// docs/design/UX-RECEPCION-FEEL.md §5.10, F12, F33, 3.3.7). Los CTA «Crear y…»
// encadenan el cobro del depósito (PaymentDialog) o el check-in (runner de U6);
// el importe llega formateado por lib/format (`money`).
// ---------------------------------------------------------------------------

export const RESERVATION_CREATE_ACTIONS = {
  /** Conmutador de la cabecera (`?modo=rapida|completa`; rápida por defecto). */
  quickMode: "Rápida",
  fullMode: "Completa",
  create: "Crear reserva",
  createAndDeposit: "Crear y cobrar depósito",
  createAndCheckIn: FRONT_DESK_ACTIONS.createAndCheckIn,
  /** Último paso del modo completo (los seis pasos se conservan para grupos, pagos complejos y solicitudes). */
  confirmAndCreate: "Confirmar y crear reserva",
  checkAvailability: "Consultar disponibilidad",
  /** Sugerencia de huésped existente (3.3.7): aplica su ficha al formulario. */
  useGuest: "Usar sus datos",
  dismissGuest: "No es esta persona",
  plusNight: RESERVATION_ACTIONS.plusNight,
  minusNight: RESERVATION_ACTIONS.minusNight
} as const;

/** Toasts de Nueva reserva: qué pasó y con qué número (P7). */
export const RESERVATION_CREATE_TOASTS = {
  created: (code: string, amount: string) => `${FRONT_DESK_TOASTS.reservationCreated(code)} · ${amount}`,
  depositCollected: (amount: string, code: string) => `Depósito de ${amount} cobrado en ${code}`,
  createdAndCheckedIn: (code: string, room: string | null) => `Reserva ${code} creada${room ? ` · check-in en la ${room} hecho` : " · check-in hecho"}`,
  guestApplied: (name: string) => `Datos de ${name} aplicados`,
  guestPrefilled: (name: string) => `Reserva para ${name}: datos de la ficha ya rellenos`
} as const;

/** Ayudas y estados del modo rápido (honestidad, P7): precio en vivo, huésped sugerido, empresa. */
export const RESERVATION_CREATE_NOTES = {
  /** «89,00 €/noche · 4 libres» (el precio va formateado). */
  livePrice: (nightly: string, available: number) => `${nightly}/noche · ${available === 1 ? "1 libre" : `${available} libres`}`,
  quoting: "Cotizando…",
  noAvailability: "Sin disponibilidad para esas fechas y ocupación.",
  fillerPrice: "Precio de relleno: alguna noche no tiene tarifa publicada. Indica el importe total para poder crear la reserva.",
  /** Llegada anterior a hoy (corrector L-02): bloquea «Crear…»; el API responde 400 PAST_ARRIVAL_DATE. */
  pastArrival: "La llegada es anterior a hoy.",
  /** Cotización sin tarifa publicada o a 0 € sin importe manual (L-02): nunca una reserva a 0 € sin quererlo. */
  priceRequired: "Sin tarifa publicada para esas noches: indica el importe total.",
  quoteError: (message: string) => `Sin precio en vivo: ${message}`,
  requiredGuest: "Lo mínimo: nombre y apellido. Teléfono y correo son opcionales.",
  guestSuggestion: (name: string) => `¿Es ${name}? Ya tiene ficha: sus datos se pueden aplicar sin volver a teclearlos.`,
  guestPrefilled: (name: string) => `Huésped ${name}: nombre, contacto y documento tomados de su ficha.`,
  companyInvoice: "Con razón social, la factura irá a la empresa (instrucción de cobro «Factura a empresa»). El NIF se recuerda para la factura.",
  totalFromRate: "Sin importe manual, la reserva toma el precio de la tarifa publicada.",
  checkInNeedsToday: "Solo para llegadas de hoy.",
  checkInNeedsRoom: "Sin habitación limpia y libre del tipo elegido: crea la reserva y haz el check-in desde la ficha.",
  depositDefault: "El importe por defecto es el total de la estancia; cámbialo en el diálogo de cobro.",
  fullModeHint: "Grupos, acompañantes, identidad (SES), pagos y solicitudes: en «Completa»."
} as const;

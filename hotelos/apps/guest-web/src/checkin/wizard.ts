// Asistente de pre-check-in del portal del huésped (Tanda CHK · lote W4-C;
// diseño docs/design/CHECKIN-AUTOMATIZADO-IA.md §4a pasos 3-9, §4c columna
// «Móvil del huésped», §8 fila «Portal del huésped»).
//
// Módulo PURO (sin React ni DOM): guest-web no tiene typecheck real (SKIP sin
// @types/react), así que toda la lógica del asistente vive aquí y la cubre
// __tests__/wizard.test.mts con node --test. Las páginas .tsx solo pintan.
//
// Seis pasos: Viajeros → Documento → Datos → Firma → Pago y extras → Llegada.
// El servidor manda: `canAdvance` refleja el DTO de GET /guest-portal/check-in
// (CheckInSessionDto + policy + steps, packages/shared/src/checkin-types.ts) y
// `missingFor` solo puede mirar los campos visibles en el DTO (sin PII: ni
// número completo, ni dirección, ni correo); la lista autoritativa de faltas es
// la que devuelven PATCH …/guests/:id (`missing`) y POST …/complete
// (409 CHECKIN_INCOMPLETE { missing }), que las páginas fusionan con mergeMissing.
//
// Copy en español e inglés dentro de este fichero (COPY): sin i18n nueva; el
// test comprueba la paridad de claves entre los dos idiomas. Desde Tanda L7
// (L7-01) también lleva el copy de las páginas fuera del asistente (sesión,
// estancia, pre-check-in clásico, peticiones, cabecera): español por defecto.

export const WIZARD_STEPS = ["travellers", "document", "details", "signature", "payment", "arrival"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export type Lang = "es" | "en";

/** RD 933/2021: menores de 14 años no firman; los declara un adulto de la reserva. */
export const MINOR_AGE = 14;

/** Imagen del documento: el API acota el decodificado a CHECKIN_DOCUMENT_MAX_BYTES (6 MiB). */
export const MAX_DOCUMENT_BYTES = 6 * 1024 * 1024;

export const SETTLED_PAYMENT_STATUSES = ["paid", "authorized", "at_reception"] as const;
export const SIGNED_GUEST_STATUSES = ["signed", "verified"] as const;
export const COMPLETE_GUEST_STATUSES = ["data_complete", "signed", "verified"] as const;
export const ARRIVED_SESSION_STATUSES = ["arrived", "checked_in", "handed_off"] as const;

// ---------------------------------------------------------------------------
// Tipos (espejo estructural de los DTO del API; sin PII)
// ---------------------------------------------------------------------------

export type WizardGuest = {
  id: string;
  isPrimary: boolean;
  ordinal: number;
  status: string;
  guestRegisterRecordId: string | null;
  ageAtArrival: number | null;
  isMinor: boolean;
  providedByCheckInGuestId: string | null;
  kinship: string | null;
  guardianTitle: string | null;
  identityVerificationMethod: string | null;
  identityVerifiedAt: string | null;
  firstName: string | null;
  surname1: string | null;
  surname2: string | null;
  nationality: string | null;
  documentType: string | null;
  documentNumberLast3: string | null;
  hasEmail: boolean;
  hasPhoneMobile: boolean;
};

export type WizardPolicy = {
  selfCheckInEnabled: boolean;
  allowedVerificationMethods: string[];
  requireVisualCheckAtKiosk: boolean;
  depositPolicy: string;
};

export type WizardConsent = {
  gdprAt: string | null;
  aiDisclosureAt: string | null;
  marketing: boolean;
  whatsappOptInAt: string | null;
};

export type WizardOffer = { id: string; title: string; price?: number | null; currency?: string | null };

export type WizardSession = {
  id: string;
  reservationId: string;
  propertyId: string;
  status: string;
  paymentStatus: string;
  etaDeclared: string | null;
  preferences: string[];
  consent: WizardConsent;
  guests: WizardGuest[];
  policy: WizardPolicy;
  /** Saldo de la reserva (GET /guest-portal/reservation); undefined si aún no se conoce. */
  balanceDue?: number;
  /** adults + children de la reserva (límite de viajeros del pre-check-in). */
  guestCapacity?: number;
  /** Ofertas de upsell; si no hay, el bloque «extras» del paso de pago no se pinta. */
  offers?: WizardOffer[];
};

// ---------------------------------------------------------------------------
// Pasos y progreso
// ---------------------------------------------------------------------------

export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step);
}

export function progressFor(step: WizardStep): { index: number; total: number; percent: number } {
  const index = stepIndex(step) + 1;
  const total = WIZARD_STEPS.length;
  return { index, total, percent: Math.round((index / total) * 100) };
}

/** Paso siguiente (null al final). La sesión ya alojada salta directamente a la llegada. */
export function nextStep(step: WizardStep, session?: Pick<WizardSession, "status"> | null): WizardStep | null {
  if (session && (ARRIVED_SESSION_STATUSES as readonly string[]).includes(session.status)) return step === "arrival" ? null : "arrival";
  const index = stepIndex(step);
  if (index < 0 || index >= WIZARD_STEPS.length - 1) return null;
  return WIZARD_STEPS[index + 1] ?? null;
}

export function prevStep(step: WizardStep): WizardStep | null {
  const index = stepIndex(step);
  return index > 0 ? (WIZARD_STEPS[index - 1] ?? null) : null;
}

function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

export function isSigned(guest: Pick<WizardGuest, "status">): boolean {
  return (SIGNED_GUEST_STATUSES as readonly string[]).includes(guest.status);
}

export function isDataComplete(guest: Pick<WizardGuest, "status">): boolean {
  return (COMPLETE_GUEST_STATUSES as readonly string[]).includes(guest.status);
}

export function hasDocument(guest: Pick<WizardGuest, "documentType" | "documentNumberLast3">): boolean {
  return hasText(guest.documentType) && hasText(guest.documentNumberLast3);
}

/** Viajeros que firman: adultos y menores de 14-17 años (los < 14 no firman). */
export function signersOf(session: Pick<WizardSession, "guests">): WizardGuest[] {
  return session.guests.filter((guest) => !guest.isMinor);
}

export function pendingSigners(session: Pick<WizardSession, "guests">): WizardGuest[] {
  return signersOf(session).filter((guest) => !isSigned(guest));
}

export function paymentSettled(session: Pick<WizardSession, "paymentStatus" | "balanceDue">): boolean {
  if ((SETTLED_PAYMENT_STATUSES as readonly string[]).includes(session.paymentStatus)) return true;
  return typeof session.balanceDue === "number" && session.balanceDue <= 0.005;
}

/**
 * ¿Se puede pasar del paso `step`? Solo con lo visible en el DTO: el servidor
 * confirma al cerrar (409 CHECKIN_INCOMPLETE) y al llegar (409 *).
 */
export function canAdvance(session: WizardSession, step: WizardStep): boolean {
  const guests = session.guests;
  switch (step) {
    case "travellers":
      return guests.length > 0 && guests.every((guest) => hasText(guest.firstName) && hasText(guest.surname1));
    case "document":
      return guests.length > 0 && guests.every(hasDocument);
    case "details":
      return guests.length > 0 && guests.every(isDataComplete) && hasText(session.consent.gdprAt);
    case "signature":
      return guests.length > 0 && guests.every((guest) => hasText(guest.guestRegisterRecordId)) && pendingSigners(session).length === 0;
    case "payment":
      return paymentSettled(session);
    case "arrival":
      return session.status === "checked_in";
    default:
      return false;
  }
}

/** Paso por el que se reanuda el asistente: el primero sin completar (o la llegada). */
export function initialStep(session: WizardSession): WizardStep {
  if ((ARRIVED_SESSION_STATUSES as readonly string[]).includes(session.status)) return "arrival";
  for (const step of WIZARD_STEPS) {
    if (step === "arrival") break;
    if (!canAdvance(session, step)) return step;
  }
  return "arrival";
}

// ---------------------------------------------------------------------------
// Datos que faltan
// ---------------------------------------------------------------------------

export const MISSING_KEYS = [
  "firstName",
  "surname1",
  "nationality",
  "dateOfBirth",
  "documentType",
  "documentNumber",
  "contact",
  "providedByCheckInGuestId",
  "kinship"
] as const;
export type MissingKey = (typeof MISSING_KEYS)[number];

/** Faltas deducibles del DTO (sin PII). La dirección y el resto las dice el servidor. */
export function missingFor(guest: WizardGuest): MissingKey[] {
  const missing: MissingKey[] = [];
  if (!hasText(guest.firstName)) missing.push("firstName");
  if (!hasText(guest.surname1)) missing.push("surname1");
  if (!hasText(guest.nationality)) missing.push("nationality");
  if (guest.ageAtArrival === null) missing.push("dateOfBirth");
  if (!hasText(guest.documentType)) missing.push("documentType");
  if (!hasText(guest.documentNumberLast3)) missing.push("documentNumber");
  if (!guest.hasEmail && !guest.hasPhoneMobile) missing.push("contact");
  if (guest.isMinor) {
    if (!hasText(guest.providedByCheckInGuestId)) missing.push("providedByCheckInGuestId");
    if (!hasText(guest.kinship)) missing.push("kinship");
  }
  return missing;
}

/** Unión ordenada y sin duplicados de las faltas locales y las del servidor. */
export function mergeMissing(local: readonly string[], server: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const key of [...local, ...(server ?? [])]) {
    const trimmed = String(key ?? "").trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/** Adultos de la sesión que pueden declarar a un menor (nunca el propio menor). */
export function adultsFor(session: Pick<WizardSession, "guests">, minorId: string | null): WizardGuest[] {
  return session.guests.filter((guest) => !guest.isMinor && guest.id !== minorId && guest.ageAtArrival !== null && guest.ageAtArrival >= 18);
}

/** ¿Puede añadirse otro viajero? (adults + children de la reserva) */
export function canAddGuest(session: Pick<WizardSession, "guests" | "guestCapacity">): boolean {
  if (typeof session.guestCapacity !== "number") return true;
  return session.guests.length < Math.max(1, session.guestCapacity);
}

// ---------------------------------------------------------------------------
// Edad y menores
// ---------------------------------------------------------------------------

function parseIsoDay(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Años cumplidos en la fecha `at` (null si alguna fecha no es válida). */
export function ageAt(dateOfBirth: string | Date | null | undefined, at: string | Date): number | null {
  const born = parseIsoDay(dateOfBirth);
  const when = parseIsoDay(at);
  if (!born || !when || born.getTime() > when.getTime()) return null;
  let age = when.getUTCFullYear() - born.getUTCFullYear();
  const beforeBirthday = when.getUTCMonth() < born.getUTCMonth() || (when.getUTCMonth() === born.getUTCMonth() && when.getUTCDate() < born.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

/** Menor de 14 años a la llegada (sin firma; datos aportados por un adulto). Sin fecha → false. */
export function isMinorAt(dateOfBirth: string | Date | null | undefined, arrivalDate: string | Date): boolean {
  const age = ageAt(dateOfBirth, arrivalDate);
  return age !== null && age < MINOR_AGE;
}

// ---------------------------------------------------------------------------
// MRZ (lector hardware, pegado manual u OCR)
// ---------------------------------------------------------------------------

export const MRZ_LINE_LENGTHS: Record<"TD1" | "TD2" | "TD3", { lines: number; length: number }> = {
  TD1: { lines: 3, length: 30 },
  TD2: { lines: 2, length: 36 },
  TD3: { lines: 2, length: 44 }
};

/**
 * Normaliza el texto de una MRZ: mayúsculas, sin espacios (los rellenos son `<`),
 * una línea por elemento; un bloque sin saltos se parte por la longitud del
 * formato (90 → TD1 3×30, 72 → TD2 2×36, 88 → TD3 2×44).
 */
export function normalizeMrzText(text: string): string[] {
  const rawLines = String(text ?? "")
    .toUpperCase()
    .split(/\r?\n|\r/)
    .map((line) => line.trim().replace(/[\s_]/g, "<").replace(/[^A-Z0-9<]/g, ""))
    .filter((line) => line.length > 0);
  if (rawLines.length === 1) {
    const single = rawLines[0]!;
    for (const format of ["TD1", "TD2", "TD3"] as const) {
      const spec = MRZ_LINE_LENGTHS[format];
      if (single.length === spec.lines * spec.length) {
        const out: string[] = [];
        for (let index = 0; index < spec.lines; index += 1) out.push(single.slice(index * spec.length, (index + 1) * spec.length));
        return out;
      }
    }
  }
  return rawLines;
}

/** Formato ICAO 9303 por número y longitud de líneas (null si no cuadra). */
export function mrzFormatOf(lines: readonly string[]): "TD1" | "TD2" | "TD3" | null {
  for (const format of ["TD1", "TD2", "TD3"] as const) {
    const spec = MRZ_LINE_LENGTHS[format];
    if (lines.length === spec.lines && lines.every((line) => line.length === spec.length)) return format;
  }
  return null;
}

/** ¿Tiene pinta de MRZ? (2-3 líneas de 30/36/44 caracteres válidos) */
export function looksLikeMrz(lines: readonly string[]): boolean {
  return mrzFormatOf(lines) !== null && lines.every((line) => /^[A-Z0-9<]+$/.test(line));
}

/** Tamaño aproximado en bytes del contenido de una `data:` URL base64. */
export function dataUrlByteSize(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return 0;
  const payload = dataUrl.slice(comma + 1);
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

export function isImageDataUrl(value: string): boolean {
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
}

// ---------------------------------------------------------------------------
// Idioma y copy (es/en) — sin i18n nueva
// ---------------------------------------------------------------------------

export function pickLanguage(navigatorLanguage: string | null | undefined): Lang {
  const value = String(navigatorLanguage ?? "").trim().toLowerCase();
  return value === "" || value.startsWith("es") || value.startsWith("gl") || value.startsWith("ca") || value.startsWith("eu") ? "es" : "en";
}

const COPY_ES = {
  wizardEyebrow: "Pre-check-in",
  wizardTitle: "Tu llegada, sin esperas",
  wizardSubtitle: "Seis pasos rápidos desde el móvil. Puedes retomarlos cuando quieras.",
  stepTravellers: "Viajeros",
  stepDocument: "Documento",
  stepDetails: "Datos",
  stepSignature: "Firma",
  stepPayment: "Pago y extras",
  stepArrival: "Llegada",
  stepOf: "Paso {index} de {total}",
  back: "Atrás",
  next: "Continuar",
  backToStay: "Volver a mi estancia",
  loading: "Cargando tu pre-check-in…",
  saving: "Guardando…",
  retry: "Reintentar",
  notInvited: "Este enlace no tiene un pre-check-in abierto. Pide a recepción una nueva invitación.",
  travellersIntro: "Indica quién viaja. Los menores de 14 años los declara un adulto de la reserva.",
  travellerPrimary: "Titular",
  travellerCompanion: "Acompañante {n}",
  travellerMinor: "Menor",
  addTraveller: "Añadir viajero",
  removeTraveller: "Quitar",
  capacityReached: "La reserva ya tiene todos los viajeros declarados.",
  firstName: "Nombre",
  surname1: "Primer apellido",
  surname2: "Segundo apellido",
  documentIntro: "Haz una foto del documento de cada viajero. La imagen se lee y se descarta: no se guarda.",
  documentFor: "Documento de {name}",
  documentDone: "Documento leído · termina en {last3}",
  documentReread: "Volver a leer el documento",
  documentRereadHint: "Si el número no es el tuyo o quieres leerlo con la cámara o la MRZ, léelo de nuevo.",
  documentRereadCancel: "Mantener el documento actual",
  documentSourceProfile: "datos de tu perfil (sin leer el documento)",
  documentMismatch: "El nombre del documento no coincide con ningún viajero de la reserva: no se ha aplicado. Recepción lo cotejará a tu llegada; puedes leer otro documento.",
  chatTitle: "Recepción por chat",
  chatIntro: "Pregunta por la llegada, la salida tardía, el desayuno o pide algo para tu estancia.",
  chatDisclosure: "Te responde un asistente automático de {property}; una persona de recepción revisa cualquier cambio.",
  chatPlaceholder: "Escribe tu mensaje…",
  chatSend: "Enviar",
  chatSending: "Enviando…",
  chatHandoff: "Lo pasamos a una persona de recepción.",
  chatPending: "Pendiente de confirmar por recepción.",
  chatUpdated: "Hecho: tu reserva se ha actualizado.",
  chatIdentify: "Para ayudarte con tu reserva, abre el chat desde tu enlace de check-in.",
  chatDisabled: "El asistente no está disponible ahora; llama a recepción.",
  chatError: "No se pudo enviar el mensaje. Inténtalo de nuevo.",
  documentType: "Tipo de documento",
  docPassport: "Pasaporte",
  docDni: "DNI",
  docTie: "TIE / NIE",
  docOther: "Otro documento",
  takePhoto: "Hacer foto",
  useCamera: "Usar la cámara",
  capture: "Capturar",
  cancel: "Cancelar",
  processing: "Leyendo el documento…",
  pasteMrz: "O pega las líneas de la MRZ (lector o teclado)",
  mrzPlaceholder: "P<ESPAPELLIDO<<NOMBRE<<<<…",
  sendMrz: "Leer la MRZ",
  documentUnreadable: "No hemos podido leer el documento. Prueba con más luz o pega las líneas de la MRZ.",
  imageTooLarge: "La imagen supera los 6 MB. Haz otra foto con menos resolución.",
  cameraUnavailable: "No se puede abrir la cámara en este dispositivo; usa «Hacer foto».",
  sourceMrz: "leído de la MRZ",
  sourceAi: "leído por visión",
  sourceManual: "introducido por el huésped",
  confidence: "confianza {pct} %",
  detailsIntro: "Completa lo que el documento no trae. Solo lo exige el registro de viajeros (RD 933/2021).",
  sex: "Sexo",
  sexH: "Hombre",
  sexM: "Mujer",
  sexO: "Otro",
  nationality: "Nacionalidad (código ISO, p. ej. ESP)",
  dateOfBirth: "Fecha de nacimiento",
  documentNumber: "Número de documento",
  documentSupportNumber: "Número de soporte (DNI/TIE)",
  documentExpiryDate: "Caducidad del documento",
  email: "Correo electrónico",
  phoneMobile: "Móvil (con prefijo, p. ej. +34…)",
  residenceFullAddress: "Dirección completa",
  residenceLocality: "Localidad",
  residenceCountry: "País de residencia (código ISO)",
  minorGuardian: "Adulto que declara al menor",
  kinship: "Parentesco",
  guardianTitle: "Cargo del tutor (si no es progenitor)",
  chooseAdult: "Elige un adulto",
  missingTitle: "Faltan datos",
  missingContact: "correo o móvil",
  consentGdpr: "He leído el tratamiento de mis datos para el registro de viajeros (obligatorio).",
  consentAi: "Entiendo que un asistente automático puede leer mi documento y responder mis mensajes.",
  consentMarketing: "Quiero recibir ofertas del hotel (opcional).",
  consentWhatsapp: "Acepto recibir mensajes por WhatsApp (opcional).",
  saveTraveller: "Guardar",
  signatureIntro: "Firma el parte de viajeros. Los menores de 14 años no firman.",
  signatureFor: "Firma de {name}",
  signatureDone: "Firmado el {date}",
  signHere: "Firma aquí con el dedo",
  clearSignature: "Borrar",
  sign: "Firmar",
  preparingRecords: "Preparando el parte de viajeros…",
  signatureNeedsData: "Antes de firmar hay que completar los datos de todos los viajeros.",
  paymentIntro: "Pago de la estancia",
  paymentNothingDue: "No hay nada pendiente de pago.",
  paymentSettled: "Todo pagado. ¡Gracias!",
  paymentAtReception: "El importe pendiente se cobrará en recepción a tu llegada.",
  paymentLinkReady: "Puedes pagar ahora de forma segura.",
  payNow: "Pagar ahora",
  paymentPending: "El pago aún no consta. Si ya pagaste, espera unos segundos y vuelve a comprobar.",
  checkPayment: "Comprobar el pago",
  balanceDue: "Pendiente: {amount}",
  extrasTitle: "Extras",
  extrasIntro: "Añade lo que quieras a tu estancia.",
  arrivalIntro: "Ya casi está. Indica a qué hora llegas y verifica tu identidad cuando estés en el hotel.",
  eta: "Hora estimada de llegada",
  preferences: "Preferencias",
  savePreferences: "Guardar preferencias",
  otpTitle: "Verifica tu identidad",
  otpIntro: "Te enviamos un código de 6 dígitos.",
  otpByEmail: "Enviar código al correo",
  otpByPhone: "Enviar código al móvil",
  otpSentTo: "Código enviado a {recipient}.",
  otpCode: "Código",
  otpVerify: "Verificar",
  otpVerified: "Identidad verificada.",
  otpDebug: "Código de demostración: {code}",
  identityAtReception: "Verificarás tu identidad en recepción al llegar.",
  arriveNow: "Ya estoy en el hotel",
  arriveHint: "Al pulsar, hacemos el check-in y te damos la habitación y la llave.",
  arrivalRoom: "Tu habitación",
  arrivalFloor: "Planta {floor}",
  arrivalKey: "Tu llave",
  arrivalKeyHint: "Muestra este código en la puerta o añádelo a tu cartera digital.",
  addToApple: "Añadir a Apple Wallet",
  addToGoogle: "Añadir a Google Wallet",
  keyAtReception: "Recoge tu llave en recepción.",
  arrivalWelcome: "¡Bienvenido! Tu check-in está hecho.",
  roomNotReadyAt: "Tu habitación estará lista a las {time}. Te avisamos en cuanto esté.",
  roomNotReady: "Tu habitación aún no está lista. Recepción te avisará en cuanto lo esté.",
  arrivalTooEarly: "Podrás hacer el check-in el {date}. Te esperamos.",
  identityNotVerified: "Tu identidad debe verificarla recepción antes del check-in.",
  balanceDueError: "Hay un importe pendiente: págalo con el enlace o en recepción.",
  signatureMissing: "Falta alguna firma del parte de viajeros.",
  alreadyCheckedIn: "Tu check-in ya estaba hecho. ¡Disfruta de la estancia!",
  genericError: "No hemos podido completar la operación. Inténtalo de nuevo.",
  handoffTitle: "Acércate al mostrador",
  handoffTicket: "Ticket {ticket}",
  handoffHint: "Un compañero de recepción terminará tu check-in con este número.",
  handoffNoTicket: "Un compañero de recepción terminará tu check-in en el mostrador.",
  handoffSignatureMessage: "Has pedido firmar en recepción: tu check-in continúa en el mostrador.",
  handoffError: "No se pudo avisar a recepción. Inténtalo de nuevo o acércate al mostrador.",
  retention: "Tus datos se cifran y solo se usan para el registro de viajeros (RD 933/2021); retención de tres años.",
  preCheckInBlock: "Pre-check-in",
  statusInvited: "Pendiente",
  statusInProgress: "En curso",
  statusReady: "Listo para llegar",
  statusArrived: "Llegada registrada",
  statusCheckedIn: "Check-in hecho",
  statusHandedOff: "En recepción",
  statusExpired: "Caducado",
  startPreCheckIn: "Empezar el pre-check-in",
  continuePreCheckIn: "Continuar el pre-check-in",
  viewArrival: "Ver mi habitación y llave",
  roomAssigned: "Habitación asignada",
  roomPending: "Te la asignamos antes de tu llegada",
  keyIssued: "Llave emitida",
  keyPending: "Llave pendiente",
  kioskTitle: "Check-in",
  kioskTouch: "Toca para empezar",
  kioskPairTitle: "Emparejar este kiosco",
  kioskPairIntro: "Introduce el código de 8 dígitos que te ha dado recepción.",
  kioskPairCode: "Código de emparejamiento",
  kioskPair: "Emparejar",
  kioskPairInvalid: "Código no válido o caducado. Pide otro en recepción.",
  kioskLocateTitle: "Localiza tu reserva",
  kioskLocateIntro: "Escanea el código de tu invitación o escribe tu código de reserva y tu correo.",
  kioskInvitationToken: "Código de la invitación",
  reservationCode: "Código de reserva",
  kioskFind: "Buscar",
  kioskNotFound: "No encontramos la reserva. Comprueba los datos o acércate al mostrador.",
  kioskIdleWarning: "Sin actividad: la pantalla se reiniciará en {seconds} s.",
  kioskFinish: "Terminar",
  kioskDevice: "Kiosco {name}",
  // Tanda L7 · L7-01: portal base (sesión, estancia, pre-check-in clásico, peticiones, cabecera).
  signingIn: "Iniciando sesión…",
  linkExpired: "Tu enlace de acceso ha caducado o no es válido. Entra con tu código de reserva y tu correo.",
  skipToContent: "Ir al contenido",
  signOut: "Cerrar sesión",
  langSelector: "Idioma",
  langEs: "Español",
  langEn: "English",
  signInEyebrow: "Portal del huésped",
  signInTitle: "Te damos la bienvenida",
  signInSubtitle: "Entra con tu código de reserva y el correo con el que reservaste.",
  signInHelp: "¿Necesitas ayuda? Pregunta en recepción.",
  missingProperty: "A este enlace le falta el identificador del hotel ({param}). Abre el enlace que te envió el hotel o pregunta en recepción.",
  reservationCodePlaceholder: "RES-2026-00042",
  emailPlaceholder: "tu@correo.com",
  signInFailed: "No se pudo iniciar sesión. Inténtalo de nuevo o pregunta en recepción.",
  signInNotFound: "No encontramos ninguna reserva con ese código y correo. Revísalos o pregunta en recepción.",
  signingInButton: "Entrando…",
  previewAnyCode: "Vista previa sin API: cualquier código y correo entran; no se envía ningún enlace.",
  stayEyebrow: "Tu estancia",
  hello: "Hola, {name}",
  loadingStay: "Cargando tu estancia",
  staySubtitle: "Todo lo que necesitas antes, durante y después de tu estancia.",
  loadingReservation: "Cargando la reserva…",
  reservationLoadError: "No hemos podido cargar tu reserva.",
  dates: "Fechas",
  datesPending: "Fechas pendientes",
  room: "Habitación",
  guestsLabel: "Huéspedes",
  balanceDueLabel: "Pendiente de pago",
  resConfirmed: "Confirmada",
  resCheckedOut: "Salida hecha",
  resCancelled: "Cancelada",
  preCheckInHint: "Ahorra tiempo al llegar",
  requestService: "Pedir un servicio",
  requestServiceHint: "Toallas, salida tardía y más",
  contactLabel: "Recepción",
  contactAtReception: "Pregunta en recepción",
  preCheckInTitle: "Agiliza tu llegada",
  preCheckInSubtitle: "Danos tus datos ahora y evita la cola en recepción.",
  documentNumberPlaceholder: "El número que figura en tu documento",
  addressPlaceholder: "Calle, ciudad, código postal",
  countryOfResidence: "País de residencia",
  countryOther: "Otro país",
  arrivalEta: "Llegada prevista",
  specialRequests: "Peticiones especiales",
  optional: "(opcional)",
  specialRequestsPlaceholder: "Habitación tranquila, llegada temprana, alergias…",
  preCheckInSaveError: "No hemos podido guardar tu pre-check-in. Inténtalo de nuevo.",
  submitPreCheckIn: "Enviar el pre-check-in",
  preCheckInDoneTitle: "Todo listo",
  preCheckInDoneBody: "Tu check-in está preparado.",
  seeYouOn: "Te esperamos el {date}.",
  confirmationNumber: "Número de confirmación",
  serviceEyebrow: "Petición de servicio",
  serviceTitle: "¿En qué podemos ayudarte?",
  serviceSubtitle: "Cuéntanos qué necesitas y lo pasamos al equipo adecuado.",
  category: "Categoría",
  catHousekeeping: "Limpieza",
  catHousekeepingHint: "Toallas, amenities, limpieza",
  catFood: "Restauración",
  catFoodHint: "Servicio de habitaciones, dietas",
  catConcierge: "Conserjería",
  catConciergeHint: "Reservas, transporte",
  catMaintenance: "Mantenimiento",
  catMaintenanceHint: "Averías, incidencias técnicas",
  whatDoYouNeed: "¿Qué necesitas?",
  serviceExample: "Dos almohadas más, por favor.",
  preferredTime: "Hora preferida",
  serviceSendError: "No hemos podido enviar tu petición. Inténtalo de nuevo.",
  sendRequest: "Enviar la petición",
  requestReceived: "Petición recibida",
  requestReceivedBody: "Te confirmamos en breve. Gracias por avisarnos.",
  ticketNumber: "Número de ticket",
  anotherRequest: "Enviar otra petición",
  // Tanda L7 · L7-06: estancia y salida (etapa, folio real, facturas, peticiones, pago honesto, datos del hotel).
  demoNoApi: "Vista previa sin API: los datos de la estancia son de demostración.",
  stayLoadError: "No hemos podido cargar tu estancia.",
  stagePreArrival: "Antes de llegar",
  stageArrivalDay: "Día de llegada",
  stageInHouse: "En el hotel",
  stageDepartureDay: "Día de salida",
  stagePostStay: "Estancia terminada",
  stageCancelled: "Cancelada",
  stagePreArrivalHint: "Te esperamos el {date}. Adelanta el pre-check-in y llega sin cola.",
  stageArrivalDayHint: "Hoy llegas. Cuando estés en el hotel, haz el check-in desde aquí o en recepción.",
  stageInHouseHint: "Disfruta de tu estancia. Pide lo que necesites desde aquí.",
  stageDepartureDayHint: "Hoy es tu salida. Consulta tu cuenta y pide la salida exprés o la factura sin pasar por recepción.",
  stagePostStayHint: "Gracias por tu estancia. Aquí tienes tu cuenta y tus facturas.",
  stagePostStayMissedHint: "La fecha de salida ya pasó sin registrar tu llegada. Si no es correcto, pregunta en recepción.",
  stageCancelledHint: "Esta reserva está cancelada. Si no es correcto, pregunta en recepción.",
  resNoShow: "No presentado",
  reviewPreCheckIn: "Revisar el pre-check-in",
  ctaArrive: "Llegar",
  ctaArriveHint: "Habitación y llave al pulsar",
  ctaCheckOut: "Salida y cuenta",
  ctaCheckOutHint: "Cuenta, pago y salida exprés",
  ctaExpressCheckOut: "Salida exprés",
  ctaExpressCheckOutHint: "Deja la llave y vete sin cola",
  ctaInvoices: "Cuenta y facturas",
  ctaInvoicesHint: "Descarga tus facturas",
  ctaSurvey: "Responder la encuesta",
  ctaSurveyHint: "Dos minutos, nos ayuda mucho",
  infoLabel: "Información del hotel",
  infoHint: "Wifi, desayuno, horarios",
  checkOutEyebrow: "Salida",
  checkOutTitle: "Tu cuenta y tu salida",
  checkOutSubtitle: "Consulta los cargos, paga si quieres y pide a recepción la salida exprés, la salida tardía o la factura por correo.",
  checkOutPostStaySubtitle: "Consulta los cargos y descarga tus facturas; si necesitas una copia por correo, pídela aquí.",
  checkOutCancelledTitle: "Reserva cancelada",
  checkOutCancelledSubtitle: "Aquí tienes los cargos de cancelación de tu reserva. Cualquier duda o pago, en recepción.",
  paymentCancelledAtReception: "Los cargos de cancelación se gestionan en recepción.",
  folioTitle: "Tu cuenta",
  folioNoCharges: "Todavía no hay cargos en tu cuenta.",
  folioNoChargesShort: "Sin cargos todavía",
  folioSettled: "Sin saldo pendiente.",
  folioBalanceDue: "Pendiente de pago: {amount}",
  folioCharges: "Cargos",
  folioPayments: "Pagos",
  folioTotalCharges: "Total de cargos",
  folioTotalPaid: "Pagado",
  folioShowLines: "Ver el detalle ({n})",
  folioQty: "{qty} ud.",
  payStatusCaptured: "Cobrado",
  payStatusPending: "Pendiente",
  payStatusFailed: "Fallido",
  payStatusRefunded: "Devuelto",
  payStatusAuthorized: "Autorizado",
  payMethodCard: "Tarjeta",
  payMethodCash: "Efectivo",
  payMethodTransfer: "Transferencia",
  payMethodLink: "Enlace de pago",
  payMethodOther: "Otro medio",
  paymentTitle: "Pago",
  getPaymentLink: "Quiero pagar ahora",
  paymentPreparing: "Preparando el pago…",
  paymentAtReceptionStay: "El saldo pendiente se cobra en recepción; no tienes que hacer nada más ahora.",
  paymentNoChargesYet: "Todavía no hay cargos: el alojamiento se carga durante la estancia y se paga en recepción o desde aquí.",
  paymentOpensPsp: "Se abre la pasarela de pago segura del hotel.",
  paymentLinkError: "No hemos podido preparar el pago. Puedes pagar en recepción.",
  checkOutRequestsTitle: "Pide a recepción",
  checkOutRequestsIntro: "Elige qué necesitas; recepción lo confirma.",
  checkOutRequestsClosed: "Las peticiones de salida se abren cuando estés alojado. Mientras tanto, pregunta en recepción.",
  kindExpressCheckout: "Salida exprés",
  kindExpressCheckoutHint: "Deja la llave y vete sin pasar por recepción",
  kindLateCheckout: "Salida tardía",
  kindLateCheckoutHint: "Quédate un poco más, según disponibilidad",
  kindInvoiceEmail: "Factura por correo",
  kindInvoiceEmailHint: "Te la enviamos al correo de la reserva",
  kindLuggage: "Consigna de equipaje",
  kindLuggageHint: "Guardamos tus maletas",
  kindOther: "Petición",
  requestNote: "Comentario",
  requestNotePlaceholder: "Lo que quieras que sepamos",
  sendToReception: "Enviar a recepción",
  requestSentBody: "Recepción ya la tiene y te confirmará. Tu número de petición:",
  requestsTitle: "Tus peticiones",
  requestsEmpty: "No has hecho ninguna petición todavía.",
  reqStatusOpen: "Abierta",
  reqStatusResolved: "Resuelta",
  reqStatusClosed: "Cerrada",
  reqStatusRejected: "Rechazada",
  stayClosedError: "La reserva está cerrada: no admite peticiones desde el portal.",
  invoicesTitle: "Facturas",
  invoicesEmpty: "Todavía no hay ninguna factura emitida. Te la damos al terminar la estancia o pídela por correo.",
  invoiceDownload: "Descargar PDF",
  invoiceOpening: "Abriendo…",
  invoiceOpenError: "No hemos podido abrir la factura. Inténtalo de nuevo o pídela en recepción.",
  invoiceLabel: "Factura {number}",
  invoiceNoNumber: "Factura",
  invoiceIssuedOn: "Emitida el {date}",
  infoEyebrow: "Información",
  infoTitle: "Datos útiles del hotel",
  infoSubtitle: "Lo que el hotel ha publicado para tu estancia. Lo que no aparece, pregúntalo en recepción.",
  infoWifi: "Wifi",
  infoWifiPassword: "Contraseña del wifi",
  infoBreakfast: "Desayuno",
  infoCheckOutTime: "Hora de salida",
  infoReceptionPhone: "Teléfono de recepción",
  infoAddress: "Dirección",
  infoEmpty: "El hotel todavía no ha publicado esta información. Pregunta en recepción.",
  infoCall: "Llamar a recepción",
  infoYourStay: "Tu estancia",
  surveyTitle: "Tu opinión",
  surveyInvited: "Te hemos enviado una encuesta por correo. Abre el enlace del mensaje para responder.",
  surveyAnswered: "Gracias por tu opinión.",
  surveyNotInvited: "Gracias por tu estancia. Esperamos verte pronto.",
  // Tanda L7 · L7-08: página de encuesta post-estancia (NPS 0-10 + comentario; T8 decisión 14, contrato L7-04).
  surveyEyebrow: "Encuesta",
  surveyPageTitle: "¿Qué tal tu estancia?",
  surveyPageSubtitle: "Dos minutos. Tu respuesta llega directamente al equipo del hotel.",
  surveyLoading: "Cargando la encuesta…",
  surveyLoadError: "No hemos podido cargar la encuesta.",
  surveyNpsLegend: "0 = nada probable · 10 = seguro",
  surveyScaleLegend: "1 = muy mal · 5 = muy bien",
  surveyScoreOption: "Puntuación {score}",
  surveyScoreChosen: "Has elegido {score} de 10.",
  surveyScoreRequired: "Elige una puntuación de 0 a 10.",
  surveyAnswerRequired: "Esta pregunta es obligatoria.",
  surveyAnswerTooLong: "Como mucho {max} caracteres.",
  surveyCommentPlaceholder: "Cuéntanos qué ha ido bien y qué podríamos mejorar.",
  surveySubmit: "Enviar mi opinión",
  surveySubmitting: "Enviando tu opinión…",
  surveySendError: "No hemos podido enviar tu respuesta. Inténtalo de nuevo.",
  surveyThanksTitle: "¡Gracias por tu opinión!",
  surveyThanksBody: "La hemos recibido y nos ayuda a mejorar. Esperamos verte pronto.",
  surveyAlreadyAnswered: "Ya has respondido a esta encuesta. ¡Gracias!",
  surveyAnsweredOn: "Respondida el {date}",
  surveyNotYet: "La encuesta se abre cuando termine tu estancia.",
  surveyClosed: "Esta reserva no tiene encuesta.",
  surveySessionExpired: "Tu enlace ha caducado. Entra con tu código de reserva y tu correo para responder.",
  surveySignIn: "Entrar con mi código",
  surveyToPortal: "Entrar en el portal con mi código",
  language: "English"
} as const;

export type CopyKey = keyof typeof COPY_ES;

const COPY_EN: Record<CopyKey, string> = {
  wizardEyebrow: "Pre-check-in",
  wizardTitle: "Arrive without the queue",
  wizardSubtitle: "Six quick steps from your phone. Pick up where you left off any time.",
  stepTravellers: "Travellers",
  stepDocument: "Document",
  stepDetails: "Details",
  stepSignature: "Signature",
  stepPayment: "Payment & extras",
  stepArrival: "Arrival",
  stepOf: "Step {index} of {total}",
  back: "Back",
  next: "Continue",
  backToStay: "Back to my stay",
  loading: "Loading your pre-check-in…",
  saving: "Saving…",
  retry: "Retry",
  notInvited: "This link has no open pre-check-in. Ask reception for a new invitation.",
  travellersIntro: "Tell us who is travelling. Children under 14 are declared by an adult on the booking.",
  travellerPrimary: "Lead guest",
  travellerCompanion: "Companion {n}",
  travellerMinor: "Minor",
  addTraveller: "Add traveller",
  removeTraveller: "Remove",
  capacityReached: "All travellers on this booking are already declared.",
  firstName: "First name",
  surname1: "First surname",
  surname2: "Second surname",
  documentIntro: "Take a photo of each traveller's ID. The image is read and discarded: it is never stored.",
  documentFor: "{name}'s document",
  documentDone: "Document read · ends in {last3}",
  documentReread: "Read the document again",
  documentRereadHint: "If the number is not yours or you want to read it with the camera or the MRZ, read it again.",
  documentRereadCancel: "Keep the current document",
  documentSourceProfile: "from your profile (document not read)",
  documentMismatch: "The name on the document does not match any traveller on this booking: it was not applied. The front desk will check it on arrival; you can read another document.",
  chatTitle: "Chat with the front desk",
  chatIntro: "Ask about arrival, late check-out, breakfast, or request something for your stay.",
  chatDisclosure: "An automated assistant of {property} answers; a front-desk person reviews any change.",
  chatPlaceholder: "Type your message…",
  chatSend: "Send",
  chatSending: "Sending…",
  chatHandoff: "We are handing this over to a front-desk person.",
  chatPending: "Pending confirmation by the front desk.",
  chatUpdated: "Done: your booking has been updated.",
  chatIdentify: "To help with your booking, open the chat from your check-in link.",
  chatDisabled: "The assistant is not available right now; please call the front desk.",
  chatError: "The message could not be sent. Please try again.",
  documentType: "Document type",
  docPassport: "Passport",
  docDni: "Spanish ID (DNI)",
  docTie: "Residence card (TIE / NIE)",
  docOther: "Other document",
  takePhoto: "Take a photo",
  useCamera: "Use the camera",
  capture: "Capture",
  cancel: "Cancel",
  processing: "Reading the document…",
  pasteMrz: "Or paste the MRZ lines (reader or keyboard)",
  mrzPlaceholder: "P<ESPSURNAME<<NAME<<<<…",
  sendMrz: "Read the MRZ",
  documentUnreadable: "We couldn't read the document. Try with more light or paste the MRZ lines.",
  imageTooLarge: "The image is over 6 MB. Take another photo at a lower resolution.",
  cameraUnavailable: "The camera can't be opened on this device; use “Take a photo”.",
  sourceMrz: "read from the MRZ",
  sourceAi: "read by vision",
  sourceManual: "entered by the guest",
  confidence: "confidence {pct}%",
  detailsIntro: "Fill in what the document doesn't carry. Only what the guest register requires (RD 933/2021).",
  sex: "Sex",
  sexH: "Male",
  sexM: "Female",
  sexO: "Other",
  nationality: "Nationality (ISO code, e.g. GBR)",
  dateOfBirth: "Date of birth",
  documentNumber: "Document number",
  documentSupportNumber: "Support number (DNI/TIE)",
  documentExpiryDate: "Document expiry date",
  email: "Email",
  phoneMobile: "Mobile (with country code, e.g. +44…)",
  residenceFullAddress: "Full address",
  residenceLocality: "City / town",
  residenceCountry: "Country of residence (ISO code)",
  minorGuardian: "Adult declaring the minor",
  kinship: "Relationship",
  guardianTitle: "Guardian's title (if not a parent)",
  chooseAdult: "Choose an adult",
  missingTitle: "Missing details",
  missingContact: "email or mobile",
  consentGdpr: "I have read how my data is used for the guest register (required).",
  consentAi: "I understand an automated assistant may read my document and answer my messages.",
  consentMarketing: "I'd like to receive offers from the hotel (optional).",
  consentWhatsapp: "I agree to receive WhatsApp messages (optional).",
  saveTraveller: "Save",
  signatureIntro: "Sign the guest register. Children under 14 don't sign.",
  signatureFor: "{name}'s signature",
  signatureDone: "Signed on {date}",
  signHere: "Sign here with your finger",
  clearSignature: "Clear",
  sign: "Sign",
  preparingRecords: "Preparing the guest register…",
  signatureNeedsData: "Every traveller's details must be complete before signing.",
  paymentIntro: "Payment for your stay",
  paymentNothingDue: "Nothing is due right now.",
  paymentSettled: "All paid. Thank you!",
  paymentAtReception: "The outstanding amount will be charged at reception on arrival.",
  paymentLinkReady: "You can pay securely now.",
  payNow: "Pay now",
  paymentPending: "The payment isn't recorded yet. If you already paid, wait a few seconds and check again.",
  checkPayment: "Check payment",
  balanceDue: "Outstanding: {amount}",
  extrasTitle: "Extras",
  extrasIntro: "Add anything you'd like to your stay.",
  arrivalIntro: "Almost there. Tell us when you arrive and verify your identity once you're at the hotel.",
  eta: "Estimated arrival time",
  preferences: "Preferences",
  savePreferences: "Save preferences",
  otpTitle: "Verify your identity",
  otpIntro: "We'll send you a 6-digit code.",
  otpByEmail: "Send the code by email",
  otpByPhone: "Send the code by SMS",
  otpSentTo: "Code sent to {recipient}.",
  otpCode: "Code",
  otpVerify: "Verify",
  otpVerified: "Identity verified.",
  otpDebug: "Demo code: {code}",
  identityAtReception: "You'll verify your identity at reception on arrival.",
  arriveNow: "I'm at the hotel",
  arriveHint: "We'll check you in and hand you your room and key.",
  arrivalRoom: "Your room",
  arrivalFloor: "Floor {floor}",
  arrivalKey: "Your key",
  arrivalKeyHint: "Show this code at the door or add it to your digital wallet.",
  addToApple: "Add to Apple Wallet",
  addToGoogle: "Add to Google Wallet",
  keyAtReception: "Collect your key at reception.",
  arrivalWelcome: "Welcome! Your check-in is done.",
  roomNotReadyAt: "Your room will be ready at {time}. We'll let you know as soon as it is.",
  roomNotReady: "Your room isn't ready yet. Reception will let you know as soon as it is.",
  arrivalTooEarly: "You'll be able to check in on {date}. See you soon.",
  identityNotVerified: "Reception must verify your identity before check-in.",
  balanceDueError: "There is an outstanding amount: pay with the link or at reception.",
  signatureMissing: "A guest register signature is missing.",
  alreadyCheckedIn: "You were already checked in. Enjoy your stay!",
  genericError: "We couldn't complete that. Please try again.",
  handoffTitle: "Please go to the desk",
  handoffTicket: "Ticket {ticket}",
  handoffHint: "A receptionist will finish your check-in with this number.",
  handoffNoTicket: "A receptionist will finish your check-in at the desk.",
  handoffSignatureMessage: "You asked to sign at reception: your check-in continues at the desk.",
  handoffError: "We couldn't notify reception. Try again or go to the desk.",
  retention: "Your data is encrypted and only used for the legal guest register (RD 933/2021); three-year retention applies.",
  preCheckInBlock: "Pre-check-in",
  statusInvited: "Pending",
  statusInProgress: "In progress",
  statusReady: "Ready for arrival",
  statusArrived: "Arrival recorded",
  statusCheckedIn: "Checked in",
  statusHandedOff: "At reception",
  statusExpired: "Expired",
  startPreCheckIn: "Start pre-check-in",
  continuePreCheckIn: "Continue pre-check-in",
  viewArrival: "See my room and key",
  roomAssigned: "Room assigned",
  roomPending: "We'll assign it before you arrive",
  keyIssued: "Key issued",
  keyPending: "Key pending",
  kioskTitle: "Check-in",
  kioskTouch: "Touch to start",
  kioskPairTitle: "Pair this kiosk",
  kioskPairIntro: "Enter the 8-digit code reception gave you.",
  kioskPairCode: "Pairing code",
  kioskPair: "Pair",
  kioskPairInvalid: "Invalid or expired code. Ask reception for another one.",
  kioskLocateTitle: "Find your booking",
  kioskLocateIntro: "Scan your invitation code or type your booking code and email.",
  kioskInvitationToken: "Invitation code",
  reservationCode: "Booking code",
  kioskFind: "Find",
  kioskNotFound: "We couldn't find the booking. Check the details or go to the desk.",
  kioskIdleWarning: "No activity: the screen resets in {seconds} s.",
  kioskFinish: "Finish",
  kioskDevice: "Kiosk {name}",
  signingIn: "Signing you in…",
  linkExpired: "Your sign-in link has expired or is not valid. Sign in with your booking code and email.",
  skipToContent: "Skip to content",
  signOut: "Sign out",
  langSelector: "Language",
  langEs: "Español",
  langEn: "English",
  signInEyebrow: "Guest portal",
  signInTitle: "Welcome",
  signInSubtitle: "Sign in with your booking code and the email you used when booking.",
  signInHelp: "Need help? Ask at reception.",
  missingProperty: "This portal link is missing the hotel identifier ({param}). Open the link the hotel sent you or ask at reception.",
  reservationCodePlaceholder: "RES-2026-00042",
  emailPlaceholder: "you@example.com",
  signInFailed: "Sign in failed. Try again or ask at reception.",
  signInNotFound: "We couldn't find a booking with that code and email. Check them or ask at reception.",
  signingInButton: "Signing in…",
  previewAnyCode: "Preview without API: any code and email work; no link is sent.",
  stayEyebrow: "Your stay",
  hello: "Hello, {name}",
  loadingStay: "Loading your stay",
  staySubtitle: "Everything you need before, during and after your stay.",
  loadingReservation: "Loading your booking…",
  reservationLoadError: "We couldn't load your booking.",
  dates: "Dates",
  datesPending: "Dates pending",
  room: "Room",
  guestsLabel: "Guests",
  balanceDueLabel: "Balance due",
  resConfirmed: "Confirmed",
  resCheckedOut: "Checked out",
  resCancelled: "Cancelled",
  preCheckInHint: "Save time on arrival",
  requestService: "Request a service",
  requestServiceHint: "Towels, late check-out and more",
  contactLabel: "Reception",
  contactAtReception: "Ask at reception",
  preCheckInTitle: "Speed up your arrival",
  preCheckInSubtitle: "Share your details now and skip the queue at reception.",
  documentNumberPlaceholder: "The number on your ID",
  addressPlaceholder: "Street, city, postal code",
  countryOfResidence: "Country of residence",
  countryOther: "Other country",
  arrivalEta: "Estimated arrival",
  specialRequests: "Special requests",
  optional: "(optional)",
  specialRequestsPlaceholder: "Quiet room, early arrival, dietary needs…",
  preCheckInSaveError: "We couldn't save your pre-check-in. Please try again.",
  submitPreCheckIn: "Submit pre-check-in",
  preCheckInDoneTitle: "You're all set",
  preCheckInDoneBody: "Your check-in is ready.",
  seeYouOn: "See you on {date}.",
  confirmationNumber: "Confirmation number",
  serviceEyebrow: "Service request",
  serviceTitle: "How can we help?",
  serviceSubtitle: "Tell us what you need and we'll route it to the right team.",
  category: "Category",
  catHousekeeping: "Housekeeping",
  catHousekeepingHint: "Towels, amenities, cleaning",
  catFood: "Food & beverage",
  catFoodHint: "Room service, dietary needs",
  catConcierge: "Concierge",
  catConciergeHint: "Reservations, transport",
  catMaintenance: "Maintenance",
  catMaintenanceHint: "Repairs, technical issues",
  whatDoYouNeed: "What do you need?",
  serviceExample: "Two extra pillows, please.",
  preferredTime: "Preferred time",
  serviceSendError: "We couldn't send your request. Please try again.",
  sendRequest: "Send request",
  requestReceived: "Request received",
  requestReceivedBody: "We'll confirm shortly. Thank you for letting us know.",
  ticketNumber: "Ticket number",
  anotherRequest: "Submit another request",
  demoNoApi: "Preview without API: the stay data is a demo.",
  stayLoadError: "We couldn't load your stay.",
  stagePreArrival: "Before you arrive",
  stageArrivalDay: "Arrival day",
  stageInHouse: "At the hotel",
  stageDepartureDay: "Departure day",
  stagePostStay: "Stay completed",
  stageCancelled: "Cancelled",
  stagePreArrivalHint: "See you on {date}. Do the pre-check-in now and skip the queue.",
  stageArrivalDayHint: "You arrive today. Once at the hotel, check in from here or at reception.",
  stageInHouseHint: "Enjoy your stay. Ask for anything you need from here.",
  stageDepartureDayHint: "You leave today. Check your bill and ask for express check-out or your invoice without queuing.",
  stagePostStayHint: "Thank you for staying with us. Your bill and invoices are here.",
  stagePostStayMissedHint: "The departure date has passed without a recorded arrival. If that's wrong, ask at reception.",
  stageCancelledHint: "This booking is cancelled. If that's wrong, ask at reception.",
  resNoShow: "No-show",
  reviewPreCheckIn: "Review pre-check-in",
  ctaArrive: "Arrive",
  ctaArriveHint: "Room and key in one tap",
  ctaCheckOut: "Check-out & bill",
  ctaCheckOutHint: "Bill, payment and express check-out",
  ctaExpressCheckOut: "Express check-out",
  ctaExpressCheckOutHint: "Leave the key and go, no queue",
  ctaInvoices: "Bill & invoices",
  ctaInvoicesHint: "Download your invoices",
  ctaSurvey: "Answer the survey",
  ctaSurveyHint: "Two minutes, it helps a lot",
  infoLabel: "Hotel information",
  infoHint: "Wi-Fi, breakfast, opening hours",
  checkOutEyebrow: "Check-out",
  checkOutTitle: "Your bill and check-out",
  checkOutSubtitle: "Review the charges, pay if you wish and ask reception for express check-out, late check-out or your invoice by email.",
  checkOutPostStaySubtitle: "Review the charges and download your invoices; if you need a copy by email, ask for it here.",
  checkOutCancelledTitle: "Booking cancelled",
  checkOutCancelledSubtitle: "Here are the cancellation charges for your booking. For any question or payment, ask at reception.",
  paymentCancelledAtReception: "Cancellation charges are handled at reception.",
  folioTitle: "Your bill",
  folioNoCharges: "There are no charges on your bill yet.",
  folioNoChargesShort: "No charges yet",
  folioSettled: "Nothing outstanding.",
  folioBalanceDue: "Outstanding: {amount}",
  folioCharges: "Charges",
  folioPayments: "Payments",
  folioTotalCharges: "Total charges",
  folioTotalPaid: "Paid",
  folioShowLines: "Show details ({n})",
  folioQty: "{qty} × ",
  payStatusCaptured: "Paid",
  payStatusPending: "Pending",
  payStatusFailed: "Failed",
  payStatusRefunded: "Refunded",
  payStatusAuthorized: "Authorised",
  payMethodCard: "Card",
  payMethodCash: "Cash",
  payMethodTransfer: "Bank transfer",
  payMethodLink: "Payment link",
  payMethodOther: "Other",
  paymentTitle: "Payment",
  getPaymentLink: "I want to pay now",
  paymentPreparing: "Preparing the payment…",
  paymentAtReceptionStay: "The outstanding balance is charged at reception; nothing else to do now.",
  paymentNoChargesYet: "No charges yet: accommodation is charged during the stay and paid at reception or from here.",
  paymentOpensPsp: "The hotel's secure payment page opens.",
  paymentLinkError: "We couldn't prepare the payment. You can pay at reception.",
  checkOutRequestsTitle: "Ask reception",
  checkOutRequestsIntro: "Choose what you need; reception confirms it.",
  checkOutRequestsClosed: "Check-out requests open once you are checked in. Meanwhile, ask at reception.",
  kindExpressCheckout: "Express check-out",
  kindExpressCheckoutHint: "Leave the key and go without queuing",
  kindLateCheckout: "Late check-out",
  kindLateCheckoutHint: "Stay a bit longer, subject to availability",
  kindInvoiceEmail: "Invoice by email",
  kindInvoiceEmailHint: "We send it to the booking email",
  kindLuggage: "Luggage storage",
  kindLuggageHint: "We keep your bags",
  kindOther: "Request",
  requestNote: "Comment",
  requestNotePlaceholder: "Anything you'd like us to know",
  sendToReception: "Send to reception",
  requestSentBody: "Reception has it and will confirm. Your request number:",
  requestsTitle: "Your requests",
  requestsEmpty: "You haven't made any request yet.",
  reqStatusOpen: "Open",
  reqStatusResolved: "Resolved",
  reqStatusClosed: "Closed",
  reqStatusRejected: "Declined",
  stayClosedError: "This booking is closed: it doesn't accept requests from the portal.",
  invoicesTitle: "Invoices",
  invoicesEmpty: "No invoice has been issued yet. You get it at the end of your stay, or ask for it by email.",
  invoiceDownload: "Download PDF",
  invoiceOpening: "Opening…",
  invoiceOpenError: "We couldn't open the invoice. Try again or ask for it at reception.",
  invoiceLabel: "Invoice {number}",
  invoiceNoNumber: "Invoice",
  invoiceIssuedOn: "Issued on {date}",
  infoEyebrow: "Information",
  infoTitle: "Useful hotel details",
  infoSubtitle: "What the hotel has published for your stay. Anything missing, ask at reception.",
  infoWifi: "Wi-Fi",
  infoWifiPassword: "Wi-Fi password",
  infoBreakfast: "Breakfast",
  infoCheckOutTime: "Check-out time",
  infoReceptionPhone: "Reception phone",
  infoAddress: "Address",
  infoEmpty: "The hotel hasn't published this information yet. Ask at reception.",
  infoCall: "Call reception",
  infoYourStay: "Your stay",
  surveyTitle: "Your opinion",
  surveyInvited: "We emailed you a survey. Open the link in the message to answer.",
  surveyAnswered: "Thank you for your feedback.",
  surveyNotInvited: "Thank you for staying with us. We hope to see you again.",
  surveyEyebrow: "Survey",
  surveyPageTitle: "How was your stay?",
  surveyPageSubtitle: "Two minutes. Your answer goes straight to the hotel team.",
  surveyLoading: "Loading the survey…",
  surveyLoadError: "We couldn't load the survey.",
  surveyNpsLegend: "0 = not at all likely · 10 = definitely",
  surveyScaleLegend: "1 = very poor · 5 = excellent",
  surveyScoreOption: "Score {score}",
  surveyScoreChosen: "You chose {score} out of 10.",
  surveyScoreRequired: "Pick a score from 0 to 10.",
  surveyAnswerRequired: "This question is required.",
  surveyAnswerTooLong: "At most {max} characters.",
  surveyCommentPlaceholder: "Tell us what went well and what we could improve.",
  surveySubmit: "Send my feedback",
  surveySubmitting: "Sending your feedback…",
  surveySendError: "We couldn't send your answer. Please try again.",
  surveyThanksTitle: "Thank you for your feedback!",
  surveyThanksBody: "We've received it and it helps us improve. We hope to see you again.",
  surveyAlreadyAnswered: "You've already answered this survey. Thank you!",
  surveyAnsweredOn: "Answered on {date}",
  surveyNotYet: "The survey opens once your stay is over.",
  surveyClosed: "This booking has no survey.",
  surveySessionExpired: "Your link has expired. Sign in with your booking code and email to answer.",
  surveySignIn: "Sign in with my code",
  surveyToPortal: "Open the portal with my code",
  language: "Español"
};

export const COPY: Record<Lang, Record<CopyKey, string>> = { es: COPY_ES, en: COPY_EN };

/** Texto en el idioma dado con sustitución `{clave}`. */
export function t(lang: Lang, key: CopyKey, params?: Record<string, string | number>): string {
  const template = COPY[lang][key] ?? COPY.es[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

export const STEP_LABEL_KEY: Record<WizardStep, CopyKey> = {
  travellers: "stepTravellers",
  document: "stepDocument",
  details: "stepDetails",
  signature: "stepSignature",
  payment: "stepPayment",
  arrival: "stepArrival"
};

export function stepLabel(step: WizardStep, lang: Lang): string {
  return t(lang, STEP_LABEL_KEY[step]);
}

export const SESSION_STATUS_KEY: Record<string, CopyKey> = {
  invited: "statusInvited",
  in_progress: "statusInProgress",
  ready_for_arrival: "statusReady",
  arrived: "statusArrived",
  checked_in: "statusCheckedIn",
  handed_off: "statusHandedOff",
  expired: "statusExpired",
  cancelled: "statusExpired"
};

export function sessionStatusLabel(status: string, lang: Lang): string {
  const key = SESSION_STATUS_KEY[status];
  return key ? t(lang, key) : status;
}

/** Nombre corto del viajero para títulos (titular / acompañante n si no hay nombre). */
export function guestLabel(guest: Pick<WizardGuest, "firstName" | "surname1" | "isPrimary" | "ordinal">, lang: Lang): string {
  const name = [guest.firstName, guest.surname1].filter((part) => hasText(part)).join(" ").trim();
  if (name) return name;
  return guest.isPrimary ? t(lang, "travellerPrimary") : t(lang, "travellerCompanion", { n: guest.ordinal });
}

/** Guía de encuadre según el tipo de documento (dónde está la MRZ). */
export function formatDocumentHint(documentType: string | null | undefined, lang: Lang): string {
  const type = String(documentType ?? "").trim().toUpperCase();
  const es = lang === "es";
  if (type === "PASSPORT" || type === "P" || type === "PASAPORTE") {
    return es ? "Página de la foto del pasaporte: las dos líneas de códigos de abajo (44 caracteres) dentro del recuadro." : "Passport photo page: the two code lines at the bottom (44 characters) inside the frame.";
  }
  if (type === "DNI" || type === "TIE" || type === "NIE" || type === "ID" || type === "I") {
    return es ? "Reverso del DNI o TIE: las tres líneas de códigos (30 caracteres) dentro del recuadro, sin reflejos." : "Back of the DNI or TIE: the three code lines (30 characters) inside the frame, without glare.";
  }
  return es ? "Coloca la zona con las líneas de códigos (MRZ) dentro del recuadro, con buena luz y sin recortar los bordes." : "Fit the code lines (MRZ) inside the frame, with good light and without cropping the edges.";
}

/** Etiqueta de origen y confianza de un campo capturado (badge junto al campo). */
export function sourceLabel(source: string | null | undefined, confidence: number | null | undefined, lang: Lang): string {
  const base = source === "mrz_reader" || source === "mrz_ai" ? t(lang, "sourceMrz") : source === "ai_vision" ? t(lang, "sourceAi") : t(lang, "sourceManual");
  if (typeof confidence === "number" && Number.isFinite(confidence) && source && source !== "manual") {
    return `${base} · ${t(lang, "confidence", { pct: Math.round(Math.max(0, Math.min(1, confidence)) * 100) })}`;
  }
  return base;
}

// ---------------------------------------------------------------------------
// OTP y verificación en línea
// ---------------------------------------------------------------------------

export type OtpChannel = "email" | "phone";

/** Canales OTP admitidos por la política (otp_email → email, otp_phone → phone). */
export function otpChannelsFor(policy: Pick<WizardPolicy, "allowedVerificationMethods">): OtpChannel[] {
  const out: OtpChannel[] = [];
  if (policy.allowedVerificationMethods.includes("otp_email")) out.push("email");
  if (policy.allowedVerificationMethods.includes("otp_phone")) out.push("phone");
  return out;
}

export function primaryGuestOf(session: Pick<WizardSession, "guests">): WizardGuest | null {
  return session.guests.find((guest) => guest.isPrimary) ?? session.guests[0] ?? null;
}

/**
 * ¿Hace falta OTP antes de llegar? Sí cuando la política admite otp_* y el
 * titular no tiene una verificación fechada (mrz_checksum sin fecha solo vale
 * si la política lo admite, como identityVerdict del API).
 */
export function needsOtp(session: WizardSession): boolean {
  const channels = otpChannelsFor(session.policy);
  if (channels.length === 0) return false;
  const primary = primaryGuestOf(session);
  if (!primary) return false;
  if (primary.identityVerifiedAt && primary.identityVerificationMethod && session.policy.allowedVerificationMethods.includes(primary.identityVerificationMethod)) return false;
  if (primary.identityVerificationMethod === "mrz_checksum" && session.policy.allowedVerificationMethods.includes("mrz_checksum")) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Errores de llegada → mensaje, paso al que volver y handoff
// ---------------------------------------------------------------------------

export type ArrivalErrorDetails = { code?: string; etaReady?: string | null; arrivalDate?: string; businessDate?: string; missing?: unknown };

export type ArrivalErrorView = {
  message: string;
  /** Paso al que conviene volver (null: no depende del huésped). */
  step: WizardStep | null;
  /** true: recepción tiene que intervenir (kiosco → ticket de handoff). */
  handoff: boolean;
  /** true: la reserva ya está alojada; mostrar la llegada como hecha. */
  done: boolean;
};

export function formatClockTime(iso: string | null | undefined, lang: Lang, timeZone?: string): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    return new Intl.DateTimeFormat(lang === "es" ? "es-ES" : "en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, ...(timeZone ? { timeZone } : {}) }).format(date);
  } catch {
    return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
  }
}

function formatDay(value: string | undefined, lang: Lang): string | null {
  const day = parseIsoDay(value);
  if (!day) return null;
  try {
    return new Intl.DateTimeFormat(lang === "es" ? "es-ES" : "en-GB", { day: "numeric", month: "long", timeZone: "UTC" }).format(day);
  } catch {
    return value ?? null;
  }
}

/** Día anterior a la llegada (ventana ±1 día del check-in) en ISO YYYY-MM-DD. */
export function earliestCheckInDay(arrivalDate: string | undefined): string | null {
  const day = parseIsoDay(arrivalDate);
  if (!day) return null;
  day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

export function describeArrivalError(details: ArrivalErrorDetails | null | undefined, fallbackMessage: string, lang: Lang, timeZone?: string): ArrivalErrorView {
  const code = details?.code ?? "";
  switch (code) {
    case "ROOM_NOT_READY": {
      const time = formatClockTime(details?.etaReady ?? null, lang, timeZone);
      return { message: time ? t(lang, "roomNotReadyAt", { time }) : t(lang, "roomNotReady"), step: null, handoff: true, done: false };
    }
    case "CHECK_IN_DATE_OUT_OF_RANGE": {
      const day = formatDay(earliestCheckInDay(details?.arrivalDate) ?? undefined, lang);
      return { message: day ? t(lang, "arrivalTooEarly", { date: day }) : fallbackMessage || t(lang, "genericError"), step: null, handoff: false, done: false };
    }
    case "IDENTITY_NOT_VERIFIED":
      return { message: t(lang, "identityNotVerified"), step: "arrival", handoff: true, done: false };
    case "BALANCE_DUE":
      return { message: t(lang, "balanceDueError"), step: "payment", handoff: true, done: false };
    case "GUEST_REGISTER_INCOMPLETE":
      return { message: t(lang, "signatureMissing"), step: "signature", handoff: false, done: false };
    case "CHECKIN_INCOMPLETE":
      return { message: t(lang, "signatureNeedsData"), step: "details", handoff: false, done: false };
    case "CHECKIN_ALREADY_DONE":
      return { message: t(lang, "alreadyCheckedIn"), step: null, handoff: false, done: true };
    // Corrector L7-REV-05: derivación pedida por el huésped y registrada en el servidor (POST /guest-portal/check-in/handoff).
    case "SIGNATURE_AT_RECEPTION":
      return { message: t(lang, "handoffSignatureMessage"), step: null, handoff: true, done: false };
    default:
      return { message: fallbackMessage || t(lang, "genericError"), step: null, handoff: true, done: false };
  }
}

// ---------------------------------------------------------------------------
// Vocabulario de preferencias (espejo de PREFERENCE_VOCABULARY, sin importar @hotelos/shared)
// ---------------------------------------------------------------------------

export const PREFERENCE_OPTIONS: ReadonlyArray<{ code: string; es: string; en: string }> = [
  { code: "floor_high", es: "Planta alta", en: "High floor" },
  { code: "floor_low", es: "Planta baja", en: "Low floor" },
  { code: "quiet", es: "Tranquila", en: "Quiet" },
  { code: "near_elevator", es: "Cerca del ascensor", en: "Near the lift" },
  { code: "far_elevator", es: "Lejos del ascensor", en: "Away from the lift" },
  { code: "view_sea", es: "Vistas al mar", en: "Sea view" },
  { code: "view_city", es: "Vistas a la ciudad", en: "City view" },
  { code: "bed_twin", es: "Dos camas", en: "Twin beds" },
  { code: "bed_king", es: "Cama grande", en: "King bed" },
  { code: "accessible", es: "Accesible", en: "Accessible" },
  { code: "connecting", es: "Comunicada", en: "Connecting" },
  { code: "crib", es: "Cuna", en: "Crib" }
];

export function togglePreference(current: readonly string[], code: string): string[] {
  return current.includes(code) ? current.filter((value) => value !== code) : [...current, code];
}

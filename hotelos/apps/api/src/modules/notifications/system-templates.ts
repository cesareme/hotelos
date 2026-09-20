// Platform-level ("system") notification templates (Tanda 3 · invitaciones).
//
// `NotificationTemplate` rows are scoped per organization, so a freshly created
// tenant (createTenant / bootstrap) has NO templates at all and the dispatcher
// used to throw `template_not_found` for platform flows such as staff
// invitations and password resets. These built-in plain-text templates are the
// fallback `resolveTemplate` uses when the organization has no active row for
// the (code, channel) pair. They are intentionally minimal and hard-coded here
// (no I/O) so they can be unit-tested and are available before any seed runs.
//
// An organization can still override any of them by creating its own
// `NotificationTemplate` with the same code/channel: DB rows always win.

import type { NotificationTemplateRecord } from "./templates.service.js";
import { BRAND } from "../../lib/brand.js";
import { listTemplateTokensForTemplate } from "./template-renderer.service.js";

export const SYSTEM_TEMPLATE_ORGANIZATION_ID = "system";

export type SystemTemplate = {
  code: string;
  /** Canal del despacho. Para `whatsapp` y `sms` el `subject` va vacío (los proveedores no lo usan). */
  channel: "email" | "whatsapp" | "sms";
  language: string;
  subject: string;
  body: string;
  /** Variables the template expects — documented for the front/admin UI. */
  variables: readonly string[];
};

export const SYSTEM_TEMPLATES: readonly SystemTemplate[] = [
  {
    code: "user_invitation",
    channel: "email",
    language: "es",
    subject: `Invitación a ${BRAND.name} — {{organizationName}}`,
    body: [
      "Hola,",
      "",
      `{{ inviterName | default: "Un administrador" }} te ha invitado a unirte a {{organizationName}} en ${BRAND.name}` +
        '{{ propertyNameSuffix | default: "" }}.',
      "",
      "Para activar tu cuenta y elegir tu contraseña, abre este enlace:",
      "",
      "{{inviteUrl}}",
      "",
      "El enlace es de un solo uso y caduca en {{expiryHours}} horas. Si caduca,",
      "pide a tu administrador que te reenvíe la invitación.",
      "",
      "Si no esperabas este correo, puedes ignorarlo.",
      "",
      `— ${BRAND.name}`
    ].join("\n"),
    variables: ["inviteUrl", "inviterName", "organizationName", "propertyName", "propertyNameSuffix", "expiryHours"]
  },
  {
    code: "password_reset",
    channel: "email",
    language: "es",
    subject: `Restablecer tu contraseña — ${BRAND.name}`,
    body: [
      "Hola {{userName}},",
      "",
      `Hemos recibido una solicitud para restablecer la contraseña de tu cuenta en ${BRAND.name}.`,
      "Abre este enlace para elegir una contraseña nueva:",
      "",
      "{{resetUrl}}",
      "",
      "El enlace caduca en {{expiryMinutes}} minutos y solo puede usarse una vez.",
      "",
      "Si no has solicitado este cambio, ignora este correo: tu contraseña actual",
      "seguirá siendo válida.",
      "",
      `— ${BRAND.name}`
    ].join("\n"),
    variables: ["resetUrl", "userName", "expiryMinutes"]
  },

  // ---------------------------------------------------------------------------
  // Check-in automatizado (Tanda CHK · W2-D, diseño §4a paso 1, §4c «Bienvenida»,
  // §2.6). Plantillas de sistema para que un tenant recién creado pueda invitar,
  // recordar, dar la bienvenida y verificar por OTP sin `template_not_found`.
  // Reglas: texto en español (la invitación también en inglés), la marca solo
  // en el pie, aviso de IA (AI Act art. 50) en la bienvenida porque enlaza al
  // asistente, y sin HTML. En WhatsApp estos cuerpos solo valen DENTRO de la
  // ventana de 24 h; fuera de ella el proveedor exige una plantilla aprobada
  // (`ProviderSendInput.template`), que el hotel registra en Meta con estos
  // mismos textos (§2.6). El renderer no tiene condicionales: los datos que
  // pueden faltar (habitación, wifi, horario, enlace al bot) llevan
  // `| default:` con una alternativa honesta («consulta en recepción»).
  // `guest_magic_link` sigue fuera a propósito (invitations.test.mts).
  // ---------------------------------------------------------------------------
  {
    code: "checkin_invitation",
    channel: "email",
    language: "es",
    subject: "Prepara tu llegada a {{propertyName}}: check-in en línea",
    body: [
      "Hola {{guestFirstName}},",
      "",
      "Tu llegada a {{propertyName}} está prevista para el {{arrivalDate}}. Puedes hacer el check-in",
      "desde el móvil ahora y evitar la espera en recepción:",
      "",
      "{{checkInUrl}}",
      "",
      "Solo necesitas tu documento de identidad (DNI, NIE o pasaporte) y unos minutos:",
      "verificamos la identidad, firmas el parte de viajeros y, si quieres, eliges tus",
      "preferencias y la hora de llegada.",
      "",
      "El enlace es personal. Si no has hecho esta reserva, ignora este mensaje.",
      "",
      `— {{propertyName}} · enviado con ${BRAND.name}`
    ].join("\n"),
    variables: ["guestFirstName", "propertyName", "arrivalDate", "checkInUrl"]
  },
  {
    code: "checkin_invitation",
    channel: "email",
    language: "en",
    subject: "Get ready for your stay at {{propertyName}}: online check-in",
    body: [
      "Hello {{guestFirstName}},",
      "",
      "You are expected at {{propertyName}} on {{arrivalDate}}. You can check in from your",
      "phone now and skip the queue at the front desk:",
      "",
      "{{checkInUrl}}",
      "",
      "You only need your ID document (national ID, residence card or passport) and a few",
      "minutes: we verify your identity, you sign the guest registration form and, if you",
      "wish, choose your preferences and arrival time.",
      "",
      "This link is personal. If you did not make this booking, please ignore this message.",
      "",
      `— {{propertyName}} · sent with ${BRAND.name}`
    ].join("\n"),
    variables: ["guestFirstName", "propertyName", "arrivalDate", "checkInUrl"]
  },
  {
    code: "checkin_invitation",
    channel: "whatsapp",
    language: "es",
    subject: "",
    body: [
      "Hola {{guestFirstName}}, te esperamos en {{propertyName}} el {{arrivalDate}}.",
      "Haz el check-in desde el móvil y evita la cola en recepción (necesitarás tu documento de identidad):",
      "{{checkInUrl}}",
      "Si no has hecho esta reserva, ignora este mensaje.",
      `Enviado con ${BRAND.name}`
    ].join("\n"),
    variables: ["guestFirstName", "propertyName", "arrivalDate", "checkInUrl"]
  },

  {
    code: "checkin_reminder",
    channel: "email",
    language: "es",
    subject: "Mañana te esperamos en {{propertyName}}: completa tu check-in",
    body: [
      "Hola {{guestFirstName}},",
      "",
      "Llegas a {{propertyName}} el {{arrivalDate}} y tu check-in en línea sigue pendiente.",
      "Complétalo ahora y tendrás la habitación preparada a tu llegada:",
      "",
      "{{checkInUrl}}",
      "",
      "Te llevará unos minutos: documento de identidad, firma del parte de viajeros y hora",
      "de llegada.",
      "",
      "Si prefieres hacerlo en recepción, no tienes que hacer nada.",
      "",
      `— {{propertyName}} · enviado con ${BRAND.name}`
    ].join("\n"),
    variables: ["guestFirstName", "propertyName", "arrivalDate", "checkInUrl"]
  },
  {
    code: "checkin_reminder",
    channel: "whatsapp",
    language: "es",
    subject: "",
    body: [
      "Hola {{guestFirstName}}, llegas a {{propertyName}} el {{arrivalDate}} y tu check-in en línea sigue pendiente.",
      "Complétalo en unos minutos y tendrás la habitación preparada: {{checkInUrl}}",
      "Si prefieres hacerlo en recepción, no tienes que hacer nada.",
      `Enviado con ${BRAND.name}`
    ].join("\n"),
    variables: ["guestFirstName", "propertyName", "arrivalDate", "checkInUrl"]
  },

  {
    code: "checkin_welcome",
    channel: "email",
    language: "es",
    subject: "Bienvenido/a a {{propertyName}}",
    body: [
      "Hola {{guestFirstName}},",
      "",
      '¡Bienvenido/a a {{propertyName}}! Tu habitación es la {{ roomNumber | default: "que te indicarán en recepción" }}.',
      "",
      'Wifi: {{ wifiName | default: "consulta en recepción" }} · contraseña: {{ wifiPassword | default: "consulta en recepción" }}',
      'Desayuno: {{ breakfastHours | default: "consulta el horario en recepción" }}',
      "",
      '¿Necesitas algo durante la estancia? Escríbenos aquí: {{ botUrl | default: "en recepción" }}',
      "Te responderá un asistente de inteligencia artificial del hotel; puedes pedir hablar con una",
      "persona del equipo en cualquier momento.",
      "",
      "Que disfrutes de tu estancia.",
      "",
      `— {{propertyName}} · enviado con ${BRAND.name}`
    ].join("\n"),
    variables: ["guestFirstName", "propertyName", "roomNumber", "wifiName", "wifiPassword", "breakfastHours", "botUrl"]
  },
  {
    code: "checkin_welcome",
    channel: "whatsapp",
    language: "es",
    subject: "",
    body: [
      "Hola {{guestFirstName}}, ¡bienvenido/a a {{propertyName}}!",
      'Habitación: {{ roomNumber | default: "te la indican en recepción" }}.',
      'Wifi: {{ wifiName | default: "consulta en recepción" }} · contraseña: {{ wifiPassword | default: "consulta en recepción" }}.',
      'Desayuno: {{ breakfastHours | default: "consulta el horario en recepción" }}.',
      '¿Dudas? Escríbenos: {{ botUrl | default: "en recepción" }} (te atiende un asistente de inteligencia artificial del hotel; pide hablar con una persona cuando quieras).',
      `Enviado con ${BRAND.name}`
    ].join("\n"),
    variables: ["guestFirstName", "propertyName", "roomNumber", "wifiName", "wifiPassword", "breakfastHours", "botUrl"]
  },
  {
    code: "checkin_welcome",
    channel: "sms",
    language: "es",
    subject: "",
    body: [
      "{{propertyName}}: bienvenido/a, {{guestFirstName}}.",
      'Habitación {{ roomNumber | default: "en recepción" }}. Wifi {{ wifiName | default: "en recepción" }} / {{ wifiPassword | default: "en recepción" }}. Desayuno {{ breakfastHours | default: "en recepción" }}.',
      'Asistente de IA del hotel (puedes pedir una persona): {{ botUrl | default: "en recepción" }}',
      BRAND.name
    ].join("\n"),
    variables: ["guestFirstName", "propertyName", "roomNumber", "wifiName", "wifiPassword", "breakfastHours", "botUrl"]
  },

  {
    code: "checkin_otp",
    channel: "email",
    language: "es",
    subject: "Tu código de verificación para {{propertyName}}",
    body: [
      "Hola {{guestFirstName}},",
      "",
      "Tu código para verificar tu identidad en el check-in de {{propertyName}} es:",
      "",
      "{{otpCode}}",
      "",
      "Caduca en pocos minutos y solo puede usarse una vez. No lo compartas con nadie.",
      "Si no lo has solicitado, ignora este mensaje: nadie puede completar el check-in sin él.",
      "",
      `— {{propertyName}} · enviado con ${BRAND.name}`
    ].join("\n"),
    variables: ["guestFirstName", "propertyName", "otpCode"]
  },
  {
    code: "checkin_otp",
    channel: "sms",
    language: "es",
    subject: "",
    body: ["{{propertyName}}: tu código de verificación es {{otpCode}}. Caduca en pocos minutos; no lo compartas.", BRAND.name].join("\n"),
    variables: ["propertyName", "otpCode"]
  }
];

/**
 * Find the built-in template for a (code, channel) pair. Exact language match
 * first, then the "es" system default. Returns null when the platform has no
 * built-in template for that code (the caller decides whether that is an error).
 */
export function resolveSystemTemplate(input: {
  code: string;
  channel: string;
  language?: string;
}): SystemTemplate | null {
  const language = input.language ?? "es";
  const matches = SYSTEM_TEMPLATES.filter((tpl) => tpl.code === input.code && tpl.channel === input.channel);
  if (matches.length === 0) return null;
  return matches.find((tpl) => tpl.language === language) ?? matches.find((tpl) => tpl.language === "es") ?? matches[0] ?? null;
}

/**
 * Shape a system template as a `NotificationTemplateRecord` so the dispatcher
 * can consume it exactly like a DB row. The synthetic id makes the origin
 * visible in logs/deliveries (`system:user_invitation:email:es`).
 */
export function systemTemplateToRecord(tpl: SystemTemplate): NotificationTemplateRecord {
  const stamp = new Date(0).toISOString();
  return {
    id: `system:${tpl.code}:${tpl.channel}:${tpl.language}`,
    organizationId: SYSTEM_TEMPLATE_ORGANIZATION_ID,
    propertyId: null,
    code: tpl.code,
    channel: tpl.channel,
    language: tpl.language,
    subject: tpl.subject,
    body: tpl.body,
    variablesJson: { variables: [...tpl.variables] },
    active: true,
    createdAt: stamp,
    updatedAt: stamp,
    tokens: listTemplateTokensForTemplate({ body: tpl.body, subject: tpl.subject })
  };
}

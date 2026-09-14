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
import { listTemplateTokensForTemplate } from "./template-renderer.service.js";

export const SYSTEM_TEMPLATE_ORGANIZATION_ID = "system";

export type SystemTemplate = {
  code: string;
  channel: "email";
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
    subject: "Invitación a Anfitorio — {{organizationName}}",
    body: [
      "Hola,",
      "",
      '{{ inviterName | default: "Un administrador" }} te ha invitado a unirte a {{organizationName}} en Anfitorio' +
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
      "— Anfitorio"
    ].join("\n"),
    variables: ["inviteUrl", "inviterName", "organizationName", "propertyName", "propertyNameSuffix", "expiryHours"]
  },
  {
    code: "password_reset",
    channel: "email",
    language: "es",
    subject: "Restablecer tu contraseña — Anfitorio",
    body: [
      "Hola {{userName}},",
      "",
      "Hemos recibido una solicitud para restablecer la contraseña de tu cuenta en Anfitorio.",
      "Abre este enlace para elegir una contraseña nueva:",
      "",
      "{{resetUrl}}",
      "",
      "El enlace caduca en {{expiryMinutes}} minutos y solo puede usarse una vez.",
      "",
      "Si no has solicitado este cambio, ignora este correo: tu contraseña actual",
      "seguirá siendo válida.",
      "",
      "— Anfitorio"
    ].join("\n"),
    variables: ["resetUrl", "userName", "expiryMinutes"]
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

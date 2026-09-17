// Esquema zod de `POST /properties/:propertyId/email/connections` (Tanda 7b · L3).
// Hasta ahora el cuerpo se pasaba tal cual a createConnection; con el propósito
// `pms_shadow` (buzón del hotel al que el Report Scheduler de OPERA envía los
// informes) el cuerpo gana `purpose`, `fromDomain` y `subjectContains`, y pasa
// a ser `.strict()` (clave desconocida → 400 VALIDATION_ERROR en español).
//
// Compatibilidad con el front (apps/admin-web/src/screens/aiOperations/
// EmailConnectorsScreen.tsx): el payload real es `{ provider }` y, para imap,
// `{ host, username, password, port: 993 }` — todas admitidas; ninguna clave
// existente queda rechazada. `purpose` por defecto `reservation_ai` (el flujo IA →
// revisión humana de siempre).

import { z } from "zod";

export const EMAIL_CONNECTION_PROVIDERS = ["gmail", "microsoft", "imap", "manual"] as const;
export type EmailConnectionProvider = (typeof EMAIL_CONNECTION_PROVIDERS)[number];

/** `reservation_ai`: extraer reservas con IA (HITL) · `pms_shadow`: entregar los adjuntos al ingest del modo sombra. */
export const EMAIL_CONNECTION_PURPOSES = ["reservation_ai", "pms_shadow"] as const;
export type EmailConnectionPurpose = (typeof EMAIL_CONNECTION_PURPOSES)[number];

export const EMAIL_CONNECTION_MAX_FILTER = 120;

export const CreateEmailConnectionSchema = z
  .object({
    provider: z.enum(EMAIL_CONNECTION_PROVIDERS, { errorMap: () => ({ message: `provider debe ser uno de: ${EMAIL_CONNECTION_PROVIDERS.join(", ")}.` }) }),
    emailAddress: z.string({ invalid_type_error: "emailAddress debe ser un texto." }).trim().email({ message: "emailAddress debe ser una dirección de correo válida." }).max(200).optional(),
    host: z.string({ invalid_type_error: "host debe ser un texto." }).trim().min(1, { message: "host no puede estar vacío." }).max(200, { message: "host no puede superar 200 caracteres." }).optional(),
    port: z.coerce.number({ invalid_type_error: "port debe ser un entero entre 1 y 65535." }).int({ message: "port debe ser un entero entre 1 y 65535." }).min(1, { message: "port debe ser un entero entre 1 y 65535." }).max(65535, { message: "port debe ser un entero entre 1 y 65535." }).optional(),
    username: z.string({ invalid_type_error: "username debe ser un texto." }).trim().min(1, { message: "username no puede estar vacío." }).max(200, { message: "username no puede superar 200 caracteres." }).optional(),
    password: z.string({ invalid_type_error: "password debe ser un texto." }).min(1, { message: "password no puede estar vacío." }).max(500, { message: "password no puede superar 500 caracteres." }).optional(),
    purpose: z.enum(EMAIL_CONNECTION_PURPOSES, { errorMap: () => ({ message: `purpose debe ser uno de: ${EMAIL_CONNECTION_PURPOSES.join(", ")}.` }) }).default("reservation_ai"),
    fromDomain: z
      .string({ invalid_type_error: "fromDomain debe ser un texto." })
      .trim()
      .min(1, { message: "fromDomain no puede estar vacío." })
      .max(EMAIL_CONNECTION_MAX_FILTER, { message: `fromDomain no puede superar ${EMAIL_CONNECTION_MAX_FILTER} caracteres.` })
      .optional(),
    subjectContains: z
      .string({ invalid_type_error: "subjectContains debe ser un texto." })
      .trim()
      .min(1, { message: "subjectContains no puede estar vacío." })
      .max(EMAIL_CONNECTION_MAX_FILTER, { message: `subjectContains no puede superar ${EMAIL_CONNECTION_MAX_FILTER} caracteres.` })
      .optional()
  })
  .strict({ message: "Campo no admitido en el cuerpo de la petición." })
  // SEC-03: un buzón `pms_shadow` sin filtro de remitente aceptaría de CUALQUIER dirección adjuntos que
  // contabilizan asientos (revenue) o cancelan reservas (changes): `fromDomain` es obligatorio para ese
  // propósito (y el runbook recomienda además `subjectContains`). La comparación sigue siendo sobre el
  // texto del From; la verificación DKIM/SPF (`Authentication-Results`) queda documentada como pendiente.
  .refine((body) => body.purpose !== "pms_shadow" || typeof body.fromDomain === "string", {
    message: "fromDomain es obligatorio para purpose pms_shadow: el buzón solo debe aceptar adjuntos del remitente del Report Scheduler / SFTP de OPERA.",
    path: ["fromDomain"]
  });
export type CreateEmailConnectionInput = z.infer<typeof CreateEmailConnectionSchema>;

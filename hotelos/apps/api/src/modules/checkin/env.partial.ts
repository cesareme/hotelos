// Variables de entorno del módulo de check-in automatizado (Tanda CHK · lote
// W2-A). Mismo formato que ENV_CONTRACT en apps/api/src/lib/env.ts (patrón de
// modules/reputation/env.partial.ts): lib/env.ts hace spread de
// CHECKIN_ENV_CONTRACT tras REPUTATION_ENV_CONTRACT y `node scripts/env-census.mjs
// --write` regenera scripts/env-contract.json, .env.example y
// deploy/.env.production.example.
//
// Decisiones:
//   · No existe la sección «Guest portal» en EnvSection: los interruptores del
//     job van a «Schedulers», las vidas de OTP/emparejamiento y la purga de
//     capturas a «Seguridad» y los límites de tamaño a «Rate limit/CORS», junto
//     a GUEST_WEB_BASE_URL (origen del portal del huésped).
//   · Lectura única en modules/checkin/checkin-config.ts (readCheckInConfig):
//     ningún servicio del módulo lee process.env; signature-storage.ts (lote
//     W2-C) lee CHECKIN_SIGNATURE_MAX_BYTES por su cuenta con respaldo de 256 KiB
//     mientras el contrato documenta 512 KiB (deuda anotada en el informe).
//   · Los jobs corren en el API bajo el líder (RUN_SCHEDULERS), como reputación.
//   · W4-D: WHATSAPP_APP_SECRET y WHATSAPP_VERIFY_TOKEN (webhook de entrada de
//     la Cloud API, routes/webhooks-whatsapp.routes.ts) van a «Email y
//     mensajería» junto a WHATSAPP_PHONE_ID / WHATSAPP_PROVIDER_TOKEN.

import type { EnvContract } from "../../lib/env.js";

export const CHECKIN_ENV_CONTRACT: EnvContract = Object.freeze({
  CHECKIN_INVITATION_DISABLED: {
    section: "Schedulers",
    format: "bool",
    default: "false",
    doc: "true desactiva el job de invitaciones al check-in en línea (invitación J-3 y recordatorio J-1). Solo actúa en el líder (RUN_SCHEDULERS)."
  },
  CHECKIN_INVITATION_INTERVAL_MS: {
    section: "Schedulers",
    format: "int",
    min: 60_000,
    max: 86_400_000,
    default: "3600000",
    doc: "Periodo del job de invitaciones al check-in (ms); por defecto 1 hora (mínimo 1 minuto, máximo 24 horas)."
  },
  CHECKIN_ASSIGNMENT_RUN_AT: {
    section: "Schedulers",
    format: "string",
    pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$",
    default: "18:00",
    doc: "Hora local (Europe/Madrid, HH:MM) del lote diario de sugerencias de habitación para las llegadas del día siguiente."
  },
  CHECKIN_OTP_TTL_MS: {
    section: "Seguridad",
    format: "int",
    min: 60_000,
    max: 3_600_000,
    default: "600000",
    doc: "Vida del código OTP de verificación de identidad del huésped (ms); por defecto 10 minutos."
  },
  CHECKIN_OTP_MAX_ATTEMPTS: {
    section: "Seguridad",
    format: "int",
    min: 1,
    max: 20,
    default: "5",
    doc: "Intentos de OTP admitidos por sesión de check-in antes de responder 429."
  },
  KIOSK_PAIRING_TTL_MS: {
    section: "Seguridad",
    format: "int",
    min: 60_000,
    max: 3_600_000,
    default: "600000",
    doc: "Vida del código de 8 dígitos de emparejamiento de un kiosco (ms); por defecto 10 minutos. Solo se guarda su hash."
  },
  CHECKIN_CAPTURE_PURGE_DAYS: {
    section: "Seguridad",
    format: "int",
    min: 1,
    max: 365,
    default: "30",
    doc: "Días tras los que se vacían los campos extraídos (fieldsJson/confidenceJson) de document_captures; queda solo la métrica. La imagen del documento nunca se guarda."
  },
  CHECKIN_DOCUMENT_MAX_BYTES: {
    section: "Rate limit/CORS",
    format: "int",
    min: 65_536,
    max: 16_777_216,
    default: "6291456",
    doc: "Bytes máximos (decodificados) de la imagen de un documento de identidad enviada al portal o al kiosco; por defecto 6 MiB."
  },
  CHECKIN_SIGNATURE_MAX_BYTES: {
    section: "Rate limit/CORS",
    format: "int",
    min: 16_384,
    max: 4_194_304,
    default: "524288",
    doc: "Bytes máximos (decodificados) del PNG/SVG de la firma del parte de viajeros; por defecto 512 KiB."
  },
  WHATSAPP_APP_SECRET: {
    section: "Email y mensajería",
    format: "string",
    tags: ["secret"],
    doc: "App Secret de la app de Meta que firma el webhook de entrada de WhatsApp (X-Hub-Signature-256 sobre el cuerpo crudo de POST /webhooks/whatsapp). Sin él el webhook responde 503 en cualquier entorno salvo que WHATSAPP_WEBHOOK_ALLOW_UNSIGNED=1 fuera de producción (corrector CHK SEC-5)."
  },
  WHATSAPP_WEBHOOK_ALLOW_UNSIGNED: {
    section: "Email y mensajería",
    format: "bool",
    tags: ["dangerous"],
    default: "false",
    doc: "Solo demo/staging y NUNCA en producción: con 1/true y sin WHATSAPP_APP_SECRET, POST /webhooks/whatsapp procesa cuerpos SIN firma como SIMULADO (escriben ETA y peticiones de servicio del bot). Sin la variable el webhook sin secreto responde 503, como el de pagos."
  },
  WHATSAPP_VERIFY_TOKEN: {
    section: "Email y mensajería",
    format: "string",
    tags: ["secret"],
    doc: "Verify token que se declara en Meta al suscribir el webhook: GET /webhooks/whatsapp devuelve hub.challenge solo si hub.verify_token coincide. Sin él la verificación responde 503."
  }
});

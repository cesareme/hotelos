// Environment contract (Tanda 4 · DATA-04 / AUTH-08).
//
// Single source of truth for every environment variable the runtime reads.
// - ENV_CONTRACT documents each variable (section, when it is required, its
//   format, default, how to generate it). scripts/env-census.mjs greps the
//   code base, fails when a variable is read but not documented here, and
//   renders scripts/env-contract.json, .env.example and
//   deploy/.env.production.example from it.
// - validateEnv() applies the formats and the production policy to a given
//   env and returns { errors, warnings } without side effects.
// - assertEnv() is called at the top of buildApiServer: with
//   NODE_ENV=production it throws with the complete list of errors (fail
//   fast, no half-configured boot); elsewhere it prints the findings once.
// - resolveCorsOrigins() normalises CORS_ALLOWED_ORIGINS (+ the deprecated
//   PILOT_PUBLIC_ORIGIN alias) for the CORS plugin in server.ts.
//
// scripts/validate-env.mjs re-implements the generic rules over the JSON so a
// VPS without TypeScript can pre-flight a .env file; keep both in sync via
// tests/env-contract.test.mjs.
import { CHANNEL_MANAGER_ENV_CONTRACT } from "../modules/channel-manager/env.partial.js";
import { accessSync, constants as fsConstants } from "node:fs";
import { z } from "zod";
import { isValidSpanishTaxId, resolveVerifactuCredentials, resolveVerifactuSoftware } from "@hotelos/compliance";

export type EnvSection =
  | "Proceso"
  | "BD y colas"
  | "Seguridad"
  | "Auth/demo flags"
  | "Rate limit/CORS"
  | "Email y mensajería"
  | "VeriFactu"
  | "SES"
  | "TBAI"
  | "IGIC"
  | "Schedulers"
  | "IA"
  | "OTA"
  | "Wallet"
  | "Sentry"
  | "Frontend"
  | "Seeds"
  | "Tests";

/**
 * When a variable must be present. `{ when }` uses a tiny grammar evaluated
 * against the *effective* values (raw value, or the contract default):
 *   "VERIFACTU_MODE!=sandbox"            — effective value differs
 *   "TBAI_MODE=production"               — effective value equals
 *   "EMAIL_PROVIDER"                     — defined and not a placeholder
 *   "!VERIFACTU_CERT_PATH"               — empty / placeholder
 * Clauses can be joined with " && ".
 */
export type EnvRequired = "always" | "production" | { when: string };

export type EnvFormat =
  | "url"
  | "postgres-url"
  | "base64-32"
  | "int"
  | "bool"
  | "enum"
  | "nif"
  | "path"
  | "origin-list"
  | "string";

export type EnvTag =
  | "secret"
  | "test"
  | "fiscal-real"
  | "deprecated"
  | "dangerous"
  | "dev-only"
  | "tool";

export type EnvVarSpec = {
  section: EnvSection;
  /** Omitted = optional. */
  required?: EnvRequired;
  format: EnvFormat;
  /** Effective value when unset (documentation + condition evaluation). */
  default?: string;
  /** User-facing explanation (Spanish), rendered into the example files. */
  doc: string;
  /** enum only. */
  values?: readonly string[];
  /** int only. */
  min?: number;
  max?: number;
  /** string only. */
  minLength?: number;
  maxLength?: number;
  /** string only: regex source the value must match (also applied by validate-env.mjs). */
  pattern?: string;
  /** url only: must be an origin — scheme://host[:port], no path, no trailing slash. */
  origin?: boolean;
  /** url only: in production the scheme must be https. */
  httpsInProduction?: boolean;
  /** Extra placeholder values that count as "not set" for this variable. */
  forbidden?: readonly string[];
  /** In production this exact value is an error (test/demo flags). */
  productionForbidden?: string;
  /** In production a different value only warns (e.g. TRUST_PROXY should be "1"). */
  productionWarnUnless?: string;
  /** `required` is satisfied when any of these variables is set instead. */
  alternatives?: readonly string[];
  /** "warn": format violations never become errors (tooling variables). */
  severity?: "error" | "warn";
  /** Value written to .env.example (and to the production example unless productionExample is set). */
  example?: string;
  productionExample?: string;
  /** Command that produces a valid value (secrets). */
  generate?: string;
  tags?: readonly EnvTag[];
};

export type EnvContract = Readonly<Record<string, EnvVarSpec>>;

/** Values that every reader in the code base treats as "not configured". */
export const PLACEHOLDER_VALUES: readonly string[] = Object.freeze(["", "change-me", "changeme", "todo", "your-key-here", "placeholder"]);

const BOOL: Pick<EnvVarSpec, "format"> = { format: "bool" };
const INTERVAL: Pick<EnvVarSpec, "format" | "min" | "max"> = { format: "int", min: 10_000, max: 86_400_000 };
const FISCAL_MODE_VALUES = ["sandbox", "preproduction", "production"] as const;
const ADAPTER_MODE_VALUES = ["stub", "real"] as const;

/**
 * The contract. Order matters: sections and keys are rendered into the
 * example files in this order.
 */
export const ENV_CONTRACT: EnvContract = Object.freeze({
  // ---------------------------------------------------------------- Proceso
  NODE_ENV: {
    section: "Proceso",
    format: "enum",
    values: ["development", "test", "production"],
    default: "development",
    example: "development",
    productionExample: "production",
    doc:
      "Modo del proceso. Con production: RBAC estricto por defecto, la clave de cifrado de PII es obligatoria (aborta el arranque), se rechaza HOTELOS_ALLOW_DEMO_AUTH y las validaciones de este contrato son errores en vez de avisos. Otros valores (prod, Production…) se rechazan porque el código compara el literal."
  },
  PORT: {
    section: "Proceso",
    format: "int",
    min: 1,
    max: 65535,
    default: "3000",
    doc: "Puerto TCP del API (el ai-gateway usa 3100 por defecto)."
  },
  HOST: {
    section: "Proceso",
    format: "string",
    default: "0.0.0.0",
    doc: "Interfaz de escucha. En un despliegue nativo detrás de Caddy usa 127.0.0.1 para no exponer el puerto 3000; el compose fuerza 0.0.0.0 (red interna de contenedores)."
  },
  APP_VERSION: {
    section: "Proceso",
    format: "string",
    maxLength: 50,
    default: "dev",
    doc: "Versión desplegada: se muestra en /health y es el valor por defecto de VERIFACTU_SYSTEM_VERSION."
  },
  DATABASE_LOG_LEVEL: {
    section: "Proceso",
    format: "enum",
    values: ["off", "query", "info", "warn", "error"],
    default: "info",
    doc: "Nivel de log de Prisma. Sin definir: warn en producción e info en desarrollo."
  },

  // ------------------------------------------------------------ BD y colas
  DATABASE_URL: {
    section: "BD y colas",
    required: "always",
    format: "postgres-url",
    example: "postgresql://hotelos:hotelos@localhost:5432/hotelos",
    productionExample: "",
    tags: ["secret"],
    doc:
      "Conexión Postgres de Prisma y pg-boss. En el compose de producción se ensambla desde POSTGRES_USER/PASSWORD/DB (déjala vacía ahí); en un despliegue nativo (systemd) es obligatoria."
  },
  REDIS_URL: {
    section: "BD y colas",
    format: "string",
    pattern: "^redis(s)?://",
    example: "redis://localhost:6379",
    productionExample: "",
    doc: "Reservada: hoy no hay cliente Redis (el rate-limit es en memoria); solo se refleja en /health. El compose la fija a redis://redis:6379."
  },

  // ------------------------------------------------------------- Seguridad
  JWT_SECRET: {
    section: "Seguridad",
    required: "always",
    format: "string",
    minLength: 32,
    tags: ["secret"],
    generate: "openssl rand -base64 48",
    doc: "Firma los JWT de sesión. Vacía o con el valor de ejemplo el API arranca pero rechaza el primer login."
  },
  ENCRYPTION_KEY: {
    section: "Seguridad",
    required: "production",
    format: "base64-32",
    alternatives: ["HOTELOS_FIELD_KEY"],
    tags: ["secret"],
    generate: "openssl rand -base64 32",
    doc:
      "Clave AES-256-GCM de los campos PII de huéspedes (fallback de HOTELOS_FIELD_KEY). En producción sin una clave válida el API aborta el arranque; en desarrollo avisa y guarda la PII en claro. Rotarla deja ilegible lo ya cifrado: haz backup antes."
  },
  HOTELOS_FIELD_KEY: {
    section: "Seguridad",
    format: "base64-32",
    tags: ["secret"],
    generate: "openssl rand -base64 32",
    doc: "Clave de cifrado de campos PII con prioridad sobre ENCRYPTION_KEY. Cadena de fallback: HOTELOS_FIELD_KEY → ENCRYPTION_KEY."
  },
  HOTELOS_LOOKUP_HASH_KEY: {
    section: "Seguridad",
    format: "string",
    minLength: 16,
    tags: ["secret"],
    generate: "openssl rand -base64 32",
    doc: "Clave HMAC de los hashes de búsqueda por igualdad (email, documento). Fallback: HOTELOS_FIELD_KEY → ENCRYPTION_KEY. Acepta base64 o texto."
  },
  BOOTSTRAP_TOKEN: {
    section: "Seguridad",
    format: "string",
    minLength: 32,
    tags: ["secret"],
    generate: "openssl rand -hex 32",
    doc: "Token del endpoint POST /onboarding/bootstrap (primera organización de una instalación real). Se desactiva solo en cuanto existe una organización."
  },

  // ------------------------------------------------------- Auth/demo flags
  HOTELOS_ALLOW_DEMO_AUTH: {
    section: "Auth/demo flags",
    ...BOOL,
    default: "false",
    example: "false",
    productionForbidden: "true",
    doc:
      "true SOLO en dev/demo: toda petición sin token recibe el super-usuario demo. Con NODE_ENV=production el API se niega a arrancar (AUTH-04) salvo HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE=true. El demo local lo pone a true en su .env."
  },
  HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE: {
    section: "Auth/demo flags",
    ...BOOL,
    default: "false",
    tags: ["dangerous"],
    doc: "Escape PELIGROSO del guard anterior: permite HOTELOS_ALLOW_DEMO_AUTH=true en producción (demo pública sin datos reales). Nunca en un despliegue de cliente."
  },
  RBAC_STRICT: {
    section: "Auth/demo flags",
    ...BOOL,
    productionForbidden: "false",
    productionExample: "true",
    doc: "RBAC estricto: un GET sin entrada en el manifiesto de permisos devuelve 403. Vacía = estricto en producción y fail-open con aviso en desarrollo. false está prohibido en producción."
  },
  TENANT_BOOTSTRAP_SKIP: {
    section: "Auth/demo flags",
    ...BOOL,
    default: "false",
    productionForbidden: "true",
    tags: ["test"],
    doc: "Salta la sincronización del catálogo RBAC y la hidratación de tenants al arrancar. Solo tests."
  },

  // ------------------------------------------------------- Rate limit/CORS
  RATE_LIMIT_MAX: {
    section: "Rate limit/CORS",
    format: "int",
    min: 1,
    max: 100_000,
    default: "600",
    doc: "Peticiones por minuto y por usuario+IP antes de responder 429."
  },
  TRUST_PROXY: {
    section: "Rate limit/CORS",
    format: "enum",
    values: ["0", "1"],
    productionWarnUnless: "1",
    productionExample: "1",
    doc: "1 detrás de Caddy/nginx para leer X-Forwarded-For; si no, el rate-limit agrupa todo en la IP del proxy. Solo se acepta el literal 1."
  },
  CORS_ALLOWED_ORIGINS: {
    section: "Rate limit/CORS",
    format: "origin-list",
    productionExample: "https://app.example.com",
    doc:
      "Orígenes (scheme://host[:puerto]) autorizados por CORS, separados por comas. Fuera de producción se admiten además localhost/127.0.0.1 en cualquier puerto. Vacía en producción = solo same-origin (Caddy sirve SPA y API en el mismo origen)."
  },
  CORS_ALLOW_LAN: {
    section: "Rate limit/CORS",
    ...BOOL,
    default: "false",
    tags: ["dev-only"],
    doc: "Solo desarrollo: true admite además los rangos privados 10/8, 172.16/12 y 192.168/16 (tablets del hotel contra un portátil). Ignorada en producción."
  },
  PILOT_PUBLIC_ORIGIN: {
    section: "Rate limit/CORS",
    format: "url",
    origin: true,
    tags: ["deprecated"],
    doc: "OBSOLETA: alias de un único origen que se fusiona en CORS_ALLOWED_ORIGINS. Migra el valor allí."
  },
  APP_BASE_URL: {
    section: "Rate limit/CORS",
    required: "production",
    format: "url",
    origin: true,
    httpsInProduction: true,
    default: "http://localhost:5173",
    example: "http://localhost:5173",
    productionExample: "https://app.example.com",
    doc: "Origen público del admin-web: construye los enlaces /accept-invite y /reset-password de los emails. Sin barra final; https en producción."
  },
  GUEST_WEB_BASE_URL: {
    section: "Rate limit/CORS",
    format: "url",
    origin: true,
    httpsInProduction: true,
    default: "http://localhost:5174",
    doc: "Origen público del portal de huéspedes (magic links). Sin barra final."
  },
  API_PUBLIC_URL: {
    section: "Rate limit/CORS",
    format: "url",
    httpsInProduction: true,
    default: "http://localhost:3000",
    productionExample: "https://app.example.com/api",
    doc: "URL pública del API para los callbacks OAuth de las bandejas de correo (Gmail/Microsoft). Sin barra final."
  },

  // ---------------------------------------------------- Email y mensajería
  EMAIL_PROVIDER: {
    section: "Email y mensajería",
    format: "enum",
    values: ["postmark", "sendgrid"],
    doc:
      "Proveedor de email saliente (invitaciones, reset de contraseña, magic links). Vacío = envío simulado en desarrollo (la API devuelve el enlace) y 'disabled' en producción. Los tres EMAIL_* van juntos."
  },
  EMAIL_PROVIDER_KEY: {
    section: "Email y mensajería",
    required: { when: "EMAIL_PROVIDER" },
    format: "string",
    tags: ["secret"],
    doc: "API key del proveedor de email."
  },
  EMAIL_FROM: {
    section: "Email y mensajería",
    required: { when: "EMAIL_PROVIDER" },
    format: "string",
    pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
    doc: "Remitente verificado en el proveedor (ej. no-reply@tu-hotel.com)."
  },
  TWILIO_ACCOUNT_SID: {
    section: "Email y mensajería",
    format: "string",
    doc: "SMS vía Twilio (con TWILIO_AUTH_TOKEN y TWILIO_FROM). Sin configurar: simulado en desarrollo, fallo explícito en producción."
  },
  TWILIO_AUTH_TOKEN: {
    section: "Email y mensajería",
    required: { when: "TWILIO_ACCOUNT_SID" },
    format: "string",
    tags: ["secret"],
    doc: "Auth token de la cuenta Twilio."
  },
  TWILIO_FROM: {
    section: "Email y mensajería",
    required: { when: "TWILIO_ACCOUNT_SID" },
    format: "string",
    pattern: "^\\+[1-9]\\d{6,14}$",
    doc: "Número remitente en formato E.164 (+34600000000)."
  },
  WHATSAPP_PHONE_ID: {
    section: "Email y mensajería",
    format: "string",
    doc: "WhatsApp Business (Meta Cloud API): id del número de teléfono."
  },
  WHATSAPP_PROVIDER_TOKEN: {
    section: "Email y mensajería",
    required: { when: "WHATSAPP_PHONE_ID" },
    format: "string",
    tags: ["secret"],
    doc: "Token Bearer de la Meta Cloud API."
  },
  WHATSAPP_TOKEN: {
    section: "Email y mensajería",
    format: "string",
    tags: ["secret", "deprecated"],
    doc: "OBSOLETA: alias de WHATSAPP_PROVIDER_TOKEN."
  },
  GMAIL_CLIENT_ID: {
    section: "Email y mensajería",
    format: "string",
    doc: "OAuth de Google para leer reservas desde una bandeja Gmail (integración de correo). Vacío = integración desactivada."
  },
  GMAIL_CLIENT_SECRET: {
    section: "Email y mensajería",
    required: { when: "GMAIL_CLIENT_ID" },
    format: "string",
    tags: ["secret"],
    doc: "Secreto OAuth de Google."
  },
  GMAIL_REDIRECT_URI: {
    section: "Email y mensajería",
    format: "url",
    doc: "Callback OAuth registrado en Google. Por defecto API_PUBLIC_URL + /integrations/email/oauth/callback."
  },
  MS_CLIENT_ID: {
    section: "Email y mensajería",
    format: "string",
    doc: "OAuth de Microsoft 365 para la bandeja de reservas. Vacío = integración desactivada."
  },
  MS_CLIENT_SECRET: {
    section: "Email y mensajería",
    required: { when: "MS_CLIENT_ID" },
    format: "string",
    tags: ["secret"],
    doc: "Secreto OAuth de Microsoft."
  },
  MS_TENANT: {
    section: "Email y mensajería",
    format: "string",
    default: "common",
    doc: "Tenant de Azure AD (common, organizations o el id del tenant)."
  },
  MS_REDIRECT_URI: {
    section: "Email y mensajería",
    format: "url",
    doc: "Callback OAuth registrado en Azure. Por defecto API_PUBLIC_URL + /integrations/email/oauth/callback."
  },

  // ------------------------------------------------------------- VeriFactu
  VERIFACTU_MODE: {
    section: "VeriFactu",
    format: "enum",
    values: FISCAL_MODE_VALUES,
    default: "sandbox",
    example: "sandbox",
    doc: "Envío a AEAT: sandbox (stub local), preproduction (entorno de pruebas oficial, ya requiere certificado y bloque SistemaInformatico) o production. Pasa por preproduction antes de production."
  },
  VERIFACTU_SOFTWARE_NAME: {
    section: "VeriFactu",
    required: { when: "VERIFACTU_MODE!=sandbox" },
    format: "string",
    maxLength: 120,
    tags: ["fiscal-real"],
    doc: "NombreRazon del PRODUCTOR del software (titular de Anfitorio, no el hotel), según la declaración responsable (docs/compliance/verifactu-declaracion-responsable.md)."
  },
  VERIFACTU_SOFTWARE_NIF: {
    section: "VeriFactu",
    required: { when: "VERIFACTU_MODE!=sandbox" },
    format: "nif",
    tags: ["fiscal-real"],
    doc: "NIF del productor del software, con letra de control."
  },
  VERIFACTU_SYSTEM_NAME: {
    section: "VeriFactu",
    format: "string",
    maxLength: 30,
    default: "Anfitorio",
    example: "Anfitorio",
    doc: "NombreSistemaInformatico (≤30)."
  },
  VERIFACTU_SYSTEM_ID: {
    section: "VeriFactu",
    format: "string",
    minLength: 2,
    maxLength: 2,
    default: "01",
    example: "01",
    doc: "IdSistemaInformatico: código de exactamente 2 caracteres elegido por el productor."
  },
  VERIFACTU_SYSTEM_VERSION: {
    section: "VeriFactu",
    format: "string",
    maxLength: 50,
    doc: "Versión declarada del sistema (≤50). Vacía = APP_VERSION y, en su defecto, 0.1.0."
  },
  VERIFACTU_INSTALL_NUMBER: {
    section: "VeriFactu",
    required: { when: "VERIFACTU_MODE!=sandbox" },
    format: "string",
    maxLength: 100,
    tags: ["fiscal-real"],
    doc: "NumeroInstalacion (≤100): identificador que el productor asigna a esta instalación (no lo asigna AEAT)."
  },
  VERIFACTU_MULTI_OT: {
    section: "VeriFactu",
    format: "enum",
    values: ["S", "N"],
    default: "S",
    example: "S",
    doc: "IndicadorMultiplesOT: S (SaaS multi-tenant) o N."
  },
  VERIFACTU_CERT_P12: {
    section: "VeriFactu",
    required: { when: "VERIFACTU_MODE!=sandbox && !VERIFACTU_CERT_PATH" },
    format: "path",
    tags: ["fiscal-real"],
    doc: "Certificado de representante/sello en PKCS#12 (.p12/.pfx) para mTLS contra AEAT. En el compose los certificados se montan desde deploy/certs en /certs (p. ej. /certs/verifactu.p12)."
  },
  VERIFACTU_CERT_P12_PASSPHRASE: {
    section: "VeriFactu",
    format: "string",
    tags: ["secret"],
    doc: "Contraseña del PKCS#12 (fallback: VERIFACTU_CERT_PASSPHRASE)."
  },
  VERIFACTU_SIGN_PEM: {
    section: "VeriFactu",
    format: "path",
    doc: "Opcional: PEM (clave privada + certificado) para la firma XAdES de auditoría guardada en verifactu_submissions. Sin PEM se guarda una firma stub. openssl pkcs12 -in cert.p12 -nodes -out sign.pem"
  },
  VERIFACTU_SIGN_PEM_PASSPHRASE: {
    section: "VeriFactu",
    format: "string",
    tags: ["secret"],
    doc: "Contraseña de la clave del PEM de firma (fallback: VERIFACTU_CERT_PASSPHRASE)."
  },
  VERIFACTU_CERT_PATH: {
    section: "VeriFactu",
    format: "path",
    doc: "Compatibilidad: un único fichero (PEM o PKCS#12, se detecta) para mTLS y firma. Ignorado cuando VERIFACTU_CERT_P12 / VERIFACTU_SIGN_PEM están definidos."
  },
  VERIFACTU_CERT_PASSPHRASE: {
    section: "VeriFactu",
    format: "string",
    tags: ["secret"],
    doc: "Contraseña del fichero de VERIFACTU_CERT_PATH y fallback de las dos anteriores."
  },
  VERIFACTU_MAX_ATTEMPTS: {
    section: "VeriFactu",
    format: "int",
    min: 1,
    max: 100,
    default: "12",
    doc: "Reintentos por registro antes de marcarlo fallido (terminal)."
  },
  XADES_TIMESTAMP_ENABLED: {
    section: "VeriFactu",
    ...BOOL,
    default: "false",
    doc: "Añade sello de tiempo (TSA) a las firmas XAdES de auditoría."
  },
  XADES_TIMESTAMP_MODE: {
    section: "VeriFactu",
    format: "enum",
    values: ["stub", "real"],
    default: "stub",
    doc: "real llama a la TSA de XADES_TIMESTAMP_TSA_URL; stub genera un sello local."
  },
  XADES_TIMESTAMP_TSA_URL: {
    section: "VeriFactu",
    format: "url",
    default: "http://timestamp.digicert.com",
    doc: "URL de la autoridad de sellado de tiempo (RFC 3161)."
  },

  // ------------------------------------------------------------------- SES
  SES_HOSPEDAJES_MODE: {
    section: "SES",
    format: "enum",
    values: FISCAL_MODE_VALUES,
    default: "sandbox",
    example: "sandbox",
    doc: "Partes de viajeros al Ministerio del Interior (SES.Hospedajes): sandbox (stub), preproduction o production. Fuera de sandbox exige certificado y credenciales."
  },
  SES_HOSPEDAJES_CERT_PATH: {
    section: "SES",
    required: { when: "SES_HOSPEDAJES_MODE!=sandbox" },
    format: "path",
    tags: ["fiscal-real"],
    doc: "Certificado electrónico cualificado registrado en el MIR (PKCS#12); en el compose /certs/ses-hospedajes.p12."
  },
  SES_HOSPEDAJES_CERT_PASSPHRASE: {
    section: "SES",
    required: { when: "SES_HOSPEDAJES_MODE!=sandbox" },
    format: "string",
    tags: ["secret", "fiscal-real"],
    doc: "Contraseña del certificado SES."
  },
  SES_HOSPEDAJES_CLIENT_ID: {
    section: "SES",
    required: { when: "SES_HOSPEDAJES_MODE!=sandbox" },
    format: "string",
    tags: ["fiscal-real"],
    doc: "Usuario de la API de comunicaciones SES.Hospedajes."
  },
  SES_HOSPEDAJES_CLIENT_SECRET: {
    section: "SES",
    required: { when: "SES_HOSPEDAJES_MODE!=sandbox" },
    format: "string",
    tags: ["secret", "fiscal-real"],
    doc: "Contraseña de la API SES.Hospedajes."
  },
  SES_MAX_ATTEMPTS: {
    section: "SES",
    format: "int",
    min: 1,
    max: 100,
    default: "10",
    doc: "Reintentos por comunicación antes de marcarla fallida."
  },

  // ------------------------------------------------------------------ TBAI
  TBAI_MODE: {
    section: "TBAI",
    format: "enum",
    values: ["sandbox", "production"],
    default: "sandbox",
    example: "sandbox",
    doc: "TicketBAI (País Vasco): solo si la propiedad tributa allí. NO existe preproduction: cualquier valor distinto de production se trata como sandbox, así que se rechaza para evitar sorpresas."
  },
  TBAI_CERT_PATH: {
    section: "TBAI",
    required: { when: "TBAI_MODE=production" },
    format: "path",
    tags: ["fiscal-real"],
    productionExample: "",
    doc: "Certificado de dispositivo/entidad TicketBAI (PKCS#12)."
  },
  TBAI_CERT_PASSPHRASE: {
    section: "TBAI",
    required: { when: "TBAI_MODE=production" },
    format: "string",
    tags: ["secret", "fiscal-real"],
    doc: "Contraseña del certificado TicketBAI."
  },
  TBAI_LICENSE_KEY: {
    section: "TBAI",
    required: { when: "TBAI_MODE=production" },
    format: "string",
    maxLength: 20,
    tags: ["fiscal-real"],
    doc: "LicenciaTBAI concedida por la diputación foral (≤20)."
  },
  TBAI_DEVICE_SERIAL: {
    section: "TBAI",
    format: "string",
    maxLength: 30,
    doc: "NumSerieDispositivo (≤30). Vacío = VERIFACTU_INSTALL_NUMBER."
  },

  // ------------------------------------------------------------------ IGIC
  IGIC_MODE: {
    section: "IGIC",
    format: "enum",
    values: FISCAL_MODE_VALUES,
    default: "sandbox",
    example: "sandbox",
    doc: "IGIC (Canarias): solo si la propiedad tributa allí. sandbox, preproduction o production."
  },
  IGIC_CERT_PATH: {
    section: "IGIC",
    required: { when: "IGIC_MODE!=sandbox" },
    format: "path",
    tags: ["fiscal-real"],
    doc: "Certificado para la Agencia Tributaria Canaria (PKCS#12)."
  },
  IGIC_CERT_PASSPHRASE: {
    section: "IGIC",
    required: { when: "IGIC_MODE!=sandbox" },
    format: "string",
    tags: ["secret", "fiscal-real"],
    doc: "Contraseña del certificado IGIC."
  },

  // ------------------------------------------------------------ Schedulers
  RUN_SCHEDULERS: {
    section: "Schedulers",
    ...BOOL,
    default: "true",
    example: "true",
    doc: "Esta instancia ejecuta los schedulers in-process (SES, VeriFactu, pace, cupos, grupos, buzón). En multi-réplica solo UNA a true o se duplican envíos a AEAT. El worker la ignora (siempre false)."
  },
  SES_SCHEDULER_DISABLED: { section: "Schedulers", ...BOOL, default: "false", doc: "true desactiva el envío periódico de partes SES." },
  SES_SCHEDULER_INTERVAL_MS: { section: "Schedulers", ...INTERVAL, default: "300000", doc: "Periodo del scheduler SES (ms)." },
  VERIFACTU_SCHEDULER_DISABLED: { section: "Schedulers", ...BOOL, default: "false", doc: "true desactiva el envío periódico de registros VeriFactu." },
  VERIFACTU_SCHEDULER_INTERVAL_MS: { section: "Schedulers", ...INTERVAL, default: "120000", doc: "Periodo del scheduler VeriFactu (ms)." },
  PACE_SCHEDULER_DISABLED: { section: "Schedulers", ...BOOL, default: "false", doc: "true desactiva el cálculo diario de pace/night-audit." },
  ALLOTMENT_RELEASE_SCHEDULER_DISABLED: { section: "Schedulers", ...BOOL, default: "false", doc: "true desactiva la liberación automática de cupos." },
  GROUP_CUTOFF_SCHEDULER_DISABLED: { section: "Schedulers", ...BOOL, default: "false", doc: "true desactiva el cutoff automático de grupos." },
  MAILBOX_POLL_DISABLED: { section: "Schedulers", ...BOOL, default: "false", doc: "true desactiva el sondeo de las bandejas de correo integradas." },
  MAILBOX_POLL_INTERVAL_MS: { section: "Schedulers", ...INTERVAL, default: "300000", doc: "Periodo del sondeo de buzones (ms)." },

  // -------------------------------------------------------------------- IA
  AI_PROVIDER: {
    section: "IA",
    format: "enum",
    values: ["none", "anthropic", "openai"],
    default: "none",
    doc: "Proveedor LLM de los asistentes. none = respuestas basadas en reglas. Sin este valor la API key no sirve."
  },
  AI_PROVIDER_API_KEY: {
    section: "IA",
    required: { when: "AI_PROVIDER!=none" },
    format: "string",
    tags: ["secret"],
    doc: "API key del proveedor LLM."
  },
  AI_MODEL: { section: "IA", format: "string", doc: "Modelo a usar. Vacío = claude-3-5-sonnet-latest (anthropic) o gpt-4o-mini (openai)." },
  AI_REQUEST_TIMEOUT_MS: { section: "IA", format: "int", min: 1000, max: 600_000, default: "20000", doc: "Timeout de cada llamada al LLM (ms)." },
  AI_GATEWAY_MODE: {
    section: "IA",
    format: "enum",
    values: ["stub", "real"],
    default: "stub",
    doc: "Motor de onboarding con IA: stub (en proceso) o real (llama al ai-gateway)."
  },
  AI_GATEWAY_URL: { section: "IA", format: "url", default: "http://localhost:4000", doc: "URL del ai-gateway cuando AI_GATEWAY_MODE=real." },
  API_BASE_URL: { section: "IA", format: "url", default: "http://localhost:3000", doc: "Solo la lee el ai-gateway: URL del API contra el que ejecuta las herramientas." },
  OCR_PROVIDER_API_KEY: { section: "IA", format: "string", tags: ["secret"], doc: "Reservada: solo el /health del ai-gateway la refleja como configured/unconfigured." },
  SPEECH_PROVIDER_API_KEY: { section: "IA", format: "string", tags: ["secret"], doc: "Reservada: solo el /health del ai-gateway la refleja como configured/unconfigured." },

  // ------------------------------------------------------------------- OTA
  // Rate grid v2 (2026-09-14): the channel manager owns its contract (mode cap,
  // Channex base URL, drain cadence) in modules/channel-manager/env.partial.ts.
  ...CHANNEL_MANAGER_ENV_CONTRACT,
  BOOKING_API_BASE_URL: { section: "OTA", format: "url", doc: "Base de la API real de Booking (vacío = por defecto del adaptador)." },
  BOOKING_OAUTH_URL: { section: "OTA", format: "url", doc: "Endpoint de token exchange JWT de Booking Connectivity (por defecto https://connectivity-authentication.booking.com/token-based-authentication/exchange)." },
  EXPEDIA_API_BASE_URL: { section: "OTA", format: "url", doc: "Base de la API de Expedia (vacío = por defecto)." },

  // ---------------------------------------------------------------- Wallet
  APPLE_WALLET_PASS_TYPE_ID: { section: "Wallet", format: "string", default: "pass.com.hotelos.roomkey", doc: "Pass Type ID de las llaves móviles en Apple Wallet." },
  APPLE_WALLET_TEAM_ID: {
    section: "Wallet",
    format: "string",
    default: "HOTELOSDEV",
    doc: "Team ID de Apple Developer. El valor por defecto es de desarrollo: en producción avisa si sigue ahí."
  },
  APPLE_WALLET_CERT_PATH: { section: "Wallet", format: "path", doc: "Certificado de firma de pases; definido = los pases salen firmados." },
  GOOGLE_WALLET_ISSUER_ID: { section: "Wallet", format: "string", default: "3388000000022000000", doc: "Issuer ID de Google Wallet (el valor por defecto es de pruebas)." },

  // ---------------------------------------------------------------- Sentry
  SENTRY_DSN: {
    section: "Sentry",
    format: "url",
    tags: ["secret"],
    doc: "DSN de Sentry del API/worker: captura errores 5xx. Vacío = desactivado (en producción avisa)."
  },
  VITE_SENTRY_DSN: { section: "Sentry", format: "url", doc: "DSN de Sentry del admin-web (se hornea en el build de Vite)." },

  // -------------------------------------------------------------- Frontend
  VITE_API_URL: {
    section: "Frontend",
    format: "url",
    default: "http://localhost:3000",
    productionExample: "https://app.example.com/api",
    doc: "URL del API que llama el admin-web; se hornea en el build (vite build). En producción https://<host>/api. Sin barra final."
  },
  VITE_APP_VERSION: { section: "Frontend", format: "string", default: "0.1.0", doc: "Versión mostrada en la ayuda del admin-web." },
  EXPO_PUBLIC_API_BASE_URL: { section: "Frontend", format: "url", doc: "URL del API para la app móvil (Expo)." },
  EXPO_PUBLIC_ADMIN_WEB_URL: { section: "Frontend", format: "url", doc: "URL del admin-web que abre la app móvil desde Más." },
  EXPO_PUBLIC_SHOW_DEV_LAUNCHER: {
    section: "Frontend",
    ...BOOL,
    default: "false",
    severity: "warn",
    tags: ["dev-only"],
    doc: "Muestra el lanzador de entornos de desarrollo en la app móvil."
  },

  // ----------------------------------------------------------------- Seeds
  SEED_ORG_ID: { section: "Seeds", format: "string", default: "org_123", tags: ["dev-only"], doc: "Organización destino de los seeds demo (db:seed:*). Solo desarrollo/demo." },
  SEED_PROPERTY_ID: { section: "Seeds", format: "string", default: "prop_123", tags: ["dev-only"], doc: "Propiedad destino de los seeds demo." },
  SEED_SCOPE: { section: "Seeds", format: "enum", values: ["full", "rates"], default: "full", tags: ["dev-only"], doc: "Alcance del seed comercial: full o solo rates." },
  SEED_BAR_PRICES: { section: "Seeds", format: "string", tags: ["dev-only"], doc: "Precios BAR por categoría para el seed comercial (formato del seed)." },
  SEED_RATE_DAYS_BACK: { section: "Seeds", format: "int", min: 0, max: 3650, default: "30", tags: ["dev-only"], doc: "Días hacia atrás de la rejilla de tarifas sembrada." },
  SEED_RATE_DAYS_AHEAD: { section: "Seeds", format: "int", min: 0, max: 3650, default: "150", tags: ["dev-only"], doc: "Días hacia delante de la rejilla de tarifas sembrada." },
  SEED_CREATE_ROOMS: {
    section: "Seeds",
    format: "enum",
    values: ["1"],
    tags: ["dev-only"],
    doc: "db:seed:snapshots: el literal 1 permite crear habitaciones demo en una propiedad de la allowlist que no tenga ninguna; sin él la propiedad se omite."
  },
  SEED_ALLOW_REAL: {
    section: "Seeds",
    format: "enum",
    values: ["1"],
    tags: ["dev-only", "dangerous"],
    doc: "Guard DATA-05: los seeds solo escriben sobre la allowlist demo (org_123, prop_123, prop_canary). Para apuntar a otro objetivo exporta el literal 1 junto con SEED_CONFIRM=<id>. Nunca en un .env persistente."
  },
  SEED_CONFIRM: {
    section: "Seeds",
    format: "string",
    tags: ["dev-only", "dangerous"],
    doc: "Guard DATA-05: id exacto (o lista separada por comas) de la organización/propiedad NO demo que confirmas como objetivo del seed; solo se honra con SEED_ALLOW_REAL=1."
  },

  // ----------------------------------------------------------------- Tests
  AUTH_EXPOSE_RESET_TOKEN: {
    section: "Tests",
    ...BOOL,
    default: "false",
    example: "false",
    productionForbidden: "true",
    tags: ["test"],
    doc: "Devuelve el token de reset de contraseña en la respuesta HTTP para poder testearlo. NUNCA en un despliegue accesible."
  },
  ADMIN_EXPOSE_TEMP_PASSWORD: {
    section: "Tests",
    ...BOOL,
    default: "false",
    example: "false",
    productionForbidden: "true",
    tags: ["test"],
    doc: "Devuelve la contraseña temporal en claro en la consola super-admin. NUNCA en un despliegue accesible."
  },
  GUEST_PORTAL_RETURN_TOKEN: {
    section: "Tests",
    ...BOOL,
    default: "false",
    example: "false",
    productionForbidden: "true",
    tags: ["test"],
    doc: "Devuelve el token del portal de huéspedes por HTTP aunque el magic link se haya entregado por email. NUNCA en producción."
  },
  WORKER_AUTOSTART: { section: "Tests", ...BOOL, default: "true", tags: ["test"], doc: "false evita que el worker arranque el scheduler al importarlo (solo tests)." },
  API_URL: { section: "Tests", format: "url", default: "http://localhost:3000", severity: "warn", tags: ["tool", "dev-only"], doc: "scripts/smoke-director-dashboard.mjs: URL del API a probar." },
  ADMIN_WEB_URL: { section: "Tests", format: "url", default: "http://localhost:5173", severity: "warn", tags: ["tool", "dev-only"], doc: "scripts/smoke-director-dashboard.mjs: URL del admin-web." },
  DEMO_PROPERTY_ID: { section: "Tests", format: "string", default: "prop_123", severity: "warn", tags: ["tool", "dev-only"], doc: "scripts/smoke-director-dashboard.mjs: propiedad del smoke." },
  SMOKE_TIMEOUT_MS: { section: "Tests", format: "int", min: 1000, max: 600_000, default: "15000", severity: "warn", tags: ["tool", "dev-only"], doc: "scripts/smoke-director-dashboard.mjs: timeout por petición (ms)." }
} satisfies Record<string, EnvVarSpec>);

// ---------------------------------------------------------------------------
// Helpers shared by validateEnv / resolveCorsOrigins
// ---------------------------------------------------------------------------

export function isPlaceholder(value: string | undefined, extra: readonly string[] = []): boolean {
  if (value === undefined) return true;
  const trimmed = value.trim();
  if (PLACEHOLDER_VALUES.includes(trimmed.toLowerCase())) return true;
  return extra.includes(trimmed);
}

/** Raw value with placeholders collapsed to undefined. */
function readValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  const spec = ENV_CONTRACT[name];
  if (isPlaceholder(raw, spec?.forbidden ?? [])) return undefined;
  return raw!.trim();
}

/** Value the code will actually use: raw value or the contract default. */
export function effectiveValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return readValue(env, name) ?? ENV_CONTRACT[name]?.default;
}

/** Evaluate the `{ when }` grammar (see EnvRequired) against effective values. */
export function evaluateWhen(when: string, env: NodeJS.ProcessEnv): boolean {
  return when.split("&&").every((rawClause) => {
    const clause = rawClause.trim();
    const neq = clause.match(/^([A-Z][A-Z0-9_]+)!=(.*)$/);
    if (neq) return effectiveValue(env, neq[1]) !== neq[2].trim();
    const eq = clause.match(/^([A-Z][A-Z0-9_]+)=(.*)$/);
    if (eq) return effectiveValue(env, eq[1]) === eq[2].trim();
    if (clause.startsWith("!")) return readValue(env, clause.slice(1).trim()) === undefined;
    return readValue(env, clause) !== undefined;
  });
}

const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;

/** Lower-cased origin without trailing slash, or null when it is not a bare origin. */
export function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim().toLowerCase().replace(/\/+$/, "");
  return ORIGIN_RE.test(trimmed) ? trimmed : null;
}

function decodesToBytes(value: string, length: number): boolean {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) return false;
  const buf = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return buf.length === length;
}

function isReadableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.R_OK);
    return true;
  } catch {
    // accessSync throws for ENOENT/EACCES; both mean "not usable" here.
    return false;
  }
}

function schemaFor(name: string, spec: EnvVarSpec, production: boolean): z.ZodTypeAny {
  switch (spec.format) {
    case "postgres-url":
      return z.string().regex(/^postgres(ql)?:\/\/.+/, `${name} debe empezar por postgresql:// (o postgres://).`);
    case "base64-32":
      return z.string().refine((v) => decodesToBytes(v, 32), `${name} debe ser base64 que decodifique a exactamente 32 bytes (openssl rand -base64 32).`);
    case "int": {
      let schema = z.coerce.number({ invalid_type_error: `${name} debe ser un entero.` }).int(`${name} debe ser un entero.`);
      if (spec.min !== undefined) schema = schema.min(spec.min, `${name} debe ser ≥ ${spec.min}.`);
      if (spec.max !== undefined) schema = schema.max(spec.max, `${name} debe ser ≤ ${spec.max}.`);
      return z.string().regex(/^-?\d+$/, `${name} debe ser un entero.`).pipe(schema);
    }
    case "bool":
      return z.enum(["true", "false"], { errorMap: () => ({ message: `${name} debe ser exactamente "true" o "false" (ni 1, ni yes).` }) });
    case "enum":
      return z.enum(spec.values as [string, ...string[]], {
        errorMap: () => ({ message: `${name} debe ser uno de: ${(spec.values ?? []).join(" | ")}.` })
      });
    case "nif":
      return z.string().refine((v) => isValidSpanishTaxId(v.toUpperCase()), `${name} no es un NIF/CIF español válido (letra de control).`);
    case "path":
      return z.string().refine(isReadableFile, `${name}: el fichero no existe o no es legible por el proceso (ruta relativa a ${process.cwd()}).`);
    case "origin-list":
      return z
        .string()
        .refine((v) => v.split(",").map((s) => s.trim()).filter(Boolean).every((s) => normalizeOrigin(s) !== null), `${name} debe ser una lista separada por comas de orígenes http(s)://host[:puerto] sin ruta ni barra final.`);
    case "url":
      return z
        .string()
        .url(`${name} debe ser una URL válida.`)
        .refine((v) => /^https?:\/\//i.test(v), `${name} debe usar http:// o https://.`)
        .refine((v) => !/\/$/.test(v), `${name} no debe terminar en barra.`)
        .refine((v) => !spec.origin || normalizeOrigin(v) !== null, `${name} debe ser solo un origen (scheme://host[:puerto]), sin ruta.`)
        .refine((v) => !(production && spec.httpsInProduction) || /^https:\/\//i.test(v), `${name} debe ser https en producción.`);
    case "string":
    default: {
      let schema = z.string();
      if (spec.minLength !== undefined) schema = schema.min(spec.minLength, `${name} debe tener al menos ${spec.minLength} caracteres.`);
      if (spec.maxLength !== undefined) schema = schema.max(spec.maxLength, `${name} supera los ${spec.maxLength} caracteres.`);
      if (spec.pattern !== undefined) schema = schema.regex(new RegExp(spec.pattern), `${name} no tiene el formato esperado.`);
      return schema;
    }
  }
}

export type EnvValidationReport = { errors: string[]; warnings: string[] };

/**
 * Formats whose readers use `process.env.X ?? default` and therefore keep ""
 * (an int is always hazardous: Number("") is 0; url/enum only when the
 * contract documents a default the reader would have applied).
 */
const BLANK_IS_NOT_DEFAULT: ReadonlySet<EnvFormat> = new Set<EnvFormat>(["url", "enum"]);

/**
 * Validate `env` against ENV_CONTRACT. Pure: never throws, never logs.
 * `production` selects the policy: missing [PROD] variables and forbidden
 * test flags are errors in production and warnings otherwise; format errors
 * of defined values are errors in both (a wrong value is wrong anywhere).
 */
export function validateEnv(env: NodeJS.ProcessEnv, opts: { production: boolean }): EnvValidationReport {
  const { production } = opts;
  const errors: string[] = [];
  const warnings: string[] = [];
  const push = (severity: "error" | "warn", message: string) => (severity === "error" ? errors : warnings).push(message);

  for (const [name, spec] of Object.entries(ENV_CONTRACT)) {
    const raw = env[name];
    const value = readValue(env, name);
    const severity: "error" | "warn" = spec.severity ?? "error";

    // Presence.
    let required = false;
    let reason = "";
    if (spec.required === "always") {
      required = true;
      reason = "obligatoria";
    } else if (spec.required === "production") {
      required = production;
      reason = "obligatoria con NODE_ENV=production";
    } else if (spec.required && typeof spec.required === "object") {
      required = evaluateWhen(spec.required.when, env);
      reason = `obligatoria cuando ${spec.required.when}`;
    }
    // [PROD] variables are advisory outside production (warning), except
    // those with an alternative (a dedicated cross rule reports them).
    const advisory = spec.required === "production" && !production && !spec.alternatives;
    if ((required || advisory) && value === undefined) {
      const satisfiedByAlternative = (spec.alternatives ?? []).some((alt) => readValue(env, alt) !== undefined);
      if (!satisfiedByAlternative) {
        const hint = spec.generate ? ` Genera un valor con: ${spec.generate}.` : "";
        const placeholderNote = raw !== undefined && raw.trim() !== "" ? ` (el valor actual "${raw.trim()}" es un placeholder)` : "";
        push(advisory ? "warn" : severity, `Falta ${name} (${reason})${placeholderNote}.${hint}`);
      }
      continue;
    }
    if (value === undefined) {
      const blankKeepsEmpty = spec.format === "int" || (BLANK_IS_NOT_DEFAULT.has(spec.format) && spec.default !== undefined);
      if (raw !== undefined && raw.trim() === "" && blankKeepsEmpty) {
        // `process.env.X ?? default` keeps "" — Number("") is 0 (port 0, a
        // 0 ms scheduler interval), an empty enum is an invalid literal.
        push(
          severity,
          `${name} está definida pero vacía: el código no aplica el valor por defecto${spec.default !== undefined ? ` (${spec.default})` : ""}. Borra la línea o pon un valor.`
        );
      } else if (raw !== undefined && raw.trim() !== "" && spec.severity !== "warn") {
        warnings.push(`${name} tiene un valor de ejemplo ("${raw.trim()}") y se ignora.`);
      }
      continue;
    }

    // Format.
    const parsed = schemaFor(name, spec, production).safeParse(value);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? `${name} tiene un valor inválido.`;
      push(severity, message);
      continue;
    }

    // Production policy per variable.
    if (spec.productionForbidden !== undefined && value === spec.productionForbidden) {
      if (production) {
        // HOTELOS_ALLOW_DEMO_AUTH has its own override handled below.
        if (name !== "HOTELOS_ALLOW_DEMO_AUTH") {
          errors.push(`${name}=${value} está prohibido en producción (${spec.doc.split(".")[0]}).`);
        }
      }
    }
    if (production && spec.productionWarnUnless !== undefined && value !== spec.productionWarnUnless) {
      warnings.push(`${name}=${value}: en producción se espera ${spec.productionWarnUnless}.`);
    }
    if (spec.tags?.includes("deprecated")) {
      warnings.push(`${name} está obsoleta: ${spec.doc}`);
    }
  }

  // ---- Cross-variable rules ------------------------------------------------
  const nodeEnv = env.NODE_ENV;
  if (nodeEnv !== undefined && nodeEnv.trim() !== "" && !["development", "test", "production"].includes(nodeEnv.trim())) {
    // Already reported by the enum check; reinforce the consequence.
    errors.push(`NODE_ENV="${nodeEnv}" no activa ni el modo producción ni el de desarrollo: el RBAC estricto y el guard de la clave PII quedarían desactivados sin querer.`);
  }

  // Encryption key: one of the two must be valid in production.
  const fieldKey = readValue(env, "HOTELOS_FIELD_KEY");
  const encryptionKey = readValue(env, "ENCRYPTION_KEY");
  const keyMaterial = fieldKey ?? encryptionKey;
  if (keyMaterial === undefined) {
    if (production) {
      if (!errors.some((e) => e.startsWith("Falta ENCRYPTION_KEY"))) {
        errors.push("Falta la clave de cifrado de PII (HOTELOS_FIELD_KEY o ENCRYPTION_KEY): en producción el API aborta el arranque. Genera una con: openssl rand -base64 32.");
      }
    } else {
      warnings.push("Sin HOTELOS_FIELD_KEY/ENCRYPTION_KEY la PII de huéspedes se guarda EN CLARO (aceptable solo en desarrollo local).");
    }
  }

  // Demo auth in production.
  if (production && readValue(env, "HOTELOS_ALLOW_DEMO_AUTH") === "true") {
    if (readValue(env, "HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE") === "true") {
      warnings.push(
        "PELIGRO: HOTELOS_ALLOW_DEMO_AUTH=true en producción con HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE=true: toda petición sin token recibe el super-usuario demo. Solo aceptable en una demo pública sin datos reales."
      );
    } else {
      // Same wording as assertDemoAuthPolicy (auth-context.ts): the boot
      // error is asserted by tests/integration/api-integration.test.mts.
      errors.push(
        "HOTELOS_ALLOW_DEMO_AUTH no puede estar activo en producción: elimínalo del entorno (NODE_ENV=production). El API se niega a arrancar (AUTH-04); solo una demo pública sin datos reales puede forzarlo con HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE=true."
      );
    }
  }

  // Email trio: all or nothing; production without it degrades invitations.
  const emailProvider = readValue(env, "EMAIL_PROVIDER");
  const emailKey = readValue(env, "EMAIL_PROVIDER_KEY");
  const emailFrom = readValue(env, "EMAIL_FROM");
  const emailDefined = [emailProvider, emailKey, emailFrom].filter((v) => v !== undefined).length;
  if (emailDefined > 0 && emailDefined < 3 && emailProvider === undefined) {
    errors.push("EMAIL_PROVIDER_KEY/EMAIL_FROM sin EMAIL_PROVIDER: los tres EMAIL_* van juntos (postmark|sendgrid + clave + remitente).");
  }
  if (production && emailDefined === 0) {
    warnings.push("Sin EMAIL_PROVIDER/EMAIL_PROVIDER_KEY/EMAIL_FROM las invitaciones y el reset de contraseña quedan en modo 'disabled': habrá que entregar los enlaces a mano.");
  }

  // VeriFactu outside sandbox: reuse the compliance resolvers (exact XSD rules).
  const verifactuMode = effectiveValue(env, "VERIFACTU_MODE");
  if (verifactuMode !== undefined && verifactuMode !== "sandbox" && ["preproduction", "production"].includes(verifactuMode)) {
    const software = resolveVerifactuSoftware(env);
    for (const message of software.errors) {
      const text = `VeriFactu (${verifactuMode}): ${message}`;
      if (!errors.some((e) => e.includes(message))) push(production ? "error" : "warn", text);
    }
    const credentials = resolveVerifactuCredentials(env);
    for (const warning of credentials.warnings) warnings.push(`VeriFactu: ${warning}`);
    if (credentials.mtls === null) {
      push(production ? "error" : "warn", `VeriFactu (${verifactuMode}): falta el certificado mTLS (VERIFACTU_CERT_P12 + passphrase, o VERIFACTU_CERT_PATH); sin él cada envío queda aparcado con CERT_NOT_CONFIGURED.`);
    } else if (!isReadableFile(credentials.mtls.path)) {
      push(production ? "error" : "warn", `VeriFactu: el certificado ${credentials.mtls.source}=${credentials.mtls.path} no existe o no es legible.`);
    }
  }

  // AI key without provider.
  if (readValue(env, "AI_PROVIDER_API_KEY") !== undefined && effectiveValue(env, "AI_PROVIDER") === "none") {
    warnings.push("AI_PROVIDER_API_KEY está definida pero AI_PROVIDER=none: el LLM sigue desactivado. Define AI_PROVIDER=anthropic|openai.");
  }

  // Production-only advisories.
  if (production) {
    if (readValue(env, "CORS_ALLOWED_ORIGINS") === undefined && readValue(env, "PILOT_PUBLIC_ORIGIN") === undefined) {
      warnings.push("Sin CORS_ALLOWED_ORIGINS: solo se admiten peticiones same-origin (correcto detrás de Caddy sirviendo SPA y API en el mismo origen).");
    }
    if (readValue(env, "SENTRY_DSN") === undefined) warnings.push("SENTRY_DSN vacío: los errores 5xx no se reportan a Sentry.");
    if (effectiveValue(env, "APPLE_WALLET_TEAM_ID") === "HOTELOSDEV") warnings.push("APPLE_WALLET_TEAM_ID sigue con el valor de desarrollo HOTELOSDEV: las llaves móviles de Apple Wallet no serán válidas.");
    if (readValue(env, "CORS_ALLOW_LAN") === "true") warnings.push("CORS_ALLOW_LAN=true se ignora en producción.");
  }

  return { errors, warnings };
}

let reportedSignature: string | null = null;

/**
 * Boot guard. NODE_ENV=production: throw with every error (the process must
 * not start half-configured). Otherwise print errors and warnings once per
 * process so `app.inject` test suites do not flood the output.
 */
export function assertEnv(env: NodeJS.ProcessEnv = process.env): void {
  const production = env.NODE_ENV === "production";
  const report = validateEnv(env, { production });
  if (production && report.errors.length > 0) {
    throw new Error(
      `Configuración de entorno inválida (NODE_ENV=production), ${report.errors.length} error(es):\n` +
        report.errors.map((e) => ` - ${e}`).join("\n") +
        (report.warnings.length ? `\nAvisos:\n${report.warnings.map((w) => ` - ${w}`).join("\n")}` : "")
    );
  }
  const signature = JSON.stringify(report);
  if (signature === reportedSignature) return;
  reportedSignature = signature;
  if (report.errors.length === 0 && report.warnings.length === 0) return;
  const mode = production ? "production" : env.NODE_ENV ?? "sin NODE_ENV";
  const lines: string[] = [];
  if (report.errors.length) {
    lines.push(`[env] ${report.errors.length} error(es) de configuración (${mode}; en producción impedirían el arranque):`);
    for (const e of report.errors) lines.push(`  - ${e}`);
  }
  if (report.warnings.length) {
    lines.push(`[env] ${report.warnings.length} aviso(s) de configuración (${mode}):`);
    for (const w of report.warnings) lines.push(`  - ${w}`);
  }
  console.warn(lines.join("\n"));
}

/** Test hook: forget the last printed report so the next assertEnv prints again. */
export function __resetEnvReportForTests(): void {
  reportedSignature = null;
}

export type CorsOrigins = {
  /** Normalised explicit allow-list (CORS_ALLOWED_ORIGINS ∪ PILOT_PUBLIC_ORIGIN). */
  allowed: string[];
  /** true outside production: localhost / 127.0.0.1 on any port are accepted as well. */
  devFallback: boolean;
  /** true outside production with CORS_ALLOW_LAN=true: private LAN ranges accepted too. */
  lanFallback: boolean;
  /** PILOT_PUBLIC_ORIGIN contributed an origin (deprecated alias). */
  deprecatedAliasUsed: boolean;
};

/**
 * Resolve the CORS allow-list from CORS_ALLOWED_ORIGINS (comma-separated,
 * normalised to lower-case origins without trailing slash, invalid entries
 * dropped — validateEnv reports them) merged with the deprecated
 * PILOT_PUBLIC_ORIGIN alias.
 */
export function resolveCorsOrigins(env: NodeJS.ProcessEnv = process.env): CorsOrigins {
  const allowed = new Set<string>();
  for (const entry of (env.CORS_ALLOWED_ORIGINS ?? "").split(",")) {
    const origin = normalizeOrigin(entry);
    if (origin) allowed.add(origin);
  }
  let deprecatedAliasUsed = false;
  const alias = env.PILOT_PUBLIC_ORIGIN ? normalizeOrigin(env.PILOT_PUBLIC_ORIGIN) : null;
  if (alias) {
    allowed.add(alias);
    deprecatedAliasUsed = true;
  }
  const devFallback = env.NODE_ENV !== "production";
  return {
    allowed: [...allowed],
    devFallback,
    lanFallback: devFallback && env.CORS_ALLOW_LAN === "true",
    deprecatedAliasUsed
  };
}

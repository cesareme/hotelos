#!/usr/bin/env node
/**
 * Environment pre-flight over a .env file (Tanda 4 · DATA-04).
 *
 *   node scripts/validate-env.mjs [path] [--role app|production-compose|production-native] [--json]
 *
 * Reads scripts/env-contract.json (generated from apps/api/src/lib/env.ts by
 * scripts/env-census.mjs) and applies the same presence / format /
 * production-policy rules the API applies at boot (assertEnv), but to a FILE
 * and without TypeScript, so it runs on a VPS or in CI before anything starts:
 *
 *   app                default for .env / .env.example (development box)
 *   production-compose deploy/.env.production consumed by
 *                      deploy/docker-compose.production.yml (NODE_ENV, PORT,
 *                      DATABASE_URL, REDIS_URL, HOST, TRUST_PROXY are computed by
 *                      the compose; DOMAIN/PUBLIC_API_URL/POSTGRES_* are required)
 *   production-native  a systemd / EnvironmentFile deployment (DATABASE_URL and
 *                      APP_BASE_URL required, certificate paths must exist here)
 *
 * Role inference when --role is absent: --production or a path containing
 * "production" → production-compose; NODE_ENV=production inside the file →
 * production-native; otherwise app. A `.example` file is checked for shape
 * (every declared value must be valid) but empty required values are allowed.
 *
 * Core rules applied (full list in the contract): DATABASE_URL postgres URL,
 * REDIS_URL reserved/optional, JWT_SECRET ≥32 chars and not change-me,
 * ENCRYPTION_KEY (or HOTELOS_FIELD_KEY) base64 of 32 bytes in production,
 * NODE_ENV ∈ development|test|production, booleans exactly true|false, integer
 * ranges (RATE_LIMIT_MAX, *_INTERVAL_MS ≥ 10000), decimals with a dot
 * (AI_USD_EUR_RATE, AI_MONTHLY_BUDGET_EUR_DEFAULT), enums (EMAIL_PROVIDER,
 * AI_PROVIDER — openai is retired and only warns —, fiscal *_MODE), URLs/origins
 * (APP_BASE_URL https in production, CORS_ALLOWED_ORIGINS list),
 * AI_PROVIDER_API_KEY required when AI_PROVIDER≠none, SENTRY_DSN advisory, SES_HOSPEDAJES_CLIENT_ID /
 * SES_HOSPEDAJES_CLIENT_SECRET / certificates required outside sandbox,
 * VeriFactu SistemaInformatico block + mTLS certificate outside sandbox,
 * production-forbidden flags (HOTELOS_ALLOW_DEMO_AUTH, RBAC_STRICT=false,
 * AUTH_EXPOSE_RESET_TOKEN, ADMIN_EXPOSE_TEMP_PASSWORD, TENANT_BOOTSTRAP_SKIP,
 * GUEST_PORTAL_RETURN_TOKEN).
 *
 * Retired in Tanda 4 (no code reads them any more; a file still carrying them
 * gets a warning): OBJECT_STORAGE_BUCKET, OBJECT_STORAGE_REGION,
 * OBJECT_STORAGE_ACCESS_KEY, OBJECT_STORAGE_SECRET_KEY, PAYMENT_PROVIDER_SECRET,
 * APP_PUBLIC_API_URL (replaced by API_PUBLIC_URL / VITE_API_URL).
 *
 * Exit codes: 0 ok (warnings allowed) · 1 contract errors · 2 usage / I/O error.
 */
import { accessSync, constants as fsConstants, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_PATH = join(ROOT, "scripts", "env-contract.json");

export const ROLES = ["app", "production-compose", "production-native"];
/** Keys the production compose computes in `environment:` (they override env_file). */
export const COMPOSE_PROVIDED = ["NODE_ENV", "PORT", "HOST", "DATABASE_URL", "REDIS_URL", "TRUST_PROXY"];
/** Keys only the compose interpolates (not read by the application). */
export const COMPOSE_ONLY = {
  DOMAIN: { required: true, doc: "hostname público (Caddy)" },
  PUBLIC_API_URL: { required: true, doc: "URL del API horneada en admin-web (https)" },
  POSTGRES_USER: { required: false, doc: "usuario Postgres del contenedor" },
  POSTGRES_DB: { required: false, doc: "base de datos Postgres del contenedor" },
  POSTGRES_PASSWORD: { required: true, doc: "contraseña Postgres (openssl rand -base64 32)" }
};
export const RETIRED_KEYS = [
  "OBJECT_STORAGE_BUCKET",
  "OBJECT_STORAGE_REGION",
  "OBJECT_STORAGE_ACCESS_KEY",
  "OBJECT_STORAGE_SECRET_KEY",
  "PAYMENT_PROVIDER_SECRET",
  "APP_PUBLIC_API_URL",
  "AI_GATEWAY_MODE",
  "AI_GATEWAY_URL",
  "API_BASE_URL",
  "OCR_PROVIDER_API_KEY",
  "SPEECH_PROVIDER_API_KEY"
];
const PLACEHOLDER_VALUES = ["", "change-me", "changeme", "todo", "your-key-here", "placeholder"];
const DNI_CONTROL_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";
const CIF_CONTROL_LETTERS = "JABCDEFGHI";

export function parseEnvFile(content) {
  const values = new Map();
  const declared = new Set();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      // `# KEY=` documents an optional key without activating it.
      const commented = line.match(/^#\s*([A-Z][A-Z0-9_]+)=/);
      if (commented) declared.add(commented[1]);
      continue;
    }
    const body = line.startsWith("export ") ? line.slice(7).trim() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    let value = body.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
    declared.add(key);
  }
  return { values, declared };
}

export function loadContract(path = CONTRACT_PATH) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return parsed.variables;
}

function isPlaceholder(value, extra = []) {
  if (value === undefined) return true;
  const trimmed = value.trim();
  return PLACEHOLDER_VALUES.includes(trimmed.toLowerCase()) || extra.includes(trimmed);
}

// --- Spanish NIF (mirror of packages/compliance/src/spain/tax-id.ts) --------
function isValidSpanishTaxId(raw) {
  let value = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (value.length === 11 && value.startsWith("ES")) value = value.slice(2);
  if (value.length !== 9) return false;
  if (/^[A-Z]?0{7,8}[A-Z0-9]$/.test(value)) return false;
  const dniLetter = (digits) => DNI_CONTROL_LETTERS[Number(digits) % 23] ?? "";
  if (/^\d{8}[A-Z]$/.test(value)) return dniLetter(value.slice(0, 8)) === value[8];
  if (/^[XYZ]\d{7}[A-Z]$/.test(value)) return dniLetter({ X: "0", Y: "1", Z: "2" }[value[0]] + value.slice(1, 8)) === value[8];
  if (/^[KLM]\d{7}[A-Z]$/.test(value)) return dniLetter(value.slice(1, 8)) === value[8];
  if (/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(value)) {
    const digits = value.slice(1, 8);
    let sum = 0;
    for (let i = 0; i < digits.length; i += 1) {
      const n = Number(digits[i]);
      if (i % 2 === 0) {
        const doubled = n * 2;
        sum += Math.floor(doubled / 10) + (doubled % 10);
      } else {
        sum += n;
      }
    }
    const control = (10 - (sum % 10)) % 10;
    const org = value[0];
    const ctrl = value[8];
    const isDigit = /\d/.test(ctrl);
    if (isDigit && "NPQRSW".includes(org)) return false;
    if (!isDigit && "ABEH".includes(org)) return false;
    return isDigit ? ctrl === String(control) : ctrl === CIF_CONTROL_LETTERS[control];
  }
  return false;
}

const ORIGIN_RE = /^https?:\/\/[a-z0-9.-]+(?::\d{1,5})?$/;
function normalizeOrigin(value) {
  const trimmed = value.trim().toLowerCase().replace(/\/+$/, "");
  return ORIGIN_RE.test(trimmed) ? trimmed : null;
}

function decodesTo32Bytes(value) {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) return false;
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").length === 32;
}

function isReadableFile(path) {
  try {
    accessSync(path, fsConstants.R_OK);
    return true;
  } catch {
    // ENOENT / EACCES both mean the process could not use the file.
    return false;
  }
}

/** Format check for a non-placeholder value. Returns an error message or null. */
export function checkFormat(name, spec, value, { production, pathSeverityWarn }) {
  switch (spec.format) {
    case "postgres-url":
      return /^postgres(ql)?:\/\/.+/.test(value) ? null : `${name} debe empezar por postgresql:// (o postgres://).`;
    case "base64-32":
      return decodesTo32Bytes(value) ? null : `${name} debe ser base64 que decodifique a exactamente 32 bytes (openssl rand -base64 32).`;
    case "int": {
      if (!/^-?\d+$/.test(value)) return `${name} debe ser un entero.`;
      const n = Number(value);
      if (spec.min !== undefined && n < spec.min) return `${name} debe ser ≥ ${spec.min}.`;
      if (spec.max !== undefined && n > spec.max) return `${name} debe ser ≤ ${spec.max}.`;
      return null;
    }
    case "decimal": {
      // Corrección L6a (WT-02): punto decimal obligatorio; «0,92» falla aquí en vez de degradar en silencio en el API.
      if (!/^-?\d+(\.\d+)?$/.test(value)) return `${name} debe ser un número con punto decimal (p. ej. 0.92), sin coma.`;
      const n = Number(value);
      if (spec.min !== undefined && n < spec.min) return `${name} debe ser ≥ ${spec.min}.`;
      if (spec.max !== undefined && n > spec.max) return `${name} debe ser ≤ ${spec.max}.`;
      return null;
    }
    case "bool":
      return value === "true" || value === "false" ? null : `${name} debe ser exactamente "true" o "false" (ni 1, ni yes).`;
    case "enum":
      return spec.values.includes(value) ? null : `${name} debe ser uno de: ${spec.values.join(" | ")}.`;
    case "nif":
      return isValidSpanishTaxId(value) ? null : `${name} no es un NIF/CIF español válido (letra de control).`;
    case "path":
      if (isReadableFile(resolve(ROOT, value))) return null;
      return { warn: pathSeverityWarn, message: `${name}: el fichero ${value} no existe o no es legible${pathSeverityWarn ? " en este host (dentro del contenedor los certificados se montan en /certs)" : ""}.` };
    case "origin-list":
      return value
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .every((s) => normalizeOrigin(s) !== null)
        ? null
        : `${name} debe ser una lista separada por comas de orígenes http(s)://host[:puerto] sin ruta ni barra final.`;
    case "url": {
      let parsed;
      try {
        parsed = new URL(value);
      } catch {
        return `${name} debe ser una URL válida.`;
      }
      if (!/^https?:$/.test(parsed.protocol)) return `${name} debe usar http:// o https://.`;
      if (/\/$/.test(value)) return `${name} no debe terminar en barra.`;
      if (spec.origin && normalizeOrigin(value) === null) return `${name} debe ser solo un origen (scheme://host[:puerto]), sin ruta.`;
      if (production && spec.httpsInProduction && parsed.protocol !== "https:") return `${name} debe ser https en producción.`;
      return null;
    }
    default: {
      if (spec.minLength !== undefined && value.length < spec.minLength) return `${name} debe tener al menos ${spec.minLength} caracteres.`;
      if (spec.maxLength !== undefined && value.length > spec.maxLength) return `${name} supera los ${spec.maxLength} caracteres.`;
      if (spec.pattern !== undefined && !new RegExp(spec.pattern).test(value)) return `${name} no tiene el formato esperado.`;
      return null;
    }
  }
}

/**
 * Validate parsed values against the contract for a role. Pure.
 * Returns { errors, warnings, checked }.
 */
export function validateValues(values, declared, contract, { role, isExample }) {
  const production = role !== "app";
  const errors = [];
  const warnings = [];
  const push = (severity, message) => (severity === "error" ? errors : warnings).push(message);

  const read = (name) => {
    const raw = values.get(name);
    const spec = contract[name];
    return isPlaceholder(raw, spec?.forbidden ?? []) ? undefined : raw.trim();
  };
  const effective = (name) => read(name) ?? contract[name]?.default;
  const evaluateWhen = (when) =>
    when.split("&&").every((rawClause) => {
      const clause = rawClause.trim();
      const neq = clause.match(/^([A-Z][A-Z0-9_]+)!=(.*)$/);
      if (neq) return effective(neq[1]) !== neq[2].trim();
      const eq = clause.match(/^([A-Z][A-Z0-9_]+)=(.*)$/);
      if (eq) return effective(eq[1]) === eq[2].trim();
      if (clause.startsWith("!")) return read(clause.slice(1).trim()) === undefined;
      return read(clause) !== undefined;
    });

  let checked = 0;
  for (const [name, spec] of Object.entries(contract)) {
    const devOnly = spec.tags?.includes("dev-only");
    if (production && devOnly && values.has(name)) {
      warnings.push(`${name} es solo para desarrollo/tests y aparece en un fichero de producción.`);
    }
    if (production && devOnly) continue;
    checked += 1;

    const raw = values.get(name);
    const value = read(name);
    const severity = spec.severity ?? "error";

    let required = false;
    let reason = "";
    if (spec.required === "always") {
      required = true;
      reason = "obligatoria";
    } else if (spec.required === "production") {
      required = production;
      reason = "obligatoria con NODE_ENV=production";
    } else if (spec.required && typeof spec.required === "object") {
      required = evaluateWhen(spec.required.when);
      reason = `obligatoria cuando ${spec.required.when}`;
    }
    if (role === "production-compose" && COMPOSE_PROVIDED.includes(name)) required = false;
    if (role === "production-native" && name === "VITE_API_URL" && value === undefined) {
      warnings.push("VITE_API_URL no está definida: el build de admin-web hornearía http://localhost:3000. Usa https://<host>/api.");
    }

    // [PROD] variables are advisory outside production (warning), except
    // those with an alternative (a dedicated cross rule reports them).
    const advisory = spec.required === "production" && !production && !spec.alternatives;
    if ((required || advisory) && value === undefined) {
      const satisfiedByAlternative = (spec.alternatives ?? []).some((alt) => read(alt) !== undefined);
      if (!satisfiedByAlternative) {
        if (isExample) {
          if (!declared.has(name)) errors.push(`${name} (${reason}) no está declarada en el fichero de ejemplo.`);
          continue;
        }
        const hint = spec.generate ? ` Genera un valor con: ${spec.generate}.` : "";
        const placeholderNote = raw !== undefined && raw.trim() !== "" ? ` (el valor actual "${raw.trim()}" es un placeholder)` : "";
        push(advisory ? "warn" : severity, `Falta ${name} (${reason})${placeholderNote}.${hint}`);
      }
      continue;
    }
    if (value === undefined) {
      const blankKeepsEmpty = spec.format === "int" || (["url", "enum"].includes(spec.format) && spec.default !== undefined);
      if (raw !== undefined && raw.trim() === "" && blankKeepsEmpty) {
        push(severity, `${name} está definida pero vacía: el código no aplica el valor por defecto${spec.default !== undefined ? ` (${spec.default})` : ""}. Borra la línea o pon un valor.`);
      } else if (raw !== undefined && raw.trim() !== "" && spec.severity !== "warn") {
        warnings.push(`${name} tiene un valor de ejemplo ("${raw.trim()}") y se ignora.`);
      }
      if (isExample && !declared.has(name)) errors.push(`${name} no está declarada en el fichero de ejemplo.`);
      continue;
    }

    const problem = checkFormat(name, spec, value, { production, pathSeverityWarn: role === "production-compose" });
    if (problem) {
      if (typeof problem === "object") push(problem.warn ? "warn" : severity, problem.message);
      else push(severity, problem);
      continue;
    }

    if (production && spec.productionForbidden !== undefined && value === spec.productionForbidden && name !== "HOTELOS_ALLOW_DEMO_AUTH") {
      errors.push(`${name}=${value} está prohibido en producción (${spec.doc.split(".")[0]}).`);
    }
    if (production && spec.productionWarnUnless !== undefined && value !== spec.productionWarnUnless) {
      warnings.push(`${name}=${value}: en producción se espera ${spec.productionWarnUnless}.`);
    }
    if (spec.tags?.includes("deprecated")) warnings.push(`${name} está obsoleta: ${spec.doc}`);
  }

  // ---- Cross-variable rules (same as validateEnv in apps/api/src/lib/env.ts) ----
  const nodeEnv = values.get("NODE_ENV");
  if (nodeEnv !== undefined && nodeEnv.trim() !== "" && !["development", "test", "production"].includes(nodeEnv.trim())) {
    errors.push(`NODE_ENV="${nodeEnv}" no activa ni el modo producción ni el de desarrollo: el RBAC estricto y el guard de la clave PII quedarían desactivados sin querer.`);
  }
  if (role === "production-native" && nodeEnv !== "production") {
    errors.push(`NODE_ENV debe ser production en un despliegue nativo (valor actual: ${nodeEnv === undefined ? "sin definir" : `"${nodeEnv}"`}).`);
  }
  if (read("HOTELOS_FIELD_KEY") === undefined && read("ENCRYPTION_KEY") === undefined) {
    if (production && !isExample) {
      if (!errors.some((e) => e.startsWith("Falta ENCRYPTION_KEY"))) {
        errors.push("Falta la clave de cifrado de PII (HOTELOS_FIELD_KEY o ENCRYPTION_KEY): en producción el API aborta el arranque. Genera una con: openssl rand -base64 32.");
      }
    } else if (!production) {
      warnings.push("Sin HOTELOS_FIELD_KEY/ENCRYPTION_KEY la PII de huéspedes se guarda EN CLARO (aceptable solo en desarrollo local).");
    }
  }
  if (production && read("HOTELOS_ALLOW_DEMO_AUTH") === "true") {
    if (read("HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE") === "true") {
      warnings.push("PELIGRO: HOTELOS_ALLOW_DEMO_AUTH=true en producción con HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE=true: toda petición sin token recibe el super-usuario demo. Solo aceptable en una demo pública sin datos reales.");
    } else {
      errors.push("HOTELOS_ALLOW_DEMO_AUTH no puede estar activo en producción: el API se niega a arrancar (AUTH-04). Elimínalo; solo una demo pública sin datos reales puede forzarlo con HOTELOS_ALLOW_DEMO_AUTH_UNSAFE_OVERRIDE=true.");
    }
  }
  const emailDefined = ["EMAIL_PROVIDER", "EMAIL_PROVIDER_KEY", "EMAIL_FROM"].filter((k) => read(k) !== undefined).length;
  if (emailDefined > 0 && emailDefined < 3 && read("EMAIL_PROVIDER") === undefined) {
    errors.push("EMAIL_PROVIDER_KEY/EMAIL_FROM sin EMAIL_PROVIDER: los tres EMAIL_* van juntos (postmark|sendgrid + clave + remitente).");
  }
  if (production && emailDefined === 0) {
    warnings.push("Sin EMAIL_PROVIDER/EMAIL_PROVIDER_KEY/EMAIL_FROM las invitaciones y el reset de contraseña quedan en modo 'disabled': habrá que entregar los enlaces a mano.");
  }
  if (read("AI_PROVIDER_API_KEY") !== undefined && effective("AI_PROVIDER") === "none") {
    warnings.push("AI_PROVIDER_API_KEY está definida pero AI_PROVIDER=none: el LLM sigue desactivado. Define AI_PROVIDER=anthropic.");
  }
  // Corrección L6a (WT-03): openai sigue en el enum por compatibilidad, pero el runtime lo trata como none.
  if (effective("AI_PROVIDER") === "openai") {
    warnings.push("AI_PROVIDER=openai está retirado (Tanda L6a): el API lo trata como none y responde por reglas. Usa AI_PROVIDER=anthropic.");
  }
  if (production) {
    if (read("CORS_ALLOWED_ORIGINS") === undefined && read("PILOT_PUBLIC_ORIGIN") === undefined) {
      warnings.push("Sin CORS_ALLOWED_ORIGINS: solo se admiten peticiones same-origin (correcto detrás de Caddy sirviendo SPA y API en el mismo origen).");
    }
    if (read("SENTRY_DSN") === undefined) warnings.push("SENTRY_DSN vacío: los errores 5xx no se reportan a Sentry.");
    if (effective("APPLE_WALLET_TEAM_ID") === "HOTELOSDEV") warnings.push("APPLE_WALLET_TEAM_ID sigue con el valor de desarrollo HOTELOSDEV: las llaves móviles de Apple Wallet no serán válidas.");
  }

  // ---- Role-specific keys -------------------------------------------------
  if (role === "production-compose") {
    for (const [name, meta] of Object.entries(COMPOSE_ONLY)) {
      const value = values.get(name)?.trim() ?? "";
      if (!declared.has(name)) {
        push(meta.required ? "error" : "warn", `Falta ${name} (${meta.doc}), requerida por deploy/docker-compose.production.yml.`);
      } else if (meta.required && value === "" && !isExample) {
        errors.push(`${name} está vacía (${meta.doc}).`);
      }
    }
    const publicApi = values.get("PUBLIC_API_URL")?.trim();
    if (publicApi && !isExample && !/^https:\/\/[^/]+\/api$/.test(publicApi)) {
      warnings.push(`PUBLIC_API_URL=${publicApi}: con Caddy en el mismo origen se espera https://<DOMAIN>/api.`);
    }
  }

  // ---- Unknown / retired keys ----------------------------------------------
  for (const name of values.keys()) {
    if (name in contract || name in COMPOSE_ONLY) continue;
    if (RETIRED_KEYS.includes(name)) {
      warnings.push(`${name} ya no la lee ningún código (retirada en la Tanda 4): elimínala del fichero.`);
    } else {
      warnings.push(`${name} no está en el contrato de entorno: ningún código la lee (o falta documentarla en apps/api/src/lib/env.ts).`);
    }
  }

  return { errors, warnings, checked };
}

function inferRole(args, envPath, values) {
  const roleIndex = args.indexOf("--role");
  if (roleIndex >= 0) {
    const role = args[roleIndex + 1];
    if (!ROLES.includes(role)) throw new Error(`--role debe ser uno de: ${ROLES.join(" | ")} (recibido: ${role ?? "nada"}).`);
    return role;
  }
  const fromFlag = args.find((a) => a.startsWith("--role="));
  if (fromFlag) {
    const role = fromFlag.slice("--role=".length);
    if (!ROLES.includes(role)) throw new Error(`--role debe ser uno de: ${ROLES.join(" | ")} (recibido: ${role}).`);
    return role;
  }
  if (args.includes("--production") || /production/i.test(envPath)) return "production-compose";
  if (values.get("NODE_ENV") === "production") return "production-native";
  return "app";
}

export function run(argv) {
  const args = argv.slice(2);
  const asJson = args.includes("--json");
  const positional = args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--role");
  const envPath = positional[0] ?? ".env.example";
  if (!existsSync(envPath)) {
    throw new Error(`No existe el fichero ${envPath}. Copia el ejemplo primero (cp .env.example .env o cp deploy/.env.production.example deploy/.env.production).`);
  }
  const { values, declared } = parseEnvFile(readFileSync(envPath, "utf8"));
  const role = inferRole(args, envPath, values);
  const isExample = envPath.endsWith(".example");
  const contract = loadContract();
  const report = validateValues(values, declared, contract, { role, isExample });
  const ok = report.errors.length === 0;

  if (asJson) {
    process.stdout.write(JSON.stringify({ ok, path: envPath, role, isExample, ...report }, null, 2) + "\n");
  } else {
    for (const warning of report.warnings) console.warn(`AVISO: ${warning}`);
    for (const error of report.errors) console.error(`ERROR: ${error}`);
    if (ok) {
      console.log(`Contrato de entorno OK: ${envPath} (rol ${role}${isExample ? ", ejemplo" : ""}) · ${report.checked} variables comprobadas · ${report.warnings.length} aviso(s).`);
    } else {
      console.error(`Contrato de entorno FALLIDO para ${envPath} (rol ${role}): ${report.errors.length} error(es), ${report.warnings.length} aviso(s).`);
    }
  }
  return ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(run(process.argv));
  } catch (error) {
    console.error(`validate-env: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}

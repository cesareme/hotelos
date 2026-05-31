import { readFileSync } from "node:fs";

const requiredVariables = [
  "DATABASE_URL",
  "REDIS_URL",
  "JWT_SECRET",
  "ENCRYPTION_KEY",
  "OBJECT_STORAGE_BUCKET",
  "OBJECT_STORAGE_REGION",
  "OBJECT_STORAGE_ACCESS_KEY",
  "OBJECT_STORAGE_SECRET_KEY",
  "AI_PROVIDER_API_KEY",
  "OCR_PROVIDER_API_KEY",
  "SPEECH_PROVIDER_API_KEY",
  "PAYMENT_PROVIDER_SECRET",
  "WHATSAPP_PROVIDER_TOKEN",
  "EMAIL_PROVIDER_KEY",
  "SES_HOSPEDAJES_CLIENT_ID",
  "SES_HOSPEDAJES_CLIENT_SECRET",
  "APP_PUBLIC_API_URL",
  "SENTRY_DSN"
];

const envPath = process.argv[2] ?? ".env.example";
const envFile = readFileSync(envPath, "utf8");
const keys = new Set(
  envFile
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split("=")[0])
);

const missing = requiredVariables.filter((key) => !keys.has(key));

if (missing.length > 0) {
  console.error(`Missing required variables in ${envPath}: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`Environment contract ok: ${requiredVariables.length} variables present in ${envPath}.`);


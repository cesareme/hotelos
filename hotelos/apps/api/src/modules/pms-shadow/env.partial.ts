// Variables de entorno del modo sombra OPERA Cloud (Tanda 7b · L3). Mismo formato
// que ENV_CONTRACT en apps/api/src/lib/env.ts: env.ts hace spread de
// PMS_SHADOW_ENV_CONTRACT (sección «Schedulers») y scripts/env-census.mjs
// encuentra documentada cada lectura (server.ts y pms-shadow.job.ts).
//
// Decisiones:
//   · El job corre en el API bajo el líder (`RUN_SCHEDULERS`, isSchedulerLeader):
//     apps/worker no depende de @hotelos/api (§10 nº 10). PMS_SHADOW_JOB_DISABLED
//     es el interruptor fino, como los *_SCHEDULER_DISABLED de los demás.
//   · Cada vuelta (PMS_SHADOW_JOB_INTERVAL_MS, 15 min por defecto) toma
//     pg_try_advisory_xact_lock(hashtext('pms_shadow.job')): una segunda réplica
//     mal configurada salta la vuelta en vez de duplicar alertas.
//   · El CLI pms-shadow:pull usa flags, no variables de entorno (corrección g).

import type { EnvContract } from "../../lib/env.js";

export const PMS_SHADOW_ENV_CONTRACT: EnvContract = Object.freeze({
  PMS_SHADOW_JOB_DISABLED: {
    section: "Schedulers",
    format: "bool",
    default: "false",
    doc: "true desactiva el job del modo sombra OPERA (alertas OPERA_FEED_LATE y cierre de runs interrumpidos). Solo actúa en el líder (RUN_SCHEDULERS)."
  },
  PMS_SHADOW_JOB_INTERVAL_MS: {
    section: "Schedulers",
    format: "int",
    min: 10_000,
    max: 86_400_000,
    default: "900000",
    doc: "Periodo del job del modo sombra OPERA (ms); por defecto 15 minutos."
  },
  // SEC-06: el agente de carpeta (scripts/pms-shadow-pull.ts) toma el ingest y la clave del entorno del cron
  // (fichero 600) en vez de argv, donde la clave quedaría visible en ps, crontab e historial del shell.
  PMS_SHADOW_INGEST_URL: {
    section: "Schedulers",
    format: "url",
    severity: "warn",
    tags: ["tool"],
    doc: "Agente pms-shadow:pull (VPS): origen del API o URL completa de POST /integrations/pms-shadow/ingest; equivale a --ingest-url."
  },
  PMS_SHADOW_API_KEY: {
    section: "Schedulers",
    format: "string",
    severity: "warn",
    tags: ["tool", "secret"],
    pattern: "^cli_[A-Za-z0-9_-]+\\.[^\\s]+$",
    doc: "Agente pms-shadow:pull (VPS): clave <clientId>.<clientSecret> de la DeveloperApp con scope pms.shadow.ingest; equivale a --api-key (preferible al flag: no queda en ps ni en el historial)."
  }
});

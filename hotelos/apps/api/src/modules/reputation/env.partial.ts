// Variables de entorno del módulo de reputación (Tanda T8 · lote T8-C). Mismo
// formato que ENV_CONTRACT en apps/api/src/lib/env.ts (patrón de
// modules/pms-shadow/env.partial.ts): el integrador hace spread de
// REPUTATION_ENV_CONTRACT en la sección «Schedulers» (mergeLine tras la línea
// 752 de env.ts, import tras la 22) y regenera scripts/env-contract.json,
// .env.example y deploy/.env.production.example con node scripts/env-census.mjs --write.
//
// Decisiones:
//   · El job corre en el API bajo el líder (RUN_SCHEDULERS, isSchedulerLeader):
//     apps/worker no depende de @hotelos/api. REPUTATION_SYNC_DISABLED es el
//     interruptor fino, como los *_SCHEDULER_DISABLED de los demás; el tick
//     toma pg_try_advisory_xact_lock(hashtext('reputation.sync')).
//   · Ningún fichero de modules/reputation lee estas variables directamente:
//     server.ts las lee del contrato y las pasa como opciones a
//     shouldStartReputationSyncJob / startReputationSyncJob (interruptor,
//     periodo, arranque) y como CollectorOptions (ids de cliente de Google).
//   · Google Business Profile: OAuth business.manage; sin ellas la fuente
//     queda unavailable con motivo honesto (collectors/google-business-profile.ts).

import type { EnvContract } from "../../lib/env.js";

export const REPUTATION_ENV_CONTRACT: EnvContract = Object.freeze({
  REPUTATION_SYNC_DISABLED: {
    section: "Schedulers",
    format: "bool",
    default: "false",
    doc: "true desactiva el job diario de reputación (sincronización de reseñas, análisis, alertas y purga). Solo actúa en el líder (RUN_SCHEDULERS)."
  },
  REPUTATION_SYNC_INTERVAL_MS: {
    section: "Schedulers",
    format: "int",
    min: 60_000,
    max: 604_800_000,
    default: "86400000",
    doc: "Periodo del job de reputación (ms); por defecto 24 horas (mínimo 1 minuto, máximo 7 días)."
  },
  REPUTATION_SYNC_RUN_AT_BOOT: {
    section: "Schedulers",
    format: "bool",
    default: "true",
    doc: "true ejecuta una vuelta del job de reputación al arrancar el líder (además del periodo); false espera al primer intervalo."
  },
  GOOGLE_BUSINESS_CLIENT_ID: {
    section: "OTA",
    format: "string",
    severity: "warn",
    doc: "Google Business Profile: OAuth business.manage; sin ellas la fuente queda unavailable. Id de cliente OAuth del proyecto Cloud del producto."
  },
  GOOGLE_BUSINESS_CLIENT_SECRET: {
    section: "OTA",
    format: "string",
    severity: "warn",
    tags: ["secret"],
    doc: "Google Business Profile: OAuth business.manage; sin ellas la fuente queda unavailable. Secreto de cliente OAuth (nunca en configJson de la fuente)."
  },
  GOOGLE_BUSINESS_REDIRECT_URI: {
    section: "OTA",
    format: "url",
    severity: "warn",
    httpsInProduction: true,
    doc: "Google Business Profile: OAuth business.manage; sin ellas la fuente queda unavailable. URI de retorno registrada en la consola de Google; la usará el callback OAuth del lote T8-L5 (hoy no existe ninguna ruta de autorización)."
  }
});

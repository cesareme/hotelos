import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for admin-web E2E (Tanda UX-1 · lote U1).
 *
 *  - Tres proyectos: `measure` (e2e/measure/t1…t6, medida automatizada del
 *    camino óptimo, docs/design/UX-RECEPCION-FEEL.md §8.6) con trace "on" para
 *    que cada tarea deje su traza completa; `chromium` (specs de humo de
 *    recepción, e2e/*.spec.ts) y `touch` (U10 · e2e/target-size.spec.ts:
 *    tablet emulada con `hasTouch` —Chromium pasa a `pointer: coarse`—, iPad
 *    apaisado 1024 × 768 y vertical 820 × 1180, claro y oscuro con
 *    `colorScheme`; contrato de tamaño de objetivos §7.1 2.5.8 y contraste de
 *    badges en oscuro). `measure` va primero para que la medida canónica use
 *    UXDAY-T1 y la spec de humo la otra llegada sin habitación; `touch` va el
 *    último porque solo lee.
 *  - Secuencial (1 worker, 0 reintentos): los flujos escriben en el tenant
 *    aislado UXDAY (seed-ux-day) y una tarea depende del estado que deja la
 *    anterior; el login de e2e tiene límite 10/min por IP.
 *  - Sin login gate: las specs autentican con `loginAsUxDay` (e2e/_helpers.ts)
 *    contra `E2E_API_URL` (por defecto http://127.0.0.1:3000) y navegan a
 *    `E2E_BASE_URL` (por defecto http://localhost:5173). Con instancia propia:
 *      E2E_BASE_URL=http://127.0.0.1:5183 E2E_API_URL=http://127.0.0.1:3913 \
 *        corepack pnpm --filter @hotelos/admin-web e2e
 *      corepack pnpm --filter @hotelos/admin-web e2e:measure   (solo measure)
 *    Ejecuta antes el seed rearmado: corepack pnpm --filter @hotelos/database db:seed:ux-day -- --reset
 *  - Límite del API: la suite completa hace ~1.250 peticiones contadas (más de
 *    1.000 preflights OPTIONS que no cuentan) en menos de 2 min con un solo usuario
 *    e IP (cada carga de página son 11-12 GET del shell). Con el techo base
 *    `RATE_LIMIT_MAX` (600/min por usuario + IP) el API respondía 429 a la propia
 *    app de forma aleatoria. El limitador (AUTH-05) no se toca: el API de pruebas
 *    arranca con `RATE_LIMIT_MAX=5000` (corrector UX1-REV-06 / R3):
 *      cd apps/api && PORT=3913 RUN_SCHEDULERS=false TENANT_BOOTSTRAP_SKIP=true \
 *        RATE_LIMIT_MAX=5000 node --env-file-if-exists=../../.env --import tsx src/server.ts
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    actionTimeout: 5_000,
    navigationTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "es-ES",
    timezoneId: "Europe/Madrid"
  },
  projects: [
    {
      name: "measure",
      testDir: "./e2e/measure",
      retries: 0,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 }, trace: "on" }
    },
    {
      name: "chromium",
      testIgnore: /measure/,
      // U10: la spec de tablet (target-size) corre solo en el proyecto `touch`.
      testMatch: /^(?!.*target-size).*\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } }
    },
    {
      // Tablet emulada (U10): la spec fija viewport y colorScheme por bloque (`test.use`).
      name: "touch",
      testMatch: /target-size\.spec\.ts$/,
      use: { browserName: "chromium", viewport: { width: 1024, height: 768 }, hasTouch: true, deviceScaleFactor: 2, colorScheme: "light" }
    }
  ]
});

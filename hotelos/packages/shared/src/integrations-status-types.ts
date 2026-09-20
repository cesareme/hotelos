// Estado honesto de las integraciones (Tanda L8 · L8-01).
//
// Contrato compartido por el API (GET /integrations/status, bloque `integrations`
// de /health) y el admin-web (Configuración › Módulos › Integraciones). Cada
// integración declara UN modo y lo que falta para operar en real; nunca cuenta
// un «enviado» que no salió del sistema.
//
// Vocabulario (fijo):
//   · mode  — cómo cruzan hoy los datos hacia el sistema externo:
//       none    → no hay integración operativa (sin credenciales, sin perfil,
//                 sin filas… o el componente no aplica / nadie lo consume);
//       sandbox → simulador local, registro «SIMULADO» o entorno de pruebas del
//                 proveedor: ningún resultado tiene efecto real ni se presenta
//                 como tal (nunca «enviado»);
//       real    → los datos son reales y cruzan de verdad (por HTTP o por
//                 ficheros reales cargados, p. ej. informes OPERA o Sage 200).
//   · transport — por dónde cruzan: `http` (API del proveedor), `files`
//     (ficheros reales cargados o generados), `manual` (una persona lo hace a
//     mano), `none` (nada cruza).
//   · configured — hay configuración o filas para esta integración, sea cual
//     sea el modo (Redis puede estar «configurado» y en modo none).
//   · readyForReal — SOLO true cuando mode === "real" y missingForReal está
//     vacío. mode none ⇒ readyForReal=false y lastActivityAt=null (regla fija,
//     aplicada por el servicio y fijada por el contrato de tests).
//   · missingForReal — qué falta para operar en real sin reservas (credencial,
//     contrato o decisión): frases en español para la pantalla.
//   · lastActivityAt / lastError — última actividad real o simulada (ISO 8601)
//     y último error registrado; nunca contadores inventados.
//   · screen — ruta del admin-web donde se opera la integración (null si no
//     tiene pantalla, p. ej. Sentry / Redis).

export const INTEGRATION_MODES = ["none", "sandbox", "real"] as const;
export type IntegrationMode = (typeof INTEGRATION_MODES)[number];

export const INTEGRATION_MODE_LABELS_ES: Readonly<Record<IntegrationMode, string>> = Object.freeze({
  none: "Sin integración",
  sandbox: "Pruebas (sin efecto real)",
  real: "Real"
});

export const INTEGRATION_TRANSPORTS = ["files", "http", "manual", "none"] as const;
export type IntegrationTransport = (typeof INTEGRATION_TRANSPORTS)[number];

export const INTEGRATION_TRANSPORT_LABELS_ES: Readonly<Record<IntegrationTransport, string>> = Object.freeze({
  files: "Ficheros",
  http: "API (red)",
  manual: "Manual",
  none: "Ninguno"
});

/** Claves fijas del inventario L8 (orden de presentación en la pantalla). */
export const INTEGRATION_KEYS = [
  "opera",
  "sage200",
  "gestoria_export",
  "channels",
  "psp",
  "whatsapp",
  "email_out",
  "sms",
  "email_in",
  "gbp",
  "ses",
  "verifactu",
  "tbai",
  "igic",
  "storage",
  "ai",
  "sentry",
  "redis"
] as const;
export type IntegrationKey = (typeof INTEGRATION_KEYS)[number];

export const INTEGRATION_LABELS_ES: Readonly<Record<IntegrationKey, string>> = Object.freeze({
  opera: "OPERA Cloud (modo sombra)",
  sage200: "Sage 200 (importación contable)",
  gestoria_export: "Exportación a gestoría",
  channels: "Canales de venta (OTAs)",
  psp: "Pasarela de pago (PSP)",
  whatsapp: "WhatsApp",
  email_out: "Correo saliente",
  sms: "SMS",
  email_in: "Correo entrante (OAuth)",
  gbp: "Google Business Profile",
  ses: "SES.Hospedajes",
  verifactu: "VeriFactu",
  tbai: "TicketBAI",
  igic: "IGIC (Canarias)",
  storage: "Almacén de documentos (S3)",
  ai: "Proveedor de IA",
  sentry: "Sentry",
  redis: "Redis"
});

/**
 * Pantalla del admin-web donde se opera cada integración (rutas ya existentes
 * en `pilots/tanda5-nav-tree.csv`; L8 no añade rutas de front). null = sin
 * pantalla (componentes de plataforma).
 */
export const INTEGRATION_SCREENS: Readonly<Record<IntegrationKey, string | null>> = Object.freeze({
  opera: "/configuracion/modulos/modo-sombra",
  sage200: "/finanzas/contabilidad/importar-sage200",
  gestoria_export: "/finanzas/contabilidad/exportar-gestoria",
  channels: "/comercial/canales",
  psp: "/configuracion/facturacion-pagos/pagos",
  whatsapp: "/configuracion/comunicaciones",
  email_out: "/configuracion/comunicaciones",
  sms: "/configuracion/comunicaciones",
  email_in: "/configuracion/comunicaciones/correo-entrante",
  gbp: "/comercial/reputacion",
  ses: "/cumplimiento/envios",
  verifactu: "/cumplimiento/verifactu",
  tbai: "/cumplimiento/verifactu",
  igic: "/cumplimiento/verifactu",
  storage: "/operaciones/digitalizar",
  ai: "/configuracion/ia",
  sentry: null,
  redis: null
});

export type IntegrationStatusDto = {
  key: IntegrationKey;
  label: string;
  mode: IntegrationMode;
  transport: IntegrationTransport;
  configured: boolean;
  readyForReal: boolean;
  /** Una frase en español, sin URLs ni nombres de variables secretas. */
  message: string;
  missingForReal: string[];
  /** ISO 8601 o null. Siempre null cuando mode === "none". */
  lastActivityAt: string | null;
  lastError: string | null;
  screen: string | null;
};

/** Entrada del bloque `integrations` de GET /health (público): solo modo y frase. */
export type IntegrationHealthEntry = { mode: IntegrationMode; message: string };

/**
 * Bloque `integrations` de /health: subconjunto SIN base de datos (las
 * integraciones por propiedad — opera, sage200, psp, gbp — no aparecen).
 */
export type IntegrationsHealthBlock = Partial<Record<IntegrationKey, IntegrationHealthEntry>>;

/** GET /integrations/status?propertyId= — 200. */
export type IntegrationsStatusResponse = {
  generatedAt: string;
  propertyId: string;
  integrations: IntegrationStatusDto[];
  /** Consultas que fallaron y se degradaron a «sin datos» (nunca a un éxito). */
  degraded: string[];
};

export function isIntegrationKey(value: unknown): value is IntegrationKey {
  return typeof value === "string" && (INTEGRATION_KEYS as readonly string[]).includes(value);
}

export function isIntegrationMode(value: unknown): value is IntegrationMode {
  return typeof value === "string" && (INTEGRATION_MODES as readonly string[]).includes(value);
}

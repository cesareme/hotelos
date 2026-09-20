// Resolución del hardware de un kiosco (Tanda CHK · lote W3-C; diseño §2.2 y
// §2.4): a partir de KioskDevice.capabilitiesJson ({ mrzReader, cardEncoder,
// paymentTerminal, printer }, kiosk.service.ts capabilitiesOf) y
// KioskDevice.lockProvider (texto libre ≤ 40, checkin.schemas.ts) se eligen
// los adaptadores con los que trabaja el flujo del kiosco.
//
// Modo (fail-closed): sin `mode: "sandbox"` explícito se resuelve en
// "production", donde hoy NO existe ningún proveedor real de tarjetas ni de
// llaves → noneCardEncoder / noneLock («recoge tu tarjeta/llave en
// recepción»). El sandbox solo se activa cuando el llamador lo pide (demo,
// tests: hardwareModeFor(process.env.NODE_ENV) en el servicio que llame; este
// fichero no lee process.env, como el resto del módulo). El lector de MRZ no
// depende del modo: un keyboard wedge produce texto real.
//
// El terminal de pago y la impresora no tienen adaptador en este lote: se
// exponen tal cual en `capabilities` para que el kiosco decida (pago por
// enlace al móvil / sin ticket impreso).

import { bufferedMrzReader, noneMrzReader, type MrzReader, type MrzReaderKind } from "./mrz-reader.adapter.js";
import { noneCardEncoder, sandboxCardEncoder, type CardEncoder, type CardEncoderProvider } from "./card-encoder.adapter.js";
import { LOCK_PROVIDERS, noneLock, sandboxLock, type LockAdapter, type LockProvider } from "./lock.adapter.js";

export * from "./mrz-reader.adapter.js";
export * from "./card-encoder.adapter.js";
export * from "./lock.adapter.js";

export type KioskHardwareMode = "production" | "sandbox";

/** Subconjunto de la fila KioskDevice (Prisma) o del DTO que necesita la resolución. */
export type KioskHardwareSource = {
  capabilitiesJson?: unknown;
  capabilities?: unknown;
  lockProvider: string | null;
};

export type KioskCapabilities = { mrzReader: boolean; cardEncoder: boolean; paymentTerminal: boolean; printer: boolean };

export type KioskHardware = {
  mode: KioskHardwareMode;
  capabilities: KioskCapabilities;
  /** Proveedor normalizado a partir de lockProvider (none si vacío o desconocido). */
  lockProvider: LockProvider;
  /** Valor crudo de KioskDevice.lockProvider (para el diagnóstico del kiosco). */
  lockProviderRaw: string | null;
  mrzReader: MrzReader;
  cardEncoder: CardEncoder;
  lock: LockAdapter;
  /** Resumen sin objetos para /kiosk/me y los logs. */
  summary: { mrzReader: MrzReaderKind; cardEncoder: CardEncoderProvider; lock: LockProvider; sandbox: boolean };
};

/** "production" salvo que NODE_ENV sea distinto de production (dev, test, demo). */
export function hardwareModeFor(nodeEnv: string | undefined): KioskHardwareMode {
  return nodeEnv === "production" ? "production" : "sandbox";
}

const LOCK_PROVIDER_ALIASES: Record<string, Exclude<LockProvider, "none">> = {
  salto: "salto_space",
  salto_space: "salto_space",
  saltospace: "salto_space",
  salto_ks: "salto_space",
  saltoks: "salto_space",
  assa: "assa_vostio",
  assa_abloy: "assa_vostio",
  assaabloy: "assa_vostio",
  vostio: "assa_vostio",
  assa_vostio: "assa_vostio",
  visionline: "assa_vostio",
  dormakaba: "dormakaba",
  kaba: "dormakaba",
  ambiance: "dormakaba"
};

/** Texto libre de KioskDevice.lockProvider → proveedor conocido o "none". */
export function normalizeLockProvider(value: string | null | undefined): LockProvider {
  if (typeof value !== "string") return "none";
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (key.length === 0) return "none";
  if ((LOCK_PROVIDERS as readonly string[]).includes(key)) return key as LockProvider;
  return LOCK_PROVIDER_ALIASES[key] ?? "none";
}

function capabilitiesOf(value: unknown): KioskCapabilities {
  const source = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    mrzReader: source.mrzReader === true,
    cardEncoder: source.cardEncoder === true,
    paymentTerminal: source.paymentTerminal === true,
    printer: source.printer === true
  };
}

/**
 * Adaptadores de un kiosco (null = sin kiosco, p. ej. portal del huésped o
 * recepción: todo none salvo el lector, que tampoco hay).
 */
export function resolveHardware(kiosk: KioskHardwareSource | null, options: { mode?: KioskHardwareMode } = {}): KioskHardware {
  const mode: KioskHardwareMode = options.mode ?? "production";
  const capabilities = capabilitiesOf(kiosk?.capabilitiesJson ?? kiosk?.capabilities);
  const lockProviderRaw = kiosk?.lockProvider ?? null;
  const lockProvider = normalizeLockProvider(lockProviderRaw);
  const sandbox = mode === "sandbox" && lockProvider !== "none";

  const mrzReader: MrzReader = capabilities.mrzReader ? bufferedMrzReader("keyboard_wedge") : noneMrzReader;
  const cardEncoder: CardEncoder = sandbox && capabilities.cardEncoder ? sandboxCardEncoder(lockProvider) : noneCardEncoder;
  const lock: LockAdapter = sandbox ? sandboxLock(lockProvider) : noneLock;

  return {
    mode,
    capabilities,
    lockProvider,
    lockProviderRaw,
    mrzReader,
    cardEncoder,
    lock,
    summary: { mrzReader: mrzReader.kind, cardEncoder: cardEncoder.provider, lock: lock.provider, sandbox }
  };
}

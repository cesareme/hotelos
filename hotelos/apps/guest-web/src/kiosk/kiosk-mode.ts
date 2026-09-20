// Modo kiosco del portal del huésped (Tanda CHK · lote W4-C; diseño §4c
// columna «Kiosco / tablet» y §8 fila «Kiosco»): `?kiosk=1&device=<id>`,
// pantalla completa, inactividad 90 s → reinicio y borrado de la sesión del
// huésped, handoff con nº de ticket para el mostrador.
//
// Módulo PURO (sin React ni DOM directo): el almacenamiento, los temporizadores
// y el reloj se inyectan para que __tests__/wizard.test.mts lo cubra con node.
// El token del kiosco (deviceToken de POST /guest-portal/check-in/kiosk/claim)
// es una credencial del DISPOSITIVO, no del huésped: se guarda en localStorage
// de la tablet (sobrevive a recargas; los códigos de emparejamiento son de un
// solo uso). La sesión del huésped NUNCA se persiste en modo kiosco.

/** Inactividad antes de reiniciar la pantalla (diseño §8: 90 s). */
export const IDLE_TIMEOUT_MS = 90_000;
export const idleTimeoutMs = IDLE_TIMEOUT_MS;

/** Aviso en pantalla durante los últimos segundos antes del reinicio. */
export const IDLE_WARNING_MS = 15_000;

export const KIOSK_QUERY_PARAM = "kiosk";
export const KIOSK_DEVICE_PARAM = "device";
export const KIOSK_STORAGE_KEY = "hotelos.kiosk.device";
/** Clave de la sesión del huésped en sessionStorage (GuestSessionContext); el kiosco la borra al reiniciar. */
export const GUEST_SESSION_STORAGE_KEY = "hotelos.guest.session";
export const GUEST_ARRIVAL_STORAGE_KEY = "hotelos.guest.arrival";

export type KioskParams = {
  enabled: boolean;
  /** `?device=<KioskDevice.id>` (informativo: el token manda; null si falta). */
  deviceId: string | null;
  /** `?property=<id>` para el sign-in por código + correo. */
  propertyId: string | null;
};

type LocationLike = { search?: string | null };

/** Lee `?kiosk=1&device=<id>` (también `kiosk=true`/`yes`). Nunca lanza. */
export function parseKioskParams(location: LocationLike | string | null | undefined): KioskParams {
  const search = typeof location === "string" ? location : (location?.search ?? "");
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  } catch {
    return { enabled: false, deviceId: null, propertyId: null };
  }
  const flag = (params.get(KIOSK_QUERY_PARAM) ?? "").trim().toLowerCase();
  const enabled = flag === "1" || flag === "true" || flag === "yes";
  const deviceId = (params.get(KIOSK_DEVICE_PARAM) ?? "").trim() || null;
  const propertyId = (params.get("property") ?? "").trim() || null;
  return { enabled, deviceId: enabled ? deviceId : null, propertyId };
}

// ---------------------------------------------------------------------------
// Credencial del dispositivo
// ---------------------------------------------------------------------------

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export type KioskDeviceCredential = {
  deviceId: string;
  token: string;
  name: string | null;
  propertyId: string | null;
  capabilities: { mrzReader: boolean; cardEncoder: boolean; paymentTerminal: boolean; printer: boolean };
  pairedAt: string;
};

export function readKioskDevice(storage: StorageLike | null | undefined): KioskDeviceCredential | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(KIOSK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<KioskDeviceCredential>;
    if (typeof parsed.token !== "string" || parsed.token.trim() === "" || typeof parsed.deviceId !== "string") return null;
    return {
      deviceId: parsed.deviceId,
      token: parsed.token,
      name: typeof parsed.name === "string" ? parsed.name : null,
      propertyId: typeof parsed.propertyId === "string" ? parsed.propertyId : null,
      capabilities: {
        mrzReader: parsed.capabilities?.mrzReader === true,
        cardEncoder: parsed.capabilities?.cardEncoder === true,
        paymentTerminal: parsed.capabilities?.paymentTerminal === true,
        printer: parsed.capabilities?.printer === true
      },
      pairedAt: typeof parsed.pairedAt === "string" ? parsed.pairedAt : ""
    };
  } catch {
    return null;
  }
}

export function writeKioskDevice(storage: StorageLike | null | undefined, device: KioskDeviceCredential): boolean {
  if (!storage) return false;
  try {
    storage.setItem(KIOSK_STORAGE_KEY, JSON.stringify(device));
    return true;
  } catch {
    return false;
  }
}

export function clearKioskDevice(storage: StorageLike | null | undefined): void {
  if (!storage) return;
  try {
    storage.removeItem(KIOSK_STORAGE_KEY);
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Reinicio de la sesión del huésped
// ---------------------------------------------------------------------------

export type ResetSessionInput = {
  /** sessionStorage de la pestaña (se borran las claves del huésped, nunca la del kiosco). */
  sessionStorage?: StorageLike | null;
  /** Borra el token del huésped en memoria (client.ts setGuestToken(null)). */
  clearGuestToken?: () => void;
  /** Cierra la sesión de React (GuestSessionContext.signOut). */
  signOut?: () => void;
};

export type ResetSessionResult = { clearedKeys: string[]; tokenCleared: boolean; signedOut: boolean };

/** Reinicio del kiosco: borra la sesión del huésped (memoria + sessionStorage) y deja la credencial del dispositivo. */
export function resetSession(input: ResetSessionInput = {}): ResetSessionResult {
  const clearedKeys: string[] = [];
  for (const key of [GUEST_SESSION_STORAGE_KEY, GUEST_ARRIVAL_STORAGE_KEY]) {
    try {
      if (input.sessionStorage?.getItem(key) !== null && input.sessionStorage?.getItem(key) !== undefined) {
        input.sessionStorage.removeItem(key);
        clearedKeys.push(key);
      }
    } catch {
      // ignore
    }
  }
  let tokenCleared = false;
  if (input.clearGuestToken) {
    input.clearGuestToken();
    tokenCleared = true;
  }
  let signedOut = false;
  if (input.signOut) {
    input.signOut();
    signedOut = true;
  }
  return { clearedKeys, tokenCleared, signedOut };
}

// ---------------------------------------------------------------------------
// Temporizador de inactividad
// ---------------------------------------------------------------------------

export type IdleTimerOptions = {
  timeoutMs?: number;
  warningMs?: number;
  onIdle: () => void;
  onWarning?: (secondsLeft: number) => void;
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  now?: () => number;
};

export type IdleTimer = {
  /** Actividad del usuario: reinicia la cuenta. */
  touch: () => void;
  stop: () => void;
  isRunning: () => boolean;
  /** ms restantes hasta el reinicio (para pintar el aviso). */
  remainingMs: () => number;
};

/** Cuenta atrás de inactividad con aviso previo; los temporizadores se inyectan para los tests. */
export function createIdleTimer(options: IdleTimerOptions): IdleTimer {
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? IDLE_TIMEOUT_MS);
  const warningMs = Math.min(Math.max(0, options.warningMs ?? IDLE_WARNING_MS), timeoutMs);
  const schedule = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms));
  const cancel = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = options.now ?? (() => Date.now());
  let idleHandle: unknown = null;
  let warningHandle: unknown = null;
  let deadline = 0;
  let running = false;

  const clearHandles = () => {
    if (idleHandle !== null) cancel(idleHandle);
    if (warningHandle !== null) cancel(warningHandle);
    idleHandle = null;
    warningHandle = null;
  };

  const touch = () => {
    clearHandles();
    running = true;
    deadline = now() + timeoutMs;
    if (options.onWarning && warningMs > 0) {
      warningHandle = schedule(() => {
        warningHandle = null;
        options.onWarning?.(Math.ceil(warningMs / 1000));
      }, timeoutMs - warningMs);
    }
    idleHandle = schedule(() => {
      idleHandle = null;
      running = false;
      options.onIdle();
    }, timeoutMs);
  };

  return {
    touch,
    stop: () => {
      clearHandles();
      running = false;
    },
    isRunning: () => running,
    remainingMs: () => (running ? Math.max(0, deadline - now()) : 0)
  };
}

// ---------------------------------------------------------------------------
// Ticket de handoff
// ---------------------------------------------------------------------------

/**
 * Número de ticket para el mostrador: «K-» + 4 dígitos deterministas a partir
 * de la sesión y el minuto (misma sesión y minuto → mismo ticket, para que el
 * huésped y el recepcionista lean el mismo número aunque la pantalla se repinte).
 */
export function handoffTicket(seed: string, now: Date = new Date()): string {
  const minute = Math.floor(now.getTime() / 60_000);
  const input = `${seed}:${minute}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `K-${String(hash % 10_000).padStart(4, "0")}`;
}

/** Cabecera de autenticación del kiosco (client.ts la envía junto a x-guest-token). */
export const KIOSK_TOKEN_HEADER = "x-kiosk-token";

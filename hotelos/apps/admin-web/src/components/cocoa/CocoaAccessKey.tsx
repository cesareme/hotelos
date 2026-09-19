// CocoaAccessKey — tecla de acceso revelada al mantener ⌥ (Tanda UX-1 · lote U5;
// docs/design/UX-RECEPCION-FEEL.md §1.1 P2, §4 «Atajos por pantalla y teclas de
// acceso», §10 D7: estilo OPERA con Ctrl).
//
//   · `CocoaButton accessKey="C"` registra su elemento aquí; mientras ⌥ está
//     pulsado pinta la letra en un `CocoaKbd` junto a la etiqueta y ⌥C ejecuta el
//     botón (`element.click()`, así respeta `disabled`, `type="submit"` y el
//     `onClick` del consumidor) si está visible y habilitado.
//   · El estado `altHeld` es global (un solo par de oyentes, instalado por
//     CocoaGlobalProvider con `installAltHeldTracking`) y se lee con
//     `useCocoaAltHeld()`; fuera del provider vale `false` (auth, guest-web).
//   · Precedencia: el provider consulta `dispatchAccessKey` ANTES de los atajos
//     ⌥ de navegación, de modo que una acción visible gana a la navegación; por
//     eso las letras H R N T B F W están reservadas (RESERVED_ACCESS_LETTERS) y
//     en desarrollo se avisa si un botón las reutiliza.
//   · R8: se compara `event.code` («KeyC»), nunca `key` (⌥C = «ç» en macOS); no
//     actúa dentro de un `<textarea>` ni de un editable (ahí ⌥ escribe símbolos);
//     en un campo de una línea sí, porque el cobro (⌥1/2/3 con el foco en el
//     importe) y las fichas viven en campos.
//
// Sin `style=` propio: el chip es el `CocoaKbd` existente (`c22-kbd`).

import { useEffect, useSyncExternalStore, type RefObject } from "react";
import { CocoaKbd } from "./CocoaKbd";
import { RESERVED_ACCESS_LETTERS, letterOfCode } from "../../content/shortcuts-registry";

// ---------------------------------------------------------------------------
// altHeld — estado global (módulo) con suscripción para React.
// ---------------------------------------------------------------------------
let altHeld = false;
const altListeners = new Set<() => void>();

function setAltHeld(next: boolean): void {
  if (altHeld === next) return;
  altHeld = next;
  for (const listener of altListeners) listener();
}

export function getAltHeld(): boolean {
  return altHeld;
}

export function subscribeAltHeld(listener: () => void): () => void {
  altListeners.add(listener);
  return () => {
    altListeners.delete(listener);
  };
}

const getServerAltHeld = () => false;

/** `true` mientras ⌥ está pulsado (estado global del provider). */
export function useCocoaAltHeld(): boolean {
  return useSyncExternalStore(subscribeAltHeld, getAltHeld, getServerAltHeld);
}

type KeyLike = { key: string; altKey: boolean };
type TrackingTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/**
 * Instala los oyentes que siguen la tecla ⌥ (keydown/keyup en captura, blur de
 * la ventana y cambio de visibilidad); devuelve la función que los retira. Lo
 * llama CocoaGlobalProvider una sola vez.
 */
export function installAltHeldTracking(target: TrackingTarget, doc?: TrackingTarget): () => void {
  const onKeyDown = (event: KeyLike) => {
    if (event.key === "Alt") setAltHeld(true);
    else if (!event.altKey) setAltHeld(false);
  };
  const onKeyUp = (event: KeyLike) => {
    if (event.key === "Alt" || !event.altKey) setAltHeld(false);
  };
  const reset = () => setAltHeld(false);
  const down = onKeyDown as unknown as EventListener;
  const up = onKeyUp as unknown as EventListener;
  target.addEventListener("keydown", down, true);
  target.addEventListener("keyup", up, true);
  target.addEventListener("blur", reset);
  doc?.addEventListener("visibilitychange", reset);
  return () => {
    target.removeEventListener("keydown", down, true);
    target.removeEventListener("keyup", up, true);
    target.removeEventListener("blur", reset);
    doc?.removeEventListener("visibilitychange", reset);
    setAltHeld(false);
  };
}

// ---------------------------------------------------------------------------
// Registro de teclas de acceso — módulo, como cocoa-page-commands.
// ---------------------------------------------------------------------------
export interface AccessKeyEntry {
  /** Letra o dígito en mayúscula («C», «1»). */
  readonly letter: string;
  /** El botón que ejecuta (null si está desmontado). */
  readonly element: () => HTMLElement | null;
}

const accessKeys: AccessKeyEntry[] = [];

/** Normaliza la letra declarada («c» → «C»); null si no es una letra o un dígito. */
export function normalizeAccessKey(letter: string | undefined | null): string | null {
  if (!letter) return null;
  const upper = letter.trim().toUpperCase();
  return /^[A-Z0-9]$/.test(upper) ? upper : null;
}

/** Registra un botón; devuelve la baja. Las bajas dobles son inocuas. */
export function registerAccessKey(entry: AccessKeyEntry): () => void {
  accessKeys.push(entry);
  return () => {
    const index = accessKeys.indexOf(entry);
    if (index >= 0) accessKeys.splice(index, 1);
  };
}

/** Test/reset helper: vacía el registro. */
export function resetAccessKeys(): void {
  accessKeys.length = 0;
}

export function getAccessKeys(): readonly AccessKeyEntry[] {
  return accessKeys;
}

type ElementLike = {
  disabled?: boolean;
  getAttribute?: (name: string) => string | null;
  getClientRects?: () => { length: number };
  hidden?: boolean;
};

/** Visible (con caja) y habilitado (ni `disabled` ni `aria-disabled="true"`). */
export function isElementActionable(element: ElementLike | null | undefined): boolean {
  if (!element) return false;
  if (element.disabled) return false;
  if (element.hidden) return false;
  if (element.getAttribute?.("aria-disabled") === "true") return false;
  const rects = element.getClientRects?.();
  if (rects && rects.length === 0) return false;
  return true;
}

type AccessKeyEventLike = { code: string; altKey: boolean; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean };

/** Letra de una pulsación ⌥+tecla (por `code`, R8); null con ⌘/Ctrl/⇧ o sin ⌥. */
export function accessKeyOfEvent(event: AccessKeyEventLike): string | null {
  if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return null;
  return letterOfCode(event.code);
}

/** El botón que atiende una letra: el registrado más tarde (el más profundo, p. ej. dentro del diálogo abierto) que esté visible y habilitado. */
export function findAccessKeyTarget(letter: string, entries: readonly AccessKeyEntry[] = accessKeys): HTMLElement | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.letter !== letter) continue;
    const element = entry.element();
    if (isElementActionable(element)) return element;
  }
  return null;
}

type TargetLike = { tagName?: string; isContentEditable?: boolean } | null | undefined;

/** Dentro de un `<textarea>` o un editable ⌥ escribe símbolos: ahí no se ejecutan teclas de acceso. */
export function accessKeysSuppressedFor(target: TargetLike): boolean {
  if (!target || typeof target !== "object") return false;
  if (target.isContentEditable) return true;
  return (target.tagName ?? "").toUpperCase() === "TEXTAREA";
}

/**
 * Atiende un keydown: ejecuta el botón de la tecla de acceso y devuelve `true`
 * (con `preventDefault`) o `false` si no había ninguno. Lo llama el provider.
 */
export function dispatchAccessKey(event: AccessKeyEventLike & { target?: unknown; preventDefault: () => void }): boolean {
  const letter = accessKeyOfEvent(event);
  if (!letter) return false;
  if (accessKeysSuppressedFor(event.target as TargetLike)) return false;
  const target = findAccessKeyTarget(letter);
  if (!target) return false;
  event.preventDefault();
  target.click();
  return true;
}

/** Valor de `aria-keyshortcuts` para un botón con tecla de acceso. */
export function accessKeyAriaShortcut(letter: string): string {
  return `Alt+${letter}`;
}

/** Registra el botón referenciado mientras esté montado (no-op sin letra). */
export function useAccessKeyRegistration(ref: RefObject<HTMLElement | null>, letter: string | undefined): string | null {
  const normalized = normalizeAccessKey(letter);
  useEffect(() => {
    if (!normalized) return undefined;
    if (import.meta.env?.DEV && RESERVED_ACCESS_LETTERS.includes(normalized)) {
      // eslint-disable-next-line no-console
      console.warn(`[CocoaAccessKey] la tecla ⌥${normalized} está reservada para la navegación global (${RESERVED_ACCESS_LETTERS.join(" ")}); elige otra letra.`);
    }
    return registerAccessKey({ letter: normalized, element: () => ref.current });
  }, [normalized, ref]);
  return normalized;
}

export interface CocoaAccessKeyProps {
  /** Letra del atajo («C»). */
  letter: string;
  /** Pintar siempre (tooltips, guía); por defecto solo mientras ⌥ está pulsado. */
  always?: boolean;
  className?: string;
}

/** Chip «C» que aparece junto a la etiqueta mientras ⌥ está pulsado. */
export function CocoaAccessKey({ letter, always = false, className }: CocoaAccessKeyProps) {
  const held = useCocoaAltHeld();
  const normalized = normalizeAccessKey(letter);
  if (!normalized || (!held && !always)) return null;
  return (
    <CocoaKbd className={["c22-access-key", className].filter(Boolean).join(" ")}>
      {normalized}
    </CocoaKbd>
  );
}

export default CocoaAccessKey;

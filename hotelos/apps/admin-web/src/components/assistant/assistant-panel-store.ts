// Asistente unificado (Tanda L6b) · store del panel, fuera de React.
//
// Mismo patrón que components/cocoa/cocoa-page-commands.ts (registro de ⌘K):
// un módulo con estado inmutable, `subscribe` + `getState` para
// `useSyncExternalStore`, y un evento de `window` («hotelos-open-assistant»)
// para que cualquier árbol (la paleta ⌘K, el shell, una pantalla) abra el
// panel con una pregunta y una superficie sin importar el componente.
//
//   openAssistant() / closeAssistant() / toggleAssistant()
//   openAssistantWith({ question?, surface? })   → abre y deja la pregunta pendiente
//   takePendingQuestion()                        → la consume el panel (una sola vez)
//   requestOpenAssistant(request)                → despacha el evento (o abre directamente sin window)
//   listenOpenAssistantEvents()                  → el panel escucha el evento mientras está montado
//
// Puro salvo el evento opcional de `window`; probado en
// components/__tests__/assistant-panel.test.mts.

import { isAssistantSurface, type AssistantSurface } from "../../services/assistantApi";

/** Evento de `window` que abre el panel: `detail` = `AssistantOpenRequest`. */
export const OPEN_ASSISTANT_EVENT = "hotelos-open-assistant";

/** Longitud máxima de una pregunta que llega por evento (la API valida la suya). */
export const MAX_QUESTION_LENGTH = 2000;

export interface AssistantOpenRequest {
  /** Pregunta que el panel envía nada más abrirse. */
  question?: string;
  /** Superficie que fija el prompt y las sugerencias (recepción, pisos, finanzas…). */
  surface?: AssistantSurface;
}

export interface AssistantPanelState {
  open: boolean;
  /** Superficie fijada por el último `openAssistantWith`; null = la del shell. */
  surface: AssistantSurface | null;
  /** Pregunta pendiente de enviar (la consume `takePendingQuestion`). */
  pendingQuestion: string | null;
  /** Sube con cada petición de apertura, aunque el panel ya estuviera abierto (el panel reacciona a él). */
  requestId: number;
}

type Listener = (state: AssistantPanelState) => void;

const INITIAL_STATE: AssistantPanelState = Object.freeze({ open: false, surface: null, pendingQuestion: null, requestId: 0 });

let state: AssistantPanelState = INITIAL_STATE;
const listeners = new Set<Listener>();

function setState(patch: Partial<AssistantPanelState>): void {
  const next: AssistantPanelState = Object.freeze({ ...state, ...patch });
  if (next.open === state.open && next.surface === state.surface && next.pendingQuestion === state.pendingQuestion && next.requestId === state.requestId) return;
  state = next;
  for (const listener of listeners) listener(state);
}

/** Estado actual (referencia estable mientras nada cambia: apto para `useSyncExternalStore`). */
export function getAssistantPanelState(): AssistantPanelState {
  return state;
}

/** Suscripción a los cambios; devuelve la función para darse de baja. */
export function subscribeAssistantPanel(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Sanea un `detail` de evento (o cualquier objeto externo): pregunta recortada y acotada, superficie solo si es conocida. */
export function parseOpenAssistantRequest(detail: unknown): AssistantOpenRequest {
  if (!detail || typeof detail !== "object") return {};
  const raw = detail as { question?: unknown; surface?: unknown };
  const request: AssistantOpenRequest = {};
  if (typeof raw.question === "string") {
    const question = raw.question.replace(/\s+/g, " ").trim().slice(0, MAX_QUESTION_LENGTH);
    if (question) request.question = question;
  }
  if (isAssistantSurface(raw.surface)) request.surface = raw.surface;
  return request;
}

export function openAssistant(): void {
  setState({ open: true, requestId: state.requestId + 1 });
}

export function closeAssistant(): void {
  setState({ open: false, pendingQuestion: null });
}

export function toggleAssistant(): void {
  if (state.open) closeAssistant();
  else openAssistant();
}

/** Abre el panel con una pregunta pendiente y/o una superficie (ambas opcionales). */
export function openAssistantWith(request: AssistantOpenRequest = {}): void {
  const clean = parseOpenAssistantRequest(request);
  setState({
    open: true,
    surface: clean.surface ?? state.surface,
    pendingQuestion: clean.question ?? null,
    requestId: state.requestId + 1
  });
}

/** Fija la superficie sin abrir ni cerrar (el shell la actualiza al cambiar de pantalla). */
export function setAssistantSurface(surface: AssistantSurface | null): void {
  setState({ surface });
}

/** Devuelve la pregunta pendiente y la vacía (null si no había). */
export function takePendingQuestion(): string | null {
  const question = state.pendingQuestion;
  if (question !== null) setState({ pendingQuestion: null });
  return question;
}

/**
 * Pide abrir el panel desde fuera del árbol: despacha `OPEN_ASSISTANT_EVENT`
 * cuando hay `window` (el panel montado lo escucha) y abre el store
 * directamente cuando no lo hay (tests, SSR).
 */
export function requestOpenAssistant(request: AssistantOpenRequest = {}): void {
  const clean = parseOpenAssistantRequest(request);
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent<AssistantOpenRequest>(OPEN_ASSISTANT_EVENT, { detail: clean }));
    return;
  }
  openAssistantWith(clean);
}

/** Manejador del evento (puro respecto al DOM): abre el store con el `detail` saneado. */
export function handleOpenAssistantEvent(event: { detail?: unknown } | null | undefined): void {
  openAssistantWith(parseOpenAssistantRequest(event?.detail));
}

/** Escucha `OPEN_ASSISTANT_EVENT` en `window`; devuelve la función para dejar de escuchar (no-op sin `window`). */
export function listenOpenAssistantEvents(): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") return () => undefined;
  const handler = (event: Event) => handleOpenAssistantEvent(event as CustomEvent<unknown>);
  window.addEventListener(OPEN_ASSISTANT_EVENT, handler);
  return () => window.removeEventListener(OPEN_ASSISTANT_EVENT, handler);
}

/** Test/reset helper: vuelve al estado inicial sin avisar a los suscriptores. */
export function resetAssistantPanel(): void {
  state = INITIAL_STATE;
}

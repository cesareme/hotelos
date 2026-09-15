// Cocoa 22 · page-level state resolution and the ⌘K command registry that
// `CocoaPage` feeds (COCOA-22.md §6 «⌘K omnipresente», §8 `commands`).
//
// The registry is a tiny module store outside React (like the toast store):
// `CocoaPage` registers its `commands` while mounted and the command palette
// reads `getPageCommands()` / subscribes to `PAGE_COMMANDS_EVENT`. Pure and
// unit-tested; no DOM beyond an optional `window` event for cross-tree sync.

export type CocoaPageState = "ready" | "loading" | "empty" | "error";

export interface CocoaPageCommand {
  id: string;
  label: string;
  run: () => void;
  /** Display hint («⌘R»); the palette does not bind it. */
  shortcut?: string;
}

/** Window event dispatched whenever the registered set changes. */
export const PAGE_COMMANDS_EVENT = "cocoa-page-commands";

type Listener = (commands: readonly CocoaPageCommand[]) => void;

const registrations = new Map<number, readonly CocoaPageCommand[]>();
const listeners = new Set<Listener>();
let nextToken = 1;

function snapshot(): CocoaPageCommand[] {
  const seen = new Set<string>();
  const out: CocoaPageCommand[] = [];
  // Later registrations (deeper pages) win on id collisions.
  for (const commands of Array.from(registrations.values()).reverse()) {
    for (const command of commands) {
      if (seen.has(command.id)) continue;
      seen.add(command.id);
      out.push(command);
    }
  }
  return out;
}

function emit(): void {
  const current = snapshot();
  for (const listener of listeners) listener(current);
  if (typeof window !== "undefined" && typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent(PAGE_COMMANDS_EVENT, { detail: current }));
  }
}

/** Registers a page's commands; returns the unregister function. */
export function registerPageCommands(commands: readonly CocoaPageCommand[]): () => void {
  const token = nextToken++;
  registrations.set(token, commands);
  emit();
  return () => {
    if (registrations.delete(token)) emit();
  };
}

/** Commands currently offered by mounted pages (most specific page first). */
export function getPageCommands(): CocoaPageCommand[] {
  return snapshot();
}

/** Subscribes to registry changes; returns the unsubscribe function. */
export function subscribePageCommands(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test/reset helper: clears every registration without notifying. */
export function resetPageCommands(): void {
  registrations.clear();
}

/** Stable key of a command set (id · label · shortcut), so re-renders don't re-register. */
export function commandsKey(commands: readonly CocoaPageCommand[] | undefined): string {
  return (commands ?? []).map((command) => `${command.id}${command.label}${command.shortcut ?? ""}`).join("\n");
}

/**
 * Explicit `state` wins; otherwise derive it from the classic
 * `loading / error / empty` trio so screens can pass either shape.
 */
export function resolvePageState(input: {
  state?: CocoaPageState;
  loading?: boolean;
  error?: unknown;
  empty?: boolean;
}): CocoaPageState {
  if (input.state) return input.state;
  if (input.loading) return "loading";
  if (input.error) return "error";
  if (input.empty) return "empty";
  return "ready";
}

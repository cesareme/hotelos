// CocoaLiveRegion — the single live region of a page (COCOA-22.md §5.2, §6
// «Live regions»): «Guardado», «Datos a 08:12», «3 indicadores no
// disponibles» are announced once through this visually hidden node instead
// of sprinkling `aria-live` on every chip. Polite by default; `assertive`
// interrupts (errors). The same message twice is re-announced only when
// `key` changes (pass a counter or a timestamp).
//
// Tanda UX-1 · U4 (docs/design/UX-RECEPCION-FEEL.md §4 «Foco y anuncio», §7.1
// 4.1.3, R5): the shell mounts ONE region (`CocoaShellLiveRegion` in
// layouts/BackOfficeLayout.tsx) fed by `announce(text)` — a module store
// outside React, like the toast store, so `showToast({ announce })`,
// `mutate(…, { announce })` and `useCocoaAnnounce()` reach it without
// prop-drilling — and `main` takes the focus after every shell navigation
// (`focusTargetAfterNavigate`, pure, unit-tested in
// layouts/__tests__/focus-after-navigate.test.mts).

import { useEffect, useState, type ReactNode } from "react";

export interface CocoaLiveRegionProps {
  message: ReactNode;
  politeness?: "polite" | "assertive";
  /** Change it to re-announce an identical message. */
  announceKey?: string | number;
  id?: string;
}

export function CocoaLiveRegion({ message, politeness = "polite", announceKey, id }: CocoaLiveRegionProps) {
  // Clear, then set on the next frame so AT sees a change even for repeats.
  const [current, setCurrent] = useState<ReactNode>(message);
  useEffect(() => {
    setCurrent(null);
    const raf = typeof window !== "undefined" ? window.requestAnimationFrame(() => setCurrent(message)) : null;
    return () => {
      if (raf !== null) window.cancelAnimationFrame(raf);
    };
  }, [message, announceKey]);

  return (
    <div id={id} className="c22-live-region cocoa-sr-only" role={politeness === "assertive" ? "alert" : "status"} aria-live={politeness} aria-atomic="true" data-cocoa="live-region">
      {current}
    </div>
  );
}

// ---------------------------------------------------------------- shell announcer (U4)

export type CocoaAnnouncePoliteness = "polite" | "assertive";

export interface CocoaAnnouncement {
  text: string;
  politeness: CocoaAnnouncePoliteness;
  /** Monotonic: an identical text announced twice still reaches AT. */
  key: number;
}

type AnnounceListener = (announcement: CocoaAnnouncement) => void;

/** Announcer store (pure factory, outside React): one per page, any caller. */
export function createAnnouncer() {
  let listeners: AnnounceListener[] = [];
  let last: CocoaAnnouncement | null = null;
  let nextKey = 1;
  return {
    /** Sends `text` to the shell region; blank text is ignored. Returns what was announced. */
    announce(text: string, politeness: CocoaAnnouncePoliteness = "polite"): CocoaAnnouncement | null {
      const trimmed = text.trim();
      if (!trimmed) return null;
      last = { text: trimmed, politeness, key: nextKey++ };
      for (const listener of listeners) listener(last);
      return last;
    },
    subscribe(listener: AnnounceListener): () => void {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((candidate) => candidate !== listener);
      };
    },
    last: () => last,
    listenerCount: () => listeners.length
  };
}

const announcer = createAnnouncer();

/** Announce `text` through the shell's single live region (no-op before the shell mounts). */
export function announce(text: string, politeness?: CocoaAnnouncePoliteness): void {
  announcer.announce(text, politeness);
}

export const subscribeAnnouncements = announcer.subscribe;

/** Last announcement made (tests, diagnostics). */
export const lastAnnouncement = announcer.last;

/** Whether the shell's live region is mounted (the toast store then lets it do the ONE announcement, R5). */
export function hasAnnouncerListeners(): boolean {
  return announcer.listenerCount() > 0;
}

/** The page's ONE live region: mounted once by the shell, fed by `announce()`. */
export function CocoaShellLiveRegion({ id = "cocoa-live-region" }: { id?: string }) {
  const [current, setCurrent] = useState<CocoaAnnouncement | null>(null);
  useEffect(() => announcer.subscribe(setCurrent), []);
  return <CocoaLiveRegion id={id} message={current?.text ?? null} politeness={current?.politeness ?? "polite"} announceKey={current?.key} />;
}

// ---------------------------------------------------------------- focus after navigation (U4, P2, WCAG 2.4.3)

export type FocusAfterNavigateTarget = "main" | null;

/**
 * Element that takes the focus after a shell navigation (pure): `main` once
 * the active screen CHANGES; nothing on the first paint (the document keeps
 * its own focus: a deep link must not yank it) and nothing when the same
 * screen re-renders.
 */
export function focusTargetAfterNavigate(input: { previousScreen: string | null | undefined; nextScreen: string }): FocusAfterNavigateTarget {
  if (!input.nextScreen) return null;
  if (input.previousScreen === undefined || input.previousScreen === null) return null;
  if (input.previousScreen === input.nextScreen) return null;
  return "main";
}

/** Id of the shell's `main` (the skip link target and the focus landing). */
export const SHELL_MAIN_ID = "cocoa-main";

export const SKIP_LINK_LABEL = "Saltar al contenido";

export default CocoaLiveRegion;

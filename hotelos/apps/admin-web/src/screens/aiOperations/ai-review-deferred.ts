// Commit diferido de la aprobación de un ítem de la cola de revisión IA
// (Tanda UX-2 · D5 · corrector UX2-REV-04; docs/design/UX-DIRECCION-FEEL.md §1 P4,
// §4 D5): «Aprobar» en la fila NO envía nada al instante. La fila pasa a
// «Aprobada» en pantalla y la CocoaUndoBar (8 s) ofrece «Deshacer»; el POST
// /ai-operations/review/:id/approve sale solo cuando la cuenta atrás termina
// («Cerrar» cuenta como terminar), al desmontar la pantalla o en `beforeunload`
// (con `keepalive`), o cuando llega otra aprobación (una barra viva a la vez,
// R15: la anterior se envía y la nueva ocupa la barra). El API no tiene ruta de
// reapertura, así que deshacer = no haber enviado.
//
// Módulo puro (sin React, sin temporizadores propios: la cuenta atrás es la de
// la barra), para que el contrato se pruebe con un `post` falso.

export type DeferredCommitReason = "expired" | "replaced" | "unmount" | "unload";

export type DeferredApproval<Item> = {
  item: Item;
  /** Cuerpo del POST (`{ notes }` desde el cajón; `{}` desde la fila). */
  body: Record<string, unknown>;
};

export type DeferredCommit<Item> = {
  /** Aprobación en espera (null cuando no hay ninguna). */
  pending: () => DeferredApproval<Item> | null;
  /**
   * «Aprobar»: deja la aprobación en espera y avisa a la pantalla. Si ya había
   * otra esperando, esa se ENVÍA ahora (`replaced`) antes de ocupar la barra.
   */
  schedule: (item: Item, body?: Record<string, unknown>) => Promise<void>;
  /** «Deshacer» (o ⌘Z): descarta la aprobación sin enviar nada. */
  undo: () => boolean;
  /** Cuenta atrás terminada o barra cerrada: envía la aprobación en espera. */
  expire: () => Promise<void>;
  /** Desmontaje (`unmount`) o cierre de la pestaña (`unload`): envía lo que quede. */
  flush: (reason?: "unmount" | "unload") => Promise<void>;
};

export function createDeferredCommit<Item extends { id: string }>(deps: {
  /** Envía la aprobación; `reason` deja elegir `keepalive` y el aviso. Nunca lanza hacia el controlador. */
  post: (approval: DeferredApproval<Item>, reason: DeferredCommitReason) => Promise<void>;
  /** Cambio de la aprobación en espera (la pantalla pinta la fila y la barra). */
  onChange: (pending: DeferredApproval<Item> | null) => void;
}): DeferredCommit<Item> {
  let pending: DeferredApproval<Item> | null = null;

  function set(next: DeferredApproval<Item> | null): void {
    pending = next;
    deps.onChange(next);
  }

  async function commit(reason: DeferredCommitReason): Promise<void> {
    const current = pending;
    if (!current) return;
    set(null);
    try {
      await deps.post(current, reason);
    } catch {
      // `post` gestiona su propio error (toast); el controlador nunca deja una promesa rechazada colgando.
    }
  }

  return {
    pending: () => pending,
    async schedule(item, body = {}) {
      const previous = pending && pending.item.id !== item.id ? commit("replaced") : Promise.resolve();
      set({ item, body });
      await previous;
    },
    undo() {
      if (!pending) return false;
      set(null);
      return true;
    },
    expire: () => commit("expired"),
    flush: (reason = "unmount") => commit(reason)
  };
}

/** Nota honesta de la barra (P4): qué hace la cuenta atrás y qué no se puede deshacer después. */
export const DEFERRED_APPROVAL_NOTE = "Se envía al terminar la cuenta atrás o al salir de la pantalla; después no hay reapertura.";

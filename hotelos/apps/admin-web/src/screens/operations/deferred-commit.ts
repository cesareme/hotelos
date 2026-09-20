// Escritura diferida con deshacer para pisos y mantenimiento (Tanda UX-3 · D0).
//
// COPIA EXACTA de `DeferredFlushReason` + `deferredCommit` de
// screens/reservations/ReservationWorkspaceScreen.tsx:325-349 (Tanda UX-1 · U7,
// cargo con deshacer). Recepción es un carril paralelo y NO se toca en esta
// tanda, así que la primitiva se duplica aquí en vez de extraerse a un módulo
// común; __tests__/deferred-commit.test.mts fija que ambas copias sigan
// idénticas. Deuda: cuando recepción esté libre, mover las dos a
// `lib/deferred-commit.ts` y reexportar desde aquí.
//
// Uso previsto (diseño §5): «Marcar limpia» / «Limpia» / «Resuelta» aplican el
// cambio optimista al instante y abren un toast «Deshacer» 8 s; el POST viaja
// solo si la ventana se agota (`wait()` → true), se vacía a mano (`flush()`) o
// la página se oculta (`flush("pagehide")`, POST con `keepalive`); «Deshacer»
// llama a `cancel()` y no se envía nada (mark-clean no degrada una inspeccionada
// y `resolved` es terminal: no hay «deshacer» en el API).

export type DeferredFlushReason = "timeout" | "manual" | "pagehide";

/**
 * Escritura diferida con deshacer: `wait()` resuelve true al agotarse la
 * ventana o al vaciar, false si se deshizo. `reason()` dice por qué se envió
 * (UX1-REV-02: en `pagehide` el POST viaja con `keepalive`; antes de cobrar o
 * cerrar la estancia se vacía a mano para que el saldo cobrado sea el real).
 */
export function deferredCommit(ms: number): { wait: () => Promise<boolean>; cancel: () => void; flush: (reason?: DeferredFlushReason) => void; settled: () => boolean; reason: () => DeferredFlushReason | null } {
  let settled = false;
  let reason: DeferredFlushReason | null = null;
  let resolveWait: ((go: boolean) => void) | null = null;
  const promise = new Promise<boolean>((resolve) => {
    resolveWait = resolve;
  });
  const timer = setTimeout(() => finish(true, "timeout"), ms);
  function finish(go: boolean, why: DeferredFlushReason | null) {
    if (settled) return;
    settled = true;
    reason = go ? why : null;
    clearTimeout(timer);
    resolveWait?.(go);
  }
  return { wait: () => promise, cancel: () => finish(false, null), flush: (why = "manual") => finish(true, why), settled: () => settled, reason: () => reason };
}

/**
 * «Deshacer» del toast de una escritura diferida (corrector UX-3-REV-01). El
 * toast y la ventana corren en paralelo (`pauseOnHover: false`: pausar el toast
 * no pausa la ventana), pero el clic puede llegar cuando la escritura ya viajó
 * (ventana agotada, vaciada por «Actualizar» o en `pagehide`, o cuando la
 * primitiva ya se decidió): entonces se avisa con `onAlreadySent` en vez de
 * callar. Devuelve true si se deshizo de verdad.
 */
export function undoDeferred(pending: Pick<ReturnType<typeof deferredCommit>, "settled" | "cancel">, onAlreadySent: () => void): boolean {
  if (pending.settled()) {
    onAlreadySent();
    return false;
  }
  pending.cancel();
  return true;
}

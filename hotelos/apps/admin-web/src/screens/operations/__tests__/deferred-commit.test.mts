import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { deferredCommit, undoDeferred } from "../deferred-commit.ts";

// Tanda UX-3 · D0: escritura diferida con deshacer (8 s en producto; aquí
// ventanas de milisegundos con temporizadores reales). Copia exacta de la
// primitiva de recepción (ReservationWorkspaceScreen.tsx): el último bloque
// fija que las dos copias no diverjan mientras recepción siga siendo un carril
// aparte.

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("deferredCommit · ventana agotada (timeout)", () => {
  it("resuelve true, reason «timeout» y queda settled al agotarse la ventana", async () => {
    const pending = deferredCommit(15);
    assert.equal(pending.settled(), false, "antes de agotarse no está settled");
    assert.equal(pending.reason(), null, "antes de agotarse no hay motivo");
    assert.equal(await pending.wait(), true);
    assert.equal(pending.settled(), true);
    assert.equal(pending.reason(), "timeout");
  });

  it("wait() devuelve siempre la misma promesa (varios lectores comparten el resultado)", async () => {
    const pending = deferredCommit(10);
    assert.equal(pending.wait(), pending.wait());
    assert.deepEqual(await Promise.all([pending.wait(), pending.wait()]), [true, true]);
  });
});

describe("deferredCommit · cancel (Deshacer)", () => {
  it("resuelve false, reason null y settled; el temporizador ya no dispara nada", async () => {
    const pending = deferredCommit(20);
    pending.cancel();
    assert.equal(pending.settled(), true);
    assert.equal(await pending.wait(), false);
    assert.equal(pending.reason(), null);
    await sleep(30);
    assert.equal(pending.reason(), null, "el timeout posterior no reescribe el motivo");
  });

  it("cancel después de flush no deshace nada (la primera decisión gana)", async () => {
    const pending = deferredCommit(50);
    pending.flush();
    pending.cancel();
    assert.equal(await pending.wait(), true);
    assert.equal(pending.reason(), "manual");
  });
});

describe("deferredCommit · flush (vaciar a mano o en pagehide)", () => {
  it("flush() sin argumento envía con motivo «manual» antes de agotar la ventana", async () => {
    const pending = deferredCommit(1000);
    pending.flush();
    assert.equal(pending.settled(), true);
    assert.equal(await pending.wait(), true);
    assert.equal(pending.reason(), "manual");
  });

  it("flush(\"pagehide\") conserva el motivo para que el POST viaje con keepalive", async () => {
    const pending = deferredCommit(1000);
    pending.flush("pagehide");
    assert.equal(await pending.wait(), true);
    assert.equal(pending.reason(), "pagehide");
  });

  it("flush después de cancel no revive la escritura", async () => {
    const pending = deferredCommit(1000);
    pending.cancel();
    pending.flush();
    assert.equal(await pending.wait(), false);
    assert.equal(pending.reason(), null);
  });

  it("dos flush consecutivos: el segundo es inocuo y no cambia el motivo", async () => {
    const pending = deferredCommit(1000);
    pending.flush("pagehide");
    pending.flush("manual");
    assert.equal(pending.reason(), "pagehide");
  });
});

describe("deferredCommit · settled", () => {
  it("es false hasta la primera decisión y true después, sea cual sea", () => {
    const byTimeout = deferredCommit(5);
    const byCancel = deferredCommit(1000);
    const byFlush = deferredCommit(1000);
    assert.deepEqual([byTimeout.settled(), byCancel.settled(), byFlush.settled()], [false, false, false]);
    byCancel.cancel();
    byFlush.flush();
    assert.deepEqual([byCancel.settled(), byFlush.settled()], [true, true]);
    return byTimeout.wait().then(() => assert.equal(byTimeout.settled(), true));
  });
});

describe("undoDeferred · «Deshacer» del toast (corrector UX-3-REV-01)", () => {
  it("dentro de la ventana cancela (nada viaja) y devuelve true sin avisar", async () => {
    const pending = deferredCommit(1000);
    let warned = 0;
    assert.equal(undoDeferred(pending, () => (warned += 1)), true);
    assert.equal(warned, 0);
    assert.equal(await pending.wait(), false);
  });

  it("con la ventana agotada avisa (onAlreadySent) y devuelve false: la escritura ya viajó", async () => {
    const pending = deferredCommit(5);
    assert.equal(await pending.wait(), true);
    let warned = 0;
    assert.equal(undoDeferred(pending, () => (warned += 1)), false);
    assert.equal(warned, 1);
    assert.equal(pending.reason(), "timeout", "el aviso no reescribe la decisión");
  });

  it("tras flush (Actualizar) o pagehide también avisa: cancelar después de enviar no deshace nada", () => {
    for (const reason of ["manual", "pagehide"] as const) {
      const pending = deferredCommit(1000);
      pending.flush(reason);
      let warned = 0;
      assert.equal(undoDeferred(pending, () => (warned += 1)), false);
      assert.equal(warned, 1);
      assert.equal(pending.reason(), reason);
    }
  });

  it("un segundo «Deshacer» sobre una ventana ya deshecha avisa (settled) y no rompe nada", () => {
    const pending = deferredCommit(1000);
    assert.equal(undoDeferred(pending, () => undefined), true);
    let warned = 0;
    assert.equal(undoDeferred(pending, () => (warned += 1)), false);
    assert.equal(warned, 1);
  });
});

describe("deferred-commit.ts · copia exacta de recepción (duplicación anotada)", () => {
  const here = readFileSync(new URL("../deferred-commit.ts", import.meta.url), "utf8");
  const reception = readFileSync(new URL("../../reservations/ReservationWorkspaceScreen.tsx", import.meta.url), "utf8");
  const block = (source: string) => {
    const start = source.indexOf("export type DeferredFlushReason");
    const fn = source.indexOf("export function deferredCommit(", start);
    const end = source.indexOf("\n}\n", fn);
    assert.ok(start >= 0 && fn > start && end > fn, "bloque DeferredFlushReason + deferredCommit presente");
    return source.slice(start, end + 3);
  };

  it("el tipo y la función son idénticos carácter a carácter a los de ReservationWorkspaceScreen.tsx", () => {
    assert.equal(block(here), block(reception));
  });

  it("la cabecera del módulo declara la duplicación y su origen", () => {
    assert.match(here, /COPIA EXACTA de `DeferredFlushReason` \+ `deferredCommit`/);
    assert.match(here, /ReservationWorkspaceScreen\.tsx:\d+-\d+/);
    assert.doesNotMatch(here, /from "\.\.\/reservations\//, "no importa de recepción (carril aparte)");
  });
});

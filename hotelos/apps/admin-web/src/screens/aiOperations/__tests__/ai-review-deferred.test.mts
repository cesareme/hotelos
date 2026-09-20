import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFERRED_APPROVAL_NOTE, createDeferredCommit, type DeferredApproval, type DeferredCommitReason } from "../ai-review-deferred.ts";

// Tanda UX-2 · D5 · corrector UX2-REV-04 (docs/design/UX-DIRECCION-FEEL.md §1 P4,
// §4 D5): commit diferido de la aprobación IA. Sin React ni temporizadores: la
// cuenta atrás es la de la CocoaUndoBar; aquí se prueba el contrato del
// controlador puro con un `post` falso — nada se envía al programar, «Deshacer»
// cancela sin POST, expirar / desmontar / beforeunload envían UNA vez, y una
// segunda aprobación envía la anterior antes de ocupar la barra (R15).

type Item = { id: string; reviewType: string };

function harness(options: { fail?: boolean } = {}) {
  const posts: Array<{ approval: DeferredApproval<Item>; reason: DeferredCommitReason }> = [];
  const changes: Array<DeferredApproval<Item> | null> = [];
  const controller = createDeferredCommit<Item>({
    post: async (approval, reason) => {
      posts.push({ approval, reason });
      if (options.fail) throw new Error("500");
    },
    onChange: (pending) => changes.push(pending)
  });
  return { controller, posts, changes };
}

const rate: Item = { id: "ahr_1", reviewType: "rate_change" };
const reply: Item = { id: "ahr_2", reviewType: "guest_message_reply" };

describe("createDeferredCommit · nada sale hasta que la barra expira", () => {
  it("schedule deja la aprobación en espera, avisa a la pantalla y NO envía", async () => {
    const { controller, posts, changes } = harness();
    await controller.schedule(rate, { notes: "ok" });
    assert.deepEqual(posts, []);
    assert.deepEqual(controller.pending(), { item: rate, body: { notes: "ok" } });
    assert.deepEqual(changes, [{ item: rate, body: { notes: "ok" } }]);
  });

  it("undo cancela sin enviar nada (no hay ruta de reapertura: deshacer = no haber enviado)", async () => {
    const { controller, posts, changes } = harness();
    await controller.schedule(rate);
    assert.equal(controller.undo(), true);
    assert.equal(controller.pending(), null);
    assert.deepEqual(posts, []);
    assert.deepEqual(changes.at(-1), null);
    assert.equal(controller.undo(), false, "sin aprobación en espera no hay nada que deshacer");
    await controller.expire();
    assert.deepEqual(posts, [], "expirar después de deshacer tampoco envía");
  });

  it("expire (cuenta atrás terminada o «Cerrar») envía UNA vez con el cuerpo programado", async () => {
    const { controller, posts } = harness();
    await controller.schedule(rate, {});
    await controller.expire();
    await controller.expire();
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0], { approval: { item: rate, body: {} }, reason: "expired" });
    assert.equal(controller.pending(), null);
  });

  it("flush al desmontar / en beforeunload envía lo que quede con su motivo (la pantalla elige keepalive)", async () => {
    const unmount = harness();
    await unmount.controller.schedule(rate);
    await unmount.controller.flush();
    assert.deepEqual(unmount.posts.map((p) => p.reason), ["unmount"]);
    const unload = harness();
    await unload.controller.schedule(reply);
    await unload.controller.flush("unload");
    assert.deepEqual(unload.posts.map((p) => p.reason), ["unload"]);
    await unload.controller.flush("unload");
    assert.equal(unload.posts.length, 1, "un segundo flush no reenvía");
  });

  it("una segunda aprobación envía la anterior («replaced») y ocupa la barra; la misma fila no se reenvía", async () => {
    const { controller, posts } = harness();
    await controller.schedule(rate);
    await controller.schedule(reply, { notes: "n" });
    assert.deepEqual(posts.map((p) => [p.approval.item.id, p.reason]), [["ahr_1", "replaced"]]);
    assert.deepEqual(controller.pending(), { item: reply, body: { notes: "n" } });
    await controller.schedule(reply, { notes: "n2" });
    assert.equal(posts.length, 1, "reprogramar la misma fila solo actualiza el cuerpo");
    assert.deepEqual(controller.pending()?.body, { notes: "n2" });
  });

  it("un POST fallido no deja la promesa rechazada ni la aprobación colgada (el toast lo pinta `post`)", async () => {
    const { controller, posts } = harness({ fail: true });
    await controller.schedule(rate);
    await assert.doesNotReject(() => controller.expire());
    assert.equal(posts.length, 1);
    assert.equal(controller.pending(), null);
  });

  it("la nota de la barra es honesta: cuándo se envía y que después no hay reapertura", () => {
    assert.match(DEFERRED_APPROVAL_NOTE, /cuenta atrás/);
    assert.match(DEFERRED_APPROVAL_NOTE, /no hay reapertura/);
  });
});

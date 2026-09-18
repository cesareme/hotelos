// Tanda L3 (2026-09-18, lote S): the zod bodies of POST /reservations/:id/cancel
// and POST /reservations/:id/no-show. Both stay NON-strict on purpose (unknown
// keys are dropped, never a 400) and gain the optional `applyPolicy` boolean
// that lote B reads (omitted = true). Pure, no DB. From apps/api:
//   node --import tsx --test src/schemas/__tests__/reservation-lifecycle-schemas.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CancelReservationSchema, NoShowReservationSchema } from "../reservations.schemas.js";

function messagesOf(result: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }): string[] {
  return result.success ? [] : (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

/** Lo que envían hoy los diálogos de ReservationWorkspaceScreen / LiveTimelineWorkspace. */
const FRONT_CANCEL = { reason: "Cliente no viaja" };
const FRONT_NO_SHOW = { reason: "No se presentó" };

describe("CancelReservationSchema (POST /reservations/:id/cancel)", () => {
  it("acepta el cuerpo actual del front y el cuerpo vacío; applyPolicy queda undefined si no viene", () => {
    const parsed = CancelReservationSchema.parse(FRONT_CANCEL);
    assert.equal(parsed.reason, "Cliente no viaja");
    assert.equal(parsed.applyPolicy, undefined);
    assert.deepEqual(CancelReservationSchema.parse({}), {});
  });

  it("applyPolicy es un booleano opcional: true y false pasan; \"true\", 1 y null son 400", () => {
    assert.equal(CancelReservationSchema.parse({ ...FRONT_CANCEL, applyPolicy: true }).applyPolicy, true);
    assert.equal(CancelReservationSchema.parse({ ...FRONT_CANCEL, applyPolicy: false }).applyPolicy, false);
    for (const applyPolicy of ["true", 1, null, "sí", {}]) {
      const result = CancelReservationSchema.safeParse({ ...FRONT_CANCEL, applyPolicy });
      assert.equal(result.success, false, `applyPolicy ${JSON.stringify(applyPolicy)} debería rechazarse`);
      assert.match(messagesOf(result).join(" | "), /^applyPolicy: /);
    }
  });

  it("conserva reason, reasonCode y notes con sus topes (reason ≤ 1000, reasonCode ≤ 40, notes ≤ 2000)", () => {
    const full = CancelReservationSchema.parse({ reason: "x".repeat(1000), reasonCode: "y".repeat(40), notes: "z".repeat(2000), applyPolicy: true });
    assert.equal(full.reason?.length, 1000);
    assert.equal(full.reasonCode?.length, 40);
    assert.equal(full.notes?.length, 2000);
    assert.equal(CancelReservationSchema.safeParse({ reason: "x".repeat(1001) }).success, false);
    assert.equal(CancelReservationSchema.safeParse({ reasonCode: "y".repeat(41) }).success, false);
    assert.equal(CancelReservationSchema.safeParse({ notes: "z".repeat(2001) }).success, false);
  });

  it("NO es strict: las claves desconocidas (apply_policy en snake_case, foo…) se descartan sin 400; supervisorAuthorizationId (corrector L3 · DS-02) se conserva", () => {
    const result = CancelReservationSchema.safeParse({ ...FRONT_CANCEL, apply_policy: false, supervisorAuthorizationId: "apr_1", foo: 1 });
    assert.equal(result.success, true, messagesOf(result).join(" | "));
    assert.deepEqual(result.success ? result.data : null, { reason: "Cliente no viaja", supervisorAuthorizationId: "apr_1" });
    // The snake_case key must NOT leak into applyPolicy (it is simply ignored).
    assert.equal(result.success ? (result.data as Record<string, unknown>).apply_policy : "leaked", undefined);
    assert.equal(CancelReservationSchema.safeParse({ supervisorAuthorizationId: "" }).success, false, "una autorización vacía es un 400");
    assert.equal(NoShowReservationSchema.parse({ applyPolicy: false, supervisorAuthorizationId: "apr_2" }).supervisorAuthorizationId, "apr_2");
  });
});

describe("NoShowReservationSchema (POST /reservations/:id/no-show)", () => {
  it("acepta el cuerpo actual del front y el vacío; applyPolicy booleano opcional", () => {
    assert.deepEqual(NoShowReservationSchema.parse(FRONT_NO_SHOW), { reason: "No se presentó" });
    assert.deepEqual(NoShowReservationSchema.parse({}), {});
    assert.equal(NoShowReservationSchema.parse({ ...FRONT_NO_SHOW, applyPolicy: false }).applyPolicy, false);
    assert.equal(NoShowReservationSchema.parse({ applyPolicy: true }).applyPolicy, true);
    for (const applyPolicy of ["false", 0, null]) {
      const result = NoShowReservationSchema.safeParse({ applyPolicy });
      assert.equal(result.success, false, `applyPolicy ${JSON.stringify(applyPolicy)} debería rechazarse`);
      assert.match(messagesOf(result).join(" | "), /^applyPolicy: /);
    }
  });

  it("reason ≤ 1000 y las claves desconocidas se descartan (no strict)", () => {
    assert.equal(NoShowReservationSchema.parse({ reason: "x".repeat(1000) }).reason?.length, 1000);
    assert.equal(NoShowReservationSchema.safeParse({ reason: "x".repeat(1001) }).success, false);
    const result = NoShowReservationSchema.safeParse({ ...FRONT_NO_SHOW, apply_policy: true, reasonCode: "NS", notes: "n" });
    assert.equal(result.success, true, messagesOf(result).join(" | "));
    assert.deepEqual(result.success ? result.data : null, { reason: "No se presentó" });
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

// U6 · runner del check-in rápido (docs/design/UX-RECEPCION-FEEL.md §5.2, §5.3,
// §6.1): orden de los pasos, aborto en el cobro (el check-in NO se hace),
// override de limpieza auditado y reconciliación con la reserva que devuelve
// POST /reservations/:id/check-in. `request` es un doble: sin red ni React.
const { CheckinRunError, buildCheckinBody, checkinStepMessage, initialCheckinProgress, isOverrideReasonValid, overrideReasonFor, progressLabel, runCheckin } = await import("../checkinRunner.ts");

type Call = { path: string; method: string; body: unknown };

function fakeDeps(overrides: Partial<Parameters<typeof runCheckin>[1]> & { failPayment?: boolean; failAssign?: boolean; failCheckin?: boolean } = {}) {
  const calls: Call[] = [];
  const progress: string[] = [];
  const deps: Parameters<typeof runCheckin>[1] = {
    request: async <T,>(path: string, options?: { method?: string; body?: unknown }) => {
      calls.push({ path, method: options?.method ?? "GET", body: options?.body });
      if (path.endsWith("/assign-room")) {
        if (overrides.failAssign) throw new Error("ROOM_OCCUPIED");
        return undefined as T;
      }
      if (path.endsWith("/check-in")) {
        if (overrides.failCheckin) throw new Error("409 fuera de ventana");
        return { id: "res_1", code: "UXDAY-T1", status: "checked_in", assignedRoomId: (options?.body as { roomId: string }).roomId, guestRegister: { created: 1, existing: 0 }, folio: { id: "folio_1", created: false } } as T;
      }
      throw new Error(`ruta inesperada ${path}`);
    },
    postPayment: async (folioId, body) => {
      calls.push({ path: `/folios/${folioId}/payments`, method: "POST", body });
      if (overrides.failPayment) throw new Error("400 Validation failed");
      return { kind: "payment", status: "captured" };
    },
    listPartes: async () => {
      calls.push({ path: "/guest-register", method: "GET", body: undefined });
      return [{ id: "parte_1", propertyId: "prop_uxday", reservationId: "res_1", recordType: "traveller", status: "draft", identityVerified: false, createdAt: "", updatedAt: "" }] as never;
    },
    markIdentity: async (id) => {
      calls.push({ path: `/guest-register/${id}/mark-identity-verified`, method: "PATCH", body: undefined });
      return {};
    },
    queueSes: async (propertyId, reservationId) => {
      calls.push({ path: `/properties/${propertyId}/ses/submissions`, method: "POST", body: { reservationId } });
      return { kind: "queued", queued: 1 };
    },
    newClientRequestId: () => "req-1",
    onProgress: (p) => progress.push(progressLabel(p)),
    ...overrides
  };
  return { deps, calls, progress };
}

const BASE = { reservationId: "res_1", propertyId: "prop_uxday", assignedRoomId: null, roomId: "room_118", currency: "EUR" };

describe("runCheckin · orden de los pasos", () => {
  it("asignar → cobrar → check-in → partes → SES, con progreso por paso y reconciliación de la reserva", async () => {
    const { deps, calls, progress } = fakeDeps();
    const result = await runCheckin({ ...BASE, payment: { folioId: "folio_1", amount: 120, method: "card" } }, deps);
    assert.deepEqual(
      calls.map((call) => `${call.method} ${call.path}`),
      ["POST /reservations/res_1/assign-room", "POST /folios/folio_1/payments", "POST /reservations/res_1/check-in", "GET /guest-register", "POST /properties/prop_uxday/ses/submissions"]
    );
    // Cuerpo del cobro estricto (F1) y del check-in sin override.
    assert.deepEqual(calls[1].body, { amount: 120, currency: "EUR", method: "card_terminal", clientRequestId: "req-1" });
    assert.deepEqual(calls[2].body, { roomId: "room_118", signatureObjectKey: "sig_drawer_checkin" });
    // Reconciliación: la reserva devuelta por el API, no un refetch.
    assert.equal(result.reservation?.status, "checked_in");
    assert.equal(result.reservation?.assignedRoomId, "room_118");
    assert.equal(result.ses.kind, "queued");
    assert.equal(result.paymentAttempt?.clientRequestId, "req-1");
    assert.equal(progressLabel(result.progress), "Habitación ✓ · Cobro ✓ · Check-in ✓ · Partes ✓ · SES ✓");
    assert.equal(progress[0], "Habitación — · Cobro — · Check-in — · Partes — · SES —");
    assert.ok(progress.includes("Habitación ✓ · Cobro ✓ · Check-in … · Partes — · SES —"), progress.join(" | "));
  });
  it("sin cambio de habitación y sin cobro: solo check-in, partes y SES", async () => {
    const { deps, calls } = fakeDeps();
    const result = await runCheckin({ ...BASE, assignedRoomId: "room_118", payment: null }, deps);
    assert.deepEqual(calls.map((call) => call.path), ["/reservations/res_1/check-in", "/guest-register", "/properties/prop_uxday/ses/submissions"]);
    assert.equal(progressLabel(result.progress), "Check-in ✓ · Partes ✓ · SES ✓");
    assert.equal(result.paymentAttempt, null);
  });
  it("identidad verificada: PATCH por parte ANTES del envío SES y relectura de partes", async () => {
    const { deps, calls } = fakeDeps();
    await runCheckin({ ...BASE, assignedRoomId: "room_118", payment: null, verifyIdentity: true }, deps);
    const order = calls.map((call) => call.path);
    assert.ok(order.indexOf("/guest-register/parte_1/mark-identity-verified") < order.indexOf("/properties/prop_uxday/ses/submissions"));
    assert.equal(order.filter((path) => path === "/guest-register").length, 2);
  });
  it("un 403 al marcar la identidad no bloquea: nota y el SES sigue", async () => {
    const forbidden = Object.assign(new Error("Forbidden"), { status: 403 });
    const { deps } = fakeDeps({ markIdentity: async () => Promise.reject(forbidden), isForbidden: (error) => (error as { status?: number }).status === 403 });
    const result = await runCheckin({ ...BASE, assignedRoomId: "room_118", payment: null, verifyIdentity: true }, deps);
    assert.match(result.identityNote ?? "", /Sin permiso para marcar la identidad verificada/);
    assert.equal(result.ses.kind, "queued");
  });
});

describe("runCheckin · aborto en el cobro y en la asignación", () => {
  it("si el cobro falla NO se hace el check-in ni el SES y el error lo dice", async () => {
    const { deps, calls } = fakeDeps({ failPayment: true });
    await assert.rejects(
      () => runCheckin({ ...BASE, payment: { folioId: "folio_1", amount: 120, method: "cash" } }, deps),
      (error: unknown) => {
        assert.ok(error instanceof CheckinRunError);
        assert.equal(error.step, "payment");
        assert.match(error.message, /No se pudo registrar el cobro/);
        assert.match(error.message, /El check-in NO se ha realizado/);
        assert.equal(error.progress.payment, "failed");
        // La clave de idempotencia sobrevive al fallo para que el reintento repita el mismo cobro.
        assert.equal(error.paymentAttempt?.clientRequestId, "req-1");
        return true;
      }
    );
    assert.equal(calls.some((call) => call.path.endsWith("/check-in")), false);
    assert.equal(calls.some((call) => call.path.includes("/ses/")), false);
  });
  it("un cobro devuelto como intento de pasarela (202 payment_intent) también aborta", async () => {
    const { deps, calls } = fakeDeps({ postPayment: async () => ({ kind: "payment_intent" }) });
    await assert.rejects(() => runCheckin({ ...BASE, assignedRoomId: "room_118", payment: { folioId: "folio_1", amount: 50, method: "card" } }, deps), /no está confirmado/);
    assert.equal(calls.some((call) => call.path.endsWith("/check-in")), false);
  });
  it("el reintento del mismo cobro reutiliza la clave; otro importe estrena otra", async () => {
    let n = 0;
    const { deps, calls } = fakeDeps({ newClientRequestId: () => `req-${++n}` });
    const first = await runCheckin({ ...BASE, assignedRoomId: "room_118", payment: { folioId: "folio_1", amount: 120, method: "card" } }, deps);
    const same = await runCheckin({ ...BASE, assignedRoomId: "room_118", payment: { folioId: "folio_1", amount: 120, method: "card" } }, { ...deps, previousAttempt: first.paymentAttempt });
    const other = await runCheckin({ ...BASE, assignedRoomId: "room_118", payment: { folioId: "folio_1", amount: 80, method: "card" } }, { ...deps, previousAttempt: same.paymentAttempt });
    const keys = calls.filter((call) => call.path.endsWith("/payments")).map((call) => (call.body as { clientRequestId: string }).clientRequestId);
    assert.deepEqual(keys, ["req-1", "req-1", "req-2"]);
  });
  it("si la asignación falla (409 ocupada) no se cobra ni se hace el check-in", async () => {
    const { deps, calls } = fakeDeps({ failAssign: true });
    await assert.rejects(() => runCheckin({ ...BASE, payment: { folioId: "folio_1", amount: 120, method: "card" } }, deps), (error: unknown) => error instanceof CheckinRunError && error.step === "assign" && /ROOM_OCCUPIED/.test(error.message));
    assert.deepEqual(calls.map((call) => call.path), ["/reservations/res_1/assign-room"]);
  });
  it("si el check-in falla tras cobrar, el error nombra el paso y conserva el cobro hecho en el progreso", async () => {
    const { deps } = fakeDeps({ failCheckin: true });
    await assert.rejects(() => runCheckin({ ...BASE, assignedRoomId: "room_118", payment: { folioId: "folio_1", amount: 120, method: "card" } }, deps), (error: unknown) => error instanceof CheckinRunError && error.step === "checkin" && error.progress.payment === "done");
  });
});

describe("copy de mostrador del 409 de fecha (L-08)", () => {
  it("CHECK_IN_DATE_OUT_OF_RANGE se traduce a la fecha y qué hacer; otros errores llegan tal cual", () => {
    const early = Object.assign(new Error("La reserva RES-00047 tiene llegada el 2026-09-29 y la fecha de negocio es 2026-09-19: … Repite con allowEarlyCheckIn:true (requiere el permiso pms.reservation.modify) para forzarlo."), {
      details: { code: "CHECK_IN_DATE_OUT_OF_RANGE", arrivalDate: "2026-09-29", businessDate: "2026-09-19" }
    });
    const message = checkinStepMessage(early, "Error ejecutando check-in");
    assert.equal(message, "La reserva llega el 2026-09-29: el check-in solo se admite con un día de margen. Si el huésped ya está aquí, adelanta la llegada desde la ficha.");
    assert.doesNotMatch(message, /allowEarlyCheckIn|permiso/);
    assert.equal(checkinStepMessage(new Error("Saldo pendiente"), "x"), "Saldo pendiente");
    assert.equal(checkinStepMessage(null, "Error ejecutando check-in"), "Error ejecutando check-in");
  });
});

describe("override de limpieza (F18)", () => {
  it("con motivo, el cuerpo del check-in lleva `overrideReason` (el API no exige la habitación limpia)", async () => {
    const { deps, calls } = fakeDeps();
    await runCheckin({ ...BASE, assignedRoomId: "room_118", payment: null, overrideReason: overrideReasonFor("el huésped lo acepta, la limpian en 10 min", "118") }, deps);
    const body = calls.find((call) => call.path.endsWith("/check-in"))?.body as { overrideReason?: string };
    assert.equal(body.overrideReason, "Check-in con la 118 sin limpiar: el huésped lo acepta, la limpian en 10 min");
  });
  it("buildCheckinBody omite el motivo vacío o de menos de 3 caracteres (CheckInSchema.min(3))", () => {
    assert.deepEqual(buildCheckinBody({ roomId: "r", overrideReason: "  " }), { roomId: "r", signatureObjectKey: "sig_drawer_checkin" });
    assert.deepEqual(buildCheckinBody({ roomId: "r", overrideReason: "ok" }), { roomId: "r", signatureObjectKey: "sig_drawer_checkin" });
    assert.deepEqual(buildCheckinBody({ roomId: "r", overrideReason: " sí, urgente ", signatureObjectKey: "sig_x" }), { roomId: "r", signatureObjectKey: "sig_x", overrideReason: "sí, urgente" });
    assert.equal(isOverrideReasonValid("ab"), false);
    assert.equal(isOverrideReasonValid("abc"), true);
    assert.equal(isOverrideReasonValid(null), false);
  });
  it("el progreso inicial omite los pasos que no aplican", () => {
    assert.equal(progressLabel(initialCheckinProgress({ willAssign: false, willPay: true })), "Cobro — · Check-in — · Partes — · SES —");
  });
});

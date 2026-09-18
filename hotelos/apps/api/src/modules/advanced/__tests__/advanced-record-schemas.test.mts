// Tanda L2 (L2-03): contratos de entrada del motor genérico — esquemas zod
// estrictos con mensajes en español y máquinas de estado cerradas. Puro (sin
// base de datos). Desde apps/api:
//   node --import tsx --test src/modules/advanced/__tests__/advanced-record-schemas.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "../../../lib/validate.js";
import { BadRequestError, ConflictError } from "../../../lib/http-error.js";
import {
  AnomalyTransitionSchema,
  assertTransitionAllowed,
  CREATE_SCHEMAS,
  CrmCampaignUpdateSchema,
  IncidentCreateSchema,
  INVALID_TRANSITION_CODE,
  isCreateKey,
  isListKey,
  isTransitionKey,
  LIST_RECORD_TYPES,
  PurchaseOrderCreateSchema,
  PurchaseOrderTransitionSchema,
  ShiftCreateSchema,
  STATE_MACHINES,
  TimeClockCreateSchema,
  TRANSITION_SCHEMAS
} from "../advanced-record-schemas.js";

function statusOf(run: () => unknown): { statusCode: number; message: string; details?: unknown } {
  try {
    run();
  } catch (error) {
    const typed = error as { statusCode?: number; message: string; details?: unknown };
    assert.equal(typeof typed.statusCode, "number", "el error debe ser un HttpError tipado");
    return { statusCode: typed.statusCode as number, message: typed.message, details: typed.details };
  }
  assert.fail("se esperaba un error");
}

describe("L2-03 · esquemas estrictos por tipo", () => {
  it("un campo no declarado es un 400 con mensaje en español", () => {
    const outcome = statusOf(() => parse(ShiftCreateSchema, { staffName: "Ana", startAt: "2026-10-01T09:00:00.000Z", endAt: "2026-10-01T17:00:00.000Z", foo: 1 }, "body"));
    assert.equal(outcome.statusCode, 400);
    assert.match(outcome.message, /campos no admitidos/);
    assert.throws(() => parse(IncidentCreateSchema, { title: "Caída", createdByUserId: "usr_x" }, "body"), BadRequestError);
  });

  it("un campo obligatorio ausente o con tipo incorrecto es un 400 en español", () => {
    const missing = statusOf(() => parse(IncidentCreateSchema, {}, "body"));
    assert.equal(missing.statusCode, 400);
    assert.match(missing.message, /title es obligatorio/);
    const wrongType = statusOf(() => parse(IncidentCreateSchema, { title: 12 }, "body"));
    assert.match(wrongType.message, /title no tiene el formato esperado/);
    const badEnum = statusOf(() => parse(IncidentCreateSchema, { title: "Caída", severity: "extreme" }, "body"));
    assert.match(badEnum.message, /La gravedad debe ser uno de: low, medium, high, critical/);
    const badDate = statusOf(() => parse(ShiftCreateSchema, { staffName: "Ana", startAt: "ayer", endAt: "2026-10-01T17:00:00.000Z" }, "body"));
    assert.match(badDate.message, /startAt debe ser una fecha ISO 8601/);
  });

  it("acepta el cuerpo real de las pantallas (turno, fichaje, incidente)", () => {
    const shift = parse(ShiftCreateSchema, { staffName: "Ana", role: "recepción", startAt: "2026-10-01T09:00:00.000Z", endAt: "2026-10-01T17:00:00.000Z" }, "body");
    assert.equal(shift.staffName, "Ana");
    const clock = parse(TimeClockCreateSchema, { propertyId: "prop_1", staffName: "Ana", action: "in", at: "2026-10-01T09:00:00.000Z" }, "body");
    assert.equal(clock.action, "in");
    const incident = parse(IncidentCreateSchema, { title: "Caída", severity: "high", location: "Pasillo 2", description: "Suelo mojado", occurredAt: "2026-10-01T09:00:00.000Z" }, "body");
    assert.equal(incident.severity, "high");
  });

  it("valida las reglas cruzadas: fin posterior al inicio, total coherente con las líneas", () => {
    const inverted = statusOf(() => parse(ShiftCreateSchema, { staffName: "Ana", startAt: "2026-10-01T17:00:00.000Z", endAt: "2026-10-01T09:00:00.000Z" }, "body"));
    assert.match(inverted.message, /endAt debe ser posterior a startAt/);
    const noAmount = statusOf(() => parse(PurchaseOrderCreateSchema, { supplierId: "sup_1" }, "body"));
    assert.match(noAmount.message, /Indica total o al menos una línea/);
    const mismatch = statusOf(() => parse(PurchaseOrderCreateSchema, { total: 10, lines: [{ description: "Bombillas", quantity: 2, unitPrice: 12 }] }, "body"));
    assert.match(mismatch.message, /total no coincide con la suma de las líneas/);
    const ok = parse(PurchaseOrderCreateSchema, { lines: [{ description: "Bombillas", quantity: 2, unitPrice: 12 }] }, "body");
    assert.equal(ok.lines?.length, 1);
    const pin = parse(PurchaseOrderTransitionSchema, { supervisorAuthorizationId: "sa_1" }, "body");
    assert.equal(pin.supervisorAuthorizationId, "sa_1");
  });

  it("los catálogos de alta, transición y lista son coherentes con las claves módulo:tipo", () => {
    for (const key of Object.keys(CREATE_SCHEMAS)) {
      assert.match(key, /^[a-z_]+:[a-z_]+$/);
      assert.equal(isCreateKey(key), true);
    }
    for (const key of Object.keys(TRANSITION_SCHEMAS)) assert.equal(isTransitionKey(key), true);
    for (const key of LIST_RECORD_TYPES) assert.equal(isListKey(key), true);
    assert.equal(isCreateKey("revenue_profit_engine:revenue_scenario"), false);
    assert.equal(isListKey("guest_data_crm_loyalty:guest_profiles"), false);
    assert.equal(isTransitionKey("guest_self_service:guest_self_service_settings"), false);
    assert.equal(Object.keys(CREATE_SCHEMAS).length, 20);
    assert.equal(Object.keys(TRANSITION_SCHEMAS).length, 10);
    assert.equal(LIST_RECORD_TYPES.length, 16);
  });
});

describe("L2-03 · máquinas de estado por tipo", () => {
  it("una transición no permitida es un 409 con código INVALID_TRANSITION", () => {
    const outcome = statusOf(() => assertTransitionAllowed("purchase_order", "received", "approved"));
    assert.equal(outcome.statusCode, 409);
    assert.match(outcome.message, /Transición de estado no permitida: received → approved/);
    assert.deepEqual((outcome.details as { code: string; allowed: string[] }).code, INVALID_TRANSITION_CODE);
    assert.deepEqual((outcome.details as { allowed: string[] }).allowed, []);
    assert.throws(() => assertTransitionAllowed("safety_incident", "closed", "open"), ConflictError);
    assert.throws(() => assertTransitionAllowed("crm_campaign", "sent", "draft"), ConflictError);
    assert.throws(() => assertTransitionAllowed("absence_request", "approved", "rejected"), ConflictError);
  });

  it("un estado origen desconocido (fila legada) o un tipo sin máquina también son 409", () => {
    assert.equal(statusOf(() => assertTransitionAllowed("purchase_order", "legacy", "approved")).statusCode, 409);
    assert.equal(statusOf(() => assertTransitionAllowed("crm_segment", "a", "b")).statusCode, 409);
  });

  it("las transiciones del flujo real pasan y el mismo estado es idempotente", () => {
    assert.doesNotThrow(() => assertTransitionAllowed("purchase_order", "draft", "approved"));
    assert.doesNotThrow(() => assertTransitionAllowed("purchase_order", "approved", "received"));
    assert.doesNotThrow(() => assertTransitionAllowed("safety_incident", "open", "resolved"));
    assert.doesNotThrow(() => assertTransitionAllowed("quality_case", "in_progress", "closed"));
    assert.doesNotThrow(() => assertTransitionAllowed("guest_review", "pending", "responded"));
    assert.doesNotThrow(() => assertTransitionAllowed("anomaly_event", "open", "acknowledged"));
    assert.doesNotThrow(() => assertTransitionAllowed("loyalty_membership", "paused", "active"));
    assert.doesNotThrow(() => assertTransitionAllowed("shift", "confirmed", "confirmed"));
    for (const [type, machine] of Object.entries(STATE_MACHINES)) {
      assert.ok(machine.initial in machine.transitions, `${type}: el estado inicial debe estar en la máquina`);
      for (const targets of Object.values(machine.transitions)) {
        for (const target of targets) assert.ok(target in machine.transitions, `${type}: destino ${target} fuera de la máquina`);
      }
    }
  });

  it("los esquemas de transición solo admiten los estados de su máquina", () => {
    assert.equal(statusOf(() => parse(CrmCampaignUpdateSchema, { status: "archived" }, "body")).statusCode, 400);
    assert.equal(parse(CrmCampaignUpdateSchema, { status: "scheduled" }, "body").status, "scheduled");
    assert.equal(statusOf(() => parse(AnomalyTransitionSchema, {}, "body")).statusCode, 400);
    assert.equal(statusOf(() => parse(AnomalyTransitionSchema, { status: "open" }, "body")).statusCode, 400);
  });
});

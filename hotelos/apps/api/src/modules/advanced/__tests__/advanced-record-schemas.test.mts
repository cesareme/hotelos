// Tanda L2 (L2-03): contratos de entrada del motor genérico — esquemas zod
// estrictos con mensajes en español y máquinas de estado cerradas. Puro (sin
// base de datos). Tanda RRHH (RRHH-4): la persona es una ficha (staffProfileId)
// o un alias resoluble (staffName = código de empleado o nombre del usuario, lo
// resuelve el almacén); ausencias con tipo tasado y filtro de estado. Desde apps/api:
//   node --import tsx --test src/modules/advanced/__tests__/advanced-record-schemas.test.mts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parse } from "../../../lib/validate.js";
import { BadRequestError, ConflictError } from "../../../lib/http-error.js";
import { ABSENCE_STATUSES, ABSENCE_TYPES } from "@hotelos/shared";
import {
  ABSENCE_STATUS_VALUES,
  ABSENCE_TYPE_VALUES,
  AbsenceCreateSchema,
  AbsenceListFilterSchema,
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
    const outcome = statusOf(() => parse(ShiftCreateSchema, { staffProfileId: "sp_1", startAt: "2026-10-01T09:00:00.000Z", endAt: "2026-10-01T17:00:00.000Z", foo: 1 }, "body"));
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
    const badDate = statusOf(() => parse(ShiftCreateSchema, { staffProfileId: "sp_1", startAt: "ayer", endAt: "2026-10-01T17:00:00.000Z" }, "body"));
    assert.match(badDate.message, /startAt debe ser una fecha ISO 8601/);
  });

  it("acepta el cuerpo real de las pantallas con la ficha (turno, fichaje, incidente)", () => {
    const shift = parse(ShiftCreateSchema, { staffProfileId: "sp_1", role: "recepción", startAt: "2026-10-01T09:00:00.000Z", endAt: "2026-10-01T17:00:00.000Z" }, "body");
    assert.equal(shift.staffProfileId, "sp_1");
    assert.equal(shift.staffName, undefined);
    const clock = parse(TimeClockCreateSchema, { propertyId: "prop_1", staffProfileId: "sp_1", action: "in", at: "2026-10-01T09:00:00.000Z" }, "body");
    assert.equal(clock.action, "in");
    const incident = parse(IncidentCreateSchema, { title: "Caída", severity: "high", location: "Pasillo 2", description: "Suelo mojado", occurredAt: "2026-10-01T09:00:00.000Z" }, "body");
    assert.equal(incident.severity, "high");
  });

  it("staffName es un alias (código de empleado o nombre de usuario) que el esquema admite y el almacén resuelve; sin ficha ni alias es un 400", () => {
    const byCode = parse(ShiftCreateSchema, { staffName: "rec-001", startAt: "2026-10-01T09:00:00.000Z", endAt: "2026-10-01T17:00:00.000Z" }, "body");
    assert.equal(byCode.staffName, "rec-001");
    assert.equal(byCode.staffProfileId, undefined);
    const clock = parse(TimeClockCreateSchema, { propertyId: "prop_1", staffName: "REC-001", action: "out" }, "body");
    assert.equal(clock.staffName, "REC-001");
    const none = statusOf(() => parse(ShiftCreateSchema, { startAt: "2026-10-01T09:00:00.000Z", endAt: "2026-10-01T17:00:00.000Z" }, "body"));
    assert.equal(none.statusCode, 400);
    assert.match(none.message, /Indica staffProfileId o staffName/);
    // Corrector RRHH · RF-01: el fichaje SIN ficha ni alias es válido en el esquema (la del propio actor); el store
    // resuelve la propia con timeclock.use y responde 400 HR_EMPLOYEE_REQUIRED a un gestor que no nombra a nadie.
    const ownClock = parse(TimeClockCreateSchema, { propertyId: "prop_1", action: "in" }, "body");
    assert.equal(ownClock.staffProfileId, undefined);
    assert.equal(ownClock.staffName, undefined);
    assert.equal(statusOf(() => parse(AbsenceCreateSchema, { absenceType: "vacation", startDate: "2026-11-02", endDate: "2026-11-06" }, "body")).statusCode, 400);
  });

  it("las ausencias llevan tipo tasado (ABSENCE_TYPES), motivo opcional y filtro de estado por la máquina", () => {
    assert.deepEqual([...ABSENCE_TYPE_VALUES], [...ABSENCE_TYPES]);
    assert.deepEqual([...ABSENCE_STATUS_VALUES], [...ABSENCE_STATUSES]);
    const ok = parse(AbsenceCreateSchema, { staffProfileId: "sp_1", absenceType: "it_common", startDate: "2026-11-02", endDate: "2026-11-06", reason: "Parte de baja" }, "body");
    assert.equal(ok.absenceType, "it_common");
    assert.equal(ok.reason, "Parte de baja");
    const legacy = statusOf(() => parse(AbsenceCreateSchema, { staffProfileId: "sp_1", absenceType: "sick", startDate: "2026-11-02", endDate: "2026-11-06" }, "body"));
    assert.equal(legacy.statusCode, 400);
    assert.match(legacy.message, /El tipo de ausencia debe ser uno de: vacation, it_common, it_accident, permit_paid, permit_unpaid, maternity, unjustified, strike, compensatory_rest/);
    const inverted = statusOf(() => parse(AbsenceCreateSchema, { staffProfileId: "sp_1", absenceType: "vacation", startDate: "2026-11-06", endDate: "2026-11-02" }, "body"));
    assert.match(inverted.message, /endDate no puede ser anterior a startDate/);
    assert.equal(parse(AbsenceListFilterSchema, { status: "pending" }, "query").status, "pending");
    assert.equal(parse(AbsenceListFilterSchema, {}, "query").status, undefined);
    const bogus = statusOf(() => parse(AbsenceListFilterSchema, { status: "bogus" }, "query"));
    assert.equal(bogus.statusCode, 400);
    assert.match(bogus.message, /El estado debe ser uno de: pending, approved, rejected, cancelled/);
  });

  it("valida las reglas cruzadas: fin posterior al inicio, total coherente con las líneas", () => {
    const inverted = statusOf(() => parse(ShiftCreateSchema, { staffProfileId: "sp_1", startAt: "2026-10-01T17:00:00.000Z", endAt: "2026-10-01T09:00:00.000Z" }, "body"));
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
    assert.equal(isListKey("workforce_labor:absence_requests"), true, "Tanda RRHH: lista de ausencias");
    assert.equal(isTransitionKey("guest_self_service:guest_self_service_settings"), false);
    assert.equal(Object.keys(CREATE_SCHEMAS).length, 20);
    assert.equal(Object.keys(TRANSITION_SCHEMAS).length, 10);
    assert.equal(LIST_RECORD_TYPES.length, 17);
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

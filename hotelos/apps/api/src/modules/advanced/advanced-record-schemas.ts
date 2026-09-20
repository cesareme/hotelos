// Tanda L2 (L2-03 · motor genérico Prisma-only): contratos de entrada del
// motor de módulos avanzados. Un esquema zod `.strict()` por tipo de registro
// (mensajes en español) y una máquina de estados explícita por tipo para las
// transiciones. Fichero PURO (sin Prisma): lo importan el almacén
// (advanced-record-store.ts) y los tests unitarios.
//
// Convenciones:
//   · Cada esquema se aplica con `parse(schema, payload, "body")`
//     (lib/validate.ts): un campo desconocido, un tipo incorrecto o un valor
//     fuera de rango es un 400 tipado, nunca un 500 ni un dato «reparado» en
//     silencio (los antiguos `String(payload.x ?? "…")` desaparecen).
//   · Las fechas llegan como cadenas ISO 8601 (`2026-09-18` o
//     `2026-09-18T09:00:00.000Z`); se convierten a Date en el almacén.
//   · Las máquinas de estado son cerradas: un estado no listado o una
//     transición no permitida es un 409 (ConflictError) con código
//     `INVALID_TRANSITION`.

import { z } from "zod";
import { ABSENCE_STATUSES, ABSENCE_TYPES } from "@hotelos/shared";
import { ConflictError } from "../../lib/http-error.js";

// ---------------------------------------------------------------------------
// Piezas reutilizables con mensajes en español
// ---------------------------------------------------------------------------

const esMessages = (label: string) => ({
  required_error: `${label} es obligatorio.`,
  invalid_type_error: `${label} no tiene el formato esperado.`
});

/** Texto obligatorio (recortado, no vacío, con longitud máxima). */
export const text = (label: string, max = 500) =>
  z.string(esMessages(label)).trim().min(1, `${label} no puede estar vacío.`).max(max, `${label} supera los ${max} caracteres.`);

/** Identificador (cuid, `prefijo_xxxx` o similar): texto corto sin espacios. */
export const identifier = (label: string) =>
  z
    .string(esMessages(label))
    .trim()
    .min(1, `${label} no puede estar vacío.`)
    .max(64, `${label} supera los 64 caracteres.`)
    .regex(/^[A-Za-z0-9_.:-]+$/, `${label} contiene caracteres no permitidos.`);

/** Fecha u hora ISO 8601 (`YYYY-MM-DD` o fecha-hora); se valida que sea parseable. */
export const isoDateTime = (label: string) =>
  z
    .string(esMessages(label))
    .trim()
    .min(1, `${label} no puede estar vacío.`)
    .refine((value) => /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value)), {
      message: `${label} debe ser una fecha ISO 8601 (YYYY-MM-DD o fecha y hora).`
    });

/** Importe o cantidad decimal no negativa (número JSON finito). */
export const amount = (label: string) =>
  z.number(esMessages(label)).finite(`${label} debe ser un número finito.`).nonnegative(`${label} no puede ser negativo.`);

/** Objeto JSON libre (configuraciones, reglas, contenido). */
export const jsonObject = (label: string) => z.record(z.string(), z.unknown(), esMessages(label));

/** Enumerado cerrado con mensaje que lista los valores admitidos. */
export const oneOf = <const T extends readonly [string, ...string[]]>(label: string, values: T) =>
  z.enum(values, { errorMap: () => ({ message: `${label} debe ser uno de: ${values.join(", ")}.` }) });

const UNKNOWN_KEY_MESSAGE = "El cuerpo contiene campos no admitidos.";

/** Objeto estricto: cualquier clave no declarada es un 400. */
const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict(UNKNOWN_KEY_MESSAGE);

// ---------------------------------------------------------------------------
// Máquinas de estado (transición) — cerradas, una por tipo
// ---------------------------------------------------------------------------

export type StateMachine = {
  /** Estado con el que nace el registro. */
  initial: string;
  /** Estado origen → estados destino permitidos. Un estado ausente es terminal. */
  transitions: Readonly<Record<string, readonly string[]>>;
};

const OPERATIONAL_CASE: StateMachine = {
  initial: "open",
  transitions: {
    open: ["in_progress", "resolved", "closed"],
    in_progress: ["resolved", "closed", "open"],
    resolved: ["closed", "open"],
    closed: []
  }
};

/** Máquina por tipo de entidad (clave = entityType de la ruta). */
export const STATE_MACHINES: Readonly<Record<string, StateMachine>> = {
  shift: {
    initial: "scheduled",
    transitions: { scheduled: ["confirmed", "cancelled", "completed"], confirmed: ["completed", "cancelled"], completed: [], cancelled: [] }
  },
  absence_request: { initial: "pending", transitions: { pending: ["approved", "rejected", "cancelled"], approved: [], rejected: [], cancelled: [] } },
  safety_incident: OPERATIONAL_CASE,
  quality_case: OPERATIONAL_CASE,
  crm_campaign: {
    initial: "draft",
    transitions: { draft: ["scheduled", "paused"], scheduled: ["sent", "paused", "draft"], paused: ["scheduled", "draft"], sent: [] }
  },
  loyalty_membership: { initial: "active", transitions: { active: ["paused", "cancelled"], paused: ["active", "cancelled"], cancelled: [] } },
  purchase_order: { initial: "draft", transitions: { draft: ["approved", "cancelled"], approved: ["received", "cancelled"], received: [], cancelled: [] } },
  guest_review: { initial: "pending", transitions: { pending: ["responded"], responded: [] } },
  anomaly_event: {
    initial: "open",
    transitions: { open: ["acknowledged", "resolved", "dismissed"], acknowledged: ["resolved", "dismissed"], resolved: [], dismissed: [] }
  }
};

export const INVALID_TRANSITION_CODE = "INVALID_TRANSITION";

/**
 * Comprueba que `from → to` está permitido por la máquina del tipo. Un estado
 * origen fuera de la máquina (fila legada) o un destino no listado es un 409.
 * `from === to` se admite (actualización de campos sin cambio de estado).
 */
export function assertTransitionAllowed(entityType: string, from: string, to: string): void {
  if (from === to) return;
  const machine = STATE_MACHINES[entityType];
  if (!machine) throw new ConflictError(`El tipo ${entityType} no admite transiciones de estado.`, { code: INVALID_TRANSITION_CODE, entityType, from, to });
  const allowed = machine.transitions[from];
  if (!allowed || !allowed.includes(to)) {
    throw new ConflictError(`Transición de estado no permitida: ${from} → ${to}.`, { code: INVALID_TRANSITION_CODE, entityType, from, to, allowed: allowed ?? [] });
  }
}

const statusOf = (entityType: string) => {
  const machine = STATE_MACHINES[entityType];
  const values = machine ? (Object.keys(machine.transitions) as [string, ...string[]]) : (["open"] as [string, ...string[]]);
  return oneOf("El estado", values);
};

// ---------------------------------------------------------------------------
// workforce_labor
// ---------------------------------------------------------------------------

// Tanda RRHH (RRHH-4): la persona se identifica SIEMPRE por su ficha
// (StaffProfile). `staffName` deja de ser un nombre libre: es un ALIAS
// resoluble (código de empleado o nombre completo del usuario de la
// organización, exacto e insensible a mayúsculas) que el almacén convierte en
// `staffProfileId`; si no resuelve, 400 HR_EMPLOYEE_REQUIRED. Nunca se guarda
// el texto como id ni en metadataJson.
const staffFields = {
  staffProfileId: identifier("staffProfileId").optional(),
  /** Alias de la ficha (employeeCode o nombre completo del usuario): se resuelve a StaffProfile o es un 400. */
  staffName: text("staffName", 120).optional()
};

/** Tipos de ausencia tasados (diseño §4 · AbsenceRequest; ABSENCE_TYPES de @hotelos/shared). */
export const ABSENCE_TYPE_VALUES = ABSENCE_TYPES;
/** Estados de AbsenceRequest admitidos como filtro de la lista `workforce_labor:absence_requests`. */
export const ABSENCE_STATUS_VALUES = ABSENCE_STATUSES;

export const ShiftCreateSchema = strictObject({
  ...staffFields,
  departmentId: identifier("departmentId").optional(),
  role: text("role", 80).optional(),
  startAt: isoDateTime("startAt"),
  endAt: isoDateTime("endAt"),
  status: oneOf("El estado", ["scheduled", "confirmed"]).optional()
})
  .refine((value) => Boolean(value.staffProfileId || value.staffName), { message: "Indica staffProfileId o staffName.", path: ["staffName"] })
  .refine((value) => Date.parse(value.endAt) > Date.parse(value.startAt), { message: "endAt debe ser posterior a startAt.", path: ["endAt"] });

export const ShiftUpdateSchema = strictObject({
  staffProfileId: identifier("staffProfileId").optional(),
  departmentId: identifier("departmentId").optional(),
  role: text("role", 80).optional(),
  startAt: isoDateTime("startAt").optional(),
  endAt: isoDateTime("endAt").optional(),
  status: statusOf("shift").optional()
});

/**
 * Fichaje: sin `staffProfileId` ni `staffName` la ficha es la del propio actor (corrector RRHH · RF-01:
 * con solo workforce.timeclock.use SIEMPRE es la propia; con timeclock.manage, quien no nombra a nadie
 * recibe 400 HR_EMPLOYEE_REQUIRED del store). `at` solo lo honra timeclock.manage.
 */
export const TimeClockCreateSchema = strictObject({
  ...staffFields,
  /** La pantalla envía la propiedad activa en el cuerpo: debe coincidir con la de la petición. */
  propertyId: identifier("propertyId").optional(),
  action: oneOf("La acción", ["in", "out"]).optional(),
  at: isoDateTime("at").optional(),
  source: text("source", 40).optional()
});

export const AbsenceCreateSchema = strictObject({
  ...staffFields,
  absenceType: oneOf("El tipo de ausencia", ABSENCE_TYPE_VALUES),
  startDate: isoDateTime("startDate"),
  endDate: isoDateTime("endDate"),
  reason: text("reason", 500).optional()
})
  .refine((value) => Boolean(value.staffProfileId || value.staffName), { message: "Indica staffProfileId o staffName.", path: ["staffName"] })
  .refine((value) => Date.parse(value.endDate) >= Date.parse(value.startDate), { message: "endDate no puede ser anterior a startDate.", path: ["endDate"] });

export const AbsenceTransitionSchema = strictObject({
  status: oneOf("El estado", ["approved", "rejected", "cancelled"]).optional(),
  note: text("note", 500).optional()
});

/** Filtro de la lista de ausencias (`?status=`): uno de los estados de la máquina. */
export const AbsenceListFilterSchema = strictObject({
  status: oneOf("El estado", ABSENCE_STATUS_VALUES).optional()
});

// ---------------------------------------------------------------------------
// safety_incident_management
// ---------------------------------------------------------------------------

export const INCIDENT_SEVERITIES = ["low", "medium", "high", "critical"] as const;

export const IncidentCreateSchema = strictObject({
  title: text("title", 200),
  severity: oneOf("La gravedad", INCIDENT_SEVERITIES).optional(),
  incidentType: text("incidentType", 60).optional(),
  description: text("description", 4000).optional(),
  /** Ubicación en texto libre (la pantalla no tiene selector de zona). */
  location: text("location", 200).optional(),
  guestId: identifier("guestId").optional(),
  reservationId: identifier("reservationId").optional(),
  assignedTo: identifier("assignedTo").optional(),
  occurredAt: isoDateTime("occurredAt").optional()
});

export const IncidentUpdateSchema = strictObject({
  status: statusOf("safety_incident").optional(),
  severity: oneOf("La gravedad", INCIDENT_SEVERITIES).optional(),
  title: text("title", 200).optional(),
  description: text("description", 4000).optional(),
  assignedTo: identifier("assignedTo").optional(),
  /** Marca temporal de gestión (la pantalla envía handledAt al «Marcar gestionado»). */
  handledAt: isoDateTime("handledAt").optional(),
  resolvedAt: isoDateTime("resolvedAt").optional()
});

export const EvidenceCreateSchema = strictObject({
  incidentId: identifier("incidentId"),
  evidenceType: oneOf("El tipo de evidencia", ["note", "photo", "document", "video", "other"]).optional(),
  objectKey: text("objectKey", 500).optional(),
  notes: text("notes", 4000).optional()
});

export const SafetyCheckCreateSchema = strictObject({
  /** La pantalla envía `name`; el modelo lo guarda como título. */
  name: text("name", 200).optional(),
  title: text("title", 200).optional(),
  checkType: text("checkType", 60).optional(),
  frequency: oneOf("La frecuencia", ["daily", "weekly", "monthly", "quarterly", "yearly"]).optional(),
  location: text("location", 200).optional(),
  assignedTo: identifier("assignedTo").optional(),
  nextDueDate: isoDateTime("nextDueDate").optional(),
  active: z.boolean(esMessages("active")).optional()
}).refine((value) => Boolean(value.name || value.title), { message: "Indica name o title.", path: ["name"] });

export const SafetyCheckResultCreateSchema = strictObject({
  safetyCheckId: identifier("safetyCheckId"),
  status: oneOf("El resultado", ["passed", "failed", "partial", "skipped"]),
  notes: text("notes", 4000).optional(),
  completedAt: isoDateTime("completedAt").optional()
});

// ---------------------------------------------------------------------------
// reputation_quality
// ---------------------------------------------------------------------------

export const QualityCaseCreateSchema = strictObject({
  title: text("title", 200),
  caseType: text("caseType", 60).optional(),
  priority: oneOf("La prioridad", ["low", "normal", "high", "urgent"]).optional(),
  description: text("description", 4000).optional(),
  reservationId: identifier("reservationId").optional(),
  guestId: identifier("guestId").optional(),
  roomId: identifier("roomId").optional(),
  ownerUserId: identifier("ownerUserId").optional(),
  slaTargetAt: isoDateTime("slaTargetAt").optional(),
  rootCause: text("rootCause", 2000).optional()
});

export const QualityCaseUpdateSchema = strictObject({
  status: statusOf("quality_case").optional(),
  priority: oneOf("La prioridad", ["low", "normal", "high", "urgent"]).optional(),
  title: text("title", 200).optional(),
  description: text("description", 4000).optional(),
  rootCause: text("rootCause", 2000).optional(),
  ownerUserId: identifier("ownerUserId").optional(),
  resolvedAt: isoDateTime("resolvedAt").optional()
});

export const SurveyCreateSchema = strictObject({
  name: text("name", 200),
  surveyType: oneOf("El tipo de encuesta", ["post_stay", "in_stay", "pre_arrival", "event", "other"]).optional(),
  questions: z.array(jsonObject("Cada pregunta"), esMessages("questions")).max(100, "Una encuesta admite hasta 100 preguntas.").optional(),
  active: z.boolean(esMessages("active")).optional()
});

export const SurveyResponseCreateSchema = strictObject({
  surveyId: identifier("surveyId"),
  reservationId: identifier("reservationId").optional(),
  guestId: identifier("guestId").optional(),
  score: z.number(esMessages("score")).min(0, "score debe estar entre 0 y 10.").max(10, "score debe estar entre 0 y 10.").optional(),
  answers: jsonObject("answers").optional()
});

export const GuestReviewRespondSchema = strictObject({
  responseBody: text("responseBody", 4000)
});

// ---------------------------------------------------------------------------
// guest_data_crm_loyalty
// ---------------------------------------------------------------------------

export const CrmSegmentCreateSchema = strictObject({
  name: text("name", 120),
  description: text("description", 1000).optional(),
  rulesJson: jsonObject("rulesJson").optional(),
  active: z.boolean(esMessages("active")).optional()
});

export const CrmSegmentUpdateSchema = strictObject({
  name: text("name", 120).optional(),
  description: text("description", 1000).optional(),
  rulesJson: jsonObject("rulesJson").optional(),
  active: z.boolean(esMessages("active")).optional()
});

export const CAMPAIGN_CHANNELS = ["email", "sms", "whatsapp", "push"] as const;

export const CrmCampaignCreateSchema = strictObject({
  name: text("name", 120),
  campaignType: text("campaignType", 60),
  channel: oneOf("El canal", CAMPAIGN_CHANNELS),
  segmentId: identifier("segmentId").optional(),
  scheduleJson: jsonObject("scheduleJson").optional(),
  contentJson: jsonObject("contentJson").optional()
});

export const CrmCampaignUpdateSchema = strictObject({
  name: text("name", 120).optional(),
  campaignType: text("campaignType", 60).optional(),
  channel: oneOf("El canal", CAMPAIGN_CHANNELS).optional(),
  segmentId: identifier("segmentId").optional(),
  status: statusOf("crm_campaign").optional(),
  scheduleJson: jsonObject("scheduleJson").optional(),
  contentJson: jsonObject("contentJson").optional()
});

export const LoyaltyProgramCreateSchema = strictObject({
  name: text("name", 120),
  configurationJson: jsonObject("configurationJson").optional(),
  active: z.boolean(esMessages("active")).optional()
});

export const LoyaltyMembershipUpdateSchema = strictObject({
  tier: text("tier", 40).optional(),
  pointsBalance: z.number(esMessages("pointsBalance")).int("pointsBalance debe ser un entero.").nonnegative("pointsBalance no puede ser negativo.").optional(),
  status: statusOf("loyalty_membership").optional()
});

// ---------------------------------------------------------------------------
// groups_events_sales
// ---------------------------------------------------------------------------

export const EventOrderCreateSchema = strictObject({
  eventId: identifier("eventId"),
  orderType: oneOf("El tipo de orden", ["beo", "catering", "setup", "av"]).optional(),
  content: jsonObject("content").optional(),
  notes: text("notes", 4000).optional()
});

// ---------------------------------------------------------------------------
// procurement_inventory
// ---------------------------------------------------------------------------

export const PurchaseOrderLineSchema = strictObject({
  inventoryItemId: identifier("inventoryItemId").optional(),
  description: text("description", 300),
  quantity: amount("quantity").positive("quantity debe ser mayor que cero."),
  unitPrice: amount("unitPrice")
});

export const PurchaseOrderCreateSchema = strictObject({
  supplierId: identifier("supplierId").optional(),
  lines: z.array(PurchaseOrderLineSchema, esMessages("lines")).max(200, "Un pedido admite hasta 200 líneas.").optional(),
  /** Total declarado; si hay líneas debe coincidir con su suma (±0,01). */
  total: amount("total").optional(),
  promisedDate: isoDateTime("promisedDate").optional(),
  notes: text("notes", 4000).optional()
})
  .refine((value) => value.total !== undefined || (value.lines !== undefined && value.lines.length > 0), {
    message: "Indica total o al menos una línea.",
    path: ["total"]
  })
  .refine(
    (value) => {
      if (value.total === undefined || !value.lines || value.lines.length === 0) return true;
      const sum = value.lines.reduce((acc, line) => acc + line.quantity * line.unitPrice, 0);
      return Math.abs(sum - value.total) < 0.01;
    },
    { message: "total no coincide con la suma de las líneas.", path: ["total"] }
  );

export const PurchaseOrderTransitionSchema = strictObject({
  /** PIN/autorización de supervisor cuando el importe supera el tramo del actor (Tanda 8a). */
  supervisorAuthorizationId: identifier("supervisorAuthorizationId").optional(),
  receivedDate: isoDateTime("receivedDate").optional(),
  note: text("note", 1000).optional()
});

// ---------------------------------------------------------------------------
// energy_sustainability
// ---------------------------------------------------------------------------

export const UtilityMeterCreateSchema = strictObject({
  meterType: oneOf("El tipo de contador", ["electricity", "gas", "water", "heat", "other"]),
  name: text("name", 120),
  unit: text("unit", 20),
  buildingId: identifier("buildingId").optional(),
  floorId: identifier("floorId").optional(),
  zoneId: identifier("zoneId").optional(),
  provider: text("provider", 120).optional(),
  active: z.boolean(esMessages("active")).optional()
});

export const UtilityReadingCreateSchema = strictObject({
  meterId: identifier("meterId"),
  readingDate: isoDateTime("readingDate"),
  value: amount("value"),
  source: oneOf("El origen", ["manual", "import", "sensor", "api"]).optional()
});

export const SustainabilityActionCreateSchema = strictObject({
  title: text("title", 200),
  description: text("description", 4000).optional(),
  category: text("category", 60).optional(),
  status: oneOf("El estado", ["planned", "in_progress", "done", "cancelled"]).optional(),
  estimatedCost: amount("estimatedCost").optional(),
  estimatedSavings: amount("estimatedSavings").optional(),
  linkedCapexProjectId: identifier("linkedCapexProjectId").optional()
});

// ---------------------------------------------------------------------------
// hotel_intelligence_platform
// ---------------------------------------------------------------------------

export const MetricDefinitionCreateSchema = strictObject({
  metricCode: identifier("metricCode"),
  name: text("name", 120),
  description: text("description", 1000).optional(),
  formulaJson: jsonObject("formulaJson").optional(),
  category: text("category", 60).optional(),
  active: z.boolean(esMessages("active")).optional()
});

export const AnomalyTransitionSchema = strictObject({
  status: oneOf("El estado", ["acknowledged", "resolved", "dismissed"]),
  note: text("note", 1000).optional()
});

export const ScheduledReportCreateSchema = strictObject({
  name: text("name", 120),
  reportType: text("reportType", 60),
  scheduleJson: jsonObject("scheduleJson").optional(),
  recipients: z.array(z.string(esMessages("Cada destinatario")).email("Cada destinatario debe ser un correo válido."), esMessages("recipients")).max(50).optional(),
  active: z.boolean(esMessages("active")).optional()
});

// ---------------------------------------------------------------------------
// Catálogo (clave `${moduleCode}:${entityType}`) — la fuente de verdad de qué
// tipos existen. El almacén hace el switch sobre estas mismas claves.
// ---------------------------------------------------------------------------

export const CREATE_SCHEMAS = {
  "workforce_labor:shift": ShiftCreateSchema,
  "workforce_labor:time_clock_entry": TimeClockCreateSchema,
  "workforce_labor:absence_request": AbsenceCreateSchema,
  "safety_incident_management:safety_incident": IncidentCreateSchema,
  "safety_incident_management:incident_evidence": EvidenceCreateSchema,
  "safety_incident_management:safety_check": SafetyCheckCreateSchema,
  "safety_incident_management:safety_check_result": SafetyCheckResultCreateSchema,
  "reputation_quality:quality_case": QualityCaseCreateSchema,
  "reputation_quality:survey": SurveyCreateSchema,
  "reputation_quality:survey_response": SurveyResponseCreateSchema,
  "guest_data_crm_loyalty:crm_segment": CrmSegmentCreateSchema,
  "guest_data_crm_loyalty:crm_campaign": CrmCampaignCreateSchema,
  "guest_data_crm_loyalty:loyalty_program": LoyaltyProgramCreateSchema,
  "groups_events_sales:event_order": EventOrderCreateSchema,
  "procurement_inventory:purchase_order": PurchaseOrderCreateSchema,
  "energy_sustainability:utility_meter": UtilityMeterCreateSchema,
  "energy_sustainability:utility_reading": UtilityReadingCreateSchema,
  "energy_sustainability:sustainability_action": SustainabilityActionCreateSchema,
  "hotel_intelligence_platform:metric_definition": MetricDefinitionCreateSchema,
  "hotel_intelligence_platform:scheduled_report": ScheduledReportCreateSchema
} as const;

export const TRANSITION_SCHEMAS = {
  "workforce_labor:shift": ShiftUpdateSchema,
  "workforce_labor:absence_request": AbsenceTransitionSchema,
  "safety_incident_management:safety_incident": IncidentUpdateSchema,
  "reputation_quality:quality_case": QualityCaseUpdateSchema,
  "reputation_quality:guest_review": GuestReviewRespondSchema,
  "guest_data_crm_loyalty:crm_segment": CrmSegmentUpdateSchema,
  "guest_data_crm_loyalty:crm_campaign": CrmCampaignUpdateSchema,
  "guest_data_crm_loyalty:loyalty_membership": LoyaltyMembershipUpdateSchema,
  "procurement_inventory:purchase_order": PurchaseOrderTransitionSchema,
  "hotel_intelligence_platform:anomaly_event": AnomalyTransitionSchema
} as const;

/** Tipos de LISTA (recordType de las rutas GET) que sirve el almacén. */
export const LIST_RECORD_TYPES = [
  "workforce_labor:schedule",
  "workforce_labor:time_clock_entries",
  "workforce_labor:absence_requests",
  "safety_incident_management:safety_incidents",
  "safety_incident_management:safety_checks",
  "reputation_quality:quality_cases",
  "reputation_quality:surveys",
  "reputation_quality:guest_reviews",
  "guest_data_crm_loyalty:crm_segments",
  "guest_data_crm_loyalty:crm_campaigns",
  "guest_data_crm_loyalty:loyalty",
  "groups_events_sales:events_calendar",
  "procurement_inventory:purchase_orders",
  "energy_sustainability:utility_meters",
  "hotel_intelligence_platform:metrics",
  "hotel_intelligence_platform:anomalies",
  "hotel_intelligence_platform:scheduled_reports"
] as const;

export type CreateKey = keyof typeof CREATE_SCHEMAS;
export type TransitionKey = keyof typeof TRANSITION_SCHEMAS;
export type ListKey = (typeof LIST_RECORD_TYPES)[number];

export const UNSUPPORTED_RECORD_TYPE_MESSAGE = "Tipo de registro no soportado.";

export const isCreateKey = (key: string): key is CreateKey => Object.prototype.hasOwnProperty.call(CREATE_SCHEMAS, key);
export const isTransitionKey = (key: string): key is TransitionKey => Object.prototype.hasOwnProperty.call(TRANSITION_SCHEMAS, key);
export const isListKey = (key: string): key is ListKey => (LIST_RECORD_TYPES as readonly string[]).includes(key);

export type ShiftCreateInput = z.infer<typeof ShiftCreateSchema>;
export type ShiftUpdateInput = z.infer<typeof ShiftUpdateSchema>;
export type TimeClockCreateInput = z.infer<typeof TimeClockCreateSchema>;
export type AbsenceCreateInput = z.infer<typeof AbsenceCreateSchema>;
export type AbsenceTransitionInput = z.infer<typeof AbsenceTransitionSchema>;
export type AbsenceListFilterInput = z.infer<typeof AbsenceListFilterSchema>;
export type IncidentCreateInput = z.infer<typeof IncidentCreateSchema>;
export type IncidentUpdateInput = z.infer<typeof IncidentUpdateSchema>;
export type EvidenceCreateInput = z.infer<typeof EvidenceCreateSchema>;
export type SafetyCheckCreateInput = z.infer<typeof SafetyCheckCreateSchema>;
export type SafetyCheckResultCreateInput = z.infer<typeof SafetyCheckResultCreateSchema>;
export type QualityCaseCreateInput = z.infer<typeof QualityCaseCreateSchema>;
export type QualityCaseUpdateInput = z.infer<typeof QualityCaseUpdateSchema>;
export type SurveyCreateInput = z.infer<typeof SurveyCreateSchema>;
export type SurveyResponseCreateInput = z.infer<typeof SurveyResponseCreateSchema>;
export type GuestReviewRespondInput = z.infer<typeof GuestReviewRespondSchema>;
export type CrmSegmentCreateInput = z.infer<typeof CrmSegmentCreateSchema>;
export type CrmSegmentUpdateInput = z.infer<typeof CrmSegmentUpdateSchema>;
export type CrmCampaignCreateInput = z.infer<typeof CrmCampaignCreateSchema>;
export type CrmCampaignUpdateInput = z.infer<typeof CrmCampaignUpdateSchema>;
export type LoyaltyProgramCreateInput = z.infer<typeof LoyaltyProgramCreateSchema>;
export type LoyaltyMembershipUpdateInput = z.infer<typeof LoyaltyMembershipUpdateSchema>;
export type EventOrderCreateInput = z.infer<typeof EventOrderCreateSchema>;
export type PurchaseOrderCreateInput = z.infer<typeof PurchaseOrderCreateSchema>;
export type PurchaseOrderTransitionInput = z.infer<typeof PurchaseOrderTransitionSchema>;
export type UtilityMeterCreateInput = z.infer<typeof UtilityMeterCreateSchema>;
export type UtilityReadingCreateInput = z.infer<typeof UtilityReadingCreateSchema>;
export type SustainabilityActionCreateInput = z.infer<typeof SustainabilityActionCreateSchema>;
export type MetricDefinitionCreateInput = z.infer<typeof MetricDefinitionCreateSchema>;
export type AnomalyTransitionInput = z.infer<typeof AnomalyTransitionSchema>;
export type ScheduledReportCreateInput = z.infer<typeof ScheduledReportCreateSchema>;

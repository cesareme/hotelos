// Zod schemas for reservation lifecycle endpoints (create, patch, check-in,
// check-out, cancel). These are the hot-path mutations of the PMS; every
// payload that crosses the wire MUST be validated before it reaches the
// service layer to prevent type confusion + injection-style errors.

import { z } from "zod";

// ISO date strings (YYYY-MM-DD) are the canonical wire format used by all
// reservation endpoints. We don't accept Date objects: the JSON-over-HTTP
// boundary always serializes to string anyway.
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "must be YYYY-MM-DD");
const isoDateTime = z.string().min(1).optional();

// Guest identity sub-schema — kept partial/optional because the booking flow
// frequently captures only the booker, not the full Mews-style identity card.
const GuestIdentitySubSchema = z
  .object({
    title: z.string().max(40).optional(),
    firstName: z.string().max(120).optional(),
    middleName: z.string().max(120).optional(),
    surname1: z.string().max(120).optional(),
    surname2: z.string().max(120).optional(),
    documentType: z.string().max(40).optional(),
    documentNumber: z.string().max(60).optional(),
    documentSupportNumber: z.string().max(60).optional(),
    documentIssueCountry: z.string().max(3).optional(),
    documentExpiryDate: z.string().optional(),
    nationality: z.string().max(3).optional(),
    dateOfBirth: z.string().optional(),
    sex: z.string().max(10).optional(),
    languagePreference: z.string().max(10).optional(),
    residenceAddress: z.string().max(500).optional(),
    residenceLocality: z.string().max(120).optional(),
    residenceProvince: z.string().max(120).optional(),
    residencePostalCode: z.string().max(20).optional(),
    residenceCountry: z.string().max(3).optional(),
    phone: z.string().max(40).optional(),
    mobilePhone: z.string().max(40).optional(),
    email: z.string().email().optional().nullable(),
    company: z.string().max(200).optional(),
    vipCode: z.string().max(20).optional(),
    loyaltyProgram: z.string().max(80).optional(),
    loyaltyNumber: z.string().max(80).optional(),
    loyaltyTier: z.string().max(80).optional(),
    emergencyContactName: z.string().max(200).optional(),
    emergencyContactPhone: z.string().max(40).optional(),
    marketingConsent: z.boolean().optional(),
    preferences: z.array(z.string()).optional(),
    notes: z.string().max(2000).optional()
  })
  .passthrough();

// POST /properties/:propertyId/reservations — large payload, but we lock down
// the critical fields. `.passthrough()` keeps the legacy free-form fields
// flowing without surprising the existing service layer.
export const CreateReservationSchema = z
  .object({
    propertyId: z.string().optional(),
    channel: z.string().max(80).optional(),
    channelId: z.string().optional(),
    arrivalDate: isoDate,
    departureDate: isoDate,
    adults: z.number().int().nonnegative().optional(),
    children: z.number().int().nonnegative().optional(),
    infants: z.number().int().nonnegative().optional(),
    childrenAges: z.array(z.number().int().nonnegative()).optional(),
    roomsCount: z.number().int().positive().optional(),
    eta: isoDateTime,
    etd: isoDateTime,
    roomTypeId: z.string().min(1, "roomTypeId required"),
    assignedRoomId: z.string().optional(),
    // UX-1 (corrector L-02): confirma una llegada anterior a hoy; la ruta solo lo honra con pms.reservation.modify.
    allowPastArrival: z.boolean().optional(),
    ratePlanId: z.string().optional(),
    boardType: z.string().max(40).optional(),
    marketSegment: z.string().max(80).optional(),
    sourceCode: z.string().max(80).optional(),
    purposeOfStay: z.string().max(80).optional(),
    guaranteeType: z.string().max(40).optional(),
    depositAmount: z.number().nonnegative().optional(),
    cancellationPolicyCode: z.string().max(80).optional(),
    billingInstruction: z.string().max(500).optional(),
    companyName: z.string().max(200).optional(),
    travelAgentName: z.string().max(200).optional(),
    groupCode: z.string().max(80).optional(),
    externalReference: z.string().max(200).optional(),
    bookerName: z.string().max(200).optional(),
    bookerEmail: z.string().email().optional().nullable(),
    specialRequests: z.string().max(2000).optional(),
    notes: z.string().max(2000).optional(),
    totalAmount: z.number().nonnegative().optional(),
    currency: z.string().length(3).optional(),
    // Tanda 8a (corrector · FSOD-06): reason code of a discount below the quote
    // (design §4.7, ≤ T1 with a code) and the single-use supervisor PIN
    // authorisation for pms.reservation.override (overbooking / discount > T1).
    discountReasonCode: z.string().trim().min(1).max(64).optional(),
    supervisorAuthorizationId: z.string().trim().min(1).max(64).nullable().optional(),
    guests: z.array(GuestIdentitySubSchema).optional(),
    primaryGuest: GuestIdentitySubSchema.optional()
  })
  .passthrough();

export type CreateReservationInput = z.infer<typeof CreateReservationSchema>;

// PATCH /reservations/:id — STRICT allowlist (Tanda 2 · REC-01).
//
// Every key below is a real `Reservation` column (schema.prisma `model
// Reservation`) plus the legacy `roomId` alias. Unknown keys are a 400: the
// old `.passthrough()` let `status`, `roomId`, `vipFlag`, … reach the service
// unvalidated, and the service silently dropped most of what the schema did
// accept. `null` clears a nullable column; `undefined` (absent) leaves it as is.
//
// Deliberately NOT editable here:
//   - `status`: lifecycle transitions have their own endpoints (/check-in,
//     /check-out, /cancel, /no-show) so room/Stay/folio side effects run.
//   - `id`, `propertyId`, `code`, `createdAt`, `deletedAt`: immutable / system.
//   - `cancellationPolicyId`: owned by the cancellation-policy service.
//   - `masterFolioId` is kept as the ONE non-column key: it reroutes the linked
//     GroupBooking.masterFolioId (audit FOLIO_ROUTED) and is ignored when the
//     reservation has no groupBookingId.
const nullableText = (max: number) => z.string().max(max).nullable().optional();
// Free-form clock/time strings ("HH:MM" by convention; the create flow never
// enforced a stricter format, so PATCH doesn't either).
const nullableTime = z.string().min(1).max(40).nullable().optional();
const STATUS_NOT_PATCHABLE =
  "status no se puede modificar por PATCH: usa /reservations/:id/check-in, /check-out, /cancel o /no-show.";

export const UpdateReservationSchema = z
  .object({
    // Stay window & occupancy
    arrivalDate: isoDate.optional(),
    departureDate: isoDate.optional(),
    adults: z.number().int().nonnegative().optional(),
    children: z.number().int().nonnegative().optional(),
    infants: z.number().int().nonnegative().optional(),
    childrenAges: z.array(z.number().int().nonnegative()).max(20).nullable().optional(),
    roomsCount: z.number().int().positive().optional(),
    eta: nullableTime,
    etd: nullableTime,
    estimatedArrivalTime: nullableTime,
    // Inventory & pricing links (validated against the reservation's property)
    roomTypeId: z.string().min(1).optional(),
    assignedRoomId: z.string().min(1).nullable().optional(),
    // Legacy alias of assignedRoomId (LiveTimeline / ChangeRoomDialog send it).
    roomId: z.string().min(1).nullable().optional(),
    ratePlanId: z.string().min(1).nullable().optional(),
    groupBookingId: z.string().min(1).nullable().optional(),
    // Commercial attributes
    channel: z.string().min(1).max(80).optional(),
    bookingSource: nullableText(80),
    boardType: nullableText(40),
    marketSegment: nullableText(80),
    sourceCode: nullableText(80),
    purposeOfStay: nullableText(80),
    guaranteeType: nullableText(40),
    depositAmount: z.number().nonnegative().nullable().optional(),
    depositPaid: z.number().nonnegative().nullable().optional(),
    depositDueDate: isoDate.nullable().optional(),
    paymentMethod: nullableText(40),
    cancellationPolicyCode: nullableText(80),
    billingInstruction: nullableText(500),
    companyName: nullableText(200),
    travelAgentName: nullableText(200),
    groupCode: nullableText(80),
    externalReference: nullableText(200),
    bookerName: nullableText(200),
    bookerEmail: z.string().email().max(200).nullable().optional(),
    // Guest-facing notes & flags
    specialRequests: nullableText(2000),
    notes: nullableText(2000),
    internalNotes: nullableText(2000),
    accessibilityNeeds: nullableText(500),
    dietaryRequirements: nullableText(500),
    vipFlag: z.boolean().optional(),
    // Money
    totalAmount: z.number().nonnegative().optional(),
    currency: z.string().length(3).optional(),
    // Non-column: reroutes GroupBooking.masterFolioId (see header comment).
    masterFolioId: z.string().min(1).nullable().optional(),
    // Explicitly rejected with a message that points at the lifecycle routes
    // (a bare `.strict()` would only say "Unrecognized key").
    status: z.never({ invalid_type_error: STATUS_NOT_PATCHABLE }).optional()
  })
  .strict();

export type UpdateReservationInput = z.infer<typeof UpdateReservationSchema>;

/**
 * HTTP body of PATCH /reservations/:id (Tanda 8a · corrector, FSOD-06): the
 * column patch above plus the two non-column fields the service reads when
 * `totalAmount` goes below the published quote — the discount reason code
 * (≤ T1, design §4.7) and the single-use supervisor PIN authorisation (> T1,
 * pms.reservation.override). The route strips them before handing the patch
 * to `patchReservation`, so the column mappers never see them.
 */
export const UpdateReservationBodySchema = UpdateReservationSchema.extend({
  discountReasonCode: z.string().trim().min(1).max(64).optional(),
  supervisorAuthorizationId: z.string().trim().min(1).max(64).nullable().optional()
}).strict();

export type UpdateReservationBody = z.infer<typeof UpdateReservationBodySchema>;

// POST /reservations/:id/check-in
export const CheckInSchema = z
  .object({
    roomId: z.string().min(1, "roomId required"),
    signatureObjectKey: z.string().optional(),
    paymentMethod: z.string().max(40).optional(),
    // REC-10: the service rejects (409) check-ins whose arrivalDate is more than
    // ±1 day away from the property's business date. This flag overrides the
    // window and requires `pms.reservation.modify` on top of `pms.checkin.execute`.
    allowEarlyCheckIn: z.boolean().optional(),
    // REC-09: an override is an audited exception, so it must carry a reason.
    // Whitespace-only / "" is not a reason (trim runs before min).
    overrideReason: z
      .string()
      .trim()
      .min(3, "overrideReason debe tener al menos 3 caracteres")
      .max(500, "overrideReason no puede superar 500 caracteres")
      .optional()
  })
  .superRefine((value, ctx) => {
    if (value.allowEarlyCheckIn === true && !value.overrideReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["overrideReason"],
        message: "overrideReason es obligatorio con allowEarlyCheckIn"
      });
    }
  });

export type CheckInInput = z.infer<typeof CheckInSchema>;

// POST /reservations/:id/check-out — body is empty for most flows. REC-08:
// when the folio still has a balance due the service answers 409
// (details.code = BALANCE_DUE) unless the client acknowledges it explicitly.
export const CheckOutSchema = z
  .object({
    paymentRequired: z.boolean().optional(),
    paymentMethod: z.string().max(40).optional(),
    acknowledgeBalance: z.boolean().optional()
  })
  .partial();

export type CheckOutInput = z.infer<typeof CheckOutSchema>;

// GET /properties/:propertyId/reservations — server-side filters (REC-05).
// Unknown query params are stripped (ignored); malformed values are a 400.
// `limit` / `cursor` / `envelope` are parsed by lib/pagination.ts instead.
const RESERVATION_STATUS_VALUES = ["draft", "confirmed", "checked_in", "checked_out", "cancelled", "no_show"] as const;
const strictIsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const csvStatus = z
  .string()
  .transform((raw) => raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0))
  .pipe(z.array(z.enum(RESERVATION_STATUS_VALUES)).min(1, "status must list at least one ReservationStatus"));

export const ReservationListFilterSchema = z.object({
  status: csvStatus.optional(),
  from: strictIsoDate.optional(),
  to: strictIsoDate.optional(),
  arrivalFrom: strictIsoDate.optional(),
  arrivalTo: strictIsoDate.optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(["arrival_desc", "arrival_asc"]).optional()
});

export type ReservationListFilterInput = z.infer<typeof ReservationListFilterSchema>;

// POST /reservations/:id/cancel
// Tanda L3 (lote S): `applyPolicy` lets the caller skip the cancellation
// policy (penalty + folio close). Omitted = the handler assumes `true`.
// Deliberately NOT `.strict()`: unknown keys (e.g. a snake_case `apply_policy`)
// are dropped, never a 400, so the existing front dialogs keep working.
export const CancelReservationSchema = z.object({
  reason: z.string().max(1000).optional(),
  reasonCode: z.string().max(40).optional(),
  notes: z.string().max(2000).optional(),
  applyPolicy: z.boolean().optional(),
  // Corrector L3 (DS-02): waiving a penalty above the operative band needs
  // the discount engine (approval, override or a supervisor PIN bound to
  // `pms.reservation.override` on this reservation) — same key as the price gate.
  supervisorAuthorizationId: z.string().min(1).max(120).optional()
});

export type CancelReservationInput = z.infer<typeof CancelReservationSchema>;

// POST /reservations/:id/no-show
// Tanda L3 (lote S): same `applyPolicy` semantics as the cancel body.
export const NoShowReservationSchema = z.object({
  reason: z.string().max(1000).optional(),
  applyPolicy: z.boolean().optional(),
  supervisorAuthorizationId: z.string().min(1).max(120).optional()
});

export type NoShowReservationInput = z.infer<typeof NoShowReservationSchema>;

// POST /reservations/:id/assign-room
export const AssignRoomSchema = z
  .object({
    roomId: z.string().optional(),
    roomNumber: z.string().optional()
  })
  .refine((v) => Boolean(v.roomId) || Boolean(v.roomNumber), {
    message: "roomId or roomNumber is required"
  });

export type AssignRoomInput = z.infer<typeof AssignRoomSchema>;

// POST /properties/:propertyId/availability/quote — body of quoteAvailability
// (pms.service.ts). Dates are strict calendar days (a regex alone lets
// "2026-13-45" through and the service would build an Invalid Date from it);
// departure must be after arrival; occupancy defaults to one adult.
// `roomTypeId` / `ratePlanId` narrow the quote to one room type / one rate
// plan's published grid; both are optional.
function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
const calendarDate = strictIsoDate.refine(isCalendarDate, { message: "must be a valid calendar date (YYYY-MM-DD)" });

export const QuoteAvailabilitySchema = z
  .object({
    arrivalDate: calendarDate,
    departureDate: calendarDate,
    adults: z.number().int().min(1).default(1),
    children: z.number().int().min(0).default(0),
    roomTypeId: z.string().min(1).optional(),
    ratePlanId: z.string().min(1).optional()
  })
  .refine((value) => value.departureDate > value.arrivalDate, {
    message: "La fecha de salida debe ser posterior a la fecha de llegada.",
    path: ["departureDate"]
  });

export type QuoteAvailabilityInput = z.infer<typeof QuoteAvailabilitySchema>;

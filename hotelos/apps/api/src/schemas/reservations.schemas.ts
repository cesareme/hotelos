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
    guests: z.array(GuestIdentitySubSchema).optional(),
    primaryGuest: GuestIdentitySubSchema.optional()
  })
  .passthrough();

export type CreateReservationInput = z.infer<typeof CreateReservationSchema>;

// PATCH /reservations/:id — every field optional (server applies partial update).
export const UpdateReservationSchema = z
  .object({
    arrivalDate: isoDate.optional(),
    departureDate: isoDate.optional(),
    adults: z.number().int().nonnegative().optional(),
    children: z.number().int().nonnegative().optional(),
    infants: z.number().int().nonnegative().optional(),
    eta: isoDateTime,
    etd: isoDateTime,
    roomTypeId: z.string().optional(),
    assignedRoomId: z.string().optional(),
    ratePlanId: z.string().optional(),
    boardType: z.string().max(40).optional(),
    marketSegment: z.string().max(80).optional(),
    notes: z.string().max(2000).optional(),
    specialRequests: z.string().max(2000).optional(),
    totalAmount: z.number().nonnegative().optional(),
    currency: z.string().length(3).optional()
  })
  .passthrough();

export type UpdateReservationInput = z.infer<typeof UpdateReservationSchema>;

// POST /reservations/:id/check-in
export const CheckInSchema = z.object({
  roomId: z.string().min(1, "roomId required"),
  signatureObjectKey: z.string().optional(),
  paymentMethod: z.string().max(40).optional()
});

export type CheckInInput = z.infer<typeof CheckInSchema>;

// POST /reservations/:id/check-out — body is currently empty for most flows
// but we accept optional payment intent fields used by the new express path.
export const CheckOutSchema = z
  .object({
    paymentRequired: z.boolean().optional(),
    paymentMethod: z.string().max(40).optional()
  })
  .partial();

export type CheckOutInput = z.infer<typeof CheckOutSchema>;

// POST /reservations/:id/cancel
export const CancelReservationSchema = z.object({
  reason: z.string().max(1000).optional(),
  reasonCode: z.string().max(40).optional(),
  notes: z.string().max(2000).optional()
});

export type CancelReservationInput = z.infer<typeof CancelReservationSchema>;

// POST /reservations/:id/no-show
export const NoShowReservationSchema = z.object({
  reason: z.string().max(1000).optional()
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

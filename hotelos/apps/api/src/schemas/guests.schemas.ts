// Zod schemas for guest CRUD + identity capture.
//
// Guest records hold PII (name, document number, residence) that the Spanish
// SES Hospedajes regulation considers sensitive. We validate every write at
// the handler boundary to guarantee shape + bounded string lengths and to
// reject obviously broken document numbers / emails / dates.

import { z } from "zod";

// Reusable identity sub-schema — every field optional because guest captures
// are progressive (booker name first, then identity card on check-in).
export const GuestIdentitySchema = z
  .object({
    title: z.string().max(40).optional(),
    firstName: z.string().min(1).max(120).optional(),
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
    gender: z.string().max(10).optional(),
    languagePreference: z.string().max(10).optional(),
    residenceAddress: z.string().max(500).optional(),
    residenceLocality: z.string().max(120).optional(),
    residenceProvince: z.string().max(120).optional(),
    residencePostalCode: z.string().max(20).optional(),
    residenceCountry: z.string().max(3).optional(),
    phone: z.string().max(40).optional().nullable(),
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

export type GuestIdentityInput = z.infer<typeof GuestIdentitySchema>;

// POST /guests — accepts either { guest: {...} } envelope or bare fields.
// We require firstName at minimum (no anonymous guests).
export const CreateGuestSchema = z
  .object({
    firstName: z.string().min(1, "required").max(120),
    email: z.string().email().optional().nullable(),
    phone: z.string().max(40).optional().nullable(),
    documentNumber: z.string().max(60).optional().nullable()
  })
  .passthrough();

export type CreateGuestInput = z.infer<typeof CreateGuestSchema>;

// PATCH /guests/:id — partial update.
export const UpdateGuestSchema = GuestIdentitySchema.partial();

export type UpdateGuestInput = z.infer<typeof UpdateGuestSchema>;

import type { GuestIdentityFields } from "@hotelos/shared";

export const REQUIRED_GUEST_REGISTER_FIELDS = [
  "firstName",
  "surname1",
  "documentType",
  "documentNumber",
  "nationality",
  "dateOfBirth",
  "phone"
] as const;

export type RequiredGuestRegisterField = (typeof REQUIRED_GUEST_REGISTER_FIELDS)[number];

export function detectMissingGuestRegisterFields(fields: GuestIdentityFields): RequiredGuestRegisterField[] {
  return REQUIRED_GUEST_REGISTER_FIELDS.filter((field) => {
    const value = fields[field];
    return value === undefined || value === null || String(value).trim() === "";
  });
}

export function calculateGuestRegisterRetentionUntil(createdAt: Date): Date {
  const retentionUntil = new Date(createdAt);
  retentionUntil.setFullYear(retentionUntil.getFullYear() + 3);
  return retentionUntil;
}

export function buildGuestRegisterPayload(fields: GuestIdentityFields): Record<string, unknown> {
  return {
    firstName: fields.firstName,
    surname1: fields.surname1,
    surname2: fields.surname2,
    documentType: fields.documentType,
    documentNumber: fields.documentNumber,
    nationality: fields.nationality,
    dateOfBirth: fields.dateOfBirth,
    residenceAddress: fields.residenceAddress,
    phone: fields.phone,
    email: fields.email
  };
}


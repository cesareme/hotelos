import { apiRequest } from "./api-client";

export type GuestProfile = {
  id: string;
  organizationId: string;
  title?: string;
  firstName: string;
  middleName?: string;
  surname1?: string;
  surname2?: string;
  fullName: string;
  documentType?: string;
  documentNumber?: string;
  documentSupportNumber?: string;
  documentIssueCountry?: string;
  documentExpiryDate?: string;
  nationality?: string;
  sex?: string;
  languagePreference?: string;
  dateOfBirth?: string;
  residenceAddress?: string;
  residenceLocality?: string;
  residenceProvince?: string;
  residencePostalCode?: string;
  residenceCountry?: string;
  phone?: string;
  mobilePhone?: string;
  email?: string;
  company?: string;
  vipCode?: string;
  loyaltyProgram?: string;
  loyaltyNumber?: string;
  loyaltyTier?: string;
  preferences: string[];
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  marketingConsent?: boolean;
  notes?: string;
  createdAt: string;
};

export type GuestStay = {
  id: string;
  code: string;
  propertyId: string;
  status: string;
  arrivalDate?: string;
  departureDate?: string;
  roomTypeId?: string;
  totalAmount: number;
  currency: string;
  isPrimary: boolean;
};

export type GuestDetail = {
  guest: GuestProfile;
  stayHistory: GuestStay[];
  stats: { stays: number; lifetimeValue: number };
};

/** Payload accepted by create/update — every field optional except firstName on create. */
export type GuestInput = Partial<Omit<GuestProfile, "id" | "organizationId" | "fullName" | "createdAt">> & {
  firstName?: string;
};

export async function fetchGuests(search?: string): Promise<GuestProfile[]> {
  return apiRequest<GuestProfile[]>("/guests", { query: search?.trim() ? { search: search.trim() } : undefined });
}

export async function fetchGuest(id: string): Promise<GuestDetail> {
  return apiRequest<GuestDetail>(`/guests/${id}`);
}

export async function createGuest(guest: GuestInput): Promise<GuestProfile> {
  return apiRequest<GuestProfile>("/guests", { method: "POST", body: { guest } });
}

export async function updateGuest(id: string, guest: GuestInput): Promise<GuestProfile> {
  return apiRequest<GuestProfile>(`/guests/${id}`, { method: "PATCH", body: { guest } });
}

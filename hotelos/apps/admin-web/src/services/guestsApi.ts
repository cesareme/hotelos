import { apiRequest } from "./api-client";
import type { Page, PageQuery } from "./pmsCommerceApi";

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

export type GuestListQuery = PageQuery & {
  /** Name / company contains, exact email or document. With a term the API returns nextCursor: null. */
  search?: string;
};

// Tanda 2 · REC-05/QC-04: legacy call keeps the bare array; passing a query
// object requests the `{ items, nextCursor, total }` envelope (createdAt desc).
export function fetchGuests(search?: string): Promise<GuestProfile[]>;
export function fetchGuests(query: GuestListQuery): Promise<Page<GuestProfile>>;
export function fetchGuests(arg?: string | GuestListQuery): Promise<GuestProfile[] | Page<GuestProfile>> {
  if (arg === undefined || typeof arg === "string") {
    const term = arg?.trim();
    return apiRequest<GuestProfile[]>("/guests", { query: term ? { search: term } : undefined });
  }
  const term = arg.search?.trim();
  return apiRequest<Page<GuestProfile>>("/guests", {
    query: {
      search: term || undefined,
      limit: arg.limit,
      cursor: arg.cursor,
      envelope: "1"
    }
  });
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

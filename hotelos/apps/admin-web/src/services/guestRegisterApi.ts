import { z } from "zod";
import { apiRequest } from "./api-client";

/**
 * Spain Guest Register (parte de entrada) — real API service.
 *
 * Backs the GuestRegisterSettingsScreen with the real backend endpoints
 * exposed in apps/api/src/server.ts under `/compliance/spain/...` and
 * `/properties/:propertyId/guest-register-records`.
 *
 * Includes a Zod schema (`spainGuestRegisterInputSchema`) used to validate the
 * record payload client-side before submission, with retry logic and
 * structured error reporting so the screen can render a useful status.
 */

// ---------------------------------------------------------------------------
// Zod schemas — mirror packages/compliance SpainGuestRegisterRecordInput.
// ---------------------------------------------------------------------------

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T.*)?$/, "Use ISO date format (YYYY-MM-DD).");

export const spainGuestRegisterInputSchema = z.object({
  recordType: z
    .enum(["reservation", "checkin", "cancellation", "correction", "annulment"])
    .optional(),
  firstName: z.string().trim().min(1, "First name is required."),
  surname1: z.string().trim().min(1, "Surname is required."),
  surname2: z.string().trim().optional(),
  sex: z.enum(["M", "F", "X"]).optional(),
  nationality: z
    .string()
    .trim()
    .length(2, "Use the ISO-3166 alpha-2 country code (e.g. ES, FR).")
    .toUpperCase(),
  dateOfBirth: isoDate,
  documentType: z.enum(["DNI", "PASSPORT", "TIE"]),
  documentNumber: z.string().trim().min(1, "Document number is required."),
  documentSupportNumber: z.string().trim().optional(),
  residenceFullAddress: z
    .string()
    .trim()
    .min(1, "Residence address is required."),
  residenceLocality: z
    .string()
    .trim()
    .min(1, "Residence locality is required."),
  residenceCountry: z
    .string()
    .trim()
    .length(2, "Use the ISO-3166 alpha-2 country code (e.g. ES, FR).")
    .toUpperCase(),
  phoneLandline: z.string().trim().optional(),
  phoneMobile: z.string().trim().optional(),
  email: z.string().trim().email("Invalid email address.").optional().or(z.literal("")),
  travellerCount: z
    .number()
    .int("Traveller count must be an integer.")
    .min(1, "At least one traveller is required."),
  isMinor: z.boolean().optional(),
  providedByAdultGuestId: z.string().trim().optional(),
  kinshipRelationIfMinor: z.string().trim().optional(),
  contractReference: z
    .string()
    .trim()
    .min(1, "Contract reference is required."),
  contractDate: isoDate.optional(),
  checkinAt: z.string().optional(),
  checkoutAt: z.string().optional(),
  paymentType: z.string().trim().optional(),
  paymentMethodIdentifier: z.string().trim().optional(),
  paymentHolder: z.string().trim().optional(),
  paymentReference: z.string().trim().optional(),
  signatureRequired: z.boolean().optional(),
  idImageStored: z.boolean().optional(),
  idImageDiscarded: z.boolean().optional()
});

export type SpainGuestRegisterInput = z.infer<typeof spainGuestRegisterInputSchema>;

// ---------------------------------------------------------------------------
// Response types — kept loose because the backend may evolve.
// ---------------------------------------------------------------------------

export type GuestRegisterStatus =
  | "draft"
  | "missing_data"
  | "ready_to_sign"
  | "signed"
  | "ready_to_submit"
  | "queued"
  | "exported"
  | "submitted"
  | "accepted"
  | "rejected"
  | "failed"
  | "annulled"
  | "corrected"
  | "expired";

export type GuestRegisterValidationIssue = {
  code: string;
  field?: string;
  severity: "blocking" | "warning";
  message: string;
};

export type GuestRegisterRecord = {
  id: string;
  propertyId: string;
  reservationId: string;
  guestId?: string;
  recordType: string;
  status: GuestRegisterStatus;
  /** Tanda L5 (L5-B1): ReservationGuest.isPrimary of the link the parte was created from. */
  isPrimaryGuest?: boolean;
  /** Tanda L5 (L5-B1): under 14 at check-in (no signature; declared through the adult). */
  isMinor?: boolean;
  providedByAdultGuestId?: string;
  kinshipRelationIfMinor?: string;
  firstName?: string;
  surname1?: string;
  surname2?: string;
  documentType?: string;
  documentNumber?: string;
  nationality?: string;
  dateOfBirth?: string;
  travellerCount?: number;
  contractReference?: string;
  signatureRequired?: boolean;
  signedAt?: string;
  identityVerified?: boolean;
  identityVerifiedAt?: string;
  identityVerificationMethod?: string;
  validationErrorsJson?: GuestRegisterValidationIssue[];
  retentionUntil?: string;
  createdAt: string;
  updatedAt: string;
};

/** Spanish label of a parte status (same wording as the guest-register queue screen). */
export const GUEST_REGISTER_STATUS_LABELS: Record<GuestRegisterStatus, string> = {
  draft: "Borrador",
  missing_data: "Datos incompletos",
  ready_to_sign: "Listo para firmar",
  signed: "Firmado",
  ready_to_submit: "Listo para enviar",
  queued: "En cola",
  exported: "Exportado",
  submitted: "Enviado",
  accepted: "Aceptado",
  rejected: "Rechazado",
  failed: "Fallido",
  annulled: "Anulado",
  corrected: "Corregido",
  expired: "Caducado"
};

export function guestRegisterStatusLabel(status: string | null | undefined): string {
  return (status && GUEST_REGISTER_STATUS_LABELS[status as GuestRegisterStatus]) || status || "Desconocido";
}

/**
 * POST /compliance/spain/guest-register/:recordId/validate (Tanda L5 · L5-B1):
 * `status` is the PERSISTED status of the parte (pipeline terminals preserved,
 * signature-only rule applied), `valid` / `issues` the validator verdict.
 */
export type GuestRegisterValidationResult = {
  valid: boolean;
  status: GuestRegisterStatus;
  issues: GuestRegisterValidationIssue[];
  payload?: Record<string, unknown>;
};

export type AuthoritySubmissionResult = {
  id: string;
  guestRegisterRecordId?: string;
  authorityType: string;
  submissionType: string;
  status: "queued" | "sent" | "accepted" | "rejected" | "failed" | "annulled";
  externalReference?: string;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
};

// ---------------------------------------------------------------------------
// Retry helper — exponential backoff for transient errors.
// ---------------------------------------------------------------------------

export type RetryOptions = {
  retries?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
};

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message.toLowerCase();
  // Auth/permission errors and explicit 4xx aren't worth retrying.
  if (m.includes("authentication") || m.includes("permission")) return false;
  if (/\bhttp 4\d\d\b/.test(m)) return false;
  // Network / 5xx / generic failures are retried.
  return true;
}

async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 400;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === retries || !isTransientError(err)) throw err;
      const delay = base * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// API surface — thin wrappers over apiRequest with validation + retry.
// ---------------------------------------------------------------------------

export async function listPropertyGuestRegisterRecords(
  propertyId: string,
  opts: RetryOptions = {}
): Promise<GuestRegisterRecord[]> {
  return withRetry(
    () => apiRequest<GuestRegisterRecord[]>(`/properties/${propertyId}/guest-register-records`),
    opts
  );
}

export async function listReservationGuestRegisterRecords(
  reservationId: string,
  opts: RetryOptions = {}
): Promise<GuestRegisterRecord[]> {
  return withRetry(
    () =>
      apiRequest<GuestRegisterRecord[]>(
        `/compliance/spain/reservations/${reservationId}/guest-register`
      ),
    opts
  );
}

/**
 * Create a Spain guest register record (parte de entrada) for a reservation.
 * The payload is validated against the Zod schema before being sent so the
 * caller gets the same field errors that the backend would reject on.
 */
export async function createSpainGuestRegisterRecord(args: {
  reservationId: string;
  propertyId: string;
  input: SpainGuestRegisterInput;
  retry?: RetryOptions;
}): Promise<GuestRegisterRecord> {
  const parsed = spainGuestRegisterInputSchema.parse(args.input);
  return withRetry(
    () =>
      apiRequest<GuestRegisterRecord>(
        `/compliance/spain/reservations/${args.reservationId}/guest-register`,
        {
          method: "POST",
          body: { ...parsed, propertyId: args.propertyId }
        }
      ),
    args.retry
  );
}

/** POST …/validate — re-validates the persisted columns; `status` is the row's status (Tanda L5 · L5-B1). */
export async function validateSpainGuestRegisterRecord(recordId: string, opts: RetryOptions = {}): Promise<GuestRegisterValidationResult> {
  return withRetry(
    () => apiRequest<GuestRegisterValidationResult>(`/compliance/spain/guest-register/${recordId}/validate`, { method: "POST", body: {} }),
    opts
  );
}

/**
 * POST …/mark-identity-verified (guest_register.edit): the receptionist checked
 * the traveller's document at the desk. Never retried: a 403 is a real answer
 * (the caller decides whether it blocks; the check-in drawer treats it as
 * non-blocking).
 */
export async function markGuestRegisterIdentityVerified(recordId: string, method = "visual_document_check"): Promise<GuestRegisterRecord> {
  return apiRequest<GuestRegisterRecord>(`/compliance/spain/guest-register/${recordId}/mark-identity-verified`, { method: "POST", body: { method } });
}

export async function queueSpainGuestRegisterSubmission(
  recordId: string,
  submissionType: "reservation" | "checkin" | "cancellation" = "checkin",
  opts: RetryOptions = {}
): Promise<AuthoritySubmissionResult> {
  return withRetry(
    () =>
      apiRequest<AuthoritySubmissionResult>(
        `/compliance/spain/guest-register/${recordId}/queue-submission`,
        { method: "POST", body: { submissionType } }
      ),
    opts
  );
}

// Tanda L2 (L2-02): retrySpainAuthoritySubmission se retiró con el reintento en
// memoria de envíos a autoridad; el reintento canónico es
// POST /ses/submissions/:id/retry.

/**
 * Helper that wraps `spainGuestRegisterInputSchema.safeParse` so callers can
 * render per-field validation errors without throwing.
 */
export type FormValidationErrors = Partial<Record<keyof SpainGuestRegisterInput, string>>;

export function validateSpainGuestRegisterForm(
  input: unknown
): { ok: true; data: SpainGuestRegisterInput } | { ok: false; errors: FormValidationErrors } {
  const result = spainGuestRegisterInputSchema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  const errors: FormValidationErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path[0];
    if (typeof key === "string" && !(key in errors)) {
      (errors as Record<string, string>)[key] = issue.message;
    }
  }
  return { ok: false, errors };
}

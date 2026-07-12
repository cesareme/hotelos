// Tiny fetch wrapper for the guest portal.
//
// The guest portal speaks to the HotelOS API on the same origin in
// production. During local dev the user can override the base URL via
// `VITE_GUEST_API_BASE`. When that env var is UNSET we fall back to typed
// stubs so the UI keeps working offline for demos. When it IS set we call the
// real Sprint 40 guest-portal endpoints:
//   POST /guest-portal/sign-in
//   POST /guest-portal/sign-out
//   GET  /guest-portal/reservation        (x-guest-token header)
//   POST /guest-portal/pre-check-in       (x-guest-token header)
//   POST /guest-portal/service-request    (x-guest-token header)

export type ReservationSummary = {
  id: string;
  reservationCode: string;
  propertyId: string;
  propertyName: string;
  guestName: string;
  roomType: string;
  roomNumber?: string;
  arrival: string; // ISO date
  departure: string; // ISO date
  guests: number;
  status: "confirmed" | "checked_in" | "checked_out" | "cancelled";
  balanceDue: number;
  currency: string;
};

export type PreCheckInPayload = {
  documentType: "passport" | "dni" | "nie" | "other";
  documentNumber: string;
  residenceAddress: string;
  country: string;
  arrivalEta: string; // ISO datetime
  specialRequests?: string;
};

export type ServiceRequestPayload = {
  category: "housekeeping" | "food_beverage" | "concierge" | "maintenance";
  description: string;
  preferredTime?: string;
};

export type SignInPayload = {
  reservationCode: string;
  email: string;
};

export type GuestSession = {
  reservationId: string;
  reservationCode: string;
  email: string;
  // Short-lived guest bearer token returned by the real API. Sent on every
  // subsequent request via the `x-guest-token` header.
  token?: string;
};

const baseUrl = ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_GUEST_API_BASE ?? "").replace(/\/$/, "");

// In-memory guest token for the current portal session. We deliberately keep
// it in module state (not localStorage) so it lives only as long as the tab —
// the token is short-lived and sensitive.
let guestToken: string | null = null;

export function setGuestToken(token: string | null): void {
  guestToken = token;
}

export function getGuestToken(): string | null {
  return guestToken;
}

function guestHeaders(): Record<string, string> {
  return guestToken ? { "x-guest-token": guestToken } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(message);
  }
  // Tolerate empty bodies (204).
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ---- Sign-in --------------------------------------------------------------
// Real endpoint: POST /guest-portal/sign-in (anti-enumeration — returns
// { ok: false } for both a bad code and a wrong email). On success the API
// returns a short-lived token which we store for subsequent requests.
export async function signIn(payload: SignInPayload): Promise<GuestSession> {
  const code = payload.reservationCode.trim();
  const email = payload.email.trim();
  if (!code || !email) {
    throw new Error("We couldn't find a reservation matching that code and email. Try again or contact the hotel.");
  }

  if (!baseUrl) {
    // Offline demo fallback — accept any non-empty code+email.
    await new Promise((r) => setTimeout(r, 350));
    return { reservationId: "res_demo_001", reservationCode: code.toUpperCase(), email };
  }

  const result = await request<
    { ok: true; token: string; reservationId: string } | { ok: false }
  >("/guest-portal/sign-in", {
    method: "POST",
    body: JSON.stringify({ reservationCode: code, email })
  });

  if (!result.ok) {
    throw new Error("We couldn't find a reservation matching that code and email. Try again or contact the hotel.");
  }

  setGuestToken(result.token);
  return {
    reservationId: result.reservationId,
    reservationCode: code.toUpperCase(),
    email,
    token: result.token
  };
}

// ---- Magic-link token ------------------------------------------------------
// Sprint 45: the guest receives an email with a single-use `?token=` link.
// On app load we exchange that token for a session by setting it as the active
// guest token and verifying it against GET /guest-portal/reservation. A valid
// token yields a full GuestSession; an invalid/expired token returns null so
// the caller can show the sign-in form with a friendly "link expired" message.
export async function signInWithToken(token: string): Promise<GuestSession | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;

  // Offline demo fallback — accept any non-empty token so the preview works
  // without a live API.
  if (!baseUrl) {
    setGuestToken(trimmed);
    const stub = stubReservation("res_demo_001");
    return {
      reservationId: stub.id,
      reservationCode: stub.reservationCode,
      email: "",
      token: trimmed
    };
  }

  setGuestToken(trimmed);
  try {
    const raw = await request<Record<string, unknown>>("/guest-portal/reservation", {
      headers: guestHeaders()
    });
    const reservation = normaliseReservation(raw, "");
    return {
      reservationId: reservation.id,
      reservationCode: reservation.reservationCode,
      email: "",
      token: trimmed
    };
  } catch {
    // Invalid or expired token — clear it so we don't keep sending a dead
    // header on subsequent requests.
    setGuestToken(null);
    return null;
  }
}

// ---- Sign-out -------------------------------------------------------------
export async function signOut(): Promise<void> {
  const token = guestToken;
  setGuestToken(null);
  if (!baseUrl || !token) return;
  try {
    await request<{ ok: true }>("/guest-portal/sign-out", {
      method: "POST",
      body: JSON.stringify({ token })
    });
  } catch {
    // Best-effort: local token is already cleared above.
  }
}

// ---- Reservation summary --------------------------------------------------
export async function getReservation(reservationId: string): Promise<ReservationSummary> {
  // Sin API configurada (demo pura sin backend) el stub es legítimo.
  if (!baseUrl) return stubReservation(reservationId);
  // Auditoría 2026-07: con API real, un error NO debe degradar a la reserva
  // falsa de demostración (Maria Lopez / RES-2026-00042) — el huésped vería
  // datos inventados como si fueran suyos. Propagar para que la UI muestre
  // "no pudimos cargar tu reserva" y permita reintentar.
  const raw = await request<Record<string, unknown>>("/guest-portal/reservation", {
    headers: guestHeaders()
  });
  return normaliseReservation(raw, reservationId);
}

function normaliseReservation(raw: Record<string, unknown>, id: string): ReservationSummary {
  // The Sprint 40 GET /guest-portal/reservation returns a safe projection:
  //   { reservationId, reservationCode, propertyName, status,
  //     arrivalDate, departureDate, roomType, guestCount, balanceDue, currency }
  const guest = (raw.primaryGuest as Record<string, unknown> | undefined) ?? {};
  const firstName = String(guest.firstName ?? "");
  const lastName = String(guest.lastName ?? "");
  const composedName = `${firstName} ${lastName}`.trim();
  return {
    id: String(raw.reservationId ?? raw.id ?? id),
    reservationCode: String(raw.reservationCode ?? raw.code ?? "RES"),
    propertyId: String(raw.propertyId ?? ""),
    propertyName: String(raw.propertyName ?? "Your hotel"),
    guestName: composedName || String(raw.guestName ?? "Guest"),
    roomType: String(raw.roomType ?? raw.roomTypeName ?? "Room"),
    roomNumber: raw.assignedRoomNumber ? String(raw.assignedRoomNumber) : undefined,
    arrival: String(raw.arrivalDate ?? raw.arrival ?? ""),
    departure: String(raw.departureDate ?? raw.departure ?? ""),
    guests: Number(raw.guestCount ?? raw.guests ?? 1),
    status: (String(raw.status ?? "confirmed") as ReservationSummary["status"]),
    balanceDue: Number(raw.balanceDue ?? 0),
    currency: String(raw.currency ?? "EUR")
  };
}

function stubReservation(id: string): ReservationSummary {
  return {
    id,
    reservationCode: "RES-2026-00042",
    propertyId: "prop_demo",
    propertyName: "HotelOS Madrid Centro",
    guestName: "Maria Lopez Garcia",
    roomType: "Deluxe King with city view",
    roomNumber: "432",
    arrival: "2026-05-22",
    departure: "2026-05-25",
    guests: 2,
    status: "confirmed",
    balanceDue: 0,
    currency: "EUR"
  };
}

// ---- Pre-check-in ---------------------------------------------------------
// Real endpoint: POST /guest-portal/pre-check-in (x-guest-token header).
export async function submitPreCheckIn(reservationId: string, payload: PreCheckInPayload): Promise<{ confirmationNumber: string }> {
  if (!baseUrl) {
    await new Promise((r) => setTimeout(r, 400));
    const id = reservationId.slice(-4).toUpperCase();
    const stamp = Date.now().toString(36).toUpperCase().slice(-5);
    void payload;
    return { confirmationNumber: `PCI-${id}-${stamp}` };
  }
  return request<{ confirmationNumber: string }>("/guest-portal/pre-check-in", {
    method: "POST",
    headers: guestHeaders(),
    body: JSON.stringify(payload)
  });
}

// ---- Service request ------------------------------------------------------
// Real endpoint: POST /guest-portal/service-request (x-guest-token header).
export async function submitServiceRequest(reservationId: string, payload: ServiceRequestPayload): Promise<{ ticketNumber: string }> {
  if (!baseUrl) {
    await new Promise((r) => setTimeout(r, 350));
    void reservationId;
    void payload;
    const stamp = Date.now().toString(36).toUpperCase().slice(-5);
    return { ticketNumber: `SRQ-${stamp}` };
  }
  return request<{ ticketNumber: string }>("/guest-portal/service-request", {
    method: "POST",
    headers: guestHeaders(),
    body: JSON.stringify(payload)
  });
}

// ---- Invoice download (stub) ---------------------------------------------
export async function downloadInvoice(reservationId: string): Promise<void> {
  // No real endpoint yet. We generate a tiny client-side text "invoice"
  // and trigger a download so the UI demonstrates the flow.
  const content = [
    "HotelOS — Provisional invoice",
    "================================",
    `Reservation: ${reservationId}`,
    `Issued:      ${new Date().toISOString().slice(0, 10)}`,
    "",
    "A full PDF invoice will replace this file once the",
    "/reservations/:id/invoice endpoint is implemented.",
    ""
  ].join("\n");
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `invoice-${reservationId}.txt`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

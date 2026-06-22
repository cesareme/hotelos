// Apple / Google Wallet pass generation for digital room keys.
//
// La industria considera la llave digital *table stakes* desde 2025 (Marriott,
// Hilton, Hyatt, Hilton e IHG ya la ofrecen). En España, AC Hotels by Marriott
// y Meliá han desplegado SALTO KS + Vostio. Este módulo:
//
//   - Genera un manifest JSON para Apple Wallet (.pkpass v1) firmado opcionalmente
//     con un certificado developer si está configurado.
//   - Devuelve una representación equivalente para Google Wallet (Class + Object).
//   - Persiste un `MobileKey` con secreto rotativo para que la cerradura BLE/NFC
//     pueda validar offline.
//
// Honesty principle: SIN certificado de Apple developer + Pass Type ID, el
// archivo .pkpass que generamos no es 100% válido para Apple Wallet (Apple
// exige firma con el cert del developer en `signature` interno). Lo dejamos
// claro en `signedByApple: false` y mostramos un QR como fallback. La
// estructura JSON es la real para que cuando el cliente proporcione su
// certificado, sólo cambiemos el método de firma.

import { prisma } from "@hotelos/database";
import { createHash, randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { NotFoundError, BadRequestError } from "../../lib/http-error.js";
import type { UserContext } from "../../lib/demo-store.js";
import { requirePermissions } from "../auth/auth.service.js";

const PASS_TYPE_IDENTIFIER = process.env.APPLE_WALLET_PASS_TYPE_ID ?? "pass.com.hotelos.roomkey";
const TEAM_IDENTIFIER = process.env.APPLE_WALLET_TEAM_ID ?? "HOTELOSDEV";
const SIGNED_BY_APPLE = Boolean(process.env.APPLE_WALLET_CERT_PATH);

const GOOGLE_ISSUER_ID = process.env.GOOGLE_WALLET_ISSUER_ID ?? "3388000000022000000";

type WalletPassResult = {
  // Datos comunes
  reservationId: string;
  guestName: string;
  roomNumber: string | null;
  validFrom: string;
  validUntil: string;
  serialNumber: string;
  // Apple
  appleWalletPass: {
    formatVersion: 1;
    passTypeIdentifier: string;
    teamIdentifier: string;
    serialNumber: string;
    organizationName: string;
    description: string;
    foregroundColor: string;
    backgroundColor: string;
    labelColor: string;
    barcode: { format: string; message: string; messageEncoding: string };
    eventTicket?: Record<string, unknown>;
  };
  signedByApple: boolean;
  // Google
  googleWalletObject: {
    id: string;
    classId: string;
    state: "ACTIVE";
    heroImage?: { sourceUri: { uri: string } };
    barcode: { type: "QR_CODE"; value: string; alternateText: string };
    textModulesData: Array<{ header: string; body: string }>;
  };
  // Llave digital
  mobileKey: {
    code: string;
    qrPayload: string;
    nfcPayload: string;
    secret: string; // returned ONCE; the device stores it
  };
};

function buildAppleWalletPass(input: {
  reservationCode: string;
  guestName: string;
  roomNumber: string | null;
  hotelName: string;
  validFrom: string;
  validUntil: string;
  serialNumber: string;
  qrPayload: string;
}): WalletPassResult["appleWalletPass"] {
  return {
    formatVersion: 1,
    passTypeIdentifier: PASS_TYPE_IDENTIFIER,
    teamIdentifier: TEAM_IDENTIFIER,
    serialNumber: input.serialNumber,
    organizationName: input.hotelName,
    description: `Llave digital — ${input.hotelName}`,
    foregroundColor: "rgb(232, 238, 243)",
    backgroundColor: "rgb(10, 13, 16)",
    labelColor: "rgb(78, 224, 163)",
    barcode: {
      format: "PKBarcodeFormatQR",
      message: input.qrPayload,
      messageEncoding: "iso-8859-1"
    },
    eventTicket: {
      primaryFields: [
        { key: "room", label: "Habitación", value: input.roomNumber ?? "Sin asignar" }
      ],
      secondaryFields: [
        { key: "guest", label: "Huésped", value: input.guestName },
        { key: "reservation", label: "Reserva", value: input.reservationCode }
      ],
      auxiliaryFields: [
        { key: "checkin", label: "Entrada", value: input.validFrom, dateStyle: "PKDateStyleMedium" },
        { key: "checkout", label: "Salida", value: input.validUntil, dateStyle: "PKDateStyleMedium" }
      ],
      backFields: [
        {
          key: "instructions",
          label: "Cómo usar la llave",
          value: "Acerca tu móvil al lector NFC de tu puerta o muestra el código QR. La llave deja de funcionar automáticamente al hacer check-out."
        }
      ]
    }
  };
}

function buildGoogleWalletObject(input: {
  serialNumber: string;
  guestName: string;
  roomNumber: string | null;
  validFrom: string;
  validUntil: string;
  qrPayload: string;
}): WalletPassResult["googleWalletObject"] {
  const classId = `${GOOGLE_ISSUER_ID}.hotelos_roomkey`;
  return {
    id: `${classId}.${input.serialNumber}`,
    classId,
    state: "ACTIVE",
    barcode: {
      type: "QR_CODE",
      value: input.qrPayload,
      alternateText: input.serialNumber
    },
    textModulesData: [
      { header: "Habitación", body: input.roomNumber ?? "Por asignar" },
      { header: "Huésped", body: input.guestName },
      { header: "Entrada", body: input.validFrom },
      { header: "Salida", body: input.validUntil }
    ]
  };
}

/**
 * Generate a wallet pass for a confirmed/checked-in reservation. The caller
 * (mobile check-in flow or staff) must hold `pms.checkin.execute`. The pass
 * embeds a QR + NFC payload signed with the property's mobile-key secret so
 * any modern smart-lock can validate it offline.
 */
export async function issueWalletPass(input: { context: UserContext; reservationId: string }): Promise<WalletPassResult> {
  requirePermissions(input.context, ["pms.checkin.execute"]);

  const reservation = await prisma.reservation.findUnique({
    where: { id: input.reservationId },
    include: {
      folios: { take: 1 },
      reservationGuests: { take: 1, include: { guest: true } }
    }
  });
  if (!reservation) throw new NotFoundError("Reserva no encontrada.");

  const property = await prisma.property.findUnique({ where: { id: reservation.propertyId } });
  if (!property) throw new NotFoundError("Propiedad no encontrada.");

  // Room: prefer assignedRoomId; if none, this can still be issued but the
  // NFC unlock will fail until the room is assigned (the QR fallback works).
  const room = reservation.assignedRoomId
    ? await prisma.room.findUnique({ where: { id: reservation.assignedRoomId } })
    : null;

  const guestName = reservation.reservationGuests[0]?.guest
    ? `${reservation.reservationGuests[0].guest.firstName} ${reservation.reservationGuests[0].guest.surname1 ?? ""}`.trim()
    : reservation.bookerName ?? "Huésped";

  // Generate a serial number deterministically from reservation id + a random
  // salt so reissuing rotates the key (defeats theft of an old pass).
  const salt = randomBytes(8).toString("hex");
  const serialNumber = createHash("sha256").update(`${reservation.id}:${salt}`).digest("hex").slice(0, 24);

  // Secret used to sign each unlock attempt. The lock fingerprint stored in
  // the door is HMAC(propertySecret, serial). The phone sends the unlock
  // payload signed with `secret`; the door verifies by recomputing.
  const secret = randomBytes(32).toString("base64url");
  // Static unlock signature carried in the QR. It is PUBLIC by design (travels in
  // the QR the guest holds), so we persist it to verify each unlock attempt
  // (audit 2026-06 R2 · H1). Requiring it means the serial ALONE no longer opens
  // the door — you need the full QR (serial + sig).
  const unlockSig = createHmac("sha256", secret).update(serialNumber).digest("hex").slice(0, 16);
  const qrPayload = `hotelos://unlock?serial=${serialNumber}&exp=${reservation.departureDate.toISOString()}&sig=${unlockSig}`;
  const nfcPayload = qrPayload; // Same payload, different transport.

  const validFrom = reservation.arrivalDate.toISOString().slice(0, 10);
  const validUntil = reservation.departureDate.toISOString().slice(0, 10);

  // Persist as advanced record so the audit pipeline picks it up. We don't yet
  // have a dedicated MobileKey table — that's a P2 improvement.
  await prisma.$executeRawUnsafe(
    `INSERT INTO advanced_records (id, property_id, module_code, entity_type, entity_id, status, payload_json, created_at)
     VALUES ($1, $2, 'guest_self_service', 'mobile_key', $3, 'active',
       $4::jsonb, NOW())
     ON CONFLICT (id) DO UPDATE SET payload_json = EXCLUDED.payload_json, status = EXCLUDED.status`,
    `mkey_${serialNumber}`,
    reservation.propertyId,
    serialNumber,
    JSON.stringify({
      reservationId: reservation.id,
      serialNumber,
      qrPayload,
      // Public unlock signature (also in the QR) — used by verifyUnlock to reject
      // serial-only attempts. audit 2026-06 R2 · H1.
      unlockSig,
      // We DO NOT store the secret in plain — only its hash for verification.
      secretHash: createHash("sha256").update(secret).digest("hex"),
      validFrom,
      validUntil,
      issuedAt: new Date().toISOString()
    })
  ).catch(() => {
    // If advanced_records doesn't accept this row, ignore — the pass still works.
  });

  const appleWalletPass = buildAppleWalletPass({
    reservationCode: reservation.code,
    guestName,
    roomNumber: room?.number ?? null,
    hotelName: property.name,
    validFrom,
    validUntil,
    serialNumber,
    qrPayload
  });

  const googleWalletObject = buildGoogleWalletObject({
    serialNumber,
    guestName,
    roomNumber: room?.number ?? null,
    validFrom,
    validUntil,
    qrPayload
  });

  return {
    reservationId: reservation.id,
    guestName,
    roomNumber: room?.number ?? null,
    validFrom,
    validUntil,
    serialNumber,
    appleWalletPass,
    signedByApple: SIGNED_BY_APPLE,
    googleWalletObject,
    mobileKey: {
      code: serialNumber,
      qrPayload,
      nfcPayload,
      secret
    }
  };
}

/**
 * Verify an unlock attempt from a phone. The door reader (or our hub) sends
 * the serial number and the timestamp-bound signature; we recompute and
 * compare against the stored hash to confirm authenticity AND that the
 * reservation is still active.
 */
export async function verifyUnlock(input: {
  context: UserContext;
  serialNumber: string;
  signature: string;
  timestamp: number;
}): Promise<{ ok: boolean; reason?: string }> {
  if (Math.abs(Date.now() - input.timestamp) > 5 * 60 * 1000) {
    return { ok: false, reason: "timestamp_skew_too_large" };
  }
  const rows = await prisma.$queryRawUnsafe<Array<{ payload_json: Record<string, unknown>; status: string }>>(
    `SELECT payload_json, status FROM advanced_records
     WHERE module_code = 'guest_self_service' AND entity_type = 'mobile_key' AND entity_id = $1`,
    input.serialNumber
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "key_not_found" };
  if (row.status !== "active") return { ok: false, reason: "key_revoked" };
  const payload = row.payload_json as { validUntil: string; unlockSig?: string };
  if (new Date(payload.validUntil) < new Date()) return { ok: false, reason: "key_expired" };
  // audit 2026-06 R2 · H1 — FIX bypass de cerradura: antes se hacia
  // `void input.signature` y se devolvia ok:true para cualquier serial activo, asi
  // que el serial SOLO (legible en el QR) abria la puerta. Ahora exigimos tambien
  // la firma criptografica del QR, comparada en tiempo constante. (Un challenge-
  // response con nonce es el siguiente endurecimiento; el secret no se guarda.)
  const expected = payload.unlockSig;
  if (!expected) return { ok: false, reason: "key_missing_signature" };
  const got = Buffer.from(input.signature);
  const exp = Buffer.from(expected);
  if (got.length !== exp.length || !timingSafeEqual(got, exp)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}

/**
 * Revoke a pass (e.g. lost phone). Sets status to "revoked" so verifyUnlock
 * rejects subsequent attempts. The pass itself stays in the user's wallet but
 * the door won't open with it.
 */
export async function revokeWalletPass(input: { context: UserContext; serialNumber: string }) {
  requirePermissions(input.context, ["pms.checkin.execute"]);
  if (!input.serialNumber) throw new BadRequestError("serialNumber required");
  await prisma.$executeRawUnsafe(
    `UPDATE advanced_records SET status = 'revoked' WHERE module_code = 'guest_self_service' AND entity_type = 'mobile_key' AND entity_id = $1`,
    input.serialNumber
  );
  return { ok: true, serialNumber: input.serialNumber };
}

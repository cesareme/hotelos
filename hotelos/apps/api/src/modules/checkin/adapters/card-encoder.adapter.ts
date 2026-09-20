// Codificador de tarjetas RFID del kiosco (Tanda CHK · lote W3-C; diseño §2.4
// «llaves, modelo (a)»: tarjeta codificada desde el PMS con Salto Space,
// Assa Abloy Vostio Encoder 4010 o dormakaba Ambiance).
//
// Contrato + dos implementaciones sin proveedor (la clave real la pone César):
//   · noneCardEncoder — provider "none": encode() responde
//     { status: "unavailable", message: CARD_PICKUP_MESSAGE } («recoge tu tarjeta
//     en recepción»). Es la respuesta honesta cuando no hay codificador conectado
//     o no hay proveedor configurado: el kiosco muestra el mensaje y la
//     recepción entrega la tarjeta a mano.
//   · sandboxCardEncoder(provider) — mismo contrato con resultado determinista
//     { status: "encoded", cardId: "sandbox_<provider>_<id>" } para demos y
//     tests. El prefijo `sandbox_` del cardId declara que la tarjeta NO existe:
//     ninguna cerradura la abre. Solo se resuelve con mode "sandbox"
//     (adapters/index.ts); en producción sin proveedor real se usa none.
//
// Validación común: validFrom/validUntil son instantes ISO 8601 y la ventana
// tiene que ser positiva; una ventana inválida es un error de programación del
// llamador (lanza), no un «unavailable» para el huésped.

export const CARD_ENCODER_PROVIDERS = ["none", "salto_space", "assa_vostio", "dormakaba"] as const;
export type CardEncoderProvider = (typeof CARD_ENCODER_PROVIDERS)[number];

/** Mensaje que ve el huésped cuando el kiosco no puede codificar. */
export const CARD_PICKUP_MESSAGE = "Recoge tu tarjeta en recepción.";

export type CardEncodeInput = {
  roomNumber: string;
  /** Inicio de validez (ISO 8601). */
  validFrom: string;
  /** Fin de validez (ISO 8601); posterior a validFrom. */
  validUntil: string;
  /** Solo para trazabilidad del proveedor; opcional. */
  reservationId?: string;
};

export type CardEncodeResult =
  | { status: "encoded"; provider: Exclude<CardEncoderProvider, "none">; cardId: string; roomNumber: string; validUntil: string; encodedAt: string }
  | { status: "unavailable"; provider: CardEncoderProvider; message: string };

export type CardEncoder = {
  provider: CardEncoderProvider;
  encode(input: CardEncodeInput): Promise<CardEncodeResult>;
};

/** Lanza si la ventana de validez no es ISO o no es positiva. */
export function assertValidityWindow(input: { validFrom: string; validUntil: string }): void {
  const from = Date.parse(input.validFrom);
  const until = Date.parse(input.validUntil);
  if (!Number.isFinite(from) || !Number.isFinite(until)) throw new Error("Ventana de validez inválida: validFrom y validUntil deben ser fechas ISO 8601.");
  if (until <= from) throw new Error("Ventana de validez inválida: validUntil debe ser posterior a validFrom.");
}

function assertRoomNumber(roomNumber: string): void {
  if (typeof roomNumber !== "string" || roomNumber.trim().length === 0) throw new Error("Número de habitación vacío.");
}

/** Sin codificador: la tarjeta se entrega en recepción. */
export const noneCardEncoder: CardEncoder = Object.freeze({
  provider: "none" as const,
  encode: async (input: CardEncodeInput): Promise<CardEncodeResult> => {
    assertRoomNumber(input.roomNumber);
    assertValidityWindow(input);
    return { status: "unavailable", provider: "none", message: CARD_PICKUP_MESSAGE };
  }
});

export type SandboxCardEncoderDeps = {
  now?: () => Date;
  /** Sufijo del cardId (por defecto contador secuencial dentro del adaptador). */
  nextId?: () => string;
};

/** Codificador de demo: siempre «codifica» con un cardId `sandbox_…` que ninguna cerradura acepta. */
export function sandboxCardEncoder(provider: Exclude<CardEncoderProvider, "none"> = "salto_space", deps: SandboxCardEncoderDeps = {}): CardEncoder & { issued(): readonly string[] } {
  const now = deps.now ?? (() => new Date());
  let counter = 0;
  const nextId = deps.nextId ?? (() => String(++counter).padStart(4, "0"));
  const issued: string[] = [];
  return {
    provider,
    issued: () => issued,
    encode: async (input) => {
      assertRoomNumber(input.roomNumber);
      assertValidityWindow(input);
      const cardId = `sandbox_${provider}_${nextId()}`;
      issued.push(cardId);
      return { status: "encoded", provider, cardId, roomNumber: input.roomNumber, validUntil: input.validUntil, encodedAt: now().toISOString() };
    }
  };
}

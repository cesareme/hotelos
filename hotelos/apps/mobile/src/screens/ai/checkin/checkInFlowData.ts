export const checkInGuest = {
  name: "Maria Lopez Garcia",
  documentType: "DNI",
  documentNumber: "12345678X",
  nationality: "ES",
  dateOfBirth: "1986-04-18",
  reservationCode: "RES-18392",
  arrival: "2026-05-14",
  departure: "2026-05-16",
  roomNumber: "432",
  roomStatus: "clean inspected",
  balance: "EUR 0",
  missingFields: ["phone"],
  signatureRequired: true
};

export const checkInSteps = [
  { code: "voice", label: "Voice" },
  { code: "scan", label: "Scan" },
  { code: "ocr", label: "OCR" },
  { code: "match", label: "Match" },
  { code: "validate", label: "Validate" },
  { code: "confirm", label: "Confirm" },
  { code: "signature", label: "Signature" },
  { code: "success", label: "Done" }
] as const;

export type CheckInStepCode = (typeof checkInSteps)[number]["code"];

export const ocrFields = [
  { label: "First name", value: "Maria", confidence: 98 },
  { label: "Surname 1", value: "Lopez", confidence: 96 },
  { label: "Surname 2", value: "Garcia", confidence: 95 },
  { label: "Document", value: "DNI 12345678X", confidence: 94 },
  { label: "Nationality", value: "ES", confidence: 99 },
  { label: "Date of birth", value: "1986-04-18", confidence: 92 },
  { label: "Phone", value: "Missing", confidence: 0 }
];

export const checkInAuditEvents = [
  { action: "VOICE_COMMAND_CAPTURED", actorType: "user", createdAt: "15:42:00" },
  { action: "OCR_FIELDS_EXTRACTED", actorType: "system", createdAt: "15:42:08" },
  { action: "ID_IMAGE_DISCARDED", actorType: "system", createdAt: "15:42:09" },
  { action: "RESERVATION_MATCH_PREVIEWED", actorType: "ai", createdAt: "15:42:12" },
  { action: "ROOM_ASSIGNMENT_VALIDATED", actorType: "system", createdAt: "15:42:13" }
];

export const checkInExecutionActions = [
  "Save required guest data",
  "Request guest register signature",
  "Check in reservation",
  "Mark room 432 occupied",
  "Queue SES.HOSPEDAJES submission",
  "Send welcome message",
  "Write audit chain"
];

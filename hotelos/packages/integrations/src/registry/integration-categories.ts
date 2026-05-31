export type IntegrationCategoryCode =
  | "otas"
  | "channel_managers"
  | "payment_gateways"
  | "electronic_locks"
  | "checkin_kiosks"
  | "guest_messaging"
  | "accounting_software"
  | "einvoicing_providers"
  | "government_compliance"
  | "document_ocr"
  | "rms_revenue"
  | "crm"
  | "guest_experience"
  | "metasearch"
  | "email_marketing"
  | "pos"
  | "telephony"
  | "energy_iot";

export type IntegrationCategoryManifest = {
  code: IntegrationCategoryCode;
  name: string;
  description: string;
};

export const INTEGRATION_CATEGORIES: IntegrationCategoryManifest[] = [
  { code: "otas", name: "OTAs", description: "Reservation demand channels." },
  { code: "channel_managers", name: "Channel Managers", description: "Availability, rates and restrictions distribution." },
  { code: "payment_gateways", name: "Payment Gateways", description: "Payment links, tokenization and capture." },
  { code: "electronic_locks", name: "Electronic Locks", description: "Guest key creation and room access." },
  { code: "checkin_kiosks", name: "Check-in Kiosks", description: "Lobby self-service check-in hardware." },
  { code: "guest_messaging", name: "Guest Messaging", description: "WhatsApp, email, SMS and web chat." },
  { code: "accounting_software", name: "Accounting Software", description: "External bookkeeping and accounting sync." },
  { code: "einvoicing_providers", name: "E-invoicing Providers", description: "Structured invoice delivery and status events." },
  { code: "government_compliance", name: "Government Compliance", description: "Authority submissions and legal reporting." },
  { code: "document_ocr", name: "Document OCR", description: "Document extraction providers for compliant workflows." },
  { code: "rms_revenue", name: "RMS / Revenue", description: "Revenue management and price recommendations." },
  { code: "crm", name: "CRM", description: "Guest relationship and marketing data." },
  { code: "guest_experience", name: "Guest Experience", description: "Surveys, upsells and stay experiences." },
  { code: "metasearch", name: "Metasearch", description: "Metasearch campaign and booking traffic channels." },
  { code: "email_marketing", name: "Email Marketing", description: "Campaigns and transactional email." },
  { code: "pos", name: "POS", description: "Restaurant, bar, spa and shop integrations." },
  { code: "telephony", name: "Telephony", description: "Phone and call-center systems." },
  { code: "energy_iot", name: "Energy / IoT", description: "Energy, sensors and building automation." }
];

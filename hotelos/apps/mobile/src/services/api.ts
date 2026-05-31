import type {
  ChatAttachment,
  ChatAttachmentDraft,
  CheckInFromScanRequest,
  CheckInFromScanResponse,
  ConfirmationCard,
  DashboardSnapshot
} from "@hotelos/shared";

const API_URL = "http://localhost:3000";

const fallbackCard: ConfirmationCard = {
  title: "Confirm check-in",
  summary: "Ready to check in Maria Lopez Garcia to room 432.",
  reservation: {
    code: "RES-18392",
    arrival: "2026-05-14",
    departure: "2026-05-16",
    balanceDue: 0
  },
  room: {
    number: "432",
    status: "clean_inspected",
    maintenanceBlock: false
  },
  guestRegister: {
    missingFields: ["phone"],
    signatureRequired: true
  },
  warnings: ["Phone number is missing. Ask guest before confirming."],
  actions: [
    "Save required guest data",
    "Request signature",
    "Check in reservation",
    "Mark room occupied",
    "Queue authority submission",
    "Send welcome message"
  ]
};

export async function getDashboardSnapshot(): Promise<DashboardSnapshot> {
  try {
    const response = await fetch(`${API_URL}/properties/prop_123/dashboard`);
    if (!response.ok) {
      throw new Error("Dashboard request failed.");
    }

    return (await response.json()) as DashboardSnapshot;
  } catch {
    return {
      arrivalsToday: 26,
      departuresToday: 18,
      roomsDirty: 9,
      roomsCleanInspected: 31,
      roomsOutOfOrder: 2,
      openMaintenanceTasks: 7,
      guestMessages: 12,
      unpaidBalances: 3420,
      failedComplianceRecords: 1,
      todayRevenue: 12840,
      aiDailyBriefing:
        "Occupancy is 84%. Four rooms are not ready for arrival and one SES.HOSPEDAJES record needs review."
    };
  }
}

export async function requestCheckInFromScan(request: CheckInFromScanRequest): Promise<CheckInFromScanResponse> {
  try {
    const response = await fetch(`${API_URL}/ai/commands/check-in-from-scan`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      throw new Error("Check-in command failed.");
    }

    return (await response.json()) as CheckInFromScanResponse;
  } catch {
    return {
      status: "confirmation_required",
      confirmationId: "conf_demo",
      card: fallbackCard
    };
  }
}

export async function executeCheckInConfirmation(confirmationId: string): Promise<{ status: string }> {
  try {
    const response = await fetch(`${API_URL}/ai/confirmations/${confirmationId}/execute`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ signatureObjectKey: "sig_mobile_demo" })
    });

    if (!response.ok) {
      throw new Error("Confirmation failed.");
    }

    return (await response.json()) as { status: string };
  } catch {
    return { status: "executed" };
  }
}

export type MobileReservation = {
  id: string;
  code: string;
  status: string;
  arrivalDate: string;
  departureDate: string;
  assignedRoomId?: string;
  totalAmount: number;
  currency: string;
};

export type MobileRoom = {
  id: string;
  number: string;
  status: string;
  housekeepingStatus: string;
  maintenanceStatus: string;
  sellable: boolean;
};

export type MobileFolio = {
  folio: { id: string; status: string; currency: string };
  chargesTotal: number;
  paymentsTotal: number;
  balanceDue: number;
};

export async function getPmsSnapshot(): Promise<{
  reservations: MobileReservation[];
  rooms: MobileRoom[];
  folio: MobileFolio;
}> {
  try {
    const [reservationsResponse, roomsResponse, folioResponse] = await Promise.all([
      fetch(`${API_URL}/properties/prop_123/reservations`),
      fetch(`${API_URL}/properties/prop_123/rooms`),
      fetch(`${API_URL}/reservations/res_18392/folio`)
    ]);

    if (!reservationsResponse.ok || !roomsResponse.ok || !folioResponse.ok) {
      throw new Error("PMS snapshot failed.");
    }

    return {
      reservations: (await reservationsResponse.json()) as MobileReservation[],
      rooms: (await roomsResponse.json()) as MobileRoom[],
      folio: (await folioResponse.json()) as MobileFolio
    };
  } catch {
    return {
      reservations: [
        {
          id: "res_18392",
          code: "RES-18392",
          status: "confirmed",
          arrivalDate: "2026-05-14",
          departureDate: "2026-05-16",
          assignedRoomId: "room_432",
          totalAmount: 272,
          currency: "EUR"
        }
      ],
      rooms: [
        {
          id: "room_432",
          number: "432",
          status: "inspected",
          housekeepingStatus: "inspected",
          maintenanceStatus: "ok",
          sellable: true
        },
        {
          id: "room_108",
          number: "108",
          status: "out_of_order",
          housekeepingStatus: "dirty",
          maintenanceStatus: "blocked",
          sellable: false
        }
      ],
      folio: {
        folio: { id: "folio_18392", status: "open", currency: "EUR" },
        chargesTotal: 272,
        paymentsTotal: 272,
        balanceDue: 0
      }
    };
  }
}

export type MobileHousekeepingBoardItem = {
  room: MobileRoom;
  tasks: Array<{
    id: string;
    taskType: string;
    priority: string;
    status: string;
  }>;
};

export type MobileWorkOrder = {
  id: string;
  title: string;
  roomId?: string;
  priority: string;
  status: string;
  blocksRoom: boolean;
};

export async function getOperationsSnapshot(): Promise<{
  housekeeping: MobileHousekeepingBoardItem[];
  workOrders: MobileWorkOrder[];
}> {
  try {
    const [housekeepingResponse, workOrdersResponse] = await Promise.all([
      fetch(`${API_URL}/properties/prop_123/housekeeping/board`),
      fetch(`${API_URL}/properties/prop_123/work-orders`)
    ]);

    if (!housekeepingResponse.ok || !workOrdersResponse.ok) {
      throw new Error("Operations snapshot failed.");
    }

    return {
      housekeeping: (await housekeepingResponse.json()) as MobileHousekeepingBoardItem[],
      workOrders: (await workOrdersResponse.json()) as MobileWorkOrder[]
    };
  } catch {
    return {
      housekeeping: [
        {
          room: {
            id: "room_432",
            number: "432",
            status: "inspected",
            housekeepingStatus: "inspected",
            maintenanceStatus: "ok",
            sellable: true
          },
          tasks: []
        },
        {
          room: {
            id: "room_108",
            number: "108",
            status: "out_of_order",
            housekeepingStatus: "dirty",
            maintenanceStatus: "blocked",
            sellable: false
          },
          tasks: [{ id: "hkt_blocked_108", taskType: "deep_clean", priority: "high", status: "pending" }]
        }
      ],
      workOrders: [
        {
          id: "wo_108_leak",
          title: "Bathroom leak",
          roomId: "room_108",
          priority: "urgent",
          status: "open",
          blocksRoom: true
        }
      ]
    };
  }
}

export type MobileAccountingSnapshot = {
  accounts: Array<{ code: string; name: string; accountType: string }>;
  supplierBills: Array<{ id: string; supplierName: string; total: number; status: string; suggestedAccountCode?: string }>;
  journalEntries: Array<{ id: string; sourceType: string; status: string }>;
};

export async function getAccountingSnapshot(): Promise<MobileAccountingSnapshot> {
  try {
    const [accountsResponse, supplierBillsResponse, journalEntriesResponse] = await Promise.all([
      fetch(`${API_URL}/organizations/org_123/accounts`),
      fetch(`${API_URL}/properties/prop_123/supplier-bills`),
      fetch(`${API_URL}/organizations/org_123/journal-entries`)
    ]);

    if (!accountsResponse.ok || !supplierBillsResponse.ok || !journalEntriesResponse.ok) {
      throw new Error("Accounting snapshot failed.");
    }

    return {
      accounts: (await accountsResponse.json()) as MobileAccountingSnapshot["accounts"],
      supplierBills: (await supplierBillsResponse.json()) as MobileAccountingSnapshot["supplierBills"],
      journalEntries: (await journalEntriesResponse.json()) as MobileAccountingSnapshot["journalEntries"]
    };
  } catch {
    return {
      accounts: [
        { code: "430", name: "Clientes", accountType: "asset" },
        { code: "572", name: "Bancos", accountType: "asset" },
        { code: "622", name: "Repairs and maintenance", accountType: "expense" }
      ],
      supplierBills: [
        {
          id: "sb_demo",
          supplierName: "HVAC Madrid SL",
          total: 480,
          status: "draft",
          suggestedAccountCode: "622"
        }
      ],
      journalEntries: [{ id: "je_demo", sourceType: "payment", status: "draft" }]
    };
  }
}

export type MobileComplianceIssue = {
  status: string;
  issue: string;
  recordId?: string;
};

export type MobileGuestRegisterRecord = {
  id: string;
  status: string;
  retentionUntil: string;
};

export type MobileSesSubmission = {
  id: string;
  status: string;
  submissionType: string;
  errorMessage?: string;
};

export async function getComplianceSnapshot(): Promise<{
  issues: MobileComplianceIssue[];
  records: MobileGuestRegisterRecord[];
  submissions: MobileSesSubmission[];
}> {
  try {
    const [issuesResponse, recordsResponse, submissionsResponse] = await Promise.all([
      fetch(`${API_URL}/properties/prop_123/compliance/inbox`),
      fetch(`${API_URL}/properties/prop_123/guest-register-records`),
      fetch(`${API_URL}/properties/prop_123/ses-hospedajes/submissions`)
    ]);

    if (!issuesResponse.ok || !recordsResponse.ok || !submissionsResponse.ok) {
      throw new Error("Compliance snapshot failed.");
    }

    return {
      issues: (await issuesResponse.json()) as MobileComplianceIssue[],
      records: (await recordsResponse.json()) as MobileGuestRegisterRecord[],
      submissions: (await submissionsResponse.json()) as MobileSesSubmission[]
    };
  } catch {
    return {
      issues: [
        {
          status: "needs_human_review",
          issue: "Guest in room 432 missing phone number.",
          recordId: "grr_demo"
        }
      ],
      records: [{ id: "grr_demo", status: "draft", retentionUntil: "2029-05-14T00:00:00.000Z" }],
      submissions: [{ id: "ses_demo", status: "queued", submissionType: "checkin" }]
    };
  }
}

export type MobileConversation = {
  id: string;
  channel: string;
  status: string;
  aiEnabled: boolean;
};

export type MobileMessage = {
  id: string;
  senderType: string;
  body: string;
  sentAt: string;
  attachments?: ChatAttachment[];
};

export async function getConciergeSnapshot(): Promise<{
  conversations: MobileConversation[];
  messages: MobileMessage[];
  aiDraft: { disclosure: string; draft: string; requiresHumanReview: boolean };
}> {
  try {
    const conversationsResponse = await fetch(`${API_URL}/properties/prop_123/conversations`);
    if (!conversationsResponse.ok) {
      throw new Error("Conversations failed.");
    }

    const conversations = (await conversationsResponse.json()) as MobileConversation[];
    const conversationId = conversations[0]?.id ?? "conv_maria";
    const [messagesResponse, draftResponse] = await Promise.all([
      fetch(`${API_URL}/conversations/${conversationId}/messages`),
      fetch(`${API_URL}/conversations/${conversationId}/ai-draft`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ guestQuestion: "Do you have parking?" })
      })
    ]);

    if (!messagesResponse.ok || !draftResponse.ok) {
      throw new Error("Concierge details failed.");
    }

    return {
      conversations,
      messages: (await messagesResponse.json()) as MobileMessage[],
      aiDraft: (await draftResponse.json()) as { disclosure: string; draft: string; requiresHumanReview: boolean }
    };
  } catch {
    return {
      conversations: [{ id: "conv_maria", channel: "app", status: "open", aiEnabled: true }],
      messages: [
        {
          id: "msg_maria_parking",
          senderType: "guest",
          body: "Do you have parking?",
          sentAt: "2026-05-14T09:31:00.000Z",
          attachments: []
        }
      ],
      aiDraft: {
        disclosure:
          "Hi, I'm the hotel's AI assistant. I can help with availability, bookings, hotel information, and service requests. A staff member can take over whenever needed.",
        draft:
          "Hi, I'm the hotel's AI assistant. I can help with availability, bookings, hotel information, and service requests. A staff member can take over whenever needed.\n\nParking is available on request. Reception can confirm availability and add it to your reservation.",
        requiresHumanReview: false
      }
    };
  }
}

export async function sendConciergeMessage(
  conversationId: string,
  input: {
    body: string;
    attachments?: ChatAttachmentDraft[];
  }
): Promise<MobileMessage> {
  try {
    const response = await fetch(`${API_URL}/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: input.body,
        senderType: "staff",
        language: "en",
        attachments: input.attachments ?? []
      })
    });

    if (!response.ok) {
      throw new Error("Message send failed.");
    }

    return (await response.json()) as MobileMessage;
  } catch {
    return {
      id: `msg_local_${Date.now()}`,
      senderType: "staff",
      body: input.body,
      sentAt: new Date().toISOString(),
      attachments: (input.attachments ?? []).map((attachment, index) => ({
        id: `att_local_${index}`,
        attachmentType: attachment.attachmentType,
        objectKey: attachment.objectKey,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        durationMs: attachment.durationMs,
        width: attachment.width,
        height: attachment.height,
        privacyReviewRequired: attachment.privacyReviewRequired,
        createdAt: new Date().toISOString()
      }))
    };
  }
}

export type MobileAsset = {
  id: string;
  roomId?: string;
  assetType: string;
  name: string;
  warrantyUntil?: string;
  status: string;
};

export type MobileCapexProject = {
  id: string;
  name: string;
  budget: number;
  status: string;
};

export type MobileRoomProfitability = {
  roomId: string;
  roomNumber: string;
  revenue: number;
  maintenanceCost: number;
  capexPlanned: number;
  profitContribution: number;
};

export type MobileOwnerSnapshot = {
  occupancy: number;
  adr: number;
  revpar: number;
  cashCollected: number;
  debtors: number;
  maintenanceCost: number;
  roomsBlocked: number;
  capexProjects: number;
  complianceIssues: number;
  aiOwnerBriefing: string;
};

export async function getOwnerSnapshot(): Promise<MobileOwnerSnapshot> {
  try {
    const response = await fetch(`${API_URL}/properties/prop_123/owner-dashboard`);
    if (!response.ok) {
      throw new Error("Owner dashboard failed.");
    }

    return (await response.json()) as MobileOwnerSnapshot;
  } catch {
    return {
      occupancy: 84,
      adr: 136,
      revpar: 114,
      cashCollected: 12840,
      debtors: 3420,
      maintenanceCost: 1200,
      roomsBlocked: 2,
      capexProjects: 3,
      complianceIssues: 1,
      aiOwnerBriefing:
        "Room 432 has repeated AC complaints. Inspect HVAC before approving fourth floor capex."
    };
  }
}

export async function getAssetsSnapshot(): Promise<{
  assets: MobileAsset[];
  capex: MobileCapexProject[];
  profitability: MobileRoomProfitability[];
}> {
  try {
    const [assetsResponse, capexResponse, profitabilityResponse] = await Promise.all([
      fetch(`${API_URL}/properties/prop_123/assets`),
      fetch(`${API_URL}/properties/prop_123/capex`),
      fetch(`${API_URL}/properties/prop_123/room-profitability`)
    ]);

    if (!assetsResponse.ok || !capexResponse.ok || !profitabilityResponse.ok) {
      throw new Error("Assets snapshot failed.");
    }

    return {
      assets: (await assetsResponse.json()) as MobileAsset[],
      capex: (await capexResponse.json()) as MobileCapexProject[],
      profitability: (await profitabilityResponse.json()) as MobileRoomProfitability[]
    };
  } catch {
    return {
      assets: [
        {
          id: "asset_hvac_432",
          roomId: "room_432",
          assetType: "hvac",
          name: "Room 432 HVAC",
          warrantyUntil: "2027-06-30",
          status: "needs_attention"
        }
      ],
      capex: [{ id: "capex_renovation_432", name: "Fourth floor refresh", budget: 18000, status: "proposed" }],
      profitability: [
        {
          roomId: "room_432",
          roomNumber: "432",
          revenue: 272,
          maintenanceCost: 180,
          capexPlanned: 1200,
          profitContribution: 92
        }
      ]
    };
  }
}

export type MobileProperty = {
  id: string;
  name: string;
  timezone: string;
  taxRegion?: string;
  sesHospedajesEnabled: boolean;
  verifactuEnabled: boolean;
};

export type MobileNotification = {
  id: string;
  type: string;
  title: string;
  body: string;
  status: string;
  createdAt: string;
};

export type MobileSecuritySettings = {
  mfaEnabled: boolean;
  activeSessions: number;
  registeredDevices: number;
  sensitiveRolesRequireMfa: string[];
};

export async function loginDemo(): Promise<{ token: string; property: MobileProperty }> {
  try {
    const response = await fetch(`${API_URL}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "reception@example.com",
        password: "demo-password",
        deviceId: "dev_reception_1"
      })
    });

    if (!response.ok) {
      throw new Error("Login failed.");
    }

    return (await response.json()) as { token: string; property: MobileProperty };
  } catch {
    return {
      token: "demo.jwt.token",
      property: {
        id: "prop_123",
        name: "HotelOS Madrid Centro",
        timezone: "Europe/Madrid",
        taxRegion: "Madrid",
        sesHospedajesEnabled: true,
        verifactuEnabled: true
      }
    };
  }
}

export async function getAppShellSnapshot(): Promise<{
  properties: MobileProperty[];
  notifications: MobileNotification[];
  security: MobileSecuritySettings;
}> {
  try {
    const [propertiesResponse, notificationsResponse, securityResponse] = await Promise.all([
      fetch(`${API_URL}/users/me/properties`),
      fetch(`${API_URL}/notifications`),
      fetch(`${API_URL}/settings/security`)
    ]);

    if (!propertiesResponse.ok || !notificationsResponse.ok || !securityResponse.ok) {
      throw new Error("App shell snapshot failed.");
    }

    return {
      properties: (await propertiesResponse.json()) as MobileProperty[],
      notifications: (await notificationsResponse.json()) as MobileNotification[],
      security: (await securityResponse.json()) as MobileSecuritySettings
    };
  } catch {
    return {
      properties: [
        {
          id: "prop_123",
          name: "HotelOS Madrid Centro",
          timezone: "Europe/Madrid",
          taxRegion: "Madrid",
          sesHospedajesEnabled: true,
          verifactuEnabled: true
        },
        {
          id: "prop_456",
          name: "HotelOS Costa",
          timezone: "Europe/Madrid",
          taxRegion: "Andalucia",
          sesHospedajesEnabled: true,
          verifactuEnabled: false
        }
      ],
      notifications: [
        {
          id: "notif_compliance_phone",
          type: "compliance",
          title: "Missing guest phone",
          body: "Guest register for RES-18392 is missing a phone number.",
          status: "unread",
          createdAt: "2026-05-14T09:20:00.000Z"
        },
        {
          id: "notif_maintenance_108",
          type: "maintenance",
          title: "Room 108 blocked",
          body: "Bathroom leak work order is open and blocks inventory.",
          status: "unread",
          createdAt: "2026-05-14T08:30:00.000Z"
        }
      ],
      security: {
        mfaEnabled: true,
        activeSessions: 1,
        registeredDevices: 1,
        sensitiveRolesRequireMfa: ["owner", "manager", "accountant", "admin"]
      }
    };
  }
}

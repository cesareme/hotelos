# AI Tool Contracts

## Contract

Every tool follows:

```ts
type AiTool<Input, Output> = {
  name: string;
  description: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  requiredPermissions: string[];
  inputSchema: ZodSchema<Input>;
  outputSchema: ZodSchema<Output>;
  requiresConfirmation: boolean;
  execute(input: Input, context: ToolContext): Promise<Output>;
};
```

Tool context:

```ts
type ToolContext = {
  organizationId: string;
  propertyId: string;
  userId: string;
  deviceId?: string;
  locale: string;
  source: "voice" | "text" | "image" | "chat" | "system";
  auditCorrelationId: string;
  permissions: PermissionKey[];
};
```

## Gateway Rules

- Parse voice, text, image, chat, and mixed input into `AiIntent`.
- Never import database packages.
- Never execute SQL.
- Call typed API tools only.
- Store `ai_tool_calls` through API execution paths.
- Ask for confirmation for medium, high, and critical sensitive actions according to the risk matrix.

## Implemented First

- `matchGuestToReservation`
- `validateRoomAssignment`
- `checkGuestRegisterCompleteness`
- `checkInReservation`
- `queueSesHospedajesSubmission`
- `sendGuestMessage`

The gateway parser recognizes:

- `CHECK_IN_GUEST`
- `CREATE_MAINTENANCE_WORK_ORDER`
- `ASSIGN_ROOM`
- `QUOTE_AVAILABILITY`
- fallback `ASK_DASHBOARD_QUESTION`

## Text Command Endpoint

`POST /ai/commands/text`

Implemented gateway behaviors:

- "Show today's arrivals" calls the API reservation list and returns live arrivals for the business date.
- "Create maintenance task for room 432" calls the API work-order endpoint. It does not block the room unless a later confirmation path grants the required approval.
- "Assign room 432 to reservation RES-1" returns `confirmation_required`; the gateway does not call the direct assignment endpoint.
- Availability requests require dates. Once dates are supplied, the gateway calls the PMS quote endpoint and returns only backend-provided availability, price, and policy data.

## Safety Evaluator

`packages/ai-tools/src/safety.ts` centralizes the refusal/escalation matrix:

- Reject storing ID images.
- Reject check-in when required guest register fields are missing.
- Reject assigning blocked rooms.
- Reject invoice issue with invalid tax configuration.
- Reject booking quotes when prices did not come from the availability tool.
- Escalate high-value refunds and penalty overrides.
- Keep accounting posts gated by accountant/high-risk permission.

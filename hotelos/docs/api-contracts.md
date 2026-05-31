# API Contracts

## Route Permissions

API edge permissions are declared in `apps/api/src/security/route-permissions.ts` and enforced by a Fastify `preHandler`.

- Every mutating `POST` and `PATCH` route must have a manifest entry.
- `DELETE` routes are also manifest-protected when used for connection or lifecycle changes.
- High-risk operational actions name the same permissions as the service layer.
- Critical actions such as refunds, invoice issue/cancel, journal posting, room blocking, and AI confirmation execution require high-risk or role-specific permissions.
- The manifest is additive to service-level validation; backend tools still validate business rules, property scope, confirmations, and audit events.

## Audit Integrity

Audit events and domain events are append-only records sealed by a SHA-256 hash chain in `apps/api/src/modules/audit/audit.service.ts`.

- Each audit record stores `hashAlgorithm`, `previousHash`, and `currentHash`.
- Each domain event stores the same fields so event replay can detect tampering or gaps.
- `/audit-events/integrity` and `/events/integrity` recompute the chain and return the first broken record if verification fails.
- Application code records audit/domain events through `recordAuditEvent` and `recordDomainEvent`; there are no update or delete APIs for audit records.

## Auth

`POST /auth/login`

```json
{
  "email": "reception@example.com",
  "password": "secret",
  "deviceId": "dev_reception_1"
}
```

Returns a demo token, user context, property, and writes `AUTH_LOGIN`.

Additional app-shell and security endpoints:

- `POST /auth/register-device`
- `GET /auth/sessions`
- `POST /auth/sessions/:id/revoke`
- `POST /auth/mfa/challenge`
- `POST /auth/mfa/verify`
- `GET /users/me/properties`
- `GET /properties`
- `GET /notifications`
- `POST /notifications/:id/read`
- `GET /settings/security`

Sensitive roles require MFA policy coverage: owner, manager, accountant, and admin. Session revocation and device registration write audit events.

## Offline Sync

- `POST /offline/sync`
- `GET /properties/:propertyId/offline-sync-records`

Allowed offline action types:

- `housekeeping.room.clean`
- `housekeeping.task.create`
- `housekeeping.task.update`
- `housekeeping.note.create`
- `maintenance.work_order.draft`
- `maintenance.photo.pending_upload`
- `voice.command.draft`
- `confirmation.status.cache`

Rejected offline action types:

- `invoice.issue`
- `reservation.check_in.final`, unless a future explicit property policy enables it

Every accepted, rejected, or conflicted offline action is persisted as an offline sync record and audit event.

## Dashboard

`GET /properties/:propertyId/dashboard`

Returns arrivals, departures, room readiness, maintenance, messages, unpaid balances, failed compliance count, revenue, and AI briefing.

## PMS

- `GET /properties/:propertyId/rooms`
- `POST /properties/:propertyId/rooms`
- `GET /properties/:propertyId/room-types`
- `POST /properties/:propertyId/availability/quote`
- `GET /properties/:propertyId/reservations`
- `POST /properties/:propertyId/reservations`
- `GET /reservations/:id`
- `PATCH /reservations/:id`
- `POST /reservations/:id/assign-room`
- `POST /reservations/:id/check-in`
- `POST /reservations/:id/check-out`
- `POST /reservations/:id/cancel`
- `POST /reservations/:id/no-show`

Every mutation writes an audit event. Reservation create, room assign, check-in, check-out, cancel, and no-show also write domain events.

Availability quotes return only room types, availability, prices, and policies calculated by the backend tool.

## Folios And Payments

- `GET /reservations/:id/folio`
- `POST /folios/:id/lines`
- `POST /folios/:id/payments`
- `POST /payments/:id/refund`
- `POST /folios/:id/close`

Refunds require `payment.refund` and `ai.high_risk.confirm`. Closing a folio requires a zero balance.

## Invoicing

- `GET /properties/:propertyId/invoices`
- `POST /invoices/drafts`
- `PATCH /invoices/:id`
- `POST /invoices/:id/issue`
- `POST /invoices/:id/cancel`
- `POST /invoices/:id/rectifying`

Issued invoices cannot be destructively edited. Corrections use cancellation or rectifying invoice workflows. Issue creates VERI*FACTU hash and QR payload placeholders.

## Accounting

- `GET /organizations/:organizationId/accounts`
- `GET /organizations/:organizationId/journal-entries`
- `POST /journal-entries/drafts`
- `POST /journal-entries/:id/post`
- `GET /properties/:propertyId/supplier-bills`
- `POST /supplier-bills/drafts`

Journal drafts must balance before they are accepted. Posting requires accountant/high-risk approval permissions.

## Assisted Check-In

`POST /ai/commands/check-in-from-scan`

```json
{
  "propertyId": "prop_123",
  "transcript": "check in this customer in room 432",
  "roomNumber": "432",
  "documentExtractedFields": {
    "firstName": "Maria",
    "surname1": "Lopez",
    "surname2": "Garcia",
    "documentType": "DNI",
    "documentNumber": "12345678X",
    "nationality": "ES",
    "dateOfBirth": "1986-04-18"
  },
  "documentImageStored": false,
  "idImageDiscarded": true
}
```

Returns `confirmation_required` with a confirmation card, or `rejected` with errors.

`POST /ai/confirmations/:confirmationId/execute`

```json
{
  "signatureObjectKey": "sig_guest_123"
}
```

Executes check-in, marks room occupied, signs guest register record, queues SES.HOSPEDAJES, queues welcome message, and writes audit/domain events.

## Operations

- `GET /properties/:propertyId/housekeeping/board`
- `POST /housekeeping/tasks`
- `PATCH /housekeeping/tasks/:id`
- `POST /housekeeping/tasks/:id/photo`
- `POST /rooms/:id/mark-clean`
- `POST /rooms/:id/mark-inspected`
- `GET /properties/:propertyId/work-orders`
- `POST /work-orders`
- `PATCH /work-orders/:id`
- `POST /work-orders/:id/media`
- `POST /work-orders/:id/block-room`
- `POST /work-orders/:id/resolve`

Checkout creates a departure-clean task when the reservation has an assigned room. Blocking a room for maintenance requires high-risk confirmation permission.

## Messaging And Concierge

- `GET /properties/:propertyId/conversations`
- `GET /conversations/:id/messages`
- `POST /conversations/:id/messages`
- `POST /conversations/:id/ai-draft`
- `POST /service-requests`
- `PATCH /service-requests/:id`

AI guest reply drafts include the guest-facing AI disclosure before substantive help text. Service requests can route towels/cleaning to housekeeping and maintenance issues to maintenance.

`POST /conversations/:id/messages` accepts `body`, optional `language`, and `attachments`. Attachments are typed as `photo`, `camera_photo`, `file`, or `voice_note`, must include an object-storage key and MIME type, and are written into the audit/event payload as attachment metadata. Voice notes require `durationMs`; files require `fileName`; photos and camera photos are marked for privacy review. Identity-document scans are excluded from chat attachments and must use the guest-register scan flow.

## Product Modules

- `GET /modules/catalog`
- `GET /modules/:moduleCode/dependencies`
- `GET /properties/:propertyId/modules`
- `PATCH /properties/:propertyId/modules/:moduleCode/enable`
- `PATCH /properties/:propertyId/modules/:moduleCode/disable`

PMS Core is enabled by default and cannot be disabled. Optional modules validate dependencies before enablement. Module enable and disable operations write `ModuleEnabled` and `ModuleDisabled` audit and domain events.

## Integration Marketplace

- `GET /integrations/categories`
- `GET /integrations/providers`
- `GET /properties/:propertyId/integrations`
- `POST /properties/:propertyId/integrations/:providerCode/connect`
- `PATCH /properties/:propertyId/integrations/:connectionId`
- `DELETE /properties/:propertyId/integrations/:connectionId`
- `POST /properties/:propertyId/integrations/:connectionId/test`
- `GET /properties/:propertyId/integrations/:connectionId/events`

Integration connection config may include only operational settings. Credentials are stored in a secret manager and referenced through `credentialsSecretRef`; plaintext credentials are rejected.

## Real Estate, Assets, And Owner Dashboard

- `GET /properties/:propertyId/assets`
- `POST /assets`
- `PATCH /assets/:id`
- `GET /properties/:propertyId/fixed-assets`
- `GET /properties/:propertyId/room-profitability`
- `GET /properties/:propertyId/owner-dashboard`
- `GET /properties/:propertyId/capex`
- `POST /capex-projects`
- `PATCH /capex-projects/:id`
- `POST /capex-projects/:id/items`

Capex approval requires `asset.capex.approve`. Room profitability rolls up reservation revenue, maintenance cost signals, and planned capex.

## Compliance

- `GET /properties/:propertyId/compliance/inbox`
- `GET /properties/:propertyId/guest-register-records`
- `POST /guest-register-records/:id/sign`
- `PATCH /guest-register-records/:id/correct`
- `POST /guest-register-records/:id/queue-ses`
- `GET /properties/:propertyId/ses-hospedajes/submissions`
- `PATCH /ses-hospedajes/submissions/:id/status`
- `GET /audit-events`
- `GET /events`
- `GET /ai/tool-calls`

Guest register records retain required extracted fields and signature references, not ID images. Failed SES records can be corrected and requeued with audit events.

## Back Office

- `GET /backoffice/properties/:propertyId/dashboard`
- `GET /backoffice/properties/:propertyId/setup`
- `PATCH /backoffice/properties/:propertyId/setup/:stepCode`
- `GET /backoffice/properties/:propertyId/readiness`
- `POST /backoffice/properties/:propertyId/readiness/recalculate`
- `POST /backoffice/properties/:propertyId/go-live`
- `GET /backoffice/properties/:propertyId/map`
- `POST /backoffice/properties/:propertyId/buildings`
- `POST /backoffice/properties/:propertyId/floors`
- `POST /backoffice/properties/:propertyId/zones`
- `POST /backoffice/properties/:propertyId/spaces`
- `POST /backoffice/properties/:propertyId/map-positions`
- `POST /backoffice/properties/:propertyId/rooms/bulk`
- `PATCH /backoffice/properties/:propertyId/rooms/bulk`
- `GET /backoffice/properties/:propertyId/property-map/export`
- `GET /backoffice/properties/:propertyId/room-types`
- `POST /backoffice/properties/:propertyId/room-types`
- `PATCH /backoffice/properties/:propertyId/room-types/:roomTypeId`
- `POST /backoffice/properties/:propertyId/room-types/:roomTypeId/deactivate`
- `POST /backoffice/properties/:propertyId/room-types/:roomTypeId/merge`
- `GET /backoffice/room-types/:roomTypeId/rooms`
- `GET /backoffice/properties/:propertyId/room-features`
- `POST /backoffice/properties/:propertyId/room-features`
- `GET /backoffice/properties/:propertyId/bed-types`
- `POST /backoffice/properties/:propertyId/bed-types`
- `POST /backoffice/properties/:propertyId/imports/property-map/preview`
- `POST /backoffice/properties/:propertyId/imports/property-map/commit`
- `GET /backoffice/properties/:propertyId/imports/:importId`
- `GET /backoffice/properties/:propertyId/modules`
- `PATCH /backoffice/properties/:propertyId/modules/:moduleCode`
- `GET /backoffice/properties/:propertyId/modules/:moduleCode/configuration`
- `PATCH /backoffice/properties/:propertyId/modules/:moduleCode/configuration`
- `GET /backoffice/properties/:propertyId/modules/:moduleCode/health`
- `POST /backoffice/properties/:propertyId/modules/:moduleCode/recalculate-health`
- `GET /backoffice/properties/:propertyId/departments`
- `POST /backoffice/properties/:propertyId/departments`
- `POST /backoffice/properties/:propertyId/departments/:departmentId/users`
- `GET /backoffice/properties/:propertyId/housekeeping-settings`
- `POST /backoffice/properties/:propertyId/housekeeping-sections`
- `POST /backoffice/properties/:propertyId/housekeeping-sections/:sectionId/rooms`
- `PATCH /backoffice/properties/:propertyId/housekeeping-rules/:ruleCode`
- `GET /backoffice/properties/:propertyId/maintenance-settings`
- `POST /backoffice/properties/:propertyId/maintenance-areas`
- `POST /backoffice/properties/:propertyId/maintenance-areas/:areaId/rooms`
- `PATCH /backoffice/properties/:propertyId/maintenance-rules/:ruleCode`
- `GET /backoffice/properties/:propertyId/users`
- `POST /backoffice/properties/:propertyId/users/invite`
- `POST /backoffice/properties/:propertyId/users/:userId/disable`
- `GET /backoffice/roles`
- `GET /backoffice/permissions`
- `GET /backoffice/properties/:propertyId/integrations`
- `POST /backoffice/properties/:propertyId/integrations/:providerCode/connect`
- `GET /backoffice/properties/:propertyId/compliance-settings`
- `PATCH /backoffice/properties/:propertyId/compliance-settings`
- `GET /backoffice/properties/:propertyId/billing-settings`
- `PATCH /backoffice/properties/:propertyId/billing-settings`
- `GET /backoffice/properties/:propertyId/accounting-settings`
- `PATCH /backoffice/properties/:propertyId/accounting-settings`
- `GET /backoffice/properties/:propertyId/ai-settings`
- `PATCH /backoffice/properties/:propertyId/ai-settings`
- `GET /backoffice/properties/:propertyId/ai/suggestions`
- `POST /backoffice/properties/:propertyId/ai/suggestions`
- `POST /backoffice/properties/:propertyId/ai/suggestions/:suggestionId/apply`
- `GET /backoffice/properties/:propertyId/templates`
- `POST /backoffice/properties/:propertyId/templates`
- `PATCH /backoffice/properties/:propertyId/templates/:templateId`
- `POST /backoffice/properties/:propertyId/qr-codes`
- `GET /backoffice/properties/:propertyId/qr-codes`
- `POST /backoffice/properties/:propertyId/qr-codes/bulk`
- `GET /backoffice/properties/:propertyId/audit`

Back Office routes are permission-protected by `backoffice.access`, `property.configure`, `property.map.manage`, `property.import`, `property.go_live`, module, integration, compliance, billing, accounting, AI, template, and audit permissions. Every mutating Back Office route writes an audit event. Readiness checks with blocking severity prevent go-live approval.

Back Office AI suggestions are preview-first. `POST /backoffice/properties/:propertyId/ai/suggestions` stores a proposed change set, and `POST /backoffice/properties/:propertyId/ai/suggestions/:suggestionId/apply` applies only a previewed suggestion after confirmation. AI cannot apply Back Office changes without preview and confirmation.

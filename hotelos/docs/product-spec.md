# HotelOS Mobile Product Spec

## Product Rule

AI interprets, proposes, and orchestrates. Backend tools execute. Humans approve sensitive actions. Every action is logged.

## Modular Suite Organization

HotelOS is organized as a modular AI-first hotel suite without changing the underlying architecture. The base apps and packages remain intact, while `@hotelos/product` adds module manifests, dependencies, module-aware mobile navigation and route visibility. The mobile shell is organized around Hoy, Habitaciones, IA, Tareas and Mas, with AI Command Center as the primary operational interface.

## First Production Stack

- Mobile: React Native, Expo Dev Client, TypeScript, Expo EAS.
- API: Node.js, TypeScript, Fastify, PostgreSQL, Redis, object storage.
- Data: Prisma schema for PostgreSQL.
- Jobs: worker service prepared for BullMQ or Temporal.
- AI: separate AI Gateway for speech, OCR, intent parsing, tool routing, guardrails, confidence scoring, and human confirmation.
- Deployment: Docker containers in an EU region, with managed PostgreSQL, Redis, object storage, logs, metrics, backups, and Sentry.

## Native Capability Boundary

Mobile voice, guest document scanning, and maintenance photo capture are behind `nativeCapabilities.ts`.

- Voice providers: Apple Speech framework on iOS and Android SpeechRecognizer on Android.
- Chat voice notes: request microphone permission through the native chat-media bridge and store the resulting audio as message media only after the user sends it.
- Chat attachments: support photo-library images, camera photos, document-picker files, and voice notes through typed attachment drafts.
- Guest document scan providers: VisionKit with Vision text/data recognition on iOS and Google ML Kit Text Recognition v2 on Android.
- Guest document scan contract: return extracted fields only, force `imageStored: false`, force `imageDiscarded: true`, reject `imageUri`, `localUri`, `objectKey`, or `documentObjectKey`.
- Maintenance photo contract: photos may be stored only as maintenance evidence and always require privacy review before upload.
- Boundary rule: ID and passport scans must never be sent as generic chat attachments; they must use the temporary guest-register scan flow.

## MVP Build Order

1. Auth, tenants, properties, users, roles, permissions, audit events.
2. PMS core: room types, rooms, guests, reservations, stays, folios.
3. Housekeeping and maintenance.
4. AI command center.
5. Assisted ID scan check-in.
6. Spain compliance queue and compliance inbox.
7. Invoicing and ledger foundations.
8. AI booking and concierge tools.
9. Owner dashboard.
10. EAS iOS and Android deployment.

## Current Mobile Tabs

- Today dashboard
- Login
- Property selector
- PMS
- AI command center
- Operations
- Books
- Assets
- Concierge inbox
- Compliance inbox
- Notifications
- Offline sync
- Settings and security
- Owner mode

## Flagship Demo

1. Open mobile app.
2. See today's dashboard.
3. Tap microphone.
4. Say "Check in this customer in room 432."
5. Scan ID or passport.
6. App extracts guest fields.
7. App discards the document image.
8. API logs `ID_IMAGE_DISCARDED`.
9. AI matches reservation and validates room.
10. App shows confirmation card.
11. Guest signs.
12. API executes check-in.
13. Room becomes occupied.
14. SES.HOSPEDAJES submission is queued.
15. Welcome message is queued.
16. Audit log shows the full chain.

## Back Office Layer

HotelOS also includes a Back Office web layer in `apps/admin-web`. It is not the daily operational mobile interface. It is the setup and administration center for organization settings, property profile, physical mapping, room types, room inventory, departments, staff roles, module activation, module health, integrations, tax, compliance, billing, accounting, payment settings, AI settings, document templates, QR codes, imports, readiness and go-live.

The Back Office uses the existing architecture and API. It adds `/backoffice` endpoints, permission checks, readiness blockers and audit events without replacing PMS Core, the mobile suite, worker, AI Gateway, module registry, compliance hub, or integration marketplace.

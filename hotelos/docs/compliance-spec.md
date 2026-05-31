# Compliance Spec

This is an implementation checklist, not legal advice. Each release that affects Spain compliance, invoicing, guest messaging, or AI disclosure should be reviewed against current official guidance and counsel.

## Source Checkpoints

- AEPD: copy of DNI/passport is not permitted for lodging compliance because it breaches data minimisation. Source: [AEPD note on DNI/passport copies in hospedajes](https://www.aepd.es/prensa-y-comunicacion/notas-de-prensa/aepd-informa-de-que-no-esta-permitido-solicitar-copia-dni-o-pasaporte-en-hospedajes).
- RD 933/2021: lodging register and communication obligations. Source: [BOE consolidated RD 933/2021](https://www.boe.es/buscar/act.php?id=BOE-A-2021-17461&p=20211027&tn=2).
- RD 1007/2023: Spanish billing system requirements and VERI*FACTU architecture. Source: [BOE RD 1007/2023](https://www.boe.es/diario_boe/txt.php?id=BOE-A-2023-24840).
- Orden HAC/1177/2024: technical specifications for billing systems under RD 1007/2023. Source: [BOE Orden HAC/1177/2024](https://www.boe.es/buscar/act.php?id=BOE-A-2024-22138).
- RD 238/2026: B2B e-invoicing framework. Source: [BOE RD 238/2026](https://www.boe.es/buscar/act.php?id=BOE-A-2026-7295).
- EU AI Act transparency requirements from 2 August 2026. Source: [European Commission AI Act FAQ](https://ai-act-service-desk.ec.europa.eu/en/faq).

## ID Scan Rule

Do not store DNI/passport images by default.

Implementation:

1. Mobile captures document temporarily.
2. OCR/MRZ extracts fields.
3. `DocumentExtractionResult.imageStored` must be `false`.
4. `DocumentExtractionResult.imageDiscarded` must be `true`.
5. API rejects check-in scan requests where `documentImageStored !== false` or `idImageDiscarded !== true`.
6. API writes an `ID_IMAGE_DISCARDED` audit event.

Code:

- `packages/compliance/src/id-scan-policy.ts`
- `apps/api/src/modules/ai/check-in.command.ts`
- `apps/mobile/src/services/nativeCapabilities.ts`

## Guest Register Rule

Guest register records store required payload fields, signature reference, status, and `retentionUntil`. Retention is calculated as three years from record creation in `calculateGuestRegisterRetentionUntil`.

## Retention Policy Rule

Retention policy code lives in `packages/compliance/src/retention-policy.ts`.

- `id_document_image` is `temporary_only` and must be deleted immediately with `ID_IMAGE_DISCARDED`.
- `guest_register_record` and `ses_hospedajes_submission` use scheduled deletion after 36 months unless a legal hold applies.
- `audit_event` and `event_stream` are `append_only` and are never deleted by retention jobs.
- Invoices, journal entries, supplier bills, and maintenance photos require manual review or configured statutory policy before deletion.
- Database-level retention configuration is represented by `retention_policies`; worker jobs use the compliance package before deleting candidates.

## Invoicing Rule

Invoices may be edited only while `status = draft`. Once issued:

- No destructive edit.
- Cancellations, credit notes, or rectifying invoices handle corrections.
- VERI*FACTU hash and QR payload fields are present from the first schema.

## B2B E-Invoice Rule

The integration adapter starts with status events: `created`, `sent`, `accepted`, `rejected`, `paid`. Structured syntaxes are represented by `UBL` and `Facturae` placeholders until the full provider is selected.

## AI Transparency Rule

Guest-facing AI first message:

> Hi, I'm the hotel's AI assistant. I can help with availability, bookings, hotel information, and service requests. A staff member can take over whenever needed.

## AI Execution Rule

AI Gateway cannot import `@hotelos/database`, `@prisma/client`, or `PrismaClient`. It calls the API over HTTP, and API modules enforce permission checks, business rules, audit events, and confirmation records.

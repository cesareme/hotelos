# Modular Suite Addendum

## Implementation Principle

This addendum does not replace the existing HotelOS architecture. The current React Native + Expo mobile app, Node.js TypeScript API, PostgreSQL schema, worker, AI Gateway, compliance services, audit log and event-driven model remain the source of truth.

The new work wraps the existing system in a modular, AI-first and mobile-first product suite:

- Product Module Registry
- Module Marketplace
- Integration Marketplace
- Mobile suite navigation: Hoy, Habitaciones, IA, Tareas, Mas
- Mobile-first PMS planning
- Distribution Hub
- Payment Vault
- Compliance Billing
- Outlet POS
- Guest Experience
- Asset Intelligence
- Owner Mode

## No-Copy Rule

HotelOS may use broad functional patterns common to hotel software suites: modular PMS core, channel distribution, booking engine, online check-in, payments, electronic invoicing, POS, integrations and guest experience workflows.

HotelOS must not copy third-party logos, brand names, commercial text, screenshots, color palettes, icons, layouts, images, animations or visual identity. The product direction is original: AI Command Center, voice-first front desk, temporary ID scan with OCR and image discard, Spain Compliance Inbox, ERP accounting, maintenance, housekeeping, asset intelligence, capex and owner dashboards.

## Module Registry

The `@hotelos/product` package owns module codes, manifests, dependencies, mobile route maps and module permissions. Properties enable modules through the API:

- `GET /modules/catalog`
- `GET /modules/:moduleCode/dependencies`
- `GET /properties/:propertyId/modules`
- `PATCH /properties/:propertyId/modules/:moduleCode/enable`
- `PATCH /properties/:propertyId/modules/:moduleCode/disable`

Core PMS is enabled by default and cannot be disabled. Optional modules validate dependencies before enablement. Enable and disable operations write audit events and domain events: `ModuleEnabled` and `ModuleDisabled`.

## Integration Marketplace

The integration registry is grouped by categories such as OTAs, Channel Managers, Payment Gateways, Electronic Locks, Guest Messaging, Accounting Software, E-invoicing Providers, Government Compliance, Document OCR, RMS / Revenue, CRM, Guest Experience, Metasearch, Email Marketing, POS, Telephony and Energy / IoT.

Credentials are stored only as secret-manager references such as `credentialsSecretRef`; plaintext credentials must not be written to `config_json`.

## Mobile Navigation

The mobile app uses five top-level tabs:

- Hoy
- Habitaciones
- IA
- Tareas
- Mas

Existing screens are not deleted. They are registered under the suite route map and progressively exposed through module visibility.

## Sensitive Actions

Critical workflows keep the previous rules:

- AI never writes directly to the database.
- AI only calls typed backend tools.
- Tools validate modules and permissions.
- Critical actions require confirmation.
- Sensitive execution writes audit events.
- ID/passport images are temporary-only and are not sent to a general LLM.

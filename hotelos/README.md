# HotelOS Mobile

HotelOS Mobile is a mobile-first operating system for hotel owners and staff. The first build targets iOS and Android with React Native, Expo Dev Client, TypeScript, a Node.js backend, PostgreSQL, Redis, object storage, workers, and a dedicated AI Gateway.

The core product rule is implemented from the beginning:

> AI interprets, proposes, and orchestrates. Backend tools execute. Humans approve sensitive actions. Every action is logged.

## What Is In This Foundation

- Monorepo layout for mobile, API, worker, AI Gateway, shared packages, compliance rules, database schema, AI tool contracts, integrations, infra, and docs.
- Prisma schema covering multi-tenancy, PMS, folios, invoicing, accounting, housekeeping, maintenance, assets, concierge, compliance, audit events, AI tool calls, and event stream records.
- API service skeleton with typed module boundaries for auth, PMS, room inventory, AI confirmations, audit, compliance, invoicing, accounting, housekeeping, maintenance, assets, and messaging.
- AI Gateway intent parser and tool routing contract. The gateway has no direct database layer.
- Expo mobile shell with dashboard, AI command center, compliance inbox, owner mode, native capability interfaces, and the flagship check-in confirmation flow.
- Dependency-free Node tests for the safety-critical rules that can run in this environment without package installation.

## Critical Safety Rules

- ID document images are temporary only. The app extracts required fields, discards the image, and logs `ID_IMAGE_DISCARDED`.
- AI never writes directly to the database. It calls typed backend tools.
- Sensitive tools require permissions, confirmation, audit events, and structured results.
- Issued invoices are immutable. Corrections use cancellation, credit notes, or rectifying invoices.
- Guest-facing AI must disclose that it is AI.
- Accounting posting is approval-gated and must remain double-entry balanced.

## Local Commands

This environment currently has Node.js but no package manager on PATH. Once `npm`, `pnpm`, or another package manager is available:

```sh
npm install
npm run test
npm run smoke:demo
npm run dev:api
npm run dev:ai
npm run dev:mobile
```

The tests that do not need installed dependencies can run now:

```sh
node --test tests/*.test.mjs
node scripts/smoke-demo.mjs
```

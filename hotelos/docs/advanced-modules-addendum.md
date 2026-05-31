# Advanced HotelOS Modules Addendum

This addendum is an incremental extension of the existing HotelOS architecture. It does not replace the mobile app, API, worker, AI Gateway, Back Office, database, product registry, integration marketplace, compliance hub or event-driven model.

## Modules

The Product Module Registry now includes:

- `revenue_profit_engine`
- `guest_data_crm_loyalty`
- `groups_events_sales`
- `workforce_labor`
- `procurement_inventory`
- `guest_self_service`
- `reputation_quality`
- `energy_sustainability`
- `safety_incident_management`
- `hotel_intelligence_platform`
- `developer_platform`
- `ai_governance`

Each module has a manifest, dependencies, permissions, mobile routes, admin routes and health-check requirements.

## Phase 1 Scope

This phase adds the foundation for the advanced suite:

- Product module manifests and dependency declarations.
- RBAC permissions for revenue, CRM, groups, events, workforce, procurement, inventory, guest self-service, reputation, quality, energy, sustainability, safety, analytics, developer platform and AI governance.
- Database schema contracts for each advanced module.
- API namespace placeholders with permission checks and audit events for sensitive mutations.
- Admin-web navigation sections for Operations, Commercial, Guest Experience, Finance and Compliance, Asset and Sustainability, and Platform.
- Mobile More routes that are visible only when the module is enabled and the user has permission.
- AI tool manifests that validate module enabled state and user permissions before execution.
- Worker job names for forecasts, profile refresh, campaigns, group blocks, labor, inventory, reviews, utilities, safety, analytics, webhooks and AI evaluations.

## AI Rules

- AI never writes directly to the database.
- AI can analyze, recommend, draft and prepare.
- AI tools are blocked when the module is disabled.
- AI tools are blocked when required permissions are missing.
- High-risk actions require confirmation.
- Financial, compliance, rate, inventory, room-blocking and AI-governance changes require the configured role approval.
- Bulk Back Office changes still require preview before apply.

## API Namespaces

Advanced module routes are grouped under:

- `/revenue`
- `/crm`
- `/sales`
- `/groups`
- `/events`
- `/workforce`
- `/procurement`
- `/inventory`
- `/guest-portal`
- `/guest-self-service`
- `/reputation`
- `/quality`
- `/surveys`
- `/energy`
- `/sustainability`
- `/safety`
- `/analytics`
- `/developer`
- `/ai-governance`

All mutating routes are represented in the API route permission manifest.

## Health Checks

Advanced health checks include:

- Revenue: PMS inventory, rates, distribution, historical demand and accounting cost data.
- CRM: guest profiles, consent, email provider, campaigns and loyalty rules.
- Groups and events: room types, spaces, billing, deposits and inventory rules.
- Workforce: departments, staff profiles, shift rules, time clock policy and labor costs.
- Procurement and inventory: suppliers, stock locations, items, approvals and accounting mappings.
- Guest self-service: portal, payments, check-in rules, templates and digital key configuration.
- Reputation and quality: review sources, surveys, workflows and messaging provider.
- Energy and sustainability: meters, occupancy metrics, targets and capex links.
- Safety: emergency contacts, checks, incident workflow and evidence storage.
- Analytics: metric definitions, snapshot worker, data quality and owner reports.
- Developer platform: scopes, webhook worker, sandbox property and docs.
- AI governance: tool registry, policies, evals, disclosure and human review queue.

## Definition Of Done

The advanced suite foundation is done when:

- Existing tests pass.
- Each new module appears in the module catalog.
- Each new permission appears in RBAC.
- Each module has schema contracts.
- Each module has route placeholders and route permissions.
- Admin-web and mobile navigation include advanced modules behind module and permission gates.
- AI tool execution remains module-aware and permission-aware.
- Worker job names exist for recurring advanced jobs.
- Documentation describes the incremental rollout path.

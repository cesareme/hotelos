# AI Onboarding & Migration

HotelOS includes `ai_onboarding_migration` as an incremental platform module for AI-assisted PMS switching and first-time setup.

The module is designed around one rule: AI suggests, humans approve. AI can classify files, extract tables, generate a Hotel Blueprint, suggest mappings and explain issues, but it cannot apply migration batches, create live reservations, overwrite production data or approve go-live without review.

## Entry Points

- Local demo launcher: `AI Setup Wizard`
- Mobile More: `Configuration & Admin -> AI Setup Wizard`
- Admin Back Office: `/backoffice/ai-setup`
- Setup Center: `Start AI Setup` / `Continue AI Setup`

If the module is disabled, the UI must show a module-disabled fallback with dependencies and setup state instead of returning a blank screen.

## Core Flow

1. Select source system: Mews, OPERA/OHIP, Cloudbeds, Apaleo, generic PMS or manual.
2. Choose import method: API, CSV/XLSX, PDF reports, floor plan, revenue report or voice/text description.
3. Upload or connect data.
4. Classify uploaded files.
5. Extract entities and source references.
6. Generate Hotel Blueprint suggestions.
7. Review rooms, floors, zones and room types.
8. Review rates, rate plans and restrictions.
9. Review channels and channel mappings.
10. Review future reservations and guests.
11. Review compliance settings.
12. Review revenue history and forecast snapshots.
13. Run data quality checks.
14. Run dry-run migration.
15. Apply approved batches only after confirmation.
16. Generate go-live readiness and cutover plan.

## Property Blueprint Assist

`Room Walk Setup` parses a manager's spoken walkthrough into room, floor, zone, room type and status suggestions. For example, a transcript such as "Floor 2, east wing, rooms 201 to 216 are double standard..." produces a preview only; the system marks it as requiring human confirmation and blocks apply until approved.

Floor-plan mapping is also assistive. It can suggest room labels, public spaces, technical spaces and emergency-exit hints from floor-plan text or OCR output, but every label requires review. Floor-plan hints must not be treated as legal or safety compliance evidence without separate validation.

## Safety Rules

- AI must not invent missing values.
- Unknown values must be `null` and listed as missing data.
- Low-confidence and high-risk mappings require human review.
- Pending, low-confidence, high-risk, missing-data, financial and compliance mappings appear in the Human Review Queue.
- Dry-run is mandatory before apply.
- Go-live is blocked by any blocking data quality issue.
- Raw card data and CVV must not be imported.
- ID/passport images must not be stored by default.
- Uploaded files are temporary onboarding artifacts and expire by policy.
- Sensitive previews, downloads, applies and rollbacks are audited.
- Guest, document, email, phone, address and payment fields are masked in previews unless `onboarding.view_sensitive` is granted.

## Data Quality Gate

Go-live and migration apply are blocked by unresolved blocking issues, including:

- rooms without room type
- duplicate room numbers
- future reservations without guest
- missing channel mappings
- missing legal property profile
- missing SES.HOSPEDAJES configuration
- missing invoice sequence
- History & Forecast totals mismatch

Warnings such as probable duplicate guests, rate plans without rate days, missing payment provider, forecast gaps and revenue report date gaps remain visible and require operating review.

## Dry-Run Gate

Migration apply requires all of the following:

- completed dry-run
- explicit human confirmation
- zero blocking data quality issues
- zero pending mapping reviews

Imports are planned in this order:

1. Property blueprint
2. Compliance settings
3. Rooms
4. Spaces
5. Inventory resources
6. Rates
7. Restrictions
8. Channels
9. Channel mappings
10. Guests
11. Companies
12. Future reservations
13. Revenue history
14. Users and roles

Historical invoices and revenue reports are imported as read-only history or analytics snapshots unless explicitly approved as an accounting ledger migration.

## Cutover Assistant

The cutover plan tracks:

- T-30 days: discovery, exports and rollback plan
- T-14 days: test import and dry-run validation
- T-7 days: staff review and training
- T-2 days: final source PMS export rehearsal
- T-1 day: configuration freeze
- Go-live day: delta import, arrivals, balances, channels and first night audit
- T+1 day: post-go-live checks

Blocking data quality issues stop the T-2, T-1 and go-live stages until resolved.

## Delta Import Dry-Run

Go-live day uses a source watermark to preview final changes from the old PMS:

- future reservations
- guests
- folios
- open balances
- housekeeping status
- maintenance status
- channel reservations

The delta import is dry-run only until go-live approval and manager confirmation are present. Reservation and channel deltas may use source-wins-after-freeze. Folios and balances require manual conflict review.

## Demo Project

The local seed exposes `HotelOS Demo Onboarding Project` with:

- Room list
- Rate sheet
- Channel mapping
- Future reservations
- Floor plan placeholder
- History & Forecast revenue report
- Suggested property blueprint
- Mapping suggestions
- Dry-run output
- Go-live readiness blockers

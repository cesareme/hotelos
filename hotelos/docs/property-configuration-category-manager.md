# Property Configuration & Category Manager

HotelOS Back Office now includes a visible Configuration Center for property taxonomy and setup forms. The goal is that a hotel can configure categories, forms, resources, rules and custom fields without developer intervention.

## Scope

- Property profile, buildings, floors, zones, room types, rooms, spaces, resources and departments.
- Room features, bed types, view types, accessibility features and cleaning categories.
- Housekeeping task types, cleaning schemas, maintenance issue types, priorities, SLAs and asset categories.
- Revenue categories, market segments, source codes, channel categories, rate categories, demand event types and forecast driver categories.
- Finance and compliance categories such as tax codes, payment method categories, invoice sequence types, authority types, document types, submission modes and retention rules.
- POS, asset, safety, guest request and AI review categories.
- Custom fields for rooms, guests, reservations, assets and other configured entities.

## Category Modes

- `system_controlled`: Legal or compliance values can be configured, but official codes and labels cannot be freely renamed or deleted.
- `property_editable`: The property can fully manage options.
- `property_extendable`: HotelOS provides defaults and the property can add custom options.
- `read_only`: Internal states remain visible and cannot be changed.

## API

The Configuration API lives under `/backoffice/configuration` and `/backoffice/properties/:propertyId/configuration`.

Key endpoints:

- List and inspect categories.
- Add, edit, deactivate, reactivate and reorder category options.
- Seed default category options.
- Import and export category options as JSON/CSV/XLSX-compatible rows.
- Manage custom field definitions and values.
- Preview and apply category templates.
- Generate AI category suggestions with preview and confirmation.

## Safety

- Options in use cannot be deleted; they can be deactivated and stay visible in historical records.
- Legal categories use `system_controlled` mode.
- Bulk imports require preview and confirmation.
- AI can suggest categories but cannot apply without confirmation.
- Category changes create audit events such as `CategoryOptionCreated`, `CategoryOptionUpdated`, `CategoryOptionDeactivated`, `CategoryTemplateApplied`, `CategoryImportApplied`, `CustomFieldCreated` and `AIPropertyCategoriesSuggested`.

## Data Quality

The Configuration Center surfaces data-quality checks for rooms without room type, rooms missing building/floor/zone, room types without rooms, inactive categories still used by active records, duplicate option codes and required custom fields missing.

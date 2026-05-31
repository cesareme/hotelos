# Revenue Management + Channel Manager Addendum

HotelOS now treats `revenue_profit_engine` as the commercial brain of the suite, not as a simple rate grid. It stays inside the existing architecture and uses the Product Module Registry, RBAC, API route permissions, worker job contracts, AI tool manifests, audit events and the Aurora UI layer.

Implemented foundation:

- Module manifest with dependencies on PMS Core, Distribution Hub, Payment Vault, Accounting ERP and Hotel Intelligence Platform.
- Revenue and channel-manager permissions for forecasts, restrictions, automation, sync and mappings.
- Prisma contracts for rate plans, rate days, inventory days, restriction days, channels, mappings, sync jobs, forecasts, recommendations, competitor snapshots, parity alerts, scenarios and automation rules.
- API namespaces: `/revenue`, `/channel-manager` and `/rate-shopper`.
- Mock channel adapters for `booking_com_mock`, `expedia_mock`, `google_hotels_mock`, `direct_booking_engine` and `manual_channel`.
- Worker job names for forecasting, pickup/pace, channel sync, rate shopper, parity, automation and risk detection.
- AI tools for pickup, pace, rate recommendations, restrictions, parity, scenario simulation, channel closeout, recommendation application and sync.
- Mobile screens for revenue dashboard, recommendations, rate grid, demand calendar, channel manager, sync health, parity alerts, scenario simulator and AI insights.
- Admin Back Office screens for revenue settings, rules, automation, channel mappings, rate shopper, competitor set, demand calendar, forecast settings and data quality.
- Confirmed rate-grid updates mutate seeded `rate_days`, `restriction_days` and `inventory_days`; unconfirmed bulk changes return a preview first.
- Approved recommendations apply into the operational rate grid and mark affected rate days as pending channel sync.
- Channel sync jobs evaluate channel health and mapping completeness before returning succeeded, failed or blocked outcomes.

Safety rules:

- AI can recommend, explain, simulate and prepare.
- AI cannot apply high-risk rates, restrictions or channel changes without confirmation.
- Channel sync is blocked when mappings are incomplete.
- Automation is blocked when channel health is unhealthy, dates are manually overridden, confidence is too low or values exceed configured limits.
- All sensitive changes write audit events with before/after payloads where applicable.

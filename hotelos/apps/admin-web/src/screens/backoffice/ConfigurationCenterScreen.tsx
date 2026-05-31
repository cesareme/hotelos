import { useEffect, useState } from "react";
import { getCurrentUserPermissions } from "../../services/api-client";

function nav(screen: string) {
  window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: screen }));
}

// Each configuration area links to its real editor screen and the permission
// required to use it.
type Area = { title: string; detail: string; permission: string; screen: string };

const AREAS: Area[] = [
  { title: "Property profile", detail: "Legal profile, address, timezone, currency, language and business date rules.", permission: "property_profile.edit", screen: "PropertyProfileSetupForm" },
  { title: "Property mapper", detail: "Buildings, floors, zones, rooms, spaces and resources — or map it from documents with AI.", permission: "property.configure", screen: "PropertyMapper" },
  { title: "Categories", detail: "Room features, bed types, housekeeping, maintenance, revenue, POS, assets and compliance values.", permission: "categories.manage", screen: "CategoryManagerScreen" },
  { title: "Custom fields", detail: "Property-specific fields for rooms, guests, reservations and assets.", permission: "custom_fields.manage", screen: "CustomFieldManagerScreen" },
  { title: "Rooms & room types", detail: "Room type defaults, features, views, accessibility, sellable state and inventory.", permission: "room_types.manage", screen: "RoomTypeSetupForm" },
  { title: "Spaces & resources", detail: "Parking, meeting rooms, spa rooms, event spaces, equipment and hourly resources.", permission: "spaces.manage", screen: "SpaceResourceSetupForm" },
  { title: "Departments", detail: "Teams, managers, users and operational ownership.", permission: "departments.manage", screen: "DepartmentSetupForm" },
  { title: "Operations setup", detail: "Housekeeping rules, maintenance categories, SLA rules and inspection logic.", permission: "operations_setup.manage", screen: "HousekeepingSetupForm" },
  { title: "Revenue setup", detail: "Market segments, source codes, rate categories and forecast driver categories.", permission: "revenue_setup.manage", screen: "RevenueCategorySetupForm" },
  { title: "Finance & compliance", detail: "Tax codes, payment categories, invoice sequences, authority types and retention rules.", permission: "configuration.manage", screen: "FinanceComplianceSetupForm" },
  { title: "AI setup", detail: "AI automation level, guest-facing disclosure, voice locales and document retention policy.", permission: "ai_category_setup.use", screen: "AiPropertySetupForm" }
];

type CategoryMode = { label: string; code: string; tag: string; cls: "ok" | "warn" | "info"; detail: string };
const CATEGORY_MODES: CategoryMode[] = [
  { label: "Property-editable", code: "property_editable", tag: "Full control", cls: "ok", detail: "The property fully manages these options — add, rename and remove freely." },
  { label: "Property-extendable", code: "property_extendable", tag: "Extendable", cls: "info", detail: "HotelOS provides defaults; the property can add its own custom options." },
  { label: "System-controlled", code: "system_controlled", tag: "Restricted", cls: "warn", detail: "Legal/compliance values can be configured but not freely renamed or deleted." },
  { label: "Read-only", code: "read_only", tag: "Locked", cls: "info", detail: "Fixed internal states stay visible but cannot be changed." }
];

export function ConfigurationCenterScreen() {
  const [permissions, setPermissions] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getCurrentUserPermissions()
      .then((perms) => { if (!cancelled) setPermissions(perms); })
      .catch(() => { if (!cancelled) setPermissions([]); });
    return () => { cancelled = true; };
  }, []);

  // While permissions are unknown, don't block actions (optimistic).
  const can = (perm: string) => permissions === null || permissions.includes(perm);

  return (
    <>
      <section className="bo-card">
        <div className="bo-card-head" style={{ marginBottom: "var(--space-2)" }}>
          <div>
            <p className="bo-page-eyebrow">Back office</p>
            <h2 className="bo-page-title" style={{ fontSize: "var(--fs-2xl)" }}>Centro de configuración</h2>
          </div>
          <div className="bo-row">
            <button type="button" onClick={() => nav("SetupCenterScreen")}>Centro de alta</button>
            <button type="button" onClick={() => nav("AISetupCenter")}>Asistente de configuración IA</button>
          </div>
        </div>
        <p className="bo-page-subtitle" style={{ marginTop: 0 }}>
          Manage the operating model of the property — categories, custom fields, rooms, resources, departments, rules and
          setup forms — without developer intervention. Pick an area to configure it.
        </p>

        <div className="bo-grid three" style={{ marginTop: "var(--space-4)" }}>
          {AREAS.map((area) => {
            const allowed = can(area.permission);
            return (
              <article className="bo-card bo-stack" key={area.title} style={{ gap: "var(--space-3)" }}>
                <div className="bo-card-head" style={{ marginBottom: 0 }}>
                  <h3 style={{ margin: 0 }}>{area.title}</h3>
                  <span className={`bo-status ${allowed ? "ok" : "warn"}`}>{allowed ? "available" : "no access"}</span>
                </div>
                <p className="bo-option-desc">{area.detail}</p>
                <div className="bo-actions">
                  <button
                    type="button"
                    className="primary"
                    onClick={() => nav(area.screen)}
                    disabled={!allowed}
                    title={allowed ? undefined : "You don't have access to this area."}
                  >
                    Configure
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="bo-card">
        <div className="bo-card-head">
          <div><p className="bo-muted">Controlled taxonomy</p><h3 style={{ margin: 0 }}>How category options behave</h3></div>
          <span className="bo-chip">4 modes</span>
        </div>
        <p className="bo-option-desc" style={{ marginBottom: "var(--space-4)" }}>
          Every category controls how much the property can change its options.
        </p>
        <div className="bo-grid two">
          {CATEGORY_MODES.map((mode) => (
            <article className="bo-card bo-stack" key={mode.code} style={{ gap: "var(--space-2)" }}>
              <div className="bo-card-head" style={{ marginBottom: 0, alignItems: "center" }}>
                <h4 style={{ margin: 0 }}>{mode.label}</h4>
                <span className={`bo-status ${mode.cls}`}>{mode.tag}</span>
              </div>
              <p className="bo-option-desc" style={{ margin: 0 }}>{mode.detail}</p>
            </article>
          ))}
        </div>
        <p className="bo-muted" style={{ textTransform: "none", letterSpacing: 0, marginTop: "var(--space-4)" }}>
          AI-suggested categories (room features, maintenance/housekeeping types, revenue segments, space &amp; asset categories)
          always require preview and confirmation before they are applied.
        </p>
      </section>
    </>
  );
}

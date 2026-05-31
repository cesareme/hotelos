import { getActivePropertyId } from "../../../services/activeProperty";
import { useEffect, useState } from "react";
import { FormPage } from "../../../components/forms/FormComponents";
import { backOfficeEndpoints, fetchConfigurationCategories, type ConfigurationCategoryGroup } from "../../../services/backofficeApi";
import { CategoryDetailScreen } from "./CategoryDetailScreen";

const groups = [
  "Property",
  "Rooms",
  "Spaces & Resources",
  "Operations",
  "Maintenance",
  "Housekeeping",
  "Revenue",
  "Distribution",
  "Guest Experience",
  "Finance",
  "Compliance",
  "POS",
  "Assets",
  "Safety",
  "AI"
];

const fallbackGroups: ConfigurationCategoryGroup[] = [
  {
    group: "Rooms",
    categories: [
      { id: "catdef_room_features", code: "room_features", name: "Room features", categoryGroup: "Rooms", mode: "property_editable", active: true, sortOrder: 10, activeOptions: 3, inactiveOptions: 1, options: [] },
      { id: "catdef_bed_types", code: "bed_types", name: "Bed types", categoryGroup: "Rooms", mode: "property_extendable", active: true, sortOrder: 20, activeOptions: 3, inactiveOptions: 0, options: [] }
    ]
  },
  {
    group: "Revenue",
    categories: [
      { id: "catdef_market_segments", code: "market_segments", name: "Market segments", categoryGroup: "Revenue", mode: "property_extendable", active: true, sortOrder: 90, activeOptions: 8, inactiveOptions: 0, options: [] }
    ]
  },
  {
    group: "Compliance",
    categories: [
      { id: "catdef_document_types", code: "document_types", name: "Document types", categoryGroup: "Compliance", mode: "system_controlled", active: true, sortOrder: 140, activeOptions: 3, inactiveOptions: 0, options: [] }
    ]
  }
];

export function CategoryManagerScreen() {
  const [categoryGroups, setCategoryGroups] = useState<ConfigurationCategoryGroup[]>(fallbackGroups);
  const [source, setSource] = useState<"static" | "api">("static");
  const categoryCount = categoryGroups.reduce((total, group) => total + group.categories.length, 0);

  useEffect(() => {
    let mounted = true;
    fetchConfigurationCategories(getActivePropertyId())
      .then((payload) => {
        if (!mounted) return;
        setCategoryGroups(payload.groups);
        setSource("api");
      })
      .catch(() => {
        if (!mounted) return;
        setCategoryGroups(fallbackGroups);
        setSource("static");
      });
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <FormPage
      eyebrow="Configuration"
      title="Property Configuration & Category Manager"
      summary="Configure property taxonomy without code changes: rooms, room types, features, bed types, spaces, resources, departments, housekeeping, maintenance, revenue, channels, POS, assets, compliance and custom fields."
    >
      <section className="bo-grid three">
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Category groups</h3>
            <span className="bo-chip">{categoryGroups.length} groups</span>
          </div>
          <ul className="bo-list">
            {groups.map((group) => (
              <li className="bo-row" key={group}><strong>{group}</strong><span className="bo-status ok">visible</span></li>
            ))}
          </ul>
        </article>
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Categories</h3>
            <button className="primary" type="button" onClick={() => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "AISetupCenter" }))}>Ask AI Setup Assistant</button>
          </div>
          <p><span className="bo-chip">{categoryCount} database categories</span></p>
          <ul className="bo-list">
            {categoryGroups.flatMap((group) =>
              group.categories.map((category) => (
                <li className="bo-row" key={category.code}>
                  <strong>{category.name}</strong>
                  <span>{category.activeOptions} active / {category.inactiveOptions} inactive</span>
                  <span className={`bo-status ${category.mode === "system_controlled" ? "warn" : "ok"}`}>{category.mode}</span>
                </li>
              ))
            )}
          </ul>
          <div className="bo-actions">
            <button type="button" disabled style={{ opacity: 0.55, cursor: "not-allowed" }} title="Pendiente de implementación">Template preview</button>
            <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "ImportReview" }))}>Import CSV/XLSX/JSON</button>
            <button type="button" disabled style={{ opacity: 0.55, cursor: "not-allowed" }} title="Pendiente de implementación">Export</button>
          </div>
        </article>
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Selected category</h3>
            <span className="bo-status ok">property_editable</span>
          </div>
          <p>Room features are fully manageable by the property. System-controlled legal values are shown in the same manager but cannot be renamed or deleted.</p>
          <div className="bo-progress-list">
            <article className="bo-progress-row complete"><span>Add option</span><strong>ready</strong><small>Color, icon, description, parent and default value.</small></article>
            <article className="bo-progress-row review"><span>Usage count</span><strong>protected</strong><small>In-use options cannot be deleted.</small></article>
            <article className="bo-progress-row complete"><span>History</span><strong>preserved</strong><small>Inactive options stay visible on historical records.</small></article>
          </div>
        </article>
      </section>
      <CategoryDetailScreen />
    </FormPage>
  );
}

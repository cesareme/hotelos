import { getActivePropertyId } from "../../../services/activeProperty";
import { useEffect, useState } from "react";
import { FormPage } from "../../../components/forms/FormComponents";
import { fetchConfigurationCategory, type ConfigurationCategory } from "../../../services/backofficeApi";
import { CategoryOptionForm } from "./CategoryOptionForm";

const fallbackCategory: ConfigurationCategory = {
  id: "catdef_room_features",
  code: "room_features",
  name: "Room features",
  categoryGroup: "Rooms",
  entityType: "room",
  mode: "property_editable",
  active: true,
  sortOrder: 10,
  activeOptions: 3,
  inactiveOptions: 1,
  options: [
    { id: "catopt_balcony", label: "Balcony", code: "balcony", usageCount: 12, active: true, sortOrder: 10 },
    { id: "catopt_sea_view", label: "Sea view", code: "sea_view", usageCount: 8, active: true, sortOrder: 20 },
    { id: "catopt_connecting", label: "Connecting room", code: "connecting_room", usageCount: 3, active: true, sortOrder: 30 },
    { id: "catopt_pet", label: "Pet friendly", code: "pet_friendly", usageCount: 0, active: false, sortOrder: 40 }
  ]
};

export function CategoryDetailScreen() {
  const [category, setCategory] = useState<ConfigurationCategory>(fallbackCategory);
  const [source, setSource] = useState<"static" | "api">("static");

  function refreshCategory() {
    fetchConfigurationCategory(getActivePropertyId(), category.code)
      .then((payload) => {
        setCategory(payload);
        setSource("api");
      })
      .catch(() => {
        setCategory(fallbackCategory);
        setSource("static");
      });
  }

  useEffect(() => {
    refreshCategory();
  }, []);

  return (
    <FormPage
      eyebrow="Category detail"
      title={category.name}
      summary="Manage property-editable options with colors, icons, descriptions, parent options, usage counts and active/inactive state."
    >
      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Options</h3>
            <div className="bo-actions">
              <button className="primary" type="button" onClick={() => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "CategoryOptionForm" }))}>Añadir opción</button>
              <button type="button" disabled style={{ opacity: 0.55, cursor: "not-allowed" }} title="Pendiente de implementación">Reorder</button>
              <button type="button" onClick={() => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "ImportReview" }))}>Import</button>
              <button type="button" disabled style={{ opacity: 0.55, cursor: "not-allowed" }} title="Pendiente de implementación">Export</button>
            </div>
          </div>
          <p>
            <span className={`bo-status ${category.mode === "system_controlled" ? "warn" : "ok"}`}>{category.mode}</span>{" "}
            <span className="bo-chip">source: {source}</span>
          </p>
          <ul className="bo-list">
            {category.options.map((option) => (
              <li className="bo-row" key={option.id}>
                <strong>{option.label}</strong>
                <span>{option.code}</span>
                <span>{option.usageCount} linked records</span>
                <span className={`bo-status ${option.active ? "ok" : "warn"}`}>{option.active ? "active" : "inactive"}</span>
                <button type="button">Editar</button>
              </li>
            ))}
          </ul>
        </article>
        <article className="bo-card">
          <CategoryOptionForm category={category} onSaved={refreshCategory} />
        </article>
      </section>
    </FormPage>
  );
}

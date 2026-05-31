import {
  FormField,
  FormPage,
  FormSection,
  FormSelect,
  FormStickyActionBar,
  FormSwitch,
  FormValidationSummary
} from "../../components/forms/FormComponents";

const customFields = [
  ["room", "internal_notes", "Internal notes", "text", "searchable"],
  ["guest", "vip_reason", "VIP reason", "select", "visible in list"],
  ["reservation", "arrival_transport", "Arrival transport", "select", "detail only"],
  ["asset", "warranty_reference", "Warranty reference", "text", "searchable"]
];

const entityTypes = ["room", "room_type", "guest", "reservation", "asset", "space", "work_order", "invoice"];
const dataTypes = ["text", "number", "boolean", "date", "datetime", "select", "multi_select", "money", "percentage", "json"];

export function CustomFieldManagerScreen() {
  return (
    <FormPage
      eyebrow="Configuration"
      title="Custom fields"
      summary="Create property-specific fields per entity without code changes. Custom fields can be searchable, visible in lists, required, validated and connected to category options."
    >
      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Custom field definitions</h3>
            <button className="primary" type="button" onClick={() => window.dispatchEvent(new CustomEvent("hotelos-nav", { detail: "CustomFieldSetupForm" }))}>Create custom field</button>
          </div>
          <table className="bo-table">
            <thead>
              <tr>
                <th>Entity</th>
                <th>Key</th>
                <th>Label</th>
                <th>Type</th>
                <th>Visibility</th>
              </tr>
            </thead>
            <tbody>
              {customFields.map(([entity, key, label, type, visibility]) => (
                <tr key={key}>
                  <td>{entity}</td>
                  <td>{key}</td>
                  <td>{label}</td>
                  <td>{type}</td>
                  <td>{visibility}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </article>

        <FormSection title="Custom field form">
          <FormSelect label="Entity type" options={entityTypes} required />
          <FormField label="Field key" required hint="Unique per property and entity type." />
          <FormField label="Label" required />
          <FormField label="Description" />
          <FormSelect label="Data type" options={dataTypes} required />
          <FormSwitch label="Required" />
          <FormSwitch label="Searchable" />
          <FormSwitch label="Visible in list" />
          <FormSwitch label="Visible in detail" />
          <FormSelect label="Options category" options={["None", "Room features", "Market segments", "Guest request categories", "Asset categories"]} />
          <FormField label="Validation JSON" />
          <FormField label="Visibility rules JSON" />
          <FormField label="Default value JSON" />
        </FormSection>
      </section>

      <FormValidationSummary
        issues={[
          "Required custom fields must be filled on active records before go-live.",
          "Select and multi-select fields should use category definitions.",
          "Every custom field update creates a CustomFieldUpdated audit event."
        ]}
      />
      <FormStickyActionBar />
    </FormPage>
  );
}

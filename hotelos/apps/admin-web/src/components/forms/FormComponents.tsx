import type { ReactNode } from "react";

export function FormPage(props: { title: string; eyebrow?: string; summary: string; children: ReactNode }) {
  return (
    <section className="bo-card">
      <div className="bo-card-head">
        <div>
          {props.eyebrow ? <p className="bo-muted">{props.eyebrow}</p> : null}
          <h2>{props.title}</h2>
        </div>
        <span className="bo-chip">Aviso de cambios sin guardar</span>
      </div>
      <p>{props.summary}</p>
      {props.children}
    </section>
  );
}

export function FormSection(props: { title: string; children: ReactNode }) {
  return (
    <section className="bo-card">
      <h3>{props.title}</h3>
      <div className="bo-grid two">{props.children}</div>
    </section>
  );
}

export function FormRow(props: { children: ReactNode }) {
  return <div className="bo-row">{props.children}</div>;
}

export function FormField(props: { label: string; required?: boolean; children?: ReactNode; hint?: string }) {
  const labelLower = props.label.toLowerCase();
  const isPhone = /tel[eé]fono|phone|\btel\b/i.test(props.label);
  const isEmail = /email|correo electr[oó]nico|e-mail/i.test(labelLower);
  let defaultInput: ReactNode = <input aria-label={props.label} />;
  if (isPhone) {
    defaultInput = <input aria-label={props.label} type="tel" inputMode="tel" />;
  } else if (isEmail) {
    defaultInput = <input aria-label={props.label} type="email" inputMode="email" />;
  }
  return (
    <label className="bo-form-field">
      <span>
        {props.label}
        {props.required ? <strong> obligatorio</strong> : null}
      </span>
      {props.children ?? defaultInput}
      {props.hint ? <small>{props.hint}</small> : null}
    </label>
  );
}

export function FormSelect(props: { label: string; options: string[]; required?: boolean; value?: string; onChange?: (value: string) => void }) {
  return (
    <FormField label={props.label} required={props.required}>
      <select aria-label={props.label} value={props.value ?? ""} onChange={(event) => props.onChange?.(event.currentTarget.value)}>
        <option value="">Seleccionar...</option>
        {props.options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </FormField>
  );
}

export function FormMultiSelect(props: { label: string; options: string[]; value?: string[]; onChange?: (value: string[]) => void }) {
  return (
    <FormField label={props.label} hint={`Separar por comas. Opciones: ${props.options.join(", ")}`}>
      <input
        aria-label={props.label}
        value={(props.value ?? []).join(", ")}
        onChange={(event) => props.onChange?.(event.currentTarget.value.split(",").map((value) => value.trim()).filter(Boolean))}
        placeholder={props.options.slice(0, 3).join(", ")}
      />
    </FormField>
  );
}

export function FormSwitch(props: { label: string; value?: boolean; onChange?: (value: boolean) => void }) {
  return (
    <FormField label={props.label}>
      <input aria-label={props.label} checked={Boolean(props.value)} onChange={(event) => props.onChange?.(event.currentTarget.checked)} type="checkbox" />
    </FormField>
  );
}

export function FormNumberInput(props: { label: string; value?: string | number; onChange?: (value: string) => void }) {
  return (
    <FormField label={props.label}>
      <input aria-label={props.label} inputMode="decimal" value={props.value ?? ""} onChange={(event) => props.onChange?.(event.currentTarget.value)} type="number" />
    </FormField>
  );
}

export function FormMoneyInput(props: { label: string; value?: string | number; onChange?: (value: string) => void }) {
  return (
    <FormField label={props.label}>
      <input aria-label={props.label} inputMode="decimal" value={props.value ?? ""} onChange={(event) => props.onChange?.(event.currentTarget.value)} placeholder="0.00" />
    </FormField>
  );
}

export function FormDateInput(props: { label: string; value?: string; onChange?: (value: string) => void }) {
  return (
    <FormField label={props.label}>
      <input aria-label={props.label} value={props.value ?? ""} onChange={(event) => props.onChange?.(event.currentTarget.value)} type="date" />
    </FormField>
  );
}

export function FormTextarea(props: { label: string; value?: string; onChange?: (value: string) => void }) {
  return (
    <FormField label={props.label}>
      <textarea aria-label={props.label} value={props.value ?? ""} onChange={(event) => props.onChange?.(event.currentTarget.value)} />
    </FormField>
  );
}

export function FormColorPicker(props: { label: string }) {
  return (
    <FormField label={props.label}>
      <input aria-label={props.label} type="color" />
    </FormField>
  );
}

export function FormIconPicker(props: { label: string }) {
  return <FormSelect label={props.label} options={["BedDouble", "Waves", "SquareParking", "Wrench", "ShieldCheck", "Sparkles"]} />;
}

export function FormRepeater(props: { title: string; children: ReactNode }) {
  return (
    <div className="bo-card">
      <div className="bo-card-head">
        <h3>{props.title}</h3>
        <button type="button">Añadir fila</button>
      </div>
      {props.children}
    </div>
  );
}

export function FormPreviewPanel(props: { children: ReactNode }) {
  return <aside className="bo-readiness-card">{props.children}</aside>;
}

function humanizeKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function formatScalar(value: unknown): { display: string; statusClass?: string; mono?: boolean } {
  if (value === null || value === undefined) return { display: "—" };
  if (typeof value === "boolean") return { display: value ? "Yes" : "No", statusClass: value ? "ok" : "info" };
  if (typeof value === "number") return { display: String(value), mono: true };
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
      try {
        const d = new Date(value);
        if (!Number.isNaN(d.getTime())) return { display: d.toLocaleString("es-ES") };
      } catch {
        // fall through
      }
    }
    const isId = /^[a-z]+_[a-z0-9]+$/i.test(value) || /^[a-f0-9]{12,}$/i.test(value) || /^cm[a-z0-9]{20,}$/i.test(value);
    return { display: value, mono: isId };
  }
  return { display: String(value), mono: true };
}

function DataField(props: { label: string; value: unknown }) {
  const { value } = props;
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return (
        <div className="dp-row">
          <span className="dp-key">{humanizeKey(props.label)}</span>
          <span className="dp-val muted">empty</span>
        </div>
      );
    }
    if (value.every((v) => typeof v === "string" || typeof v === "number")) {
      return (
        <div className="dp-row">
          <span className="dp-key">{humanizeKey(props.label)}</span>
          <span className="dp-val">
            {value.map((v, i) => <span key={i} className="bo-chip" style={{ marginRight: 4 }}>{String(v)}</span>)}
          </span>
        </div>
      );
    }
    return (
      <details className="dp-nested">
        <summary className="dp-key">{humanizeKey(props.label)} <span className="dp-count">{value.length}</span></summary>
        <div className="dp-nested-body">
          {value.map((item, i) => (
            <div key={i} className="dp-array-item">
              {isPlainObject(item) ? <DataPreview data={item} /> : <span>{String(item)}</span>}
            </div>
          ))}
        </div>
      </details>
    );
  }
  if (isPlainObject(value)) {
    return (
      <details className="dp-nested" open>
        <summary className="dp-key">{humanizeKey(props.label)}</summary>
        <div className="dp-nested-body">
          <DataPreview data={value} />
        </div>
      </details>
    );
  }
  const fmt = formatScalar(value);
  return (
    <div className="dp-row">
      <span className="dp-key">{humanizeKey(props.label)}</span>
      <span className={`dp-val${fmt.mono ? " mono" : ""}`}>
        {fmt.statusClass ? <span className={`bo-status ${fmt.statusClass}`}>{fmt.display}</span> : fmt.display}
      </span>
    </div>
  );
}

export function DataPreview(props: { data: Record<string, unknown> | null | undefined; emptyMessage?: string }) {
  const data = props.data ?? {};
  const entries = Object.entries(data);
  if (entries.length === 0) {
    return <p className="bo-muted">{props.emptyMessage ?? "No data."}</p>;
  }
  return (
    <div className="dp-table">
      {entries.map(([key, value]) => (
        <DataField key={key} label={key} value={value} />
      ))}
    </div>
  );
}

export function FormStickyActionBar() {
  return (
    <div className="bo-actions">
      <button className="primary" type="button">Guardar</button>
      <button type="button">Guardar y añadir otro</button>
      <button type="button">Cancelar</button>
      <button type="button">Desactivar</button>
      <button type="button">Historial de auditoría</button>
    </div>
  );
}

// Turn snake_case / kebab-case check codes into readable text; leave real
// sentences untouched (just ensure the first letter is capitalised).
function humanizeIssue(value: string): string {
  const trimmed = value.trim();
  const looksLikeCode = /^[a-z0-9]+([_-][a-z0-9]+)+$/.test(trimmed);
  const text = looksLikeCode ? trimmed.replace(/[_-]/g, " ") : trimmed;
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

export function FormValidationSummary(props: { issues: string[] }) {
  return (
    <div className="bo-card">
      <strong>Resumen de validación</strong>
      <ul className="bo-list">
        {props.issues.map((issue) => (
          <li className="bo-row" key={issue} style={{ justifyContent: "space-between", width: "100%" }}>
            <span>{humanizeIssue(issue)}</span>
            <span className="bo-status warn">revisar</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

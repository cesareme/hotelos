// Proveedores — /finanzas/proveedores/directorio (Tanda 6 · Finanzas · lote 6-E).
//
// Cocoa 22 «lista / tabla» (docs/design/COCOA-22.md §4, pilot GuestsListScreen):
// CocoaPage → CocoaToolbar (search + active filter) → CocoaSection padding none
// → CocoaTable (a row opens the supplier form in a CocoaDrawer) → footer with
// the count. The drawer is the create AND edit form (CocoaFormSection ×4, two
// footer buttons): NIF/CIF and IBAN are validated by the server, so the 400s
// SUPPLIER_NIF_INVALID / SUPPLIER_NIF_DUPLICATE / SUPPLIER_IBAN_INVALID land on
// their field and every other failure in a CocoaCallout (payablesErrorMessage).
//
// Reads services/payablesApi.ts: listSuppliers · createSupplier · updateSupplier
// (organisation scope: /organizations/:id/payables/suppliers). Hosted inside
// ProveedoresTabs the container paints title and subtitle; the page adds the
// «Nuevo proveedor» action.

import { useMemo, useState, type CSSProperties } from "react";
import type { RetentionRowCode } from "@hotelos/shared";
import { createSupplier, listSuppliers, updateSupplier, type SupplierDto, type SupplierUpsertRequest } from "../../services/payablesApi";
import { useToast } from "../../components/Toast";
import { useTabHost } from "../tabs/TabHost";
import { percent, plural } from "../../lib/format";
import { ACTIONS, FIELD_LABELS, STATUS_LABELS, newLabel } from "../../content/actions";
import {
  CocoaBadge,
  CocoaButton,
  CocoaCallout,
  CocoaDrawer,
  CocoaField,
  CocoaFormRow,
  CocoaFormSection,
  CocoaInput,
  CocoaPage,
  CocoaSearchInput,
  CocoaSection,
  CocoaSegmentedControl,
  CocoaSelect,
  CocoaState,
  CocoaSwitch,
  CocoaTable,
  CocoaToolbar,
  type CocoaTableColumn
} from "../../components/cocoa";
import { RETENTION_ROW_OPTIONS, accountOptions, decimalInput, describeFailure, isExpenseAccount, useChartAccounts, useLoader } from "./payables-shared";

// Secondary line under a cell value (city, phone): caption secondary (never inside a style literal, rule 6).
const subStyle: CSSProperties = {
  display: "block",
  fontSize: "var(--cocoa-fs-caption)",
  fontWeight: "var(--cocoa-fw-regular)" as CSSProperties["fontWeight"],
  color: "var(--cocoa-label-secondary)"
};

type ActiveFilter = "active" | "all" | "inactive";

const ACTIVE_OPTIONS = [
  { value: "active", label: "Activos" },
  { value: "all", label: STATUS_LABELS.all },
  { value: "inactive", label: "Inactivos" }
];

type SupplierForm = {
  name: string;
  taxId: string;
  countryCode: string;
  contactName: string;
  email: string;
  phone: string;
  address: string;
  postalCode: string;
  city: string;
  province: string;
  iban: string;
  paymentTermDays: string;
  defaultExpenseAccountCode: string;
  retentionRate: string;
  retentionRowCode: string;
  active: boolean;
};

const EMPTY_FORM: SupplierForm = {
  name: "",
  taxId: "",
  countryCode: "ES",
  contactName: "",
  email: "",
  phone: "",
  address: "",
  postalCode: "",
  city: "",
  province: "",
  iban: "",
  paymentTermDays: "",
  defaultExpenseAccountCode: "",
  retentionRate: "",
  retentionRowCode: "",
  active: true
};

function formOf(supplier: SupplierDto): SupplierForm {
  return {
    name: supplier.name,
    taxId: supplier.taxId ?? "",
    countryCode: supplier.countryCode ?? "ES",
    contactName: supplier.contact?.contactName ?? "",
    email: supplier.contact?.email ?? "",
    phone: supplier.contact?.phone ?? "",
    address: supplier.address ?? "",
    postalCode: supplier.postalCode ?? "",
    city: supplier.city ?? "",
    province: supplier.province ?? "",
    iban: supplier.ibanFormatted ?? supplier.iban ?? "",
    paymentTermDays: supplier.paymentTermDays === null ? "" : String(supplier.paymentTermDays),
    defaultExpenseAccountCode: supplier.defaultExpenseAccountCode ?? "",
    retentionRate: supplier.retentionRate ?? "",
    retentionRowCode: supplier.retentionRowCode ?? "",
    active: supplier.active
  };
}

type FieldErrors = Partial<Record<keyof SupplierForm, string>>;

/** Client-side checks that mirror the zod schema (the server re-validates NIF and IBAN). */
function validate(form: SupplierForm): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.name.trim()) errors.name = "El nombre es obligatorio.";
  if (form.countryCode.trim() && !/^[A-Za-z]{2}$/.test(form.countryCode.trim())) errors.countryCode = "Código de país ISO de dos letras (ES, PT, FR…).";
  if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errors.email = "Correo electrónico no válido.";
  if (form.paymentTermDays.trim()) {
    const days = Number(form.paymentTermDays.trim());
    if (!Number.isInteger(days) || days < 0 || days > 365) errors.paymentTermDays = "Entre 0 y 365 días.";
  }
  if (form.retentionRate.trim()) {
    const rate = decimalInput(form.retentionRate);
    if (rate === null || Number(rate) < 0 || Number(rate) > 100) errors.retentionRate = "Porcentaje entre 0 y 100 con dos decimales como máximo.";
  }
  if (form.retentionRate.trim() && !form.retentionRowCode) errors.retentionRowCode = "Indica en qué modelo se declara la retención.";
  return errors;
}

/** Request body: empty strings become null (clear) or are dropped (contact keys); `active` only when editing. */
function bodyOf(form: SupplierForm, editing: boolean): SupplierUpsertRequest {
  const text = (value: string) => (value.trim() ? value.trim() : null);
  const contact: NonNullable<SupplierUpsertRequest["contact"]> = {};
  if (form.contactName.trim()) contact.contactName = form.contactName.trim();
  if (form.email.trim()) contact.email = form.email.trim();
  if (form.phone.trim()) contact.phone = form.phone.trim();
  const retentionRate = form.retentionRate.trim() ? decimalInput(form.retentionRate) : null;
  return {
    name: form.name.trim(),
    taxId: text(form.taxId),
    countryCode: form.countryCode.trim().toUpperCase() || "ES",
    contact,
    paymentTermDays: form.paymentTermDays.trim() ? Number(form.paymentTermDays.trim()) : null,
    address: text(form.address),
    postalCode: text(form.postalCode),
    city: text(form.city),
    province: text(form.province),
    iban: form.iban.replace(/\s+/g, "") || null,
    defaultExpenseAccountCode: text(form.defaultExpenseAccountCode),
    retentionRate,
    retentionRowCode: retentionRate && form.retentionRowCode ? (form.retentionRowCode as RetentionRowCode) : null,
    ...(editing ? { active: form.active } : {})
  };
}

const COLUMNS: CocoaTableColumn<SupplierDto>[] = [
  {
    key: "name",
    label: FIELD_LABELS.name,
    render: (s) => (
      <>
        <strong>{s.name}</strong>
        {s.city || s.province ? <span style={subStyle}>{[s.city, s.province].filter(Boolean).join(", ")}</span> : null}
      </>
    )
  },
  {
    key: "taxId",
    label: "NIF / CIF",
    render: (s) =>
      s.taxId ? (
        <span className="cocoa-cluster">
          <span>{s.taxId}</span>
          {s.nifValidatedAt ? (
            <CocoaBadge tone="success" size="small">
              Validado
            </CocoaBadge>
          ) : (
            <CocoaBadge tone="neutral" size="small" title="NIF extranjero o sin dígito de control comprobable">
              Sin validar
            </CocoaBadge>
          )}
        </span>
      ) : (
        "—"
      )
  },
  {
    key: "contact",
    label: "Contacto",
    hideOnNarrow: true,
    render: (s) => (
      <>
        {s.contact?.email ?? s.contact?.contactName ?? "—"}
        {s.contact?.phone ? <span style={subStyle}>{s.contact.phone}</span> : null}
      </>
    )
  },
  { key: "paymentTermDays", label: "Plazo de pago", align: "right", hideOnNarrow: true, render: (s) => (s.paymentTermDays === null ? "—" : plural(s.paymentTermDays, "día", "días")) },
  { key: "defaultExpenseAccountCode", label: "Cuenta habitual", hideOnNarrow: true, render: (s) => s.defaultExpenseAccountCode ?? "—" },
  { key: "retentionRate", label: "Retención", align: "right", hideOnNarrow: true, render: (s) => (s.retentionRate ? percent(s.retentionRate) : "—") },
  {
    key: "active",
    label: FIELD_LABELS.status,
    render: (s) => <CocoaBadge tone={s.active ? "success" : "neutral"}>{s.active ? STATUS_LABELS.active : STATUS_LABELS.inactive}</CocoaBadge>
  }
];

export function SuppliersScreen() {
  const hosted = useTabHost() !== null;
  const { showToast } = useToast();
  const [search, setSearch] = useState("");
  const [activeFilter, setActiveFilter] = useState<ActiveFilter>("active");
  const active = activeFilter === "all" ? undefined : activeFilter === "active";
  const list = useLoader(() => listSuppliers({ q: search.trim() || undefined, active, limit: 500 }), `${search}|${activeFilter}`, "No se pudieron cargar los proveedores.");
  const chart = useChartAccounts();
  const expenseOptions = useMemo(() => accountOptions(chart.accounts, isExpenseAccount), [chart.accounts]);

  // Drawer: null closed · "new" · the supplier being edited.
  const [editing, setEditing] = useState<SupplierDto | "new" | null>(null);
  const [form, setForm] = useState<SupplierForm>(EMPTY_FORM);
  const [touched, setTouched] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const suppliers = list.data ?? [];
  const newSupplierLabel = newLabel("m", "proveedor");
  const clientErrors = validate(form);
  const errors: FieldErrors = { ...clientErrors, ...serverErrors };
  const valid = Object.keys(clientErrors).length === 0;

  function openNew() {
    setForm(EMPTY_FORM);
    setTouched(false);
    setServerErrors({});
    setFailure(null);
    setEditing("new");
  }

  function openEdit(supplier: SupplierDto) {
    setForm(formOf(supplier));
    setTouched(false);
    setServerErrors({});
    setFailure(null);
    setEditing(supplier);
  }

  function close() {
    if (saving) return;
    setEditing(null);
  }

  function set<K extends keyof SupplierForm>(key: K, value: SupplierForm[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    if (serverErrors[key]) setServerErrors((current) => ({ ...current, [key]: undefined }));
  }

  async function save() {
    if (!editing || saving) return;
    setTouched(true);
    if (!valid) return;
    setSaving(true);
    setFailure(null);
    setServerErrors({});
    try {
      const body = bodyOf(form, editing !== "new");
      const saved = editing === "new" ? await createSupplier(body) : await updateSupplier(editing.id, body);
      showToast(editing === "new" ? `Proveedor ${saved.name} creado.` : `Proveedor ${saved.name} actualizado.`, { variant: "success" });
      setEditing(null);
      list.refresh();
    } catch (error: unknown) {
      const { code, message } = describeFailure(error, "No se pudo guardar el proveedor. Revisa los datos e inténtalo de nuevo.");
      if (code === "SUPPLIER_NIF_INVALID" || code === "SUPPLIER_NIF_DUPLICATE") setServerErrors({ taxId: message });
      else if (code === "SUPPLIER_IBAN_INVALID") setServerErrors({ iban: message });
      else setFailure(message);
    } finally {
      setSaving(false);
    }
  }

  const ready = !list.loading && !list.error && suppliers.length > 0;
  const fieldError = (key: keyof SupplierForm) => (touched || serverErrors[key] ? errors[key] : undefined);

  let body;
  if (list.loading && suppliers.length === 0) {
    body = <CocoaTable columns={COLUMNS} rows={[]} loading aria-label="Proveedores" />;
  } else if (list.error) {
    body = <CocoaState kind="error" title="No se pudieron cargar los proveedores" message={list.error} onRetry={list.refresh} />;
  } else if (suppliers.length === 0) {
    body = (
      <CocoaState
        kind="empty"
        illustration={search ? "search" : "box"}
        title={search ? STATUS_LABELS.noResults : activeFilter === "inactive" ? "Sin proveedores inactivos" : "Aún no hay proveedores"}
        message={search ? "Ningún proveedor coincide con la búsqueda." : "Da de alta a tus proveedores con su NIF e IBAN para registrar sus facturas y pagarlas por banco."}
        primaryAction={{ label: newSupplierLabel, onClick: openNew }}
      />
    );
  } else {
    body = <CocoaTable columns={COLUMNS} rows={suppliers} rowKey="id" selectedKey={editing && editing !== "new" ? editing.id : undefined} onSelect={openEdit} caption="Proveedores" aria-label="Proveedores" />;
  }

  return (
    <CocoaPage
      eyebrow="Finanzas · Organización"
      title="Proveedores"
      subtitle={hosted ? undefined : "Directorio de proveedores de la organización: NIF e IBAN validados, plazo de pago, cuenta de gasto habitual y retención."}
      actions={
        <CocoaButton variant="filled" tone="accent" size={hosted ? "small" : "regular"} onClick={openNew}>
          {newSupplierLabel}
        </CocoaButton>
      }
      commands={[
        { id: "suppliers-new", label: newSupplierLabel, run: openNew },
        { id: "suppliers-refresh", label: "Actualizar proveedores", run: list.refresh }
      ]}
    >
      <CocoaToolbar
        variant="content"
        aria-label="Filtros de proveedores"
        leftSlot={<CocoaSearchInput value={search} onChange={setSearch} debounceMs={250} placeholder="Nombre o NIF…" aria-label="Buscar proveedores por nombre o NIF" />}
        rightSlot={<CocoaSegmentedControl value={activeFilter} onChange={(v) => setActiveFilter(v as ActiveFilter)} options={ACTIVE_OPTIONS} size="small" aria-label="Filtrar por estado" />}
      />

      <CocoaSection padding={ready ? "none" : "md"} style={{ overflow: "clip" }} aria-label="Listado de proveedores" footer={ready ? <span>{plural(suppliers.length, "proveedor", "proveedores")}</span> : undefined}>
        {body}
      </CocoaSection>

      <CocoaDrawer
        open={editing !== null}
        onClose={close}
        title={editing === "new" ? newSupplierLabel : editing ? editing.name : "Proveedor"}
        subtitle={editing && editing !== "new" ? [editing.taxId, editing.active ? STATUS_LABELS.active : STATUS_LABELS.inactive].filter(Boolean).join(" · ") : undefined}
        side="right"
        size="lg"
        dismissible={!saving}
        footer={
          <>
            <CocoaButton variant="bordered" tone="neutral" onClick={close} disabled={saving}>
              {ACTIONS.cancel}
            </CocoaButton>
            <CocoaButton variant="filled" tone="accent" onClick={() => void save()} loading={saving} disabled={saving || (touched && !valid)}>
              {editing === "new" ? "Crear proveedor" : ACTIONS.saveChanges}
            </CocoaButton>
          </>
        }
      >
        {editing ? (
          <div className="cocoa-stack" data-gap="4">
            {failure ? (
              <CocoaCallout tone="danger" role="alert" title="No se pudo guardar">
                {failure}
              </CocoaCallout>
            ) : null}

            <CocoaFormSection title="Identificación" description="El NIF o CIF se comprueba con su dígito de control y no puede repetirse en la organización.">
              <CocoaFormRow columns={2}>
                <CocoaField label={FIELD_LABELS.name} required error={fieldError("name")}>
                  <CocoaInput value={form.name} onChange={(v) => set("name", v)} placeholder="Lavandería Atlántica, S. L." autoComplete="organization" disabled={saving} />
                </CocoaField>
                <CocoaField label="NIF / CIF" error={fieldError("taxId")} help="Sin él las facturas no entran en el libro de IVA recibidas.">
                  <CocoaInput value={form.taxId} onChange={(v) => set("taxId", v.toUpperCase())} placeholder="B12345674" maxLength={20} disabled={saving} />
                </CocoaField>
                <CocoaField label="País" error={fieldError("countryCode")} help="Código ISO de dos letras; el NIF solo se valida para ES.">
                  <CocoaInput value={form.countryCode} onChange={(v) => set("countryCode", v.toUpperCase())} maxLength={2} disabled={saving} />
                </CocoaField>
                {editing !== "new" ? (
                  <CocoaField label="Proveedor activo" inline help="Un proveedor inactivo no aparece al registrar facturas.">
                    <CocoaSwitch checked={form.active} onChange={(v) => set("active", v)} size="small" disabled={saving} />
                  </CocoaField>
                ) : (
                  <CocoaField label="Persona de contacto">
                    <CocoaInput value={form.contactName} onChange={(v) => set("contactName", v)} disabled={saving} autoComplete="name" />
                  </CocoaField>
                )}
              </CocoaFormRow>
            </CocoaFormSection>

            <CocoaFormSection title="Contacto y dirección">
              <CocoaFormRow columns={2}>
                {editing !== "new" ? (
                  <CocoaField label="Persona de contacto">
                    <CocoaInput value={form.contactName} onChange={(v) => set("contactName", v)} disabled={saving} autoComplete="name" />
                  </CocoaField>
                ) : null}
                <CocoaField label={FIELD_LABELS.email} error={fieldError("email")}>
                  <CocoaInput value={form.email} onChange={(v) => set("email", v)} type="email" inputMode="email" autoComplete="email" disabled={saving} />
                </CocoaField>
                <CocoaField label={FIELD_LABELS.phone}>
                  <CocoaInput value={form.phone} onChange={(v) => set("phone", v)} type="tel" inputMode="tel" autoComplete="tel" disabled={saving} />
                </CocoaField>
                <CocoaField label="Dirección" fullWidth>
                  <CocoaInput value={form.address} onChange={(v) => set("address", v)} autoComplete="street-address" disabled={saving} />
                </CocoaField>
                <CocoaField label="Código postal">
                  <CocoaInput value={form.postalCode} onChange={(v) => set("postalCode", v)} maxLength={12} inputMode="numeric" autoComplete="postal-code" disabled={saving} />
                </CocoaField>
                <CocoaField label="Municipio">
                  <CocoaInput value={form.city} onChange={(v) => set("city", v)} autoComplete="address-level2" disabled={saving} />
                </CocoaField>
                <CocoaField label="Provincia">
                  <CocoaInput value={form.province} onChange={(v) => set("province", v)} autoComplete="address-level1" disabled={saving} />
                </CocoaField>
              </CocoaFormRow>
            </CocoaFormSection>

            <CocoaFormSection title="Pago y contabilidad" description="El IBAN se comprueba con su módulo 97; la cuenta habitual se propone en cada línea de sus facturas.">
              <CocoaFormRow columns={2}>
                <CocoaField label="IBAN" error={fieldError("iban")} fullWidth>
                  <CocoaInput value={form.iban} onChange={(v) => set("iban", v.toUpperCase())} placeholder="ES91 2100 0418 4502 0005 1332" maxLength={40} disabled={saving} />
                </CocoaField>
                <CocoaField label="Plazo de pago (días)" error={fieldError("paymentTermDays")} help="Propone el vencimiento de sus facturas.">
                  <CocoaInput value={form.paymentTermDays} onChange={(v) => set("paymentTermDays", v)} inputMode="numeric" placeholder="30" disabled={saving} />
                </CocoaField>
                <CocoaField label="Cuenta de gasto habitual" error={fieldError("defaultExpenseAccountCode")} help={chart.error ?? "Subcuenta del grupo 6; 20x o 21x si vende bienes de inversión."}>
                  {chart.accounts.length > 0 ? (
                    <CocoaSelect
                      value={form.defaultExpenseAccountCode}
                      onChange={(v) => set("defaultExpenseAccountCode", v)}
                      options={[{ value: "", label: "Sin cuenta habitual" }, ...expenseOptions]}
                      disabled={saving}
                    />
                  ) : (
                    <CocoaInput value={form.defaultExpenseAccountCode} onChange={(v) => set("defaultExpenseAccountCode", v)} placeholder="629" maxLength={12} disabled={saving || chart.loading} />
                  )}
                </CocoaField>
                <CocoaField label="Retención IRPF (%)" error={fieldError("retentionRate")} help="15 profesionales · 7 nuevos profesionales · 19 alquileres.">
                  <CocoaInput value={form.retentionRate} onChange={(v) => set("retentionRate", v)} inputMode="decimal" placeholder="15" disabled={saving} />
                </CocoaField>
                <CocoaField label="Modelo de la retención" error={fieldError("retentionRowCode")} fullWidth>
                  <CocoaSelect
                    value={form.retentionRowCode}
                    onChange={(v) => set("retentionRowCode", v)}
                    options={[{ value: "", label: "Sin retención" }, ...RETENTION_ROW_OPTIONS]}
                    disabled={saving || !form.retentionRate.trim()}
                  />
                </CocoaField>
              </CocoaFormRow>
            </CocoaFormSection>
          </div>
        ) : null}
      </CocoaDrawer>
    </CocoaPage>
  );
}

export default SuppliersScreen;

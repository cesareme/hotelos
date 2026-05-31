import { useState } from "react";
import {
  FormField,
  FormNumberInput,
  FormPage,
  FormSection,
  FormSelect,
  FormStickyActionBar,
  FormSwitch,
  FormValidationSummary
} from "../../../../components/forms/FormComponents";
import { useToast } from "../../../../components/Toast";

const ROOM_TYPES = ["Doble estándar", "Superior twin", "Junior suite", "Apartamento", "Dormitorio compartido"];
const BUILDINGS = ["Principal", "Anexo", "Jardín", "Frente al mar"];
const FLOORS = ["Planta baja", "1", "2", "3", "4", "5"];
const ZONES = ["Ala este", "Ala oeste", "Patio", "Torre"];
const VIEWS = ["Mar", "Montaña", "Ciudad", "Jardín", "Piscina", "Patio interior"];
const ACCESSIBILITY = ["Ninguna", "Silla de ruedas", "Auditiva", "Visual", "Movilidad"];

export function RoomForm() {
  const { showToast } = useToast();
  const [values, setValues] = useState({
    number: "",
    name: "",
    roomType: "",
    building: "",
    floor: "",
    zone: "",
    view: "",
    accessibility: "",
    smoking: false,
    connectingRoom: "",
    maxOccupancyOverride: "",
    sellable: true,
    active: true
  });
  const [dirty, setDirty] = useState(false);

  function patch<K extends keyof typeof values>(key: K, value: (typeof values)[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty(true);
  }

  const issues: string[] = [];
  if (!values.number.trim()) issues.push("El número de habitación es obligatorio.");
  if (!values.roomType) issues.push("El tipo de habitación es obligatorio.");

  function handleSave(addAnother: boolean) {
    if (issues.length > 0) {
      return;
    }
    setDirty(false);
    if (addAnother) {
      setValues({
        number: "",
        name: "",
        roomType: "",
        building: "",
        floor: "",
        zone: "",
        view: "",
        accessibility: "",
        smoking: false,
        connectingRoom: "",
        maxOccupancyOverride: "",
        sellable: true,
        active: true
      });
    }
  }

  function handleDeactivate() {
    patch("active", false);
    showToast("Habitación desactivada", { variant: "info" });
  }

  return (
    <FormPage
      eyebrow="Configuración / Habitaciones"
      title="Habitación"
      summary="Unidad reservable individual asociada a un tipo de habitación, edificio, planta y zona, con vista, accesibilidad y estado vendible."
    >
      {dirty ? (
        <div className="bo-card">
          <strong>Tienes cambios sin guardar</strong>
          <p>Guarda antes de salir o tus cambios se descartarán.</p>
        </div>
      ) : null}
      <FormValidationSummary issues={issues.length ? issues : ["No hay problemas de validación bloqueantes."]} />
      <FormSection title="Identidad">
        <FormField label="Número" required>
          <input aria-label="Número" value={values.number} onChange={(event) => patch("number", event.currentTarget.value)} placeholder="401" />
        </FormField>
        <FormField label="Nombre">
          <input aria-label="Nombre" value={values.name} onChange={(event) => patch("name", event.currentTarget.value)} placeholder="Suite Aurora" />
        </FormField>
        <FormSelect label="Tipo de habitación" required options={ROOM_TYPES} value={values.roomType} onChange={(value) => patch("roomType", value)} />
      </FormSection>
      <FormSection title="Ubicación">
        <FormSelect label="Edificio" options={BUILDINGS} value={values.building} onChange={(value) => patch("building", value)} />
        <FormSelect label="Planta" options={FLOORS} value={values.floor} onChange={(value) => patch("floor", value)} />
        <FormSelect label="Zona" options={ZONES} value={values.zone} onChange={(value) => patch("zone", value)} />
        <FormSelect label="Vista" options={VIEWS} value={values.view} onChange={(value) => patch("view", value)} />
        <FormSelect label="Accesibilidad" options={ACCESSIBILITY} value={values.accessibility} onChange={(value) => patch("accessibility", value)} />
      </FormSection>
      <FormSection title="Operativa">
        <FormSwitch label="Fumadores" value={values.smoking} onChange={(value) => patch("smoking", value)} />
        <FormField label="Habitación comunicada">
          <input aria-label="Habitación comunicada" value={values.connectingRoom} onChange={(event) => patch("connectingRoom", event.currentTarget.value)} placeholder="402" />
        </FormField>
        <FormNumberInput label="Ocupación máxima (excepción)" value={values.maxOccupancyOverride} onChange={(value) => patch("maxOccupancyOverride", value)} />
        <FormSwitch label="Vendible" value={values.sellable} onChange={(value) => patch("sellable", value)} />
        <FormSwitch label="Activa" value={values.active} onChange={(value) => patch("active", value)} />
      </FormSection>
      <FormSection title="Historial de auditoría">
        <FormField label="Última modificación">
          <span>Última modificación por sistema, el 2026-05-17, ver registro de auditoría.</span>
        </FormField>
      </FormSection>
      <div className="bo-actions">
        <button className="primary" type="button" onClick={() => handleSave(false)}>Guardar</button>
        <button type="button" onClick={() => handleSave(true)}>Guardar y añadir otro</button>
        <button type="button" onClick={() => window.history.back()}>Cancelar</button>
        <button type="button" onClick={handleDeactivate}>Desactivar</button>
      </div>
      <FormStickyActionBar />
    </FormPage>
  );
}

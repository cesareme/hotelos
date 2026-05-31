import {
  FormField,
  FormMoneyInput,
  FormMultiSelect,
  FormNumberInput,
  FormPage,
  FormSection,
  FormSelect,
  FormStickyActionBar,
  FormSwitch,
  FormTextarea,
  FormValidationSummary
} from "../components/forms/FormComponents";

const steps = [
  ["Datos de la organización", "completado"],
  ["Datos legales de la propiedad", "completado"],
  ["Mapa físico de la propiedad", "revisar"],
  ["Tipos de habitación", "revisar"],
  ["Habitaciones", "revisar"],
  ["Espacios y recursos", "revisar"],
  ["Departamentos", "no iniciado"],
  ["Categorías operativas", "no iniciado"],
  ["Categorías de revenue", "no iniciado"],
  ["Finanzas y cumplimiento", "bloqueado"],
  ["Pagos", "revisar"],
  ["Integraciones", "revisar"],
  ["Ajustes de IA", "revisar"],
  ["Revisión", "no iniciado"],
  ["Puesta en marcha", "bloqueado"]
];

const inputCategories = [
  "Perfil de propiedad",
  "Edificios",
  "Plantas",
  "Zonas",
  "Habitaciones",
  "Tipos de habitación",
  "Características de habitación",
  "Tipos de cama",
  "Tipos de vistas",
  "Características de accesibilidad",
  "Espacios",
  "Recursos reservables",
  "Departamentos",
  "Secciones de limpieza",
  "Áreas de mantenimiento",
  "Categorías de activos",
  "Categorías de órdenes de trabajo",
  "Planes tarifarios",
  "Segmentos de mercado",
  "Segmentos de huéspedes",
  "Categorías de canales",
  "Categorías de revenue",
  "Puntos de venta",
  "Categorías de productos POS",
  "Ajustes de cumplimiento",
  "Ajustes de facturación",
  "Secuencias de factura",
  "Ajustes de IA",
  "Campos personalizados"
];

export function PropertySetupWizard() {
  return (
    <FormPage
      eyebrow="Back Office"
      title="Asistente de configuración del hotel"
      summary="Mapea el modelo operativo completo del hotel: perfil legal, estructura física, habitaciones, espacios, recursos, categorías, departamentos, configuración de revenue, configuración de cumplimiento y campos personalizados."
    >
      <section className="bo-grid two">
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Lista de configuración</h3>
            <span className="bo-status warn">en progreso</span>
          </div>
          <ul className="bo-list">
            {steps.map(([step, state], index) => (
              <li className="bo-row" key={step}>
                <strong>{index + 1}. {step}</strong>
                <span className={`bo-status ${state === "completado" ? "ok" : state === "bloqueado" ? "error" : "warn"}`}>
                  {state}
                </span>
              </li>
            ))}
          </ul>
        </article>
        <article className="bo-card">
          <div className="bo-card-head">
            <h3>Categorías de entrada</h3>
            <span className="bo-chip">mapeador de propiedad</span>
          </div>
          <div className="bo-actions">
            {inputCategories.map((category) => (
              <span className="bo-chip" key={category}>{category}</span>
            ))}
          </div>
        </article>
      </section>

      <FormSection title="Perfil de la propiedad">
        <FormField label="Nombre de la propiedad" required />
        <FormField label="Razón social" required />
        <FormField label="NIF/CIF" required />
        <FormTextarea label="Dirección" />
        <FormSelect label="País" options={["España", "Portugal", "Francia", "Italia"]} required />
        <FormField label="Región" />
        <FormField label="Provincia" />
        <FormField label="Ciudad" required />
        <FormField label="Código postal" />
        <FormSelect label="Zona horaria" options={["Europe/Madrid", "Europe/Lisbon", "Europe/Paris"]} required />
        <FormSelect label="Moneda" options={["EUR", "GBP", "USD"]} required />
        <FormSelect label="Idioma" options={["Español", "Inglés", "Catalán", "Francés"]} />
        <FormSelect label="Región fiscal" options={["España peninsular", "Canarias", "Ceuta", "Melilla"]} />
        <FormSelect label="Región de tasa turística" options={["Ninguna", "Cataluña", "Baleares"]} />
        <FormField label="Reglas de fecha contable" />
      </FormSection>

      <section className="bo-grid two">
        <FormSection title="Edificios, plantas y zonas">
          <FormField label="Nombre del edificio" required />
          <FormField label="Código del edificio" required />
          <FormTextarea label="Descripción" />
          <FormNumberInput label="Orden" />
          <FormField label="Nombre de planta" required />
          <FormNumberInput label="Número de planta" />
          <FormField label="Código de planta" />
          <FormField label="Nombre de zona" required />
          <FormSelect label="Tipo de zona" options={["guest_rooms", "public_area", "back_of_house", "technical", "food_beverage", "wellness", "parking", "events", "outdoor"]} />
          <FormSelect label="Sección de limpieza" options={["Ala norte", "Ala sur", "Suites", "Apartamentos"]} />
          <FormSelect label="Área de mantenimiento" options={["Habitaciones", "Zonas comunes", "Salas técnicas", "Exterior"]} />
          <FormSwitch label="Activo" />
        </FormSection>

        <FormSection title="Tipos de habitación y habitaciones">
          <FormField label="Nombre del tipo" required />
          <FormField label="Código del tipo" required />
          <FormSelect label="Categoría" options={["Estándar", "Superior", "Suite", "Apartamento", "Dormitorio compartido"]} required />
          <FormNumberInput label="Ocupación base" />
          <FormNumberInput label="Ocupación máxima" />
          <FormSelect label="Configuración de cama por defecto" options={["Cama king", "Camas gemelas", "Cama queen", "Sofá cama"]} />
          <FormMultiSelect label="Características por defecto" options={["Balcón", "Vistas al mar", "Vistas a la ciudad", "Habitación comunicada", "Admite mascotas", "Accesible"]} />
          <FormSelect label="Categoría de limpieza por defecto" options={["Estándar", "Suite", "Apartamento", "Limpieza profunda"]} />
          <FormField label="Número de habitación" required />
          <FormField label="Nombre visible" />
          <FormSelect label="Edificio / planta / zona" options={["Main / Floor 4 / East", "Main / Floor 3 / West", "Annex / Floor 1 / Courtyard"]} />
          <FormNumberInput label="Ocupación estándar" />
          <FormNumberInput label="Metros cuadrados" />
          <FormSelect label="Estado de habitación" options={["Vacía limpia", "Vacía sucia", "Vacía inspeccionada", "Ocupada", "Fuera de servicio", "Inhabilitada"]} />
          <FormSwitch label="Vendible" />
          <FormSwitch label="Activo" />
        </FormSection>

        <FormSection title="Espacios y recursos">
          <FormField label="Nombre" required />
          <FormField label="Código" required />
          <FormSelect label="Tipo de recurso" options={["room", "parking_space", "meeting_room", "coworking_desk", "spa_room", "restaurant_table", "event_space", "equipment", "storage", "technical_room", "other"]} />
          <FormSelect label="Tipo de espacio" options={["guest_rooms", "public_area", "back_of_house", "technical", "food_beverage", "wellness", "parking", "events", "outdoor"]} />
          <FormSelect label="Edificio / planta / zona" options={["Main / Floor 1 / Lobby", "Main / Floor -1 / Parking", "Rooftop / Events"]} />
          <FormNumberInput label="Capacidad" />
          <FormSwitch label="Reservable por hora" />
          <FormSwitch label="Reservable por día" />
          <FormSwitch label="Reservable por mes" />
          <FormSwitch label="Vendible" />
          <FormSelect label="Código fiscal" options={["IVA 21", "IVA 10", "IGIC", "Exempt"]} />
          <FormMoneyInput label="Tarifa por defecto" />
        </FormSection>

        <FormSection title="Departamentos y propiedad operativa">
          <FormField label="Nombre del departamento" required />
          <FormField label="Código" required />
          <FormTextarea label="Descripción" />
          <FormSelect label="Responsable" options={["Jefe de Recepción", "Gobernanta", "Jefe de Mantenimiento", "Revenue Manager"]} />
          <FormMultiSelect label="Usuarios" options={["Ana", "Carlos", "Maria", "Jorge"]} />
          <FormSelect label="Sección de limpieza" options={["Ala norte", "Ala sur", "Suites", "Apartamentos"]} />
          <FormSelect label="Área de mantenimiento" options={["Habitaciones", "Zonas comunes", "Salas técnicas", "Exterior"]} />
          <FormSwitch label="Activo" />
        </FormSection>

        <FormSection title="Categorías operativas">
          <FormMultiSelect label="Tipos de tareas de limpieza" options={["Limpieza de salida", "Estancia", "Inspección", "Limpieza profunda", "Minibar"]} />
          <FormMultiSelect label="Esquemas de limpieza" options={["Estándar", "Suite", "Apartamento", "Eco stayover"]} />
          <FormNumberInput label="Duración de limpieza por defecto" />
          <FormSwitch label="Requiere inspección" />
          <FormSelect label="Política de estancia" options={["Diaria", "Bajo petición", "Cada 2 días", "Eco opt-out"]} />
          <FormMultiSelect label="Tipos de incidencia de mantenimiento" options={["HVAC", "Plumbing", "Electric", "Furniture", "Lock", "Noise"]} />
          <FormMultiSelect label="Prioridades de OT" options={["Low", "Normal", "High", "Blocking"]} />
          <FormTextarea label="Reglas SLA" />
        </FormSection>

        <FormSection title="Categorías de revenue, finanzas y cumplimiento">
          <FormMultiSelect label="Segmentos de mercado" options={["Directo", "OTA", "Corporativo", "Grupo", "Mayorista", "Walk-in", "Ocio", "Negocio"]} />
          <FormMultiSelect label="Códigos de origen" options={["Web", "Teléfono", "Booking.com", "Expedia", "Google", "Corporativo"]} />
          <FormMultiSelect label="Categorías de canales" options={["Directo", "OTA", "Corporativo", "Grupos", "Metabuscador"]} />
          <FormMultiSelect label="Categorías de tarifa" options={["BAR flexible", "No reembolsable", "Paquete", "Corporativo", "Grupo"]} />
          <FormMultiSelect label="Tipos de eventos de demanda" options={["Demanda por evento", "Baja demanda", "Alta compresión", "Festivo"]} />
          <FormMultiSelect label="Categorías de método de pago" options={["Efectivo", "Token de tarjeta", "Transferencia", "Plataforma"]} />
          <FormMultiSelect label="Tipos de secuencia de factura" options={["Ordinaria", "Simplificada", "Rectificativa"]} />
          <FormSelect label="Tipo de autoridad de cumplimiento" options={["SES.HOSPEDAJES", "Mossos", "Ertzaintza", "Manual", "Otro"]} />
          <FormSelect label="Regla de retención" options={["3 años (registro de viajeros)", "Periodo legal de facturas", "Solo con opt-in de marketing"]} />
        </FormSection>
      </section>

      <FormValidationSummary
        issues={[
          "Las habitaciones vendibles deben tener tipo de habitación, edificio, planta, zona, sección de limpieza y área de mantenimiento.",
          "Los espacios y recursos requieren tipo de recurso, capacidad, modo de reserva, código fiscal y tarifa por defecto antes de poder venderse.",
          "La configuración de cumplimiento requiere región fiscal, tipo de autoridad, tipos de documento, secuencia de factura y regla de retención.",
          "Las categorías inactivas permanecen visibles en los registros históricos y no pueden romper el mapeo de la propiedad."
        ]}
      />
      <FormStickyActionBar />
    </FormPage>
  );
}

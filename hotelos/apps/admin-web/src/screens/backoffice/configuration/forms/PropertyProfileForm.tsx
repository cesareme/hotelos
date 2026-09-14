// Perfil del establecimiento · ruta /backoffice/configuration/property-profile.
//
// This file used to hold a local mock form (state only: `handleSave` never
// called the API, and "Región fiscal" offered human labels the tax resolver
// does not understand). It now delegates to the real wizard form, which reads
// and writes the property profile through fetch/savePropertySetupForm, so both
// routes share one persistence path and the canonical tax-region select.
//
// The navigation lot may retire the `ConfigurationPropertyProfileForm` key and
// point the route at `PropertyProfileSetupForm`; this wrapper keeps the URL
// working until then.
import { PropertyProfileSetupForm } from "../../../propertySetup/PropertySetupForms";

export function PropertyProfileForm() {
  return <PropertyProfileSetupForm />;
}

export default PropertyProfileForm;

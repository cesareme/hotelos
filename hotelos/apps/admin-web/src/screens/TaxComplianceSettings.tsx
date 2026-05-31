import { ScreenScaffold } from "./ScreenScaffold";

export function TaxComplianceSettings() {
  return (
    <ScreenScaffold
      eyebrow="Regulatorio"
      title="Ajustes de cumplimiento fiscal"
      summary="Configura país, región fiscal, IVA/IGIC/IPSI, tasa turística, SES.HOSPEDAJES, Veri*FACTU, TicketBAI, SII, facturación electrónica B2B y retenciones."
      cards={[
        {
          title: "Cumplimiento España",
          status: "error",
          body: "SES.HOSPEDAJES está activado pero faltan las credenciales.",
          actions: [
            { label: "Configurar SES.HOSPEDAJES", screen: "SesHospedajesSettings" },
            { label: "Enrutamiento a autoridad", screen: "AuthorityRoutingSettings" }
          ]
        },
        {
          title: "Registro de viajeros",
          status: "ok",
          body: "Campos obligatorios y retención de tres años configurados; las imágenes de DNI se descartan tras el OCR por política.",
          actions: [
            { label: "Ajustes del registro", screen: "GuestRegisterSettings" },
            { label: "Retención", screen: "GuestRegisterRetentionSettings" },
            { label: "Mapeo de campos", screen: "GuestRegisterFieldMapping" }
          ]
        },
        {
          title: "Modelos fiscales",
          status: "ok",
          body: "Generadores de Modelos 303/111/115 trimestrales y 180/390 anuales disponibles.",
          actions: [
            { label: "Centro fiscal", screen: "FiscalDashboard" },
            { label: "Bandeja de cumplimiento", screen: "ComplianceInbox" }
          ]
        }
      ]}
    />
  );
}
